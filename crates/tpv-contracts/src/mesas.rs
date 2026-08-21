//! Contratos (DTOs) de la frontera UI<->Rust para **mesas / salón / comandas / cocina**.
//! Local-First: los args de entrada NO llevan op_id/outbox/remote_id. Los nombres de los
//! tipos llevan el prefijo `Mesas`/`Mesa` cuando podrían colisionar en `bindings.ts` con
//! DTOs de otros módulos (p. ej. `LineaComandaRow` de venta_rapida, `IdCategoriaArgs` de
//! inventario). Los **nombres de campo** (serde) se conservan idénticos al backend antiguo.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/* =========================================================
   LAYOUT
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct RoomPoly {
    #[serde(rename = "type")]
    pub kind: String,
    pub points: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TableInput {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub x: i64,
    #[ts(type = "number")]
    pub y: i64,
    #[ts(type = "number")]
    pub width: i64,
    #[ts(type = "number")]
    pub height: i64,
    #[ts(type = "number | null")]
    pub radius: Option<i64>,
    #[ts(type = "number")]
    pub seats: i64,
    pub shape: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SalonInput {
    pub id: String,
    pub name: String,
    pub room: RoomPoly,
    pub tables: Vec<TableInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct TableOut {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub x: i64,
    #[ts(type = "number")]
    pub y: i64,
    #[ts(type = "number")]
    pub width: i64,
    #[ts(type = "number")]
    pub height: i64,
    #[ts(type = "number | null")]
    pub radius: Option<i64>,
    #[ts(type = "number")]
    pub seats: i64,
    pub shape: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SalonOut {
    pub id: String,
    pub name: String,
    pub room: RoomPoly,
    pub tables: Vec<TableOut>,
}

/* =========================================================
   COMANDAS (mesa)
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ComandaRow {
    pub id_comanda: String,
    pub id_mesa: String,
    pub id_trabajador: Option<String>,
    pub id_reserva: Option<String>,
    pub fecha_hora_apertura: String,
    pub fecha_hora_cierre: Option<String>,
    pub total_comanda: f64,
    pub estado: String,
}

/// Línea de comanda de mesa. (`Mesa`-prefijo para no colisionar con la de venta_rapida.)
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct MesaLineaComandaRow {
    #[serde(rename = "ID_Detalle")]
    pub id_detalle: String,
    #[serde(rename = "ID_Comanda")]
    pub id_comanda: String,
    #[serde(rename = "ID_Producto")]
    pub id_producto: String,
    #[serde(rename = "Cantidad")]
    pub cantidad: f64,
    #[serde(rename = "Precio_Unitario")]
    pub precio_unitario: f64,
    /// Tipo de IVA con el que se vendió la línea (congelado al añadirla). `None` = el general
    /// del negocio. Va al ticket para desglosar por tipo.
    #[serde(rename = "IVA_Percent")]
    #[ts(optional)]
    pub iva_percent: Option<f64>,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
    #[serde(rename = "Estado_Cocina")]
    pub estado_cocina: Option<String>,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Pasa_Cocina")]
    #[ts(type = "number")]
    pub pasa_cocina: i64,
    #[serde(rename = "Pagado")]
    #[ts(type = "number")]
    pub pagado: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ComandaBarraListItem {
    pub id_comanda: String,
    pub fecha_hora_apertura: String,
    pub estado: String,
    pub total_pendiente: f64,
    pub total_comanda: f64,
    #[ts(type = "number")]
    pub pendientes_cocina: i64,
    #[ts(type = "number")]
    pub pendientes_pago: i64,
}

/* =========================================================
   META MESAS
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct ReservaMesaOut {
    #[serde(rename = "idReserva")]
    pub id_reserva: String,
    #[serde(rename = "clienteNombre")]
    pub cliente_nombre: String,
    #[serde(rename = "diaYMD")]
    pub dia_ymd: String,
    pub hora: String,
    pub estado: String,
    #[serde(rename = "minutosPara")]
    #[ts(type = "number")]
    pub minutos_para: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct MesaMetaOut {
    pub ocupada: bool,
    pub id_comanda: String,
    pub idComanda: String,
    pub totalPendiente: f64,
    #[ts(type = "number")]
    pub pendientesPago: i64,
    #[ts(type = "number")]
    pub pendientesCocina: i64,
    pub estado: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reserva: Option<ReservaMesaOut>,
}

/* =========================================================
   CATÁLOGO
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct CategoriaVendibleOut {
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
    #[serde(rename = "Pasa_Cocina")]
    #[ts(type = "number")]
    pub pasa_cocina: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct ProductoVendibleOut {
    #[serde(rename = "ID_Producto")]
    pub id_producto: String,
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Precio_Venta")]
    pub precio_venta: f64,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

/* =========================================================
   COCINA
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
#[allow(non_snake_case)]
pub struct KitchenRow {
    #[serde(rename = "ID_Comanda")]
    pub id_comanda: String,
    #[serde(rename = "Numero_Mesa")]
    pub numero_mesa: String,
    #[serde(rename = "Fecha_Hora_Apertura")]
    pub fecha_hora_apertura: String,
    #[serde(rename = "ID_Detalle")]
    pub id_detalle: String,
    #[serde(rename = "Cantidad")]
    pub cantidad: f64,
    #[serde(rename = "Nombre_Producto")]
    pub nombre_producto: String,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
    #[serde(rename = "Estado_Cocina")]
    pub estado_cocina: Option<String>,
    #[serde(rename = "Pagado")]
    #[ts(type = "number")]
    pub pagado: i64,
}

/* =========================================================
   Entrada: items de cobro venta rápida
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CobroVRItem {
    pub producto_id: String,
    pub precio: f64,
}

/* =========================================================
   Args / Inputs — Local-First (sin op_id/outbox/remote_id)
========================================================= */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasSaveLayoutInput {
    pub salons: Vec<SalonInput>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasSetReservaEstadoInput {
    pub id_reserva: String,
    pub estado: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasIdMesaArgs {
    pub id_mesa: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasIdComandaArgs {
    pub id_comanda: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasAbrirComandaInput {
    pub id_mesa: String,
    #[serde(default)]
    #[ts(optional)]
    pub id_trabajador: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub id_usuario: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub id_reserva: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasComandaSetTrabajadorInput {
    pub id_comanda: String,
    #[serde(default)]
    #[ts(optional)]
    pub id_usuario: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub id_trabajador: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasCerrarComandaInput {
    pub id_comanda: String,
    pub total: f64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasAddLineaComandaInput {
    pub id_comanda: String,
    pub id_producto: String,
    pub cantidad: f64,
    pub precio: f64,
    #[serde(default)]
    #[ts(optional)]
    pub id_usuario: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub id_trabajador: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasGetOrCreateComandaBarraInput {
    #[serde(default)]
    #[ts(optional)]
    pub id_trabajador: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasCreateComandaBarraInput {
    #[serde(default)]
    #[ts(optional)]
    pub id_trabajador: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasCobrarVentaRapidaInput {
    pub metodo: String,
    pub items: Vec<CobroVRItem>,
    #[serde(default)]
    #[ts(optional)]
    pub id_usuario_cobrador: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub id_trabajador_cobrador: Option<String>,
    /// Comanda concreta a cobrar (si no, se usa/crea la de barra abierta).
    #[serde(default)]
    #[ts(optional)]
    pub id_comanda: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasListComandasBarraArgs {
    #[serde(default)]
    #[ts(optional)]
    pub include_pagadas: Option<bool>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasDeleteComandaBarraIfSafeInput {
    pub id_comanda: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasIdCategoriaArgs {
    pub id_categoria: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasSearchProductosArgs {
    #[serde(default)]
    #[ts(optional)]
    pub q: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub query: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub texto: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasRemoveOnePendingDetalleInput {
    pub id_comanda: String,
    pub id_producto: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasDeleteDetalleInput {
    pub id_detalle: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasUpdateDetalleNotaInput {
    pub id_detalle: String,
    #[serde(default)]
    #[ts(optional)]
    pub nota: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasCobrarDetallesInput {
    pub id_comanda: String,
    pub metodo: String,
    pub tipo: String,
    pub detalle_ids: Vec<String>,
    #[serde(default)]
    #[ts(optional)]
    pub id_usuario: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct MesasKitchenSetLineStateInput {
    pub id_detalle: String,
    pub id_usuario_cocinero: String,
    pub estado: String,
}
