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
// Lo que se teclea en un buscador, sin acentos ni mayúsculas: la expresión SQL de la columna.
pub(crate) mod busqueda;
// El historial de caja (`Movimientos_Caja`, CUENTA-07): lo escriben el cobro, el gasto y la
// anulación, así que la sentencia vive en un sitio y no copiada en cada uno.
pub mod caja_movimientos;
pub mod cierre_caja;
pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub(crate) mod consumo_stock;
// El resumen diario de las estadísticas (`_Estad_*`): una caché local que se rehace desde los cobros.
pub mod estadisticas_diarias;
// OBS-06: las referencias de imagen de la base, para renombrar las heredadas.
pub mod imagenes;
/// Ingredientes: catálogo, los de cada producto y sus borrados (lo usa el repo de inventario).
pub(crate) mod ingredientes;
pub mod inventario;
pub mod jobs;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod reconciliacion;
pub mod recovery;
pub mod sello;
pub mod reservas;
pub mod reservas_web;
pub mod reservas_web_avisos;
pub mod stats;
pub mod stock_alertas;
pub mod sync;
// SYNC-36: las filas que toca un cambio de la nube que no entra en esta base, y lo que se hace
// con su cuarentena: sus datos caducan y el contraste la cierra trayéndolas de la nube.
pub(crate) mod filas_tocadas;
pub(crate) mod cuarentenas_bajada;
// SYN-INC-07: dos fichas con el mismo correo (aquí y en la nube) se funden en la de la nube.
pub(crate) mod clave_natural;
// El contraste con la nube por resúmenes: el lado de la Main (`/v1/sync/verificar/*`).
pub(crate) mod contraste;
// SYNC-29: el orden de la nube manda. Lo que su orden dejó de otra forma aquí se trae de ella.
pub(crate) mod convergencia;
// SYNC-37: escribir de una vez filas que se intercambian un valor único.
pub(crate) mod aparcar;
pub mod sync_reparacion;
pub mod tareas;
pub mod tickets;
pub mod trabajadores;
pub mod venta_rapida;
pub(crate) mod cobros_pendientes;
pub mod verifactu;
// Lo que el contraste con la nube recuerda de sus pasadas (`_Verificacion_Nube`, VERIF-02).
pub mod verificacion_nube;

pub mod permisos;

pub(crate) mod consultas;
