# D10 — Configuración (negocio · ticket · email · contacto)

> **Ámbito.** Ajustes singleton del negocio: datos de empresa + logo + IVA, formato del ticket, datos
> de contacto, y **configuración de correo** (envío por el worker) usada para mandar pedidos a
> proveedores.
> **Capas:** `crates/tpv-infra-sqlite/src/configuracion.rs`, `email_config.rs` (repo),
> `apps/tpv-main/src-tauri/src/commands/{configuracion,email_config}.rs`,
> `use_cases/{configuracion,email_config}.rs`, `apps/cloud-worker-licensing/src/domains/{configuracion,email}/*`,
> FE `apps/tpv-main/src/features/configuracion/*` (se carga en stores Zustand).
>
> **Estado (revisado 2026-08-09).** Resueltos y retirados: CONF-01, CONF-02, CONF-03, CONF-04,
> CONF-05.

## Hallazgos abiertos

| ID | Sev | Título | Ubicación |
|----|-----|--------|-----------|
| CONF-06 | 🔵 | Doble implementación Rust/worker (parity) | `configuracion.rs` ↔ `configuracion.commands.ts` |

### CONF-06 🔵 Doble implementación
Instancia de **ARCH-01**; la paridad se mantiene a mano y falta el harness de tests de contrato →
ver [BACKLOG.md §Unificación](../BACKLOG.md#unificación-de-la-doble-implementación-mainworker).

---

## Qué se corrigió (referencia rápida)

| ID | Cómo quedó |
|----|------------|
| CONF-01 | Se **eliminó el modo SMTP propio** y la tabla `Email_Settings` (DB-04): no hay `Smtp_Password` en el esquema, ni en ningún DTO, ni replicable a la nube. Todo el correo sale por el worker (`/v1/email/enviar-pedido`). |
| CONF-02 | El logo viaja por el **mismo canal R2 que las imágenes de producto**; en `Business_Settings.Logo_DataUrl` se guarda solo la ruta relativa, así que la sentencia replicada es corta. Los `data:` heredados se siguen resolviendo verbatim (compatibilidad). |
| CONF-03 | La *header injection* no aplica: el subject se manda como campo JSON a la API de correo (no concatenado en cabeceras SMTP) y el `nombre_proveedor` está validado por zod. La atomicidad envío↔estado se resolvió en PROV-02. |
| CONF-04 | `IVA_Percent` y el resto de settings se validan en el dominio antes de escribir. |
| CONF-05 | `get_ticket` lee todas las columnas de `Ticket_Settings` (DPI, chars/línea, márgenes, fuente) y llegan al ticket. |
