//! Casos de uso de login / auth / fichaje. Local-First: validan, hacen la cripto del PIN
//! con el dominio e invocan el puerto. Las escrituras "OK" devuelven `()` (el comando mapea).

use tpv_contracts::login::{
    CompleteInitialSetupInput, LoginOk, LoginUserArgs, PunchInput, PunchStatus, PunchStatusArgs,
    SetTurnoPartidoInput, UserListItem,
};
use tpv_domain::login::{
    hash_pin, limpiar_opcional, requerido, validate_email_basic, verify_pin,
};

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
    let rec = repo
        .get_login_record(args.id_usuario)
        .await?
        .ok_or_else(|| AppError::not_found("Usuario no encontrado o inactivo"))?;

    verify_pin(&args.pin, &rec.password_hash).map_err(AppError::validation)?;

    Ok(LoginOk {
        id_usuario: rec.id_usuario,
        id_trabajador: rec.id_trabajador,
        nombre: rec.nombre,
        apellido: rec.apellido,
        rol: rec.rol,
        email: rec.email,
        requiere_setup: rec.requiere_setup,
    })
}

pub async fn get_today_punch_status(
    repo: &dyn LoginRepository,
    args: PunchStatusArgs,
) -> AppResult<PunchStatus> {
    repo.get_today_punch_status(args.id_usuario).await
}

pub async fn set_turno_partido_hoy(
    repo: &dyn LoginRepository,
    input: SetTurnoPartidoInput,
) -> AppResult<()> {
    if input.id_usuario <= 0 {
        return Err(AppError::validation("id_usuario inválido"));
    }
    repo.set_turno_partido(
        input.id_usuario,
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

    if input.id_usuario <= 0 {
        return Err(AppError::validation("id_usuario inválido"));
    }
    if pin_nuevo.trim().len() < 4 {
        return Err(AppError::validation("El PIN nuevo debe tener al menos 4 dígitos"));
    }
    if !validate_email_basic(&email_nuevo) {
        return Err(AppError::validation("Email inválido"));
    }

    let info = repo
        .get_setup_info(input.id_usuario)
        .await?
        .ok_or_else(|| AppError::not_found("Usuario no encontrado"))?;

    if info.requiere_setup == 0 {
        return Err(AppError::conflict("Este usuario ya completó el setup inicial"));
    }

    verify_pin(&pin_actual, &info.password_hash).map_err(AppError::validation)?;

    if repo.email_in_use(email_nuevo.trim(), input.id_usuario).await? {
        return Err(AppError::conflict("Ese email ya está en uso"));
    }

    let new_hash = hash_pin(pin_nuevo.trim()).map_err(AppError::validation)?;

    repo.apply_initial_setup(input.id_usuario, email_nuevo.trim().to_string(), new_hash)
        .await
}

pub async fn punch(repo: &dyn LoginRepository, input: PunchInput) -> AppResult<PunchStatus> {
    if input.id_usuario <= 0 {
        return Err(AppError::validation("id_usuario inválido"));
    }

    let tipo = requerido(&input.tipo, "tipo")
        .map_err(AppError::validation)?
        .to_lowercase();

    if tipo != "entrada" && tipo != "salida" {
        return Err(AppError::validation("Tipo inválido (usa 'entrada' o 'salida')"));
    }

    let hash = repo
        .get_password_hash(input.id_usuario)
        .await?
        .ok_or_else(|| AppError::not_found("Usuario no encontrado o inactivo"))?;

    verify_pin(&input.pin, &hash).map_err(AppError::validation)?;

    repo.punch(
        input.id_usuario,
        tipo,
        limpiar_opcional(input.fecha),
        limpiar_opcional(input.hora_evento),
    )
    .await
}
