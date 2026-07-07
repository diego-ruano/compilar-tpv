//! Contratos (DTOs) de la frontera UI<->Rust para **cuentas** (caja).
//! Campos snake_case idénticos a los structs antiguos (compat frontend).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Fila de entradas (cobros). `id` es String (igual que el backend antiguo).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct EntradaDto {
    pub id: String,
    pub fecha_hora: String,
    pub cliente: String,
    pub metodo: String,
    pub importe: f64,
}

/// Fila de salidas (gastos).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct SalidaDto {
    pub id: String,
    pub fecha_hora: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    pub proveedor_id: Option<String>,
}

/* ── Args/Inputs ── */

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CuentasRangoArgs {
    #[serde(default)]
    #[ts(optional)]
    pub del: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub al: Option<String>,
    /// Búsqueda de texto (server-side): filtra por fecha/cliente/concepto/método/importe.
    #[serde(default)]
    #[ts(optional)]
    pub q: Option<String>,
    /// Página 1-based. Si es `None`, se devuelven **todas** las filas (usado por el PDF).
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub page: Option<u32>,
    /// Tamaño de página. Si es `None`/0 junto con `page`, se ignora la paginación.
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub page_size: Option<u32>,
}

/// Resumen agregado de caja para un rango (+ búsqueda opcional). Se calcula en SQL sobre TODO el
/// rango, de modo que las cifras de cabecera son correctas aunque la lista esté paginada.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ResumenCajaDto {
    pub total_entradas: f64,
    pub total_salidas: f64,
    pub total_efectivo: f64,
    pub total_tarjeta: f64,
    #[ts(type = "number")]
    pub count_entradas: i64,
    #[ts(type = "number")]
    pub count_salidas: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CreateGastoInput {
    #[serde(default)]
    #[ts(optional)]
    pub id_gasto: Option<String>,
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    #[serde(default)]
    #[ts(optional)]
    pub proveedor_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpdateGastoInput {
    pub id_gasto: String,
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    #[serde(default)]
    #[ts(optional)]
    pub proveedor_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DeleteGastoInput {
    pub id_gasto: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpdatePagoInput {
    pub id_pago: String,
    pub fecha_hora: String,
    pub metodo: String,
    pub importe: f64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DeletePagoInput {
    pub id_pago: String,
}
