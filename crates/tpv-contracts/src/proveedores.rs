//! Contratos (DTOs) de la frontera UI<->Rust para **proveedores**.
//! Campos snake_case idénticos a los structs antiguos (compat frontend).

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CategoriaProveedorDto {
    pub id_categoria: String,
    pub nombre: String,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ProductoProveedorDto {
    pub id_producto: String,
    pub id_categoria: Option<String>,
    pub id_proveedor: Option<String>,
    pub nombre: String,
    pub precio_venta: Option<Dinero>,
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

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ProveedoresGetProductosArgs {
    pub id_proveedor: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ProveedorSaveInput {
    #[serde(default)]
    pub id_proveedor: Option<String>,
    pub nombre_empresa: String,
    #[serde(default)]
    pub contacto: Option<String>,
    #[serde(default)]
    pub telefono: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub cif: Option<String>,
    #[serde(default)]
    pub informacion_adicional: Option<String>,
    #[serde(default)]
    pub nombre_imagen: Option<String>,
    #[serde(default)]
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ProveedoresDeleteInput {
    pub id_proveedor: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ProveedoresSetVinculosInput {
    pub id_proveedor: String,
    pub producto_ids: Vec<String>,
}

