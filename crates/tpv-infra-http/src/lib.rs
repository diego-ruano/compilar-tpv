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
//! Un módulo por puerto, contra las rutas del worker (`/v1/…`): cierre_caja, clientes, configuracion,
//! cuentas, inventario, login, mesas, notificaciones, pedidos_proveedor, permisos, proveedores,
//! reservas, stats, tareas, trabajadores y venta_rapida.

pub mod cierre_caja;
pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub mod inventario;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod reservas;
pub mod stats;
pub mod tareas;
pub mod trabajadores;
pub mod venta_rapida;

mod client;
pub use client::{CloudClient, CLOUD_API_BASE};

pub mod permisos;

pub mod websocket;

#[cfg(test)]
mod tests_sin_datos_en_la_url;
