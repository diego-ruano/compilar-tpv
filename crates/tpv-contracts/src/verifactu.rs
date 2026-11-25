//! DTOs del **registro de facturación** (FISCAL-01) que cruzan la frontera UI ↔ Rust.

use serde::{Deserialize, Serialize};
/// La factura que se acaba de emitir, tal como la devuelven las facturas completas de Cuentas.
///
/// **Estos datos no se pueden inventar en el cliente.** Salen de la fila que se acaba de escribir
/// en `Registros_Facturacion` dentro de la misma transacción: el número es el que reservó el
/// contador.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BloqueFiscal {
    /// `2027/000001`. En un cobro es también `Pagos.Numero_Ticket`: un solo número para el papel,
    /// el cobro y el registro — dos numeraciones paralelas serían dos cosas que pueden divergir.
    pub num_serie_factura: String,
    /// `DD-MM-AAAA`.
    pub fecha_expedicion: String,
    /// `F1` | `F2` | `F3` | `R1`..`R5`.
    pub tipo_factura: String,
}

/// Datos del cliente para emitir **factura completa** (FISCAL-02).
///
/// El registro de facturación guarda el nombre, el NIF y el domicilio en `Destinatario_Json`: el
/// art. 6 ROF le exige a una factura el domicilio del destinatario, y de ahí sale el papel (RI-29).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DestinatarioInput {
    pub nombre_razon: String,
    pub nif: String,
    #[serde(default)]
    pub domicilio: Option<String>,
}

/// ¿Puede facturar el negocio? Lo leen el aviso de datos fiscales y Configuración → Negocio.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EstadoFiscal {
    /// ¿Están el NIF y la razón social configurados? Sin ellos no se puede emitir la factura, y
    /// por tanto no se puede cobrar.
    pub datos_fiscales_completos: bool,
    pub nif: Option<String>,
    pub razon_social: Option<String>,
}

/// Si el ticket de un cobro se puede canjear por una factura completa (DOC-INC-01). Lo pide
/// Cuentas al elegir varios tickets para una factura, para no dejar marcar uno que se rechazaría.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct CanjeableDto {
    pub id_pago: String,
    /// `None` = se puede canjear. Si no, por qué, corto: «Ya facturado: 2026/000026».
    pub motivo: Option<String>,
}
