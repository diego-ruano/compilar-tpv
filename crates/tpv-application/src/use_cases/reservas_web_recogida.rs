//! La recogida de las reservas web (docs/estudios/reservas-web.md §5.4 y §5.5).
//!
//! La agenda del worker guarda lo que se reserva y se cancela desde la web mientras la Main no lo
//! tiene. La Main lo pide (`POST /v1/reservas-web/pendientes`), lo registra en su base con su
//! outbox, contesta cómo le ha ido con cada petición (`POST /v1/reservas-web/recogidas`) y avisa al
//! restaurante. Lo dispara el motor de réplica: al conectar, al terminar una recuperación y cuando
//! el `TenantHub` manda `{"type":"reservas_web"}`.
//!
//! Reglas que no se rompen aquí:
//!   · **Una reserva web confirmada no se rechaza nunca** (regla 3 del plan): si choca, se guarda y
//!     se avisa. Sólo es `fallida` lo que no se puede guardar por sí mismo (un dato imposible).
//!   · **Un fallo transitorio no es `fallida`**: una `fallida` le manda un correo al cliente. Si la
//!     base no responde, se corta la vuelta sin contestar lo que queda, y la agenda lo vuelve a
//!     ofrecer.
//!   · Los avisos al restaurante son best-effort: no deciden nada.

use serde_json::{json, Value as JsonValue};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::reservas_web::{
    PeticionReservaWebDto, RecogidaReservaWebDto, ResultadoRecogidaWeb, TipoPeticionWeb,
};
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};
use tpv_domain::reservas_web::{
    dia_corto, AltaWebEntrada, AltaWebParaRegistrar, AltaWebRegistrada, CancelacionWeb,
};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::PairingService;
use crate::ports::notificaciones::Notifier;
use crate::ports::reservas_web::ReservasWebRepository;

/// Cuántas tandas pide una recogida como mucho. La agenda entrega de 50 en 50; lo que no quepa
/// sale en la siguiente recogida.
const MAX_TANDAS: usize = 20;

/// Lo que ha hecho una recogida. Sin datos de nadie: es lo que puede ir al log.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ResumenRecogida {
    pub registradas: usize,
    pub solapadas: usize,
    pub canceladas: usize,
    pub fallidas: usize,
}

/// Una petición tal como llega: bien formada, o rota pero con su id para poder contestarla.
enum Entrada {
    Valida(Box<PeticionReservaWebDto>),
    Rota(String),
}

impl ResumenRecogida {
    /// ¿Se ha escrito algo en la base? Entonces hay que refrescar la pantalla y subir el outbox.
    pub fn hay_cambios(&self) -> bool {
        self.registradas + self.solapadas + self.canceladas + self.fallidas > 0
    }
}

/// Pide lo pendiente, lo registra y contesta, tanda a tanda. Lo hecho se va apuntando en `resumen`
/// según se guarda: si algo falla a mitad, lo apuntado ya está en la base y quien llama tiene que
/// enterarse igual (refrescar la pantalla, subir el outbox).
pub async fn recoger(
    nube: &dyn PairingService,
    repo: &dyn ReservasWebRepository,
    notifier: Option<&dyn Notifier>,
    resumen: &mut ResumenRecogida,
) -> AppResult<()> {
    for _ in 0..MAX_TANDAS {
        let bruto = nube.tpv_server_post_json("tpv", "/v1/reservas-web/pendientes", json!({})).await?;
        let (entradas, hay_mas) = leer_pendientes(&bruto)?;
        if entradas.is_empty() {
            break;
        }

        let mut resultados = Vec::with_capacity(entradas.len());
        let mut corte = None;
        for entrada in entradas {
            match entrada {
                Entrada::Rota(id) => {
                    resumen.fallidas += 1;
                    resultados.push(contestar(id, ResultadoRecogidaWeb::Fallida, Some("peticion_invalida")));
                }
                Entrada::Valida(p) => match registrar(repo, notifier, &p, resumen).await {
                    Ok(r) => resultados.push(r),
                    Err(e) => {
                        corte = Some(e);
                        break;
                    }
                },
            }
        }
        // Lo hecho se contesta aunque la tanda se haya cortado: lo que falta se vuelve a ofrecer.
        if !resultados.is_empty() {
            nube.tpv_server_post_json(
                "tpv",
                "/v1/reservas-web/recogidas",
                json!({ "resultados": resultados }),
            )
            .await?;
        }
        if let Some(e) = corte {
            return Err(e);
        }
        if !hay_mas {
            break;
        }
    }
    Ok(())
}

/// Interpreta `{ ok, peticiones, hay_mas }`, petición a petición: una mal formada no impide
/// registrar las demás.
fn leer_pendientes(bruto: &JsonValue) -> AppResult<(Vec<Entrada>, bool)> {
    let lista = bruto
        .get("peticiones")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| AppError::external("La nube no ha devuelto las reservas web pendientes"))?;
    let hay_mas = bruto.get("hay_mas").and_then(JsonValue::as_bool).unwrap_or(false);
    let entradas = lista
        .iter()
        .filter_map(|v| match serde_json::from_value::<PeticionReservaWebDto>(v.clone()) {
            Ok(p) => Some(Entrada::Valida(Box::new(p))),
            // Sin id no se puede contestar: la agenda la volverá a ofrecer.
            Err(_) => v
                .get("id_peticion")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(|id| Entrada::Rota(id.to_string())),
        })
        .collect();
    Ok((entradas, hay_mas))
}

fn contestar(id_peticion: String, resultado: ResultadoRecogidaWeb, codigo: Option<&str>) -> RecogidaReservaWebDto {
    RecogidaReservaWebDto { id_peticion, resultado, codigo: codigo.map(str::to_string) }
}

/// Lo que no se arregla repitiendo: un dato que no vale, algo que choca con el esquema. Lo demás
/// (la base ocupada o en recuperación, un fallo de disco) se corta y se vuelve a intentar.
fn es_permanente(e: &AppError) -> bool {
    matches!(e.code(), ErrorCode::Validation | ErrorCode::Conflict | ErrorCode::NotFound)
}

/// El código del error como identificador (`validation`), nunca su texto.
fn codigo_de(e: &AppError) -> String {
    serde_json::to_value(e.code())
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "internal".to_string())
}

async fn registrar(
    repo: &dyn ReservasWebRepository,
    notifier: Option<&dyn Notifier>,
    p: &PeticionReservaWebDto,
    resumen: &mut ResumenRecogida,
) -> AppResult<RecogidaReservaWebDto> {
    let id = p.id_peticion.clone();
    match p.tipo {
        TipoPeticionWeb::Alta => {
            let Some(datos) = &p.datos else {
                resumen.fallidas += 1;
                avisar(notifier, aviso_fallida(p)).await;
                return Ok(contestar(id, ResultadoRecogidaWeb::Fallida, Some("sin_datos")));
            };
            let entrada = AltaWebEntrada {
                dia_ymd: p.dia_ymd.clone(),
                hora: p.hora.clone(),
                personas: p.personas,
                id_mesa: p.id_mesa.clone().unwrap_or_default(),
                nombre: datos.nombre.clone(),
                email: datos.email.clone(),
                telefono: datos.telefono.clone(),
                nota: datos.nota.clone(),
            };
            let alta = match AltaWebParaRegistrar::validar(&p.id_reserva, entrada, &p.creada_local) {
                Ok(a) => a,
                Err(_) => {
                    resumen.fallidas += 1;
                    avisar(notifier, aviso_fallida(p)).await;
                    return Ok(contestar(id, ResultadoRecogidaWeb::Fallida, Some("validation")));
                }
            };
            let nombre = alta.alta.nombre.clone();
            match repo.registrar_alta(alta).await {
                Ok(AltaWebRegistrada::YaEstaba) => Ok(contestar(id, ResultadoRecogidaWeb::Registrada, None)),
                Ok(AltaWebRegistrada::Nueva { solapada, mesa }) => {
                    let detalle = detalle(Some(&nombre), &p.dia_ymd, &p.hora, mesa.as_deref());
                    if solapada {
                        resumen.solapadas += 1;
                        avisar(notifier, aviso(
                            "reserva_web_solapada",
                            Severidad::Aviso,
                            "Reserva web en una mesa ocupada",
                            format!("{detalle}. Muévela a otra mesa."),
                            &p.id_reserva,
                        ))
                        .await;
                        Ok(contestar(id, ResultadoRecogidaWeb::Solapada, None))
                    } else {
                        resumen.registradas += 1;
                        avisar(notifier, aviso("reserva_web_nueva", Severidad::Info, "Nueva reserva web", detalle, &p.id_reserva))
                            .await;
                        Ok(contestar(id, ResultadoRecogidaWeb::Registrada, None))
                    }
                }
                Err(e) if es_permanente(&e) => {
                    resumen.fallidas += 1;
                    avisar(notifier, aviso_fallida(p)).await;
                    Ok(contestar(id, ResultadoRecogidaWeb::Fallida, Some(&codigo_de(&e))))
                }
                Err(e) => Err(e),
            }
        }
        TipoPeticionWeb::Cancelacion => match repo.cancelar_desde_la_web(&p.id_reserva).await {
            Ok(CancelacionWeb::Cancelada(r)) => {
                resumen.canceladas += 1;
                let detalle = detalle(r.nombre.as_deref(), &r.dia_ymd, &r.hora, r.mesa.as_deref());
                avisar(notifier, aviso(
                    "reserva_web_cancelada",
                    Severidad::Info,
                    "Reserva web cancelada por el cliente",
                    detalle,
                    &p.id_reserva,
                ))
                .await;
                Ok(contestar(id, ResultadoRecogidaWeb::Registrada, None))
            }
            Ok(CancelacionWeb::YaNoEstabaViva) => Ok(contestar(id, ResultadoRecogidaWeb::Registrada, None)),
            // Sin la reserva en la Main no hay nada que cancelar, y la agenda no la verá nunca
            // cancelada en la base del negocio: se cierra, para que no se le vuelva a ofrecer cada hora.
            Ok(CancelacionWeb::NoExiste) => {
                Ok(contestar(id, ResultadoRecogidaWeb::Fallida, Some("reserva_inexistente")))
            }
            Err(e) if es_permanente(&e) => {
                Ok(contestar(id, ResultadoRecogidaWeb::Fallida, Some(&codigo_de(&e))))
            }
            Err(e) => Err(e),
        },
    }
}

/// «Ana · 24/10 21:00 · Mesa 5». La mesa va con el nombre que tiene en la Main, que ya suele ser
/// «Mesa 5»: sólo a un número a secas se le antepone «Mesa» (la regla de `@tpv/plano/nombre`).
fn detalle(nombre: Option<&str>, dia_ymd: &str, hora: &str, mesa: Option<&str>) -> String {
    let mut partes = Vec::new();
    if let Some(n) = nombre.map(str::trim).filter(|n| !n.is_empty()) {
        partes.push(n.to_string());
    }
    partes.push(format!("{} {}", dia_corto(dia_ymd), hora));
    partes.push(match mesa {
        Some(m) if !m.is_empty() && m.bytes().all(|b| b.is_ascii_digit()) => format!("Mesa {m}"),
        Some(m) => m.to_string(),
        None => "sin mesa".to_string(),
    });
    partes.join(" · ")
}

/// A los administradores, como la de «Nueva reserva». Con su clave por reserva y tipo: la misma
/// petición entregada dos veces no avisa dos veces.
fn aviso(tipo: &str, severidad: Severidad, titulo: &str, cuerpo: String, id_reserva: &str) -> NuevaNotificacion {
    NuevaNotificacion {
        tipo: tipo.to_string(),
        severidad,
        titulo: titulo.to_string(),
        cuerpo: Some(cuerpo),
        destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
        accion: Some("ver_reservas".to_string()),
        payload: None,
        clave_dedupe: Some(format!("{tipo}:{id_reserva}")),
        expira_en: None,
    }
}

/// Lo que no se pudo registrar, con el contacto del cliente para llamarle: tiene una reserva
/// confirmada que el restaurante no tiene.
fn aviso_fallida(p: &PeticionReservaWebDto) -> NuevaNotificacion {
    let cuando = format!("{} {}", dia_corto(&p.dia_ymd), p.hora);
    let cuerpo = match &p.datos {
        Some(d) => format!(
            "Llama al cliente para avisarle: {} · {} · {} · {cuando}",
            d.nombre.trim(),
            d.telefono.trim(),
            d.email.trim()
        ),
        None => format!("Una reserva web para el {cuando} no se ha podido registrar."),
    };
    aviso(
        "reserva_web_fallida",
        Severidad::Error,
        "No se ha podido registrar una reserva web",
        cuerpo,
        &p.id_reserva,
    )
}

async fn avisar(notifier: Option<&dyn Notifier>, nueva: NuevaNotificacion) {
    if let Some(n) = notifier {
        let _ = n.emitir(nueva).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::Value;
    use tpv_contracts::licensing::*;
    use tpv_contracts::reservas_web::{CierreReservaWebDto, ReservaWebMesaDto};
    use tpv_domain::reservas_web::{CierreValidado, MesaWebValidada, ReservaWebResumen};

    use super::*;

    /// La nube: contesta en orden lo que se le pida y apunta lo que le mandan.
    #[derive(Default)]
    struct Nube {
        respuestas: Mutex<VecDeque<Value>>,
        llamadas: Mutex<Vec<(String, Value)>>,
        falla_al_contestar: bool,
    }
    impl Nube {
        fn con(respuestas: Vec<Value>) -> Self {
            Nube { respuestas: Mutex::new(respuestas.into()), ..Default::default() }
        }
        fn recogidas(&self) -> Vec<Value> {
            self.llamadas
                .lock()
                .unwrap()
                .iter()
                .filter(|(ruta, _)| ruta == "/v1/reservas-web/recogidas")
                .flat_map(|(_, cuerpo)| cuerpo["resultados"].as_array().cloned().unwrap_or_default())
                .collect()
        }
    }
    #[async_trait]
    impl PairingService for Nube {
        fn device_identity(&self) -> AppResult<DeviceIdentity> {
            panic!("ajeno a esta prueba")
        }
        fn firmar_hello(&self, _: &str, _: &str) -> AppResult<FirmaDispositivo> {
            panic!("ajeno a esta prueba")
        }
        fn firmar_emparejamiento(&self, _: DeviceFirmarEmparejamientoArgs) -> AppResult<FirmaDispositivo> {
            panic!("ajeno a esta prueba")
        }
        fn hora_para_firmar(&self) -> i64 {
            panic!("ajeno a esta prueba")
        }
        fn handy_set_token(&self, _: &str, _: &str) -> AppResult<()> {
            panic!("ajeno a esta prueba")
        }
        fn handy_clear_token(&self) -> AppResult<()> {
            panic!("ajeno a esta prueba")
        }
        fn handy_get_tenant(&self) -> AppResult<Option<String>> {
            panic!("ajeno a esta prueba")
        }
        fn negocio_de_la_licencia(&self) -> AppResult<Option<String>> {
            panic!("ajeno a esta prueba")
        }
        fn tpv_server_signed_headers(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AppResult<ApiSignedHeaders> {
            panic!("ajeno a esta prueba")
        }
        async fn tpv_server_post_json(&self, _mode: &str, ruta: &str, cuerpo: Value) -> AppResult<Value> {
            self.llamadas.lock().unwrap().push((ruta.to_string(), cuerpo));
            if ruta == "/v1/reservas-web/recogidas" {
                if self.falla_al_contestar {
                    return Err(AppError::external("sin red"));
                }
                return Ok(json!({ "ok": true }));
            }
            self.respuestas.lock().unwrap().pop_front().ok_or_else(|| AppError::external("sin red"))
        }
        async fn pair_create(&self) -> AppResult<PairCreateResult> {
            panic!("ajeno a esta prueba")
        }
        async fn upload_image(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: Vec<u8>,
        _negocio: &str,
    ) -> AppResult<crate::ports::licensing::ResultadoSubidaImagen> {
            panic!("ajeno a esta prueba")
        }
        async fn delete_image(&self, _: &str, _: &str) -> AppResult<()> {
            panic!("ajeno a esta prueba")
        }
        async fn download_image(&self, _: &str, _: &str) -> AppResult<Option<Vec<u8>>> {
            panic!("ajeno a esta prueba")
        }
    }

    /// La base de la Main: contesta lo que diga la prueba y apunta lo que le piden.
    #[derive(Default)]
    struct Repo {
        altas: Mutex<VecDeque<AppResult<AltaWebRegistrada>>>,
        cancelaciones: Mutex<VecDeque<AppResult<CancelacionWeb>>>,
        registradas: Mutex<Vec<AltaWebParaRegistrar>>,
    }
    #[async_trait]
    impl ReservasWebRepository for Repo {
        async fn zona_horaria(&self) -> AppResult<String> {
            unreachable!()
        }
        async fn fijar_zona_horaria(&self, _: &str) -> AppResult<()> {
            unreachable!()
        }
        async fn activa(&self) -> AppResult<bool> {
            unreachable!()
        }
        async fn fijar_activa(&self, _: bool) -> AppResult<bool> {
            unreachable!()
        }
        async fn cierres(&self) -> AppResult<Vec<CierreReservaWebDto>> {
            unreachable!()
        }
        async fn cerrar_dia(&self, _: CierreValidado) -> AppResult<String> {
            unreachable!()
        }
        async fn quitar_cierre(&self, _: &str) -> AppResult<bool> {
            unreachable!()
        }
        async fn mesas(&self) -> AppResult<Vec<ReservaWebMesaDto>> {
            unreachable!()
        }
        async fn guardar_mesa(&self, _: MesaWebValidada) -> AppResult<()> {
            unreachable!()
        }
        async fn registrar_alta(&self, alta: AltaWebParaRegistrar) -> AppResult<AltaWebRegistrada> {
            self.registradas.lock().unwrap().push(alta);
            self.altas.lock().unwrap().pop_front().expect("alta no prevista")
        }
        async fn cancelar_desde_la_web(&self, _: &str) -> AppResult<CancelacionWeb> {
            self.cancelaciones.lock().unwrap().pop_front().expect("cancelación no prevista")
        }
    }

    #[derive(Default)]
    struct Avisos(Mutex<Vec<NuevaNotificacion>>);
    #[async_trait]
    impl Notifier for Avisos {
        async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
            self.0.lock().unwrap().push(nueva);
            Ok("n".into())
        }
        async fn resolver_por_clave(&self, _: &str) -> AppResult<bool> {
            Ok(false)
        }
    }
    impl Avisos {
        fn tipos(&self) -> Vec<String> {
            self.0.lock().unwrap().iter().map(|n| n.tipo.clone()).collect()
        }
    }

    fn alta(id: &str) -> Value {
        json!({
            "id_peticion": format!("p-{id}"), "tipo": "alta", "id_reserva": id, "id_mesa": "m5",
            "dia_ymd": "2026-10-24", "hora": "21:00", "personas": 2, "creada_local": "2026-10-18 12:00:00",
            "datos": { "nombre": "Ana", "email": "Ana@Correo.es", "telefono": "600 112 233", "nota": null }
        })
    }
    fn cancelacion(id: &str) -> Value {
        json!({
            "id_peticion": format!("c-{id}"), "tipo": "cancelacion", "id_reserva": id, "id_mesa": "m5",
            "dia_ymd": "2026-10-24", "hora": "21:00", "personas": 2, "creada_local": "2026-10-18 12:00:00",
            "datos": null
        })
    }
    fn tanda(peticiones: Vec<Value>, hay_mas: bool) -> Value {
        json!({ "ok": true, "peticiones": peticiones, "hay_mas": hay_mas })
    }
    fn resultado(id: &str, r: &str, codigo: Option<&str>) -> Value {
        json!({ "id_peticion": id, "resultado": r, "codigo": codigo })
    }

    #[tokio::test]
    async fn registra_en_orden_contesta_cada_una_y_avisa_al_restaurante() {
        let nube = Nube::con(vec![tanda(vec![alta("r1"), alta("r2"), cancelacion("r0")], false)]);
        let repo = Repo::default();
        repo.altas.lock().unwrap().extend([
            Ok(AltaWebRegistrada::Nueva { solapada: false, mesa: Some("5".into()) }),
            Ok(AltaWebRegistrada::Nueva { solapada: true, mesa: None }),
        ]);
        repo.cancelaciones.lock().unwrap().push_back(Ok(CancelacionWeb::Cancelada(ReservaWebResumen {
            nombre: Some("Luis".into()),
            dia_ymd: "2026-10-25".into(),
            hora: "14:00".into(),
            // Con el nombre que propone la Main: no sale «Mesa Mesa 2».
            mesa: Some("Mesa 2".into()),
        })));
        let avisos = Avisos::default();

        let mut resumen = ResumenRecogida::default();
        recoger(&nube, &repo, Some(&avisos), &mut resumen).await.unwrap();

        assert_eq!(resumen, ResumenRecogida { registradas: 1, solapadas: 1, canceladas: 1, fallidas: 0 });
        assert_eq!(
            nube.recogidas(),
            vec![
                resultado("p-r1", "registrada", None),
                resultado("p-r2", "solapada", None),
                resultado("c-r0", "registrada", None),
            ]
        );
        // Lo que llega se vuelve a validar y normalizar antes de guardarlo.
        let registradas = repo.registradas.lock().unwrap();
        assert_eq!(
            (registradas[0].alta.email.as_str(), registradas[0].alta.telefono.as_str()),
            ("ana@correo.es", "600112233")
        );
        assert_eq!(registradas[0].creada_local.as_deref(), Some("2026-10-18 12:00:00"));

        assert_eq!(avisos.tipos(), ["reserva_web_nueva", "reserva_web_solapada", "reserva_web_cancelada"]);
        let notas = avisos.0.lock().unwrap();
        assert_eq!(notas[0].cuerpo.as_deref(), Some("Ana · 24/10 21:00 · Mesa 5"));
        assert_eq!(notas[1].cuerpo.as_deref(), Some("Ana · 24/10 21:00 · sin mesa. Muévela a otra mesa."));
        assert_eq!(notas[2].cuerpo.as_deref(), Some("Luis · 25/10 14:00 · Mesa 2"));
        assert_eq!(notas[0].clave_dedupe.as_deref(), Some("reserva_web_nueva:r1"));
    }

    #[test]
    fn la_mesa_va_con_su_nombre_y_mesa_delante_solo_si_es_un_numero() {
        let con = |mesa: &str| detalle(Some("Ana"), "2026-10-24", "21:00", Some(mesa));
        assert_eq!(con("5"), "Ana · 24/10 21:00 · Mesa 5");
        assert_eq!(con("Mesa 1"), "Ana · 24/10 21:00 · Mesa 1");
        assert_eq!(con("Terraza 3"), "Ana · 24/10 21:00 · Terraza 3");
    }

    #[tokio::test]
    async fn lo_que_ya_estaba_se_contesta_registrado_sin_volver_a_avisar() {
        let nube = Nube::con(vec![tanda(vec![alta("r1")], false)]);
        let repo = Repo::default();
        repo.altas.lock().unwrap().push_back(Ok(AltaWebRegistrada::YaEstaba));
        let avisos = Avisos::default();

        recoger(&nube, &repo, Some(&avisos), &mut ResumenRecogida::default()).await.unwrap();

        assert_eq!(nube.recogidas(), vec![resultado("p-r1", "registrada", None)]);
        assert!(avisos.tipos().is_empty());
    }

    /// Una fallida le manda un correo al cliente: sólo lo es lo que no se puede guardar por sí mismo.
    #[tokio::test]
    async fn un_dato_imposible_es_fallida_con_el_contacto_del_cliente_para_llamarle() {
        let mut mala = alta("r1");
        mala["datos"]["email"] = json!("no-es-un-correo");
        let mut sin_datos = alta("r2");
        sin_datos["datos"] = Value::Null;
        let rota = json!({ "id_peticion": "p-rota", "tipo": "otra" });
        let nube = Nube::con(vec![tanda(vec![mala, sin_datos, rota, json!({ "sin": "id" })], false)]);
        let repo = Repo::default();
        let avisos = Avisos::default();

        let mut resumen = ResumenRecogida::default();
        recoger(&nube, &repo, Some(&avisos), &mut resumen).await.unwrap();

        assert_eq!(resumen.fallidas, 3);
        assert_eq!(
            nube.recogidas(),
            vec![
                resultado("p-r1", "fallida", Some("validation")),
                resultado("p-r2", "fallida", Some("sin_datos")),
                resultado("p-rota", "fallida", Some("peticion_invalida")),
            ]
        );
        assert!(repo.registradas.lock().unwrap().is_empty());
        assert_eq!(avisos.tipos(), ["reserva_web_fallida", "reserva_web_fallida"]);
        let notas = avisos.0.lock().unwrap();
        assert_eq!(
            notas[0].cuerpo.as_deref(),
            Some("Llama al cliente para avisarle: Ana · 600 112 233 · no-es-un-correo · 24/10 21:00")
        );
        assert!(matches!(notas[0].severidad, Severidad::Error));
    }

    /// Si la base no responde, no es culpa de la reserva: se contesta lo hecho, se corta y el resto
    /// se lo vuelve a ofrecer la agenda. Nada de «fallida», que le mandaría un correo al cliente.
    #[tokio::test]
    async fn un_fallo_de_la_base_corta_la_tanda_sin_dar_nada_por_fallido() {
        let nube = Nube::con(vec![tanda(vec![alta("r1"), alta("r2"), alta("r3")], false)]);
        let repo = Repo::default();
        repo.altas.lock().unwrap().extend([
            Ok(AltaWebRegistrada::Nueva { solapada: false, mesa: Some("5".into()) }),
            Err(AppError::repository("disco lleno")),
        ]);

        let mut resumen = ResumenRecogida::default();
        assert!(recoger(&nube, &repo, None, &mut resumen).await.is_err());

        assert_eq!(nube.recogidas(), vec![resultado("p-r1", "registrada", None)]);
        // Lo guardado antes del corte queda apuntado: quien llama refresca la pantalla igual.
        assert_eq!(resumen.registradas, 1);
        assert!(resumen.hay_cambios());
        assert_eq!(repo.registradas.lock().unwrap().len(), 2);
    }

    /// Lo guardado está guardado aunque la respuesta a la agenda no llegue: quien llama tiene que
    /// saberlo para refrescar la pantalla y subir el outbox.
    #[tokio::test]
    async fn si_no_se_puede_contestar_lo_guardado_queda_apuntado() {
        let nube = Nube { falla_al_contestar: true, ..Nube::con(vec![tanda(vec![alta("r1")], false)]) };
        let repo = Repo::default();
        repo.altas.lock().unwrap().push_back(Ok(AltaWebRegistrada::Nueva { solapada: true, mesa: None }));
        let avisos = Avisos::default();

        let mut resumen = ResumenRecogida::default();
        assert!(recoger(&nube, &repo, Some(&avisos), &mut resumen).await.is_err());

        assert_eq!(resumen.solapadas, 1);
        assert!(resumen.hay_cambios());
        assert_eq!(avisos.tipos(), ["reserva_web_solapada"]);
    }

    #[tokio::test]
    async fn una_cancelacion_de_algo_que_la_main_no_tiene_se_cierra() {
        let nube = Nube::con(vec![tanda(vec![cancelacion("r1"), cancelacion("r2")], false)]);
        let repo = Repo::default();
        repo.cancelaciones
            .lock()
            .unwrap()
            .extend([Ok(CancelacionWeb::NoExiste), Ok(CancelacionWeb::YaNoEstabaViva)]);
        let avisos = Avisos::default();

        recoger(&nube, &repo, Some(&avisos), &mut ResumenRecogida::default()).await.unwrap();

        assert_eq!(
            nube.recogidas(),
            vec![
                resultado("c-r1", "fallida", Some("reserva_inexistente")),
                resultado("c-r2", "registrada", None),
            ]
        );
        assert!(avisos.tipos().is_empty());
    }

    #[tokio::test]
    async fn pide_otra_tanda_mientras_haya_mas_y_para_cuando_no_queda_nada() {
        let nube = Nube::con(vec![tanda(vec![alta("r1")], true), tanda(vec![alta("r2")], false)]);
        let repo = Repo::default();
        repo.altas.lock().unwrap().extend([Ok(AltaWebRegistrada::YaEstaba), Ok(AltaWebRegistrada::YaEstaba)]);

        recoger(&nube, &repo, None, &mut ResumenRecogida::default()).await.unwrap();
        assert_eq!(nube.recogidas().len(), 2);

        // Sin nada pendiente, ni contesta.
        let vacia = Nube::con(vec![tanda(vec![], false)]);
        recoger(&vacia, &repo, None, &mut ResumenRecogida::default()).await.unwrap();
        assert!(vacia.recogidas().is_empty());

        // Una respuesta sin lista es un error de la nube, no una lista vacía.
        let rota = Nube::con(vec![json!({ "ok": true })]);
        assert!(recoger(&rota, &repo, None, &mut ResumenRecogida::default()).await.is_err());
    }
}
