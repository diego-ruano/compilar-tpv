//! # tpv-infra-sqlite
//!
//! Adaptador de **persistencia** de la arquitectura hexagonal del TPV.
//!
//! Implementa los puertos de repositorio definidos en `tpv-application::ports`
//! ejecutando SQL real contra la base de datos SQLite local (libsql). Toda
//! sentencia SQL del backend antiguo (`mesas.rs`, `inventario.rs`, ...) se reubica
//! aquí, dentro de repositorios que reciben la `Connection` de libsql.

// Tests de contrato Main(Rust)↔worker(TS). Son dos y fijan las dos mitades del contrato:
//   · escritura → el EFECTO de un comando (las filas que deja) es el mismo en los dos lados.
//   · lectura   → el VALOR DEVUELTO por una consulta es el mismo, y en el mismo orden.
// Ver `contract_tests.rs`, `contract_read_tests.rs` y `tests/contract/README.md`.
#[cfg(test)]
mod contract_comun;
#[cfg(test)]
mod contract_read_tests;
#[cfg(test)]
mod contract_tests;

// Helpers de mapeo libsql::Value <-> tipos Rust:
pub mod mapping;

// Utilidades compartidas por repositorios (next_table_id, now_ms, …):
pub mod util;

// Manejo de conexiones: escritor único serializado + pool de lectura (WAL).
// Incluye la captura de escrituras al outbox (antes en `recording.rs`).
pub mod db;

// Conexión / inicialización de la BD local (schema, migraciones, seed):
pub mod connection;

// Migraciones versionadas del esquema (PRAGMA user_version): traen al día las BDs ya existentes
// cuando una actualización modifica tablas. Ver `migrations.rs`.
pub mod migrations;

// Repositorios concretos (uno por agregado/módulo). Cada uno pide `db.read()` (pool de lectura)
// o `db.write()` (escritor único) según la operación; los helpers son genéricos sobre los traits
// `Reader`/`Writer` de `db.rs`.
pub mod auth;
pub mod avisos;
pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub mod inventario;
pub mod jobs;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod reconciliacion;
pub mod reservas;
pub mod stats;
pub mod stock_alertas;
pub mod sync;
pub mod tareas;
pub mod trabajadores;
pub mod venta_rapida;
