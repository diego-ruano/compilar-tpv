//! Contratos (DTOs) de la frontera UI<->Rust para **inventario**.
//! ⚠️ Las salidas usan claves PascalCase (`#[serde(rename = ...)]`) y `flatten`,
//! idénticas al backend antiguo (ts-rs las respeta vía serde-compat).

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
/* ── Lectura ── */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CategoriaInvDto {
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Nombre_Imagen")]
    pub nombre_imagen: Option<String>,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
    #[serde(rename = "Vendible")]
    pub vendible: Option<i64>,
    #[serde(rename = "Pasa_Cocina")]
    pub pasa_cocina: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProveedorMiniDto {
    #[serde(rename = "ID_Proveedor")]
    pub id_proveedor: String,
    #[serde(rename = "Nombre_Empresa")]
    pub nombre_empresa: String,
    #[serde(rename = "Email")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProductoBaseDto {
    #[serde(rename = "ID_Producto")]
    pub id_producto: String,
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: String,
    #[serde(rename = "ID_Proveedor")]
    pub id_proveedor: Option<String>,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Precio_Venta")]
    pub precio_venta: Option<Dinero>,
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
    /// VR-04: stock "suelto" fuera de lotes. `None` = el producto no lo usa. Puede ser negativo.
    #[serde(rename = "Stock_Suelto")]
    pub stock_suelto: Option<f64>,
    /// Tipo de IVA propio. `None` = hereda el del negocio (lo normal en hostelería: el consumo
    /// en local va todo al tipo reducido). Se fija solo en lo que tributa distinto.
    #[serde(rename = "IVA_Percent")]
    pub iva_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProductoListDto {
    #[serde(flatten)]
    pub base: ProductoBaseDto,
    #[serde(rename = "Stock_Actual")]
    pub stock_actual: Option<f64>,
    #[serde(rename = "Caducidad_Proxima")]
    pub caducidad_proxima: Option<String>,
    #[serde(rename = "Lote_Proximo")]
    pub lote_proximo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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
    pub precio_venta: Option<Dinero>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AlergenoInvDto {
    #[serde(rename = "ID_Alergeno")]
    pub id_alergeno: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Nombre_Imagen")]
    pub nombre_imagen: Option<String>,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AlergenoMiniDto {
    #[serde(rename = "ID_Alergeno")]
    pub id_alergeno: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProductoDetalleDto {
    #[serde(flatten)]
    pub producto: ProductoBaseDto,
    #[serde(rename = "alergs")]
    pub alergs: Vec<AlergenoMiniDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProductDetailResponse {
    pub producto: Option<ProductoBaseDto>,
    pub alergenos: Vec<AlergenoInvDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct LoteDto {
    #[serde(rename = "ID_Lote")]
    pub id_lote: String,
    #[serde(rename = "ID_Producto")]
    pub id_producto: String,
    #[serde(rename = "Codigo_Lote")]
    pub codigo_lote: String,
    #[serde(rename = "Fecha_Entrada")]
    pub fecha_entrada: String,
    #[serde(rename = "Caducidad")]
    pub caducidad: Option<String>,
    #[serde(rename = "Stock_Disponible")]
    pub stock_disponible: f64,
    #[serde(rename = "Coste_Unitario")]
    pub coste_unitario: Option<Dinero>,
    #[serde(rename = "ID_Proveedor")]
    pub id_proveedor: Option<String>,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct InventarioResumenResponse {
    #[serde(rename = "proximosCaducar")]
    pub proximos_caducar: Vec<ProductoResumenDto>,
    #[serde(rename = "menosCantidad")]
    pub menos_cantidad: Vec<ProductoResumenDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UpsertProductoResult {
    pub id_producto: String,
}

/* ── Args/Inputs ── */

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct IdCategoriaArgs {
    pub id_categoria: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct IdProductoArgs {
    pub id_producto: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SummaryArgs {
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct UpsertCategoriaInput {
    #[serde(default)]
    pub id_categoria: Option<String>,
    pub nombre: String,
    pub nombre_imagen: String,
    pub ruta_imagen: String,
    pub vendible: bool,
    pub pasa_cocina: bool,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SetProductoAlergenosInput {
    pub id_producto: String,
    pub ids_alergenos: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct UpsertProductoInput {
    #[serde(default)]
    pub id_producto: Option<String>,
    pub id_categoria: String,
    #[serde(default)]
    pub id_proveedor: Option<String>,
    pub nombre: String,
    #[serde(default)]
    pub precio_venta: Option<Dinero>,
    #[serde(default)]
    pub stock_minimo: Option<f64>,
    #[serde(default)]
    pub unidad_medida: Option<String>,
    #[serde(default)]
    pub nombre_imagen: Option<String>,
    #[serde(default)]
    pub ruta_imagen: Option<String>,
    #[serde(default)]
    pub cantidad_pedido_esperada: Option<f64>,
    /// VR-04: stock suelto fuera de lotes (opcional; None = el producto no lo usa).
    ///
    /// **Sólo cuenta al crear el producto** (RI-55): editando la ficha se ignora, y el stock suelto
    /// se cambia con `AjusteStockSueltoInput`, que deja su movimiento.
    #[serde(default)]
    pub stock_suelto: Option<f64>,
    /// Tipo de IVA propio (opcional; None = hereda el del negocio).
    #[serde(default)]
    pub iva_percent: Option<f64>,
    #[serde(default)]
    pub ids_alergenos: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CreateLoteInput {
    #[serde(default)]
    pub id_lote: Option<String>,
    pub id_producto: String,
    pub codigo_lote: String,
    #[serde(default)]
    pub caducidad: Option<String>,
    pub stock_disponible: f64,
    #[serde(default)]
    pub fecha_entrada: Option<String>,
    #[serde(default)]
    pub coste_unitario: Option<Dinero>,
    #[serde(default)]
    pub id_proveedor: Option<String>,
    #[serde(default)]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
/// Los datos de un lote, **sin sus existencias** (RI-55): esas se cambian con `AjusteLoteInput`.
pub struct UpdateLoteInput {
    pub id_lote: String,
    pub id_producto: String,
    pub codigo_lote: String,
    #[serde(default)]
    pub caducidad: Option<String>,
    #[serde(default)]
    pub fecha_entrada: Option<String>,
    #[serde(default)]
    pub coste_unitario: Option<Dinero>,
    #[serde(default)]
    pub id_proveedor: Option<String>,
    #[serde(default)]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
/// Ajuste de las existencias de un lote (RI-55). `stock_visto` es lo que enseñaba la pantalla al
/// abrir el ajuste: si ya no es lo que hay, se rechaza en vez de pisar lo que se movió entre medias.
pub struct AjusteLoteInput {
    pub id_lote: String,
    pub stock_visto: f64,
    pub stock_nuevo: f64,
    #[serde(default)]
    pub motivo: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
/// Ajuste del stock suelto de un producto (RI-55), igual que `AjusteLoteInput`. `None` es «no lleva
/// stock suelto»: en `stock_nuevo` lo desactiva y en `stock_visto` dice que no lo llevaba.
pub struct AjusteStockSueltoInput {
    pub id_producto: String,
    #[serde(default)]
    pub stock_visto: Option<f64>,
    #[serde(default)]
    pub stock_nuevo: Option<f64>,
    #[serde(default)]
    pub motivo: Option<String>,
}
