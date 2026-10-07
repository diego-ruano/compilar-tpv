//! Canal interno de la nube. Lo abre infraestructura autenticada, nunca un llamante de IPC.
use std::time::Duration;
use async_trait::async_trait;
use serde_json::Value;
use crate::error::AppResult;

#[async_trait]
pub trait CanalNube: Send {
    async fn enviar(&mut self, mensaje: Value) -> AppResult<()>;
    /// None indica un vencimiento, no un cierre (el cierre devuelve error).
    async fn recibir(&mut self, espera: Duration) -> AppResult<Option<Value>>;
}

