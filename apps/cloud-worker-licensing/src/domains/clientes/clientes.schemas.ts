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

export const createClienteSchema = z.object({
	// ID autogenerado por el backend: el cliente HTTP lo envía como `null` cuando no lo
	// conoce. Lo aceptamos y lo normalizamos a `undefined` (compat con @tpv/contracts).
	id_cliente: idStr.nullish().transform((v) => (v == null ? undefined : v)),
	nombre: z.string().trim().min(1, "nombre required"),
	email: optStr,
	telefono: optStr,
	notas: optStr,
});

export const updateClienteSchema = z.object({
	nombre: z.string().trim().min(1, "nombre required"),
	email: optStr,
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
