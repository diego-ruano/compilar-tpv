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
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::{extract_id, CloudClient};

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

    async fn list_productos_by_categoria(&self, id_categoria: i64) -> AppResult<Vec<ProductoRow>> {
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

    async fn get_lineas_comanda(&self, id_comanda: i64) -> AppResult<Vec<LineaComandaRow>> {
        self.client
            .get_json(&format!("/v1/venta-rapida/comandas/{id_comanda}/lineas"))
            .await
    }

    async fn get_index_rows(&self, ids: Vec<i64>) -> AppResult<Vec<IndexRow>> {
        // Lectura vía POST (el body lleva la lista de ids); el worker no exige idempotencia aquí.
        self.client
            .post_json("/v1/venta-rapida/index-rows", &json!({ "ids": ids }))
            .await
    }

    async fn get_detalles_ver_ticket(
        &self,
        id_comanda: i64,
    ) -> AppResult<Vec<VerTicketsDetalleRow>> {
        self.client
            .get_json(&format!(
                "/v1/venta-rapida/comandas/{id_comanda}/ticket-detalles"
            ))
            .await
    }

    async fn create_comanda_barra(
        &self,
        id_trabajador: Option<i64>,
        get_or_create: bool,
    ) -> AppResult<i64> {
        let body = json!({ "id_trabajador": id_trabajador, "get_or_create": get_or_create });
        let resp: JsonValue = self
            .client
            .post_json("/v1/venta-rapida/comandas/barra", &body)
            .await?;
        extract_id(&resp, "id_comanda")
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: i64,
        id_producto: i64,
        cantidad: f64,
        precio_unitario: f64,
    ) -> AppResult<i64> {
        let body = json!({
            "id_comanda": id_comanda,
            "id_producto": id_producto,
            "cantidad": cantidad,
            "precio_unitario": precio_unitario,
        });
        let resp: JsonValue = self.client.post_json("/v1/venta-rapida/lineas", &body).await?;
        extract_id(&resp, "id_detalle")
    }

    async fn remove_last_unpaid_linea(
        &self,
        id_comanda: i64,
        id_producto: i64,
    ) -> AppResult<bool> {
        let body = json!({ "id_comanda": id_comanda, "id_producto": id_producto });
        let _: JsonValue = self
            .client
            .post_json("/v1/venta-rapida/lineas/remove-last-unpaid", &body)
            .await?;
        Ok(true)
    }

    async fn delete_linea_if_unpaid(&self, id_comanda: i64, id_detalle: i64) -> AppResult<bool> {
        let body = json!({ "id_comanda": id_comanda, "id_detalle": id_detalle });
        let _: JsonValue = self
            .client
            .post_json("/v1/venta-rapida/lineas/delete-if-unpaid", &body)
            .await?;
        Ok(true)
    }

    async fn update_nota_detalle(&self, id_detalle: i64, nota: Option<String>) -> AppResult<bool> {
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

    async fn delete_comanda_if_safe(&self, id_comanda: i64) -> AppResult<bool> {
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
