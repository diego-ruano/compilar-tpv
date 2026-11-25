//! Política por capacidad, independiente de SQLite/HTTP/Tauri.
use crate::{
    error::{AppError, AppResult},
    ports::permisos::PermisosRepository,
};
use tpv_contracts::{errors::ErrorCode, permisos::*};
use tpv_domain::permisos::{self, ADMIN, CATALOGO};

fn denegado() -> AppError {
    AppError::coded(ErrorCode::PermisoDenegado, "No tienes permiso para esta acción")
}

/// El usuario de la sesión existe pero ya no está activo: lo desactivó un administrador con la
/// sesión abierta. Lo devuelve el repositorio (el SQLite de la Main y, en la Handy, el worker con el
/// mismo código y el mismo texto), y la pantalla cierra la sesión.
pub fn usuario_inactivo() -> AppError {
    AppError::coded(ErrorCode::UsuarioInactivo, tpv_contracts::errors::USUARIO_INACTIVO)
}

pub async fn usuario(repo: &dyn PermisosRepository, id: &str) -> AppResult<AutorizacionUsuario> {
    let mut usuario = repo.usuario(id).await?.ok_or_else(denegado)?;
    usuario.permisos.retain(|p| permisos::conocido(p));
    if usuario.rol == ADMIN {
        usuario.permisos = CATALOGO.iter().map(|(codigo, _, _)| codigo.to_string()).collect();
    }
    usuario.permisos.sort();
    usuario.permisos.dedup();
    Ok(usuario)
}

pub async fn configuracion(
    repo: &dyn PermisosRepository,
    actor: &str,
) -> AppResult<ConfiguracionPermisos> {
    if usuario(repo, actor).await?.rol != ADMIN {
        return Err(denegado());
    }
    let roles = repo.roles().await?;
    let catalogo = CATALOGO.iter().map(|(codigo, nombre, grupo)| PermisoDef {
        codigo: codigo.to_string(),
        nombre: nombre.to_string(),
        grupo: grupo.to_string(),
    }).collect();
    Ok(ConfiguracionPermisos { catalogo, roles })
}

pub async fn guardar(
    repo: &dyn PermisosRepository,
    actor: &str,
    mut input: GuardarPermisosInput,
) -> AppResult<()> {
    if usuario(repo, actor).await?.rol != ADMIN {
        return Err(denegado());
    }
    permisos::validar_lista(&input.permisos).map_err(AppError::validation)?;
    permisos::validar_lista(&input.permisos_vistos).map_err(AppError::validation)?;
    input.permisos.sort();
    input.permisos_vistos.sort();
    repo.guardar(actor, input).await
}
