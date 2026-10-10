// src/domains/mesas/mesas.schemas.ts

import * as z from "zod";
import { zMetodoPago, zEstadoCocina } from "../../lib/pago";

import type { Assert, SameKeys } from "../../lib/typeGuards";
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

export const addLineaSchema = z
	.object({
		id_comanda: idField("id_comanda"),
		id_producto: idField("id_producto"),
		cantidad: z.coerce.number().positive(),
		id_usuario: z.any().optional().nullable(),
		id_trabajador: z.any().optional().nullable(),
	})
	// ARCH-03: se reconstruye el objeto en vez de esparcir `...v`, igual que hace
	// `setTrabajadorSchema`. Con el spread, `id_usuario`/`id_trabajador` seguían en el
	// resultado aunque `AddLineaInput` dice que desaparecen: el tipo declarado y lo que
	// salía de verdad no coincidían. Nadie los leía, pero el drift-guard lo destapó.
	.transform((v) => ({
		id_comanda: v.id_comanda,
		id_producto: v.id_producto,
		cantidad: v.cantidad,
		id_trabajador_o_usuario:
			optIdStr(v.id_trabajador) ?? optIdStr(v.id_usuario),
	}));

export const removeOneDetalleSchema = z.object({
	id_comanda: idField("id_comanda"),
	id_producto: idField("id_producto"),
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
		metodo: zMetodoPago,
		tipo: z.any().optional(),
		detalle_ids: z.any().optional(),
		id_usuario: z.any().optional().nullable(),
	})
	.transform((v) => ({
		id_comanda: v.id_comanda,
		metodo: v.metodo,
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
	estado: zEstadoCocina,
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
	"id_comanda" | "id_producto" | "cantidad"
> & {
	id_trabajador_o_usuario: string | null;
};

/**
 * FISCAL-02: el `destinatario` se declara porque está en el DTO de Rust, pero esta ruta **no lo
 * usa** y no puede usarlo.
 *
 * Cobrar es de la Main (`soloLaMainCobra`): esta ruta está vetada a una Handy, así que aquí no llega
 * nadie. Y aunque llegara, emitir una factura completa exige escribir en `Registros_Facturacion`,
 * que es justo lo que el veto de `applyViaHub` impide desde la nube — la cadena de huellas vive en
 * el SIF del obligado, y la nube es copia, no fuente.
 *
 * Se quita del tipo local con `Omit` en vez de declararlo en el zod y tirarlo: un campo validado que
 * nadie lee es una promesa que el código no cumple.
 */
export type CobrarDetallesInput = Omit<
	ContractMesasCobrarDetallesInput,
	"id_usuario" | "destinatario"
> & {
	id_usuario: string | null;
};

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GSaveLayout = Assert<SameKeys<z.infer<typeof saveLayoutSchema>, SaveLayoutInput>>;
type _GAbrirComanda = Assert<SameKeys<z.infer<typeof abrirComandaSchema>, AbrirComandaInput>>;
type _GSetTrabajador = Assert<SameKeys<z.infer<typeof setTrabajadorSchema>, SetTrabajadorInput>>;
type _GAddLinea = Assert<SameKeys<z.infer<typeof addLineaSchema>, AddLineaInput>>;
type _GCobrarDetalles = Assert<SameKeys<z.infer<typeof cobrarDetallesSchema>, CobrarDetallesInput>>;
