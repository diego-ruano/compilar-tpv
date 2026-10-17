//! Puerto de la reserva desde la web (docs/estudios/reservas-web.md).
//!
//! Sólo lo implementa la Main: su configuración es de administración y la Handy tiene vetadas sus
//! tablas en el worker (`lib/hub.ts::TABLAS_SOLO_MAIN`).

use async_trait::async_trait;

use tpv_contracts::reservas_web::CierreReservaWebDto;
use tpv_domain::reservas_web::CierreValidado;

use crate::error::AppResult;

#[async_trait]
pub trait ReservasWebRepository: Send + Sync {
    /// La zona horaria guardada del negocio (`Business_Settings.Zona_Horaria`).
    async fn zona_horaria(&self) -> AppResult<String>;

    /// La cambia. Se replica: la nube la lee de su copia de la base.
    async fn fijar_zona_horaria(&self, zona: &str) -> AppResult<()>;

    /// El interruptor general (`Business_Settings.Reserva_Web_Activa`).
    async fn activa(&self) -> AppResult<bool>;

    /// Lo enciende o apaga si no lo estaba ya, comparando y escribiendo bajo el mismo cerrojo de
    /// escritura: dos pulsaciones seguidas quedan en el orden en que llegaron. Sólo escribe si
    /// cambia, porque cada escritura viaja a la nube. Devuelve si ha cambiado.
    async fn fijar_activa(&self, activa: bool) -> AppResult<bool>;

    /// Los días cerrados de hoy en adelante, por fecha. Los pasados ya no le importan a nadie.
    async fn cierres(&self) -> AppResult<Vec<CierreReservaWebDto>>;

    /// Cierra un día. Si ya lo estaba, sólo cambia el motivo. Devuelve su id.
    async fn cerrar_dia(&self, cierre: CierreValidado) -> AppResult<String>;

    /// Vuelve a abrir un día. Devuelve si estaba cerrado.
    async fn quitar_cierre(&self, id_cierre: &str) -> AppResult<bool>;
}
