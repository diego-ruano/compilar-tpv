//! Adaptador HTTP del cierre de caja (dominio `/v1/cuentas/cierres` del worker).
//!
//! **La Handy mira, no toca.** Las lecturas van por REST; cualquier escritura falla aquí mismo, sin
//! salir a la red. No es sólo comodidad: que el adaptador lo impida significa que ninguna pantalla,
//! por equivocada que esté, puede cerrar ni reabrir una caja desde una Handy. El worker lo vuelve a
//! rechazar por su cuenta (ver `soloLaMainEscribeCaja`), porque una regla que sólo vive en el
//! cliente no es una regla: es una sugerencia.

use tpv_domain::dinero::Dinero;
use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cierre_caja::{
    ApunteCaja, ApunteGuardado, ArmarCierre, CierreCajaRepository, RectificacionNueva,
};
use tpv_contracts::cierre_caja::{CierreDto, CierreResumenDto};
use tpv_domain::cierre_caja::TotalesCaja;

use crate::CloudClient;

pub struct HttpCierreCajaRepository {
    client: Arc<CloudClient>,
}

impl HttpCierreCajaRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

/// El «no» de la caja en una Handy, con el mismo texto que el worker (`caja_solo_en_main`): sea quien
/// sea el que lo diga, se lee igual. Antes cada escritura decía la suya, y la de dar de alta un gasto
/// hablaba de «Corregir un apunte de caja».
fn solo_main() -> AppError {
    AppError::conflict(crate::cuentas::CAJA_SOLO_EN_MAIN)
}

#[async_trait]
impl CierreCajaRepository for HttpCierreCajaRepository {
    async fn ultimo_cierre(&self) -> AppResult<Option<CierreDto>> {
        self.client.get_json("/v1/cuentas/cierres/ultimo").await
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

    /// Siempre 0: el aviso de caja sin cerrar lo da la Main, que es la única que puede cerrarla.
    async fn horas_periodo_abierto(&self) -> AppResult<i64> {
        Ok(0)
    }

    // ── De aquí abajo, cosas de la Main ──────────────────────────────────────────

    async fn totales_desde(&self, _desde: Option<&str>) -> AppResult<TotalesCaja> {
        Err(solo_main())
    }

    async fn comandas_sin_cobrar(&self) -> AppResult<(i64, i64)> {
        Err(solo_main())
    }

    /// Nada: la Handy lee de la nube, que tiene el histórico entero.
    async fn caja_por_bajar(&self, _desde: Option<&str>) -> AppResult<bool> {
        Ok(false)
    }

    async fn anulaciones_desde(&self, _desde: Option<&str>) -> AppResult<(i64, Dinero)> {
        Err(solo_main())
    }

    async fn cerrar_periodo(&self, _id_cierre: &str, _armar: ArmarCierre<'_>) -> AppResult<()> {
        Err(solo_main())
    }

    async fn reabrir(&self, _id_cierre: &str, _id_usuario: Option<&str>) -> AppResult<bool> {
        Err(solo_main())
    }

    async fn cierre_de_momento(&self, _momento: &str) -> AppResult<Option<CierreDto>> {
        Err(solo_main())
    }

    async fn apunte(&self, _tipo: ApunteCaja, _id: &str) -> AppResult<Option<ApunteGuardado>> {
        Err(solo_main())
    }

    async fn devoluciones_de(&self, _id_pago: &str) -> AppResult<Vec<ApunteGuardado>> {
        Err(solo_main())
    }

    async fn guardar_rectificacion(&self, _r: RectificacionNueva) -> AppResult<()> {
        Err(solo_main())
    }
}

#[cfg(test)]
mod tests {
    //! Lo que una Handy oye al intentar escribir en la caja es lo mismo, lo diga este adaptador o el
    //! worker: antes dar de alta un gasto decía «Corregir un apunte de caja sólo se puede hacer desde
    //! la Main…».

    use super::*;
    use crate::cuentas::{HttpCuentasRepository, CAJA_SOLO_EN_MAIN};
    use tpv_application::use_cases::rectificacion_caja as rect;
    use tpv_contracts::cuentas::CreateGastoInput;

    /// Un host que no existe: si algo saliera a la red, el error sería de red, no el de la caja.
    fn repos() -> (HttpCuentasRepository, HttpCierreCajaRepository) {
        let cliente = Arc::new(CloudClient::new("http://127.0.0.1:1", std::env::temp_dir()).unwrap());
        (HttpCuentasRepository::new(cliente.clone()), HttpCierreCajaRepository::new(cliente))
    }

    #[tokio::test]
    async fn dar_de_alta_un_gasto_desde_la_handy_dice_lo_mismo_que_el_worker() {
        let (cuentas, cierres) = repos();
        let e = rect::crear_gasto(
            &cuentas,
            &cierres,
            "u1",
            CreateGastoInput {
                id_gasto: None,
                fecha: "2026-05-10".into(),
                tipo_gasto: "Suministros".into(),
                concepto: "Hielo".into(),
                importe: Dinero::de_centimos(500),
                proveedor_id: None,
                pagado_con_caja: Some(true),
            },
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(e.to_string(), CAJA_SOLO_EN_MAIN);
    }

    #[tokio::test]
    async fn cerrar_y_deshacer_un_cierre_desde_la_handy_dicen_lo_mismo() {
        let (_, cierres) = repos();
        let e = cierres.totales_desde(None).await.unwrap_err();
        assert_eq!(e.to_string(), CAJA_SOLO_EN_MAIN);
        let e = cierres.reabrir("c1", None).await.unwrap_err();
        assert_eq!(e.to_string(), CAJA_SOLO_EN_MAIN);
        let e = cierres.cerrar_periodo("c1", &|_| unreachable!()).await.unwrap_err();
        assert_eq!(e.to_string(), CAJA_SOLO_EN_MAIN);
    }

    #[test]
    fn el_texto_es_el_del_worker() {
        let worker = include_str!("../../../apps/cloud-worker-licensing/src/lib/errorCodes.ts");
        assert!(
            worker.contains(&format!("caja_solo_en_main: \"{CAJA_SOLO_EN_MAIN}\"")),
            "el texto de `caja_solo_en_main` del worker ya no es «{CAJA_SOLO_EN_MAIN}»"
        );
    }
}
