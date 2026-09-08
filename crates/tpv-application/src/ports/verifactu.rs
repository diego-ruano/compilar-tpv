//! Puertos de **Veri\*factu** (FISCAL-01).
//!
//! Dos interfaces, y la separación importa:
//!
//! - [`VerifactuRepository`] es lo local: la cadena de registros, la cola de envío y el panel.
//! - [`AeatClient`] es lo que sale a internet. Es un puerto propio porque su implementación de
//!   verdad **sólo existe en Windows** (necesita el almacén de certificados del sistema para el
//!   TLS mutuo) y porque los tests no pueden usarla: el certificado vive en el almacén de una
//!   máquina concreta. Todo lo que se puede probar sin red está del otro lado de esta frontera.

use async_trait::async_trait;

use crate::error::AppResult;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};

/// La cadena de registros y su cola de envío, en local.
#[async_trait]
pub trait VerifactuRepository: Send + Sync {
    /// El bloque fiscal de un ticket ya emitido, por su número de factura.
    ///
    /// Lo usan **la impresión y la reimpresión**, que son el mismo caso: una reimpresión saca el
    /// mismo número, el mismo QR y la misma huella, marcada COPIA, y no genera registro. Por eso
    /// se lee de la fila y no se recalcula — recalcular daría otra hora de generación y, por
    /// tanto, otra huella.
    async fn bloque_por_numero(&self, num_serie_factura: &str) -> AppResult<Option<BloqueFiscal>>;

    /// Resumen para el panel de Configuración → Fiscal y para la escalera de avisos.
    async fn estado(&self) -> AppResult<EstadoFiscal>;

    /// Los registros para el panel, del más reciente al más antiguo.
    async fn listar(&self, limite: i64, desplazamiento: i64) -> AppResult<Vec<RegistroFiscal>>;
}
