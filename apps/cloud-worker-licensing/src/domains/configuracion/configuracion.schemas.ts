// src/domains/configuracion/configuracion.schemas.ts

import { z } from "zod";

import type { Assert, SameKeys } from "../../lib/typeGuards";
import type { ConfigPatchInput } from "@tpv/contracts";

export const configPatchSchema = z.object({
	patch: z.record(z.unknown()).default({}),
});

export type { ConfigPatchInput };

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GConfigPatch = Assert<SameKeys<z.infer<typeof configPatchSchema>, ConfigPatchInput>>;
