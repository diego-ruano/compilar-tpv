//! Estados cerrados del dominio (RI-48); el texto se adapta en las fronteras.
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, strum::EnumString, strum::IntoStaticStr, strum::VariantArray)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE", ascii_case_insensitive)]
pub enum EstadoCocina { Pendiente, Preparado }
impl EstadoCocina {
    pub fn desde_texto(s: &str) -> Result<Self, String> {
        s.trim().parse().map_err(|_| format!("Estado no admitido: '{s}'"))
    }
    pub fn como_texto(self) -> &'static str { self.into() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, strum::EnumString, strum::IntoStaticStr, strum::VariantArray)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE", ascii_case_insensitive)]
pub enum EstadoReserva { Proxima, Activa, Finalizada, Cancelada, NoShow }
impl EstadoReserva {
    pub fn desde_texto(s: &str) -> Result<Self, String> {
        s.trim().parse().map_err(|_| format!("Estado no admitido: '{s}'"))
    }
    pub fn como_texto(self) -> &'static str { self.into() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, strum::EnumString, strum::IntoStaticStr, strum::VariantArray)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE", ascii_case_insensitive)]
pub enum EstadoTarea { Abierta, Eliminada }
impl EstadoTarea {
    pub fn como_texto(self) -> &'static str { self.into() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, strum::EnumString, strum::IntoStaticStr, strum::VariantArray)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE", ascii_case_insensitive)]
pub enum EstadoAsignacion { Pendiente, Finalizada }
impl EstadoAsignacion {
    pub fn desde_texto(s: &str) -> Result<Self, String> {
        s.trim().parse().map_err(|_| format!("Estado no admitido: '{s}'"))
    }
    pub fn como_texto(self) -> &'static str { self.into() }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, strum::EnumString, strum::IntoStaticStr, strum::VariantArray)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[strum(serialize_all = "SCREAMING_SNAKE_CASE", ascii_case_insensitive)]
pub enum EstadoFichaje { Abierto, Cerrado }
impl EstadoFichaje {
    pub fn desde_texto(s: &str) -> Result<Self, String> {
        s.trim().parse().map_err(|_| format!("Estado no admitido: '{s}'"))
    }
    pub fn como_texto(self) -> &'static str { self.into() }
}
