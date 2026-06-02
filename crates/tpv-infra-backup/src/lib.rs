//! # tpv-infra-backup
//!
//! Adaptador de **backup** de la arquitectura hexagonal del TPV.
//!
//! Implementa los puertos de backup de `tpv-application` sobre el sistema de archivos
//! (copias locales del `data.db` / imágenes) y la red (subida de backups al worker).
//! Sustituye la antigua sincronización en tiempo real: la nube pasa de "sync" a "backup".

// pub mod fs_backup;     // copia/restaura backups locales
// pub mod network_backup; // sube backups al endpoint remoto
