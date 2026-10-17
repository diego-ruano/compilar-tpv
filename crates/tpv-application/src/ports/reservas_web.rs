//! Puerto de la reserva desde la web (docs/estudios/reservas-web.md).
//!
//! Sólo lo implementa la Main: su configuración es de administración y la Handy tiene vetadas sus
//! tablas en el worker (`lib/hub.ts::TABLAS_SOLO_MAIN`).

use async_trait::async_trait;

use crate::error::AppResult;

#[async_trait]
pub trait ReservasWebRepository: Send + Sync {
    /// La zona horaria guardada del negocio (`Business_Settings.Zona_Horaria`).
    async fn zona_horaria(&self) -> AppResult<String>;

    /// La cambia. Se replica: la nube la lee de su copia de la base.
    async fn fijar_zona_horaria(&self, zona: &str) -> AppResult<()>;
}
