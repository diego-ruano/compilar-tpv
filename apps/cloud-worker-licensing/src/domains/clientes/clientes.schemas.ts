// src/domains/clientes/clientes.schemas.ts

import { z } from "zod";
import type {
	CreateClienteInput as ContractCreateClienteInput,
	UpdateClienteInput as ContractUpdateClienteInput,
} from "@tpv/contracts";

const idStr = z.string().trim().min(1);

function cleanOptional(v: unknown): string | null {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
}

const optStr = z.string().nullish().transform(cleanOptional);

// Misma regla que el dominio Rust (`validate_email_basic`): longitud mínima, contiene
// '@' y '.', sin espacios. Se mantiene idéntica para no divergir entre Main y worker.
function isValidEmail(e: string): boolean {
	return e.length >= 6 && e.includes("@") && e.includes(".") && !e.includes(" ");
}

// Email opcional (CLI-04): vacío/ausente => null; si hay valor se normaliza a minúsculas
// (unicidad case-insensitive) y debe tener formato de email válido.
const optEmail = z
	.string()
	.nullish()
	.transform((v) => {
		const t = (v ?? "").toString().trim().toLowerCase();
		return t.length ? t : null;
	})
	.refine((v) => v === null || isValidEmail(v), { message: "email inválido" });

export const createClienteSchema = z.object({
	// ID autogenerado por el backend: el cliente HTTP lo envía como `null` cuando no lo
	// conoce. Lo aceptamos y lo normalizamos a `undefined` (compat con @tpv/contracts).
	id_cliente: idStr.nullish().transform((v) => (v == null ? undefined : v)),
	nombre: z.string().trim().min(1, "nombre required"),
	email: optEmail,
	telefono: optStr,
	notas: optStr,
});

export const updateClienteSchema = z.object({
	nombre: z.string().trim().min(1, "nombre required"),
	email: optEmail,
	telefono: optStr,
	notas: optStr,
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
