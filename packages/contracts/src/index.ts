// @tpv/contracts — barrel público.
//
// Re-exporta los tipos TypeScript autogenerados desde Rust (ts-rs) a partir de los
// DTOs de la crate `crates/tpv-contracts`. El frontend importa SIEMPRE desde aquí:
//
//   import type { ComandaDto, LineaComandaDto } from "@tpv/contracts";
//
// El contenido de ./generated lo escribe la tarea `generate-types` (ts-rs); no editar a mano.
export * from "./generated/bindings";

// Esquema del evento de telemetría (`SpoolEvent`), generado desde `crates/tpv-telemetry`
// (fuente única de verdad; OBS-05). Lo consume el endpoint de ingesta del worker `tpv-api`.
export * from "./generated/telemetry";
