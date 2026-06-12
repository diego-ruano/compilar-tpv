//! Adaptador HTTP del repositorio de clientes (implementa `ClientesRepository` contra la nube).
//!
//! Espejo de `tpv_infra_sqlite::clientes::SqliteClientesRepository`, pero hablando con el
//! worker `tpv-api` en vez de con SQLite. Las rutas son las del dominio `clientes` del worker
//! (`/v1/clientes/*`): lecturas GET y escrituras POST (alta) / PUT (edición).

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;

use tpv_application::error::AppResult;
use tpv_application::ports::clientes::ClientesRepository;
use tpv_contracts::clientes::{ClienteForm, ClienteOverview};
use tpv_domain::clientes::{Cliente, ClienteRanking, NuevoCliente};

use crate::CloudClient;

pub struct HttpClientesRepository {
    client: Arc<CloudClient>,
}

impl HttpClientesRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

/// Respuesta mínima de las escrituras: `{ "ok": true }`.
#[derive(Debug, Deserialize)]
struct OkFlag {
    #[serde(default)]
    ok: bool,
}

/// Mapea el criterio de ranking al valor de query que entiende el worker (igual que el
/// argumento que ya envía la UI).
fn ranking_arg(r: ClienteRanking) -> &'static str {
    match r {
        ClienteRanking::PorReservas => "reservas",
        ClienteRanking::PorGasto => "gasto",
        ClienteRanking::Reciente => "reciente",
    }
}

#[async_trait]
impl ClientesRepository for HttpClientesRepository {
    async fn overview(&self, ranking: ClienteRanking) -> AppResult<Vec<ClienteOverview>> {
        self.client
            .get_json(&format!(
                "/v1/clientes/overview?ranking={}",
                ranking_arg(ranking)
            ))
            .await
    }

    async fn form(&self, id_cliente: &str) -> AppResult<Option<ClienteForm>> {
        self.client
            .get_json(&format!("/v1/clientes/{id_cliente}/form"))
            .await
    }

    async fn create(&self, nuevo: NuevoCliente) -> AppResult<bool> {
        // POST /v1/clientes — el `id_cliente` (UUIDv7) lo genera el cliente: si no viene, lo
        // creamos aquí. El worker lo persiste tal cual (no recalcula ids).
        let id_cliente = nuevo
            .id
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_cliente": id_cliente,
            "nombre": nuevo.nombre,
            "email": nuevo.email,
            "telefono": nuevo.telefono,
            "notas": nuevo.notas,
        });
        let resp: OkFlag = self.client.post_json("/v1/clientes", &body).await?;
        Ok(resp.ok)
    }

    async fn update(&self, cliente: Cliente) -> AppResult<bool> {
        // PUT /v1/clientes/:id — el id viaja en la URL; el cuerpo sólo lleva los campos
        // editables (el schema del worker ignora un `id_cliente` en el body).
        let body = json!({
            "nombre": cliente.nombre,
            "email": cliente.email,
            "telefono": cliente.telefono,
            "notas": cliente.notas,
        });
        let resp: OkFlag = self
            .client
            .put_json(&format!("/v1/clientes/{}", cliente.id), &body)
            .await?;
        Ok(resp.ok)
    }
}
