//! Contratos (DTOs) de la frontera UI<->Rust para **mesas / salón / comandas / cocina**.
//! Local-First: los args de entrada NO llevan op_id/outbox/remote_id. Los nombres de los
//! tipos llevan el prefijo `Mesas`/`Mesa` cuando podrían colisionar en `bindings.ts` con
//! DTOs de otros módulos (p. ej. `LineaComandaRow` de venta_rapida, `IdCategoriaArgs` de
//! inventario). Los **nombres de campo** (serde) se conservan idénticos al backend antiguo.

use tpv_domain::dinero::Dinero;

use serde::{Deserialize, Serialize};
use crate::verifactu::DestinatarioInput;

/* =========================================================
   LAYOUT
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RoomPoly {
    #[serde(rename = "type")]
    pub kind: String,
    pub points: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TableInput {
    pub id: String,
    pub name: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub radius: Option<i64>,
    pub seats: i64,
    pub shape: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SalonInput {
    pub id: String,
    pub name: String,
    pub room: RoomPoly,
    pub tables: Vec<TableInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TableOut {
    pub id: String,
    pub name: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub radius: Option<i64>,
    pub seats: i64,
    pub shape: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SalonOut {
    pub id: String,
    pub name: String,
    pub room: RoomPoly,
    pub tables: Vec<TableOut>,
}

/* =========================================================
   COMANDAS (mesa)
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ComandaRow {
    pub id_comanda: String,
    pub id_mesa: String,
    pub id_trabajador: Option<String>,
    pub id_reserva: Option<String>,
    pub fecha_hora_apertura: String,
    pub fecha_hora_cierre: Option<String>,
    pub total_comanda: Dinero,
    pub estado: String,
}

/// Línea de comanda de mesa. (`Mesa`-prefijo para no colisionar con la de venta_rapida.)
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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
    pub precio_unitario: Dinero,
    /// Tipo de IVA con el que se vendió la línea (congelado al añadirla). `None` = el general
    /// del negocio. Va al ticket para desglosar por tipo.
    #[serde(rename = "IVA_Percent")]
    pub iva_percent: Option<f64>,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
    #[serde(rename = "Estado_Cocina")]
    pub estado_cocina: Option<String>,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Pasa_Cocina")]
    pub pasa_cocina: i64,
    #[serde(rename = "Pagado")]
    pub pagado: i64,
}

/* =========================================================
   META MESAS
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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
    pub minutos_para: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct MesaMetaOut {
    pub ocupada: bool,
    pub id_comanda: String,
    pub idComanda: String,
    pub totalPendiente: Dinero,
    pub pendientesPago: i64,
    pub pendientesCocina: i64,
    pub estado: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserva: Option<ReservaMesaOut>,
}

/* =========================================================
   CATÁLOGO
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct CategoriaVendibleOut {
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
    #[serde(rename = "Pasa_Cocina")]
    pub pasa_cocina: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct ProductoVendibleOut {
    #[serde(rename = "ID_Producto")]
    pub id_producto: String,
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Precio_Venta")]
    pub precio_venta: Dinero,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

/* =========================================================
   COCINA
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[allow(non_snake_case)]
pub struct KitchenRow {
    #[serde(rename = "ID_Comanda")]
    pub id_comanda: String,
    /// `None` en un ticket de barra, que no tiene mesa (RI-69).
    #[serde(rename = "Numero_Mesa")]
    pub numero_mesa: Option<String>,
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
    pub pagado: i64,
}

/* =========================================================
   Args / Inputs — Local-First (sin op_id/outbox/remote_id)
========================================================= */

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasSaveLayoutInput {
    pub salons: Vec<SalonInput>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasSetReservaEstadoInput {
    pub id_reserva: String,
    pub estado: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasIdMesaArgs {
    pub id_mesa: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasIdComandaArgs {
    pub id_comanda: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasAbrirComandaInput {
    pub id_mesa: String,
    #[serde(default)]
    pub id_trabajador: Option<String>,
    #[serde(default)]
    pub id_usuario: Option<String>,
    #[serde(default)]
    pub id_reserva: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasComandaSetTrabajadorInput {
    pub id_comanda: String,
    #[serde(default)]
    pub id_usuario: Option<String>,
    #[serde(default)]
    pub id_trabajador: Option<String>,
}

/// INC-20261030-007: enlazar la reserva que acaba de llegar con la comanda que ya estaba abierta
/// en su mesa, si el camarero dice que es suya.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasComandaSetReservaInput {
    pub id_comanda: String,
    pub id_reserva: String,
}

/// RI-27: sin precio. El de la línea lo pone el catálogo, no la pantalla.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasAddLineaComandaInput {
    pub id_comanda: String,
    pub id_producto: String,
    pub cantidad: f64,
    #[serde(default)]
    pub id_usuario: Option<String>,
    #[serde(default)]
    pub id_trabajador: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasIdCategoriaArgs {
    pub id_categoria: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasSearchProductosArgs {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub texto: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasRemoveOnePendingDetalleInput {
    pub id_comanda: String,
    pub id_producto: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasDeleteDetalleInput {
    pub id_detalle: String,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasUpdateDetalleNotaInput {
    pub id_detalle: String,
    #[serde(default)]
    pub nota: Option<String>,
}

/// REV-17: quién cobra sale de la **sesión**, nunca de la entrada (SEC-01).
///
/// Es la misma regla que ya aplican anular un cobro, cerrar la caja y abrir el cajón, y faltaba
/// justo donde más duele: el cobrador que se guarda con el pago es el rastro con el que se
/// investiga un descuadre del cajón. Firmándolo con lo que le pase la pantalla, quien alcance el
/// IPC puede cobrar en efectivo a nombre de otro — o sea, la sisa que ese rastro existe para poder
/// ver. Y no hay sitio donde se cobre sin sesión: a las dos pantallas de venta sólo se llega
/// pasando el login.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasCobrarDetallesInput {
    pub id_comanda: String,
    pub metodo: String,
    pub tipo: String,
    pub detalle_ids: Vec<String>,
    /// FISCAL-02: si viene, se emite **factura completa** (`F1`) en vez de un ticket.
    ///
    /// Se llega aquí por dos caminos: el cliente lo pide («Factura con NIF») o el importe pasa del
    /// límite de la simplificada y entonces no hay alternativa. Si pasa del límite y esto va vacío,
    /// el cobro se rechaza con `factura_completa_requerida` y la pantalla pide los datos.
    #[serde(default)]
    pub destinatario: Option<DestinatarioInput>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MesasKitchenSetLineStateInput {
    pub id_detalle: String,
    pub id_usuario_cocinero: String,
    pub estado: String,
}
