//! Casos de uso del **registro de facturación** (FISCAL-01).
//!
//! Son finos a propósito: la aritmética está en `tpv-domain` y la emisión ocurre **dentro de la
//! transacción del cobro**, en el repositorio, porque ahí es donde está la transacción. Lo que
//! queda aquí es lo que se pide fuera del cobro: el estado de los datos fiscales y las facturas
//! completas de Cuentas.

use crate::error::{AppError, AppResult};
use crate::ports::verifactu::VerifactuRepository;
use tpv_contracts::verifactu::{BloqueFiscal, CanjeableDto, DestinatarioInput, EstadoFiscal};

/// ¿Puede facturar el negocio? Lo leen el aviso de datos fiscales y Configuración → Fiscal.
pub async fn estado(repo: &dyn VerifactuRepository) -> AppResult<EstadoFiscal> {
    repo.estado().await
}

/// Emite una factura completa en sustitución de los tickets de unos cobros (`F3`, FISCAL-02).
///
/// Los datos del cliente se validan en el repositorio, justo antes de emitir: un NIF con el dígito
/// de control mal se caza con el cliente delante.
pub async fn emitir_sustitutiva(
    repo: &dyn VerifactuRepository,
    id_pagos: &[String],
    destinatario: DestinatarioInput,
) -> AppResult<BloqueFiscal> {
    let ids: Vec<String> = id_pagos
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if ids.is_empty() {
        return Err(AppError::validation(
            "Elige al menos un cobro cuyo ticket se quiera facturar.",
        ));
    }
    repo.emitir_sustitutiva(&ids, destinatario_de(destinatario)).await
}

/// Qué tickets de estos cobros se pueden canjear por una factura completa (DOC-INC-01). Una página de
/// Cuentas como mucho: lo que se pide son las casillas que se ven.
pub async fn facturas_canjeables(
    repo: &dyn VerifactuRepository,
    id_pagos: &[String],
) -> AppResult<Vec<CanjeableDto>> {
    let mut ids: Vec<String> = id_pagos
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    ids.dedup();
    if ids.len() > 500 {
        return Err(AppError::validation("Como mucho 500 cobros de una vez."));
    }
    repo.facturas_canjeables(&ids).await
}

/// Corrige los datos del cliente de una factura completa ya expedida (FISCAL-02).
pub async fn corregir_factura(
    repo: &dyn VerifactuRepository,
    num_factura: &str,
    destinatario: DestinatarioInput,
) -> AppResult<BloqueFiscal> {
    let n = num_factura.trim();
    if n.is_empty() {
        return Err(AppError::validation("Hace falta el número de la factura que se corrige."));
    }
    repo.corregir_factura(n, destinatario_de(destinatario)).await
}

fn destinatario_de(d: DestinatarioInput) -> tpv_domain::verifactu::Destinatario {
    tpv_domain::verifactu::Destinatario {
        nombre_razon: d.nombre_razon,
        nif: d.nif,
        direccion: d.domicilio,
    }
}
