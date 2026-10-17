//! # tpv-infra-sqlite
//!
//! Adaptador de **persistencia** de la arquitectura hexagonal del TPV.
//!
//! Implementa los puertos de repositorio definidos en `tpv-application::ports`
//! ejecutando SQL real contra la base de datos SQLite local (rusqlite, por medio de
//! `ejecutor`). Toda sentencia SQL del backend antiguo (`mesas.rs`, `inventario.rs`, ...) se
//! reubica aquí, dentro de repositorios que reciben la `Connection` del ejecutor.

// Tests de contrato Main(Rust)↔worker(TS). Son dos y fijan las dos mitades del contrato:
//   · escritura → el EFECTO de un comando (las filas que deja) es el mismo en los dos lados.
//   · lectura   → el VALOR DEVUELTO por una consulta es el mismo, y en el mismo orden.
// Ver `contract_tests.rs`, `contract_read_tests.rs` y `tests/contract/README.md`.
// Raíz común de los directorios temporales de los tests (y purga de los que dejó la ejecución
// anterior). Ver `test_temp.rs`.
#[cfg(test)]
mod test_temp;

#[cfg(test)]
mod contract_comun;
#[cfg(test)]
mod contract_read_tests;
#[cfg(test)]
mod contract_tests;
// Los planes de las consultas calientes, sin estadísticas (RI-02).
#[cfg(test)]
mod planes;

// Helpers de mapeo `Value` <-> tipos Rust:
pub mod mapping;

// Utilidades compartidas por repositorios (new_id, now_ms, …):
pub mod util;

// Manejo de conexiones: escritor único serializado + pool de lectura (WAL).
// Incluye la captura de escrituras al outbox (antes en `recording.rs`).
pub mod db;
pub mod ejecutor;

// Conexión / inicialización de la BD local (schema, migraciones, seed):
pub mod connection;

// Migraciones del esquema registradas en `_migrations` (nombre, hash SHA-256 y fecha de aplicación).
// Construyen las BDs nuevas, aplican las pendientes y rechazan cambios en las ya aplicadas.
// Ver `migrations.rs`.
pub mod migrations;

// Repositorios concretos (uno por agregado/módulo). Cada uno pide `db.read()` (pool de lectura)
// o `db.write()` (escritor único) según la operación; los helpers son genéricos sobre los traits
// `Reader`/`Writer` de `db.rs`.
pub mod auth;
pub mod avisos;
// El historial de caja (`Movimientos_Caja`, CUENTA-07): lo escriben el cobro, el gasto y la
// anulación, así que la sentencia vive en un sitio y no copiada en cada uno.
pub mod caja_movimientos;
pub mod cierre_caja;
pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub(crate) mod consumo_stock;
pub mod inventario;
pub mod jobs;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod reconciliacion;
pub mod recovery;
pub mod reservas;
pub mod reservas_web;
pub mod stats;
pub mod stock_alertas;
pub mod sync;
pub mod sync_reparacion;
pub mod tareas;
pub mod tickets;
pub mod trabajadores;
pub mod venta_rapida;
pub(crate) mod cobros_pendientes;
pub mod verifactu;
/// Exportacion de los registros de facturacion en ZIP (art. 8 RRSIF).
pub mod verifactu_export;

pub mod permisos;

pub(crate) mod consultas;
