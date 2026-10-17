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

/// Cómo se puede reservar una mesa desde la web: la casilla y su franja. La pantalla edita una
/// franja por mesa aunque el esquema admita varias.
///
/// `dias_semana` es la máscara de `Reserva_Web_Franjas` (1 lunes … 64 domingo; 127 = todos). Sin
/// franja guardada, las horas llegan vacías.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebMesaDto {
    pub id_mesa: String,
    pub activa: bool,
    pub dias_semana: i64,
    pub fecha_desde: Option<String>,
    pub fecha_hasta: Option<String>,
    pub hora_desde: Option<String>,
    pub hora_hasta: Option<String>,
}

/// Lo que guarda la pantalla para una mesa. Mismos campos que [`ReservaWebMesaDto`].
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ReservaWebMesaInput {
    pub id_mesa: String,
    pub activa: bool,
    pub dias_semana: i64,
    pub fecha_desde: Option<String>,
    pub fecha_hasta: Option<String>,
    pub hora_desde: Option<String>,
    pub hora_hasta: Option<String>,
}
