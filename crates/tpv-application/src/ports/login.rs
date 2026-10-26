//! Puerto de **login / auth / fichaje**.
//!
//! Operaciones **gruesas**: la verificación del PIN forma parte de cada operación y ocurre
//! dentro del adaptador — en local (`tpv-infra-sqlite`) con la cripto del dominio, o delegada
//! al worker (`tpv-infra-http`) en modo Handy, que la verifica server-side y nunca expone el
//! hash. Por eso el puerto no devuelve el `password_hash`.

use async_trait::async_trait;

use tpv_contracts::login::{LoginOk, PunchStatus, SetupPendiente, UserListItem};

use crate::error::{AppError, AppResult};

#[async_trait]
pub trait LoginRepository: Send + Sync {
    /* Lecturas */
    async fn list_login_users(&self) -> AppResult<Vec<UserListItem>>;
    /// ¿Hay un usuario con el setup inicial pendiente? Lectura sin sesión: decide la primera
    /// pantalla del arranque.
    async fn setup_pendiente(&self) -> AppResult<SetupPendiente>;
    async fn get_today_punch_status(&self, id_usuario: &str) -> AppResult<PunchStatus>;

    /* Operaciones que verifican el PIN dentro del adaptador */
    /// Verifica el PIN y devuelve los datos de sesión.
    async fn login(&self, id_usuario: &str, pin: &str) -> AppResult<LoginOk>;

    /// Nº de intentos de PIN fallidos consecutivos del usuario (0 si no hay racha). Por defecto 0:
    /// los adaptadores que no lo rastrean (p. ej. HTTP/Handy) no disparan el aviso de seguridad.
    async fn intentos_fallidos(&self, _id_usuario: &str) -> AppResult<i64> {
        Ok(0)
    }

    /// Comprueba el email y aplica el setup inicial (cambia PIN + email). El permiso es
    /// `Requiere_Setup = 1`, que se apaga al aplicarlo: la operación se cierra sola tras el primer
    /// uso.
    ///
    /// REV-06: **es de la Main, y por defecto falla** —igual que `restablecer_pin_admin`—, así que
    /// la Handy no lo implementa. Lo hacía, contra una ruta del worker que verificaba el PIN sin
    /// límite de intentos: diez mil combinaciones y el PIN del administrador. Y no cubría ningún
    /// caso real, porque una Handy no puede llegar aquí — una Main con el setup pendiente no pasa
    /// de su propia pantalla de setup (`App.tsx`), así que no llega a Configuración y no puede
    /// vincular ninguna Handy.
    async fn complete_initial_setup(
        &self,
        _id_usuario: &str,
        _pin_nuevo: &str,
    ) -> AppResult<()> {
        Err(AppError::validation(
            "El PIN inicial se elige desde el TPV principal",
        ))
    }

    /// Aplica el fichaje (entrada/salida) tras verificar el PIN; devuelve el estado del día.
    async fn punch(&self, id_usuario: &str, pin: &str, tipo: &str) -> AppResult<PunchStatus>;

    /// Fija un PIN nuevo a un **administrador activo** tras recuperar el acceso por correo
    /// (LOGIN-07). No pide el PIN actual: quien autoriza es el código que la nube acaba de dar por
    /// bueno. Sólo tiene sentido donde el PIN se guarda, que es la Main; por defecto falla, y eso es
    /// lo que hace la Handy.
    async fn restablecer_pin_admin(&self, _id_usuario: &str, _pin_nuevo: &str) -> AppResult<()> {
        Err(AppError::validation("El PIN se recupera desde el TPV principal"))
    }

    /// Fija el turno partido del día (no requiere PIN).
    async fn set_turno_partido(
        &self,
        id_usuario: &str,
        fecha: Option<String>,
        turno_partido: bool,
    ) -> AppResult<()>;
}
