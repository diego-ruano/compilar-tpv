//! Contrato de errores de la frontera UI <-> Rust (ARCH-02 / ARCH-05).
//!
//! Antes, un error cruzaba la frontera como `String` y el frontend decidía qué hacer
//! comparando el TEXTO del mensaje. Eso hacía que reescribir un mensaje pudiera romper
//! una rama de la UI sin que ningún compilador se enterase, y que en Sentry dos
//! redacciones del mismo fallo fuesen dos errores distintos.
//!
//! Ahora cruza `AppErrorDto { code, message }`:
//!   · `code`    → estable, cerrado y compartido (Rust · worker · frontend). Es por lo
//!                 que se ramifica.
//!   · `message` → texto libre, diagnóstico. Se muestra y se registra, NUNCA se compara.
//!
//! ## Cómo se elige un código
//!
//! El catálogo es **deliberadamente corto**. Un código nuevo se añade sólo cuando la UI
//! (o el worker) necesita **distinguir ese caso para hacer algo diferente**. Si el único
//! uso es enseñárselo al usuario, NO es un código: es un `message` con el código genérico
//! que corresponda (`Validation`, `Conflict`, …). Enumerar aquí cada mensaje del repo
//! convertiría este enum en una lista inmantenible de doscientas variantes.
//!
//! El valor serializado (snake_case) es el **mismo string** que ya usan el worker y el
//! frontend, para que el contrato sea uno solo en las tres capas.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Catálogo cerrado de códigos de error. Compartido por Rust, el worker y el frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub enum ErrorCode {
    // ── Genéricos: CLASIFICAN el fallo, no lo identifican ──────────────────────
    /// Entrada inválida o regla de dominio incumplida. El detalle va en `message`.
    Validation,
    /// La entidad pedida no existe.
    NotFound,
    /// El estado actual no admite la operación (comanda cerrada, stock insuficiente…).
    Conflict,
    /// Fallo de persistencia (SQLite/libsql).
    Repository,
    /// Fallo de un servicio externo (red, worker, licencias).
    External,
    /// Cualquier otro fallo inesperado.
    Internal,

    // ── Negocio: la UI RAMIFICA por ellos ──────────────────────────────────────
    /// Emparejamiento Handy todavía sin aprobar en la Main. El polling de `AppBoot`
    /// lo trata como "sigue esperando", no como error: es el caso que obligaba a
    /// existir al antiguo `AppError::Raw`.
    NotApproved,
    /// No hay ninguna Main conectada al TenantHub: las Handy congelan su UI.
    MainOffline,
    /// El dispositivo fue revocado desde la Main.
    DeviceRevoked,
    /// La licencia del tenant está caducada o bloqueada.
    LicenseExpired,
    /// No existe licencia activa para este tenant.
    LicenseNotFound,
    /// PIN incorrecto en login/fichaje.
    InvalidPin,
}

impl ErrorCode {
    /// Mensaje por defecto, para cuando no hay detalle que añadir.
    pub fn default_message(self) -> &'static str {
        match self {
            ErrorCode::Validation => "Datos no válidos",
            ErrorCode::NotFound => "No encontrado",
            ErrorCode::Conflict => "La operación no es posible en el estado actual",
            ErrorCode::Repository => "Error de base de datos",
            ErrorCode::External => "Error de un servicio externo",
            ErrorCode::Internal => "Error interno",
            ErrorCode::NotApproved => "Emparejamiento pendiente de aprobación",
            ErrorCode::MainOffline => "No hay ningún TPV principal conectado",
            ErrorCode::DeviceRevoked => "Este dispositivo ha sido revocado",
            ErrorCode::LicenseExpired => "La licencia ha caducado",
            ErrorCode::LicenseNotFound => "No hay una licencia activa",
            ErrorCode::InvalidPin => "PIN incorrecto",
        }
    }

    /// Resuelve el código a partir del string que devuelve el worker en `{ "error": … }`.
    ///
    /// Los códigos que el worker emite y la UI **no** ramifica caen a `External` a
    /// propósito: su texto sigue viajando en `message`, que es donde debe estar.
    pub fn from_wire(s: &str) -> Self {
        match s.trim() {
            "not_approved" => ErrorCode::NotApproved,
            "main_offline" => ErrorCode::MainOffline,
            "device_revoked" | "revoked" => ErrorCode::DeviceRevoked,
            "license_expired" | "expired" => ErrorCode::LicenseExpired,
            "no_active_license_for_tenant" | "license_not_found" => ErrorCode::LicenseNotFound,
            "invalid_pin" => ErrorCode::InvalidPin,
            "validation_error" => ErrorCode::Validation,
            "not_found" => ErrorCode::NotFound,
            _ => ErrorCode::External,
        }
    }
}

/// Error tal y como lo recibe el frontend. Es el `Err` de **todos** los comandos Tauri.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AppErrorDto {
    /// Código estable. Es lo único por lo que se debe ramificar.
    pub code: ErrorCode,
    /// Texto diagnóstico, legible. Se muestra y se registra; nunca se compara.
    pub message: String,
}

impl AppErrorDto {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        let message = message.into();
        let message = if message.trim().is_empty() {
            code.default_message().to_string()
        } else {
            message
        };
        Self { code, message }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

/// Puente para los helpers de la shell (`lib.rs`, `AppState`) que todavía producen
/// `String`: rutas de AppData, ficheros de configuración, resolución de repositorios…
///
/// No es un atajo para la lógica de negocio: un error de dominio debe nacer como
/// `AppError` con su variante, para que llegue aquí con un código que signifique algo.
/// Lo que cae por este `From` es, por definición, un fallo interno de la shell.
impl From<String> for AppErrorDto {
    fn from(message: String) -> Self {
        AppErrorDto::new(ErrorCode::Internal, message)
    }
}

impl From<&str> for AppErrorDto {
    fn from(message: &str) -> Self {
        AppErrorDto::new(ErrorCode::Internal, message)
    }
}

impl std::fmt::Display for AppErrorDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppErrorDto {}
