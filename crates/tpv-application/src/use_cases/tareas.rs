//! Casos de uso de tareas. Local-First: validan con el dominio e invocan el puerto.

use tpv_contracts::tareas::{
    CreateTareaInput, FinalizarTareaInput, MisTareasArgs, MisTareasRow, SetAsignacionesTareaInput,
    TareaAdminRow, TareaAsignadoRow, TareaIdArgs, TareaRow, TrabajadorUI, UpdateTareaInput,
};
use tpv_domain::tareas::{limpiar_opcional, normalizar_ids, requerido, TareaData};

use crate::error::{AppError, AppResult};
use crate::ports::tareas::TareasRepository;

/* Lecturas */

pub async fn get_trabajadores(repo: &dyn TareasRepository) -> AppResult<Vec<TrabajadorUI>> {
    repo.get_trabajadores().await
}

pub async fn get_tareas_admin(repo: &dyn TareasRepository) -> AppResult<Vec<TareaAdminRow>> {
    repo.get_tareas_admin().await
}

pub async fn get_tarea_by_id(
    repo: &dyn TareasRepository,
    args: TareaIdArgs,
) -> AppResult<Option<TareaRow>> {
    if args.id_tarea <= 0 {
        return Ok(None);
    }
    repo.get_tarea_by_id(args.id_tarea).await
}

pub async fn get_tarea_asignados(
    repo: &dyn TareasRepository,
    args: TareaIdArgs,
) -> AppResult<Vec<TareaAsignadoRow>> {
    if args.id_tarea <= 0 {
        return Ok(vec![]);
    }
    repo.get_tarea_asignados(args.id_tarea).await
}

pub async fn get_mis_tareas(
    repo: &dyn TareasRepository,
    args: MisTareasArgs,
) -> AppResult<Vec<MisTareasRow>> {
    if args.id_trabajador <= 0 {
        return Ok(vec![]);
    }
    repo.get_mis_tareas(args.id_trabajador).await
}

/* Escrituras */

pub async fn create_tarea(repo: &dyn TareasRepository, input: CreateTareaInput) -> AppResult<bool> {
    let titulo = requerido(&input.titulo, "titulo").map_err(AppError::validation)?;
    let ids_trabajadores = normalizar_ids(input.ids_trabajadores);

    if ids_trabajadores.is_empty() {
        return Err(AppError::validation("ids_trabajadores required"));
    }

    let data = TareaData {
        titulo,
        descripcion: limpiar_opcional(input.descripcion),
        fecha_limite: limpiar_opcional(input.fecha_limite),
    };

    repo.create_tarea(data, ids_trabajadores).await
}

pub async fn update_tarea(repo: &dyn TareasRepository, input: UpdateTareaInput) -> AppResult<bool> {
    if input.id_tarea <= 0 {
        return Err(AppError::validation("id_tarea required"));
    }

    let titulo = requerido(&input.titulo, "titulo").map_err(AppError::validation)?;

    let data = TareaData {
        titulo,
        descripcion: limpiar_opcional(input.descripcion),
        fecha_limite: limpiar_opcional(input.fecha_limite),
    };

    repo.update_tarea(input.id_tarea, data).await
}

pub async fn set_asignaciones(
    repo: &dyn TareasRepository,
    input: SetAsignacionesTareaInput,
) -> AppResult<bool> {
    if input.id_tarea <= 0 {
        return Err(AppError::validation("id_tarea required"));
    }

    repo.set_asignaciones(input.id_tarea, normalizar_ids(input.ids_trabajadores))
        .await
}

pub async fn delete_tarea(repo: &dyn TareasRepository, args: TareaIdArgs) -> AppResult<bool> {
    if args.id_tarea <= 0 {
        return Err(AppError::validation("id_tarea required"));
    }
    repo.delete_tarea(args.id_tarea).await
}

pub async fn marcar_finalizada(
    repo: &dyn TareasRepository,
    input: FinalizarTareaInput,
) -> AppResult<bool> {
    if input.id_tarea <= 0 || input.id_trabajador <= 0 {
        return Err(AppError::validation("id_tarea/id_trabajador required"));
    }
    repo.marcar_finalizada(input.id_tarea, input.id_trabajador).await
}
