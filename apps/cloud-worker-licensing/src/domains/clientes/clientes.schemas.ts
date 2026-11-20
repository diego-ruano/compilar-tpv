// src/domains/clientes/clientes.schemas.ts

import * as z from "zod";

import { MSG_TEXTO_DEMASIADO_LARGO, cabeEnTextoLibre, recortar } from "../../lib/texto";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	CreateClienteInput as ContractCreateClienteInput,
	UpdateClienteInput as ContractUpdateClienteInput,
} from "@tpv/contracts";

const idStr = z.string().overwrite(recortar).min(1);

function cleanOptional(v: unknown): string | null {
	const t = recortar((v ?? "").toString());
	return t.length ? t : null;
}

const optStr = z.string().nullish().transform(cleanOptional);

// Misma regla que el dominio Rust (`validate_email_basic`): longitud mínima, contiene
// '@' y '.', sin espacios. Se mantiene idéntica para no divergir entre Main y worker.
export function isValidEmail(e: string): boolean {
	return e.length >= 6 && e.includes("@") && e.includes(".") && !e.includes(" ");
}

// Email opcional (CLI-04): vacío/ausente => null; si hay valor se normaliza a minúsculas
// (unicidad case-insensitive) y debe tener formato de email válido.
const optEmail = z
	.string()
	.nullish()
	.transform((v) => {
		const t = recortar((v ?? "").toString()).toLowerCase();
		return t.length ? t : null;
	})
	.refine((v) => v === null || isValidEmail(v), { message: "El correo no es válido." });

// AUD-36: con un máximo, como en la Main.
const notas = optStr.refine(cabeEnTextoLibre, MSG_TEXTO_DEMASIADO_LARGO);

export const createClienteSchema = z.object({
	// ID autogenerado por el backend: el cliente HTTP lo envía como `null` cuando no lo
	// conoce. Lo aceptamos y lo normalizamos a `undefined` (compat con @tpv/contracts).
	id_cliente: idStr.nullish().transform((v) => (v == null ? undefined : v)),
	nombre: z.string().overwrite(recortar).min(1, "Escribe el nombre del cliente."),
	email: optEmail,
	telefono: optStr,
	notas: notas,
});

export const updateClienteSchema = z.object({
	nombre: z.string().overwrite(recortar).min(1, "Escribe el nombre del cliente."),
	email: optEmail,
	telefono: optStr,
	notas: notas,
});

type NullableClienteFields = "email" | "telefono" | "notas";

export type CreateClienteInput = Omit<
	ContractCreateClienteInput,
	NullableClienteFields
> & {
	[K in NullableClienteFields]?: ContractCreateClienteInput[K] | null;
};

export type UpdateClienteInput = Omit<
	ContractUpdateClienteInput,
	"id_cliente" | NullableClienteFields
> & {
	[K in NullableClienteFields]?: ContractUpdateClienteInput[K] | null;
};

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GCreateCliente = Assert<SameKeys<z.infer<typeof createClienteSchema>, CreateClienteInput>>;
type _GUpdateCliente = Assert<SameKeys<z.infer<typeof updateClienteSchema>, UpdateClienteInput>>;
