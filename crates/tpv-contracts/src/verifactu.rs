//! DTOs de **Veri\*factu** (FISCAL-01) que cruzan la frontera UI ↔ Rust.
//!
//! Los IDs `i64` van con `#[ts(type = "number")]`: los identificadores de este TPV no se acercan a
//! 2^53 y el frontend los trata como `number`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// El bloque fiscal que un cobro devuelve al frontend para que lo meta en el payload de impresión.
///
/// **Estos datos no se pueden inventar en el cliente.** Salen de la fila que se acaba de escribir
/// en `Registros_Facturacion` dentro de la misma transacción que el pago: el número es el que
/// reservó el contador, el QR es la URL exacta que se guardó, y la huella es la que encadena. Una
/// reimpresión saca los mismos tres, y por eso se leen de la fila y no se recalculan.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct BloqueFiscal {
    /// `2027/000001`. Es también `Pagos.Numero_Ticket`: un solo número para el papel, el cobro y el
    /// registro — dos numeraciones paralelas serían dos cosas que pueden divergir.
    pub num_serie_factura: String,
    /// `DD-MM-AAAA`, tal cual va al XML y al QR.
    pub fecha_expedicion: String,
    /// La URL que se rasteriza en el código QR del papel.
    pub qr_url: String,
    /// 64 hexadecimales en mayúsculas.
    pub huella: String,
    /// `F1` | `F2` | `F3` | `R1`..`R5`.
    pub tipo_factura: String,
    /// `true` si el registro se emitió contra el entorno de **pruebas**. El papel lleva entonces un
    /// QR que apunta a `prewww2.aeat.es`, y la pantalla tiene que gritarlo.
    pub entorno_pruebas: bool,
}

/// Una fila de `Registros_Facturacion` tal como la enseña el panel fiscal.
///
/// Es un subconjunto: el panel no necesita el desglose ni el bloque del sistema informático, que
/// son para el XML y para la exportación del art. 8 RRSIF.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct RegistroFiscal {
    pub id_registro: String,
    #[ts(type = "number")]
    pub orden: i64,
    /// `ALTA` | `ANULACION`.
    pub tipo: String,
    pub num_serie_factura: String,
    pub fecha_expedicion: String,
    #[ts(optional)]
    pub tipo_factura: Option<String>,
    #[ts(optional)]
    pub importe_total: Option<String>,
    #[ts(optional)]
    pub cuota_total: Option<String>,
    pub huella: String,
    /// `AAAA-MM-DDThh:mm:ss±hh:mm`.
    pub fecha_hora_huso: String,
    /// `"S"` si el registro se generó durante una incidencia (sin conexión, tras una restauración).
    pub incidencia: String,
    /// `"S"` si es una subsanación de otro registro.
    #[ts(optional)]
    pub subsanacion: Option<String>,
    #[ts(optional)]
    pub id_pago: Option<String>,

    // ── Estado del envío (tabla local `_Verifactu_Envios`, no se replica) ──
    /// `PENDIENTE` | `ACEPTADO` | `ACEPTADO_CON_ERRORES` | `RECHAZADO`, o `null` si por lo que sea
    /// el registro no tiene fila de envío (no debería pasar: se crean juntas).
    #[ts(optional)]
    pub estado_envio: Option<String>,
    #[ts(type = "number")]
    pub intentos: i64,
    #[ts(optional)]
    pub codigo_error: Option<String>,
    #[ts(optional)]
    pub descripcion_error: Option<String>,
    /// Código Seguro de Verificación que devolvió la AEAT. **No se puede recuperar con una consulta
    /// posterior**, así que se guarda en el momento del alta o se pierde.
    #[ts(optional)]
    pub csv: Option<String>,
}

/// Resumen para el panel de Configuración → Fiscal y para la barra de estado.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct EstadoFiscal {
    /// ¿Están el NIF y la razón social configurados? Sin ellos no se puede emitir, y por tanto no
    /// se puede cobrar: es la única puerta que Veri\*factu añade al camino de la venta.
    pub datos_fiscales_completos: bool,
    #[ts(optional)]
    pub nif: Option<String>,
    #[ts(optional)]
    pub razon_social: Option<String>,
    pub entorno_pruebas: bool,

    #[ts(type = "number")]
    pub total_registros: i64,
    #[ts(type = "number")]
    pub pendientes: i64,
    #[ts(type = "number")]
    pub aceptados: i64,
    #[ts(type = "number")]
    pub aceptados_con_errores: i64,
    #[ts(type = "number")]
    pub rechazados: i64,

    /// Antigüedad en minutos del registro **pendiente más viejo**. `null` si no hay ninguno.
    ///
    /// Es lo que mide la escalera de avisos, y se mide sobre el registro y no sobre el tiempo sin
    /// conexión a propósito: estar desconectado sin nada que enviar no es un problema.
    #[ts(optional)]
    #[ts(type = "number")]
    pub antiguedad_pendiente_min: Option<i64>,
    /// Escalón de la escalera: `ninguno` | `visible` | `notificacion` | `modal_login` |
    /// `modal_cobro`.
    pub escalon_aviso: String,

    /// ¿Hay un certificado elegido y sigue existiendo en el almacén de Windows?
    pub certificado_ok: bool,
    /// Motivo por el que no se puede remitir, si lo hay: `sin_certificado`,
    /// `certificado_no_encontrado`, `sin_datos_fiscales`… Vacío si se puede.
    #[ts(optional)]
    pub motivo_no_remite: Option<String>,
    /// Días que quedan hasta que caduque el certificado elegido. `null` si no hay certificado.
    #[ts(optional)]
    #[ts(type = "number")]
    pub dias_para_caducar_certificado: Option<i64>,
}
