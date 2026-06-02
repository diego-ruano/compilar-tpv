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
    #[ts(type = "number | null")]
    pub proveedor_id: Option<i64>,
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
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct CreateGastoInput {
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub id_gasto: Option<i64>,
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub proveedor_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpdateGastoInput {
    #[ts(type = "number")]
    pub id_gasto: i64,
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub proveedor_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DeleteGastoInput {
    #[ts(type = "number")]
    pub id_gasto: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct UpdatePagoInput {
    #[ts(type = "number")]
    pub id_pago: i64,
    pub fecha_hora: String,
    pub metodo: String,
    pub importe: f64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct DeletePagoInput {
    #[ts(type = "number")]
    pub id_pago: i64,
}
