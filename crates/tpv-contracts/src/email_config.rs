//! Contratos (DTOs) de la frontera UI<->Rust para configuración de correo.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct EmailConfigDto {
    pub modo: String,
    pub smtp_host: String,
    pub smtp_port: i32,
    pub smtp_user: String,
    pub smtp_password: String,
    pub smtp_from_email: String,
    pub smtp_from_name: String,
    pub smtp_use_tls: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct EmailConfigPatchInput {
    pub modo: String,
    pub smtp_host: String,
    pub smtp_port: i32,
    pub smtp_user: String,
    pub smtp_password: String,
    pub smtp_from_email: String,
    pub smtp_from_name: String,
    pub smtp_use_tls: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LineaEmailInput {
    pub nombre_producto: String,
    pub cantidad: f64,
    #[serde(default)]
    #[ts(optional)]
    pub precio_unitario: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub unidad: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct EnviarPedidoEmailInput {
    pub email_destino: String,
    pub nombre_proveedor: String,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
    pub lineas: Vec<LineaEmailInput>,
}
