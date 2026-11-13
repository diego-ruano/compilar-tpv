//! Casos de uso: orquestan dominio + puertos. Sin SQL ni detalles de Tauri.

pub mod avisos;
pub mod cierre_caja;
pub mod clientes;
pub mod configuracion;
pub mod correo_recuperacion;
pub mod cuentas;
pub mod interruptores;
pub mod inventario;
pub mod jobs;
pub mod licensing;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pairing;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod reconciliacion;
pub mod rectificacion_caja;
pub mod recuperacion_pin;
pub mod reservas;
pub mod reservas_web;
pub mod reservas_web_avisos;
pub mod reservas_web_recogida;
pub mod stats;
pub mod stock_alertas;
pub mod sync;
pub mod tareas;
pub mod tickets;
pub mod trabajadores;
pub mod venta_rapida;
pub mod verifactu;

pub mod replicacion;

pub mod permisos;

pub mod avisos_nube;

pub mod presencia_handy;
pub mod saludo_socket;
