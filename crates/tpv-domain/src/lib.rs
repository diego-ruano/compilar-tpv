//! # tpv-domain
//!
//! Capa de **dominio** de la arquitectura hexagonal del TPV.
//!
//! Contiene exclusivamente entidades puras, value objects y reglas de negocio.
//! No depende de infraestructura (SQLite, red, sistema de archivos) ni de Tauri.
//!
//! Cada módulo de negocio (mesas, venta rápida, inventario, caja…) publica sus
//! entidades y validaciones puras.

pub mod cierre_caja;
pub mod clientes;
pub mod configuracion;
pub mod cantidad;
pub mod cuentas;
/// El tipo del dinero (ARQ-01): céntimos enteros de punta a punta.
pub mod dinero;
pub mod inventario;
pub mod licensing;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pago;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod reservas;
pub mod tareas;
/// Desglose de IVA: un unico calculo para el papel, la vista previa y el registro fiscal.
pub mod ticket;
pub mod trabajadores;
pub mod venta_rapida;
/// Veri*factu (FISCAL-01): huella, importes, QR, NIF. Puro y con los vectores oficiales.
pub mod verifactu;

pub mod permisos;

pub mod texto;
pub mod estados;
