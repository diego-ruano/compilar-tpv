//! Casos de uso de reservas (Local-First).

use tpv_contracts::reservas::{
    ClienteCoincidente, ReservaBuscarClienteArgs, ReservaDeleteInput, ReservaDto,
    ReservaSaveInput, ReservasGetMesArgs, ReservasMetaDto,
};
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};
use tpv_domain::reservas::{normalize_dia_ymd, ReservaValidada};

use crate::error::{AppError, AppResult};
use crate::ports::notificaciones::Notifier;
use crate::ports::reservas::ReservasRepository;

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

pub async fn guardar(
    repo: &dyn ReservasRepository,
    notifier: Option<&dyn Notifier>,
    input: ReservaSaveInput,
) -> AppResult<bool> {
    // ¿Es un alta? (sin id -> el repo asigna uno). Se captura ANTES de `validar`, que consume input.
    let es_nueva = input
        .id_reserva
        .as_deref()
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);
    let dia = input.dia_ymd.trim().to_string();
    let hora = input.hora.trim().to_string();

    let validada = ReservaValidada::validar(tpv_domain::reservas::ReservaEntrada {
        id_reserva: input.id_reserva,
        dia_ymd: &input.dia_ymd,
        hora: &input.hora,
        turno: input.turno,
        comensales: input.comensales,
        duracion_min: input.duracion_min,
        nota: input.nota,
        estado: input.estado,
        id_mesa: input.id_mesa,
        id_cliente: input.id_cliente,
        nombre_cliente: input.nombre_cliente.clone(),
        telefono: input.telefono,
        email: input.email,
    })
    .map_err(AppError::validation)?;

    let ok = repo.guardar(validada, input.forzar_solape.unwrap_or(false)).await?;

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
                    payload: None,
                    clave_dedupe: None,
                    expira_en: None,
                })
                .await;
        }
    }

    Ok(ok)
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

pub async fn eliminar(repo: &dyn ReservasRepository, input: ReservaDeleteInput) -> AppResult<bool> {
    if input.id_reserva.trim().is_empty() {
        return Err(AppError::validation("ID_Reserva inválido"));
    }
    repo.eliminar(&input.id_reserva).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    struct RepoQueNoDebeLlamarse;
    #[async_trait]
    impl ReservasRepository for RepoQueNoDebeLlamarse {
        async fn meta(&self) -> AppResult<ReservasMetaDto> {
            panic!("repo llamado")
        }
        async fn mes(&self, _: &str, _: &str) -> AppResult<Vec<ReservaDto>> {
            panic!("repo llamado")
        }
        async fn guardar(&self, _: ReservaValidada, _: bool) -> AppResult<bool> {
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
        async fn guardar(&self, _: ReservaValidada, _: bool) -> AppResult<bool> {
            Ok(true)
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
            estado: None,
            id_mesa: Some("m1".into()),
            id_cliente: None,
            nombre_cliente: Some("Ana".into()),
            telefono: None,
            email: None,
        }
    }

    #[tokio::test]
    async fn guardar_alta_emite_aviso_a_admin() {
        let notifier = FakeNotifier::default();
        assert!(guardar(&RepoOk, Some(&notifier), input_reserva(None)).await.unwrap());

        let emitidas = notifier.emitidas.lock().unwrap();
        assert_eq!(emitidas.len(), 1);
        assert_eq!(emitidas[0].tipo, "reserva_nueva");
        assert_eq!(emitidas[0].destino, Destino::Rol(ADMIN_ROL_ID.to_string()));
    }

    #[tokio::test]
    async fn una_reserva_sin_cliente_se_guarda_y_avisa_solo_con_la_hora() {
        // RI-61: sin cliente es un alta válida, no un «nombre_cliente required».
        let notifier = FakeNotifier::default();
        let input = ReservaSaveInput { nombre_cliente: None, ..input_reserva(None) };
        assert!(guardar(&RepoOk, Some(&notifier), input).await.unwrap());

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
        assert!(guardar(&RepoOk, Some(&notifier), input_reserva(Some("r1"))).await.unwrap());
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
    async fn eliminar_exige_id() {
        let input = ReservaDeleteInput {
            id_reserva: " ".into(),
        };
        assert!(matches!(
            eliminar(&RepoQueNoDebeLlamarse, input).await,
            Err(AppError::Validation(_))
        ));
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
