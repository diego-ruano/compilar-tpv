//! Puerto de persistencia de pedidos a proveedores.

use async_trait::async_trait;

use tpv_contracts::pedidos_proveedor::PedidosPageDto;
use tpv_domain::pedidos_proveedor::{LineaPedidoNueva, PedidoProveedorNuevo};

use crate::error::AppResult;

#[async_trait]
pub trait PedidoProveedorRepository: Send + Sync {
    /// Página de pedidos (PROV-03), ordenada por fecha de creación descendente. `search`
    /// filtra por proveedor/email/notas/estado (LIKE case-insensitive). Devuelve la página
    /// y el total de coincidencias.
    async fn get_page(
        &self,
        limit: i64,
        offset: i64,
        search: Option<String>,
    ) -> AppResult<PedidosPageDto>;
    async fn crear(
        &self,
        pedido: PedidoProveedorNuevo,
        lineas: Vec<LineaPedidoNueva>,
    ) -> AppResult<String>;
    async fn actualizar(
        &self,
        id_pedido: &str,
        id_proveedor: Option<String>,
        email_destino: Option<String>,
        notas: Option<String>,
        lineas: Vec<LineaPedidoNueva>,
    ) -> AppResult<bool>;
    async fn cambiar_estado(
        &self,
        id_pedido: &str,
        estado: &str,
        fecha_envio: Option<String>,
    ) -> AppResult<bool>;
}
