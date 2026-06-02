//! Puerto de persistencia de tareas.

use async_trait::async_trait;

use tpv_contracts::tareas::{
    MisTareasRow, TareaAdminRow, TareaAsignadoRow, TareaRow, TrabajadorUI,
};
use tpv_domain::tareas::TareaData;

use crate::error::AppResult;

#[async_trait]
pub trait TareasRepository: Send + Sync {
    /* Lecturas */
    async fn get_trabajadores(&self) -> AppResult<Vec<TrabajadorUI>>;
    async fn get_tareas_admin(&self) -> AppResult<Vec<TareaAdminRow>>;
    async fn get_tarea_by_id(&self, id_tarea: i64) -> AppResult<Option<TareaRow>>;
    async fn get_tarea_asignados(&self, id_tarea: i64) -> AppResult<Vec<TareaAsignadoRow>>;
    async fn get_mis_tareas(&self, id_trabajador: i64) -> AppResult<Vec<MisTareasRow>>;

    /* Escrituras (Local-First, sin outbox) */
    /// Crea una tarea y sus asignaciones iniciales. `true` si todo fue bien.
    async fn create_tarea(&self, data: TareaData, ids_trabajadores: Vec<i64>) -> AppResult<bool>;
    /// Actualiza una tarea existente. Error si no existe.
    async fn update_tarea(&self, id_tarea: i64, data: TareaData) -> AppResult<bool>;
    /// Sustituye el conjunto de asignaciones de la tarea. Error si la tarea no existe.
    async fn set_asignaciones(&self, id_tarea: i64, ids_trabajadores: Vec<i64>) -> AppResult<bool>;
    /// Elimina una tarea (y sus asignaciones). Error si no existe.
    async fn delete_tarea(&self, id_tarea: i64) -> AppResult<bool>;
    /// Marca finalizada la asignación de un trabajador en una tarea. Error si no existe.
    async fn marcar_finalizada(&self, id_tarea: i64, id_trabajador: i64) -> AppResult<bool>;
}
