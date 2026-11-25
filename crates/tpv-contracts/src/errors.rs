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
/// Catálogo cerrado de códigos de error. Compartido por Rust, el worker y el frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, strum::VariantArray, strum::IntoStaticStr)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ErrorCode {
    // ── Genéricos: CLASIFICAN el fallo, no lo identifican ──────────────────────
    /// Entrada inválida o regla de dominio incumplida. El detalle va en `message`.
    Validation,
    /// La entidad pedida no existe.
    NotFound,
    /// El estado actual no admite la operación (comanda cerrada, stock insuficiente…).
    Conflict,
    /// Fallo de la base SQLite local de la Main. Sólo lo emite Rust: las bases de la nube (la de
    /// cada negocio, en el SQLite de su Durable Object, y la central, en el objeto `BaseCentral`)
    /// son cosa del worker, que no manda este código.
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
    /// El servidor confirma que el tenant no tiene base de datos aprovisionada. Sólo este caso
    /// permite ofrecer la creación de una base nueva; un timeout o un 500 genérico no.
    TenantDbNotProvisioned,
    /// El volcado completo excede el límite seguro del Worker.
    BootstrapTooLarge,
    /// Una migración ya registrada cambió de contenido en el servidor.
    TenantMigrationAltered,
    /// El fichero elegido no es una copia SQLite íntegra y utilizable.
    BackupCorrupt,
    /// Quien ha invocado el comando no tiene sesión, o su rol no basta para lo que pide
    /// (SEC-01). La UI ramifica por él para llevar al login en vez de enseñar un fallo
    /// genérico: "no puedes" y "ha fallado" piden cosas distintas de quien está delante.
    PermisoDenegado,
    /// Faltan el NIF o la razón social del obligado, así que no se puede generar el registro de
    /// facturación — y sin registro no se puede cobrar (art. 9 RRSIF: el registro se crea de forma
    /// simultánea o inmediatamente anterior a la expedición de la factura).
    ///
    /// Tiene código propio porque la UI **hace algo distinto**: lleva al formulario de datos
    /// fiscales en vez de enseñar "no se puede cobrar", que es lo único que vería el camarero con
    /// un código genérico. Es la única puerta que Veri*factu añade al camino de la venta, y va
    /// antes de la primera venta y no a mitad de servicio.
    DatosFiscalesIncompletos,
    /// El importe del cobro **pasa del límite de la factura simplificada** (3.000 € con IVA en
    /// hostelería, art. 4.2 RD 1619/2012) y no se han dado los datos del cliente.
    ///
    /// Por encima de esa cifra no cabe una `F2`: la AEAT la rechaza (error 1150), y una `F1` sin
    /// destinatario es imposible (el bloque `Destinatarios` es obligatorio, error 1189). O sea que
    /// no hay ninguna factura que emitir con lo que hay.
    ///
    /// Tiene código propio porque la UI **hace algo distinto**: abre el formulario de datos
    /// fiscales y reintenta el mismo cobro con el NIF y el nombre. No es un fallo, es un dato que
    /// falta — y quien lo tiene es el cliente que está delante.
    FacturaCompletaRequerida,
    /// La reserva **se pisa con otra de la misma mesa**, o la mesa tiene una comanda abierta en ese
    /// rato, y el negocio tiene los solapes en «permitir con aviso» (RI-61).
    ///
    /// Tiene código propio porque la UI **hace algo distinto**: enseña el choque y ofrece «guardar
    /// igualmente», que reenvía la misma reserva con `forzar_solape`. Con los solapes prohibidos
    /// el rechazo es un `Conflict` normal: no hay nada que ofrecer.
    ReservaSolapada,
    /// El usuario de la sesión **ya no está activo**: un administrador lo ha desactivado con la
    /// sesión abierta.
    ///
    /// Tiene código propio porque la UI **hace algo distinto**: cierra la sesión y el login dice por
    /// qué. Con `PermisoDenegado` la aplicación se quedaba en una pantalla de error sin salida.
    UsuarioInactivo,
}

/// Lo que se dice cuando el usuario de la sesión ya no está activo. El mismo texto en la Main y en el
/// worker (`MENSAJES.usuario_inactivo` en `lib/errorCodes.ts`).
pub const USUARIO_INACTIVO: &str = "Tu usuario ya no está activo. Habla con un administrador.";

impl ErrorCode {
    /// Catálogo generado desde el enum; no hay listas paralelas (RI-48).
    pub const TODOS: &'static [ErrorCode] = <Self as strum::VariantArray>::VARIANTS;

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
            ErrorCode::TenantDbNotProvisioned => "No existe una base de datos en la nube",
            ErrorCode::BootstrapTooLarge => {
                // DO-02: sólo llega si ni lo imprescindible para trabajar cabe en una descarga.
                "Lo imprescindible para volver a trabajar no cabe en una sola descarga desde la nube"
            }
            ErrorCode::TenantMigrationAltered => {
                "La versión de la base de datos de la nube es incompatible"
            }
            ErrorCode::BackupCorrupt => "La copia de seguridad local está dañada",
            ErrorCode::PermisoDenegado => "No tienes permiso para hacer esto",
            ErrorCode::DatosFiscalesIncompletos => {
                "Faltan los datos fiscales del negocio (NIF y razón social)"
            }
            ErrorCode::FacturaCompletaRequerida => {
                "Este importe necesita factura completa: hacen falta el NIF y el nombre del cliente"
            }
            ErrorCode::ReservaSolapada => "La reserva se pisa con otra de la misma mesa",
            ErrorCode::UsuarioInactivo => USUARIO_INACTIVO,
        }
    }

    /// Valor del cable derivado del enum; se verifica su paridad con serde.
    pub fn wire(self) -> &'static str { self.into() }

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
        ErrorCode::TODOS.iter().copied().find(|c| c.wire() == s)
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
            // `main_volcando`: la Main está subiendo su atraso y la nube está a medio construir.
            // Para quien lo recibe es el mismo caso que no haber Main —congelar—, solo cambia el
            // texto; el detalle de en cuál de los dos estamos viaja por la presencia del WS.
            "main_offline" | "main_volcando" => ErrorCode::MainOffline,
            // `device_replaced`: la licencia se activó en otro equipo (cambio de
            // equipo). Este Main ya no lo es, así que para él la consecuencia es la misma que
            // estar revocado: parar. Ver el fixture compartido `error-codes.json`.
            // `device_not_registered`: la fila de este dispositivo ya no está en este negocio
            // (se vinculó como Handy de otro, o se borró). La consecuencia es la misma que estar
            // revocado —parar y volver a vincular—, y para una Handy es lo que la separa de un
            // corte de red, que sí se reintenta.
            "device_revoked" | "revoked" | "device_replaced" | "device_not_registered" => {
                ErrorCode::DeviceRevoked
            }
            // `license_revoked` cae aquí a propósito: `LicenseExpired` ya significa "caducada o
            // bloqueada", y quien lo recibe hace lo mismo en ambos casos.
            "license_expired" | "expired" | "license_revoked" => ErrorCode::LicenseExpired,
            "no_active_license_for_tenant" | "license_not_found" => ErrorCode::LicenseNotFound,
            "invalid_pin" => ErrorCode::InvalidPin,
            "validation_error" => ErrorCode::Validation,
            "not_found" => ErrorCode::NotFound,
            "tenant_db_not_provisioned" => ErrorCode::TenantDbNotProvisioned,
            "bootstrap_demasiado_grande" | "bootstrap_too_large" => ErrorCode::BootstrapTooLarge,
            "migration_altered" | "tenant_migration_altered" => ErrorCode::TenantMigrationAltered,
            "backup_corrupt" => ErrorCode::BackupCorrupt,
            "permiso_denegado" => ErrorCode::PermisoDenegado,
            "datos_fiscales_incompletos" => ErrorCode::DatosFiscalesIncompletos,
            "factura_completa_requerida" => ErrorCode::FacturaCompletaRequerida,
            "reserva_solapada" => ErrorCode::ReservaSolapada,
            "usuario_inactivo" => ErrorCode::UsuarioInactivo,
            _ => ErrorCode::External,
        }
    }
}

/// Error tal y como lo recibe el frontend. Es el `Err` de **todos** los comandos Tauri.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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

        // `message` se PINTA en la UI. Tres casos en los que el texto recibido no sirve para
        // enseñárselo a nadie:
        //   · vacío, o el propio código — lo que llega cuando el error nace de un código del
        //     worker (`AppError::from_wire("main_offline")`), porque ahí el string ES el código.
        //     Se sustituye por el legible del catálogo.
        //   · otro identificador de máquina (`pair_code_not_found`): una respuesta del worker sin
        //     frase propia. Se enseña el legible y el identificador va detrás, entre paréntesis,
        //     porque es lo único con lo que soporte puede saber qué pasó.
        let message = if limpio.is_empty() || limpio.eq_ignore_ascii_case(code.wire()) {
            code.default_message().to_string()
        } else if es_identificador_de_maquina(limpio) {
            format!("{} ({limpio})", code.default_message())
        } else {
            message
        };

        Self { code, message }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

/// Un texto que no es una frase sino un identificador: sin espacios y con guion bajo
/// (`pair_code_not_found`, `insufficient_stock:12:3:1`). Una palabra suelta sin guion bajo
/// («Prohibido») no cuenta: podría ser un mensaje de verdad.
fn es_identificador_de_maquina(texto: &str) -> bool {
    texto.contains('_') && !texto.chars().any(char::is_whitespace)
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
            let esperado = caso
                .code
                .clone()
                .expect("los casos de negocio llevan `code`");
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
            let esperado = caso
                .code
                .clone()
                .expect("los casos de normalización llevan `code`");
            let obtenido = wire_de(ErrorCode::from_wire(&caso.wire));
            assert_eq!(
                obtenido,
                esperado,
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
        let producidos: Vec<String> = f.negocio.iter().filter_map(|c| c.code.clone()).collect();

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

        let f = fixture();
        for &code in ErrorCode::TODOS {
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

    /// Comprueba que la lista derivada conserva todas las variantes y su orden.
    #[test]
    fn todos_coincide_con_la_declaracion_del_enum() {
        let fuente = include_str!("errors.rs");
        let inicio = fuente.find("pub enum ErrorCode {").expect("declaración del enum");
        let cuerpo = &fuente[inicio..];
        let cuerpo = &cuerpo[..cuerpo.find("
}").expect("cierre del enum")];

        let declaradas: Vec<String> = cuerpo
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.starts_with("//") && l.ends_with(','))
            .map(|l| l.trim_end_matches(',').to_string())
            .collect();
        let en_todos: Vec<String> = ErrorCode::TODOS.iter().map(|c| format!("{c:?}")).collect();

        assert!(declaradas.len() > 10, "no se ha podido leer el enum: {declaradas:?}");
        assert_eq!(en_todos, declaradas, "ErrorCode::TODOS no recoge todas las variantes, en orden");
    }

    /// Lo que el worker manda en `code` es el valor serializado; `from_code` tiene que
    /// reconocerlo para TODOS los códigos, o uno nuevo del worker se degrada a genérico.
    #[test]
    fn from_code_reconoce_cada_codigo_del_catalogo() {
        for &code in ErrorCode::TODOS {
            assert_eq!(ErrorCode::from_code(&wire_de(code)), Some(code), "{code:?}");
            assert_eq!(code.wire(), wire_de(code), "{code:?}: wire() y serde se separan");
        }
    }

    #[test]
    fn ningun_codigo_se_queda_sin_mensaje_legible() {

        for &code in ErrorCode::TODOS {
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

    /// Una respuesta del worker sin frase propia trae sólo su identificador. Enseñarlo tal cual
    /// era lo que hacía leer `pair_code_not_found` en la pantalla de vinculación.
    #[test]
    fn un_identificador_de_maquina_se_ensena_con_su_frase_y_se_conserva_para_soporte() {
        let dto = AppErrorDto::new(ErrorCode::External, "missing_op_id");
        assert_eq!(dto.message, "Error de un servicio externo (missing_op_id)");

        // Lo que algunos llevan detrás de los dos puntos también se conserva: es diagnóstico.
        let dto = AppErrorDto::new(ErrorCode::Conflict, " insufficient_stock:12:3:1 ");
        assert!(dto.message.starts_with(ErrorCode::Conflict.default_message()), "{}", dto.message);
        assert!(dto.message.contains("insufficient_stock:12:3:1"), "{}", dto.message);
    }

    #[test]
    fn una_frase_o_una_palabra_suelta_no_se_toma_por_identificador() {
        for texto in [
            "Ya hay un cliente con ese correo.",
            "id_mesa invalido",
            "No se ha podido conectar (error_de_red)",
            "Prohibido",
        ] {
            assert_eq!(AppErrorDto::new(ErrorCode::Validation, texto).message, texto);
        }
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
