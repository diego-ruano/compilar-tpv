//! Contratos (DTOs) de la frontera UI<->Rust para pedidos a proveedores.

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LineaPedidoDto {
    pub id_linea: String,
    pub nombre_producto: String,
    pub cantidad: f64,
    pub precio_unitario: Option<Dinero>,
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

/// Página de pedidos (PROV-03): el listado se sirve paginado en vez de cargar todos los
/// pedidos y toda la tabla de líneas en memoria. `total` es el nº de pedidos que casan con
/// el filtro (para saber si quedan más páginas).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PedidosPageDto {
    pub pedidos: Vec<PedidoProveedorDto>,
    #[ts(type = "number")]
    pub total: i64,
}

/* ── Inputs ── */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PedidosGetPageInput {
    pub limit: u32,
    pub offset: u32,
    #[serde(default)]
    #[ts(optional)]
    pub search: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LineaPedidoInput {
    pub id_linea: String,
    pub nombre_producto: String,
    pub cantidad: f64,
    #[serde(default)]
    #[ts(optional)]
    pub precio_unitario: Option<Dinero>,
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
