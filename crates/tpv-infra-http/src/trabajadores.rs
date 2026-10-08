//! Adaptador HTTP del repositorio de trabajadores/horarios (dominio `/v1/trabajadores`).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::trabajadores::TrabajadoresRepository;
use tpv_contracts::trabajadores::{
    AsignacionRow, RolRow, TrabajadorDetailRow, TrabajadorRow, TurnoRow,
};
use tpv_domain::trabajadores::{
    AsignacionCambios, AsignacionNueva, TrabajadorCambios, TrabajadorNuevo,
};

use crate::CloudClient;

pub struct HttpTrabajadoresRepository {
    client: Arc<CloudClient>,
}

impl HttpTrabajadoresRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl TrabajadoresRepository for HttpTrabajadoresRepository {
    async fn get_roles(&self) -> AppResult<Vec<RolRow>> {
        self.client.get_json("/v1/trabajadores/roles").await
    }

    async fn get_all(&self) -> AppResult<Vec<TrabajadorRow>> {
        self.client.get_json("/v1/trabajadores").await
    }

    async fn get_detail(&self, id_trabajador: &str) -> AppResult<Option<TrabajadorDetailRow>> {
        self.client
            .get_json(&format!("/v1/trabajadores/{id_trabajador}"))
            .await
    }

    async fn get_id_by_usuario(&self, id_usuario: &str) -> AppResult<Option<String>> {
        self.client
            .get_json(&format!("/v1/trabajadores/by-usuario/{id_usuario}"))
            .await
    }

    async fn turnos_get_all(&self) -> AppResult<Vec<TurnoRow>> {
        self.client.get_json("/v1/trabajadores/turnos").await
    }

    async fn create_trabajador(&self, data: TrabajadorNuevo) -> AppResult<bool> {
        let body = json!({
            "id_rol": data.id_rol,
            "email": data.email,
            // RI-63: el PIN, no su hash: lo hashea el worker, como la Main en su SQLite.
            "pin": data.pin,
            "nombre": data.nombre,
            "apellido": data.apellido,
            "estado": data.estado,
            "dni": data.dni,
            "telefono": data.telefono,
            "puesto": data.puesto,
            "iban": data.iban,
            "numero_seguridad_social": data.numero_seguridad_social,
            "fecha_inicio_contrato": data.fecha_inicio_contrato,
            "fecha_fin_contrato": data.fecha_fin_contrato,
        });
        let _: JsonValue = self.client.post_json("/v1/trabajadores", &body).await?;
        Ok(true)
    }

    async fn update_trabajador(
        &self,
        id_trabajador: &str,
        cambios: TrabajadorCambios,
    ) -> AppResult<bool> {
        let body = json!({
            "id_trabajador": id_trabajador,
            "id_usuario": cambios.id_usuario,
            "id_rol": cambios.id_rol,
            "email": cambios.email,
            "nombre": cambios.nombre,
            "apellido": cambios.apellido,
            "estado": cambios.estado,
            "dni": cambios.dni,
            "telefono": cambios.telefono,
            "puesto": cambios.puesto,
            "iban": cambios.iban,
            "numero_seguridad_social": cambios.numero_seguridad_social,
            "fecha_inicio_contrato": cambios.fecha_inicio_contrato,
            "fecha_fin_contrato": cambios.fecha_fin_contrato,
            "pin": cambios.pin,
        });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/trabajadores/{id_trabajador}"), &body)
            .await?;
        Ok(true)
    }

    async fn get_asignaciones_semana(&self, fecha_lunes: String) -> AppResult<Vec<AsignacionRow>> {
        self.client
            .get_query("/v1/trabajadores/horarios/semana", &[("fecha_lunes", fecha_lunes)])
            .await
    }

    async fn create_asignacion(&self, data: AsignacionNueva) -> AppResult<bool> {
        let body = json!({
            "id_trabajador": data.id_trabajador,
            "fecha": data.fecha,
            "id_turno": data.id_turno,
            "area": data.area,
            "hora_inicio": data.hora_inicio,
            "hora_fin": data.hora_fin,
            "notas": data.notas,
        });
        let _: JsonValue = self
            .client
            .post_json("/v1/trabajadores/horarios/asignaciones", &body)
            .await?;
        Ok(true)
    }

    async fn guardar_asignacion(&self, id_asignacion: Option<String>, tramos: Vec<AsignacionNueva>) -> AppResult<bool> {
        let primero = &tramos[0];
        let body = json!({ "id_asignacion": id_asignacion, "id_trabajador": primero.id_trabajador,
            "fecha": primero.fecha, "id_turno": primero.id_turno, "area": primero.area,
            "notas": primero.notas, "tramos": tramos.iter().map(|t| json!({
                "hora_inicio": t.hora_inicio, "hora_fin": t.hora_fin })).collect::<Vec<_>>() });
        let _: JsonValue = self.client.post_json("/v1/trabajadores/horarios/guardar", &body).await?;
        Ok(true)
    }

    async fn update_asignacion(
        &self,
        id_asignacion: &str,
        cambios: AsignacionCambios,
    ) -> AppResult<bool> {
        let body = json!({
            "id_turno": cambios.id_turno,
            "area": cambios.area,
            "hora_inicio": cambios.hora_inicio,
            "hora_fin": cambios.hora_fin,
            "notas": cambios.notas,
        });
        let _: JsonValue = self
            .client
            .put_json(
                &format!("/v1/trabajadores/horarios/asignaciones/{id_asignacion}"),
                &body,
            )
            .await?;
        Ok(true)
    }

    async fn delete_asignacion(&self, id_asignacion: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!(
                "/v1/trabajadores/horarios/asignaciones/{id_asignacion}"
            ))
            .await?;
        Ok(true)
    }

    async fn copy_semana(
        &self,
        from_monday: String,
        to_monday: String,
        overwrite: bool,
    ) -> AppResult<bool> {
        let body = json!({
            "from_monday": from_monday,
            "to_monday": to_monday,
            "overwrite": overwrite,
        });
        let _: JsonValue = self
            .client
            .post_json("/v1/trabajadores/horarios/copy-semana", &body)
            .await?;
        Ok(true)
    }

    async fn set_predeterminado_desde_semana(&self, fecha_lunes: String) -> AppResult<bool> {
        let body = json!({ "fecha_lunes": fecha_lunes });
        let _: JsonValue = self
            .client
            .post_json("/v1/trabajadores/horarios/predeterminado-desde-semana", &body)
            .await?;
        Ok(true)
    }
}
