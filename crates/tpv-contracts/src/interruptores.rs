//! Interruptores remotos de emergencia (PROD-06).
//!
//! Un interruptor apaga **en caliente y desde la nube** una tarea automática que se ha puesto a
//! hacer daño, sin publicar una versión. La lista es CERRADA y corta a propósito: una acción entra
//! sólo si cumple las tres condiciones —
//!
//! 1. **es automática** (la hace un job o el sistema, no alguien en el mostrador);
//! 2. **puede dañar a muchos a la vez o fuera del equipo** (escribe en la nube o en la AEAT, o
//!    cuesta dinero);
//! 3. **pausarla no pierde nada**: lo pendiente se queda en su cola y se retoma al encender.
//!
//! Y queda fuera siempre lo que PROTEGE (copias, licencia) y lo que rodea al cobro: nada de esto
//! puede impedir cobrar ni emitir el registro fiscal de un cobro.
//!
//! El valor serializado (snake_case) es el mismo en Rust, en el worker (`lib/interruptores.ts`,
//! con su drift-guard) y en la tabla `interruptores` de la base central.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Catálogo cerrado de lo que se puede apagar desde la nube.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(
    export,
    export_to = "../../../packages/contracts/src/generated/bindings.ts"
)]
pub enum Interruptor {
    /// Remisión de registros de facturación a la AEAT (job `verifactu_remitir`). Los registros se
    /// quedan `PENDIENTE`. Es una obligación tributaria: apagarlo es para no generar rechazos que
    /// haya que subsanar a mano mientras sale el arreglo, y por eso se ve en Configuración → Fiscal.
    VerifactuRemitir,
    /// La parte que ESCRIBE del contraste con la nube (SYNC-22/24/25): se sigue comparando e
    /// informando, pero no se encola ninguna reparación ni ningún borrado.
    ReparacionNube,
    /// El volcado del atraso a la cola del DO (SYNC-18). La Main sube por el camino en vivo.
    VolcadoAtraso,
    /// El drenado de la cola de entrada del DO. Sólo lo mira el worker; la cola es durable.
    ColaDo,
    /// La descarga del histórico tras una recuperación (SYNC-19, fase 2).
    BackfillHistorico,
    /// La conversión de la PII del personal a texto cifrado (TRAB-03).
    CifradoPii,
    /// La subida de imágenes pendientes a R2.
    Imagenes,
}

/// Un interruptor apagado ahora mismo para este equipo, tal como lo devuelve el worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../packages/contracts/src/generated/bindings.ts"
)]
pub struct InterruptorApagado {
    pub interruptor: Interruptor,
    /// Por qué se apagó. Se enseña en pantalla: lo escribe soporte, no es un identificador.
    pub motivo: String,
    /// Hasta cuándo (epoch ms). Pasada esta hora vuelve a estar encendido aunque no se sepa nada
    /// más de la nube: todo interruptor se enciende solo.
    #[ts(type = "number")]
    pub hasta_ms: i64,
}
