//! Adaptador HTTP del repositorio de reservas (dominio `/v1/reservas` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::reservas::ReservasRepository;
use tpv_contracts::reservas::{ReservaDto, ReservasMetaDto};
use tpv_domain::reservas::ReservaValidada;

use crate::CloudClient;

pub struct HttpReservasRepository {
    client: Arc<CloudClient>,
}

impl HttpReservasRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl ReservasRepository for HttpReservasRepository {
    async fn meta(&self) -> AppResult<ReservasMetaDto> {
        self.client.get_json("/v1/reservas/meta").await
    }

    async fn mes(&self, desde: &str, hasta: &str) -> AppResult<Vec<ReservaDto>> {
        self.client
            .get_query(
                "/v1/reservas/mes",
                &[("desde", desde.to_string()), ("hasta", hasta.to_string())],
            )
            .await
    }

    async fn guardar(&self, reserva: ReservaValidada) -> AppResult<bool> {
        // El worker hace el upsert del cliente internamente a partir de estos campos.
        let id_reserva = reserva
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_reserva": id_reserva,
            "dia_ymd": reserva.dia_ymd,
            "hora": reserva.hora,
            "turno": reserva.turno,
            "comensales": reserva.comensales,
            "nota": reserva.nota,
            "estado": reserva.estado,
            "id_mesa": reserva.id_mesa,
            "nombre_cliente": reserva.cliente.nombre,
            "telefono": reserva.cliente.telefono,
            "email": reserva.cliente.email,
            "notas_cliente": reserva.cliente.notas,
        });
        let _: JsonValue = self.client.post_json("/v1/reservas", &body).await?;
        Ok(true)
    }

    async fn eliminar(&self, id_reserva: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/reservas/{id_reserva}"))
            .await?;
        Ok(true)
    }
}
