//! Casos de uso de pedidos a proveedores (Local-First).

use tpv_contracts::pedidos_proveedor::{
    PedidosActualizarInput, PedidosCambiarEstadoInput, PedidosCrearInput, PedidosGetPageInput,
    PedidosPageDto,
};
use tpv_domain::pedidos_proveedor::{LineaPedidoNueva, PedidoProveedorNuevo};

use crate::error::{AppError, AppResult};
use crate::ports::pedidos_proveedor::PedidoProveedorRepository;

/// Tamaño máximo de página admitido (evita que la UI pida cargas gigantes).
const MAX_LIMIT: u32 = 200;

pub async fn get_page(
    repo: &dyn PedidoProveedorRepository,
    input: PedidosGetPageInput,
) -> AppResult<PedidosPageDto> {
    let limit = input.limit.clamp(1, MAX_LIMIT) as i64;
    let offset = input.offset as i64;
    let search = input
        .search
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    repo.get_page(limit, offset, search).await
}

pub async fn crear(
    repo: &dyn PedidoProveedorRepository,
    input: PedidosCrearInput,
) -> AppResult<String> {
    let pedido = PedidoProveedorNuevo::validar(
        input.id_pedido,
        input.id_proveedor,
        input.email_destino,
        input.notas,
    )
    .map_err(AppError::validation)?;

    let lineas: Result<Vec<LineaPedidoNueva>, _> = input
        .lineas
        .into_iter()
        .map(|l| {
            LineaPedidoNueva::validar(
                l.id_linea,
                l.nombre_producto,
                l.cantidad,
                l.precio_unitario,
                l.unidad,
            )
        })
        .collect();
    let lineas = lineas.map_err(AppError::validation)?;

    repo.crear(pedido, lineas).await
}

pub async fn actualizar(
    repo: &dyn PedidoProveedorRepository,
    input: PedidosActualizarInput,
) -> AppResult<bool> {
    let id = input.id_pedido.trim().to_string();
    if id.is_empty() {
        return Err(AppError::validation("id_pedido required"));
    }

    let lineas: Result<Vec<LineaPedidoNueva>, _> = input
        .lineas
        .into_iter()
        .map(|l| {
            LineaPedidoNueva::validar(
                l.id_linea,
                l.nombre_producto,
                l.cantidad,
                l.precio_unitario,
                l.unidad,
            )
        })
        .collect();
    let lineas = lineas.map_err(AppError::validation)?;

    repo.actualizar(
        &id,
        input.id_proveedor,
        input.email_destino,
        input.notas,
        lineas,
    )
    .await
}

pub async fn cambiar_estado(
    repo: &dyn PedidoProveedorRepository,
    input: PedidosCambiarEstadoInput,
) -> AppResult<bool> {
    let id = input.id_pedido.trim().to_string();
    if id.is_empty() {
        return Err(AppError::validation("id_pedido required"));
    }
    let estado = input.estado.trim().to_string();
    if !matches!(estado.as_str(), "cancelado" | "enviado") {
        return Err(AppError::validation("estado inválido (cancelado|enviado)"));
    }
    repo.cambiar_estado(&id, &estado, input.fecha_envio).await
}
