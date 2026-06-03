//! # tpv-domain
//!
//! Capa de **dominio** de la arquitectura hexagonal del TPV.
//!
//! Contiene exclusivamente entidades puras, value objects y reglas de negocio.
//! No depende de infraestructura (SQLite, red, sistema de archivos) ni de Tauri.
//!
//! Durante la migración, cada módulo de negocio (mesas, venta_rapida, inventario,
//! caja, etc.) irá publicando aquí sus structs y validaciones puras.

pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub mod inventario;
pub mod login;
pub mod mesas;
pub mod proveedores;
pub mod reservas;
pub mod tareas;
pub mod trabajadores;
pub mod venta_rapida;

// Los submódulos de dominio se irán añadiendo módulo por módulo:
// pub mod mesas;
// pub mod venta_rapida;
// pub mod inventario;
// ...
