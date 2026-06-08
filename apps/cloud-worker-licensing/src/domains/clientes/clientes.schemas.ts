// src/domains/clientes/clientes.schemas.ts

import { z } from "zod";

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

export type CreateClienteInput = z.infer<typeof createClienteSchema>;
export type UpdateClienteInput = z.infer<typeof updateClienteSchema>;
