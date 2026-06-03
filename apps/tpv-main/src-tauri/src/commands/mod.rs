//! Comandos Tauri **finos**: inyectan el estado (`AppState`), obtienen la conexión,
//! construyen el repositorio de infraestructura e invocan el caso de uso de
//! `tpv-application`. No contienen SQL ni reglas de negocio.

pub mod clientes;
pub mod configuracion;
pub mod cuentas;
pub mod inventario;
pub mod login;
pub mod mesas;
pub mod proveedores;
pub mod reservas;
pub mod stats;
pub mod tareas;
pub mod trabajadores;
pub mod venta_rapida;
