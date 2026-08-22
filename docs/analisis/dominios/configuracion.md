# D10 — Configuración (negocio · ticket · email · contacto)

> **Ámbito.** Ajustes singleton del negocio: datos de empresa + logo + IVA, formato del ticket, datos
> de contacto, y **configuración de correo** (envío por el worker) usada para mandar pedidos a
> proveedores.
> **Capas:** `crates/tpv-infra-sqlite/src/configuracion.rs`, `email_config.rs` (repo),
> `apps/tpv-main/src-tauri/src/commands/{configuracion,email_config}.rs`,
> `use_cases/{configuracion,email_config}.rs`, `apps/cloud-worker-licensing/src/domains/{configuracion,email}/*`,
> FE `apps/tpv-main/src/features/configuracion/*` (se carga en stores Zustand).

## Hallazgos abiertos

Ninguno.


