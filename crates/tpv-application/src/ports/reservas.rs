//! Puerto de persistencia de reservas.

use async_trait::async_trait;

use tpv_contracts::reservas::{ClienteCoincidente, ReservaDto, ReservasMetaDto};
use tpv_contracts::reservas_web::{AvisoReservaWebInput, TipoAvisoReservaWeb};
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

    /// Elimina una reserva (desvinculando comandas). Una reserva web que está por venir no se borra:
    /// se cancela. Devuelve `true` si borró o canceló alguna.
    async fn eliminar(&self, id_reserva: &str) -> AppResult<bool>;
}

/// Lo que se le dice al cliente de una reserva web que el restaurante ha cambiado o cancelado
/// (docs/estudios/reservas-web.md §5.7): los datos de después del cambio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvisoAlCliente {
    pub id_reserva: String,
    pub tipo: TipoAvisoReservaWeb,
    pub dia_ymd: String,
    pub hora: String,
    pub personas: i64,
    /// El nombre de la mesa, o `None` sin mesa.
    pub mesa: Option<String>,
    /// El cliente que tiene la reserva tras el cambio: a ése, y sólo a ése, le escribe la nube.
    pub id_cliente: Option<String>,
    /// La huella de su correo en la Main: la nube espera a tener el mismo.
    pub huella_correo: Option<String>,
}

/// El correo al cliente de una reserva web por un cambio del restaurante. Lo envía el worker
/// (`POST /v1/reservas-web/avisos`); cada implementación le pone su id al aviso.
#[async_trait]
pub trait AvisosReservaWeb: Send + Sync {
    /// En la Main lo encola, y un job lo manda cuando hay conexión (un cambio hecho sin internet
    /// avisa al volver); en la Handy, que siempre tiene red, lo manda ya.
    async fn encolar(&self, aviso: AvisoAlCliente) -> AppResult<()>;
}

/// Un aviso que espera en la cola de la Main (`_Reservas_Web_Avisos`): el cuerpo tal cual se
/// manda, con su id, y cuándo se encoló.
#[derive(Debug, Clone, PartialEq)]
pub struct AvisoEnCola {
    pub cuerpo: AvisoReservaWebInput,
    pub creado_ms: i64,
    /// Cuántas veces se ha intentado sin que saliera.
    pub intentos: i64,
}

/// La cola de avisos de la Main, que vacía el job `avisos_reserva_web`. Es estado local del equipo:
/// no se replica.
#[async_trait]
pub trait ColaAvisosReservaWeb: Send + Sync {
    /// Primero los menos intentados y, entre ellos, los más viejos, como mucho `max`: los que no
    /// salen van rotando detrás y no tapan a los demás. Como mucho uno por reserva: encolar el aviso
    /// de una reserva quita los que esperaban de ella, porque el último dice cómo queda.
    async fn pendientes(&self, max: i64) -> AppResult<Vec<AvisoEnCola>>;
    /// Enviado, o descartado.
    async fn quitar(&self, id_aviso: &str) -> AppResult<()>;
    /// Un intento que no ha salido, con el código del error (nunca su texto).
    async fn apuntar_fallo(&self, id_aviso: &str, codigo: &str) -> AppResult<()>;
}
