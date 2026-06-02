// @tpv/contracts — barrel público.
//
// Re-exporta los tipos TypeScript autogenerados desde Rust (ts-rs) a partir de los
// DTOs de la crate `crates/tpv-contracts`. El frontend importa SIEMPRE desde aquí:
//
//   import type { ComandaDto, LineaComandaDto } from "@tpv/contracts";
//
// El contenido de ./generated lo escribe la tarea `generate-types` (ts-rs); no editar a mano.
export * from "./generated/bindings";
