// @tpv/contracts — barrel público.
//
// Re-exporta los tipos TypeScript autogenerados desde Rust (Specta) a partir de los
// DTOs de la crate `crates/tpv-contracts`. El frontend importa SIEMPRE desde aquí:
//
//   import type { ComandaDto, LineaComandaDto } from "@tpv/contracts";
//
// El contenido de ./generated lo escribe `pnpm generate-types`; no editar a mano.
export * from "./generated/bindings";

// SpoolEvent también se exporta en bindings.ts desde crates/tpv-telemetry (OBS-05).
