//! Adaptador HTTP del repositorio de trabajadores/horarios (dominio `/v1/trabajadores`).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::trabajadores::TrabajadoresRepository;
use tpv_contracts::trabajadores::{
    AsignacionRow, RolRow, TrabajadorDetailRow, TrabajadorEliminado, TrabajadorRow, TurnoRow,
};
use tpv_domain::trabajadores::{AsignacionNueva, TrabajadorCambios, TrabajadorNuevo};

use crate::CloudClient;

/// El cuerpo del alta. Se desestructura sin `..` para que un campo nuevo de `TrabajadorNuevo`
/// no compile hasta decidir si viaja: `sin_pin` se quedaba fuera y la Handy daba de alta con PIN a
/// quien se marcaba «Entra sin PIN» (TRA-INC-02).
fn cuerpo_alta(data: TrabajadorNuevo) -> JsonValue {
    let TrabajadorNuevo {
        id_rol, email, pin, nombre, apellido, estado, dni, telefono, puesto, iban,
        numero_seguridad_social, fecha_inicio_contrato, fecha_fin_contrato, sin_pin,
    } = data;
    json!({
        "id_rol": id_rol,
        "email": email,
        // RI-63: el PIN, no su hash: lo hashea el worker, como la Main en su SQLite.
        "pin": pin,
        "nombre": nombre,
        "apellido": apellido,
        "estado": estado,
        "dni": dni,
        "telefono": telefono,
        "puesto": puesto,
        "iban": iban,
        "numero_seguridad_social": numero_seguridad_social,
        "fecha_inicio_contrato": fecha_inicio_contrato,
        "fecha_fin_contrato": fecha_fin_contrato,
        "sin_pin": sin_pin,
    })
}

/// El cuerpo de la edición, con el mismo criterio que el alta (TRA-INC-02). `sin_pin` a `null`
/// deja el que tenga (`COALESCE` en el worker).
fn cuerpo_edicion(id_trabajador: &str, cambios: TrabajadorCambios) -> JsonValue {
    let TrabajadorCambios {
        id_usuario, id_rol, email, nombre, apellido, estado, dni, telefono, puesto, iban,
        numero_seguridad_social, fecha_inicio_contrato, fecha_fin_contrato, pin, sin_pin,
    } = cambios;
    json!({
        "id_trabajador": id_trabajador,
        "id_usuario": id_usuario,
        "id_rol": id_rol,
        "email": email,
        "nombre": nombre,
        "apellido": apellido,
        "estado": estado,
        "dni": dni,
        "telefono": telefono,
        "puesto": puesto,
        "iban": iban,
        "numero_seguridad_social": numero_seguridad_social,
        "fecha_inicio_contrato": fecha_inicio_contrato,
        "fecha_fin_contrato": fecha_fin_contrato,
        "pin": pin,
        "sin_pin": sin_pin,
    })
}

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
        let body = cuerpo_alta(data);
        let _: JsonValue = self.client.post_json("/v1/trabajadores", &body).await?;
        Ok(true)
    }

    async fn update_trabajador(
        &self,
        id_trabajador: &str,
        cambios: TrabajadorCambios,
    ) -> AppResult<bool> {
        let body = cuerpo_edicion(id_trabajador, cambios);
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/trabajadores/{id_trabajador}"), &body)
            .await?;
        Ok(true)
    }

    async fn eliminar_trabajador(&self, id_trabajador: &str) -> AppResult<bool> {
        let r: TrabajadorEliminado = self
            .client
            .delete_json(&format!("/v1/trabajadores/{id_trabajador}"))
            .await?;
        Ok(r.retirado)
    }

    async fn get_asignaciones_semana(&self, fecha_lunes: String) -> AppResult<Vec<AsignacionRow>> {
        self.client
            .get_query("/v1/trabajadores/horarios/semana", &[("fecha_lunes", fecha_lunes)])
            .await
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

    async fn delete_asignacion(&self, id_asignacion: &str) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!(
                "/v1/trabajadores/horarios/asignaciones/{id_asignacion}"
            ))
            .await?;
        Ok(true)
    }

    async fn marcar_libre(&self, id_trabajador: &str, fecha: String) -> AppResult<bool> {
        let body = json!({ "id_trabajador": id_trabajador, "fecha": fecha });
        let _: JsonValue = self.client.post_json("/v1/trabajadores/horarios/libre", &body).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn alta(sin_pin: bool) -> TrabajadorNuevo {
        TrabajadorNuevo {
            id_rol: "r".into(), email: "a@b.es".into(), pin: "1234".into(), nombre: "Ana".into(),
            apellido: None, estado: "Activo".into(), dni: None, telefono: None, puesto: None,
            iban: None, numero_seguridad_social: None, fecha_inicio_contrato: None,
            fecha_fin_contrato: None, sin_pin,
        }
    }

    fn edicion(sin_pin: Option<bool>) -> TrabajadorCambios {
        TrabajadorCambios {
            id_usuario: "u".into(), id_rol: "r".into(), email: "a@b.es".into(), nombre: "Ana".into(),
            apellido: None, estado: "Activo".into(), dni: None, telefono: None, puesto: None,
            iban: None, numero_seguridad_social: None, fecha_inicio_contrato: None,
            fecha_fin_contrato: None, pin: None, sin_pin,
        }
    }

    #[test]
    fn el_alta_lleva_entra_sin_pin() {
        assert_eq!(cuerpo_alta(alta(true))["sin_pin"], json!(true));
        assert_eq!(cuerpo_alta(alta(false))["sin_pin"], json!(false));
    }

    #[test]
    fn la_edicion_lleva_entra_sin_pin_y_null_si_no_se_toca() {
        assert_eq!(cuerpo_edicion("t", edicion(Some(true)))["sin_pin"], json!(true));
        assert_eq!(cuerpo_edicion("t", edicion(Some(false)))["sin_pin"], json!(false));
        assert_eq!(cuerpo_edicion("t", edicion(None))["sin_pin"], JsonValue::Null);
    }
}
