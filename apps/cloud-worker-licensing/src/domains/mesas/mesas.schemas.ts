// src/domains/mesas/mesas.schemas.ts

import { z } from "zod";
import type {
	MesasAbrirComandaInput,
	MesasAddLineaComandaInput,
	MesasCobrarDetallesInput as ContractMesasCobrarDetallesInput,
	MesasComandaSetTrabajadorInput,
	MesasSaveLayoutInput,
} from "@tpv/contracts";

function idField(field: string) {
	return z.coerce.string().trim().min(1, `${field} invalido`);
}

function optIdStr(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s.length ? s : null;
}

function cleanOrNull(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s.length ? s : null;
}

function metodo(v: unknown): string {
	return String(v ?? "").trim().toLowerCase() === "tarjeta" ? "Tarjeta" : "Efectivo";
}

function cocina(v: unknown): string {
	return String(v ?? "").trim().toUpperCase() === "PREPARADO"
		? "PREPARADO"
		: "PENDIENTE";
}

function idArray(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	return Array.from(
		new Set(
			values
				.map((s) => String(s ?? "").trim())
				.filter((s) => s.length > 0),
		),
	);
}

const roomSchema = z
	.object({
		type: z.string().optional().default("poly"),
		points: z.array(z.coerce.number()).optional().default([]),
	})
	.transform((v) => ({ type: "poly", points: v.points }));

const tableSchema = z.object({
	id: z.string().default(""),
	name: z.string().transform((s) => s.trim()),
	x: z.coerce.number().int().default(0),
	y: z.coerce.number().int().default(0),
	width: z.coerce.number().int().default(120),
	height: z.coerce.number().int().default(70),
	radius: z.coerce.number().int().nullable().optional().default(null),
	seats: z.coerce.number().int().default(4),
	shape: z.string().default("rounded"),
});

export const saveLayoutSchema = z.object({
	salons: z.array(
		z.object({
			id: z.string().default(""),
			name: z.string().transform((s) => s.trim()),
			room: roomSchema,
			tables: z.array(tableSchema).optional().default([]),
		}),
	),
});

export const setReservaEstadoSchema = z.object({
	id_reserva: idField("id_reserva"),
	estado: z
		.string()
		.transform((s) => s.trim().toUpperCase())
		.refine((s) => ["PROXIMA", "ACTIVA", "FINALIZADA", "CANCELADA", "NO_SHOW"].includes(s)),
});

export const abrirComandaSchema = z
	.object({
		id_mesa: idField("id_mesa"),
		id_trabajador: z.any().optional().nullable(),
		id_usuario: z.any().optional().nullable(),
		id_reserva: z.any().optional().nullable(),
	})
	.transform((v) => ({
		id_mesa: v.id_mesa,
		id_trabajador_o_usuario:
			optIdStr(v.id_trabajador) ?? optIdStr(v.id_usuario),
		id_reserva: optIdStr(v.id_reserva),
	}));

export const setTrabajadorSchema = z
	.object({
		id_comanda: idField("id_comanda"),
		id_usuario: z.any().optional().nullable(),
		id_trabajador: z.any().optional().nullable(),
	})
	.transform((v) => ({
		id_comanda: v.id_comanda,
		id_trabajador_o_usuario:
			optIdStr(v.id_trabajador) ?? optIdStr(v.id_usuario),
	}));

export const cerrarComandaSchema = z.object({
	id_comanda: idField("id_comanda"),
	total: z.coerce.number().min(0),
});

export const addLineaSchema = z
	.object({
		id_comanda: idField("id_comanda"),
		id_producto: idField("id_producto"),
		cantidad: z.coerce.number().positive(),
		precio: z.coerce.number().min(0),
		id_usuario: z.any().optional().nullable(),
		id_trabajador: z.any().optional().nullable(),
	})
	.transform((v) => ({
		...v,
		id_trabajador_o_usuario:
			optIdStr(v.id_trabajador) ?? optIdStr(v.id_usuario),
	}));

export const removeOneDetalleSchema = z.object({
	id_comanda: idField("id_comanda"),
	id_producto: idField("id_producto"),
});

export const deleteDetalleSchema = z.object({
	id_detalle: idField("id_detalle"),
});

export const updateNotaSchema = z
	.object({
		id_detalle: idField("id_detalle"),
		nota: z.any().optional().nullable(),
	})
	.transform((v) => ({ ...v, nota: cleanOrNull(v.nota) }));

export const cobrarDetallesSchema = z
	.object({
		id_comanda: idField("id_comanda"),
		metodo: z.any(),
		tipo: z.any(),
		detalle_ids: z.any(),
		id_usuario: z.any().optional().nullable(),
	})
	.transform((v) => ({
		id_comanda: v.id_comanda,
		metodo: metodo(v.metodo),
		tipo: String(v.tipo ?? "TOTAL").trim().toUpperCase() === "FRACCIONADO"
			? "FRACCIONADO"
			: "TOTAL",
		detalle_ids: idArray(v.detalle_ids),
		id_usuario: optIdStr(v.id_usuario),
	}))
	.refine((v) => v.detalle_ids.length > 0, {
		path: ["detalle_ids"],
		message: "detalle_ids required",
	});

export const kitchenStateSchema = z.object({
	id_detalle: idField("id_detalle"),
	id_usuario_cocinero: idField("id_usuario_cocinero"),
	estado: z.any().transform(cocina),
});

export const searchSchema = z.object({
	query: z.string().optional(),
	q: z.string().optional(),
	texto: z.string().optional(),
}).transform((v) => ({
	query: String(v.query ?? v.q ?? v.texto ?? "").trim(),
}));

export type SaveLayoutInput = MesasSaveLayoutInput;

export type AbrirComandaInput = Pick<MesasAbrirComandaInput, "id_mesa"> & {
	id_trabajador_o_usuario: string | null;
	id_reserva: string | null;
};

export type SetTrabajadorInput = Pick<
	MesasComandaSetTrabajadorInput,
	"id_comanda"
> & {
	id_trabajador_o_usuario: string | null;
};

export type AddLineaInput = Pick<
	MesasAddLineaComandaInput,
	"id_comanda" | "id_producto" | "cantidad" | "precio"
> & {
	id_trabajador_o_usuario: string | null;
};

export type CobrarDetallesInput = Omit<
	ContractMesasCobrarDetallesInput,
	"id_usuario"
> & {
	id_usuario: string | null;
};
