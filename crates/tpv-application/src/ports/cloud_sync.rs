//! Puerto de **sincronización Main → nube**.
//!
//! Operaciones que la Main (modo TPV) empuja al worker por HTTP firmado (device-proof, modo
//! `tpv`), fuera del camino normal de repositorios. Hoy cubre la subida del setup inicial; es
//! el punto natural para añadir futuras subidas de baseline (catálogo, configuración, etc.).
//!
//! No SQLite: lo implementa el adaptador de `tpv-infra-licensing` reutilizando su firma y su
//! cliente HTTP. El comando Tauri resuelve AppData y construye el adaptador.

use async_trait::async_trait;

use crate::error::AppResult;

#[async_trait]
pub trait CloudSyncService: Send + Sync {
    /// Sube a la nube el PIN inicial del admin (ya validado en local), para que el login de la
    /// Handy funcione contra datos reales y no contra el seed.
    async fn upload_initial_setup(&self, id_usuario: &str, pin: &str) -> AppResult<()>;
}
