//! Contratos (DTOs) de la frontera UI<->Rust para **venta rápida** (barra).
//! Los DTOs de salida conservan los nombres PascalCase de las columnas (campos crudos
//! con `#[allow(non_snake_case)]`). Local-First: los args de entrada NO llevan
//! op_id/outbox/remote_id.

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
use crate::verifactu::DestinatarioInput;

/* =========================================================
   Salida (read models)
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct CategoriaRow {
    pub ID_Categoria: String,
    pub Nombre: String,
    pub Nombre_Imagen: Option<String>,
    pub Ruta_Imagen: Option<String>,
    pub Vendible: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct ProductoRow {
    pub ID_Producto: String,
    pub ID_Categoria: String,
    pub Nombre: String,
    pub Precio_Venta: Dinero,
    pub Stock_Actual: f64,
    pub Stock_Minimo: f64,
    pub Unidad_Medida: Option<String>,
    pub Nombre_Imagen: Option<String>,
    pub Ruta_Imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct ComandaBarraRow {
    pub ID_Comanda: String,
    pub Fecha_Hora_Apertura: String,
    pub Estado: String,
    pub Total_Pendiente: Dinero,
    pub Total_Comanda: Dinero,
    pub Pendientes_Cocina: i64,
    pub Pendientes_Pago: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct LineaComandaRow {
    pub ID_Detalle: String,
    pub ID_Comanda: String,
    pub ID_Producto: String,
    pub Cantidad: f64,
    pub Precio_Unitario: Dinero,
    /// Tipo de IVA con el que se vendió la línea (congelado al añadirla); `None` = el del negocio.
    pub IVA_Percent: Option<f64>,
    pub Notas: Option<String>,
    /// Lo que se pidió distinto (array JSON de `Detalle_Comanda.Cambios_Ingredientes`).
    pub Cambios_Ingredientes: Option<String>,
    pub Estado_Cocina: Option<String>,
    pub Pagado: i64,
    pub Nombre: String,
    /// El nombre de la categoría del producto, con el que el ticket agrupa sus líneas (INC-03).
    /// `None` si el producto ya no existe.
    pub Categoria: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct VerTicketsDetalleRow {
    pub ID_Detalle: String,
    pub ID_Producto: String,
    pub Nombre: String,
    pub Cantidad: f64,
    pub Precio_Unitario: Dinero,
    /// Tipo de IVA con el que se vendió la línea (congelado al añadirla); `None` = el del negocio.
    pub IVA_Percent: Option<f64>,
    pub Estado_Cocina: String,
    pub Pagado: i64,
    pub Notas: Option<String>,
    /// Lo que se pidió distinto (array JSON de `Detalle_Comanda.Cambios_Ingredientes`).
    pub Cambios_Ingredientes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct IndexRow {
    pub ID_Comanda: String,
    pub Productos: Option<String>,
    pub NumLineas: i64,
    pub Unidades: f64,
}

/* =========================================================
   Entrada (args/inputs) — Local-First
========================================================= */

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrListComandasArgs {
    pub include_pagadas: bool,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrIdCategoriaArgs {
    pub id_categoria: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrSearchProductosArgs {
    pub query: String,
    pub limit: i64,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrIdComandaArgs {
    pub id_comanda: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrIdsArgs {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrCreateComandaBarraInput {
    #[serde(default)]
    pub id_trabajador: Option<String>,
    /// Si es `true`, reutiliza la comanda de barra abierta si existe (get-or-create).
    #[serde(default)]
    pub get_or_create: Option<bool>,
}

/// RI-27: sin precio. El de la línea lo pone el catálogo, no la pantalla.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrAddLineaComandaInput {
    pub id_comanda: String,
    pub id_producto: String,
    pub cantidad: f64,
}

/// La línea recién añadida, con el precio que se le ha puesto: el del catálogo en ese momento, que
/// puede no ser el de la carta en caché de la pantalla (RI-27).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct VrLineaAnadida {
    pub id_detalle: String,
    pub precio_unitario: Dinero,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrRemoveLastUnpaidLineaInput {
    pub id_comanda: String,
    pub id_producto: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrDeleteLineaIfUnpaidInput {
    pub id_comanda: String,
    pub id_detalle: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrUpdateNotaDetalleInput {
    pub id_detalle: String,
    #[serde(default)]
    pub nota: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
/// REV-17: quién cobra sale de la **sesión**, nunca de la entrada (SEC-01).
///
/// Es la misma regla que ya aplican anular un cobro, cerrar la caja y abrir el cajón, y faltaba
/// justo donde más duele: el cobrador que se guarda con el pago es el rastro con el que se
/// investiga un descuadre del cajón. Firmándolo con lo que le pase la pantalla, quien alcance el
/// IPC puede cobrar en efectivo a nombre de otro — o sea, la sisa que ese rastro existe para poder
/// ver. Y no hay sitio donde se cobre sin sesión: a las dos pantallas de venta sólo se llega
/// pasando el login.
pub struct VrCobrarFraccionadoInput {
    /// El id del cobro (`Pagos.ID_Pago`), un UUID que genera la pantalla al encolarlo.
    ///
    /// Es lo que hace idempotente el cobro: si la aplicación se cae después de guardarlo y antes de
    /// quitarlo de la cola, al volver se reintenta con el mismo id y se devuelve el número del cobro
    /// que ya existe, en vez de rechazarlo por no quedar líneas pendientes.
    pub id_pago: String,
    pub id_comanda: String,
    pub metodo: String,
    pub importe_total: Dinero,
    pub detalles: Vec<String>,
    /// FISCAL-02: si viene, se emite **factura completa** (`F1`) en vez de un ticket.
    ///
    /// Se llega aquí por dos caminos: el cliente lo pide («Factura con NIF») o el importe pasa del
    /// límite de la simplificada y entonces no hay alternativa. Si pasa del límite y esto va vacío,
    /// el cobro se rechaza con `factura_completa_requerida` y la pantalla pide los datos.
    #[serde(default)]
    pub destinatario: Option<DestinatarioInput>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct VrDeleteComandaIfSafeInput {
    pub id_comanda: String,
}

/// RI-47: recuperación local compartida. La atribución la fija el backend al preparar el cobro.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CobroPendienteDto {
    pub cobro: VrCobrarFraccionadoInput,
    pub id_usuario: Option<String>,
    pub id_trabajador: Option<String>,
    pub creado_en_ms: i64,
    pub ultimo_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ResolverCobroPendienteInput {
    pub id_pago: String,
    #[serde(default)]
    pub destinatario: Option<DestinatarioInput>,
}
