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
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ContactSettings {
    pub recovery_email: String,
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
