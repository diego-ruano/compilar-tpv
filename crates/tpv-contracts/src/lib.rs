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
pub mod cuentas;
pub mod proveedores;
pub mod reservas;

// Los módulos de contratos por dominio se añaden durante la migración:
// pub mod mesas;
// pub mod venta_rapida;
// ...
