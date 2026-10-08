use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ImagenApartada {
    pub rel_path: String,
    pub motivo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct EstadoColaImagenes {
    pub pendientes: u32,
    pub total_apartadas: u32,
    // Hasta 100 entradas por respuesta; el total permite detectar si quedan más.
    pub apartadas: Vec<ImagenApartada>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../packages/contracts/src/generated/bindings.ts")]
pub struct ReintentarImagenArgs {
    pub rel_path: String,
}
