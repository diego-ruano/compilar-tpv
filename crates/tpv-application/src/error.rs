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

#[cfg(test)]
mod tests_contrato {
    //! Mapeo `AppError` → `AppErrorDto` (ARCH-05).
    //!
    //! Lo que se prueba no es que el `match` sea el `match`, sino las propiedades que la UI y
    //! la telemetría dan por ciertas: que cada variante llegue con un código que signifique
    //! algo, que el detalle no se pierda por el camino, y que un error nacido de un código
    //! del worker conserve ESE código y no uno genérico.

    use super::*;
    use tpv_contracts::errors::ErrorCode;

    /// Una muestra de cada variante, con un detalle reconocible.
    fn todas() -> Vec<(AppError, ErrorCode)> {
        vec![
            (AppError::validation("email inválido"), ErrorCode::Validation),
            (AppError::not_found("mesa 7"), ErrorCode::NotFound),
            (AppError::conflict("comanda cerrada"), ErrorCode::Conflict),
            (AppError::repository("no such table"), ErrorCode::Repository),
            (AppError::external("timeout"), ErrorCode::External),
            (AppError::internal("panic"), ErrorCode::Internal),
            (
                AppError::coded(ErrorCode::MainOffline, "sin Main"),
                ErrorCode::MainOffline,
            ),
        ]
    }

    #[test]
    fn cada_variante_conserva_su_codigo_al_cruzar_la_frontera() {
        for (err, esperado) in todas() {
            let dto: AppErrorDto = err.into();
            assert_eq!(dto.code, esperado);
        }
    }

    /// Regresión de la razón de ser de todo esto: antes el detalle se aplanaba a un `String`
    /// con prefijo ("validación: …") y el frontend hacía `includes()` sobre él.
    #[test]
    fn el_detalle_llega_entero_y_sin_prefijos() {
        let dto: AppErrorDto = AppError::validation("El email no es válido").into();

        assert_eq!(dto.message, "El email no es válido");
        assert!(!dto.message.contains("validación"), "no debe llevar prefijo: {}", dto.message);
        assert!(!dto.message.contains(':'), "no debe llevar prefijo: {}", dto.message);
    }

    /// El caso que obligaba a existir a `AppError::Raw`: el código del worker tiene que
    /// sobrevivir hasta la UI. Si degradara a genérico, `AppBoot` dejaría de distinguir
    /// "sigue esperando aprobación" de un fallo de verdad y rompería el emparejamiento.
    #[test]
    fn un_codigo_de_negocio_del_worker_sobrevive_hasta_el_dto() {
        let dto: AppErrorDto = AppError::from_wire("not_approved").into();
        assert_eq!(dto.code, ErrorCode::NotApproved);

        let dto: AppErrorDto = AppError::from_wire("  MAIN_OFFLINE ").into();
        assert_eq!(dto.code, ErrorCode::MainOffline);
    }

    /// Un código que el worker inventa mañana no puede tumbar al cliente ni disfrazarse de
    /// otro: cae en genérico y su texto se conserva para diagnosticar.
    #[test]
    fn un_codigo_desconocido_degrada_a_generico_sin_perder_el_texto() {
        let dto: AppErrorDto = AppError::from_wire("tenant_db_provision_failed").into();

        assert_eq!(dto.code, ErrorCode::External);
        assert!(
            dto.message.contains("tenant_db_provision_failed"),
            "el texto original debe conservarse: {}",
            dto.message
        );
    }

    /// `?` sobre un `AppError` dentro de un comando Tauri pasa por este `From`. Si se
    /// perdiera el código, todos los errores del sistema serían "internal".
    #[test]
    fn el_interrogante_de_los_comandos_no_aplasta_el_codigo() {
        fn comando() -> Result<(), AppErrorDto> {
            Err(AppError::conflict("stock insuficiente"))?;
            Ok(())
        }

        let err = comando().unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert_eq!(err.message, "stock insuficiente");
    }

    /// Los helpers de la shell siguen produciendo `String`. Ese puente debe clasificar como
    /// interno — pero nunca robarle el código a un error que sí lo traía.
    #[test]
    fn el_puente_desde_string_solo_afecta_a_los_strings() {
        let desde_string: AppErrorDto = "no se pudo leer AppData".to_string().into();
        assert_eq!(desde_string.code, ErrorCode::Internal);
        assert_eq!(desde_string.message, "no se pudo leer AppData");

        let desde_error: AppErrorDto = AppError::not_found("cliente").into();
        assert_eq!(desde_error.code, ErrorCode::NotFound);
    }

    /// Un mensaje enorme o con caracteres raros no puede romper la serialización: es lo que
    /// llega cuando el error trae dentro un volcado de SQL o una respuesta HTTP entera.
    #[test]
    fn aguanta_mensajes_hostiles() {
        let hostil = format!(
            "{} \"comillas\" \\barras\\ \n saltos \t tabs ñáü 中文 {}",
            "x".repeat(5000),
            "🙂"
        );

        let dto: AppErrorDto = AppError::repository(hostil.clone()).into();
        let json = serde_json::to_string(&dto).unwrap();
        let vuelta: AppErrorDto = serde_json::from_str(&json).unwrap();

        assert_eq!(vuelta.code, ErrorCode::Repository);
        assert_eq!(vuelta.message, hostil);
    }
}
