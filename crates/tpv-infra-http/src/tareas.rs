//! Adaptador HTTP del repositorio de tareas (dominio `/v1/tareas` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::tareas::TareasRepository;
use tpv_contracts::tareas::{
    MisTareasRow, TareaAdminRow, TareaAsignadoRow, TareaRow, TrabajadorUI,
};
use tpv_domain::tareas::TareaData;

use crate::CloudClient;

pub struct HttpTareasRepository {
    client: Arc<CloudClient>,
}

impl HttpTareasRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl TareasRepository for HttpTareasRepository {
    async fn get_trabajadores(&self) -> AppResult<Vec<TrabajadorUI>> {
        self.client.get_json("/v1/tareas/trabajadores").await
    }

    async fn get_tareas_admin(&self) -> AppResult<Vec<TareaAdminRow>> {
        self.client.get_json("/v1/tareas/admin").await
    }

    async fn get_tarea_by_id(&self, id_tarea: &str) -> AppResult<Option<TareaRow>> {
        self.client.get_json(&format!("/v1/tareas/{id_tarea}")).await
    }

    async fn get_tarea_asignados(&self, id_tarea: &str) -> AppResult<Vec<TareaAsignadoRow>> {
        self.client
            .get_json(&format!("/v1/tareas/{id_tarea}/asignados"))
            .await
    }

    async fn get_mis_tareas(&self, id_trabajador: &str) -> AppResult<Vec<MisTareasRow>> {
        self.client
            .get_query("/v1/tareas/mias", &[("trabajador", id_trabajador.to_string())])
            .await
    }

    async fn create_tarea(&self, data: TareaData, ids_trabajadores: Vec<String>) -> AppResult<bool> {
        let body = json!({
            "titulo": data.titulo,
            "descripcion": data.descripcion,
            "fecha_limite": data.fecha_limite,
            "ids_trabajadores": ids_trabajadores,
        });
        let _: JsonValue = self.client.post_json("/v1/tareas", &body).await?;
        Ok(true)
    }

    async fn update_tarea(&self, id_tarea: &str, data: TareaData) -> AppResult<bool> {
        let body = json!({
            "titulo": data.titulo,
            "descripcion": data.descripcion,
            "fecha_limite": data.fecha_limite,
        });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/tareas/{id_tarea}"), &body)
            .await?;
        Ok(true)
    }

    async fn set_asignaciones(&self, id_tarea: &str, ids_trabajadores: Vec<String>) -> AppResult<bool> {
        let body = json!({ "ids_trabajadores": ids_trabajadores });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/tareas/{id_tarea}/asignaciones"), &body)
            .await?;
        Ok(true)
    }

    async fn delete_tarea(&self, id_tarea: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/tareas/{id_tarea}"))
            .await?;
        Ok(true)
    }

    async fn marcar_finalizada(&self, id_tarea: &str, id_trabajador: &str) -> AppResult<bool> {
        let body = json!({ "id_trabajador": id_trabajador });
        let _: JsonValue = self
            .client
            .post_json(&format!("/v1/tareas/{id_tarea}/finalizar"), &body)
            .await?;
        Ok(true)
    }
}
