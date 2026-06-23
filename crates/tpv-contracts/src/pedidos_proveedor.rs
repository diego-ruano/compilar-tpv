//! Contratos (DTOs) de la frontera UI<->Rust para pedidos a proveedores.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LineaPedidoDto {
    pub id_linea: String,
    pub nombre_producto: String,
    pub cantidad: f64,
    pub precio_unitario: Option<f64>,
    pub unidad: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PedidoProveedorDto {
    pub id_pedido: String,
    pub id_proveedor: Option<String>,
    pub nombre_proveedor: Option<String>,
    pub email_destino: Option<String>,
    pub estado: String,
    pub fecha_creacion: String,
    pub fecha_envio: Option<String>,
    pub notas: Option<String>,
    pub lineas: Vec<LineaPedidoDto>,
}

/* ── Inputs ── */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LineaPedidoInput {
    pub id_linea: String,
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
pub struct PedidosCrearInput {
    pub id_pedido: String,
    #[serde(default)]
    #[ts(optional)]
    pub id_proveedor: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub email_destino: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
    pub lineas: Vec<LineaPedidoInput>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PedidosActualizarInput {
    pub id_pedido: String,
    #[serde(default)]
    #[ts(optional)]
    pub id_proveedor: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub email_destino: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
    pub lineas: Vec<LineaPedidoInput>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PedidosCambiarEstadoInput {
    pub id_pedido: String,
    pub estado: String,
    #[serde(default)]
    #[ts(optional)]
    pub fecha_envio: Option<String>,
}
