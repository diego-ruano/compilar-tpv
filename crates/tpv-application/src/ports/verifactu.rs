//! Puerto del **registro de facturación** (FISCAL-01).
//!
//! La emisión ocurre dentro de la transacción del cobro, en el repositorio de cada camino que cobra;
//! lo que queda aquí es lo que se pide desde fuera de ella: si se puede facturar y las facturas
//! completas que se emiten después del cobro. Esta rama no remite a la AEAT (ver
//! `docs/arquitectura/verifactu.md`).

use async_trait::async_trait;

use crate::error::AppResult;
use tpv_contracts::verifactu::{BloqueFiscal, CanjeableDto, EstadoFiscal};

/// El registro de facturación, en local.
#[async_trait]
pub trait VerifactuRepository: Send + Sync {
    /// ¿Están los datos fiscales del negocio? Sin ellos no se puede cobrar.
    async fn estado(&self) -> AppResult<EstadoFiscal>;

    /// Emite una **factura completa en sustitución** de los tickets de unos cobros (`F3`,
    /// FISCAL-02): uno, o varios del mismo cliente en una sola factura.
    ///
    /// Es el *«¿me lo puedes hacer con IVA?»* del día siguiente. **No rectifica nada** (art. 15.6
    /// ROF): canjear simplificadas por una completa no es rectificar, y los tickets se quedan
    /// exactamente como están.
    async fn emitir_sustitutiva(
        &self,
        id_pagos: &[String],
        destinatario: tpv_domain::verifactu::Destinatario,
    ) -> AppResult<BloqueFiscal>;

    /// Qué tickets de estos cobros se pueden canjear por una factura completa, y por qué no los que
    /// no (DOC-INC-01). Son las mismas comprobaciones que hace `emitir_sustitutiva`, que rechaza
    /// igual: esto es para no dejar marcarlos en la pantalla.
    async fn facturas_canjeables(&self, id_pagos: &[String]) -> AppResult<Vec<CanjeableDto>>;

    /// Corrige el cliente de una factura completa ya expedida (una `F3` o una `F1`) y devuelve la
    /// factura nueva. Cómo se hace en cada caso está en el adaptador.
    async fn corregir_factura(
        &self,
        num_factura: &str,
        destinatario: tpv_domain::verifactu::Destinatario,
    ) -> AppResult<BloqueFiscal>;
}
