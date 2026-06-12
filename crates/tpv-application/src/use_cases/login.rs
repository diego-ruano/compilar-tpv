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
        return Err(AppError::validation("El PIN nuevo debe tener al menos 4 dígitos"));
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
        return Err(AppError::validation("Tipo inválido (usa 'entrada' o 'salida')"));
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
