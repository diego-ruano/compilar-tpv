//! # tpv-infra-licensing
//!
//! Adaptador de **licenciamiento e identidad de dispositivo** de la arquitectura
//! hexagonal del TPV.
//!
//! Reúne toda la lógica de bajo nivel que antes vivía en `licensing.rs` y `pairing.rs`:
//! generación/almacenamiento de la clave ed25519 (keyring), firma de cabeceras,
//! hashing y las llamadas HTTP (reqwest) al worker de licencias. Implementa los
//! puertos `LicenseService` / `DeviceIdentity` definidos en `tpv-application::ports`.
//!
//! La app (`apps/tpv-main/src-tauri/src/commands/licensing.rs`) sólo expondrá comandos
//! Tauri finos que invocan este servicio a través del `AppState`.

// pub mod device_identity; // clave ed25519, keyring, firma
// pub mod license_client;  // HTTP al worker de licencias
