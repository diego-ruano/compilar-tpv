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
}

/// Lo que hace falta para imprimir el ticket de un cobro.
#[derive(Debug, Clone, PartialEq)]
pub struct TicketDePago {
    /// `Pagos.Numero_Ticket`. Vacío en un cobro anterior a la numeración.
    pub numero_ticket: String,
    pub metodo_pago: String,
    /// `Mesa 5` / `Barra`.
    pub origen: String,
    pub anulado: bool,
    /// `Pagos.Fecha_Hora`. Es la fecha del papel cuando el cobro no tiene factura (modo prueba).
    pub fecha_hora: String,
    /// Las líneas que cobró ESE pago, no las de la comanda entera.
    pub lineas: Vec<LineaVendida>,
    /// `None` en un cobro sin registro de facturación (modo prueba).
    pub factura: Option<FacturaDelTicket>,
}

#[async_trait]
pub trait TicketsRepository: Send + Sync {
    /// El ticket de un cobro. `None` si el pago no existe.
    async fn ticket_de_pago(&self, id_pago: &str) -> AppResult<Option<TicketDePago>>;
}
