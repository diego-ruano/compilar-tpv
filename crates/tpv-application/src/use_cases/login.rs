//! Casos de uso de login / auth / fichaje. Validan/normalizan la entrada y delegan en el
//! puerto, que verifica el PIN dentro del adaptador (local o nube). Las escrituras "OK"
//! devuelven `()` (el comando mapea).

use tpv_contracts::login::{
    CompleteInitialSetupInput, LoginOk, LoginUserArgs, PunchInput, PunchStatus, PunchStatusArgs,
    SetTurnoPartidoInput, SetupPendiente, UserListItem,
};
use tpv_domain::login::{hash_pin, limpiar_opcional, requerido, validate_email_basic};
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::{AppError, AppResult};
use crate::ports::login::LoginRepository;
use crate::ports::notificaciones::Notifier;

/// Umbral de intentos de PIN fallidos consecutivos que dispara el aviso de seguridad.
const UMBRAL_LOGIN_FALLIDOS: i64 = 5;

/// Hash de un PIN (comando `hash_password`). Cómputo puro de dominio.
pub fn hash_password(pin: &str) -> AppResult<String> {
    hash_pin(pin).map_err(AppError::validation)
}

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

    res
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
    let pin_nuevo = requerido(&input.pin_nuevo, "pin_nuevo").map_err(AppError::validation)?;
    // El PIN actual sólo viaja por el camino con sesión (Handy → worker). En el primer arranque
    // el setup ocurre ANTES del login y no hay ninguno que confirmar.
    let pin_actual = input.pin_actual.clone().unwrap_or_default();

    if input.id_usuario.trim().is_empty() {
        return Err(AppError::validation("id_usuario inválido"));
    }
    if pin_nuevo.trim().len() < 4 {
        return Err(AppError::validation(
            "El PIN nuevo debe tener al menos 4 dígitos",
        ));
    }
    if !validate_email_basic(&email_nuevo) {
        return Err(AppError::validation("Email inválido"));
    }

    repo.complete_initial_setup(
        &input.id_usuario,
        pin_actual.trim(),
        pin_nuevo.trim(),
        email_nuevo.trim(),
    )
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

    repo.punch(
        &input.id_usuario,
        &input.pin,
        &tipo,
        limpiar_opcional(input.fecha),
        limpiar_opcional(input.hora_evento),
    )
    .await
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
        async fn complete_initial_setup(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> AppResult<()> {
            unimplemented!("no usado")
        }
        async fn punch(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: Option<String>,
            _: Option<String>,
        ) -> AppResult<PunchStatus> {
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

    #[test]
    fn hash_password_genera_hash_verificable_y_no_deja_pin_en_claro() {
        let hash = hash_password("1234").unwrap();
        assert_ne!(hash, "1234");
        assert!(tpv_domain::login::verify_pin("1234", &hash).is_ok());
        assert!(tpv_domain::login::verify_pin("9999", &hash).is_err());
    }

    #[test]
    fn hash_password_rechaza_pin_invalido() {
        assert!(matches!(hash_password(" "), Err(AppError::Validation(_))));
    }

    #[test]
    fn hashes_del_mismo_pin_tienen_salts_distintos() {
        let primero = hash_password("1234").unwrap();
        let segundo = hash_password("1234").unwrap();
        assert_ne!(primero, segundo);
        assert!(tpv_domain::login::verify_pin("1234", &primero).is_ok());
        assert!(tpv_domain::login::verify_pin("1234", &segundo).is_ok());
    }

    #[test]
    fn pin_se_verifica_tras_recortar_extremos() {
        let hash = hash_password(" 1234 ").unwrap();
        assert!(tpv_domain::login::verify_pin("1234", &hash).is_ok());
    }

    #[test]
    fn pin_alfanumerico_se_hashea_y_verifica() {
        let hash = hash_password("Abc12345").unwrap();
        assert!(tpv_domain::login::verify_pin("Abc12345", &hash).is_ok());
        assert!(tpv_domain::login::verify_pin("Abc12346", &hash).is_err());
    }

    #[test]
    fn pin_alfanumerico_distingue_mayusculas_y_minusculas() {
        let hash = hash_password("Clave9X").unwrap();
        assert!(tpv_domain::login::verify_pin("Clave9X", &hash).is_ok());
        assert!(tpv_domain::login::verify_pin("clave9x", &hash).is_err());
        assert!(tpv_domain::login::verify_pin("CLAVE9X", &hash).is_err());
    }

    #[test]
    fn pin_admite_simbolos_sin_perder_entropia() {
        let hash = hash_password("Barra#27!").unwrap();
        assert!(tpv_domain::login::verify_pin("Barra#27!", &hash).is_ok());
        assert!(tpv_domain::login::verify_pin("Barra27", &hash).is_err());
        assert!(tpv_domain::login::verify_pin("Barra#27?", &hash).is_err());
    }

    #[test]
    fn pin_con_espacios_interiores_los_conserva() {
        let hash = hash_password("cafe 2026").unwrap();
        assert!(tpv_domain::login::verify_pin("cafe 2026", &hash).is_ok());
        assert!(tpv_domain::login::verify_pin("cafe2026", &hash).is_err());
        // Solo se eliminan espacios de los extremos.
        assert!(tpv_domain::login::verify_pin("  cafe 2026  ", &hash).is_ok());
    }

    #[test]
    fn pin_unicode_se_verifica_sin_normalizaciones_ocultas() {
        let hash = hash_password("CafÃ©42Ã±").unwrap();
        assert!(tpv_domain::login::verify_pin("CafÃ©42Ã±", &hash).is_ok());
        assert!(tpv_domain::login::verify_pin("Cafe42n", &hash).is_err());
    }

    #[test]
    fn pin_alfanumerico_demasiado_corto_se_rechaza() {
        assert!(matches!(hash_password("a1"), Err(AppError::Validation(_))));
        assert!(matches!(hash_password("X9 "), Err(AppError::Validation(_))));
    }
}
