//! Casos de uso de login / auth / fichaje. Validan/normalizan la entrada y delegan en el
//! puerto, que verifica el PIN dentro del adaptador (local o nube). Las escrituras "OK"
//! devuelven `()` (el comando mapea).

use tpv_contracts::login::{
    CompleteInitialSetupInput, LoginOk, LoginUserArgs, PunchInput, PunchStatus, PunchStatusArgs,
    SetTurnoPartidoInput, SetupPendiente, UserListItem,
};
use tpv_domain::login::{limpiar_opcional, pin_de_teclado, requerido, validate_email_basic};
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::{AppError, AppResult};
use crate::ports::login::LoginRepository;
use crate::ports::notificaciones::Notifier;

/// Umbral de intentos de PIN fallidos consecutivos que dispara el aviso de seguridad.
const UMBRAL_LOGIN_FALLIDOS: i64 = 5;

pub async fn list_login_users(repo: &dyn LoginRepository) -> AppResult<Vec<UserListItem>> {
    repo.list_login_users().await
}

pub async fn setup_pendiente(repo: &dyn LoginRepository) -> AppResult<SetupPendiente> {
    repo.setup_pendiente().await
}

pub async fn login_user(
    repo: &dyn LoginRepository,
    notifier: Option<&dyn Notifier>,
    args: LoginUserArgs,
) -> AppResult<LoginOk> {
    let res = repo.login(&args.id_usuario, &args.pin).await;

    // Aviso de seguridad a admins EXACTAMENTE al alcanzar el umbral de fallos consecutivos (una vez
    // por racha; el 6º, 7º… no re-emiten, y un login correcto resetea el contador). Best-effort.
    if res.is_err() {
        if let Some(notifier) = notifier {
            if let Ok(n) = repo.intentos_fallidos(&args.id_usuario).await {
                if n == UMBRAL_LOGIN_FALLIDOS {
                    let _ = notifier
                        .emitir(NuevaNotificacion {
                            tipo: "login_fallidos".to_string(),
                            severidad: Severidad::Aviso,
                            titulo: "Varios intentos de acceso fallidos".to_string(),
                            cuerpo: Some(format!(
                                "Se han registrado {UMBRAL_LOGIN_FALLIDOS} intentos de PIN fallidos seguidos."
                            )),
                            destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                            accion: None,
                            payload: None,
                            clave_dedupe: None,
                            expira_en: None,
                        })
                        .await;
                }
            }
        }
    }

    let ok = res?;
    // El comando establece la sesión sólo cuando este caso de uso termina correctamente.
    // Se consulta tras verificar el PIN, también si el frontend invoca directamente por IPC.
    let estado = repo.get_today_punch_status(&ok.id_usuario).await?;
    let primera = estado.partes.iter().find(|p| p.parte == 1);
    let segunda = estado.partes.iter().find(|p| p.parte == 2);
    tpv_domain::login::validar_acceso_por_fichaje(
        primera.is_some_and(|p| p.entrada.is_some()),
        primera.is_some_and(|p| p.salida.is_some()),
        estado.turno_partido == 1,
        segunda.is_some_and(|p| p.entrada.is_some()),
    ).map_err(AppError::validation)?;
    Ok(ok)
}

pub async fn get_today_punch_status(
    repo: &dyn LoginRepository,
    args: PunchStatusArgs,
) -> AppResult<PunchStatus> {
    repo.get_today_punch_status(&args.id_usuario).await
}

pub async fn set_turno_partido_hoy(
    repo: &dyn LoginRepository,
    input: SetTurnoPartidoInput,
) -> AppResult<()> {
    if input.id_usuario.trim().is_empty() {
        return Err(AppError::validation("id_usuario inválido"));
    }
    repo.set_turno_partido(
        &input.id_usuario,
        limpiar_opcional(input.fecha),
        input.turno_partido,
    )
    .await
}

pub async fn complete_initial_setup(
    repo: &dyn LoginRepository,
    input: CompleteInitialSetupInput,
) -> AppResult<()> {
    let email_nuevo = requerido(&input.email_nuevo, "email_nuevo").map_err(AppError::validation)?;
    // RI-63: el mismo PIN que se puede teclear en el login, no sólo «al menos 4».
    let pin_nuevo = pin_de_teclado(&input.pin_nuevo).map_err(AppError::validation)?;

    if input.id_usuario.trim().is_empty() {
        return Err(AppError::validation("id_usuario inválido"));
    }
    if !validate_email_basic(&email_nuevo) {
        return Err(AppError::validation("Email inválido"));
    }

    repo.complete_initial_setup(&input.id_usuario, &pin_nuevo, email_nuevo.trim())
        .await
}

pub async fn punch(repo: &dyn LoginRepository, input: PunchInput) -> AppResult<PunchStatus> {
    if input.id_usuario.trim().is_empty() {
        return Err(AppError::validation("id_usuario inválido"));
    }

    let tipo = requerido(&input.tipo, "tipo")
        .map_err(AppError::validation)?
        .to_lowercase();

    if tipo != "entrada" && tipo != "salida" {
        return Err(AppError::validation(
            "Tipo inválido (usa 'entrada' o 'salida')",
        ));
    }

    repo.punch(&input.id_usuario, &input.pin, &tipo).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct FakeLogin {
        fallidos: i64,
    }
    #[async_trait]
    impl LoginRepository for FakeLogin {
        async fn list_login_users(&self) -> AppResult<Vec<UserListItem>> {
            Ok(vec![])
        }
        async fn setup_pendiente(&self) -> AppResult<SetupPendiente> {
            unimplemented!("no usado")
        }
        async fn get_today_punch_status(&self, _: &str) -> AppResult<PunchStatus> {
            unimplemented!("no usado")
        }
        async fn login(&self, _: &str, _: &str) -> AppResult<LoginOk> {
            Err(AppError::validation("PIN incorrecto"))
        }
        async fn intentos_fallidos(&self, _: &str) -> AppResult<i64> {
            Ok(self.fallidos)
        }
        async fn complete_initial_setup(&self, _: &str, _: &str, _: &str) -> AppResult<()> {
            unimplemented!("no usado")
        }
        async fn punch(&self, _: &str, _: &str, _: &str) -> AppResult<PunchStatus> {
            unimplemented!("no usado")
        }
        async fn set_turno_partido(
            &self,
            _: &str,
            _: Option<String>,
            _: bool,
        ) -> AppResult<()> {
            unimplemented!("no usado")
        }
    }

    #[derive(Default)]
    struct FakeNotifier {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
    }
    #[async_trait]
    impl Notifier for FakeNotifier {
        async fn emitir(&self, n: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(n);
            Ok("n".into())
        }
        async fn resolver_por_clave(&self, _: &str) -> AppResult<bool> {
            Ok(false)
        }
    }

    #[tokio::test]
    async fn login_emite_aviso_al_quinto_fallo() {
        let repo = FakeLogin { fallidos: 5 };
        let notifier = FakeNotifier::default();
        let args = LoginUserArgs { id_usuario: "u1".into(), pin: "0000".into() };
        assert!(login_user(&repo, Some(&notifier), args).await.is_err());

        let e = notifier.emitidas.lock().unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].tipo, "login_fallidos");
        assert_eq!(e[0].destino, Destino::Rol(ADMIN_ROL_ID.to_string()));
    }

    #[tokio::test]
    async fn login_no_emite_antes_del_umbral() {
        let repo = FakeLogin { fallidos: 4 };
        let notifier = FakeNotifier::default();
        let args = LoginUserArgs { id_usuario: "u1".into(), pin: "0000".into() };
        assert!(login_user(&repo, Some(&notifier), args).await.is_err());
        assert!(notifier.emitidas.lock().unwrap().is_empty());
    }
}
