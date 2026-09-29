//! Comandos Tauri de venta rápida (barra). Capa fina hexagonal. Local-First: sin op_id ni outbox.

use tauri::State;

use tpv_application::use_cases::venta_rapida as uc;
use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow, VerTicketsDetalleRow,
    VrAddLineaComandaInput, VrCobrarFraccionadoInput, VrCreateComandaBarraInput,
    VrDeleteComandaIfSafeInput, VrDeleteLineaIfUnpaidInput, VrIdCategoriaArgs, VrIdComandaArgs,
    VrIdsArgs, VrListComandasArgs, VrRemoveLastUnpaidLineaInput,
    VrSearchProductosArgs, VrUpdateNotaDetalleInput,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/* Lecturas */

#[tauri::command]
pub async fn vr_list_categorias_vendibles(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaRow>, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::list_categorias_vendibles(repo.as_ref()).await?)
}

#[tauri::command]
pub async fn vr_list_productos_by_categoria(
    state: State<'_, AppState>,
    args: VrIdCategoriaArgs,
) -> Result<Vec<ProductoRow>, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::list_productos_by_categoria(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_search_productos(
    state: State<'_, AppState>,
    args: VrSearchProductosArgs,
) -> Result<Vec<ProductoRow>, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::search_productos(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_list_comandas_barra(
    state: State<'_, AppState>,
    args: VrListComandasArgs,
) -> Result<Vec<ComandaBarraRow>, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::list_comandas_barra(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_get_lineas_comanda(
    state: State<'_, AppState>,
    args: VrIdComandaArgs,
) -> Result<Vec<LineaComandaRow>, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::get_lineas_comanda(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_get_index_rows(
    state: State<'_, AppState>,
    args: VrIdsArgs,
) -> Result<Vec<IndexRow>, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::get_index_rows(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_get_detalles_ver_ticket(
    state: State<'_, AppState>,
    args: VrIdComandaArgs,
) -> Result<Vec<VerTicketsDetalleRow>, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::get_detalles_ver_ticket(repo.as_ref(), args).await?)
}

/* Escrituras */

#[tauri::command]
pub async fn vr_create_comanda_barra(
    state: State<'_, AppState>,
    args: VrCreateComandaBarraInput,
) -> Result<String, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::create_comanda_barra(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_add_linea_comanda(
    state: State<'_, AppState>,
    args: VrAddLineaComandaInput,
) -> Result<String, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::add_linea_comanda(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_remove_last_unpaid_linea(
    state: State<'_, AppState>,
    args: VrRemoveLastUnpaidLineaInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::remove_last_unpaid_linea(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_delete_linea_if_unpaid(
    state: State<'_, AppState>,
    args: VrDeleteLineaIfUnpaidInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::delete_linea_if_unpaid(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_update_nota_detalle(
    state: State<'_, AppState>,
    args: VrUpdateNotaDetalleInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::update_nota_detalle(repo.as_ref(), args).await?)
}

#[tauri::command]
pub async fn vr_cobrar_fraccionado(
    state: State<'_, AppState>,
    args: VrCobrarFraccionadoInput,
) -> Result<String, AppErrorDto> {
    // REV-17: quién cobra sale de aquí y no del input. Sin rol: cobrar lo hace cualquiera a mitad
    // de servicio, como abrir el cajón — lo que hace falta es estar identificado.
    //
    // Un cobro que se reintenta desde la cola de la pantalla tras un cierre inesperado queda a
    // nombre de quien tenga la sesión abierta cuando por fin entre — y es el mismo: esa cola se
    // guarda bajo una clave de `localStorage` que ya lleva dentro el usuario y el trabajador
    // (`PENDING_COBROS_STORAGE_PREFIX`), así que nadie drena los intents de otro.
    let sesion = state.sesion().await?;
    let repo = state.venta_rapida_repo().await?;
    // Devuelve el número de ticket del cobro: es lo que el POS imprime a continuación.
    Ok(uc::cobrar_fraccionado(
        repo.as_ref(),
        &sesion.id_usuario,
        sesion.id_trabajador.as_deref(),
        args,
    )
    .await?)
}

#[tauri::command]
pub async fn vr_delete_comanda_if_safe(
    state: State<'_, AppState>,
    args: VrDeleteComandaIfSafeInput,
) -> Result<bool, AppErrorDto> {
    let repo = state.venta_rapida_repo().await?;
    Ok(uc::delete_comanda_if_safe(repo.as_ref(), args).await?)
}
