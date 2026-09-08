//! Comandos Tauri **finos**: inyectan el estado (`AppState`), obtienen la conexión,
//! construyen el repositorio de infraestructura e invocan el caso de uso de
//! `tpv-application`. No contienen SQL ni reglas de negocio.

pub mod cierre_caja;
pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub mod email_config;
pub mod inventario;
pub mod jobs;
pub mod licensing;
pub mod login;
pub mod mesas;
pub mod notificaciones;
pub mod pairing;
pub mod pedidos_proveedor;
pub mod proveedores;
pub mod recovery;
pub mod reservas;
pub mod stats;
pub mod sync;
pub mod tareas;
pub mod trabajadores;
pub mod venta_rapida;
pub mod verifactu;
