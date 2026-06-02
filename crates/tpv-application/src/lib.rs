//! # tpv-application
//!
//! Capa de **aplicación** de la arquitectura hexagonal del TPV.
//!
//! Define los **puertos** (traits en `ports/`) que la infraestructura debe implementar
//! y los **casos de uso** (en `use_cases/`) que orquestan el dominio a través de esos
//! puertos. No conoce SQLite, red ni Tauri: sólo trabaja contra abstracciones.

pub mod error;

// Puertos (interfaces que implementan las crates de infraestructura):
// pub mod ports;

// Casos de uso (lógica de orquestación):
// pub mod use_cases;
