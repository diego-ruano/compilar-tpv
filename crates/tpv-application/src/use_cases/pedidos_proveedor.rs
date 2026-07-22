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

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRepo {
        pagina: Mutex<Option<(i64, i64, Option<String>)>>,
    }
    #[async_trait]
    impl PedidoProveedorRepository for FakeRepo {
        async fn get_page(
            &self,
            limit: i64,
            offset: i64,
            search: Option<String>,
        ) -> AppResult<PedidosPageDto> {
            *self.pagina.lock().unwrap() = Some((limit, offset, search));
            Err(AppError::external("fin de prueba"))
        }
        async fn crear(
            &self,
            _: PedidoProveedorNuevo,
            _: Vec<LineaPedidoNueva>,
        ) -> AppResult<String> {
            panic!("no usado")
        }
        async fn actualizar(
            &self,
            _: &str,
            _: Option<String>,
            _: Option<String>,
            _: Option<String>,
            _: Vec<LineaPedidoNueva>,
        ) -> AppResult<bool> {
            panic!("no usado")
        }
        async fn cambiar_estado(&self, _: &str, _: &str, _: Option<String>) -> AppResult<bool> {
            panic!("no usado")
        }
    }

    #[tokio::test]
    async fn pagina_acota_limit_y_limpia_busqueda() {
        let repo = FakeRepo::default();
        let _ = get_page(
            &repo,
            PedidosGetPageInput {
                limit: 999,
                offset: 7,
                search: Some("  cafe  ".into()),
            },
        )
        .await;
        assert_eq!(
            *repo.pagina.lock().unwrap(),
            Some((200, 7, Some("cafe".into())))
        );
    }

    #[tokio::test]
    async fn pagina_descarta_busqueda_vacia() {
        let repo = FakeRepo::default();
        let _ = get_page(
            &repo,
            PedidosGetPageInput {
                limit: 0,
                offset: 0,
                search: Some(" ".into()),
            },
        )
        .await;
        assert_eq!(*repo.pagina.lock().unwrap(), Some((1, 0, None)));
    }

    #[tokio::test]
    async fn cambiar_estado_rechaza_id_vacio_y_estados_desconocidos() {
        let repo = FakeRepo::default();
        let sin_id = PedidosCambiarEstadoInput { id_pedido: " ".into(), estado: "enviado".into(), fecha_envio: None };
        let estado_mal = PedidosCambiarEstadoInput { id_pedido: "p1".into(), estado: "pendiente".into(), fecha_envio: None };
        assert!(matches!(cambiar_estado(&repo, sin_id).await, Err(AppError::Validation(_))));
        assert!(matches!(cambiar_estado(&repo, estado_mal).await, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn cambiar_estado_exige_valor_canonico_en_minusculas() {
        let repo = FakeRepo::default();
        let input = PedidosCambiarEstadoInput { id_pedido: "p1".into(), estado: " ENVIADO ".into(), fecha_envio: None };
        assert!(matches!(cambiar_estado(&repo, input).await, Err(AppError::Validation(_))));
    }
}
