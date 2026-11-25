// src/domains/proveedores/proveedores.schemas.ts

import * as z from "zod";

import { MSG_TEXTO_DEMASIADO_LARGO, cabeEnTextoLibre, recortar } from "../../lib/texto";
import { esImagenGuardable, MSG_IMAGEN_NO_VALIDA } from "../images/rutaDeImagen";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	ProveedorSaveInput as ContractProveedorSaveInput,
	ProveedoresSetVinculosInput,
} from "@tpv/contracts";

const idStr = z.string().overwrite(recortar).min(1);

function cleanOptional(v: unknown): string | null {
	const t = recortar((v ?? "").toString());
	return t.length ? t : null;
}

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => recortar((s ?? "").toString())).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

const optStr = z.string().nullish().transform(cleanOptional);

export const proveedorSaveSchema = z.object({
	id_proveedor: idStr.optional().nullish(),
	nombre_empresa: z.string().overwrite(recortar).min(1, "Escribe el nombre del proveedor."),
	contacto: optStr,
	telefono: optStr,
	email: optStr,
	cif: optStr,
	// AUD-36: con un máximo, como en la Main.
	informacion_adicional: optStr.refine(cabeEnTextoLibre, MSG_TEXTO_DEMASIADO_LARGO),
	nombre_imagen: optStr,
	// AUD-31: una ruta de `save_image` o nada, como en la Main (`validar_ruta_imagen`).
	ruta_imagen: z.string().refine(esImagenGuardable, MSG_IMAGEN_NO_VALIDA).nullish().transform(cleanOptional),
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
