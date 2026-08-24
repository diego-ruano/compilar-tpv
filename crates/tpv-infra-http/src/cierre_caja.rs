//! Adaptador HTTP del cierre de caja (dominio `/v1/cuentas/cierres` del worker).
//!
//! **La Handy mira, no toca.** Las lecturas van por REST; cualquier escritura falla aquí mismo, sin
//! salir a la red. No es sólo comodidad: que el adaptador lo impida significa que ninguna pantalla,
//! por equivocada que esté, puede cerrar ni reabrir una caja desde una Handy. El worker lo vuelve a
//! rechazar por su cuenta (ver `soloLaMainEscribeCaja`), porque una regla que sólo vive en el
//! cliente no es una regla: es una sugerencia.

use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cierre_caja::{ApunteCaja, CierreCajaRepository, CierreNuevo};
use tpv_contracts::cierre_caja::{CierreDto, CierreResumenDto};

use crate::CloudClient;

pub struct HttpCierreCajaRepository {
    client: Arc<CloudClient>,
}

impl HttpCierreCajaRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

fn solo_main(que: &str) -> AppError {
    AppError::conflict(format!(
        "{que} sólo se puede hacer desde la Main: el cajón y el recuento están allí"
    ))
}

#[async_trait]
impl CierreCajaRepository for HttpCierreCajaRepository {
    async fn ultimo_cierre(&self) -> AppResult<Option<CierreDto>> {
        self.client.get_json("/v1/cuentas/cierres/ultimo").await
    }

    async fn corte_vigente(&self) -> AppResult<Option<String>> {
        Ok(self.ultimo_cierre().await?.map(|c| c.fecha_hora))
    }

    async fn listar(&self, limite: i64) -> AppResult<Vec<CierreResumenDto>> {
        self.client
            .get_query("/v1/cuentas/cierres", &[("limite", limite.to_string())])
            .await
    }

    async fn detalle(&self, id_cierre: &str) -> AppResult<Option<CierreDto>> {
        self.client
            .get_json(&format!("/v1/cuentas/cierres/{id_cierre}"))
            .await
    }

    /// Siempre `None`: el gate del periodo cerrado sólo corre antes de una escritura de caja, y
    /// desde una Handy no hay ninguna que pueda llegar aquí. Devolver `None` no abre una puerta —
    /// las escrituras fallan más abajo, y el worker las rechaza otra vez por su cuenta.
    async fn fecha_apunte(&self, _tipo: ApunteCaja, _id: &str) -> AppResult<Option<String>> {
        Ok(None)
    }

    /// Siempre 0: el aviso de caja sin cerrar lo da la Main, que es la única que puede cerrarla.
    async fn horas_periodo_abierto(&self) -> AppResult<i64> {
        Ok(0)
    }

    // ── De aquí abajo, cosas de la Main ──────────────────────────────────────────

    async fn ventas_efectivo_desde(&self, _desde: Option<&str>) -> AppResult<f64> {
        Err(solo_main("Preparar un cierre"))
    }

    async fn comandas_abiertas(&self) -> AppResult<i64> {
        Err(solo_main("Preparar un cierre"))
    }

    async fn crear(&self, _cierre: CierreNuevo) -> AppResult<()> {
        Err(solo_main("Cerrar la caja"))
    }

    async fn reabrir(&self, _id_cierre: &str, _id_usuario: Option<&str>) -> AppResult<bool> {
        Err(solo_main("Reabrir un cierre"))
    }
}
