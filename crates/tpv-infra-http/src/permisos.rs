//! La Handy consulta las concesiones vigentes; su edición sólo existe en la Main.
use std::sync::Arc;
use async_trait::async_trait;
use tpv_application::{error::AppResult, ports::permisos::PermisosRepository};
use tpv_contracts::permisos::{AutorizacionUsuario, RolPermisos};
use crate::CloudClient;
pub struct HttpPermisosRepository { client: Arc<CloudClient> }
impl HttpPermisosRepository { pub fn new(client: Arc<CloudClient>) -> Self { Self { client } } }
#[async_trait]
impl PermisosRepository for HttpPermisosRepository {
    async fn usuario(&self, id: &str) -> AppResult<Option<AutorizacionUsuario>> {
        let id = uuid::Uuid::parse_str(id).map_err(|_| tpv_application::error::AppError::validation("Usuario inválido"))?;
        self.client.get_json(&format!("/v1/trabajadores/permisos/{id}")).await
    }
    async fn roles(&self) -> AppResult<Vec<RolPermisos>> {
        Err(tpv_application::error::AppError::coded(tpv_contracts::errors::ErrorCode::PermisoDenegado, "Los permisos se administran en el TPV principal"))
    }
}
