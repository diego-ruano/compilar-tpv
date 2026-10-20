//! Puerto de **escaneo de avisos**: consultas de tiempo/estado que alimentan el escáner periódico
//! (tareas vencidas, reservas próximas). Solo lo implementa el adaptador SQLite: el escáner corre
//! en la Main (escritor único), y desde ahí las emisiones se replican por el outbox.

use async_trait::async_trait;

use crate::error::AppResult;

/// Tarea con fecha límite pasada y alguna asignación sin finalizar (mínimo para el aviso).
#[derive(Debug, Clone)]
pub struct TareaVencida {
    pub id_tarea: String,
    pub titulo: String,
}

/// Reserva activa que empieza dentro de la ventana de antelación.
#[derive(Debug, Clone)]
pub struct ReservaProxima {
    pub id_reserva: String,
    pub nombre_cliente: String,
    pub dia_ymd: String,
    pub hora: String,
}

#[async_trait]
pub trait AvisosScanRepository: Send + Sync {
    /// Tareas ABIERTAS con `Fecha_Limite` pasada y ≥1 asignación distinta de FINALIZADA.
    async fn tareas_vencidas(&self) -> AppResult<Vec<TareaVencida>>;

    /// Reservas a las que aún no ha llegado nadie (`PROXIMA`) que empiezan dentro de los próximos
    /// `ventana_min` minutos.
    async fn reservas_proximas(&self, ventana_min: i64) -> AppResult<Vec<ReservaProxima>>;
}
