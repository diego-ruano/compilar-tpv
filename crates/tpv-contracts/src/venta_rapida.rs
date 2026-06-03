//! Contratos (DTOs) de la frontera UI<->Rust para **venta rápida** (barra).
//! Los DTOs de salida conservan los nombres PascalCase de las columnas (campos crudos
//! con `#[allow(non_snake_case)]`). Local-First: los args de entrada NO llevan
//! op_id/outbox/remote_id.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/* =========================================================
   Salida (read models)
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct CategoriaRow {
    #[ts(type = "number")]
    pub ID_Categoria: i64,
    pub Nombre: String,
    pub Nombre_Imagen: Option<String>,
    pub Ruta_Imagen: Option<String>,
    #[ts(type = "number | null")]
    pub Vendible: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct ProductoRow {
    #[ts(type = "number")]
    pub ID_Producto: i64,
    #[ts(type = "number")]
    pub ID_Categoria: i64,
    pub Nombre: String,
    pub Precio_Venta: f64,
    pub Stock_Actual: f64,
    pub Stock_Minimo: f64,
    pub Unidad_Medida: Option<String>,
    pub Nombre_Imagen: Option<String>,
    pub Ruta_Imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct ComandaBarraRow {
    #[ts(type = "number")]
    pub ID_Comanda: i64,
    pub Fecha_Hora_Apertura: String,
    pub Estado: String,
    pub Total_Pendiente: f64,
    pub Total_Comanda: f64,
    #[ts(type = "number")]
    pub Pendientes_Cocina: i64,
    #[ts(type = "number")]
    pub Pendientes_Pago: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct LineaComandaRow {
    #[ts(type = "number")]
    pub ID_Detalle: i64,
    #[ts(type = "number")]
    pub ID_Comanda: i64,
    #[ts(type = "number")]
    pub ID_Producto: i64,
    pub Cantidad: f64,
    pub Precio_Unitario: f64,
    pub Notas: Option<String>,
    pub Estado_Cocina: Option<String>,
    #[ts(type = "number")]
    pub Pagado: i64,
    pub Nombre: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct VerTicketsDetalleRow {
    #[ts(type = "number")]
    pub ID_Detalle: i64,
    #[ts(type = "number")]
    pub ID_Producto: i64,
    pub Nombre: String,
    pub Cantidad: f64,
    pub Precio_Unitario: f64,
    pub Estado_Cocina: String,
    #[ts(type = "number")]
    pub Pagado: i64,
    pub Notas: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct IndexRow {
    #[ts(type = "number")]
    pub ID_Comanda: i64,
    pub Productos: Option<String>,
    #[ts(type = "number")]
    pub NumLineas: i64,
    pub Unidades: f64,
}

/* =========================================================
   Entrada (args/inputs) — Local-First
========================================================= */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrListComandasArgs {
    pub include_pagadas: bool,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrIdCategoriaArgs {
    #[ts(type = "number")]
    pub id_categoria: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrSearchProductosArgs {
    pub query: String,
    #[ts(type = "number")]
    pub limit: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrIdComandaArgs {
    #[ts(type = "number")]
    pub id_comanda: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrIdsArgs {
    #[ts(type = "Array<number>")]
    pub ids: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrCreateComandaBarraInput {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_trabajador: Option<i64>,
    /// Si es `true`, reutiliza la comanda de barra abierta si existe (get-or-create).
    #[serde(default)]
    #[ts(optional)]
    pub get_or_create: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrAddLineaComandaInput {
    #[ts(type = "number")]
    pub id_comanda: i64,
    #[ts(type = "number")]
    pub id_producto: i64,
    pub cantidad: f64,
    pub precio_unitario: f64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrRemoveLastUnpaidLineaInput {
    #[ts(type = "number")]
    pub id_comanda: i64,
    #[ts(type = "number")]
    pub id_producto: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrDeleteLineaIfUnpaidInput {
    #[ts(type = "number")]
    pub id_comanda: i64,
    #[ts(type = "number")]
    pub id_detalle: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrUpdateNotaDetalleInput {
    #[ts(type = "number")]
    pub id_detalle: i64,
    #[serde(default)]
    #[ts(optional)]
    pub nota: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct StockLinea {
    #[ts(type = "number")]
    pub producto_id: i64,
    pub cantidad: f64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrCobrarFraccionadoInput {
    #[ts(type = "number")]
    pub id_comanda: i64,
    pub metodo: String,
    pub importe_total: f64,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_usuario_cobrador: Option<i64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_trabajador_cobrador: Option<i64>,
    #[ts(type = "Array<number>")]
    pub detalles: Vec<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrRestarStockInput {
    pub lineas: Vec<StockLinea>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct VrDeleteComandaIfSafeInput {
    #[ts(type = "number")]
    pub id_comanda: i64,
}
