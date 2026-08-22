# D6 — Reservas

> **Ámbito.** Reservas de mesa (calendario mensual, alta/edición, estado, borrado) y su vínculo con
> clientes y mesas. Incluye el `upsert_cliente` que crea/actualiza el cliente al reservar.
>
> **Identidad del cliente al reservar (decidido, no es un hallazgo).** Reservas deduplica por email y
> **también por teléfono**, y no valida el formato del email; la pantalla de Clientes solo deduplica
> por email (índice único `ux_clientes_email`) y sí lo valida. Es a propósito: una reserva se coge
> por teléfono y con datos a medias. Consecuencia asumida por el responsable (2026-08-22): si dos
> personas comparten teléfono, la reserva se engancha a la ficha existente y aparece con **su**
> nombre. Se acepta; no se toca. El merge no es destructivo (RES-01): reusar una ficha solo rellena
> huecos, nunca pisa datos.
> **Capas:** `crates/tpv-infra-sqlite/src/reservas.rs`, `use_cases/reservas.rs`,
> `crates/tpv-domain/src/reservas.rs`, `apps/cloud-worker-licensing/src/domains/reservas/*`,
> FE `apps/tpv-main/src/features/reservas/*` (React Query).
>
## Hallazgos abiertos

Ninguno.


