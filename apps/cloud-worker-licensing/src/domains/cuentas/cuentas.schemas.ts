// src/domains/cuentas/cuentas.schemas.ts

import { z } from "zod";

const posInt = z.number().int().positive();
const money = z.number().finite().min(0);

function clean(v: unknown): string {
	return String(v ?? "").trim();
}

function cleanOptional(v: unknown): string | null {
	const t = clean(v);
	return t.length ? t : null;
}

export const createGastoSchema = z.object({
	id_gasto: posInt.optional().nullish(),
	fecha: z.string().transform(clean).refine(Boolean, "fecha required"),
	tipo_gasto: z.string().transform(clean).refine(Boolean, "tipo_gasto required"),
	concepto: z.string().transform(clean).refine(Boolean, "concepto required"),
	importe: money,
	proveedor_id: posInt.optional().nullish(),
});

export const updateGastoSchema = createGastoSchema.omit({ id_gasto: true });

export const updatePagoSchema = z.object({
	fecha_hora: z.string().transform(clean).refine(Boolean, "fecha_hora required"),
	metodo: z.string().transform((v) => (v.trim() === "Tarjeta" ? "Tarjeta" : "Efectivo")),
	importe: money,
});

export const rangoSchema = z.object({
	del: z.string().nullish().transform(cleanOptional),
	al: z.string().nullish().transform(cleanOptional),
});

export type CreateGastoInput = z.infer<typeof createGastoSchema>;
export type UpdateGastoInput = z.infer<typeof updateGastoSchema>;
export type UpdatePagoInput = z.infer<typeof updatePagoSchema>;
