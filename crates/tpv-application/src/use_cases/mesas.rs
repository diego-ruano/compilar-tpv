//! Casos de uso de mesas / salón / comandas / cocina. Local-First: validan/normalizan
//! e invocan el puerto. Las escrituras "OK" devuelven `()` (el comando mapea a "OK").

use std::collections::HashMap;

use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaBarraListItem, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, MesasAbrirComandaInput, MesasAddLineaComandaInput, MesasCerrarComandaInput,
    MesasCobrarDetallesInput, MesasCobrarVentaRapidaInput, MesasComandaSetTrabajadorInput,
    MesasCreateComandaBarraInput, MesasDeleteComandaBarraIfSafeInput, MesasDeleteDetalleInput,
    MesasGetOrCreateComandaBarraInput, MesasIdCategoriaArgs, MesasIdComandaArgs, MesasIdMesaArgs,
    MesasKitchenSetLineStateInput, MesasListComandasBarraArgs, MesasRemoveOnePendingDetalleInput,
    MesasSaveLayoutInput, MesasSearchProductosArgs, MesasSetReservaEstadoInput,
    MesasUpdateDetalleNotaInput, ProductoVendibleOut, SalonOut,
};
use tpv_domain::mesas::{
    limpiar_opcional, normalize_estado_cocina, normalize_metodo, requerido, AbrirComandaData,
    CobroDetalles, CobroVentaRapida,
};

use crate::error::{AppError, AppResult};
use crate::ports::mesas::MesasRepository;

/* Layout */

pub async fn save_layout(repo: &dyn MesasRepository, input: MesasSaveLayoutInput) -> AppResult<()> {
    repo.save_layout(input.salons).await
}

pub async fn load_layout(repo: &dyn MesasRepository) -> AppResult<Vec<SalonOut>> {
    repo.load_layout().await
}

pub async fn get_mesas_ocupadas(
    repo: &dyn MesasRepository,
) -> AppResult<HashMap<String, bool>> {
    repo.get_mesas_ocupadas().await
}

/* Reservas */

pub async fn set_reserva_estado(
    repo: &dyn MesasRepository,
    input: MesasSetReservaEstadoInput,
) -> AppResult<()> {
    let estado = requerido(&input.estado, "estado")
        .map_err(AppError::validation)?
        .to_uppercase();
    if input.id_reserva <= 0 {
        return Err(AppError::validation("ID_Reserva inválido"));
    }
    repo.set_reserva_estado(input.id_reserva, estado).await
}

/* Comandas de mesa */

pub async fn get_comanda_abierta_by_mesa(
    repo: &dyn MesasRepository,
    args: MesasIdMesaArgs,
) -> AppResult<Option<ComandaRow>> {
    if args.id_mesa <= 0 {
        return Ok(None);
    }
    repo.get_comanda_abierta_by_mesa(args.id_mesa).await
}

pub async fn abrir_comanda(
    repo: &dyn MesasRepository,
    input: MesasAbrirComandaInput,
) -> AppResult<Option<ComandaRow>> {
    if input.id_mesa <= 0 {
        return Err(AppError::validation("id_mesa inválido"));
    }
    let data = AbrirComandaData {
        id_mesa: input.id_mesa,
        id_trabajador_o_usuario: input.id_usuario.or(input.id_trabajador).filter(|n| *n > 0),
        id_reserva: input.id_reserva.filter(|n| *n > 0),
    };
    repo.abrir_comanda(data).await
}

pub async fn comanda_set_trabajador_if_null(
    repo: &dyn MesasRepository,
    input: MesasComandaSetTrabajadorInput,
) -> AppResult<bool> {
    if input.id_comanda <= 0 {
        return Ok(false);
    }
    let id = input.id_usuario.or(input.id_trabajador).filter(|n| *n > 0);
    repo.comanda_set_trabajador_if_null(input.id_comanda, id).await
}

pub async fn cerrar_comanda(
    repo: &dyn MesasRepository,
    input: MesasCerrarComandaInput,
) -> AppResult<()> {
    if input.id_comanda <= 0 {
        return Err(AppError::validation("id_comanda inválido"));
    }
    if !input.total.is_finite() || input.total < 0.0 {
        return Err(AppError::validation("total inválido"));
    }
    repo.cerrar_comanda(input.id_comanda, input.total).await
}

pub async fn get_lineas_comanda(
    repo: &dyn MesasRepository,
    args: MesasIdComandaArgs,
) -> AppResult<Vec<MesaLineaComandaRow>> {
    if args.id_comanda <= 0 {
        return Ok(vec![]);
    }
    repo.get_lineas_comanda(args.id_comanda).await
}

pub async fn add_linea_comanda(
    repo: &dyn MesasRepository,
    input: MesasAddLineaComandaInput,
) -> AppResult<()> {
    if input.id_comanda <= 0 || input.id_producto <= 0 {
        return Err(AppError::validation("id_comanda/id_producto inválidos"));
    }
    if !input.cantidad.is_finite() || input.cantidad <= 0.0 {
        return Err(AppError::validation("cantidad inválida"));
    }
    if !input.precio.is_finite() {
        return Err(AppError::validation("precio inválido"));
    }
    let id = input.id_usuario.or(input.id_trabajador).filter(|n| *n > 0);
    repo.add_linea_comanda(
        input.id_comanda,
        input.id_producto,
        input.cantidad,
        input.precio,
        id,
    )
    .await
}

/* Barra */

pub async fn get_or_create_mesa_barra(repo: &dyn MesasRepository) -> AppResult<i64> {
    repo.get_or_create_mesa_barra().await
}

pub async fn get_or_create_comanda_barra(
    repo: &dyn MesasRepository,
    input: MesasGetOrCreateComandaBarraInput,
) -> AppResult<i64> {
    repo.get_or_create_comanda_barra(input.id_trabajador.filter(|n| *n > 0))
        .await
}

pub async fn cobrar_venta_rapida(
    repo: &dyn MesasRepository,
    input: MesasCobrarVentaRapidaInput,
) -> AppResult<()> {
    let items: Vec<(i64, f64)> = input
        .items
        .into_iter()
        .filter(|it| it.producto_id > 0 && it.precio.is_finite())
        .map(|it| (it.producto_id, it.precio))
        .collect();

    let data = CobroVentaRapida {
        metodo: normalize_metodo(&input.metodo),
        items,
        id_usuario_cobrador: input.id_usuario_cobrador.filter(|n| *n > 0),
        id_trabajador_cobrador: input.id_trabajador_cobrador.filter(|n| *n > 0),
        id_comanda: input.id_comanda.filter(|n| *n > 0),
    };
    repo.cobrar_venta_rapida(data).await
}

pub async fn create_comanda_barra(
    repo: &dyn MesasRepository,
    input: MesasCreateComandaBarraInput,
) -> AppResult<i64> {
    repo.create_comanda_barra(input.id_trabajador.filter(|n| *n > 0))
        .await
}

pub async fn list_comandas_barra(
    repo: &dyn MesasRepository,
    args: MesasListComandasBarraArgs,
) -> AppResult<Vec<ComandaBarraListItem>> {
    let include_pagadas = args.include_pagadas.unwrap_or(false);
    let limit = args.limit.unwrap_or(50).clamp(1, 200);
    repo.list_comandas_barra(include_pagadas, limit).await
}

pub async fn delete_comanda_barra_if_safe(
    repo: &dyn MesasRepository,
    input: MesasDeleteComandaBarraIfSafeInput,
) -> AppResult<bool> {
    if input.id_comanda <= 0 {
        return Ok(false);
    }
    repo.delete_comanda_barra_if_safe(input.id_comanda).await
}

/* Meta + catálogo */

pub async fn mesas_meta_all(
    repo: &dyn MesasRepository,
) -> AppResult<HashMap<i64, MesaMetaOut>> {
    repo.mesas_meta_all().await
}

pub async fn list_categorias_vendibles(
    repo: &dyn MesasRepository,
) -> AppResult<Vec<CategoriaVendibleOut>> {
    repo.list_categorias_vendibles().await
}

pub async fn list_productos_by_categoria(
    repo: &dyn MesasRepository,
    args: MesasIdCategoriaArgs,
) -> AppResult<Vec<ProductoVendibleOut>> {
    repo.list_productos_by_categoria(args.id_categoria).await
}

pub async fn search_productos_by_nombre(
    repo: &dyn MesasRepository,
    args: MesasSearchProductosArgs,
) -> AppResult<Vec<ProductoVendibleOut>> {
    let q = args.q.or(args.query).or(args.texto).unwrap_or_default();
    repo.search_productos_by_nombre(q).await
}

/* Detalles (ticket) */

pub async fn remove_one_pending_detalle(
    repo: &dyn MesasRepository,
    input: MesasRemoveOnePendingDetalleInput,
) -> AppResult<()> {
    if input.id_comanda <= 0 || input.id_producto <= 0 {
        return Ok(());
    }
    repo.remove_one_pending_detalle(input.id_comanda, input.id_producto)
        .await
}

pub async fn delete_detalle(
    repo: &dyn MesasRepository,
    input: MesasDeleteDetalleInput,
) -> AppResult<()> {
    if input.id_detalle <= 0 {
        return Ok(());
    }
    repo.delete_detalle(input.id_detalle).await
}

pub async fn update_detalle_nota(
    repo: &dyn MesasRepository,
    input: MesasUpdateDetalleNotaInput,
) -> AppResult<()> {
    if input.id_detalle <= 0 {
        return Ok(());
    }
    repo.update_detalle_nota(input.id_detalle, limpiar_opcional(input.nota))
        .await
}

pub async fn cobrar_detalles(
    repo: &dyn MesasRepository,
    input: MesasCobrarDetallesInput,
) -> AppResult<()> {
    let mut ids = input.detalle_ids.clone();
    ids.sort_unstable();
    ids.dedup();
    ids.retain(|n| *n > 0);

    if input.id_comanda <= 0 || ids.is_empty() {
        return Ok(());
    }

    let metodo = requerido(&input.metodo, "metodo").map_err(AppError::validation)?;
    let tipo = requerido(&input.tipo, "tipo").map_err(AppError::validation)?;

    let data = CobroDetalles {
        id_comanda: input.id_comanda,
        metodo,
        tipo,
        detalle_ids: ids,
        id_usuario: input.id_usuario.filter(|n| *n > 0),
    };
    repo.cobrar_detalles(data).await
}

/* Cocina */

pub async fn kitchen_list_today_pending(
    repo: &dyn MesasRepository,
) -> AppResult<Vec<KitchenRow>> {
    repo.kitchen_list_today_pending().await
}

pub async fn kitchen_set_line_state(
    repo: &dyn MesasRepository,
    input: MesasKitchenSetLineStateInput,
) -> AppResult<()> {
    if input.id_detalle <= 0 {
        return Err(AppError::validation("ID_Detalle inválido"));
    }
    if input.id_usuario_cocinero <= 0 {
        return Err(AppError::validation("ID_Usuario_Cocinero inválido"));
    }
    let estado = normalize_estado_cocina(&input.estado);
    repo.kitchen_set_line_state(input.id_detalle, input.id_usuario_cocinero, estado)
        .await
}
