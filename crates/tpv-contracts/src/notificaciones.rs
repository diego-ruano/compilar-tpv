//! Contratos (DTOs) de la frontera UI<->Rust para **notificaciones**.
//!
//! Campos snake_case (los consume el frontend directamente). Sin op_id/outbox (Local-First):
//! el reparto a otros dispositivos lo hace la captura del outbox sobre las escrituras.

use serde::{Deserialize, Serialize};
/// Fila del centro de notificaciones **para un usuario concreto**: incluye `leida`, que se calcula
/// respecto a ese usuario (una notificación "a todos" está leída para unos y no para otros).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NotificacionRow {
    pub id_notificacion: String,
    pub tipo: String,
    pub severidad: String,
    pub titulo: String,
    pub cuerpo: Option<String>,
    pub destino_tipo: String,
    pub destino_valor: Option<String>,
    pub accion: Option<String>,
    pub payload: Option<String>,
    pub estado: String,
    pub creada_en: String,
    pub expira_en: Option<String>,
    /// ¿La ha leído el usuario por el que se consulta?
    pub leida: bool,
}

/// Args para listar las notificaciones visibles de un usuario.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct NotificacionesListArgs {
    pub id_usuario: String,
    /// Si es `true`, solo devuelve las no leídas por ese usuario.
    #[serde(default)]
    pub solo_no_leidas: Option<bool>,
}

/// Args con solo el id de usuario (p. ej. contador de no leídas).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct NotificacionesUsuarioArgs {
    pub id_usuario: String,
}

/// Marca una notificación como leída por un usuario.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MarcarLeidaInput {
    pub id_notificacion: String,
    pub id_usuario: String,
}

/// Identifica una notificación para las acciones de la papelera (descartar, restaurar, eliminar).
///
/// El estado de la papelera es de la NOTIFICACIÓN, no del usuario que la mira: una notificación es
/// un aviso del negocio (stock bajo, pedido por aprobar) y borrarla es decir "esto ya está visto",
/// no "no me lo enseñes a mí". Por eso aquí no viaja el `id_usuario`: lo que sí es por usuario es
/// la lectura, que tiene su propia tabla.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct NotificacionIdInput {
    pub id_notificacion: String,
}

/// Marca como leídas todas las notificaciones visibles de un usuario.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MarcarTodasLeidasInput {
    pub id_usuario: String,
}

/// Entrada para emitir una notificación manual (envío desde una pantalla de administración).
/// El resto de módulos NO usan este DTO: emiten por el puerto `Notifier` en su caso de uso.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CrearNotificacionInput {
    pub tipo: String,
    #[serde(default)]
    pub severidad: Option<String>,
    pub titulo: String,
    #[serde(default)]
    pub cuerpo: Option<String>,
    pub destino_tipo: String,
    #[serde(default)]
    pub destino_valor: Option<String>,
    #[serde(default)]
    pub accion: Option<String>,
    /// JSON (como string) con los datos de la acción.
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub clave_dedupe: Option<String>,
    #[serde(default)]
    pub expira_en: Option<String>,
}
