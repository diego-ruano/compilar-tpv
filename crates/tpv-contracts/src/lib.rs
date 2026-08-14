//! # tpv-contracts
//!
//! **Contratos** de la frontera UI <-> Rust.
//!
//! Aquí viven los DTOs (Data Transfer Objects) que cruzan la frontera Tauri: lo que
//! los comandos reciben como argumentos y devuelven como resultado. Cada DTO deriva
//! `Serialize`/`Deserialize` (serde) y `TS` (ts-rs) para autogenerar su equivalente
//! TypeScript en `packages/contracts/src/generated/bindings.ts`.
//!
//! Regla: el dominio (`tpv-domain`) permanece puro; los tipos que se exponen a la UI
//! se definen o se re-exportan aquí con la macro `#[derive(TS)]`.

pub mod clientes;
pub mod configuracion;
pub mod email_config;
pub mod cuentas;
pub mod inventario;
pub mod jobs;
pub mod licensing;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod reservas;
pub mod stats;
pub mod sync;
pub mod tareas;
pub mod trabajadores;
pub mod venta_rapida;

// Los módulos de contratos por dominio se añaden durante la migración:
// pub mod mesas;
// pub mod venta_rapida;
// ...
