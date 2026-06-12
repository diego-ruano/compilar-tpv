//! Contratos (DTOs) de la frontera UI<->Rust para **proveedores**.
//! Campos snake_case idénticos a los structs antiguos (compat frontend).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedorDto {
    pub id_proveedor: String,
    pub nombre_empresa: String,
    pub contacto: Option<String>,
    pub telefono: Option<String>,
    pub email: Option<String>,
    pub cif: Option<String>,
    pub informacion_adicional: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CategoriaProveedorDto {
    pub id_categoria: String,
    pub nombre: String,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProductoProveedorDto {
    pub id_producto: String,
    pub id_categoria: Option<String>,
    pub id_proveedor: Option<String>,
    pub nombre: String,
    pub precio_venta: Option<f64>,
    pub stock_actual: Option<f64>,
    pub stock_minimo: Option<f64>,
    pub unidad_medida: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
    pub cantidad_pedido_esperada: Option<f64>,
    pub ultima_entrada: Option<String>,
    pub caducidad_proxima: Option<String>,
}

/* ── Args/Inputs ── */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedoresGetProductosArgs {
    pub id_proveedor: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedorSaveInput {
    #[serde(default)]
    #[ts(optional)]
    pub id_proveedor: Option<String>,
    pub nombre_empresa: String,
    #[serde(default)]
    #[ts(optional)]
    pub contacto: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub telefono: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub email: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub cif: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub informacion_adicional: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub nombre_imagen: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedoresDeleteInput {
    pub id_proveedor: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedoresSetVinculosInput {
    pub id_proveedor: String,
    pub producto_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedoresCreateProductoInput {
    #[serde(default)]
    #[ts(optional)]
    pub id_producto: Option<String>,
    pub id_categoria: String,
    pub id_proveedor: String,
    pub nombre: String,
    #[serde(default)]
    #[ts(optional)]
    pub precio_venta: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub stock_actual: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub stock_minimo: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub unidad_medida: Option<String>,
}
