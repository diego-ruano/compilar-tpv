//! Contratos (DTOs) de la frontera UI<->Rust para el envío de pedidos por correo.
//!
//! Ya NO hay configuración SMTP (DB-04): todo el correo se envía por el worker, así que aquí solo
//! viven los DTOs de la petición de envío.

use serde::Deserialize;
use ts_rs::TS;

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
