//! Casos de uso de **Veri\*factu** (FISCAL-01).
//!
//! Son finos a propósito: la aritmética está en `tpv-domain` y la emisión ocurre **dentro de la
//! transacción del cobro**, en el repositorio, porque ahí es donde está la transacción. Lo que
//! queda aquí son las lecturas —el panel, el bloque para imprimir— y la orquestación de lo que no
//! puede vivir dentro de una transacción.

use crate::error::AppResult;
use crate::ports::verifactu::VerifactuRepository;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};

/// El bloque fiscal de un ticket ya emitido. Sirve igual para imprimir y para reimprimir.
pub async fn bloque_por_numero(
    repo: &dyn VerifactuRepository,
    num_serie_factura: &str,
) -> AppResult<Option<BloqueFiscal>> {
    let n = num_serie_factura.trim();
    if n.is_empty() {
        // Una precuenta no lleva número, y no llevar número es lo correcto: no es una factura, así
        // que no tiene registro ni QR. Devolver `None` en vez de un error es lo que permite que la
        // impresión de la precuenta comparta camino con la del ticket.
        return Ok(None);
    }
    repo.bloque_por_numero(n).await
}

/// Resumen del estado fiscal: datos del obligado, cola de envío y escalón de aviso.
pub async fn estado(repo: &dyn VerifactuRepository) -> AppResult<EstadoFiscal> {
    repo.estado().await
}

/// Los registros del panel.
pub async fn listar(
    repo: &dyn VerifactuRepository,
    limite: Option<i64>,
    desplazamiento: Option<i64>,
) -> AppResult<Vec<RegistroFiscal>> {
    repo.listar(limite.unwrap_or(100), desplazamiento.unwrap_or(0))
        .await
}
