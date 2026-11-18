//! Adaptador HTTP del repositorio de cuentas/caja (dominio `/v1/cuentas` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cuentas::{
    AnularPagoArgs, CuentasFiltro, CuentasRepository, DevolverLineasArgs,
};
use tpv_contracts::cuentas::{
    AnulacionPagoDto, CobroDevolubleDto, DestinoLineasBaja, DevolucionDto, PaginaEntradas, PaginaSalidas, ResumenCajaDto,
};
use tpv_domain::cuentas::{GastoData, PagoData};

use crate::CloudClient;

pub struct HttpCuentasRepository {
    client: Arc<CloudClient>,
}

impl HttpCuentasRepository {
    pub fn new(client: Arc<CloudClient>) -> Self {
        Self { client }
    }
}

/// Lo que se busca, o `None` si no hay nada escrito.
/// Lo que dice una Handy que intenta escribir en la caja: el mismo texto que el worker
/// (`caja_solo_en_main` en `lib/errorCodes.ts`), lo diga quien lo diga.
pub(crate) const CAJA_SOLO_EN_MAIN: &str = "La caja sólo se gestiona desde el TPV principal.";

fn busqueda(q: Option<&String>) -> Option<&String> {
    q.filter(|s| !s.trim().is_empty())
}

/// El cuerpo de un listado: rango + búsqueda + paginación por clave (el cursor va en dos campos
/// planos, `cursor_fecha` y `cursor_id`, igual que en `CuentasRangoArgs`).
///
/// AUD-27: va en el cuerpo de un POST y no en la query. Lo que se busca es texto que escribe
/// alguien (el nombre de un cliente, un concepto) y la URL se queda en los registros de la nube.
fn cuerpo_listado(filtro: &CuentasFiltro) -> JsonValue {
    json!({
        "del": filtro.del,
        "al": filtro.al,
        "q": busqueda(filtro.q.as_ref()),
        "page_size": filtro.page_size,
        "cursor_fecha": filtro.cursor.as_ref().map(|c| &c.fecha),
        "cursor_id": filtro.cursor.as_ref().map(|c| &c.id),
    })
}

/// El cuerpo del resumen: el mismo rango y la misma búsqueda, sin paginar (AUD-27).
fn cuerpo_resumen(del: Option<String>, al: Option<String>, q: Option<String>) -> JsonValue {
    json!({ "del": del, "al": al, "q": busqueda(q.as_ref()) })
}

#[async_trait]
impl CuentasRepository for HttpCuentasRepository {
    async fn entradas(&self, filtro: CuentasFiltro) -> AppResult<PaginaEntradas> {
        self.client
            .post_lectura("/v1/cuentas/entradas", &cuerpo_listado(&filtro))
            .await
    }

    async fn salidas(&self, filtro: CuentasFiltro) -> AppResult<PaginaSalidas> {
        self.client
            .post_lectura("/v1/cuentas/salidas", &cuerpo_listado(&filtro))
            .await
    }

    async fn resumen(
        &self,
        del: Option<String>,
        al: Option<String>,
        q: Option<String>,
    ) -> AppResult<ResumenCajaDto> {
        self.client
            .post_lectura("/v1/cuentas/resumen", &cuerpo_resumen(del, al, q))
            .await
    }

    async fn crear_gasto(
        &self,
        id: Option<String>,
        gasto: GastoData,
        _id_usuario: Option<&str>,
    ) -> AppResult<bool> {
        let generado = id.is_none().then_some("id_gasto");
        let id_gasto = id.unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let body = json!({
            "id_gasto": id_gasto,
            "fecha": gasto.fecha,
            "tipo_gasto": gasto.tipo_gasto,
            "concepto": gasto.concepto,
            "importe": gasto.importe,
            "proveedor_id": gasto.proveedor_id,
            "pagado_con_caja": gasto.pagado_con_caja,
        });
        let _: (JsonValue, _) = self
            .client
            .post_json_creando("/v1/cuentas/gastos", &body, generado)
            .await?;
        Ok(true)
    }

    async fn actualizar_gasto(&self, id_gasto: &str, gasto: GastoData) -> AppResult<bool> {
        let body = json!({
            "fecha": gasto.fecha,
            "tipo_gasto": gasto.tipo_gasto,
            "concepto": gasto.concepto,
            "importe": gasto.importe,
            "proveedor_id": gasto.proveedor_id,
            "pagado_con_caja": gasto.pagado_con_caja,
        });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/cuentas/gastos/{id_gasto}"), &body)
            .await?;
        Ok(true)
    }

    async fn eliminar_gasto(&self, id_gasto: &str, _id_usuario: Option<&str>) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/cuentas/gastos/{id_gasto}"))
            .await?;
        Ok(true)
    }

    async fn actualizar_pago(&self, id_pago: &str, pago: PagoData) -> AppResult<bool> {
        let body = json!({
            "fecha_hora": pago.fecha_hora,
            "metodo": pago.metodo,
            "importe": pago.importe,
        });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/cuentas/pagos/{id_pago}"), &body)
            .await?;
        Ok(true)
    }

    /// El cajón cuelga de la impresora de la Main: una Handy no tiene ninguno que abrir.
    async fn registrar_apertura_cajon(&self, _id_usuario: Option<String>) -> AppResult<()> {
        Ok(())
    }

    /// No hay endpoint para esto, y devuelve `ACTIVO` **a propósito**.
    ///
    /// Lo que hace este método es dejar que el caso de uso siga adelante hasta la escritura, que es
    /// donde el worker dice que no (`caja_solo_en_main`). Devolver `None` sería más "honesto" y
    /// mucho peor: el caso de uso lo leería como «ese cobro no existe» y el botón no haría nada,
    /// sin error y sin explicación. Que la Handy no anula ya lo sabe la pantalla —la lista trae el
    /// estado de cada cobro— y lo vuelve a decir el servidor, que es donde la regla vale.
    async fn estado_pago(&self, _id_pago: &str) -> AppResult<Option<String>> {
        Ok(Some(tpv_domain::cuentas::ESTADO_ACTIVO.to_string()))
    }

    /// Devolver es cosa de la Main, como cobrar y anular: tiene la caja y la numeración de las
    /// facturas. No hay ruta en el worker, así que el «no» se dice aquí, con el mismo texto que
    /// el worker usa para el resto de la caja.
    async fn lineas_devolubles(&self, _id_pago: &str) -> AppResult<Option<CobroDevolubleDto>> {
        Err(AppError::conflict(CAJA_SOLO_EN_MAIN))
    }

    async fn devolver_lineas(&self, _args: DevolverLineasArgs) -> AppResult<DevolucionDto> {
        Err(AppError::conflict(CAJA_SOLO_EN_MAIN))
    }

    /// Anular es cosa de la Main; el worker rechaza esta escritura desde una Handy. Se manda
    /// igualmente para que el "no" venga de donde el usuario no manda.
    async fn anular_pago(&self, args: AnularPagoArgs) -> AppResult<AnulacionPagoDto> {
        let body = json!({ "id_usuario": args.id_usuario, "motivo": args.motivo });
        let id_pago = args.id_pago;
        let _: JsonValue = self
            .client
            .post_json(&format!("/v1/cuentas/pagos/{id_pago}/anular"), &body)
            .await?;
        Ok(AnulacionPagoDto { anulado: true, lineas: DestinoLineasBaja::NoVuelven, mesa: None })
    }
}

#[cfg(test)]
mod tests {
    //! AUD-27: lo que se busca en Cuentas viaja en el cuerpo, con los nombres de campo que lee el
    //! `listadoSchema` del worker.

    use super::*;
    use tpv_contracts::cuentas::CursorCuentas;

    #[test]
    fn el_listado_lleva_rango_busqueda_y_pagina_con_el_cursor_en_dos_campos() {
        let filtro = CuentasFiltro {
            del: Some("2026-11-01".into()),
            al: Some("2026-11-08".into()),
            q: Some("Cliente Ficticio".into()),
            page_size: Some(50),
            cursor: Some(CursorCuentas { fecha: "2026-11-08 13:05:00".into(), id: "p-1".into() }),
        };
        assert_eq!(
            cuerpo_listado(&filtro),
            json!({
                "del": "2026-11-01",
                "al": "2026-11-08",
                "q": "Cliente Ficticio",
                "page_size": 50,
                "cursor_fecha": "2026-11-08 13:05:00",
                "cursor_id": "p-1",
            })
        );
    }

    #[test]
    fn lo_que_no_se_pide_va_como_null_y_una_busqueda_en_blanco_no_se_manda() {
        let filtro = CuentasFiltro { q: Some("   ".into()), ..CuentasFiltro::default() };
        assert_eq!(
            cuerpo_listado(&filtro),
            json!({
                "del": null,
                "al": null,
                "q": null,
                "page_size": null,
                "cursor_fecha": null,
                "cursor_id": null,
            })
        );
    }

    #[test]
    fn el_resumen_lleva_el_mismo_rango_y_la_misma_busqueda() {
        assert_eq!(
            cuerpo_resumen(Some("2026-11-01".into()), None, Some("María José".into())),
            json!({ "del": "2026-11-01", "al": null, "q": "María José" })
        );
        assert_eq!(
            cuerpo_resumen(None, None, Some(" ".into())),
            json!({ "del": null, "al": null, "q": null })
        );
    }
}
