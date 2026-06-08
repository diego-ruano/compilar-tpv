// src/domains/clientes/clientes.schemas.ts

import { z } from "zod";
import type {
	CreateClienteInput as ContractCreateClienteInput,
	UpdateClienteInput as ContractUpdateClienteInput,
} from "@tpv/contracts";

const posInt = z.number().int().positive();

function cleanOptional(v: unknown): string | null {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
}

const optStr = z.string().nullish().transform(cleanOptional);

export const createClienteSchema = z.object({
	id_cliente: posInt.optional(),
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
