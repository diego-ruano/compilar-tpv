//! Casos de uso de pedidos a proveedores (Local-First).

use tpv_contracts::pedidos_proveedor::{
    PedidosActualizarInput, PedidosCambiarEstadoInput, PedidosCrearInput, PedidosGetPageInput,
    PedidosPageDto,
};
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};
use tpv_domain::pedidos_proveedor::{
    estado_nuevo, validar_lineas, LineaPedidoNueva, PedidoProveedorNuevo, MSG_FALTA_EL_PEDIDO,
};
use tpv_contracts::pedidos_proveedor::LineaPedidoInput;

use crate::error::{AppError, AppResult};
use crate::ports::notificaciones::Notifier;
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
    notifier: Option<&dyn Notifier>,
    input: PedidosCrearInput,
) -> AppResult<String> {
    let pedido = PedidoProveedorNuevo::validar(
        input.id_pedido,
        input.id_proveedor,
        input.email_destino,
        input.notas,
    )
    .map_err(AppError::validation)?;

    let lineas = lineas_validas(input.lineas)?;

    let id = repo.crear(pedido, lineas).await?;

    // Un pedido nuevo nace en 'borrador' (pendiente de revisar/enviar): avisamos a los
    // administradores. Dedupe por id => idempotente. Best-effort (no tumba la creación).
    if let Some(notifier) = notifier {
        let _ = notifier
            .emitir(NuevaNotificacion {
                tipo: "pedido_pendiente".to_string(),
                severidad: Severidad::Aviso,
                titulo: "Pedido pendiente de aprobar".to_string(),
                cuerpo: Some("Hay un pedido de proveedor en borrador esperando revisión.".to_string()),
                destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                accion: Some("ver_pedidos".to_string()),
                payload: None,
                clave_dedupe: Some(format!("pedido_pendiente:{id}")),
                expira_en: None,
            })
            .await;
    }

    Ok(id)
}

/// Las líneas que llegan, validadas como en el worker: su tope y cada una en su orden.
fn lineas_validas(lineas: Vec<LineaPedidoInput>) -> AppResult<Vec<LineaPedidoNueva>> {
    validar_lineas(
        lineas
            .into_iter()
            .map(|l| LineaPedidoNueva {
                id_linea: l.id_linea,
                nombre_producto: l.nombre_producto,
                cantidad: l.cantidad,
                precio_unitario: l.precio_unitario,
                unidad: l.unidad,
            })
            .collect(),
    )
    .map_err(AppError::validation)
}

/// Edita un borrador. Uno que ya se envió o se canceló no se toca, y se dice
/// (`MSG_PEDIDO_NO_EDITABLE`, con `conflict`): lo decide el repositorio dentro de su escritura.
pub async fn actualizar(
    repo: &dyn PedidoProveedorRepository,
    input: PedidosActualizarInput,
) -> AppResult<bool> {
    // La cabecera se valida y se limpia igual que al crearlo.
    let pedido = PedidoProveedorNuevo::validar(
        input.id_pedido,
        input.id_proveedor,
        input.email_destino,
        input.notas,
    )
    .map_err(AppError::validation)?;
    let lineas = lineas_validas(input.lineas)?;

    repo.actualizar(
        &pedido.id_pedido,
        pedido.id_proveedor,
        pedido.email_destino,
        pedido.notas,
        lineas,
    )
    .await
}

pub async fn cambiar_estado(
    repo: &dyn PedidoProveedorRepository,
    notifier: Option<&dyn Notifier>,
    input: PedidosCambiarEstadoInput,
) -> AppResult<bool> {
    let id = input.id_pedido.trim().to_string();
    if id.is_empty() {
        return Err(AppError::validation(MSG_FALTA_EL_PEDIDO));
    }
    let estado = estado_nuevo(&input.estado).map_err(AppError::validation)?;
    let fecha_envio = tpv_domain::texto::limpiar_opcional(input.fecha_envio);
    let cambiado = repo.cambiar_estado(&id, estado, fecha_envio).await?;

    // El pedido deja de estar en borrador (se envió o se canceló), así que el aviso "pendiente de
    // aprobar" que emitió `crear` ya no aplica: lo resolvemos. Sin esto la notificación se quedaba
    // activa para siempre y el usuario veía el pedido como pendiente aunque acabara de enviarlo.
    // Best-effort: si falla, no tumba el cambio de estado (que es lo que de verdad importa).
    if cambiado {
        if let Some(notifier) = notifier {
            let _ = notifier
                .resolver_por_clave(&format!("pedido_pendiente:{id}"))
                .await;
        }
    }

    Ok(cambiado)
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

    /// Repo que acepta `crear` (para probar la emisión sin tocar SQLite).
    struct RepoCrearOk;
    #[async_trait]
    impl PedidoProveedorRepository for RepoCrearOk {
        async fn get_page(&self, _: i64, _: i64, _: Option<String>) -> AppResult<PedidosPageDto> {
            unimplemented!("no usado")
        }
        async fn crear(
            &self,
            _: PedidoProveedorNuevo,
            _: Vec<LineaPedidoNueva>,
        ) -> AppResult<String> {
            Ok("ped-1".into())
        }
        async fn actualizar(
            &self,
            _: &str,
            _: Option<String>,
            _: Option<String>,
            _: Option<String>,
            _: Vec<LineaPedidoNueva>,
        ) -> AppResult<bool> {
            unimplemented!("no usado")
        }
        async fn cambiar_estado(&self, _: &str, _: &str, _: Option<String>) -> AppResult<bool> {
            unimplemented!("no usado")
        }
    }

    #[derive(Default)]
    struct FakeNotifier {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
    }
    #[async_trait]
    impl Notifier for FakeNotifier {
        async fn emitir(&self, n: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(n);
            Ok("n1".into())
        }
        async fn resolver_por_clave(&self, _: &str) -> AppResult<bool> {
            Ok(false)
        }
    }

    #[tokio::test]
    async fn crear_emite_pedido_pendiente_a_admin() {
        let notifier = FakeNotifier::default();
        let input = PedidosCrearInput {
            id_pedido: "p1".into(),
            id_proveedor: Some("prov1".into()),
            email_destino: None,
            notas: None,
            lineas: vec![],
        };
        let id = crear(&RepoCrearOk, Some(&notifier), input).await.unwrap();
        assert_eq!(id, "ped-1");

        let emitidas = notifier.emitidas.lock().unwrap();
        assert_eq!(emitidas.len(), 1);
        assert_eq!(emitidas[0].tipo, "pedido_pendiente");
        assert_eq!(emitidas[0].destino, Destino::Rol(ADMIN_ROL_ID.to_string()));
        assert_eq!(emitidas[0].clave_dedupe.as_deref(), Some("pedido_pendiente:ped-1"));
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
        assert!(matches!(cambiar_estado(&repo, None, sin_id).await, Err(AppError::Validation(_))));
        assert!(matches!(cambiar_estado(&repo, None, estado_mal).await, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn cambiar_estado_exige_valor_canonico_en_minusculas() {
        let repo = FakeRepo::default();
        let input = PedidosCambiarEstadoInput { id_pedido: "p1".into(), estado: " ENVIADO ".into(), fecha_envio: None };
        assert!(matches!(cambiar_estado(&repo, None, input).await, Err(AppError::Validation(_))));
    }

    /// Repo cuyo `cambiar_estado` confirma el cambio (para probar la resolución del aviso).
    struct RepoCambiarOk;
    #[async_trait]
    impl PedidoProveedorRepository for RepoCambiarOk {
        async fn get_page(&self, _: i64, _: i64, _: Option<String>) -> AppResult<PedidosPageDto> {
            unimplemented!("no usado")
        }
        async fn crear(&self, _: PedidoProveedorNuevo, _: Vec<LineaPedidoNueva>) -> AppResult<String> {
            unimplemented!("no usado")
        }
        async fn actualizar(
            &self,
            _: &str,
            _: Option<String>,
            _: Option<String>,
            _: Option<String>,
            _: Vec<LineaPedidoNueva>,
        ) -> AppResult<bool> {
            unimplemented!("no usado")
        }
        async fn cambiar_estado(&self, _: &str, _: &str, _: Option<String>) -> AppResult<bool> {
            Ok(true)
        }
    }

    /// Notifier que registra las claves resueltas.
    #[derive(Default)]
    struct NotifierResoluciones {
        resueltas: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl Notifier for NotifierResoluciones {
        async fn emitir(&self, _: NuevaNotificacion) -> AppResult<String> {
            Ok("n1".into())
        }
        async fn resolver_por_clave(&self, clave: &str) -> AppResult<bool> {
            self.resueltas.lock().unwrap().push(clave.to_string());
            Ok(true)
        }
    }

    /// Al enviar (o cancelar) el pedido, el aviso "pendiente de aprobar" que emitió `crear` deja de
    /// aplicar y debe resolverse; si no, el usuario lo ve pendiente para siempre.
    #[tokio::test]
    async fn cambiar_estado_resuelve_el_aviso_de_pendiente() {
        for estado in ["enviado", "cancelado"] {
            let notifier = NotifierResoluciones::default();
            let input = PedidosCambiarEstadoInput {
                id_pedido: " ped-1 ".into(),
                estado: estado.into(),
                fecha_envio: None,
            };
            let ok = cambiar_estado(&RepoCambiarOk, Some(&notifier), input)
                .await
                .unwrap();
            assert!(ok);
            assert_eq!(
                *notifier.resueltas.lock().unwrap(),
                vec!["pedido_pendiente:ped-1".to_string()],
                "estado {estado} debe resolver el aviso"
            );
        }
    }
}
