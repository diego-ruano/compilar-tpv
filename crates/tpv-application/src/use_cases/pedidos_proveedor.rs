//! Casos de uso de pedidos a proveedores (Local-First).

use tpv_contracts::pedidos_proveedor::{
    PedidoProveedorDto, PedidosActualizarInput, PedidosCambiarEstadoInput, PedidosCrearInput,
};
use tpv_domain::pedidos_proveedor::{LineaPedidoNueva, PedidoProveedorNuevo};

use crate::error::{AppError, AppResult};
use crate::ports::pedidos_proveedor::PedidoProveedorRepository;

pub async fn get_all(repo: &dyn PedidoProveedorRepository) -> AppResult<Vec<PedidoProveedorDto>> {
    repo.get_all().await
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
