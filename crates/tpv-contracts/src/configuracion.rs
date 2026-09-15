//! Contratos (DTOs) de la frontera UI<->Rust para **configuración**.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct BusinessSettings {
    pub business_name: String,
    pub logo_data_url: Option<String>,
    pub direccion: String,
    pub telefono: String,
    pub cif: String,
    pub mensaje_footer: String,
    pub iva_percent: f64,
    /// A partir de cuánto descuadre el cierre de caja pide un motivo escrito (CUENTA-06).
    pub umbral_descuadre: f64,

    // ── Datos fiscales (FISCAL-01, Veri*factu) ──────────────────────────────────────────────────
    /// `NombreRazon` del obligado a expedir la factura. **No es `business_name`**: uno es el rótulo
    /// («Bar La Plaza») y el otro quien factura («Francisco García SL»). El ticket enseña los dos;
    /// el registro que se remite a la AEAT, sólo este.
    pub razon_social: String,
    /// `DescripcionOperacion`, campo obligatorio de hasta 500 caracteres. Texto fijo configurable y
    /// no un resumen de las líneas: los nombres de producto los escribe el usuario, y un campo
    /// obligatorio que puede llegar vacío o con basura es un rechazo garantizado.
    pub descripcion_op: String,
    /// Límite (IVA incluido) por encima del cual ya no cabe una simplificada (`F2`) y hay que
    /// emitir factura completa. 3.000 € en hostelería (art. 4.2 RD 1619/2012).
    pub limite_simplif: f64,
    /// `"produccion"` | `"pruebas"`. Cambia a la vez el endpoint del servicio web y la URL del QR.
    pub verifactu_entorno: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TicketSettings {
    pub show_logo: bool,
    pub show_business_name: bool,
    pub show_address: bool,
    pub show_phone: bool,
    pub show_cif: bool,
    pub show_date_time: bool,
    pub show_line_items: bool,
    pub show_base_and_iva: bool,
    pub show_total: bool,
    pub show_footer_message: bool,
    #[ts(type = "number")]
    pub paper_width_mm: i64,

    // ── Parámetros de impresión (antes columnas muertas del esquema, ahora respetadas
    //    por el renderizado ESC/POS en `printing.rs`). ──
    /// DPI de la impresora térmica (203 | 300). Usado para convertir márgenes mm→dots/líneas.
    #[ts(type = "number")]
    pub paper_dpi: i64,
    /// Caracteres por línea del cuerpo del ticket (fuente A). Autoritativo sobre el ancho de papel.
    #[ts(type = "number")]
    pub chars_per_line: i64,
    /// Márgenes del ticket en milímetros.
    pub margin_top_mm: f64,
    pub margin_bottom_mm: f64,
    pub margin_left_mm: f64,
    pub margin_right_mm: f64,
    /// Escala global de la fuente (0.5–2.0). El builder ESC/POS la mapea a magnificación entera.
    pub font_scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ContactSettings {
    pub contact_email: String,
    pub contact_phone: String,
}

/// Entrada de patch parcial (objeto con un subconjunto de claves de los ajustes).
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ConfigPatchInput {
    #[ts(type = "Record<string, unknown>")]
    pub patch: JsonValue,
}
