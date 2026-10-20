//! Los avisos al cliente de una reserva web que el restaurante ha cambiado o cancelado, desde la
//! Main (docs/estudios/reservas-web.md §5.7).
//!
//! La Main los apunta en su cola al cambiar la reserva y el job `avisos_reserva_web` los manda al
//! worker (`POST /v1/reservas-web/avisos`), que envía el correo. Así un cambio hecho sin internet
//! avisa al volver la conexión. El worker no repite un aviso que ya envió (por su id), así que
//! mandarlo otra vez porque no llegó la respuesta no le escribe dos veces al cliente.
//!
//! Qué se hace con cada respuesta:
//!   · bien → fuera de la cola;
//!   · la reserva aún no está en la nube (`not_found`: la Main la cambió sin conexión o su outbox va
//!     detrás) → se repite la siguiente vez;
//!   · un aviso que el worker no acepta (`validation`) o que no es de una reserva web (`conflict`)
//!     → fuera: repetirlo daría lo mismo;
//!   · otro error del worker (el buzón de ese cliente en su tope, el correo que no sale) → se repite,
//!     y los demás avisos de esa reserva esperan detrás para no llegar desordenados;
//!   · sin respuesta (la red) → se repite, y se para la vuelta: los demás fallarían igual.
//!
//! Se descarta, y queda en el log, el aviso de una reserva cuya hora ya ha pasado (ni se intenta: ya
//! no le sirve al cliente) y el que lleva un día de intentos sin salir. Lo que lleva días en la cola
//! porque la Main estuvo sin conexión sale igual, si la reserva está por venir.

use tpv_contracts::errors::ErrorCode;

use crate::error::{AppError, AppResult};
use crate::ports::licensing::PairingService;
use crate::ports::reservas::{AvisoEnCola, ColaAvisosReservaWeb, ReservasRepository};
use tpv_contracts::reservas_web::{AvisoReservaWebInput, TipoAvisoReservaWeb};

/// Cuántos avisos manda cada vuelta del job. Lo que quede, en la siguiente.
pub const MAX_POR_VUELTA: i64 = 50;
/// Tras tantos intentos fallidos se descarta: un día, a uno por minuto con la Main encendida.
pub const MAX_INTENTOS: i64 = 24 * 60;

/// Lo que ha hecho una vuelta. Sin datos de nadie: es lo que puede ir al log.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ResumenAvisos {
    pub enviados: usize,
    pub pendientes: usize,
    pub descartados: usize,
}

pub async fn enviar(
    cola: &dyn ColaAvisosReservaWeb,
    nube: &dyn PairingService,
    reservas: &dyn ReservasRepository,
    // «Ahora» en la hora del negocio, `YYYY-MM-DD HH:MM`, como el día y la hora de una reserva.
    ahora_local: &str,
) -> AppResult<ResumenAvisos> {
    let mut resumen = ResumenAvisos::default();
    // Las reservas con un aviso que no ha salido en esta vuelta: los siguientes de la misma reserva
    // esperan detrás, para que al cliente no le llegue el «cancelada» antes que el «cambiada».
    let mut apartadas: std::collections::HashSet<String> = std::collections::HashSet::new();
    for aviso in cola.pendientes(MAX_POR_VUELTA).await? {
        let id = aviso.cuerpo.id_aviso.clone();
        if apartadas.contains(&aviso.cuerpo.id_reserva) {
            continue;
        }
        let cuerpo = if format!("{} {}", aviso.cuerpo.dia_ymd, aviso.cuerpo.hora).as_str() <= ahora_local {
            None
        } else {
            al_dia(reservas, &aviso).await
        };
        let Some(cuerpo) = cuerpo else {
            cola.quitar(&id).await?;
            resumen.descartados += 1;
            continue;
        };
        let cuerpo = serde_json::to_value(&cuerpo).map_err(|e| AppError::internal(e.to_string()))?;
        match nube.tpv_server_post_json("tpv", "/v1/reservas-web/avisos", cuerpo).await {
            Ok(_) => {
                cola.quitar(&id).await?;
                resumen.enviados += 1;
            }
            Err(e) if matches!(e.code(), ErrorCode::Validation | ErrorCode::Conflict) => {
                cola.quitar(&id).await?;
                resumen.descartados += 1;
            }
            Err(_) if aviso.intentos + 1 >= MAX_INTENTOS => {
                cola.quitar(&id).await?;
                resumen.descartados += 1;
            }
            Err(e) => {
                cola.apuntar_fallo(&id, &codigo_de(&e)).await?;
                resumen.pendientes += 1;
                // El worker ha contestado: es cosa de este aviso (la reserva aún no está al día, el
                // buzón de ese cliente en su tope, su correo saliendo por otro lado). Se aparta y se
                // sigue con los demás. Sin respuesta (la red), los demás fallarían igual: se para.
                if !matches!(e, AppError::Coded(..)) {
                    break;
                }
                apartadas.insert(aviso.cuerpo.id_reserva.clone());
            }
        }
    }
    Ok(resumen)
}

/// El cuerpo que se manda, al día con la copia de la Main, o `None` si el aviso está superado:
///   · un «cambiada» que no coincide con la copia (hubo otro cambio después, también de una Handy, que
///     ya ha llegado aquí y avisó él) o de una reserva que ya no está por venir: «así queda ahora»
///     sería falso;
///   · si sigue valiendo, el cliente y la huella de su correo salen de la copia de ahora: si se
///     corrigió el correo después de encolarlo, la nube tiene que esperar al nuevo, no al de entonces;
///   · si no se puede leer, el cuerpo tal cual: la nube también compara lo que anuncia con lo que tiene.
async fn al_dia(reservas: &dyn ReservasRepository, aviso: &AvisoEnCola) -> Option<AvisoReservaWebInput> {
    let mut cuerpo = aviso.cuerpo.clone();
    let modificada = cuerpo.tipo == TipoAvisoReservaWeb::Modificada;
    match reservas.reserva(&cuerpo.id_reserva).await {
        Ok(Some(r)) => {
            let distinta = r.estado != "PROXIMA"
                || r.dia_ymd != cuerpo.dia_ymd
                || r.hora != cuerpo.hora
                || r.comensales != cuerpo.personas
                || crate::use_cases::reservas::mesa_de(&r) != cuerpo.mesa;
            if modificada && distinta {
                return None;
            }
            cuerpo.id_cliente = r.id_cliente.clone();
            cuerpo.huella_correo = tpv_domain::reservas_web::huella_de_correo(r.email_cliente.as_deref());
            Some(cuerpo)
        }
        Ok(None) if modificada => None,
        _ => Some(cuerpo),
    }
}

/// El código del error como identificador (`not_found`), nunca su texto.
fn codigo_de(e: &AppError) -> String {
    serde_json::to_value(e.code())
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "internal".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::Value as JsonValue;
    use tpv_contracts::licensing::*;
    use tpv_contracts::reservas_web::{AvisoReservaWebInput, TipoAvisoReservaWeb};

    use crate::ports::licensing::ResultadoSubidaImagen;
    use tpv_contracts::reservas::{ClienteCoincidente, ReservaDto, ReservasMetaDto};
    use tpv_domain::reservas::ReservaValidada;

    #[derive(Default)]
    struct Cola {
        avisos: Mutex<Vec<AvisoEnCola>>,
        fallos: Mutex<Vec<(String, String)>>,
    }

    #[async_trait]
    impl ColaAvisosReservaWeb for Cola {
        async fn pendientes(&self, max: i64) -> AppResult<Vec<AvisoEnCola>> {
            Ok(self.avisos.lock().unwrap().iter().take(max as usize).cloned().collect())
        }
        async fn quitar(&self, id: &str) -> AppResult<()> {
            self.avisos.lock().unwrap().retain(|a| a.cuerpo.id_aviso != id);
            Ok(())
        }
        async fn apuntar_fallo(&self, id: &str, codigo: &str) -> AppResult<()> {
            self.fallos.lock().unwrap().push((id.into(), codigo.into()));
            Ok(())
        }
    }

    /// La nube: contesta a cada aviso lo que se le diga, por orden, y apunta qué le llegó.
    struct Nube {
        respuestas: Mutex<VecDeque<AppResult<JsonValue>>>,
        recibidos: Mutex<Vec<JsonValue>>,
    }

    impl Nube {
        fn con(respuestas: Vec<AppResult<JsonValue>>) -> Self {
            Self { respuestas: Mutex::new(respuestas.into()), recibidos: Mutex::new(vec![]) }
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
        fn tpv_server_signed_headers(&self, _: &str, _: &str, _: &str, _: &[u8]) -> AppResult<ApiSignedHeaders> {
            panic!("ajeno a esta prueba")
        }
        async fn tpv_server_post_json(&self, _mode: &str, ruta: &str, body: JsonValue) -> AppResult<JsonValue> {
            assert_eq!(ruta, "/v1/reservas-web/avisos");
            self.recibidos.lock().unwrap().push(body);
            self.respuestas.lock().unwrap().pop_front().expect("respuesta preparada")
        }
        async fn pair_create(&self) -> AppResult<PairCreateResult> {
            panic!("ajeno a esta prueba")
        }
        async fn upload_image(&self, _: &str, _: &str, _: &str, _: Vec<u8>) -> AppResult<ResultadoSubidaImagen> {
            panic!("ajeno a esta prueba")
        }
        async fn delete_image(&self, _: &str, _: &str) -> AppResult<()> {
            panic!("ajeno a esta prueba")
        }
        async fn download_image(&self, _: &str, _: &str) -> AppResult<Option<Vec<u8>>> {
            panic!("ajeno a esta prueba")
        }
    }

    fn aviso(id: &str, intentos: i64) -> AvisoEnCola {
        AvisoEnCola {
            cuerpo: AvisoReservaWebInput {
                id_aviso: id.into(),
                id_reserva: format!("r-{id}"),
                tipo: TipoAvisoReservaWeb::Cancelada,
                dia_ymd: "2026-10-24".into(),
                hora: "21:00".into(),
                personas: 2,
                mesa: None,
                id_cliente: Some("c1".into()),
                huella_correo: None,
            },
            creado_ms: 0,
            intentos,
        }
    }

    /// La copia de la Main: lo que devuelve `reserva`, o `None` y que no se puede leer.
    struct Copia(Option<ReservaDto>, bool);
    #[async_trait]
    impl ReservasRepository for Copia {
        async fn meta(&self) -> AppResult<ReservasMetaDto> {
            panic!("ajeno a esta prueba")
        }
        async fn mes(&self, _: &str, _: &str) -> AppResult<Vec<ReservaDto>> {
            panic!("ajeno a esta prueba")
        }
        async fn reserva(&self, _: &str) -> AppResult<Option<ReservaDto>> {
            if self.1 {
                return Err(AppError::internal("no se puede leer"));
            }
            Ok(self.0.clone())
        }
        async fn guardar(&self, _: ReservaValidada, _: bool) -> AppResult<bool> {
            panic!("ajeno a esta prueba")
        }
        async fn buscar_cliente(&self, _: Option<&str>, _: Option<&str>) -> AppResult<Option<ClienteCoincidente>> {
            panic!("ajeno a esta prueba")
        }
        async fn eliminar(&self, _: &str) -> AppResult<bool> {
            panic!("ajeno a esta prueba")
        }
        async fn cancelar(&self, _: &str) -> AppResult<bool> {
            panic!("ajeno a esta prueba")
        }
    }

    fn sin_copia() -> Copia {
        Copia(None, true)
    }

    /// En la hora del negocio, días antes de la reserva de `aviso`.
    const AHORA: &str = "2026-10-20 12:00";

    #[tokio::test]
    async fn lo_enviado_sale_de_la_cola_y_lo_que_no_esta_en_la_nube_se_repite() {
        let cola = Cola::default();
        cola.avisos.lock().unwrap().extend([aviso("a1", 0), aviso("a2", 0), aviso("a3", 0)]);
        let nube = Nube::con(vec![
            Ok(serde_json::json!({ "ok": true, "enviado": true })),
            Err(AppError::Coded(ErrorCode::NotFound, "reserva_inexistente".into())),
            Ok(serde_json::json!({ "ok": true, "enviado": false })),
        ]);
        let r = enviar(&cola, &nube, &sin_copia(), AHORA).await.unwrap();
        assert_eq!(r, ResumenAvisos { enviados: 2, pendientes: 1, descartados: 0 });
        let quedan: Vec<_> = cola.avisos.lock().unwrap().iter().map(|a| a.cuerpo.id_aviso.clone()).collect();
        assert_eq!(quedan, ["a2"]);
        assert_eq!(*cola.fallos.lock().unwrap(), [("a2".to_string(), "not_found".to_string())]);
        // Lo que llega a la nube es el cuerpo tal cual, con su id.
        assert_eq!(nube.recibidos.lock().unwrap()[0]["id_aviso"], "a1");
        assert_eq!(nube.recibidos.lock().unwrap()[0]["tipo"], "cancelada");
    }

    #[tokio::test]
    async fn lo_que_el_worker_no_acepta_se_descarta_y_un_fallo_de_red_para_la_vuelta() {
        let cola = Cola::default();
        cola.avisos.lock().unwrap().extend([aviso("a1", 0), aviso("a2", 0), aviso("a3", 0)]);
        let nube = Nube::con(vec![
            Err(AppError::Coded(ErrorCode::Conflict, "reserva_no_web".into())),
            Err(AppError::external("sin red")),
        ]);
        let r = enviar(&cola, &nube, &sin_copia(), AHORA).await.unwrap();
        assert_eq!(r, ResumenAvisos { enviados: 0, pendientes: 1, descartados: 1 });
        // El tercero ni se intenta: sin red fallaría igual.
        assert_eq!(nube.recibidos.lock().unwrap().len(), 2);
        assert_eq!(cola.avisos.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn un_buzon_en_su_tope_no_para_a_los_demas_ni_desordena_los_suyos() {
        let cola = Cola::default();
        let mismo = |id: &str| {
            let mut a = aviso(id, 0);
            a.cuerpo.id_reserva = "r-ana".into();
            a
        };
        // Dos de la reserva de Ana (cambiada y luego cancelada) y uno de otra, detrás.
        cola.avisos.lock().unwrap().extend([mismo("a1"), mismo("a2"), aviso("b1", 0)]);
        let nube = Nube::con(vec![
            // 429: el buzón de Ana en su tope. El worker ha contestado: es cosa de ese aviso.
            Err(AppError::Coded(ErrorCode::External, "email_limite_diario".into())),
            Ok(serde_json::json!({ "ok": true, "enviado": true })),
        ]);
        let r = enviar(&cola, &nube, &sin_copia(), AHORA).await.unwrap();
        assert_eq!(r, ResumenAvisos { enviados: 1, pendientes: 1, descartados: 0 });
        // El de la otra reserva ha salido; el segundo de Ana no se ha intentado: espera al primero.
        let ids: Vec<_> = nube.recibidos.lock().unwrap().iter().map(|b| b["id_aviso"].clone()).collect();
        assert_eq!(ids, ["a1", "b1"]);
        let quedan: Vec<_> = cola.avisos.lock().unwrap().iter().map(|a| a.cuerpo.id_aviso.clone()).collect();
        assert_eq!(quedan, ["a1", "a2"]);
    }

    #[tokio::test]
    async fn tras_un_dia_de_intentos_se_descarta() {
        let cola = Cola::default();
        cola.avisos.lock().unwrap().push(aviso("viejo", MAX_INTENTOS - 1));
        let nube = Nube::con(vec![Err(AppError::Coded(ErrorCode::NotFound, "reserva_inexistente".into()))]);
        let r = enviar(&cola, &nube, &sin_copia(), AHORA).await.unwrap();
        assert_eq!(r, ResumenAvisos { enviados: 0, pendientes: 0, descartados: 1 });
        assert!(cola.avisos.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn el_de_una_reserva_que_ya_ha_pasado_ni_se_intenta() {
        let cola = Cola::default();
        cola.avisos.lock().unwrap().push(aviso("pasada", 0));
        let nube = Nube::con(vec![]);
        let r = enviar(&cola, &nube, &sin_copia(), "2026-10-24 21:00").await.unwrap();
        assert_eq!(r, ResumenAvisos { enviados: 0, pendientes: 0, descartados: 1 });
        assert!(nube.recibidos.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn uno_que_lleva_dias_en_la_cola_sin_intentarse_sale_si_la_reserva_esta_por_venir() {
        // La Main estuvo días sin conexión: el aviso sale al volver, no se descarta por viejo.
        let cola = Cola::default();
        cola.avisos.lock().unwrap().push(AvisoEnCola { creado_ms: 1, ..aviso("de-hace-dias", 0) });
        let nube = Nube::con(vec![Ok(serde_json::json!({ "ok": true, "enviado": true }))]);
        let r = enviar(&cola, &nube, &sin_copia(), AHORA).await.unwrap();
        assert_eq!(r, ResumenAvisos { enviados: 1, pendientes: 0, descartados: 0 });
    }
    #[tokio::test]
    async fn un_cambiada_que_ya_no_dice_como_esta_la_reserva_en_la_main_se_descarta_sin_mandarlo() {
        let modificada = |id: &str| {
            let mut a = aviso(id, 0);
            a.cuerpo.tipo = TipoAvisoReservaWeb::Modificada;
            a.cuerpo.hora = "22:00".into();
            a
        };
        let copia = |hora: &str, estado: &str| ReservaDto {
            id_reserva: "r-a1".into(),
            id_mesa: String::new(),
            dia_ymd: "2026-10-24".into(),
            hora: hora.into(),
            turno: None,
            comensales: 2,
            duracion_min: None,
            nota: None,
            estado: estado.into(),
            origen: "WEB".into(),
            id_cliente: Some("c1".into()),
            nombre_cliente: "Ana".into(),
            telefono_cliente: None,
            email_cliente: None,
            id_zona: String::new(),
            numero_mesa: String::new(),
            capacidad: 0,
            nombre_zona: String::new(),
        };
        // Una Handy la pasó después a las 23:00 (y ya avisó ella); este aviso dice las 22:00.
        for repo in [Copia(Some(copia("23:00", "PROXIMA")), false), Copia(Some(copia("22:00", "CANCELADA")), false), Copia(None, false)] {
            let cola = Cola::default();
            cola.avisos.lock().unwrap().push(modificada("a1"));
            let nube = Nube::con(vec![]);
            let r = enviar(&cola, &nube, &repo, AHORA).await.unwrap();
            assert_eq!(r, ResumenAvisos { enviados: 0, pendientes: 0, descartados: 1 });
            assert!(nube.recibidos.lock().unwrap().is_empty());
        }
        // Si coincide, sale.
        let cola = Cola::default();
        cola.avisos.lock().unwrap().push(modificada("a1"));
        let nube = Nube::con(vec![Ok(serde_json::json!({ "ok": true, "enviado": true }))]);
        let r = enviar(&cola, &nube, &Copia(Some(copia("22:00", "PROXIMA")), false), AHORA).await.unwrap();
        assert_eq!(r.enviados, 1);
    }
    #[tokio::test]
    async fn si_el_correo_del_cliente_se_corrigio_despues_de_encolarlo_sale_con_el_de_ahora() {
        let cola = Cola::default();
        // Encolado cuando el cliente aún tenía el correo mal escrito (y su huella va en el aviso).
        let mut a = aviso("a1", 0);
        a.cuerpo.huella_correo = tpv_domain::reservas_web::huella_de_correo(Some("ana@corero.es"));
        cola.avisos.lock().unwrap().push(a);
        let ahora = ReservaDto {
            id_reserva: "r-a1".into(),
            id_mesa: String::new(),
            dia_ymd: "2026-10-24".into(),
            hora: "21:00".into(),
            turno: None,
            comensales: 2,
            duracion_min: None,
            nota: None,
            estado: "CANCELADA".into(),
            origen: "WEB".into(),
            id_cliente: Some("c1".into()),
            nombre_cliente: "Ana".into(),
            telefono_cliente: None,
            email_cliente: Some("ana@correo.es".into()),
            id_zona: String::new(),
            numero_mesa: String::new(),
            capacidad: 0,
            nombre_zona: String::new(),
        };
        let nube = Nube::con(vec![Ok(serde_json::json!({ "ok": true, "enviado": true }))]);
        enviar(&cola, &nube, &Copia(Some(ahora), false), AHORA).await.unwrap();
        let mandado = nube.recibidos.lock().unwrap()[0].clone();
        assert_eq!(mandado["huella_correo"], tpv_domain::reservas_web::huella_de_correo(Some("ana@correo.es")).unwrap());
        assert_eq!(mandado["id_cliente"], "c1");
        assert_eq!(mandado["id_aviso"], "a1");
    }
}
