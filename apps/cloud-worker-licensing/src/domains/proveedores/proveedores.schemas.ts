// src/domains/proveedores/proveedores.schemas.ts

import * as z from "zod";
import { zDineroOpcional } from "../../lib/dinero";

import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	ProveedorSaveInput as ContractProveedorSaveInput,
	ProveedoresSetVinculosInput,
} from "@tpv/contracts";

const idStr = z.string().trim().min(1);
const optNum = z.number().finite().min(0).nullish();

function cleanOptional(v: unknown): string | null {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
}

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => (s ?? "").toString().trim()).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

const optStr = z.string().nullish().transform(cleanOptional);

export const proveedorSaveSchema = z.object({
	id_proveedor: idStr.optional().nullish(),
	nombre_empresa: z.string().trim().min(1, "nombre_empresa required"),
	contacto: optStr,
	telefono: optStr,
	email: optStr,
	cif: optStr,
	informacion_adicional: optStr,
	nombre_imagen: optStr,
	ruta_imagen: optStr,
});

export const setVinculosSchema = z.object({
	producto_ids: z.array(z.string()).default([]).transform(normalizeIds),
});

type NullableProveedorFields =
	| "contacto"
	| "telefono"
	| "email"
	| "cif"
	| "informacion_adicional"
	| "nombre_imagen"
	| "ruta_imagen";

export type ProveedorSaveInput = Omit<
	ContractProveedorSaveInput,
	"id_proveedor" | NullableProveedorFields
> & {
	id_proveedor?: string | null;
} & {
	[K in NullableProveedorFields]?: ContractProveedorSaveInput[K] | null;
};

export type SetVinculosInput = Omit<ProveedoresSetVinculosInput, "id_proveedor">;

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GProveedorSave = Assert<SameKeys<z.infer<typeof proveedorSaveSchema>, ProveedorSaveInput>>;
type _GSetVinculos = Assert<SameKeys<z.infer<typeof setVinculosSchema>, SetVinculosInput>>;
