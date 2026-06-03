//! # tpv-infra-sqlite
//!
//! Adaptador de **persistencia** de la arquitectura hexagonal del TPV.
//!
//! Implementa los puertos de repositorio definidos en `tpv-application::ports`
//! ejecutando SQL real contra la base de datos SQLite local (libsql). Toda
//! sentencia SQL del backend antiguo (`mesas.rs`, `inventario.rs`, ...) se reubica
//! aquí, dentro de repositorios que reciben la `Connection` de libsql.

// Helpers de mapeo libsql::Value <-> tipos Rust:
pub mod mapping;

// Utilidades compartidas por repositorios (next_table_id, now_ms, …):
pub mod util;

// Conexión / inicialización de la BD local (schema, migraciones, seed):
// pub mod connection;

// Repositorios concretos (uno por agregado/módulo):
pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub mod inventario;
pub mod mesas;
pub mod proveedores;
pub mod reservas;
pub mod stats;
pub mod tareas;
pub mod trabajadores;
pub mod venta_rapida;
// pub mod mesas;
// pub mod inventario;
// ...
