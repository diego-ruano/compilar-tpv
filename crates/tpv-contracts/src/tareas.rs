//! Contratos (DTOs) de la frontera UI<->Rust para **tareas**.
//! Los DTOs de salida conservan los nombres PascalCase vía `#[serde(rename)]`
//! (compat con el frontend que mapea por esas claves). Local-First: los args de
//! entrada NO llevan op_id/outbox/remote_id.

use serde::{Deserialize, Serialize};
/* =========================================================
   Salida (read models)
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TrabajadorUI {
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: String,
    #[serde(rename = "ID_Usuario")]
    pub id_usuario: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Apellido")]
    pub apellido: Option<String>,
    #[serde(rename = "Puesto")]
    pub puesto: Option<String>,
    #[serde(rename = "Email")]
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TareaAdminRow {
    #[serde(rename = "ID_Tarea")]
    pub id_tarea: String,
    #[serde(rename = "Titulo")]
    pub titulo: String,
    #[serde(rename = "Descripcion")]
    pub descripcion: Option<String>,
    #[serde(rename = "Fecha_Creacion")]
    pub fecha_creacion: String,
    #[serde(rename = "Fecha_Limite")]
    pub fecha_limite: Option<String>,
    #[serde(rename = "Total_Asignados")]
    pub total_asignados: i64,
    #[serde(rename = "Total_Finalizadas")]
    pub total_finalizadas: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TareaRow {
    #[serde(rename = "ID_Tarea")]
    pub id_tarea: String,
    #[serde(rename = "Titulo")]
    pub titulo: String,
    #[serde(rename = "Descripcion")]
    pub descripcion: Option<String>,
    #[serde(rename = "Fecha_Creacion")]
    pub fecha_creacion: String,
    #[serde(rename = "Fecha_Limite")]
    pub fecha_limite: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct TareaAsignadoRow {
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Apellido")]
    pub apellido: Option<String>,
    #[serde(rename = "Puesto")]
    pub puesto: Option<String>,
    #[serde(rename = "Asignada_At")]
    pub asignada_at: String,
    #[serde(rename = "Estado")]
    pub estado: String,
    #[serde(rename = "Finalizada_At")]
    pub finalizada_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct MisTareasRow {
    #[serde(rename = "ID_Tarea")]
    pub id_tarea: String,
    #[serde(rename = "Titulo")]
    pub titulo: String,
    #[serde(rename = "Descripcion")]
    pub descripcion: Option<String>,
    #[serde(rename = "Fecha_Limite")]
    pub fecha_limite: Option<String>,
    #[serde(rename = "Asignada_At")]
    pub asignada_at: String,
    #[serde(rename = "Estado")]
    pub estado: String,
    #[serde(rename = "Finalizada_At")]
    pub finalizada_at: Option<String>,
}

/* =========================================================
   Entrada (args/inputs) — Local-First
========================================================= */

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CreateTareaInput {
    pub titulo: String,
    #[serde(default)]
    pub descripcion: Option<String>,
    #[serde(default)]
    pub fecha_limite: Option<String>,
    #[serde(default)]
    pub ids_trabajadores: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct UpdateTareaInput {
    pub id_tarea: String,
    pub titulo: String,
    #[serde(default)]
    pub descripcion: Option<String>,
    #[serde(default)]
    pub fecha_limite: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct SetAsignacionesTareaInput {
    pub id_tarea: String,
    #[serde(default)]
    pub ids_trabajadores: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct FinalizarTareaInput {
    pub id_tarea: String,
    pub id_trabajador: String,
}

/// Argumento con sólo el id de tarea (get por id, asignados, borrar).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TareaIdArgs {
    pub id_tarea: String,
}

/// Argumento con sólo el id de trabajador (mis tareas).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MisTareasArgs {
    pub id_trabajador: String,
}
