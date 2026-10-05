//! Puerto del **ticket de un cobro** (RI-29).
//!
//! El papel de un cobro se compone desde la base y no desde la pantalla: las líneas que cobró ese
//! pago y la factura que se emitió con él. Sólo existe en la Main, que es la que cobra, la que
//! tiene la impresora y la que guarda los registros de facturación.

use async_trait::async_trait;

use crate::error::AppResult;
use tpv_domain::dinero::Dinero;
use tpv_domain::ticket::{LineaVendida, TramoIva};

/// La factura que se emitió con un cobro, tal como está en `Registros_Facturacion`.
#[derive(Debug, Clone, PartialEq)]
pub struct FacturaDelTicket {
    /// `Num_Serie_Factura`: es también el número del ticket.
    pub num_serie: String,
    /// `F1` | `F2` | `F3`.
    pub tipo_factura: String,
    pub nif_emisor: String,
    pub razon_emisor: String,
    /// `DD-MM-AAAA`, como en el XML.
    pub fecha_expedicion: String,
    /// La hora en que se generó el registro (`2027-01-02T13:45:10+01:00`).
    pub fecha_hora_huso: String,
    pub qr_url: String,
    pub importe_total: Dinero,
    /// El desglose declarado, leído de `Desglose_Json`.
    pub tramos: Vec<TramoIva>,
    /// El cliente de una factura completa (`F1`/`F3`): `(nombre, NIF, domicilio)`.
    pub destinatario: Option<(String, String, Option<String>)>,
    /// En una `F3`, los números de las facturas que sustituye: el ticket que canjea, los de un
    /// canje de varios o, tras una devolución, la rectificativa.
    pub sustituye: Vec<String>,
    /// En una rectificativa, la factura que rectifica: `(número, fecha DD-MM-AAAA)`.
    pub rectifica: Option<(String, String)>,
}

/// Una factura de un cobro: `(número, tipo, importe total)`.
pub type FacturaDelCobro = (String, String, Dinero);

/// Lo que hace falta para imprimir el ticket de un cobro.
#[derive(Debug, Clone, PartialEq)]
pub struct TicketDePago {
    /// `Pagos.Numero_Ticket`. Vacío en un cobro anterior a la numeración.
    pub numero_ticket: String,
    pub metodo_pago: String,
    /// `Mesa 5` / `Barra`.
    pub origen: String,
    pub anulado: bool,
    /// Es la devolución de parte de otro cobro (`Pagos.ID_Pago_Origen`): sus líneas son las
    /// devueltas, y el papel las lleva en negativo aunque no haya rectificativa (modo prueba).
    pub es_devolucion: bool,
    /// `Pagos.Fecha_Hora`. Es la fecha del papel cuando el cobro no tiene factura (modo prueba).
    pub fecha_hora: String,
    /// Las líneas que documenta la factura: las que cobró ESE pago (no las de la comanda entera)
    /// o, en una `F3` de varios tickets, las de todos los cobros que canjea.
    pub lineas: Vec<LineaVendida>,
    /// `None` en un cobro sin registro de facturación (modo prueba).
    pub factura: Option<FacturaDelTicket>,
    /// Todas las facturas del cobro, en el orden en que se expidieron: el ticket o la `F1`, la `F3`
    /// que lo canjeó (sola o con otros tickets), la rectificativa de una devolución y su `F3`
    /// negativa.
    pub facturas: Vec<FacturaDelCobro>,
}

#[async_trait]
pub trait TicketsRepository: Send + Sync {
    /// El ticket de un cobro. `None` si el pago no existe.
    ///
    /// La factura es la del número del pago (`Pagos.Numero_Ticket`) salvo que se pida otra con
    /// `num_factura`: cualquiera de las del cobro (la `F3` del canje, la rectificativa…), que
    /// comparten pago y no número. Una factura que no es de ese pago no se devuelve.
    async fn ticket_de_pago(
        &self,
        id_pago: &str,
        num_factura: Option<&str>,
    ) -> AppResult<Option<TicketDePago>>;
}
