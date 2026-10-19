//! Adaptador HTTP del repositorio de reservas (dominio `/v1/reservas` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::reservas::{AvisoAlCliente, AvisosReservaWeb, ReservasRepository};
use tpv_contracts::reservas_web::AvisoReservaWebInput;
use tpv_contracts::reservas::{ClienteCoincidente, ReservaDto, ReservasMetaDto};
use tpv_domain::reservas::{ClienteReserva, ReservaValidada};

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

    async fn reserva(&self, id_reserva: &str) -> AppResult<Option<ReservaDto>> {
        self.client.get_json(&format!("/v1/reservas/{id_reserva}")).await
    }

    async fn guardar(&self, reserva: ReservaValidada, forzar_solape: bool) -> AppResult<bool> {
        // RI-61: el cliente viaja decidido, en los mismos campos que la entrada de la pantalla, y el
        // worker lo resuelve igual que la Main (`resolverCliente`).
        let generado = reserva.id.is_none().then_some("id_reserva");
        let id_reserva = reserva
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let (id_cliente, nombre, telefono, email) = match reserva.cliente {
            ClienteReserva::Ninguno => (None, None, None, None),
            ClienteReserva::Existente { id, telefono, email } => (Some(id), None, telefono, email),
            ClienteReserva::Nuevo { nombre, telefono, email } => (None, Some(nombre), telefono, email),
        };
        let body = json!({
            "id_reserva": id_reserva,
            "dia_ymd": reserva.dia_ymd,
            "hora": reserva.hora,
            "turno": reserva.turno,
            "comensales": reserva.comensales,
            "duracion_min": reserva.duracion_min,
            "forzar_solape": forzar_solape,
            "nota": reserva.nota,
            "estado": reserva.estado,
            "id_mesa": reserva.id_mesa,
            "id_cliente": id_cliente,
            "nombre_cliente": nombre,
            "telefono": telefono,
            "email": email,
        });
        let _: (JsonValue, _) = self
            .client
            .post_json_creando("/v1/reservas", &body, generado)
            .await?;
        Ok(true)
    }

    async fn buscar_cliente(
        &self,
        telefono: Option<&str>,
        email: Option<&str>,
    ) -> AppResult<Option<ClienteCoincidente>> {
        let mut query = Vec::new();
        if let Some(t) = telefono {
            query.push(("telefono", t.to_string()));
        }
        if let Some(e) = email {
            query.push(("email", e.to_string()));
        }
        self.client.get_query("/v1/reservas/buscar-cliente", &query).await
    }

    async fn eliminar(&self, id_reserva: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/reservas/{id_reserva}"))
            .await?;
        Ok(true)
    }
}

/// El aviso al cliente de una reserva web, desde la Handy: siempre tiene red, así que se manda ya
/// (docs/estudios/reservas-web.md §5.7). En la Main va por la cola y su job.
pub struct HttpAvisosReservaWeb {
    client: Arc<CloudClient>,
}

impl HttpAvisosReservaWeb {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl AvisosReservaWeb for HttpAvisosReservaWeb {
    async fn encolar(&self, aviso: AvisoAlCliente) -> AppResult<()> {
        let cuerpo = AvisoReservaWebInput {
            id_aviso: uuid::Uuid::now_v7().to_string(),
            id_reserva: aviso.id_reserva,
            tipo: aviso.tipo,
            dia_ymd: aviso.dia_ymd,
            hora: aviso.hora,
            personas: aviso.personas,
            mesa: aviso.mesa,
            id_cliente: aviso.id_cliente,
        };
        let _: JsonValue = self.client.post_json("/v1/reservas-web/avisos", &cuerpo).await?;
        Ok(())
    }
}
