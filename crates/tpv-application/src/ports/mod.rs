//! Puertos (traits) que la infraestructura debe implementar.

pub mod avisos;
pub mod cierre_caja;
pub mod clientes;
pub mod configuracion;
pub mod correo_recuperacion;
pub mod cuentas;
pub mod diagnostico;
pub mod field_cipher;
pub mod inventario;
pub mod jobs;
pub mod licensing;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod reconciliacion;
pub mod recuperacion_pin;
pub mod reservas;
pub mod reservas_web;
pub mod stats;
pub mod stock_alertas;
pub mod subida_completa;
pub mod sync;
pub mod tareas;
pub mod tickets;
pub mod trabajadores;
pub mod venta_rapida;
pub mod verifactu;
pub mod verificacion_nube;

pub mod replicacion;

pub mod permisos;

pub mod canal_nube;
