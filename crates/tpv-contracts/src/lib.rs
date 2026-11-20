//! # tpv-contracts
//!
//! **Contratos** de la frontera UI <-> Rust.
//!
//! Aquí viven los DTOs (Data Transfer Objects) que cruzan la frontera Tauri: lo que
//! los comandos reciben como argumentos y devuelven como resultado. Cada DTO deriva
//! `Serialize`/`Deserialize` (serde) y `specta::Type` para autogenerar su equivalente
//! TypeScript en `packages/contracts/src/generated/bindings.ts`.
//!
//! Regla: el dominio (`tpv-domain`) permanece puro; los tipos que se exponen a la UI
//! se definen o se re-exportan aquí con la macro `#[derive(specta::Type)]`.

pub mod cierre_caja;
pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub mod diagnostico;
pub mod email_config;
pub mod impresion;
pub mod errors;
pub mod interruptores;
pub mod inventario;
pub mod jobs;
pub mod licensing;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod recovery;
pub mod reservas;
pub mod reservas_web;
pub mod stats;
pub mod sync;
pub mod tareas;
pub mod telemetria;
pub mod trabajadores;
pub mod venta_rapida;
pub mod ventana;
pub mod verifactu;

pub mod permisos;

pub mod socket_handy;

pub mod imagenes;

pub mod json;
