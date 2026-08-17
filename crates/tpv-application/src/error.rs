//! Error común de la capa de aplicación.
//!
//! Los casos de uso devuelven `Result<T, AppError>`. Los adaptadores de infraestructura
//! convierten sus errores concretos (libsql, reqwest, io, etc.) en estas variantes.
//!
//! En la frontera Tauri, los comandos devuelven `Result<T, AppErrorDto>` (ARCH-02/05):
//! ya NO se aplana a `String`. Cada variante tiene un `ErrorCode` estable y el texto
//! viaja aparte, en `message`, para que el frontend ramifique por código y no por texto.

use thiserror::Error;
use tpv_contracts::errors::{AppErrorDto, ErrorCode};

/// Error de aplicación, agnóstico de la tecnología concreta de infraestructura.
#[derive(Debug, Error)]
pub enum AppError {
    /// Validación de dominio o de entrada fallida.
    #[error("{0}")]
    Validation(String),

    /// Entidad no encontrada.
    #[error("{0}")]
    NotFound(String),

    /// Conflicto de estado (p. ej. comanda ya cerrada, stock insuficiente).
    #[error("{0}")]
    Conflict(String),

    /// Fallo en la capa de persistencia (repositorio).
    #[error("{0}")]
    Repository(String),

    /// Fallo en un servicio externo (red, licenciamiento, backup).
    #[error("{0}")]
    External(String),

    /// Cualquier otro error inesperado.
    #[error("{0}")]
    Internal(String),

    /// Error de negocio con **código explícito** del catálogo compartido.
    ///
    /// Sustituye al antiguo `AppError::Raw`, que propagaba el string del worker
    /// verbatim porque el frontend lo comparaba por igualdad (p. ej. `not_approved`).
    /// Ahora lo que se propaga es el código; el texto es sólo diagnóstico.
    #[error("{1}")]
    Coded(ErrorCode, String),
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

    /// Error con un código concreto del catálogo.
    pub fn coded(code: ErrorCode, msg: impl Into<String>) -> Self {
        AppError::Coded(code, msg.into())
    }

    /// Error a partir de un código de negocio devuelto por el worker
    /// (`{ "error": "…" }`). El string se traduce a código y se conserva como texto.
    pub fn from_wire(wire: impl Into<String>) -> Self {
        let wire = wire.into();
        AppError::Coded(ErrorCode::from_wire(&wire), wire)
    }

    /// Código estable de esta variante.
    pub fn code(&self) -> ErrorCode {
        match self {
            AppError::Validation(_) => ErrorCode::Validation,
            AppError::NotFound(_) => ErrorCode::NotFound,
            AppError::Conflict(_) => ErrorCode::Conflict,
            AppError::Repository(_) => ErrorCode::Repository,
            AppError::External(_) => ErrorCode::External,
            AppError::Internal(_) => ErrorCode::Internal,
            AppError::Coded(code, _) => *code,
        }
    }
}

/// Conversión al DTO de la frontera Tauri (`Result<T, AppErrorDto>`).
impl From<AppError> for AppErrorDto {
    fn from(e: AppError) -> Self {
        AppErrorDto::new(e.code(), e.to_string())
    }
}

/// Compatibilidad con el código de la shell (`lib.rs`) que todavía produce `String`
/// en helpers internos: se clasifica como interno y el texto se conserva.
impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

pub type AppResult<T> = Result<T, AppError>;
