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

    /// Valor serializado del código. Espejo explícito de lo que produce serde; hay un test
    /// que comprueba que no se separan.
    pub fn wire(self) -> &'static str {
        match self {
            ErrorCode::Validation => "validation",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Conflict => "conflict",
            ErrorCode::Repository => "repository",
            ErrorCode::External => "external",
            ErrorCode::Internal => "internal",
            ErrorCode::NotApproved => "not_approved",
            ErrorCode::MainOffline => "main_offline",
            ErrorCode::DeviceRevoked => "device_revoked",
            ErrorCode::LicenseExpired => "license_expired",
            ErrorCode::LicenseNotFound => "license_not_found",
            ErrorCode::InvalidPin => "invalid_pin",
        }
    }

    /// Parsea un valor del **propio catálogo** (`{ "code": … }` de una respuesta del worker).
    ///
    /// Devuelve `None` si no lo reconoce, que es lo que pasa cuando un worker más nuevo manda
    /// un código que este cliente todavía no conoce. El llamante debe entonces recurrir a
    /// `from_wire`: degradar a genérico es preferible a inventarse un código.
    ///
    /// No es lo mismo que `from_wire`: aquélla traduce el *string de negocio*
    /// (`"no_active_license_for_tenant"`), ésta lee el código ya resuelto (`"license_not_found"`).
    pub fn from_code(s: &str) -> Option<Self> {
        let s = s.trim().to_ascii_lowercase();
        [
            ErrorCode::Validation,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::Repository,
            ErrorCode::External,
            ErrorCode::Internal,
            ErrorCode::NotApproved,
            ErrorCode::MainOffline,
            ErrorCode::DeviceRevoked,
            ErrorCode::LicenseExpired,
            ErrorCode::LicenseNotFound,
            ErrorCode::InvalidPin,
        ]
        .into_iter()
        .find(|c| c.wire() == s)
    }

    /// Resuelve el código a partir del string que devuelve el worker en `{ "error": … }`.
    ///
    /// Normaliza espacios y mayúsculas antes de buscar: el código de error de una respuesta
    /// no debe depender de cómo lo escribiera quien lo emitió. Sin esto, un `Revoked` en vez
    /// de `revoked` degradaría en silencio a genérico y la UI dejaría de ramificar.
    ///
    /// Los códigos que el worker emite y la UI **no** ramifica caen a `External` a
    /// propósito: su texto sigue viajando en `message`, que es donde debe estar.
    pub fn from_wire(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
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
        let limpio = message.trim();

        // `message` se PINTA en la UI. Dos casos en los que el texto recibido no sirve para
        // enseñárselo a nadie y se sustituye por el legible del catálogo:
        //   · vacío,
        //   · el propio identificador de máquina — que es justo lo que llega cuando el error
        //     nace de un código del worker (`AppError::from_wire("main_offline")`), porque
        //     ahí el string ES el código. Sin esto, el usuario leía "main_offline".
        let message = if limpio.is_empty() || limpio.eq_ignore_ascii_case(code.wire()) {
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

#[cfg(test)]
mod tests {
    //! Tests del contrato de errores (ARCH-05).
    //!
    //! Se escriben contra el **fixture compartido**
    //! (`packages/contracts/fixtures/error-codes.json`), no contra el `match` de abajo: el
    //! fixture lo leen también los tests del worker, así que si un lado cambia un mapeo y el
    //! otro no, uno de los dos se pone rojo. Copiar aquí la tabla de la implementación no
    //! probaría nada: sólo diría que el código es igual a sí mismo.

    use super::*;
    use serde::Deserialize;

    const FIXTURE: &str = include_str!("../../../packages/contracts/fixtures/error-codes.json");

    #[derive(Debug, Deserialize)]
    struct Caso {
        wire: String,
        #[serde(default)]
        code: Option<String>,
        porque: String,
    }

    #[derive(Debug, Deserialize)]
    struct Fixture {
        negocio: Vec<Caso>,
        normalizacion: Vec<Caso>,
        desconocidos: Vec<Caso>,
        #[serde(rename = "codigosDeNegocio")]
        codigos_de_negocio: Vec<String>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("el fixture compartido debe ser JSON válido")
    }

    /// Serializa el código como lo ve el cable (lo mismo que verá el worker y el frontend).
    fn wire_de(code: ErrorCode) -> String {
        serde_json::to_value(code)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn cada_codigo_de_negocio_del_fixture_se_traduce_igual() {
        for caso in fixture().negocio {
            let esperado = caso.code.clone().expect("los casos de negocio llevan `code`");
            let obtenido = wire_de(ErrorCode::from_wire(&caso.wire));
            assert_eq!(
                obtenido, esperado,
                "'{}' debería mapear a '{}' ({})",
                caso.wire, esperado, caso.porque
            );
        }
    }

    #[test]
    fn la_busqueda_normaliza_espacios_y_mayusculas() {
        for caso in fixture().normalizacion {
            let esperado = caso.code.clone().expect("los casos de normalización llevan `code`");
            let obtenido = wire_de(ErrorCode::from_wire(&caso.wire));
            assert_eq!(
                obtenido, esperado,
                "'{}' debería normalizarse a '{}' ({})",
                caso.wire.escape_debug(),
                esperado,
                caso.porque
            );
        }
    }

    /// Un código desconocido NO puede colarse como uno de negocio: eso haría que la UI
    /// ramificara por un caso que no es. Que caiga en un genérico es lo correcto.
    #[test]
    fn lo_desconocido_no_se_disfraza_de_codigo_de_negocio() {
        let f = fixture();
        for caso in f.desconocidos {
            let code = ErrorCode::from_wire(&caso.wire);
            let obtenido = wire_de(code);
            assert!(
                !f.codigos_de_negocio.contains(&obtenido),
                "'{}' no debería mapear al código de negocio '{}' ({})",
                caso.wire,
                obtenido,
                caso.porque
            );
        }
    }

    /// Si alguien añade un código de negocio al enum y se olvida del mapeo, este test lo caza.
    #[test]
    fn todos_los_codigos_de_negocio_tienen_al_menos_un_string_que_los_produce() {
        let f = fixture();
        let producidos: Vec<String> = f
            .negocio
            .iter()
            .filter_map(|c| c.code.clone())
            .collect();

        for code in &f.codigos_de_negocio {
            assert!(
                producidos.contains(code),
                "el código de negocio '{code}' no lo produce ningún string del fixture: \
                 nadie podría llegar a él desde una respuesta del worker"
            );
        }
    }

    /// El fixture no puede quedarse corto respecto al enum: si el catálogo crece con un código
    /// de negocio nuevo, hay que declarar cómo se llega a él.
    #[test]
    fn el_fixture_cubre_todos_los_codigos_de_negocio_del_enum() {
        // Lista explícita: los genéricos clasifican y no se alcanzan desde un string.
        let genericos = [
            ErrorCode::Validation,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::Repository,
            ErrorCode::External,
            ErrorCode::Internal,
        ];
        let todos = [
            ErrorCode::Validation,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::Repository,
            ErrorCode::External,
            ErrorCode::Internal,
            ErrorCode::NotApproved,
            ErrorCode::MainOffline,
            ErrorCode::DeviceRevoked,
            ErrorCode::LicenseExpired,
            ErrorCode::LicenseNotFound,
            ErrorCode::InvalidPin,
        ];

        let f = fixture();
        for code in todos {
            if genericos.contains(&code) {
                continue;
            }
            let s = wire_de(code);
            assert!(
                f.codigos_de_negocio.contains(&s),
                "el código '{s}' es de negocio pero no está en `codigosDeNegocio` del fixture"
            );
        }
    }

    #[test]
    fn ningun_codigo_se_queda_sin_mensaje_legible() {
        let todos = [
            ErrorCode::Validation,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::Repository,
            ErrorCode::External,
            ErrorCode::Internal,
            ErrorCode::NotApproved,
            ErrorCode::MainOffline,
            ErrorCode::DeviceRevoked,
            ErrorCode::LicenseExpired,
            ErrorCode::LicenseNotFound,
            ErrorCode::InvalidPin,
        ];

        for code in todos {
            let msg = code.default_message();
            assert!(!msg.trim().is_empty(), "{code:?} sin mensaje");
            // Un mensaje por defecto es para enseñárselo a alguien: no puede ser el propio
            // identificador de máquina.
            assert_ne!(
                msg,
                wire_de(code),
                "{code:?}: el mensaje por defecto no puede ser el código en crudo"
            );
        }
    }

    /// El `message` que llega a la UI se PINTA. Un código de máquina en crudo ("main_offline")
    /// no es un mensaje: si el error no trae texto propio, hay que enseñar el legible.
    #[test]
    fn un_mensaje_que_solo_es_el_codigo_se_sustituye_por_texto_legible() {
        let dto = AppErrorDto::new(ErrorCode::MainOffline, "main_offline");
        assert_eq!(dto.code, ErrorCode::MainOffline);
        assert_ne!(
            dto.message, "main_offline",
            "un mensaje que es literalmente el código no sirve para enseñárselo a nadie"
        );
        assert_eq!(dto.message, ErrorCode::MainOffline.default_message());
    }

    #[test]
    fn el_mensaje_de_verdad_se_respeta() {
        let dto = AppErrorDto::new(ErrorCode::Validation, "El email no es válido");
        assert_eq!(dto.message, "El email no es válido");
    }

    #[test]
    fn un_mensaje_vacio_o_en_blanco_cae_al_legible() {
        for entrada in ["", "   ", "\t\n"] {
            let dto = AppErrorDto::new(ErrorCode::Conflict, entrada);
            assert_eq!(dto.message, ErrorCode::Conflict.default_message());
        }
    }

    /// El DTO viaja por el IPC de Tauri: tiene que sobrevivir a serializar y deserializar.
    #[test]
    fn el_dto_sobrevive_al_viaje_por_el_cable() {
        for code in [
            ErrorCode::NotApproved,
            ErrorCode::Internal,
            ErrorCode::LicenseExpired,
        ] {
            let original = AppErrorDto::new(code, "detalle con acentos: ñ á ü — y comillas \"x\"");
            let json = serde_json::to_string(&original).unwrap();
            let vuelta: AppErrorDto = serde_json::from_str(&json).unwrap();

            assert_eq!(vuelta.code, original.code);
            assert_eq!(vuelta.message, original.message);
        }
    }

    /// La forma serializada es contrato con el worker y el frontend: `{code, message}` con el
    /// código en snake_case. Cambiarla rompe a los tres a la vez.
    #[test]
    fn la_forma_serializada_es_la_esperada() {
        let json = serde_json::to_value(AppErrorDto::new(ErrorCode::NotApproved, "x")).unwrap();
        assert_eq!(json["code"], "not_approved");
        assert_eq!(json["message"], "x");

        let obj = json.as_object().unwrap();
        assert_eq!(
            obj.len(),
            2,
            "el DTO debe llevar exactamente `code` y `message`, tiene: {:?}",
            obj.keys().collect::<Vec<_>>()
        );
    }
}
