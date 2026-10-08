use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ImagenApartada {
    pub rel_path: String,
    pub motivo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EstadoColaImagenes {
    pub pendientes: u32,
    pub total_apartadas: u32,
    // Hasta 100 entradas por respuesta; el total permite detectar si quedan más.
    pub apartadas: Vec<ImagenApartada>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReintentarImagenArgs {
    pub rel_path: String,
}
