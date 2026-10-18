//! Puerto de la reserva desde la web (docs/estudios/reservas-web.md).
//!
//! Sólo lo implementa la Main: su configuración es de administración y la Handy tiene vetadas sus
//! tablas en el worker (`lib/hub.ts::TABLAS_SOLO_MAIN`).

use async_trait::async_trait;

use tpv_contracts::reservas_web::{CierreReservaWebDto, ReservaWebMesaDto};
use tpv_domain::reservas_web::{
    AltaWebParaRegistrar, AltaWebRegistrada, CancelacionWeb, CierreValidado, MesaWebValidada,
};

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

    /// La configuración web de las mesas del plano que la tienen, encendida o no. Las archivadas
    /// no salen: ya no están en el plano.
    async fn mesas(&self) -> AppResult<Vec<ReservaWebMesaDto>>;

    /// Guarda la de una mesa del plano y deja una sola franja, la de la pantalla. `NotFound` si la
    /// mesa ya no está en el plano.
    async fn guardar_mesa(&self, mesa: MesaWebValidada) -> AppResult<()>;

    /// Registra un alta de la web (§5.5), en una transacción: la reserva con el id de la agenda y su
    /// cliente, el que ya tenga ese correo o uno nuevo. **Nunca la rechaza por chocar**: la guarda y
    /// dice que choca. Recibirla dos veces no la duplica.
    async fn registrar_alta(&self, alta: AltaWebParaRegistrar) -> AppResult<AltaWebRegistrada>;

    /// Cancela una reserva web porque lo pide el cliente desde su enlace. Idempotente.
    async fn cancelar_desde_la_web(&self, id_reserva: &str) -> AppResult<CancelacionWeb>;
}
