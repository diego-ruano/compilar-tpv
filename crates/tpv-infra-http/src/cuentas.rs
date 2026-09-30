//! Adaptador HTTP del repositorio de cuentas/caja (dominio `/v1/cuentas` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::cuentas::{AnularPagoArgs, CuentasFiltro, CuentasRepository};
use tpv_contracts::cuentas::{
    PaginaEntradas, PaginaSalidas, ResumenCajaDto, TicketReimpresionDto,
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

fn rango(del: Option<String>, al: Option<String>) -> Vec<(&'static str, String)> {
    let mut q = Vec::new();
    if let Some(d) = del {
        q.push(("del", d));
    }
    if let Some(a) = al {
        q.push(("al", a));
    }
    q
}

/// Query params de listado: rango + búsqueda + paginación por clave (el cursor va en dos
/// parámetros planos, `cursor_fecha` y `cursor_id`, igual que en `CuentasRangoArgs`).
fn listado_query(filtro: &CuentasFiltro) -> Vec<(&'static str, String)> {
    let mut q = rango(filtro.del.clone(), filtro.al.clone());
    if let Some(s) = filtro.q.as_ref().filter(|s| !s.trim().is_empty()) {
        q.push(("q", s.clone()));
    }
    if let Some(ps) = filtro.page_size {
        q.push(("page_size", ps.to_string()));
    }
    if let Some(c) = &filtro.cursor {
        q.push(("cursor_fecha", c.fecha.clone()));
        q.push(("cursor_id", c.id.clone()));
    }
    q
}

#[async_trait]
impl CuentasRepository for HttpCuentasRepository {
    async fn entradas(&self, filtro: CuentasFiltro) -> AppResult<PaginaEntradas> {
        self.client
            .get_query("/v1/cuentas/entradas", &listado_query(&filtro))
            .await
    }

    async fn salidas(&self, filtro: CuentasFiltro) -> AppResult<PaginaSalidas> {
        self.client
            .get_query("/v1/cuentas/salidas", &listado_query(&filtro))
            .await
    }

    async fn resumen(
        &self,
        del: Option<String>,
        al: Option<String>,
        q: Option<String>,
    ) -> AppResult<ResumenCajaDto> {
        let mut params = rango(del, al);
        if let Some(s) = q.filter(|s| !s.trim().is_empty()) {
            params.push(("q", s));
        }
        self.client.get_query("/v1/cuentas/resumen", &params).await
    }

    async fn crear_gasto(
        &self,
        id: Option<String>,
        gasto: GastoData,
        _id_usuario: Option<&str>,
    ) -> AppResult<bool> {
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
        let _: JsonValue = self.client.post_json("/v1/cuentas/gastos", &body).await?;
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

    /// Reimprimir es cosa de la Main: es la que tiene la impresora, y solo ella cobra. No hay
    /// endpoint en el worker para esto.
    async fn ticket_para_reimprimir(
        &self,
        _id_pago: &str,
    ) -> AppResult<Option<TicketReimpresionDto>> {
        Ok(None)
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

    /// Anular es cosa de la Main; el worker rechaza esta escritura desde una Handy. Se manda
    /// igualmente para que el "no" venga de donde el usuario no manda.
    async fn anular_pago(&self, args: AnularPagoArgs) -> AppResult<bool> {
        let body = json!({ "id_usuario": args.id_usuario, "motivo": args.motivo });
        let id_pago = args.id_pago;
        let _: JsonValue = self
            .client
            .post_json(&format!("/v1/cuentas/pagos/{id_pago}/anular"), &body)
            .await?;
        Ok(true)
    }
}
