//! Casos de uso de reservas (Local-First).

use tpv_contracts::reservas::{
    ClienteCoincidente, ReservaBuscarClienteArgs, ReservaCancelarInput, ReservaDeleteInput,
    ReservaDto, ReservaSaveInput, ReservasGetMesArgs, ReservasMetaDto,
};
use tpv_contracts::reservas_web::TipoAvisoReservaWeb;
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};
use tpv_domain::reservas::{normalize_dia_ymd, ReservaValidada};

use crate::error::{AppError, AppResult};
use crate::ports::notificaciones::Notifier;
use crate::ports::reservas::{AvisoAlCliente, AvisosReservaWeb, NoVinoReservas, ReservasRepository};

pub async fn get_meta(repo: &dyn ReservasRepository) -> AppResult<ReservasMetaDto> {
    repo.meta().await
}

pub async fn get_mes(
    repo: &dyn ReservasRepository,
    args: ReservasGetMesArgs,
) -> AppResult<Vec<ReservaDto>> {
    let desde = normalize_dia_ymd(&args.desde).map_err(AppError::validation)?;
    let hasta = normalize_dia_ymd(&args.hasta).map_err(AppError::validation)?;
    repo.mes(&desde, &hasta).await
}

/// `ahora_local` («YYYY-MM-DD HH:MM», la hora del negocio) decide si al cliente de una reserva web
/// aún se le avisa: de una reserva que ya ha pasado, no.
pub async fn guardar(
    repo: &dyn ReservasRepository,
    notifier: Option<&dyn Notifier>,
    avisos: Option<&dyn AvisosReservaWeb>,
    input: ReservaSaveInput,
    ahora_local: &str,
) -> AppResult<bool> {
    // ¿Es un alta? (sin id -> el repo asigna uno). Se captura ANTES de `validar`, que consume input.
    let id_editada = input.id_reserva.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let es_nueva = id_editada.is_none();
    let dia = input.dia_ymd.trim().to_string();
    let hora = input.hora.trim().to_string();

    let visto = input.visto.map(Into::into);
    let mut validada = ReservaValidada::validar(tpv_domain::reservas::ReservaEntrada {
        id_reserva: input.id_reserva,
        dia_ymd: &input.dia_ymd,
        hora: &input.hora,
        turno: input.turno,
        comensales: input.comensales,
        duracion_min: input.duracion_min,
        nota: input.nota,
        id_mesa: input.id_mesa,
        id_cliente: input.id_cliente,
        nombre_cliente: input.nombre_cliente.clone(),
        telefono: input.telefono,
        email: input.email,
    })
    .map_err(AppError::validation)?;
    // RES-INC-03: sólo al editar.
    if validada.id.is_some() {
        validada.visto = visto;
    }

    // Cómo estaba, para saber si al cliente de una reserva web hay que decirle algo (§5.7).
    let antes = match (&id_editada, avisos) {
        (Some(id), Some(_)) => antes_de_cambiarla(repo, id).await,
        _ => None,
    };

    // El id con el que ha quedado: el de una nueva lo elige el repositorio, y el aviso lleva a ella.
    let id_reserva = repo.guardar(validada, input.forzar_solape.unwrap_or(false)).await?;
    let ok = true;

    if let (true, Some(antes), Some(avisos)) = (ok, antes, avisos) {
        avisar_al_cliente(repo, avisos, &antes, ahora_local).await;
    }

    // Aviso "nueva reserva" a los administradores (SOLO en altas, no al editar). Best-effort.
    if ok && es_nueva {
        if let Some(notifier) = notifier {
            // Sin cliente nuevo (asignada a uno que ya existe, o sin cliente, RI-61) va sólo la hora.
            let cuerpo = match input.nombre_cliente.as_deref().map(str::trim) {
                Some(nombre) if !nombre.is_empty() => format!("{nombre} · {dia} {hora}"),
                _ => format!("{dia} {hora}"),
            };
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "reserva_nueva".to_string(),
                    severidad: Severidad::Info,
                    titulo: "Nueva reserva".to_string(),
                    cuerpo: Some(cuerpo.trim().to_string()),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: Some("ver_reservas".to_string()),
                    payload: Some(payload_del_aviso(&id_reserva, &dia)),
                    clave_dedupe: None,
                    expira_en: None,
                })
                .await;
        }
    }

    Ok(ok)
}

/// El `payload` de un aviso de reserva (`accion: "ver_reservas"`): qué reserva es y de qué día, para
/// que la pantalla de Reservas abra ese día y la señale (`features/notificaciones/acciones.ts`). Lo
/// llevan todos los avisos de reservas: el de una nueva, el de una próxima y los de la web.
pub(crate) fn payload_del_aviso(id_reserva: &str, dia_ymd: &str) -> String {
    serde_json::json!({ "id_reserva": id_reserva, "dia_ymd": dia_ymd }).to_string()
}

/// RI-61: el cliente que ya tiene ese teléfono o ese email, para que la pantalla pregunte antes de
/// asignarle la reserva. Sin ninguno de los dos no hay nada que buscar.
pub async fn buscar_cliente(
    repo: &dyn ReservasRepository,
    args: ReservaBuscarClienteArgs,
) -> AppResult<Option<ClienteCoincidente>> {
    let telefono = args.telefono.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    // En minúsculas, como se guarda (`limpia_email`) y como lo compara el índice único.
    let email = args.email.map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty());
    if telefono.is_none() && email.is_none() {
        return Ok(None);
    }
    repo.buscar_cliente(telefono.as_deref(), email.as_deref()).await
}

/// Borra una reserva: desaparece. Una reserva web no se borra (el repositorio lo rechaza): se
/// cancela, para que quede constancia y a su cliente le llegue el correo (§5.6).
pub async fn eliminar(repo: &dyn ReservasRepository, input: ReservaDeleteInput) -> AppResult<bool> {
    let id = input.id_reserva.trim();
    if id.is_empty() {
        return Err(AppError::validation("Falta la reserva."));
    }
    repo.eliminar(id).await
}

/// Cancela una reserva que aún no ha llegado: se queda en la lista, cancelada. Si es una reserva
/// web por venir (y su hora no ha pasado a `ahora_local`), a su cliente se le avisa (§5.6).
pub async fn cancelar(
    repo: &dyn ReservasRepository,
    avisos: Option<&dyn AvisosReservaWeb>,
    input: ReservaCancelarInput,
    ahora_local: &str,
) -> AppResult<bool> {
    let id = input.id_reserva.trim();
    if id.is_empty() {
        return Err(AppError::validation("Falta la reserva."));
    }
    let antes = match avisos {
        Some(_) => antes_de_cambiarla(repo, id).await,
        None => None,
    };
    let ok = repo.cancelar(id).await?;
    if let (true, Some(antes), Some(avisos)) = (ok, antes, avisos) {
        avisar_al_cliente(repo, avisos, &antes, ahora_local).await;
    }
    Ok(ok)
}

/// Cuántas reservas marca «No vino» una pasada como mucho. Al encender el ajuste puede haber muchas
/// viejas: cada una es una escritura que sube a la nube, así que van por tandas, una cada pasada.
pub const MAX_NO_VINO_POR_VUELTA: i64 = 200;

/// «No vino» automático: lo que lleva sin llegar los minutos del negocio pasa a `NO_SHOW` (deja de
/// ocupar la mesa y sale atenuada en la lista). Al cliente de una reserva web no se le escribe:
/// `aviso_al_cliente` no tiene nada que decirle de una reserva sin presentarse.
pub async fn marcar_no_vino(repo: &dyn NoVinoReservas, ahora_local: &str) -> AppResult<usize> {
    repo.marcar_no_vino(ahora_local, MAX_NO_VINO_POR_VUELTA).await
}

/// Cómo está una reserva antes de cambiarla, si es una reserva web por venir: las demás no avisan
/// a nadie. Si no se puede leer se sigue sin aviso: el cambio es lo importante.
async fn antes_de_cambiarla(repo: &dyn ReservasRepository, id: &str) -> Option<ReservaDto> {
    repo.reserva(id)
        .await
        .ok()
        .flatten()
        .filter(|r| r.origen == "WEB" && r.estado == "PROXIMA")
}

/// Lo que le toca saber al cliente de una reserva web que estaba por venir, comparando cómo
/// estaba con cómo ha quedado (`None` si ya no está). Cancelada: que se ha cancelado. Otro día,
/// otra hora, otras personas u otra mesa: cómo queda. Nada más le importa (una nota, la duración).
pub fn aviso_al_cliente(antes: &ReservaDto, despues: Option<&ReservaDto>) -> Option<AvisoAlCliente> {
    let aviso = |tipo, r: &ReservaDto| AvisoAlCliente {
        id_reserva: r.id_reserva.clone(),
        tipo,
        dia_ymd: r.dia_ymd.clone(),
        hora: r.hora.clone(),
        personas: r.comensales,
        mesa: mesa_de(r),
        id_cliente: r.id_cliente.clone(),
        huella_correo: tpv_domain::reservas_web::huella_de_correo(r.email_cliente.as_deref()),
    };
    match despues {
        None => Some(aviso(TipoAvisoReservaWeb::Cancelada, antes)),
        Some(d) if d.estado == "CANCELADA" => Some(aviso(TipoAvisoReservaWeb::Cancelada, d)),
        Some(d) if d.estado != "PROXIMA" => None,
        Some(d) => {
            let cambia = d.dia_ymd != antes.dia_ymd
                || d.hora != antes.hora
                || d.comensales != antes.comensales
                || d.id_mesa != antes.id_mesa;
            cambia.then(|| aviso(TipoAvisoReservaWeb::Modificada, d))
        }
    }
}

/// El nombre de la mesa de una reserva, como va en el aviso; `None` sin mesa.
pub(crate) fn mesa_de(r: &ReservaDto) -> Option<String> {
    (!r.id_mesa.is_empty() && !r.numero_mesa.is_empty()).then(|| r.numero_mesa.clone())
}

/// Best-effort, como el aviso de «Nueva reserva»: el cambio ya está hecho, y lo que no se pueda
/// encolar lo apunta en el log la implementación del puerto. Si no se puede leer cómo ha quedado no
/// se avisa: «no la encuentro» no es «ya no está», y le diría al cliente que se ha cancelado.
///
/// Tampoco de una reserva cuya hora (la de después del cambio, que es la que lleva el aviso) ya ha
/// pasado: la cola de la Main lo descartaría, pero la Handy lo manda en el acto, y la pantalla ya no
/// promete el correo.
async fn avisar_al_cliente(
    repo: &dyn ReservasRepository,
    avisos: &dyn AvisosReservaWeb,
    antes: &ReservaDto,
    ahora_local: &str,
) {
    let Ok(despues) = repo.reserva(&antes.id_reserva).await else { return };
    let Some(aviso) = aviso_al_cliente(antes, despues.as_ref()) else { return };
    if tpv_domain::reservas_web::ya_ha_pasado(&aviso.dia_ymd, &aviso.hora, ahora_local) {
        return;
    }
    let _ = avisos.encolar(aviso).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    /// Antes que las reservas de estas pruebas (el 25/07/2026): todas están por venir.
    const AHORA: &str = "2026-07-01 12:00";

    struct RepoQueNoDebeLlamarse;
    #[async_trait]
    impl ReservasRepository for RepoQueNoDebeLlamarse {
        async fn meta(&self) -> AppResult<ReservasMetaDto> {
            panic!("repo llamado")
        }
        async fn mes(&self, _: &str, _: &str) -> AppResult<Vec<ReservaDto>> {
            panic!("repo llamado")
        }
        async fn reserva(&self, _: &str) -> AppResult<Option<ReservaDto>> {
            panic!("repo llamado")
        }
        async fn guardar(&self, _: ReservaValidada, _: bool) -> AppResult<String> {
            panic!("repo llamado")
        }
        async fn buscar_cliente(
            &self,
            _: Option<&str>,
            _: Option<&str>,
        ) -> AppResult<Option<ClienteCoincidente>> {
            panic!("repo llamado")
        }
        async fn eliminar(&self, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
        async fn cancelar(&self, _: &str) -> AppResult<bool> {
            panic!("repo llamado")
        }
    }

    /// Repo que acepta `guardar` (para probar la emisión sin tocar SQLite).
    struct RepoOk;
    #[async_trait]
    impl ReservasRepository for RepoOk {
        async fn meta(&self) -> AppResult<ReservasMetaDto> {
            unimplemented!("no usado en estos tests")
        }
        async fn mes(&self, _: &str, _: &str) -> AppResult<Vec<ReservaDto>> {
            Ok(vec![])
        }
        async fn reserva(&self, _: &str) -> AppResult<Option<ReservaDto>> {
            Ok(None)
        }
        async fn guardar(&self, _: ReservaValidada, _: bool) -> AppResult<String> {
            Ok("r-nueva".into())
        }
        async fn buscar_cliente(
            &self,
            _: Option<&str>,
            _: Option<&str>,
        ) -> AppResult<Option<ClienteCoincidente>> {
            Ok(None)
        }
        async fn eliminar(&self, _: &str) -> AppResult<bool> {
            Ok(true)
        }
        async fn cancelar(&self, _: &str) -> AppResult<bool> {
            Ok(true)
        }
    }

    #[derive(Default)]
    struct FakeNotifier {
        emitidas: std::sync::Mutex<Vec<NuevaNotificacion>>,
    }
    #[async_trait]
    impl Notifier for FakeNotifier {
        async fn emitir(&self, n: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(n);
            Ok("notif-1".into())
        }
        async fn resolver_por_clave(&self, _: &str) -> AppResult<bool> {
            Ok(false)
        }
    }

    fn input_reserva(id: Option<&str>) -> ReservaSaveInput {
        ReservaSaveInput {
            id_reserva: id.map(|s| s.to_string()),
            dia_ymd: "2026-07-25".into(),
            hora: "20:30".into(),
            turno: None,
            comensales: 2,
            duracion_min: None,
            forzar_solape: None,
            nota: None,
            id_mesa: Some("m1".into()),
            id_cliente: None,
            nombre_cliente: Some("Ana".into()),
            telefono: None,
            email: None,
            visto: None,
        }
    }

    #[tokio::test]
    async fn guardar_alta_emite_aviso_a_admin() {
        let notifier = FakeNotifier::default();
        assert!(guardar(&RepoOk, Some(&notifier), None, input_reserva(None), AHORA).await.unwrap());

        let emitidas = notifier.emitidas.lock().unwrap();
        assert_eq!(emitidas.len(), 1);
        assert_eq!(emitidas[0].tipo, "reserva_nueva");
        assert_eq!(emitidas[0].destino, Destino::Rol(ADMIN_ROL_ID.to_string()));
        // Lleva a la reserva: su id (el que le ha dado el repositorio) y su día.
        assert_eq!(emitidas[0].accion.as_deref(), Some("ver_reservas"));
        let payload: serde_json::Value = serde_json::from_str(emitidas[0].payload.as_deref().expect("payload")).unwrap();
        assert_eq!(payload, serde_json::json!({ "id_reserva": "r-nueva", "dia_ymd": "2026-07-25" }));
    }

    #[tokio::test]
    async fn una_reserva_sin_cliente_se_guarda_y_avisa_solo_con_la_hora() {
        // RI-61: sin cliente es un alta válida, no un «nombre_cliente required».
        let notifier = FakeNotifier::default();
        let input = ReservaSaveInput { nombre_cliente: None, ..input_reserva(None) };
        assert!(guardar(&RepoOk, Some(&notifier), None, input, AHORA).await.unwrap());

        let emitidas = notifier.emitidas.lock().unwrap();
        assert_eq!(emitidas[0].cuerpo.as_deref(), Some("2026-07-25 20:30"));
    }

    #[tokio::test]
    async fn buscar_cliente_sin_telefono_ni_email_no_pregunta_al_repo() {
        let args = ReservaBuscarClienteArgs { telefono: Some("  ".into()), email: None };
        assert_eq!(buscar_cliente(&RepoQueNoDebeLlamarse, args).await.unwrap(), None);
    }

    #[tokio::test]
    async fn guardar_edicion_no_emite() {
        let notifier = FakeNotifier::default();
        assert!(guardar(&RepoOk, Some(&notifier), None, input_reserva(Some("r1")), AHORA).await.unwrap());
        assert!(notifier.emitidas.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn get_mes_rechaza_fechas_invalidas_antes_del_repo() {
        let args = ReservasGetMesArgs {
            desde: "22/07/2026".into(),
            hasta: "2026-07-31".into(),
        };
        assert!(matches!(
            get_mes(&RepoQueNoDebeLlamarse, args).await,
            Err(AppError::Validation(_))
        ));
    }

    #[tokio::test]
    async fn eliminar_y_cancelar_exigen_id() {
        let input = ReservaDeleteInput {
            id_reserva: " ".into(),
        };
        assert!(matches!(
            eliminar(&RepoQueNoDebeLlamarse, input).await,
            Err(AppError::Validation(_))
        ));
        let input = ReservaCancelarInput { id_reserva: " ".into() };
        assert!(matches!(
            cancelar(&RepoQueNoDebeLlamarse, None, input, AHORA).await,
            Err(AppError::Validation(_))
        ));
    }

    // ── El aviso al cliente de una reserva web (docs/estudios/reservas-web.md §5.7) ──

    fn web(estado: &str) -> ReservaDto {
        ReservaDto {
            id_reserva: "r1".into(),
            id_mesa: "m1".into(),
            dia_ymd: "2026-07-25".into(),
            hora: "20:30".into(),
            turno: None,
            comensales: 2,
            duracion_min: None,
            nota: None,
            estado: estado.into(),
            origen: "WEB".into(),
            id_cliente: Some("c1".into()),
            nombre_cliente: "Ana".into(),
            telefono_cliente: None,
            email_cliente: Some("ana@correo.es".into()),
            id_zona: "z1".into(),
            numero_mesa: "Mesa 1".into(),
            capacidad: 4,
            nombre_zona: "Salón".into(),
        }
    }

    /// Una base con una reserva: `guardar` la cambia como lo haría el repo, `eliminar` la borra y
    /// `cancelar` cancela la que aún no ha llegado (la ya cancelada la deja como está).
    struct RepoConUna(std::sync::Mutex<Option<ReservaDto>>);
    #[async_trait]
    impl ReservasRepository for RepoConUna {
        async fn meta(&self) -> AppResult<ReservasMetaDto> {
            unimplemented!("no usado en estos tests")
        }
        async fn mes(&self, _: &str, _: &str) -> AppResult<Vec<ReservaDto>> {
            unimplemented!("no usado en estos tests")
        }
        async fn reserva(&self, _: &str) -> AppResult<Option<ReservaDto>> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn guardar(&self, v: ReservaValidada, _: bool) -> AppResult<String> {
            let mut r = self.0.lock().unwrap();
            let r = r.as_mut().expect("hay reserva");
            r.dia_ymd = v.dia_ymd;
            r.hora = v.hora;
            r.comensales = v.comensales;
            r.nota = v.nota;
            r.id_mesa = v.id_mesa.unwrap_or_default();
            r.numero_mesa = if r.id_mesa == "m2" { "Terraza 2".into() } else { "Mesa 1".into() };
            Ok(r.id_reserva.clone())
        }
        async fn buscar_cliente(&self, _: Option<&str>, _: Option<&str>) -> AppResult<Option<ClienteCoincidente>> {
            Ok(None)
        }
        async fn eliminar(&self, _: &str) -> AppResult<bool> {
            Ok(self.0.lock().unwrap().take().is_some())
        }
        async fn cancelar(&self, _: &str) -> AppResult<bool> {
            let mut r = self.0.lock().unwrap();
            match r.as_mut() {
                None => Ok(false),
                Some(x) if x.estado == "PROXIMA" || x.estado == "CANCELADA" => {
                    x.estado = "CANCELADA".into();
                    Ok(true)
                }
                Some(_) => Err(AppError::conflict("ya no está pendiente")),
            }
        }
    }

    #[derive(Default)]
    struct Avisos(std::sync::Mutex<Vec<AvisoAlCliente>>);
    #[async_trait]
    impl AvisosReservaWeb for Avisos {
        async fn encolar(&self, aviso: AvisoAlCliente) -> AppResult<()> {
            self.0.lock().unwrap().push(aviso);
            Ok(())
        }
    }

    fn editar(cambio: impl FnOnce(&mut ReservaSaveInput)) -> ReservaSaveInput {
        let mut i = input_reserva(Some("r1"));
        i.id_cliente = Some("c1".into());
        i.nombre_cliente = None;
        cambio(&mut i);
        i
    }

    #[tokio::test]
    async fn cambiar_la_hora_o_la_mesa_de_una_reserva_web_por_venir_avisa_con_como_queda() {
        let repo = RepoConUna(std::sync::Mutex::new(Some(web("PROXIMA"))));
        let avisos = Avisos::default();
        guardar(&repo, None, Some(&avisos), editar(|i| i.hora = "22:00".into()), AHORA).await.unwrap();
        guardar(&repo, None, Some(&avisos), editar(|i| {
            i.hora = "22:00".into();
            i.id_mesa = Some("m2".into());
        }), AHORA)
        .await
        .unwrap();
        let avisos = avisos.0.lock().unwrap();
        assert_eq!(
            *avisos,
            vec![
                AvisoAlCliente {
                    id_reserva: "r1".into(),
                    tipo: TipoAvisoReservaWeb::Modificada,
                    dia_ymd: "2026-07-25".into(),
                    hora: "22:00".into(),
                    personas: 2,
                    mesa: Some("Mesa 1".into()),
                    id_cliente: Some("c1".into()),
                    huella_correo: tpv_domain::reservas_web::huella_de_correo(Some("ana@correo.es")),
                },
                AvisoAlCliente {
                    id_reserva: "r1".into(),
                    tipo: TipoAvisoReservaWeb::Modificada,
                    dia_ymd: "2026-07-25".into(),
                    hora: "22:00".into(),
                    personas: 2,
                    mesa: Some("Terraza 2".into()),
                    id_cliente: Some("c1".into()),
                    huella_correo: tpv_domain::reservas_web::huella_de_correo(Some("ana@correo.es")),
                },
            ]
        );
    }

    #[tokio::test]
    async fn lo_que_no_le_importa_al_cliente_no_le_avisa() {
        // Sólo la nota: la hora, el día, las personas y la mesa siguen igual.
        let repo = RepoConUna(std::sync::Mutex::new(Some(web("PROXIMA"))));
        let avisos = Avisos::default();
        guardar(&repo, None, Some(&avisos), editar(|i| i.nota = Some("Junto a la ventana".into())), AHORA).await.unwrap();
        assert!(avisos.0.lock().unwrap().is_empty());

        // Una reserva del TPV, o una web que ya no está por venir, no avisa a nadie.
        for r in [ReservaDto { origen: "TPV".into(), ..web("PROXIMA") }, web("ACTIVA"), web("CANCELADA")] {
            let repo = RepoConUna(std::sync::Mutex::new(Some(r)));
            guardar(&repo, None, Some(&avisos), editar(|i| i.hora = "22:00".into()), AHORA).await.unwrap();
        }
        assert!(avisos.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelar_una_reserva_web_por_venir_avisa_una_sola_vez() {
        let repo = RepoConUna(std::sync::Mutex::new(Some(web("PROXIMA"))));
        let avisos = Avisos::default();
        let cancela = || ReservaCancelarInput { id_reserva: "r1".into() };
        assert!(cancelar(&repo, Some(&avisos), cancela(), AHORA).await.unwrap());
        assert_eq!(repo.0.lock().unwrap().as_ref().map(|r| r.estado.clone()), Some("CANCELADA".into()));
        assert_eq!(avisos.0.lock().unwrap().iter().map(|a| a.tipo).collect::<Vec<_>>(), [TipoAvisoReservaWeb::Cancelada]);

        // Ya cancelada: cancelarla otra vez no hace nada, y no se le vuelve a escribir.
        assert!(cancelar(&repo, Some(&avisos), cancela(), AHORA).await.unwrap());
        assert_eq!(avisos.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn de_una_reserva_web_que_ya_ha_pasado_no_se_avisa() {
        // La reserva es el 25/07 a las 20:30. La Handy manda el aviso en el acto: sin esto, cancelar
        // o mover una que ya pasó le escribía al cliente aunque la pantalla no lo prometiera.
        let avisos = Avisos::default();
        let cancela = || ReservaCancelarInput { id_reserva: "r1".into() };

        // A las 21:00 ya ha pasado: cancelarla no avisa.
        let repo = RepoConUna(std::sync::Mutex::new(Some(web("PROXIMA"))));
        assert!(cancelar(&repo, Some(&avisos), cancela(), "2026-07-25 21:00").await.unwrap());
        assert!(avisos.0.lock().unwrap().is_empty());

        // Moverla a una hora que también ha pasado, tampoco.
        let repo = RepoConUna(std::sync::Mutex::new(Some(web("PROXIMA"))));
        guardar(&repo, None, Some(&avisos), editar(|i| i.hora = "20:00".into()), "2026-07-25 20:15").await.unwrap();
        assert!(avisos.0.lock().unwrap().is_empty());

        // Moverla a una hora que aún no ha llegado sí: el aviso lleva la hora nueva.
        let repo = RepoConUna(std::sync::Mutex::new(Some(web("PROXIMA"))));
        guardar(&repo, None, Some(&avisos), editar(|i| i.hora = "22:00".into()), "2026-07-25 21:00").await.unwrap();
        assert_eq!(avisos.0.lock().unwrap().iter().map(|a| a.hora.clone()).collect::<Vec<_>>(), ["22:00"]);
    }

    #[tokio::test]
    async fn cancelar_una_del_tpv_no_avisa_a_nadie() {
        let repo = RepoConUna(std::sync::Mutex::new(Some(ReservaDto { origen: "TPV".into(), ..web("PROXIMA") })));
        let avisos = Avisos::default();
        assert!(cancelar(&repo, Some(&avisos), ReservaCancelarInput { id_reserva: "r1".into() }, AHORA).await.unwrap());
        assert_eq!(repo.0.lock().unwrap().as_ref().map(|r| r.estado.clone()), Some("CANCELADA".into()));
        assert!(avisos.0.lock().unwrap().is_empty());
    }

    /// Como `RepoConUna`, pero la lectura de después del cambio falla (la red de la Handy).
    struct RepoQueNoRelee(RepoConUna, std::sync::atomic::AtomicUsize);
    #[async_trait]
    impl ReservasRepository for RepoQueNoRelee {
        async fn meta(&self) -> AppResult<ReservasMetaDto> {
            unimplemented!("no usado en estos tests")
        }
        async fn mes(&self, _: &str, _: &str) -> AppResult<Vec<ReservaDto>> {
            unimplemented!("no usado en estos tests")
        }
        async fn reserva(&self, id: &str) -> AppResult<Option<ReservaDto>> {
            if self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                return Err(AppError::external("sin red"));
            }
            self.0.reserva(id).await
        }
        async fn guardar(&self, v: ReservaValidada, f: bool) -> AppResult<String> {
            self.0.guardar(v, f).await
        }
        async fn buscar_cliente(&self, t: Option<&str>, e: Option<&str>) -> AppResult<Option<ClienteCoincidente>> {
            self.0.buscar_cliente(t, e).await
        }
        async fn eliminar(&self, id: &str) -> AppResult<bool> {
            self.0.eliminar(id).await
        }
        async fn cancelar(&self, id: &str) -> AppResult<bool> {
            self.0.cancelar(id).await
        }
    }

    #[tokio::test]
    async fn si_no_se_puede_leer_como_ha_quedado_no_se_avisa_de_nada() {
        // Guardado; lo que no se sabe es cómo ha quedado. No es «ya no está»: no se le dice al
        // cliente que se ha cancelado.
        let repo = RepoQueNoRelee(RepoConUna(std::sync::Mutex::new(Some(web("PROXIMA")))), Default::default());
        let avisos = Avisos::default();
        assert!(guardar(&repo, None, Some(&avisos), editar(|i| i.hora = "22:00".into()), AHORA).await.unwrap());
        assert!(avisos.0.lock().unwrap().is_empty());

        let repo = RepoQueNoRelee(RepoConUna(std::sync::Mutex::new(Some(web("PROXIMA")))), Default::default());
        assert!(cancelar(&repo, Some(&avisos), ReservaCancelarInput { id_reserva: "r1".into() }, AHORA).await.unwrap());
        assert!(avisos.0.lock().unwrap().is_empty());
    }

    #[test]
    fn el_aviso_sale_de_como_estaba_y_como_queda() {
        let antes = web("PROXIMA");
        // Ya no está (se borró por otro lado): cancelada, con lo que tenía.
        assert_eq!(aviso_al_cliente(&antes, None).map(|a| (a.tipo, a.hora)), Some((TipoAvisoReservaWeb::Cancelada, "20:30".into())));
        // Sentados o no presentados: no es un cambio para el cliente.
        assert_eq!(aviso_al_cliente(&antes, Some(&web("ACTIVA"))), None);
        assert_eq!(aviso_al_cliente(&antes, Some(&web("NO_SHOW"))), None);
        // Sin mesa, el aviso va sin mesa.
        let sin_mesa = ReservaDto { id_mesa: String::new(), numero_mesa: String::new(), ..web("PROXIMA") };
        assert_eq!(aviso_al_cliente(&antes, Some(&sin_mesa)).and_then(|a| a.mesa), None);
        // Otras personas, otro día.
        let mas = ReservaDto { comensales: 4, dia_ymd: "2026-07-26".into(), ..web("PROXIMA") };
        let a = aviso_al_cliente(&antes, Some(&mas)).unwrap();
        assert_eq!((a.tipo, a.personas, a.dia_ymd.as_str()), (TipoAvisoReservaWeb::Modificada, 4, "2026-07-26"));
    }

    #[test]
    fn fecha_de_reserva_acepta_timestamp_y_extrae_el_dia() {
        assert_eq!(normalize_dia_ymd(" 2026-07-22T18:30:00Z ").unwrap(), "2026-07-22");
    }

    #[test]
    fn fecha_de_reserva_rechaza_formato_y_mes_imposibles() {
        assert!(normalize_dia_ymd("22-07-2026").is_err());
        assert!(normalize_dia_ymd("2026-13-01").is_err());
    }
}
