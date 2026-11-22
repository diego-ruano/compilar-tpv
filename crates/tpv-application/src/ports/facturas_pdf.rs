//! Puertos del **PDF de las facturas completas**.
//!
//! Cada factura completa (un alta de `Registros_Facturacion` con destinatario: `F1`, `F3` y las
//! rectificativas con cliente) tiene su PDF, compuesto una vez con lo mismo que su papel y guardado
//! en el equipo y en la nube. Lo orquesta `use_cases::facturas_pdf`; aquí está lo que necesita:
//!
//! - [`FacturasPdfRepository`]: qué facturas hay que documentar y por dónde va cada una
//!   (`_Facturas_Pdf`, estado local del equipo que no se replica).
//! - [`ArchivoFacturas`]: los PDF en la carpeta del equipo.
//! - [`FacturasNube`]: subirlos y bajarlos del bucket del negocio.
//! - [`GeneradorFacturas`]: componer el PDF de una factura.
//!
//! Sólo existen en la Main: es la que cobra y guarda los registros de facturación.

use async_trait::async_trait;

use crate::error::AppResult;
use tpv_contracts::impresion::PrintTicketPayload;

/// De dónde salió el PDF local de una factura.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrigenPdf {
    /// Compuesto en este equipo.
    Generado,
    /// Bajado de la nube: el que se emitió, en un equipo restaurado.
    Bajado,
}

impl OrigenPdf {
    pub fn como_texto(self) -> &'static str {
        match self {
            OrigenPdf::Generado => "generado",
            OrigenPdf::Bajado => "bajado",
        }
    }

    pub fn desde_texto(s: &str) -> Option<Self> {
        match s {
            "generado" => Some(OrigenPdf::Generado),
            "bajado" => Some(OrigenPdf::Bajado),
            _ => None,
        }
    }
}

/// Por dónde va el PDF de una factura en este equipo (una fila de `_Facturas_Pdf`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EstadoPdfFactura {
    pub id_registro: String,
    /// `None` hasta que hay un PDF local.
    pub origen: Option<OrigenPdf>,
    pub generado_ms: Option<i64>,
    /// Cuándo lo confirmó la nube (subido, ya estaba o bajado de ella).
    pub subido_ms: Option<i64>,
    /// Intentos fallidos de componerlo seguidos.
    pub intentos: i64,
    pub ultimo_error: Option<String>,
    pub proximo_intento_ms: Option<i64>,
    /// La nube lo rechazó por lo que es: no se vuelve a subir.
    pub apartado: bool,
}

/// El cobro con el que se imprime una factura: su papel es el de ese pago con ese número.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CobroDeLaFactura {
    pub id_pago: String,
    pub num_serie: String,
}

#[async_trait]
pub trait FacturasPdfRepository: Send + Sync {
    /// Apunta las facturas completas que todavía no tienen fila. Idempotente; devuelve cuántas.
    async fn apuntar_nuevas(&self) -> AppResult<u64>;

    /// Las que no tienen PDF local y ya pueden intentarse (sin espera pendiente), de la más
    /// reciente a la más antigua.
    async fn sin_pdf_local(&self, ahora_ms: i64, limite: i64) -> AppResult<Vec<EstadoPdfFactura>>;

    /// Las que tienen PDF local y la nube todavía no lo ha confirmado, sin las apartadas.
    async fn sin_subir(&self, limite: i64) -> AppResult<Vec<EstadoPdfFactura>>;

    /// El estado de una. `None` si no tiene fila (aún no se ha apuntado o no es una factura
    /// completa).
    async fn estado(&self, id_registro: &str) -> AppResult<Option<EstadoPdfFactura>>;

    /// El cobro con el que se compone su papel. `None` si no es una factura completa o no se
    /// encuentra su cobro.
    async fn cobro_de_la_factura(&self, id_registro: &str) -> AppResult<Option<CobroDeLaFactura>>;

    /// Ya hay PDF local: anota de dónde salió y cuándo, y borra los fallos. Si es una factura que
    /// aún no tenía fila (la pide la pantalla antes que el job), la crea.
    async fn anotar_local(&self, id_registro: &str, ruta: &str, origen: OrigenPdf, ahora_ms: i64)
        -> AppResult<()>;

    /// Estaba anotado y el PDF local ya no está: se vuelve a documentar.
    async fn olvidar_local(&self, id_registro: &str) -> AppResult<()>;

    /// La nube lo tiene.
    async fn anotar_subido(&self, id_registro: &str, ahora_ms: i64) -> AppResult<()>;

    /// No se ha podido componer: un intento más, el motivo y cuándo volver a probar.
    async fn anotar_fallo(&self, id_registro: &str, motivo: &str, proximo_intento_ms: i64)
        -> AppResult<()>;

    /// La nube lo ha rechazado por lo que es: se aparta y no se vuelve a subir.
    async fn apartar(&self, id_registro: &str, motivo: &str) -> AppResult<()>;
}

/// Los PDF de las facturas en la carpeta del equipo (`AppData/facturas/{ID_Registro}.pdf`).
pub trait ArchivoFacturas: Send + Sync {
    /// La ruta relativa a AppData con la que se anota.
    fn ruta(&self, id_registro: &str) -> String;
    /// Los bytes del PDF local, si está.
    fn leer(&self, id_registro: &str) -> AppResult<Option<Vec<u8>>>;
    /// Guarda (o sustituye) el PDF local de una vez: no queda un fichero a medias.
    fn guardar(&self, id_registro: &str, pdf: &[u8]) -> AppResult<()>;
}

/// Lo que contesta la nube a una subida.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubidaFactura {
    Guardada,
    /// Ya tenía un PDF de ese registro, y no lo ha tocado: una factura subida no cambia.
    YaEstaba,
    /// Lo ha rechazado por lo que es (no es un PDF, pasa del tope). Repetirlo no cambia nada.
    Rechazada { motivo: String },
}

/// El PDF de las facturas en la nube (`/v1/facturas`, en el bucket del negocio).
///
/// Un `Err` es que no se ha podido hablar con ella o que no ha atendido (sin red, credenciales, un
/// fallo suyo): no dice nada de la factura, y la pasada deja la nube para más tarde.
#[async_trait]
pub trait FacturasNube: Send + Sync {
    async fn subir(&self, id_registro: &str, pdf: &[u8]) -> AppResult<SubidaFactura>;
    /// `None` si la nube no lo tiene.
    async fn bajar(&self, id_registro: &str) -> AppResult<Option<Vec<u8>>>;
}

/// Compone el PDF de una factura a partir de su papel.
#[async_trait]
pub trait GeneradorFacturas: Send + Sync {
    async fn generar(&self, cobro: &CobroDeLaFactura) -> AppResult<Vec<u8>>;
}

/// Maqueta en PDF el papel de una factura, ya compuesto (`use_cases::tickets`).
#[async_trait]
pub trait MaquetaFactura: Send + Sync {
    async fn pdf(&self, papel: PrintTicketPayload) -> AppResult<Vec<u8>>;
}
