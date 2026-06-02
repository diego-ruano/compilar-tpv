//! # tpv-infra-sqlite
//!
//! Adaptador de **persistencia** de la arquitectura hexagonal del TPV.
//!
//! Implementa los puertos de repositorio definidos en `tpv-application::ports`
//! ejecutando SQL real contra la base de datos SQLite local (libsql). Toda
//! sentencia SQL del backend antiguo (`mesas.rs`, `inventario.rs`, ...) se reubica
//! aquí, dentro de repositorios que reciben la `Connection` de libsql.

// Conexión / inicialización de la BD local (schema, migraciones, seed):
// pub mod connection;

// Helpers de mapeo libsql::Value <-> tipos de dominio:
// pub mod mapping;

// Repositorios concretos (uno por agregado/módulo):
// pub mod mesas;
// pub mod inventario;
// ...
