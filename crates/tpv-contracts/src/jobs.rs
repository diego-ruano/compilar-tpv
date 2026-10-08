//! Contratos del **runner de jobs**: las tareas periódicas de fondo de la app (chequeo de
//! licencia, feed de actualizaciones, escáner de avisos…).
//!
//! Solo se expone la FOTO de estado para el panel de diagnóstico (Configuración → Conectividad).
//! El runner no se pilota desde la UI: se declara en Rust y corre solo.

use serde::{Deserialize, Serialize};
/// Estado de un job periódico. Lo devuelve el comando `jobs_status`, una fila por job registrado
/// (los que no aplican a este dispositivo —modo o plataforma— ni siquiera aparecen).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct JobStatus {
    /// Identificador estable: es la clave en `_Jobs_State` y lo que aparece en logs y telemetría.
    pub nombre: String,
    /// Cada cuánto vence el job, en segundos.
    pub cada_secs: i64,
    /// Último intento, haya ido bien o mal. `null` si no se ha ejecutado nunca en este equipo.
    pub last_run_ms: Option<i64>,
    /// Última ejecución CORRECTA. Es la que marca el vencimiento del siguiente ciclo, así que
    /// sobrevive a reinicios de la app y a suspensiones del equipo.
    pub last_ok_ms: Option<i64>,
    /// Error del último intento fallido. `null` si el último intento fue bien.
    pub last_error: Option<String>,
    /// Fallos consecutivos (0 si el último intento fue bien). El runner los usa para el backoff.
    pub fallos: i64,
}
