//! RI-31/RI-57: el transporte de réplica es una capacidad interna, nunca un IPC de SQL.
use std::sync::Arc;
use async_trait::async_trait;
use tpv_contracts::sync::SqlStatement;
use crate::{error::AppResult, ports::sync::SyncRepository};

pub use crate::ports::canal_nube::CanalNube as CanalReplicacion;

#[async_trait]
pub trait ContextoReplicacion: Send + Sync {
    /// Se adquiere sólo mientras se usa: retener la Db impediría restaurar una copia en Windows.
    async fn repositorio(&self) -> AppResult<Arc<dyn SyncRepository>>;
    fn cambios(&self, sentencias: &[SqlStatement]);
    fn fase_recuperacion(&self, fase: &str);
    fn solicitud_emparejamiento(&self);
    fn fallo_subida(&self, op_id: &str, fallo: &tpv_contracts::sync::OutboxFallo);
    async fn completar_recuperacion(&self, high_water: i64) -> AppResult<()>;
    async fn sigue_disponible(&self, recuperando: bool) -> AppResult<bool>;
    fn volcado_permitido(&self) -> bool;
}
