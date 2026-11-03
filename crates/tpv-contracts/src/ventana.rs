//! Contratos de la **ventana de escritorio**: el tamaño de la interfaz (zoom).

use serde::{Deserialize, Serialize};

/// El zoom de la ventana tal como está ahora.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ZoomVentana {
    /// El aplicado, en tanto por ciento (`85` es el 85 %). Entero a propósito: un `f64` viaja como
    /// `number | null`, porque un NaN se serializa como `null`.
    pub porcentaje: u32,
    /// `true` si lo decide el monitor; `false` si alguien lo ha fijado en este equipo.
    pub automatico: bool,
}

/// Lo que se pide desde la barra de arriba.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CambioZoom {
    Acercar,
    Alejar,
    /// Volver a que lo decida el monitor.
    Automatico,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CambioZoomArgs {
    pub cambio: CambioZoom,
}
