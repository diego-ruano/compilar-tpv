//! Contratos de autorización y edición de permisos por rol (RI-70).
use serde::{Deserialize, Serialize};
use ts_rs::TS;
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct PermisoDef { pub codigo: String, pub nombre: String, pub grupo: String }
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct AutorizacionUsuario { pub rol: String, pub permisos: Vec<String> }
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct RolPermisos { pub id_rol: String, pub nombre: String, pub permisos: Vec<String> }
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ConfiguracionPermisos { pub catalogo: Vec<PermisoDef>, pub roles: Vec<RolPermisos> }
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct GuardarPermisosInput { pub id_rol: String, pub permisos_vistos: Vec<String>, pub permisos: Vec<String> }
