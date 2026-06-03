//! Puerto de persistencia de login / auth / fichaje.

use async_trait::async_trait;

use tpv_contracts::login::{PunchStatus, UserListItem};
use tpv_domain::login::{LoginUserRecord, SetupInfo};

use crate::error::AppResult;

#[async_trait]
pub trait LoginRepository: Send + Sync {
    /* Lecturas */
    async fn list_login_users(&self) -> AppResult<Vec<UserListItem>>;
    /// Datos del usuario para login (incluye el hash; la verificación va en el caso de uso).
    async fn get_login_record(&self, id_usuario: i64) -> AppResult<Option<LoginUserRecord>>;
    async fn get_today_punch_status(&self, id_usuario: i64) -> AppResult<PunchStatus>;
    /// Hash del usuario activo (para verificar PIN antes de fichar).
    async fn get_password_hash(&self, id_usuario: i64) -> AppResult<Option<String>>;
    async fn get_setup_info(&self, id_usuario: i64) -> AppResult<Option<SetupInfo>>;
    async fn email_in_use(&self, email: &str, exclude_id: i64) -> AppResult<bool>;

    /* Escrituras (Local-First, sin outbox) */
    async fn set_turno_partido(
        &self,
        id_usuario: i64,
        fecha: Option<String>,
        turno_partido: bool,
    ) -> AppResult<()>;
    async fn apply_initial_setup(
        &self,
        id_usuario: i64,
        email: String,
        new_hash: String,
    ) -> AppResult<()>;
    /// Aplica un fichaje (entrada/salida) con sus reglas y devuelve el estado del día.
    async fn punch(
        &self,
        id_usuario: i64,
        tipo: String,
        fecha: Option<String>,
        hora_evento: Option<String>,
    ) -> AppResult<PunchStatus>;
}
