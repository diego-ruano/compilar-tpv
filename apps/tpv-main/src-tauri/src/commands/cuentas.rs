//! Comandos Tauri de cuentas/caja (capa fina hexagonal).
//!
//! RI-70: cobros/devoluciones exigen `cuentas.cobros`; gastos, totales y correcciones de
//! pagos, `cuentas.gastos`. Los cierres tienen su capacidad propia (`caja.cerrar`).
//! El gate se comprueba en Rust con las concesiones vigentes; la interfaz refleja esas capacidades.
//!
//! CAJA-01: los que tocan un apunte ya no se niegan por fecha. Pasan por `rectificacion_caja`, que
//! rectifica el cierre ya hecho al que pertenezca el apunte. El aviso previo lo pide la pantalla con
//! `cuentas_previsualizar_cambio`, y el motivo llega aparte (`motivo_rectificacion`) porque no es un
//! dato del apunte: es de la corrección.

use tauri::State;

use tpv_application::use_cases::cuentas as uc;
use tpv_application::use_cases::rectificacion_caja as rect;
use tpv_contracts::cierre_caja::{CambioCajaInput, ImpactoCajaDto};
use tpv_contracts::cuentas::{
    AnulacionPagoDto, AnularPagoInput, CobroDevolubleDto, CreateGastoInput, CuentasRangoArgs, DeleteGastoInput,
    DevolucionDto, DevolverLineasInput, PaginaEntradas, PaginaSalidas, ResumenCajaDto,
    UpdateGastoInput, UpdatePagoInput,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

#[tauri::command]
#[specta::specta]
pub async fn cuentas_get_entradas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<PaginaEntradas, AppErrorDto> {
    state.exigir_permiso("cuentas.cobros").await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_entradas(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cuentas_get_salidas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<PaginaSalidas, AppErrorDto> {
    state.exigir_permiso("cuentas.gastos").await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_salidas(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cuentas_get_resumen(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<ResumenCajaDto, AppErrorDto> {
    state.exigir_permiso("cuentas.gastos").await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::get_resumen(repo.as_ref(), args).await?)
}

/// A qué cierres ya hechos afectaría un cambio y cómo quedarían. No toca nada.
///
/// El de una baja lo pide también el camarero, porque la pantalla lo enseña antes de darla; el
/// resto de cambios son del administrador.
#[tauri::command]
#[specta::specta]
pub async fn cuentas_previsualizar_cambio(
    state: State<'_, AppState>,
    args: CambioCajaInput,
) -> Result<ImpactoCajaDto, AppErrorDto> {
    match args {
        CambioCajaInput::AnularPago { .. } => state.exigir_permiso("cuentas.cobros").await?,
        _ => state.exigir_permiso("cuentas.gastos").await?,
    };
    let cierres = state.cierre_caja_repo().await?;
    Ok(rect::previsualizar(cierres.as_ref(), &args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cuentas_create_gasto(
    state: State<'_, AppState>,
    args: CreateGastoInput,
    motivo_rectificacion: Option<String>,
) -> Result<bool, AppErrorDto> {
    // Quién registra el gasto sale de la sesión: va al historial de caja (CUENTA-07).
    let sesion = state.exigir_permiso("cuentas.gastos").await?;
    let cuentas = state.cuentas_repo().await?;
    let cierres = state.cierre_caja_repo().await?;
    Ok(rect::crear_gasto(
        cuentas.as_ref(),
        cierres.as_ref(),
        &sesion.id_usuario,
        args,
        motivo_rectificacion,
    )
    .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cuentas_update_gasto(
    state: State<'_, AppState>,
    args: UpdateGastoInput,
    motivo_rectificacion: Option<String>,
) -> Result<bool, AppErrorDto> {
    let sesion = state.exigir_permiso("cuentas.gastos").await?;
    let cuentas = state.cuentas_repo().await?;
    let cierres = state.cierre_caja_repo().await?;
    Ok(rect::editar_gasto(
        cuentas.as_ref(),
        cierres.as_ref(),
        &sesion.id_usuario,
        args,
        motivo_rectificacion,
    )
    .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cuentas_delete_gasto(
    state: State<'_, AppState>,
    args: DeleteGastoInput,
    motivo_rectificacion: Option<String>,
) -> Result<bool, AppErrorDto> {
    let sesion = state.exigir_permiso("cuentas.gastos").await?;
    let cuentas = state.cuentas_repo().await?;
    let cierres = state.cierre_caja_repo().await?;
    Ok(rect::borrar_gasto(
        cuentas.as_ref(),
        cierres.as_ref(),
        &sesion.id_usuario,
        args,
        motivo_rectificacion,
    )
    .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn cuentas_update_pago(
    state: State<'_, AppState>,
    args: UpdatePagoInput,
    motivo_rectificacion: Option<String>,
) -> Result<bool, AppErrorDto> {
    let sesion = state.exigir_permiso("cuentas.gastos").await?;
    let cuentas = state.cuentas_repo().await?;
    let cierres = state.cierre_caja_repo().await?;
    Ok(rect::editar_pago(
        cuentas.as_ref(),
        cierres.as_ref(),
        &sesion.id_usuario,
        args,
        motivo_rectificacion,
    )
    .await?)
}

/// Las líneas de un cobro con lo que queda por devolver de cada una: lo que enseña la pantalla
/// de devolver.
#[tauri::command]
#[specta::specta]
pub async fn cuentas_lineas_devolubles(
    state: State<'_, AppState>,
    id_pago: String,
) -> Result<CobroDevolubleDto, AppErrorDto> {
    state.exigir_permiso("cuentas.cobros").await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::lineas_devolubles(repo.as_ref(), &id_pago).await?)
}

/// Devuelve parte de un cobro: unas líneas, o unas unidades de una línea (`docs/arquitectura/caja.md`).
///
/// Quién devuelve sale de la **sesión** (SEC-01), como al anular. No pasa por la rectificación de
/// cierres: la devolución cae ahora, en el periodo abierto, que es donde sale el dinero.
#[tauri::command]
#[specta::specta]
pub async fn cuentas_devolver_lineas(
    state: State<'_, AppState>,
    args: DevolverLineasInput,
) -> Result<DevolucionDto, AppErrorDto> {
    let sesion = state.exigir_permiso("cuentas.cobros").await?;
    let repo = state.cuentas_repo().await?;
    Ok(uc::devolver_lineas(repo.as_ref(), &sesion.id_usuario, args).await?)
}

/// Anula un cobro (CUENTA-07). Antes lo borraba, y ése era el agujero: el arqueo calcula
/// `esperado = fondo + cobros en efectivo`, así que borrar la fila de una venta en efectivo bajaba
/// el esperado exactamente lo mismo que faltaba en el cajón y el descuadre salía cero.
///
/// Quién anula sale de la **sesión** (SEC-01) y nunca del input: una anulación firmada con el
/// nombre que le pase la pantalla es una auditoría que da confianza sin merecerla.
///
/// La hace también el camarero, las dos clases: el cliente que vuelve a por su dinero no espera
/// al encargado, y lo que deja rastro es la firma de la sesión, no el rol.
#[tauri::command]
#[specta::specta]
pub async fn cuentas_anular_pago(
    state: State<'_, AppState>,
    args: AnularPagoInput,
) -> Result<AnulacionPagoDto, AppErrorDto> {
    let sesion = state.exigir_permiso("cuentas.cobros").await?;
    let cuentas = state.cuentas_repo().await?;
    let cierres = state.cierre_caja_repo().await?;
    Ok(rect::anular_pago(cuentas.as_ref(), cierres.as_ref(), &sesion.id_usuario, args).await?)
}

