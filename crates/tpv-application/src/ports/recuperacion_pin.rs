//! Puerto de la **recuperación del PIN de un administrador** (LOGIN-07).
//!
//! La nube hace dos cosas y ninguna más: mandar un código al correo de la licencia y decir si el
//! que se ha escrito vale. El PIN nuevo no sale del equipo: lo guarda el `LoginRepository` local.
//! Lo implementa el adaptador de `tpv-infra-licensing`, que firma la petición con la clave del
//! dispositivo — y esa firma es la mitad de la prueba de que quien pide está delante de la Main.

use async_trait::async_trait;

use tpv_contracts::login::CodigoPinEnviado;

use crate::error::AppResult;

#[async_trait]
pub trait RecuperacionPinService: Send + Sync {
    /// Pide que se mande un código al correo del titular de la licencia.
    async fn solicitar_codigo(&self, id_usuario: &str) -> AppResult<CodigoPinEnviado>;

    /// `Ok` sólo si el código vale para este equipo y este usuario. Si vale, queda gastado.
    async fn verificar_codigo(&self, id_usuario: &str, codigo: &str) -> AppResult<()>;
}
