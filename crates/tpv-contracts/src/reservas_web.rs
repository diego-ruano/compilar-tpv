//! Contratos (DTOs) de la reserva desde la web (docs/estudios/reservas-web.md).

use serde::{Deserialize, Serialize};

/// Lo que se configura en Configuración → Reservas, en el bloque de la web.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AjustesReservaWebDto {
    /// El interruptor general (`Business_Settings.Reserva_Web_Activa`).
    pub activa: bool,
    /// Los días cerrados de hoy en adelante, por fecha.
    pub cierres: Vec<CierreReservaWebDto>,
}

/// Un día en que la web no acepta reservas.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CierreReservaWebDto {
    pub id_cierre: String,
    pub dia_ymd: String,
    pub motivo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebActivarInput {
    pub activa: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebCierreInput {
    pub dia_ymd: String,
    pub motivo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebQuitarCierreInput {
    pub id_cierre: String,
}
