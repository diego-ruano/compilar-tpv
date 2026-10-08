//! Estado de la Handy para presentación. El transporte y las credenciales permanecen en Rust.
use serde::{Deserialize, Serialize};
use crate::sync::CambioReplicado;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ConexionHandy { Pausada, SinIdentidad, Conectando, Conectada, Reintentando, Rechazada }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RechazoHandy { Dispositivo, Licencia }

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EstadoSocketHandy {
    pub revision: u64,
    // Cambia al sustituir el vínculo o el modo. Un aviso anterior no pertenece a esta sesión.
    pub generacion: u64,
    // Cambia en cada conexión autenticada: permite recuperar avisos perdidos por la interfaz.
    pub conexion: u64,
    pub tenant_id: Option<String>,
    pub estado: ConexionHandy,
    pub main_online: Option<bool>,
    pub volcando: bool,
    pub rechazo: Option<RechazoHandy>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AvisoSocketHandy {
    pub generacion: u64,
    pub cambio: CambioReplicado,
}
