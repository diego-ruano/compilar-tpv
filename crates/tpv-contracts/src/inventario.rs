//! Contratos (DTOs) de la frontera UI<->Rust para **inventario**.
//! ⚠️ Las salidas usan claves PascalCase (`#[serde(rename = ...)]`) y `flatten`,
//! idénticas al backend antiguo (ts-rs las respeta vía serde-compat).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/* ── Lectura ── */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CategoriaInvDto {
    #[serde(rename = "ID_Categoria")]
    #[ts(type = "number")]
    pub id_categoria: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Nombre_Imagen")]
    pub nombre_imagen: Option<String>,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
    #[serde(rename = "Vendible")]
    #[ts(type = "number | null")]
    pub vendible: Option<i64>,
    #[serde(rename = "Pasa_Cocina")]
    #[ts(type = "number | null")]
    pub pasa_cocina: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProveedorMiniDto {
    #[serde(rename = "ID_Proveedor")]
    #[ts(type = "number")]
    pub id_proveedor: i64,
    #[serde(rename = "Nombre_Empresa")]
    pub nombre_empresa: String,
    #[serde(rename = "Email")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProductoBaseDto {
    #[serde(rename = "ID_Producto")]
    #[ts(type = "number")]
    pub id_producto: i64,
    #[serde(rename = "ID_Categoria")]
    #[ts(type = "number")]
    pub id_categoria: i64,
    #[serde(rename = "ID_Proveedor")]
    #[ts(type = "number | null")]
    pub id_proveedor: Option<i64>,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Precio_Venta")]
    pub precio_venta: Option<f64>,
    #[serde(rename = "Stock_Minimo")]
    pub stock_minimo: Option<f64>,
    #[serde(rename = "Unidad_Medida")]
    pub unidad_medida: Option<String>,
    #[serde(rename = "Nombre_Imagen")]
    pub nombre_imagen: Option<String>,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
    #[serde(rename = "Cantidad_Pedido_Esperada")]
    pub cantidad_pedido_esperada: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProductoListDto {
    #[serde(flatten)]
    #[ts(flatten)]
    pub base: ProductoBaseDto,
    #[serde(rename = "Stock_Actual")]
    pub stock_actual: Option<f64>,
    #[serde(rename = "Caducidad_Proxima")]
    pub caducidad_proxima: Option<String>,
    #[serde(rename = "Lote_Proximo")]
    pub lote_proximo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProductoResumenDto {
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Stock_Actual")]
    pub stock_actual: Option<f64>,
    #[serde(rename = "Unidad_Medida")]
    pub unidad_medida: Option<String>,
    #[serde(rename = "Caducidad_Proxima")]
    pub caducidad_proxima: Option<String>,
    #[serde(rename = "Lote")]
    pub lote: Option<String>,
    #[serde(rename = "Precio_Venta")]
    pub precio_venta: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AlergenoInvDto {
    #[serde(rename = "ID_Alergeno")]
    #[ts(type = "number")]
    pub id_alergeno: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Nombre_Imagen")]
    pub nombre_imagen: Option<String>,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AlergenoMiniDto {
    #[serde(rename = "ID_Alergeno")]
    #[ts(type = "number")]
    pub id_alergeno: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProductoDetalleDto {
    #[serde(flatten)]
    #[ts(flatten)]
    pub producto: ProductoBaseDto,
    #[serde(rename = "alergs")]
    pub alergs: Vec<AlergenoMiniDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ProductDetailResponse {
    pub producto: Option<ProductoBaseDto>,
    pub alergenos: Vec<AlergenoInvDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct LoteDto {
    #[serde(rename = "ID_Lote")]
    #[ts(type = "number")]
    pub id_lote: i64,
    #[serde(rename = "ID_Producto")]
    #[ts(type = "number")]
    pub id_producto: i64,
    #[serde(rename = "Codigo_Lote")]
    pub codigo_lote: String,
    #[serde(rename = "Fecha_Entrada")]
    pub fecha_entrada: String,
    #[serde(rename = "Caducidad")]
    pub caducidad: Option<String>,
    #[serde(rename = "Cantidad_Inicial")]
    pub cantidad_inicial: f64,
    #[serde(rename = "Stock_Disponible")]
    pub stock_disponible: f64,
    #[serde(rename = "Coste_Unitario")]
    pub coste_unitario: Option<f64>,
    #[serde(rename = "ID_Proveedor")]
    #[ts(type = "number | null")]
    pub id_proveedor: Option<i64>,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct InventarioResumenResponse {
    #[serde(rename = "proximosCaducar")]
    pub proximos_caducar: Vec<ProductoResumenDto>,
    #[serde(rename = "menosCantidad")]
    pub menos_cantidad: Vec<ProductoResumenDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpsertProductoResult {
    #[ts(type = "number")]
    pub id_producto: i64,
}

/* ── Args/Inputs ── */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct IdCategoriaArgs {
    #[ts(type = "number")]
    pub id_categoria: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct IdProductoArgs {
    #[ts(type = "number")]
    pub id_producto: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SummaryArgs {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpsertCategoriaInput {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_categoria: Option<i64>,
    pub nombre: String,
    pub nombre_imagen: String,
    pub ruta_imagen: String,
    pub vendible: bool,
    pub pasa_cocina: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SetProductoAlergenosInput {
    #[ts(type = "number")]
    pub id_producto: i64,
    #[ts(type = "Array<number>")]
    pub ids_alergenos: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpsertProductoInput {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_producto: Option<i64>,
    #[ts(type = "number")]
    pub id_categoria: i64,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_proveedor: Option<i64>,
    pub nombre: String,
    #[serde(default)]
    #[ts(optional)]
    pub precio_venta: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub stock_minimo: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub unidad_medida: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub nombre_imagen: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub ruta_imagen: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub cantidad_pedido_esperada: Option<f64>,
    #[serde(default)]
    #[ts(type = "Array<number>")]
    pub ids_alergenos: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CreateLoteInput {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_lote: Option<i64>,
    #[ts(type = "number")]
    pub id_producto: i64,
    pub codigo_lote: String,
    #[serde(default)]
    #[ts(optional)]
    pub caducidad: Option<String>,
    pub cantidad_inicial: f64,
    #[serde(default)]
    #[ts(optional)]
    pub stock_disponible: Option<f64>,
    #[serde(default)]
    #[ts(optional)]
    pub fecha_entrada: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub coste_unitario: Option<f64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_proveedor: Option<i64>,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AjusteLoteInput {
    #[ts(type = "number")]
    pub id_lote: i64,
    pub stock_disponible: f64,
    #[serde(default)]
    #[ts(optional)]
    pub notas: Option<String>,
}
