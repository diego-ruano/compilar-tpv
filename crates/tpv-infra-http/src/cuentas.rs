//! Adaptador HTTP del repositorio de cuentas/caja (dominio `/v1/cuentas` del worker).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};

use tpv_application::error::AppResult;
use tpv_application::ports::cuentas::CuentasRepository;
use tpv_contracts::cuentas::{EntradaDto, SalidaDto};
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

#[async_trait]
impl CuentasRepository for HttpCuentasRepository {
    async fn entradas(&self, del: Option<String>, al: Option<String>) -> AppResult<Vec<EntradaDto>> {
        self.client
            .get_query("/v1/cuentas/entradas", &rango(del, al))
            .await
    }

    async fn salidas(&self, del: Option<String>, al: Option<String>) -> AppResult<Vec<SalidaDto>> {
        self.client
            .get_query("/v1/cuentas/salidas", &rango(del, al))
            .await
    }

    async fn crear_gasto(&self, id: Option<i64>, gasto: GastoData) -> AppResult<bool> {
        let body = json!({
            "id_gasto": id,
            "fecha": gasto.fecha,
            "tipo_gasto": gasto.tipo_gasto,
            "concepto": gasto.concepto,
            "importe": gasto.importe,
            "proveedor_id": gasto.proveedor_id,
        });
        let _: JsonValue = self.client.post_json("/v1/cuentas/gastos", &body).await?;
        Ok(true)
    }

    async fn actualizar_gasto(&self, id_gasto: i64, gasto: GastoData) -> AppResult<bool> {
        let body = json!({
            "fecha": gasto.fecha,
            "tipo_gasto": gasto.tipo_gasto,
            "concepto": gasto.concepto,
            "importe": gasto.importe,
            "proveedor_id": gasto.proveedor_id,
        });
        let _: JsonValue = self
            .client
            .put_json(&format!("/v1/cuentas/gastos/{id_gasto}"), &body)
            .await?;
        Ok(true)
    }

    async fn eliminar_gasto(&self, id_gasto: i64) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/cuentas/gastos/{id_gasto}"))
            .await?;
        Ok(true)
    }

    async fn actualizar_pago(&self, id_pago: i64, pago: PagoData) -> AppResult<bool> {
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

    async fn eliminar_pago(&self, id_pago: i64) -> AppResult<bool> {
        let _: JsonValue = self
            .client
            .delete_json(&format!("/v1/cuentas/pagos/{id_pago}"))
            .await?;
        Ok(true)
    }
}
