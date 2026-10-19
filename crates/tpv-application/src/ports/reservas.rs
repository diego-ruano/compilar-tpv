//! Puerto de persistencia de reservas.

use async_trait::async_trait;

use tpv_contracts::reservas::{ClienteCoincidente, ReservaDto, ReservasMetaDto};
use tpv_domain::reservas::ReservaValidada;

use crate::error::AppResult;

#[async_trait]
pub trait ReservasRepository: Send + Sync {
    /// Zonas + mesas (para los selectores del calendario de reservas).
    async fn meta(&self) -> AppResult<ReservasMetaDto>;

    /// Reservas en el rango `[desde, hasta]` (ambos YYYY-MM-DD ya normalizados).
    async fn mes(&self, desde: &str, hasta: &str) -> AppResult<Vec<ReservaDto>>;

    /// Una reserva, como en el calendario, o `None`. Es cómo estaba antes de cambiarla o borrarla:
    /// lo que dice si al cliente de una reserva web hay que avisarle (docs/estudios/reservas-web.md
    /// §5.7).
    async fn reserva(&self, id_reserva: &str) -> AppResult<Option<ReservaDto>>;

    /// Crea o actualiza una reserva con su cliente (ninguno, uno existente o uno nuevo, RI-61).
    /// Devuelve `true` si quedó persistida.
    ///
    /// Si la reserva se pisa con otra de su mesa o con una comanda abierta en ella, decide el modo
    /// del negocio (`Business_Settings.Reserva_Solape`): con «prohibir» es un `Conflict`; con
    /// «avisar», un `ReservaSolapada` salvo que llegue `forzar_solape`.
    async fn guardar(&self, reserva: ReservaValidada, forzar_solape: bool) -> AppResult<bool>;

    /// RI-61: el cliente que ya tiene ese email o, si no, ese teléfono (ya normalizados).
    async fn buscar_cliente(
        &self,
        telefono: Option<&str>,
        email: Option<&str>,
    ) -> AppResult<Option<ClienteCoincidente>>;

    /// Elimina una reserva (desvinculando comandas). Devuelve `true` si borró alguna fila.
    async fn eliminar(&self, id_reserva: &str) -> AppResult<bool>;
}
