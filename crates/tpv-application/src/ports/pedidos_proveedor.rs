//! Puerto de persistencia de pedidos a proveedores.

use async_trait::async_trait;

use tpv_contracts::pedidos_proveedor::PedidosPageDto;
use tpv_domain::pedidos_proveedor::{LineaPedidoNueva, PedidoProveedorNuevo};

use crate::error::AppResult;

#[async_trait]
pub trait PedidoProveedorRepository: Send + Sync {
    /// Página de pedidos (PROV-03), ordenada por fecha de creación descendente (la clave desempata).
    /// `search` filtra por proveedor/email/notas/estado, sin acentos ni mayúsculas. La página se corta
    /// en `TECHO_LINEAS_PAGINA` líneas. Devuelve la página y el total de coincidencias.
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
    /// Edita un borrador. Uno que ya no lo es (o que no existe) no se toca: `conflict` con
    /// `MSG_PEDIDO_NO_EDITABLE`.
    async fn actualizar(
        &self,
        id_pedido: &str,
        id_proveedor: Option<String>,
        email_destino: Option<String>,
        notas: Option<String>,
        lineas: Vec<LineaPedidoNueva>,
    ) -> AppResult<bool>;
    /// Pasa un borrador a `estado`. `false` si no había un borrador con ese id.
    async fn cambiar_estado(
        &self,
        id_pedido: &str,
        estado: &str,
        fecha_envio: Option<String>,
    ) -> AppResult<bool>;
}
