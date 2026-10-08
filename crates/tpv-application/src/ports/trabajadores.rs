//! Puerto de persistencia de trabajadores / horarios.

use async_trait::async_trait;

use tpv_contracts::trabajadores::{
    AsignacionRow, RolRow, TrabajadorDetailRow, TrabajadorRow, TurnoRow,
};
use tpv_domain::trabajadores::{
    AsignacionCambios, AsignacionNueva, TrabajadorCambios, TrabajadorNuevo,
};

use crate::error::AppResult;

#[async_trait]
pub trait TrabajadoresRepository: Send + Sync {
    /* Lecturas */
    async fn get_roles(&self) -> AppResult<Vec<RolRow>>;
    async fn get_all(&self) -> AppResult<Vec<TrabajadorRow>>;
    async fn get_detail(&self, id_trabajador: &str) -> AppResult<Option<TrabajadorDetailRow>>;
    async fn get_id_by_usuario(&self, id_usuario: &str) -> AppResult<Option<String>>;
    async fn turnos_get_all(&self) -> AppResult<Vec<TurnoRow>>;

    /* Alta / edición de trabajador (crea/actualiza Usuario + Trabajador) */
    async fn create_trabajador(&self, data: TrabajadorNuevo) -> AppResult<bool>;
    async fn update_trabajador(
        &self,
        id_trabajador: &str,
        cambios: TrabajadorCambios,
    ) -> AppResult<bool>;
    /// Asignaciones de la semana del lunes dado, rellenando con el horario
    /// predeterminado para semanas presentes/futuras (filas con `id_asignacion = 0`).
    async fn get_asignaciones_semana(&self, fecha_lunes: String) -> AppResult<Vec<AsignacionRow>>;

    /* Escrituras (Local-First, sin outbox) */
    async fn create_asignacion(&self, data: AsignacionNueva) -> AppResult<bool>;
    /// RI-85: sustituye el grupo completo; las asignaciones antiguas son grupos de un tramo.
    async fn guardar_asignacion(&self, id_asignacion: Option<String>, tramos: Vec<AsignacionNueva>) -> AppResult<bool>;
    async fn update_asignacion(
        &self,
        id_asignacion: &str,
        cambios: AsignacionCambios,
    ) -> AppResult<bool>;
    async fn delete_asignacion(&self, id_asignacion: &str) -> AppResult<bool>;
    /// Copia las asignaciones de una semana a otra (desplazando 7 días).
    async fn copy_semana(
        &self,
        from_monday: String,
        to_monday: String,
        overwrite: bool,
    ) -> AppResult<bool>;
    /// Fija el horario predeterminado a partir de las asignaciones de una semana.
    async fn set_predeterminado_desde_semana(&self, fecha_lunes: String) -> AppResult<bool>;
}
