//! Error común de la capa de aplicación.
//!
//! Los casos de uso devuelven `Result<T, AppError>`. Los adaptadores de infraestructura
//! convierten sus errores concretos (libsql, reqwest, io, etc.) en estas variantes.
//! En la frontera Tauri, los comandos mapean `AppError` a `String` (Local-First: el
//! frontend asume éxito, así que un error es excepcional y se transmite como mensaje).

use thiserror::Error;

/// Error de aplicación, agnóstico de la tecnología concreta de infraestructura.
#[derive(Debug, Error)]
pub enum AppError {
    /// Validación de dominio o de entrada fallida.
    #[error("validación: {0}")]
    Validation(String),

    /// Entidad no encontrada.
    #[error("no encontrado: {0}")]
    NotFound(String),

    /// Conflicto de estado (p. ej. comanda ya cerrada, stock insuficiente).
    #[error("conflicto: {0}")]
    Conflict(String),

    /// Fallo en la capa de persistencia (repositorio).
    #[error("repositorio: {0}")]
    Repository(String),

    /// Fallo en un servicio externo (red, licenciamiento, backup).
    #[error("servicio externo: {0}")]
    External(String),

    /// Cualquier otro error inesperado.
    #[error("interno: {0}")]
    Internal(String),

    /// Error que debe llegar al frontend **verbatim, sin prefijo**. Se reserva para
    /// códigos de error de negocio devueltos por servicios externos cuyo string exacto
    /// es load-bearing en el frontend (p. ej. `not_approved` en el polling de pairing
    /// Handy, comparado por igualdad estricta en AppBoot).
    #[error("{0}")]
    Raw(String),
}

impl AppError {
    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError::NotFound(msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        AppError::Conflict(msg.into())
    }
    pub fn repository(msg: impl Into<String>) -> Self {
        AppError::Repository(msg.into())
    }
    pub fn external(msg: impl Into<String>) -> Self {
        AppError::External(msg.into())
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        AppError::Internal(msg.into())
    }
    /// Error sin prefijo (verbatim) para códigos de negocio de servicios externos.
    pub fn raw(msg: impl Into<String>) -> Self {
        AppError::Raw(msg.into())
    }
}

/// Conversión a `String` para la frontera Tauri (`Result<T, String>`).
impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

pub type AppResult<T> = Result<T, AppError>;
