//! Casos de uso de trabajadores / horarios. Local-First: validan con el dominio
//! e invocan el puerto.

use tpv_contracts::trabajadores::{
    AsignacionCreateInput, AsignacionDeleteInput, AsignacionRow, AsignacionUpdateInput,
    CopySemanaInput, HorariosSemanaArgs, RolRow, SetPredeterminadoInput, TrabajadorCreateInput,
    TrabajadorDetailArgs, TrabajadorDetailRow, TrabajadorIdByUsuarioArgs, TrabajadorRow,
    TrabajadorUpdateInput, TurnoRow,
};
use tpv_domain::trabajadores::{
    limpiar_opcional, normalizar_estado, requerido, AsignacionCambios, AsignacionNueva,
    TrabajadorCambios, TrabajadorNuevo,
};

use crate::error::{AppError, AppResult};
use crate::ports::trabajadores::TrabajadoresRepository;

/* Lecturas */

pub async fn get_roles(repo: &dyn TrabajadoresRepository) -> AppResult<Vec<RolRow>> {
    repo.get_roles().await
}

pub async fn get_all(repo: &dyn TrabajadoresRepository) -> AppResult<Vec<TrabajadorRow>> {
    repo.get_all().await
}

pub async fn get_detail(
    repo: &dyn TrabajadoresRepository,
    args: TrabajadorDetailArgs,
) -> AppResult<Option<TrabajadorDetailRow>> {
    if args.id_trabajador <= 0 {
        return Err(AppError::validation("id_trabajador required"));
    }
    repo.get_detail(args.id_trabajador).await
}

pub async fn get_trabajador_id_by_usuario(
    repo: &dyn TrabajadoresRepository,
    args: TrabajadorIdByUsuarioArgs,
) -> AppResult<Option<i64>> {
    if args.id_usuario <= 0 {
        return Ok(None);
    }
    repo.get_id_by_usuario(args.id_usuario).await
}

pub async fn turnos_get_all(repo: &dyn TrabajadoresRepository) -> AppResult<Vec<TurnoRow>> {
    repo.turnos_get_all().await
}

pub async fn get_asignaciones_semana(
    repo: &dyn TrabajadoresRepository,
    args: HorariosSemanaArgs,
) -> AppResult<Vec<AsignacionRow>> {
    let fecha_lunes = requerido(&args.fecha_lunes, "fecha_lunes").map_err(AppError::validation)?;
    repo.get_asignaciones_semana(fecha_lunes).await
}

/* Escrituras */

pub async fn create_asignacion(
    repo: &dyn TrabajadoresRepository,
    input: AsignacionCreateInput,
) -> AppResult<bool> {
    if input.id_trabajador <= 0 || input.id_turno <= 0 {
        return Err(AppError::validation("id_trabajador/id_turno required"));
    }

    let fecha = requerido(&input.fecha, "fecha").map_err(AppError::validation)?;
    let area = requerido(&input.area, "area").map_err(AppError::validation)?;

    let data = AsignacionNueva {
        id_trabajador: input.id_trabajador,
        fecha,
        id_turno: input.id_turno,
        area,
        hora_inicio: limpiar_opcional(input.hora_inicio),
        hora_fin: limpiar_opcional(input.hora_fin),
        notas: limpiar_opcional(input.notas),
    };

    repo.create_asignacion(data).await
}

pub async fn update_asignacion(
    repo: &dyn TrabajadoresRepository,
    input: AsignacionUpdateInput,
) -> AppResult<bool> {
    if input.id_asignacion <= 0 || input.id_turno <= 0 {
        return Err(AppError::validation("id_asignacion/id_turno required"));
    }

    let area = requerido(&input.area, "area").map_err(AppError::validation)?;

    let cambios = AsignacionCambios {
        id_turno: input.id_turno,
        area,
        hora_inicio: limpiar_opcional(input.hora_inicio),
        hora_fin: limpiar_opcional(input.hora_fin),
        notas: limpiar_opcional(input.notas),
    };

    repo.update_asignacion(input.id_asignacion, cambios).await
}

pub async fn delete_asignacion(
    repo: &dyn TrabajadoresRepository,
    input: AsignacionDeleteInput,
) -> AppResult<bool> {
    if input.id_asignacion <= 0 {
        return Err(AppError::validation("id_asignacion required"));
    }
    repo.delete_asignacion(input.id_asignacion).await
}

pub async fn copy_semana_asignaciones(
    repo: &dyn TrabajadoresRepository,
    input: CopySemanaInput,
) -> AppResult<bool> {
    let from_monday = requerido(&input.from_monday, "from_monday").map_err(AppError::validation)?;
    let to_monday = requerido(&input.to_monday, "to_monday").map_err(AppError::validation)?;
    let overwrite = input.overwrite.unwrap_or(true);

    repo.copy_semana(from_monday, to_monday, overwrite).await
}

pub async fn set_predeterminado_desde_semana(
    repo: &dyn TrabajadoresRepository,
    input: SetPredeterminadoInput,
) -> AppResult<bool> {
    let fecha_lunes = requerido(&input.fecha_lunes, "fecha_lunes").map_err(AppError::validation)?;
    repo.set_predeterminado_desde_semana(fecha_lunes).await
}

/* Alta / edición de trabajador */

pub async fn create_trabajador(
    repo: &dyn TrabajadoresRepository,
    input: TrabajadorCreateInput,
) -> AppResult<bool> {
    if input.id_rol <= 0 {
        return Err(AppError::validation("id_rol required"));
    }

    let email = requerido(&input.email, "email").map_err(AppError::validation)?;
    let password_hash =
        requerido(&input.password_hash, "password_hash").map_err(AppError::validation)?;
    let nombre = requerido(&input.nombre, "nombre").map_err(AppError::validation)?;

    let data = TrabajadorNuevo {
        id_rol: input.id_rol,
        email,
        password_hash,
        nombre,
        apellido: limpiar_opcional(input.apellido),
        estado: normalizar_estado(&input.estado),
        dni: limpiar_opcional(input.dni),
        telefono: limpiar_opcional(input.telefono),
        puesto: limpiar_opcional(input.puesto),
        iban: limpiar_opcional(input.iban),
        numero_seguridad_social: limpiar_opcional(input.numero_seguridad_social),
        fecha_inicio_contrato: limpiar_opcional(input.fecha_inicio_contrato),
        fecha_fin_contrato: limpiar_opcional(input.fecha_fin_contrato),
    };

    repo.create_trabajador(data).await
}

pub async fn update_trabajador(
    repo: &dyn TrabajadoresRepository,
    input: TrabajadorUpdateInput,
) -> AppResult<bool> {
    if input.id_trabajador <= 0 || input.id_usuario <= 0 || input.id_rol <= 0 {
        return Err(AppError::validation(
            "id_trabajador/id_usuario/id_rol required",
        ));
    }

    let email = requerido(&input.email, "email").map_err(AppError::validation)?;
    let nombre = requerido(&input.nombre, "nombre").map_err(AppError::validation)?;

    let cambios = TrabajadorCambios {
        id_usuario: input.id_usuario,
        id_rol: input.id_rol,
        email,
        nombre,
        apellido: limpiar_opcional(input.apellido),
        estado: normalizar_estado(&input.estado),
        dni: limpiar_opcional(input.dni),
        telefono: limpiar_opcional(input.telefono),
        puesto: limpiar_opcional(input.puesto),
        iban: limpiar_opcional(input.iban),
        numero_seguridad_social: limpiar_opcional(input.numero_seguridad_social),
        fecha_inicio_contrato: limpiar_opcional(input.fecha_inicio_contrato),
        fecha_fin_contrato: limpiar_opcional(input.fecha_fin_contrato),
        password_hash: limpiar_opcional(input.password_hash),
    };

    repo.update_trabajador(input.id_trabajador, cambios).await
}
