//! Adaptador HTTP del repositorio de login/auth/fichaje (dominio `/v1/login` del worker).
//!
//! El PIN viaja al worker, que lo verifica server-side (nunca expone el hash). Por eso las
//! operaciones gruesas del puerto encajan 1:1 con los endpoints del worker.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::login::LoginRepository;
use tpv_contracts::login::{LoginOk, PunchStatus, SetupPendiente, UserListItem};

use crate::CloudClient;

pub struct HttpLoginRepository {
    client: Arc<CloudClient>,
}

impl HttpLoginRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl LoginRepository for HttpLoginRepository {
    async fn list_login_users(&self) -> AppResult<Vec<UserListItem>> {
        self.client.get_json("/v1/login/users").await
    }

    /// El Handy nunca hace el setup inicial: es cosa de la Main, que es donde vive el admin del
    /// negocio. Para el arranque del Handy la respuesta es siempre "no hay nada pendiente", y así
    /// la primera pantalla es el login sin preguntar a la nube.
    async fn setup_pendiente(&self) -> AppResult<SetupPendiente> {
        Ok(SetupPendiente {
            pendiente: false,
            // El Handy no tiene BD que perder: su recuperación es que la Main recupere la suya.
            requiere_recuperacion: false,
            id_usuario: None,
            nombre: None,
            email: None,
        })
    }

    async fn get_today_punch_status(&self, id_usuario: &str) -> AppResult<PunchStatus> {
        self.client
            .get_json(&format!("/v1/login/{id_usuario}/punch-status"))
            .await
    }

    async fn login(&self, id_usuario: &str, pin: &str) -> AppResult<LoginOk> {
        self.client
            .post_json("/v1/login/login", &json!({ "id_usuario": id_usuario, "pin": pin }))
            .await
    }

    // REV-06: `complete_initial_setup` NO se implementa aquí, y su ausencia es la corrección.
    // Mandaba el PIN a `/v1/login/complete-initial-setup`, que lo verificaba sin el bloqueo por
    // intentos de LOGIN-01 y sin mirar `Requiere_Setup`: un PIN de cuatro cifras, diez mil
    // combinaciones y ningún freno, y al acertar se le cambiaban PIN y correo a cualquier usuario
    // activo, administrador incluido. No tapaba ningún hueco real —la pantalla nunca rellenaba el
    // `pin_actual` que la ruta exigía, así que devolvía un 400— y no puede taparlo: una Handy no
    // llega a este flujo, porque una Main con el setup pendiente no pasa de su propia pantalla de
    // setup y por tanto no puede vincular ninguna Handy. Hereda el rechazo del puerto.

    async fn punch(&self, id_usuario: &str, pin: &str, tipo: &str) -> AppResult<PunchStatus> {
        // Sin fecha ni hora: las pone el worker con el reloj de este equipo (`X-Client-Now`, que el
        // transporte pone en todas las peticiones). Viajaron aquí y nadie las leía.
        let body = json!({
            "id_usuario": id_usuario,
            "pin": pin,
            "tipo": tipo,
        });
        self.client.post_json("/v1/login/punch", &body).await
    }

    async fn set_turno_partido(
        &self,
        id_usuario: &str,
        fecha: Option<String>,
        turno_partido: bool,
    ) -> AppResult<()> {
        let body = json!({
            "id_usuario": id_usuario,
            "turno_partido": turno_partido,
            "fecha": fecha,
        });
        let _: JsonValue = self
            .client
            .post_json("/v1/login/turno-partido", &body)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! REV-06: la Handy no elige el PIN inicial de nadie.

    use super::*;
    use tpv_application::ports::login::LoginRepository;

    #[tokio::test]
    async fn la_handy_no_completa_el_setup_inicial() {
        // La base apunta a un host que no existe: si esto saliera a la red, el error sería de red y
        // no el del puerto. Que falle sin moverse es justamente lo que se comprueba.
        let cliente = CloudClient::new("http://127.0.0.1:1", std::env::temp_dir()).unwrap();
        let repo = HttpLoginRepository::new(Arc::new(cliente));

        let e = repo
            .complete_initial_setup("admin", "4321", "ladron@bar.test")
            .await
            .expect_err("tiene que rechazarlo");

        let texto = format!("{e:?}");
        assert!(texto.contains("TPV principal"), "mensaje inesperado: {texto}");
    }
}
