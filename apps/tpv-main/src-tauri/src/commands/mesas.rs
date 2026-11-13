//! Comandos Tauri de mesas / salón / comandas / cocina (capa fina hexagonal).
//! Local-First: sin op_id ni outbox. Nombres de invoke idénticos al monolito previo.

use std::collections::HashMap;

use tauri::State;

use tpv_application::use_cases::mesas as uc;
use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaConLineasOut, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, MesasAbrirComandaInput, MesasAddLineaComandaInput, MesasCobrarDetallesInput, MesasComandaSetReservaInput, MesasComandaSetTrabajadorInput,
    MesasDeleteDetalleInput,
    MesasIdCategoriaArgs, MesasIdComandaArgs, MesasIdMesaArgs,
    MesasKitchenSetLineStateInput, MesasRemoveOnePendingDetalleInput,
    MesasSaveLayoutInput, MesasSearchProductosArgs, MesasSetReservaEstadoInput,
    MesasUpdateDetalleNotaInput, ProductoVendibleOut, SalonOut,
};
use crate::AppState;
use tpv_contracts::errors::AppErrorDto;

/* ===== LAYOUT ===== */

#[tauri::command]
#[specta::specta]
pub async fn save_layout(
    state: State<'_, AppState>,
    args: MesasSaveLayoutInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("plano.gestionar").await?;
    let repo = state.mesas_repo().await?;
    uc::save_layout(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn load_layout(state: State<'_, AppState>) -> Result<Vec<SalonOut>, AppErrorDto> {
    let repo = state.mesas_repo().await?;
    Ok(uc::load_layout(repo.as_ref()).await?)
}

/* ===== RESERVAS ===== */

#[tauri::command]
#[specta::specta]
pub async fn set_reserva_estado(
    state: State<'_, AppState>,
    args: MesasSetReservaEstadoInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("reservas.gestionar").await?;
    let repo = state.mesas_repo().await?;
    uc::set_reserva_estado(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

/* ===== COMANDAS (mesa) ===== */

#[tauri::command]
#[specta::specta]
pub async fn get_comanda_abierta_by_mesa(
    state: State<'_, AppState>,
    args: MesasIdMesaArgs,
) -> Result<Option<ComandaRow>, AppErrorDto> {
    let repo = state.mesas_repo().await?;
    Ok(uc::get_comanda_abierta_by_mesa(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn abrir_comanda(
    state: State<'_, AppState>,
    mut args: MesasAbrirComandaInput,
) -> Result<Option<ComandaRow>, AppErrorDto> {
    // RI-28: la atribución procede de la sesión del backend.
    let sesion = state.exigir_permiso("servicio.vender").await?;
    args.id_usuario = Some(sesion.id_usuario);
    args.id_trabajador = sesion.id_trabajador;
    let repo = state.mesas_repo().await?;
    Ok(uc::abrir_comanda(repo.as_ref(), args).await?)
}

/// Abrir o retomar la mesa: su comanda abierta (creada si no hay ninguna, con el trabajador de la
/// sesión si le faltaba) y sus líneas, en un paso. Es lo que pide la pantalla de la mesa al
/// abrirse; en la Handy, un viaje en vez de cuatro.
#[tauri::command]
#[specta::specta]
pub async fn mesas_abrir_o_retomar(
    state: State<'_, AppState>,
    mut args: MesasAbrirComandaInput,
) -> Result<ComandaConLineasOut, AppErrorDto> {
    // RI-28: la atribución procede de la sesión del backend.
    let sesion = state.exigir_permiso("servicio.vender").await?;
    args.id_usuario = Some(sesion.id_usuario);
    args.id_trabajador = sesion.id_trabajador;
    let repo = state.mesas_repo().await?;
    Ok(uc::abrir_o_retomar(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn comanda_set_trabajador_if_null(
    state: State<'_, AppState>,
    mut args: MesasComandaSetTrabajadorInput,
) -> Result<bool, AppErrorDto> {
    // RI-28: la atribución procede de la sesión del backend.
    let sesion = state.exigir_permiso("servicio.vender").await?;
    args.id_usuario = Some(sesion.id_usuario);
    args.id_trabajador = sesion.id_trabajador;
    let repo = state.mesas_repo().await?;
    Ok(uc::comanda_set_trabajador_if_null(repo.as_ref(), args).await?)
}

/// INC-20261030-007: lo pide el modal de la mesa al marcar la llegada, si el camarero dice que la
/// cuenta que ya estaba abierta es de los clientes de la reserva.
#[tauri::command]
#[specta::specta]
pub async fn comanda_set_reserva_if_null(
    state: State<'_, AppState>,
    args: MesasComandaSetReservaInput,
) -> Result<bool, AppErrorDto> {
    state.exigir_permiso("servicio.vender").await?;
    let repo = state.mesas_repo().await?;
    Ok(uc::comanda_set_reserva_if_null(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_lineas_comanda(
    state: State<'_, AppState>,
    args: MesasIdComandaArgs,
) -> Result<Vec<MesaLineaComandaRow>, AppErrorDto> {
    let repo = state.mesas_repo().await?;
    Ok(uc::get_lineas_comanda(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn add_linea_comanda(
    state: State<'_, AppState>,
    mut args: MesasAddLineaComandaInput,
) -> Result<Vec<MesaLineaComandaRow>, AppErrorDto> {
    // RI-28: la atribución procede de la sesión del backend.
    let sesion = state.exigir_permiso("servicio.vender").await?;
    args.id_usuario = Some(sesion.id_usuario);
    args.id_trabajador = sesion.id_trabajador;
    let repo = state.mesas_repo().await?;
    Ok(uc::add_linea_comanda(repo.as_ref(), args).await?)
}

/* ===== BARRA ===== */

/* ===== META + CATÁLOGO ===== */

#[tauri::command]
#[specta::specta]
pub async fn mesas_meta_all(
    state: State<'_, AppState>,
) -> Result<HashMap<String, MesaMetaOut>, AppErrorDto> {
    let repo = state.mesas_repo().await?;
    Ok(uc::mesas_meta_all(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn list_categorias_vendibles(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaVendibleOut>, AppErrorDto> {
    let repo = state.mesas_repo().await?;
    Ok(uc::list_categorias_vendibles(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn list_productos_by_categoria(
    state: State<'_, AppState>,
    args: MesasIdCategoriaArgs,
) -> Result<Vec<ProductoVendibleOut>, AppErrorDto> {
    let repo = state.mesas_repo().await?;
    Ok(uc::list_productos_by_categoria(repo.as_ref(), args).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn search_productos_by_nombre(
    state: State<'_, AppState>,
    args: MesasSearchProductosArgs,
) -> Result<Vec<ProductoVendibleOut>, AppErrorDto> {
    let repo = state.mesas_repo().await?;
    Ok(uc::search_productos_by_nombre(repo.as_ref(), args).await?)
}

/* ===== TICKET (detalles) ===== */

#[tauri::command]
#[specta::specta]
pub async fn remove_one_pending_detalle(
    state: State<'_, AppState>,
    args: MesasRemoveOnePendingDetalleInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("servicio.vender").await?;
    let repo = state.mesas_repo().await?;
    uc::remove_one_pending_detalle(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_detalle(
    state: State<'_, AppState>,
    args: MesasDeleteDetalleInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("servicio.vender").await?;
    let repo = state.mesas_repo().await?;
    uc::delete_detalle(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn update_detalle_nota(
    state: State<'_, AppState>,
    args: MesasUpdateDetalleNotaInput,
) -> Result<String, AppErrorDto> {
    state.exigir_permiso("servicio.vender").await?;
    let repo = state.mesas_repo().await?;
    uc::update_detalle_nota(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn cobrar_detalles(
    state: State<'_, AppState>,
    args: MesasCobrarDetallesInput,
) -> Result<String, AppErrorDto> {
    // REV-17: quién cobra sale de la sesión. Ver `cobrar_venta_rapida`.
    let sesion = state.exigir_permiso("servicio.vender").await?;
    let repo = state.mesas_repo().await?;
    // Devuelve el id del pago: con él la pantalla pide su ticket (RI-29).
    Ok(uc::cobrar_detalles(repo.as_ref(), &sesion.id_usuario, args).await?)
}

/* ===== COCINA ===== */

#[tauri::command]
#[specta::specta]
pub async fn kitchen_list_today_pending(
    state: State<'_, AppState>,
) -> Result<Vec<KitchenRow>, AppErrorDto> {
    state.exigir_permiso("servicio.cocina").await?;
    let repo = state.mesas_repo().await?;
    Ok(uc::kitchen_list_today_pending(repo.as_ref()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn kitchen_set_line_state(
    state: State<'_, AppState>,
    mut args: MesasKitchenSetLineStateInput,
) -> Result<String, AppErrorDto> {
    // RI-28: la atribución procede de la sesión del backend.
    let sesion = state.exigir_permiso("servicio.cocina").await?;
    args.id_usuario_cocinero = sesion.id_usuario;
    let repo = state.mesas_repo().await?;
    uc::kitchen_set_line_state(repo.as_ref(), args).await?;
    Ok("OK".to_string())
}
