//! # tpv-infra-http
//!
//! Adaptador **HTTP** del TPV para el **modo Handy** (dispositivos secundarios que no tienen
//! BD local). Implementa los mismos puertos de `tpv-application` que `tpv-infra-sqlite`, pero
//! en vez de consultar SQLite hace peticiones al worker unificado `tpv-api` en la nube.
//!
//! La autenticación (cabeceras device-proof: token + ts + firma ed25519) se delega en el
//! `PairingAdapter` de `tpv-infra-licensing`, así no se duplica la cripto. El `CloudClient`
//! es el transporte compartido; cada módulo añade su propio `Http…Repository` encima de él.
//!
//! NO depende de Tauri: el directorio de datos (AppData) lo inyecta el shell al construir
//! el cliente.
//!
//! ## Cobertura
//! Implementados contra los dominios del worker (`/v1/<modulo>/*`): clientes, configuracion,
//! cuentas, reservas, tareas, trabajadores, proveedores, stats, venta_rapida, inventario,
//! mesas y login. Excepción conocida:
//! - los métodos de **barra** de `MesasRepository` (el worker los sirve bajo `venta_rapida`):
//!   se implementan como error explícito `endpoint_no_disponible_en_handy`.

pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub mod inventario;
pub mod login;
pub mod mesas;
pub mod proveedores;
pub mod reservas;
pub mod stats;
pub mod tareas;
pub mod trabajadores;
pub mod venta_rapida;

mod client;
pub use client::{CloudClient, CLOUD_API_BASE};

use serde_json::Value;
use tpv_application::error::{AppError, AppResult};

/// Extrae un id entero de una respuesta JSON del worker (p. ej. `{ "id_comanda": 12 }`).
pub(crate) fn extract_id(v: &Value, key: &str) -> AppResult<i64> {
    v.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::external(format!("respuesta sin '{key}': {v}")))
}
