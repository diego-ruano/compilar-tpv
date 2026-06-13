// src/domains/venta_rapida/venta_rapida.schemas.ts

import { z } from "zod";
import type {
	VrAddLineaComandaInput,
	VrCobrarFraccionadoInput as ContractVrCobrarFraccionadoInput,
	VrCreateComandaBarraInput,
	VrDeleteLineaIfUnpaidInput,
	VrRemoveLastUnpaidLineaInput,
	VrRestarStockInput,
	VrUpdateNotaDetalleInput,
} from "@tpv/contracts";

function idField(field: string) {
	return z.coerce.string().trim().min(1, `${field} invalido`);
}

function positiveNumber(field: string) {
	return z.coerce.number().positive(`${field} invalido`);
}

function optIdStr(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s.length ? s : null;
}

function cleanOrNull(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s.length ? s : null;
}

function normalizeIds(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	return Array.from(
		new Set(
			values
				.map((s) => String(s ?? "").trim())
				.filter((s) => s.length > 0),
		),
	).sort();
}

function normalizeMetodo(v: unknown): string {
	return String(v ?? "").trim().toLowerCase() === "tarjeta"
		? "Tarjeta"
		: "Efectivo";
}

export const listComandasSchema = z.object({
	include_pagadas: z
		.any()
		.optional()
		.transform((v) => {
			const s = String(v ?? "").trim().toLowerCase();
			return s === "true" || s === "1";
		}),
	limit: z.coerce.number().int().min(1).max(200).optional().default(60),
});

export const searchProductosSchema = z.object({
	query: z.string().transform((s) => s.trim()),
	limit: z.coerce.number().int().min(1).max(200).optional().default(60),
});

export const idsSchema = z
	.object({ ids: z.any() })
	.transform((v) => ({ ids: normalizeIds(v.ids) }));

export const createComandaBarraSchema = z
	.object({
		id_trabajador: z.any().optional().nullable(),
		get_or_create: z.boolean().optional().default(false),
	})
	.transform((v) => ({
		id_trabajador: optIdStr(v.id_trabajador),
		get_or_create: Boolean(v.get_or_create),
	}));

export const addLineaSchema = z.object({
	id_comanda: idField("id_comanda"),
	id_producto: idField("id_producto"),
	cantidad: positiveNumber("cantidad"),
	precio_unitario: z.coerce.number().min(0, "precio_unitario invalido"),
});

export const removeLastLineaSchema = z.object({
	id_comanda: idField("id_comanda"),
	id_producto: idField("id_producto"),
});

export const deleteLineaSchema = z.object({
	id_comanda: idField("id_comanda"),
	id_detalle: idField("id_detalle"),
});

export const updateNotaSchema = z
	.object({
		id_detalle: idField("id_detalle"),
		nota: z.any().optional().nullable(),
	})
	.transform((v) => ({ ...v, nota: cleanOrNull(v.nota) }));

export const cobrarFraccionadoSchema = z
	.object({
		id_comanda: idField("id_comanda"),
		metodo: z.any(),
		importe_total: z.coerce.number().min(0),
		id_usuario_cobrador: z.any().optional().nullable(),
		id_trabajador_cobrador: z.any().optional().nullable(),
		detalles: z.any(),
	})
	.transform((v) => ({
		id_comanda: v.id_comanda,
		metodo: normalizeMetodo(v.metodo),
		importe_total: v.importe_total,
		id_usuario_cobrador: optIdStr(v.id_usuario_cobrador),
		id_trabajador_cobrador: optIdStr(v.id_trabajador_cobrador),
		detalles: normalizeIds(v.detalles),
	}))
	.refine((v) => v.detalles.length > 0, {
		path: ["detalles"],
		message: "detalles required",
	});

export const restarStockSchema = z
	.object({ lineas: z.any() })
	.transform((v) => ({
		lineas: Array.isArray(v.lineas)
			? v.lineas
					.map((it: any) => ({
						producto_id: String(it?.producto_id ?? "").trim(),
						cantidad: Number(it?.cantidad),
					}))
					.filter(
						(it) =>
							it.producto_id.length > 0
							&& Number.isFinite(it.cantidad)
							&& it.cantidad > 0,
					)
			: [],
	}));

export type CreateComandaBarraInput = Omit<
	VrCreateComandaBarraInput,
	"id_trabajador" | "get_or_create"
> & {
	id_trabajador: string | null;
	get_or_create: boolean;
};

export type AddLineaInput = VrAddLineaComandaInput;
export type RemoveLastLineaInput = VrRemoveLastUnpaidLineaInput;
export type DeleteLineaInput = VrDeleteLineaIfUnpaidInput;

export type UpdateNotaInput = Omit<VrUpdateNotaDetalleInput, "nota"> & {
	nota?: string | null;
};

export type CobrarFraccionadoInput = Omit<
	ContractVrCobrarFraccionadoInput,
	"id_usuario_cobrador" | "id_trabajador_cobrador"
> & {
	id_usuario_cobrador: string | null;
	id_trabajador_cobrador: string | null;
};

export type RestarStockInput = VrRestarStockInput;
