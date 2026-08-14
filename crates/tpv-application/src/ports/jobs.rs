//! Puerto del **estado persistido de los jobs** periódicos.
//!
//! El runner vive en el shell (Tauri), pero su estado tiene que sobrevivir a los reinicios: sin él
//! un job de 6 h no se ejecutaría NUNCA en un equipo que se apaga cada noche antes de cumplirlas.
//! Guardando `last_ok_ms` el vencimiento se decide en reloj de pared ("¿ha pasado el intervalo
//! desde el último éxito?") en vez de por tiempo de proceso.
//!
//! Solo lo implementa el adaptador SQLite: es estado LOCAL del dispositivo (cada equipo tiene su
//! propio ritmo de ejecución) y por eso no viaja por el outbox ni existe en la nube.

use async_trait::async_trait;

use crate::error::AppResult;

/// Estado de un job entre arranques. `Default` = nunca ejecutado.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EstadoJob {
    /// Último intento (éxito o fallo).
    pub last_run_ms: Option<i64>,
    /// Última ejecución correcta: la que cuenta para el vencimiento.
    pub last_ok_ms: Option<i64>,
    /// Error del último intento fallido; `None` si el último fue bien.
    pub last_error: Option<String>,
    /// Fallos consecutivos; 0 tras un éxito.
    pub fallos: i64,
}

#[async_trait]
pub trait JobsStateRepository: Send + Sync {
    /// Estado guardado de un job. `None` si no se ha ejecutado nunca en este equipo.
    async fn cargar(&self, nombre: &str) -> AppResult<Option<EstadoJob>>;

    /// Persiste el estado tras un intento (upsert por nombre).
    async fn guardar(&self, nombre: &str, estado: &EstadoJob) -> AppResult<()>;

    /// Todos los estados guardados, para la foto de diagnóstico.
    async fn listar(&self) -> AppResult<Vec<(String, EstadoJob)>>;
}
