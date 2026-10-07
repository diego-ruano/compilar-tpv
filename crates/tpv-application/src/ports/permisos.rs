//! Autorización vigente; nunca recibe el rol que declara la webview.
use async_trait::async_trait;
use crate::error::{AppError, AppResult};
use tpv_contracts::permisos::{AutorizacionUsuario, RolPermisos, GuardarPermisosInput};
#[async_trait]
pub trait PermisosRepository: Send + Sync {
    async fn usuario(&self, id_usuario: &str) -> AppResult<Option<AutorizacionUsuario>>;
    async fn roles(&self) -> AppResult<Vec<RolPermisos>>;
    /// El adaptador comprueba al administrador y la versión leída dentro de la transacción.
    async fn guardar(&self, _actor: &str, _input: GuardarPermisosInput) -> AppResult<()> {
        Err(AppError::coded(tpv_contracts::errors::ErrorCode::PermisoDenegado, "Los permisos se administran en el TPV principal"))
    }
}
