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
    async fn get_tarea_by_id(&self, id_tarea: &str) -> AppResult<Option<TareaRow>>;
    async fn get_tarea_asignados(&self, id_tarea: &str) -> AppResult<Vec<TareaAsignadoRow>>;
    async fn get_mis_tareas(&self, id_trabajador: &str) -> AppResult<Vec<MisTareasRow>>;

    /* Escrituras (Local-First, sin outbox) */
    /// Crea una tarea y sus asignaciones iniciales. `true` si todo fue bien.
    async fn create_tarea(&self, data: TareaData, ids_trabajadores: Vec<String>)
        -> AppResult<bool>;
    /// Actualiza una tarea existente. Error si no existe.
    async fn update_tarea(&self, id_tarea: &str, data: TareaData) -> AppResult<bool>;
    /// Sustituye el conjunto de asignaciones de la tarea. Error si la tarea no existe.
    async fn set_asignaciones(
        &self,
        id_tarea: &str,
        ids_trabajadores: Vec<String>,
    ) -> AppResult<bool>;
    /// Manda una tarea a la papelera (TAR-05: borrado reversible). Error si no existe.
    async fn delete_tarea(&self, id_tarea: &str) -> AppResult<bool>;
    /// Tareas que están en la papelera.
    async fn get_papelera(&self) -> AppResult<Vec<TareaAdminRow>>;
    /// Devuelve una tarea de la papelera a la lista. Error si no está en la papelera.
    async fn restaurar_tarea(&self, id_tarea: &str) -> AppResult<bool>;
    /// Vacía la papelera: borrado definitivo. Devuelve cuántas tareas se han borrado.
    async fn vaciar_papelera(&self) -> AppResult<i64>;
    /// Marca finalizada la asignación de un trabajador en una tarea. Error si no existe.
    async fn marcar_finalizada(&self, id_tarea: &str, id_trabajador: &str) -> AppResult<bool>;
}
