//! Puerto del **correo de recuperación** del negocio (LOGIN-08): a dónde llegan los códigos para
//! recuperar el PIN de un administrador.
//!
//! Vive en la base central, no en la local: es la nube la que manda los códigos, y cambiarlo exige
//! demostrar el buzón nuevo con un código que la nube genera. Lo implementa el adaptador de
//! `tpv-infra-licensing`, que firma cada petición con la clave del dispositivo.

use async_trait::async_trait;

use tpv_contracts::login::{CodigoEnviado, EstadoCorreoRecuperacion};

use crate::error::AppResult;

#[async_trait]
pub trait CorreoRecuperacionService: Send + Sync {
    async fn estado(&self) -> AppResult<EstadoCorreoRecuperacion>;

    /// Manda un código al correo NUEVO. Hasta confirmarlo no cambia nada.
    async fn solicitar_cambio(&self, correo: &str) -> AppResult<CodigoEnviado>;

    /// Confirma la dirección que se pidió con `solicitar_cambio`, si el código vale.
    async fn confirmar_cambio(&self, codigo: &str) -> AppResult<EstadoCorreoRecuperacion>;

    /// Vuelve al correo de la compra. No pide código: ese buzón ya está demostrado.
    async fn usar_el_de_la_compra(&self) -> AppResult<EstadoCorreoRecuperacion>;
}
