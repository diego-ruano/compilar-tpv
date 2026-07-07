// src/domains/cuentas/cuentas.schemas.ts

import { z } from "zod";
import type {
	CreateGastoInput as ContractCreateGastoInput,
	UpdateGastoInput as ContractUpdateGastoInput,
	UpdatePagoInput as ContractUpdatePagoInput,
} from "@tpv/contracts";

const idStr = z.string().trim().min(1);
const money = z.number().finite().min(0);

function clean(v: unknown): string {
	return String(v ?? "").trim();
}

function cleanOptional(v: unknown): string | null {
	const t = clean(v);
	return t.length ? t : null;
}

export const createGastoSchema = z.object({
	id_gasto: idStr.optional().nullish(),
	fecha: z.string().transform(clean).refine(Boolean, "fecha required"),
	tipo_gasto: z.string().transform(clean).refine(Boolean, "tipo_gasto required"),
	concepto: z.string().transform(clean).refine(Boolean, "concepto required"),
	importe: money,
	proveedor_id: idStr.optional().nullish(),
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

const optInt = z
	.union([z.string(), z.number()])
	.nullish()
	.transform((v) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
	});

// Listado de caja con búsqueda de texto + paginación (CUENTA-05).
export const listadoSchema = z.object({
	del: z.string().nullish().transform(cleanOptional),
	al: z.string().nullish().transform(cleanOptional),
	q: z.string().nullish().transform(cleanOptional),
	page: optInt,
	page_size: optInt,
});

export type CreateGastoInput = Omit<
	ContractCreateGastoInput,
	"id_gasto" | "proveedor_id"
> & {
	id_gasto?: string | null;
	proveedor_id?: string | null;
};

export type UpdateGastoInput = Omit<
	ContractUpdateGastoInput,
	"id_gasto" | "proveedor_id"
> & {
	proveedor_id?: string | null;
};

export type UpdatePagoInput = Omit<ContractUpdatePagoInput, "id_pago">;
