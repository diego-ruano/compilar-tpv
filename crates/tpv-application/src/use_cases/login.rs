//! Casos de uso de login / auth / fichaje. Validan/normalizan la entrada y delegan en el
//! puerto, que verifica el PIN dentro del adaptador (local o nube). Las escrituras "OK"
//! devuelven `()` (el comando mapea).

use tpv_contracts::login::{
    CompleteInitialSetupInput, LoginOk, LoginUserArgs, PunchInput, PunchStatus, PunchStatusArgs,
    SetTurnoPartidoInput, UserListItem,
};
use tpv_domain::login::{hash_pin, limpiar_opcional, requerido, validate_email_basic};

use crate::error::{AppError, AppResult};
use crate::ports::login::LoginRepository;

/// Hash de un PIN (comando `hash_password`). Cómputo puro de dominio.
pub fn hash_password(pin: &str) -> AppResult<String> {
    hash_pin(pin).map_err(AppError::validation)
}

pub async fn list_login_users(repo: &dyn LoginRepository) -> AppResult<Vec<UserListItem>> {
    repo.list_login_users().await
}

pub async fn login_user(repo: &dyn LoginRepository, args: LoginUserArgs) -> AppResult<LoginOk> {
    repo.login(&args.id_usuario, &args.pin).await
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
    let pin_actual = requerido(&input.pin_actual, "pin_actual").map_err(AppError::validation)?;
    let pin_nuevo = requerido(&input.pin_nuevo, "pin_nuevo").map_err(AppError::validation)?;

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
