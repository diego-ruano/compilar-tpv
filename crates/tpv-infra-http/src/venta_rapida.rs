//! Adaptador HTTP del repositorio de venta rápida/barra (dominio `/v1/venta-rapida`).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow,
    VerTicketsDetalleRow, VrLineaAnadida,
};
use tpv_application::error::AppError;
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::client::leer_campo;
use crate::CloudClient;

/// Confirma con el cuerpo de la respuesta el id de la fila creada.
///
/// Convención del proyecto (docs/arquitectura/sincronizacion.md · `idStep` en cada `*.commands.ts`): **el id lo genera el
/// dispositivo** y lo envía; la nube lo honra y solo genera uno si no llega. Aun así leemos el id de
/// la respuesta en lugar de dar por hecho el nuestro: es la autoridad, y así es imposible que la UI
/// y la nube se desincronicen aunque el servidor decidiera otro (p. ej. un `get_or_create` que
/// reengancha con un ticket ya abierto, que devuelve un id distinto del que mandamos).
///
/// Ese desajuste era justo el bug del primer cobro: el Handy se inventaba el id, el worker lo
/// descartaba y generaba otro, y la UI acababa cobrando líneas con ids inexistentes
/// (`no_valid_pending_details`) hasta que un refetch traía los buenos.
fn id_from_response(resp: &JsonValue, field: &str) -> AppResult<String> {
    let id = resp
        .get(field)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    if id.is_empty() {
        return Err(AppError::external(format!("respuesta sin {field}")));
    }
    Ok(id)
}

pub struct HttpVentaRapidaRepository {
    client: Arc<CloudClient>,
}

impl HttpVentaRapidaRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl VentaRapidaRepository for HttpVentaRapidaRepository {
    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaRow>> {
        self.client.get_json("/v1/venta-rapida/categorias").await
    }

    async fn list_productos_by_categoria(&self, id_categoria: &str) -> AppResult<Vec<ProductoRow>> {
        self.client
            .get_json(&format!("/v1/venta-rapida/productos/{id_categoria}"))
            .await
    }

    async fn search_productos(&self, query: String, limit: i64) -> AppResult<Vec<ProductoRow>> {
        // AUD-27: lo que se escribe en un buscador va en el cuerpo, no en la URL.
        self.client
            .post_lectura(
                "/v1/venta-rapida/productos/search",
                &json!({ "query": query, "limit": limit }),
            )
            .await
    }

    async fn list_comandas_barra(&self, limit: Option<i64>) -> AppResult<Vec<ComandaBarraRow>> {
        let mut q = Vec::new();
        if let Some(l) = limit {
            q.push(("limit", l.to_string()));
        }
        self.client.get_query("/v1/venta-rapida/comandas", &q).await
    }

    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<LineaComandaRow>> {
        self.client
            .get_json(&format!("/v1/venta-rapida/comandas/{id_comanda}/lineas"))
            .await
    }

    async fn get_index_rows(&self, ids: Vec<String>) -> AppResult<Vec<IndexRow>> {
        // Lectura por POST (el cuerpo lleva la lista de ids): sin clave de idempotencia.
        self.client
            .post_lectura("/v1/venta-rapida/index-rows", &json!({ "ids": ids }))
            .await
    }

    async fn get_detalles_ver_ticket(
        &self,
        id_comanda: &str,
    ) -> AppResult<Vec<VerTicketsDetalleRow>> {
        self.client
            .get_json(&format!(
                "/v1/venta-rapida/comandas/{id_comanda}/ticket-detalles"
            ))
            .await
    }

    async fn create_comanda_barra(
        &self,
        id_trabajador: Option<String>,
        get_or_create: bool,
    ) -> AppResult<String> {
        let body = json!({
            "id_comanda": uuid::Uuid::now_v7().to_string(),
            "id_trabajador": id_trabajador,
            "get_or_create": get_or_create,
        });
        let (resp, _): (JsonValue, _) = self
            .client
            .post_json_creando("/v1/venta-rapida/comandas/barra", &body, Some("id_comanda"))
            .await?;
        // Ojo: con `get_or_create` el worker puede devolver el id de un ticket ya abierto, distinto
        // del que acabamos de proponer. Por eso manda la respuesta, no nuestro uuid.
        id_from_response(&resp, "id_comanda")
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
    ) -> AppResult<VrLineaAnadida> {
        let body = json!({
            "id_detalle": uuid::Uuid::now_v7().to_string(),
            "id_comanda": id_comanda,
            "id_producto": id_producto,
            "cantidad": cantidad,
        });
        let (resp, _): (JsonValue, _) = self
            .client
            .post_json_creando("/v1/venta-rapida/lineas", &body, Some("id_detalle"))
            .await?;
        Ok(VrLineaAnadida {
            id_detalle: id_from_response(&resp, "id_detalle")?,
            // AUD-28: sin el texto de serde, que cita el valor que no encaja.
            precio_unitario: leer_campo("bad_precio_unitario", &resp["precio_unitario"])?,
        })
    }

    async fn remove_last_unpaid_linea(
        &self,
        id_comanda: &str,
        id_producto: &str,
    ) -> AppResult<bool> {
        let body = json!({ "id_comanda": id_comanda, "id_producto": id_producto });
        let _: JsonValue = self
            .client
            .post_json("/v1/venta-rapida/lineas/remove-last-unpaid", &body)
            .await?;
        Ok(true)
    }

    async fn delete_linea_if_unpaid(&self, id_comanda: &str, id_detalle: &str) -> AppResult<bool> {
        let body = json!({ "id_comanda": id_comanda, "id_detalle": id_detalle });
        let _: JsonValue = self
            .client
            .post_json("/v1/venta-rapida/lineas/delete-if-unpaid", &body)
            .await?;
        Ok(true)
    }

    async fn update_nota_detalle(&self, id_detalle: &str, nota: Option<String>) -> AppResult<bool> {
        let body = json!({ "id_detalle": id_detalle, "nota": nota });
        let _: JsonValue = self
            .client
            .put_json("/v1/venta-rapida/lineas/nota", &body)
            .await?;
        Ok(true)
    }

    /// El worker rechaza el cobro desde un Handy (solo cobra la Main, que es la que tiene
    /// impresora y cajón), así que esta llamada devuelve 403 y nunca llega a un número. Se
    /// mantiene el camino por si algún día se retoma.
    async fn cobrar_fraccionado(&self, data: CobroFraccionado) -> AppResult<String> {
        let body = json!({
            "id_comanda": data.id_comanda,
            "metodo": data.metodo,
            "importe_total": data.importe_total,
            "id_usuario_cobrador": data.id_usuario_cobrador,
            "id_trabajador_cobrador": data.id_trabajador_cobrador,
            "detalles": data.detalles,
        });
        let _: JsonValue = self
            .client
            .post_json("/v1/venta-rapida/cobrar-fraccionado", &body)
            .await?;
        Ok(String::new())
    }

    async fn delete_comanda_if_safe(&self, id_comanda: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .post_json(
                "/v1/venta-rapida/comandas/delete-if-safe",
                &json!({ "id_comanda": id_comanda }),
            )
            .await?;
        Ok(true)
    }
}
