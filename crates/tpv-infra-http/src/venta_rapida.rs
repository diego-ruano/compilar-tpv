//! Adaptador HTTP del repositorio de venta rápida/barra (dominio `/v1/venta-rapida`).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow, StockLinea,
    VerTicketsDetalleRow,
};
use tpv_application::error::AppError;
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::CloudClient;

/// Extrae del cuerpo de la respuesta el id que la NUBE asignó a la fila recién creada.
///
/// El id de estas escrituras lo genera el worker (paso `kind:"value"` con `crypto.randomUUID()`
/// **antes** del INSERT) y se replica desde ahí a la Main, que es lo que exige la regla de IDs
/// deterministas (CLAUDE.md §9): una fila, un id, igual en todos los lados.
///
/// Antes el Handy se inventaba aquí un UUIDv7 propio, lo mandaba en el cuerpo (donde el esquema zod
/// lo descartaba) e **ignoraba la respuesta**, devolviendo el suyo. Resultado: la UI creía que la
/// línea era `A` y la nube la había guardado como `B`, así que el primer cobro mandaba ids que no
/// existían y fallaba con `no_valid_pending_details`; sólo funcionaba al segundo intento, porque el
/// fallo provocaba un refetch que traía los ids buenos. Con las comandas pasaba lo mismo, pero se
/// disimulaba porque `addLinea` recrea la comanda si falta (dejando una comanda huérfana vacía por
/// cada ticket).
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
        self.client
            .get_query(
                "/v1/venta-rapida/productos/search",
                &[("query", query), ("limit", limit.to_string())],
            )
            .await
    }

    async fn list_comandas_barra(
        &self,
        include_pagadas: bool,
        limit: Option<i64>,
    ) -> AppResult<Vec<ComandaBarraRow>> {
        let mut q = vec![("include_pagadas", include_pagadas.to_string())];
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
        // Lectura vía POST (el body lleva la lista de ids); el worker no exige idempotencia aquí.
        self.client
            .post_json("/v1/venta-rapida/index-rows", &json!({ "ids": ids }))
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
            "id_trabajador": id_trabajador,
            "get_or_create": get_or_create,
        });
        let resp: JsonValue = self
            .client
            .post_json("/v1/venta-rapida/comandas/barra", &body)
            .await?;
        id_from_response(&resp, "id_comanda")
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
        precio_unitario: f64,
    ) -> AppResult<String> {
        let body = json!({
            "id_comanda": id_comanda,
            "id_producto": id_producto,
            "cantidad": cantidad,
            "precio_unitario": precio_unitario,
        });
        let resp: JsonValue = self.client.post_json("/v1/venta-rapida/lineas", &body).await?;
        id_from_response(&resp, "id_detalle")
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

    async fn cobrar_fraccionado(&self, data: CobroFraccionado) -> AppResult<bool> {
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
        Ok(true)
    }

    async fn restar_stock(&self, lineas: Vec<StockLinea>) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .post_json("/v1/venta-rapida/restar-stock", &json!({ "lineas": lineas }))
            .await?;
        Ok(true)
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
