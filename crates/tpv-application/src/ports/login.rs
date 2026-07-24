//! Puerto de **login / auth / fichaje**.
//!
//! Operaciones **gruesas**: la verificación del PIN forma parte de cada operación y ocurre
//! dentro del adaptador — en local (`tpv-infra-sqlite`) con la cripto del dominio, o delegada
//! al worker (`tpv-infra-http`) en modo Handy, que la verifica server-side y nunca expone el
//! hash. Por eso el puerto no devuelve el `password_hash`.

use async_trait::async_trait;

use tpv_contracts::login::{LoginOk, PunchStatus, UserListItem};

use crate::error::AppResult;

#[async_trait]
pub trait LoginRepository: Send + Sync {
    /* Lecturas */
    async fn list_login_users(&self) -> AppResult<Vec<UserListItem>>;
    async fn get_today_punch_status(&self, id_usuario: &str) -> AppResult<PunchStatus>;

    /* Operaciones que verifican el PIN dentro del adaptador */
    /// Verifica el PIN y devuelve los datos de sesión.
    async fn login(&self, id_usuario: &str, pin: &str) -> AppResult<LoginOk>;

    /// Nº de intentos de PIN fallidos consecutivos del usuario (0 si no hay racha). Por defecto 0:
    /// los adaptadores que no lo rastrean (p. ej. HTTP/Handy) no disparan el aviso de seguridad.
    async fn intentos_fallidos(&self, _id_usuario: &str) -> AppResult<i64> {
        Ok(0)
    }

    /// Verifica el PIN actual, comprueba el email y aplica el setup inicial (cambia PIN + email).
    async fn complete_initial_setup(
        &self,
        id_usuario: &str,
        pin_actual: &str,
        pin_nuevo: &str,
        email_nuevo: &str,
    ) -> AppResult<()>;

    /// Aplica el fichaje (entrada/salida) tras verificar el PIN; devuelve el estado del día.
    async fn punch(
        &self,
        id_usuario: &str,
        pin: &str,
        tipo: &str,
        fecha: Option<String>,
        hora_evento: Option<String>,
    ) -> AppResult<PunchStatus>;

    /// Fija el turno partido del día (no requiere PIN).
    async fn set_turno_partido(
        &self,
        id_usuario: &str,
        fecha: Option<String>,
        turno_partido: bool,
    ) -> AppResult<()>;
}
