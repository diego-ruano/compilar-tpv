// src/domains/venta_rapida/venta_rapida.schemas.ts

import { z } from "zod";
import { zDineroNoNegativo } from "../../lib/dinero";

import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	VrAddLineaComandaInput,
	VrCobrarFraccionadoInput as ContractVrCobrarFraccionadoInput,
	VrCreateComandaBarraInput,
	VrDeleteLineaIfUnpaidInput,
	VrRemoveLastUnpaidLineaInput,
	VrUpdateNotaDetalleInput,
} from "@tpv/contracts";

function idField(field: string) {
	return z.coerce.string().trim().min(1, `${field} invalido`);
}

/**
 * Id que el DISPOSITIVO genera y envía (UUIDv7). Opcional: si no llega, el comando genera uno.
 * Convención del proyecto (ver `idStep` en cada `*.commands.ts`): una fila tiene UN id, elegido
 * por quien la crea, y la nube lo honra. Se acepta `null` porque los clientes lo mandan así
 * cuando no lo conocen.
 */
const optionalIdField = z.coerce
	.string()
	.trim()
	.min(1)
	.nullish()
	.transform((v) => (v == null ? undefined : v));

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

// El alias `q` lo declara el schema y no la ruta: antes la lista de nombres que acepta esta
// búsqueda estaba escrita dos veces, aquí y en el `safeParse` del router.
export const searchProductosSchema = z
	.object({
		query: z.string().optional(),
		q: z.string().optional(),
		limit: z.coerce.number().int().min(1).max(200).optional().default(60),
	})
	.transform((v) => ({ query: String(v.query ?? v.q ?? "").trim(), limit: v.limit }));

export const idsSchema = z
	.object({ ids: z.any() })
	.transform((v) => ({ ids: normalizeIds(v.ids) }));

export const createComandaBarraSchema = z
	.object({
		id_comanda: optionalIdField,
		id_trabajador: z.any().optional().nullable(),
		get_or_create: z.boolean().optional().default(false),
	})
	.transform((v) => ({
		id_comanda: v.id_comanda,
		id_trabajador: optIdStr(v.id_trabajador),
		get_or_create: Boolean(v.get_or_create),
	}));

export const addLineaSchema = z.object({
	id_detalle: optionalIdField,
	id_comanda: idField("id_comanda"),
	id_producto: idField("id_producto"),
	cantidad: positiveNumber("cantidad"),
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
		importe_total: zDineroNoNegativo,
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

// `id_comanda`/`id_detalle` NO están en los DTOs de `@tpv/contracts` a propósito: esos describen la
// frontera frontend↔Rust, donde el id no viaja (lo pone el repositorio). Aquí, en la frontera HTTP,
// el dispositivo sí lo envía para que la fila tenga el MISMO id en el Handy y en la nube.
export type CreateComandaBarraInput = Omit<
	VrCreateComandaBarraInput,
	"id_trabajador" | "get_or_create"
> & {
	id_comanda?: string;
	id_trabajador: string | null;
	get_or_create: boolean;
};

export type AddLineaInput = VrAddLineaComandaInput & {
	id_detalle?: string;
};
export type RemoveLastLineaInput = VrRemoveLastUnpaidLineaInput;
export type DeleteLineaInput = VrDeleteLineaIfUnpaidInput;

export type UpdateNotaInput = Omit<VrUpdateNotaDetalleInput, "nota"> & {
	nota?: string | null;
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
 * Lo mismo vale para `id_pago`, el id con el que la Main hace idempotente el cobro: sólo tiene
 * sentido donde se cobra.
 *
 * Se quitan del tipo local con `Omit` en vez de declararlos en el zod y tirarlos: un campo validado
 * que nadie lee es una promesa que el código no cumple.
 */
export type CobrarFraccionadoInput = Omit<
	ContractVrCobrarFraccionadoInput,
	"id_pago" | "id_usuario_cobrador" | "id_trabajador_cobrador" | "destinatario"
> & {
	id_usuario_cobrador: string | null;
	id_trabajador_cobrador: string | null;
};

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GCreateComandaBarra = Assert<SameKeys<z.infer<typeof createComandaBarraSchema>, CreateComandaBarraInput>>;
type _GAddLinea = Assert<SameKeys<z.infer<typeof addLineaSchema>, AddLineaInput>>;
type _GRemoveLastLinea = Assert<SameKeys<z.infer<typeof removeLastLineaSchema>, RemoveLastLineaInput>>;
type _GDeleteLinea = Assert<SameKeys<z.infer<typeof deleteLineaSchema>, DeleteLineaInput>>;
type _GUpdateNota = Assert<SameKeys<z.infer<typeof updateNotaSchema>, UpdateNotaInput>>;
type _GCobrarFraccionado = Assert<SameKeys<z.infer<typeof cobrarFraccionadoSchema>, CobrarFraccionadoInput>>;
