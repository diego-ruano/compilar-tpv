//! Casos de uso de venta rápida (barra). Local-First: validan/normalizan e invocan el puerto.

use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow, StockLinea,
    VerTicketsDetalleRow, VrAddLineaComandaInput, VrCobrarFraccionadoInput,
    VrCreateComandaBarraInput, VrDeleteComandaIfSafeInput, VrDeleteLineaIfUnpaidInput,
    VrIdCategoriaArgs, VrIdComandaArgs, VrIdsArgs, VrListComandasArgs,
    VrRemoveLastUnpaidLineaInput, VrRestarStockInput, VrSearchProductosArgs,
    VrUpdateNotaDetalleInput,
};
use tpv_domain::venta_rapida::{limpiar_opcional, normalize_metodo, CobroFraccionado};

use crate::error::{AppError, AppResult};
use crate::ports::venta_rapida::VentaRapidaRepository;

/* Lecturas */

pub async fn list_categorias_vendibles(
    repo: &dyn VentaRapidaRepository,
) -> AppResult<Vec<CategoriaRow>> {
    repo.list_categorias_vendibles().await
}

pub async fn list_productos_by_categoria(
    repo: &dyn VentaRapidaRepository,
    args: VrIdCategoriaArgs,
) -> AppResult<Vec<ProductoRow>> {
    if args.id_categoria <= 0 {
        return Ok(vec![]);
    }
    repo.list_productos_by_categoria(args.id_categoria).await
}

pub async fn search_productos(
    repo: &dyn VentaRapidaRepository,
    args: VrSearchProductosArgs,
) -> AppResult<Vec<ProductoRow>> {
    let q = args.query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let lim = if args.limit <= 0 { 60 } else { args.limit };
    repo.search_productos(q, lim).await
}

pub async fn list_comandas_barra(
    repo: &dyn VentaRapidaRepository,
    args: VrListComandasArgs,
) -> AppResult<Vec<ComandaBarraRow>> {
    repo.list_comandas_barra(args.include_pagadas, args.limit).await
}

pub async fn get_lineas_comanda(
    repo: &dyn VentaRapidaRepository,
    args: VrIdComandaArgs,
) -> AppResult<Vec<LineaComandaRow>> {
    if args.id_comanda <= 0 {
        return Ok(vec![]);
    }
    repo.get_lineas_comanda(args.id_comanda).await
}

pub async fn get_index_rows(
    repo: &dyn VentaRapidaRepository,
    args: VrIdsArgs,
) -> AppResult<Vec<IndexRow>> {
    let ids: Vec<i64> = args.ids.into_iter().filter(|n| *n > 0).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    repo.get_index_rows(ids).await
}

pub async fn get_detalles_ver_ticket(
    repo: &dyn VentaRapidaRepository,
    args: VrIdComandaArgs,
) -> AppResult<Vec<VerTicketsDetalleRow>> {
    if args.id_comanda <= 0 {
        return Ok(vec![]);
    }
    repo.get_detalles_ver_ticket(args.id_comanda).await
}

/* Escrituras */

pub async fn create_comanda_barra(
    repo: &dyn VentaRapidaRepository,
    input: VrCreateComandaBarraInput,
) -> AppResult<i64> {
    let id_trabajador = input.id_trabajador.filter(|n| *n > 0);
    let get_or_create = input.get_or_create.unwrap_or(false);
    repo.create_comanda_barra(id_trabajador, get_or_create).await
}

pub async fn add_linea_comanda(
    repo: &dyn VentaRapidaRepository,
    input: VrAddLineaComandaInput,
) -> AppResult<i64> {
    if input.id_comanda <= 0
        || input.id_producto <= 0
        || !input.cantidad.is_finite()
        || input.cantidad <= 0.0
    {
        return Err(AppError::validation("id_comanda/id_producto/cantidad invalid"));
    }
    if !input.precio_unitario.is_finite() {
        return Err(AppError::validation("precio_unitario invalid"));
    }
    repo.add_linea_comanda(
        input.id_comanda,
        input.id_producto,
        input.cantidad,
        input.precio_unitario,
    )
    .await
}

pub async fn remove_last_unpaid_linea(
    repo: &dyn VentaRapidaRepository,
    input: VrRemoveLastUnpaidLineaInput,
) -> AppResult<bool> {
    if input.id_comanda <= 0 || input.id_producto <= 0 {
        return Err(AppError::validation("id_comanda/id_producto invalid"));
    }
    repo.remove_last_unpaid_linea(input.id_comanda, input.id_producto).await
}

pub async fn delete_linea_if_unpaid(
    repo: &dyn VentaRapidaRepository,
    input: VrDeleteLineaIfUnpaidInput,
) -> AppResult<bool> {
    if input.id_comanda <= 0 || input.id_detalle <= 0 {
        return Err(AppError::validation("id_comanda/id_detalle invalid"));
    }
    repo.delete_linea_if_unpaid(input.id_comanda, input.id_detalle).await
}

pub async fn update_nota_detalle(
    repo: &dyn VentaRapidaRepository,
    input: VrUpdateNotaDetalleInput,
) -> AppResult<bool> {
    if input.id_detalle <= 0 {
        return Err(AppError::validation("id_detalle invalid"));
    }
    repo.update_nota_detalle(input.id_detalle, limpiar_opcional(input.nota)).await
}

pub async fn cobrar_fraccionado(
    repo: &dyn VentaRapidaRepository,
    input: VrCobrarFraccionadoInput,
) -> AppResult<bool> {
    if input.id_comanda <= 0 {
        return Err(AppError::validation("id_comanda invalid"));
    }
    if !input.importe_total.is_finite() || input.importe_total < 0.0 {
        return Err(AppError::validation("importe_total invalid"));
    }

    let mut detalles: Vec<i64> = input.detalles.iter().copied().filter(|d| *d > 0).collect();
    detalles.sort_unstable();
    detalles.dedup();

    if detalles.is_empty() {
        return Err(AppError::validation("detalles required"));
    }

    let data = CobroFraccionado {
        id_comanda: input.id_comanda,
        metodo: normalize_metodo(&input.metodo),
        importe_total: input.importe_total,
        id_usuario_cobrador: input.id_usuario_cobrador.filter(|n| *n > 0),
        id_trabajador_cobrador: input.id_trabajador_cobrador.filter(|n| *n > 0),
        detalles,
    };

    repo.cobrar_fraccionado(data).await
}

pub async fn restar_stock(
    repo: &dyn VentaRapidaRepository,
    input: VrRestarStockInput,
) -> AppResult<bool> {
    let mut norm: Vec<StockLinea> = input
        .lineas
        .into_iter()
        .filter(|it| it.producto_id > 0 && it.cantidad.is_finite() && it.cantidad > 0.0)
        .collect();

    norm.sort_by(|a, b| a.producto_id.cmp(&b.producto_id));

    let mut merged: Vec<StockLinea> = Vec::new();
    for item in norm {
        if let Some(last) = merged.last_mut() {
            if last.producto_id == item.producto_id {
                last.cantidad += item.cantidad;
                continue;
            }
        }
        merged.push(item);
    }

    if merged.is_empty() {
        return Ok(true);
    }

    repo.restar_stock(merged).await
}

pub async fn delete_comanda_if_safe(
    repo: &dyn VentaRapidaRepository,
    input: VrDeleteComandaIfSafeInput,
) -> AppResult<bool> {
    if input.id_comanda <= 0 {
        return Err(AppError::validation("id_comanda invalid"));
    }
    repo.delete_comanda_if_safe(input.id_comanda).await
}
