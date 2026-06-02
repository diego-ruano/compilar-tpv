//! Contratos (DTOs) de la frontera UI<->Rust para **proveedores**.
//! Campos snake_case idénticos a los structs antiguos (compat frontend).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedorDto {
    #[ts(type = "number")]
    pub id_proveedor: i64,
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
    #[ts(type = "number")]
    pub id_categoria: i64,
    pub nombre: String,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProductoProveedorDto {
    #[ts(type = "number")]
    pub id_producto: i64,
    #[ts(type = "number | null")]
    pub id_categoria: Option<i64>,
    #[ts(type = "number | null")]
    pub id_proveedor: Option<i64>,
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
    #[ts(type = "number")]
    pub id_proveedor: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedorSaveInput {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_proveedor: Option<i64>,
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
    #[ts(type = "number")]
    pub id_proveedor: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedoresSetVinculosInput {
    #[ts(type = "number")]
    pub id_proveedor: i64,
    #[ts(type = "Array<number>")]
    pub producto_ids: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedoresCreateProductoInput {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_producto: Option<i64>,
    #[ts(type = "number")]
    pub id_categoria: i64,
    #[ts(type = "number")]
    pub id_proveedor: i64,
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
