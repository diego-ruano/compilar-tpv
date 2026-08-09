// src/domains/reservas/reservas.schemas.ts

import { z } from "zod";
import type { ReservaSaveInput as ContractReservaSaveInput } from "@tpv/contracts";

const ESTADOS = new Set([
	"PROXIMA",
	"ACTIVA",
	"FINALIZADA",
	"CANCELADA",
	"NO_SHOW",
]);

const TURNOS = new Set(["DESAYUNO", "COMIDA", "CAFE", "CENA"]);

function cleanOrNull(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s.length ? s : null;
}

// Igual que `cleanOrNull` pero en minúsculas. El email identifica al cliente y su unicidad es
// case-insensitive (índice `ux_clientes_email` sobre `lower(Email)`). Espejo de `limpia_email` en
// `tpv_domain::reservas`: Main y Handy tienen que guardar exactamente el mismo valor.
function cleanEmailOrNull(v: unknown): string | null {
	const s = String(v ?? "").trim().toLowerCase();
	return s.length ? s : null;
}

function normalizeDia(raw: unknown): string {
	const s = String(raw ?? "").trim();
	const candidate = s.length >= 10 ? s.slice(0, 10) : "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
		throw new Error("dia_ymd invalido");
	}
	return candidate;
}

function normalizeHora(raw: unknown): string {
	const s = String(raw ?? "").trim();
	const hhmm = s.length >= 5 ? s.slice(0, 5) : "";
	if (!/^\d{2}:\d{2}$/.test(hhmm)) {
		throw new Error("hora invalida");
	}
	const hh = Number(hhmm.slice(0, 2));
	const mm = Number(hhmm.slice(3, 5));
	if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
		throw new Error("hora invalida");
	}
	return hhmm;
}

function turnoPorHora(hhmm: string): string {
	const hh = Number(hhmm.slice(0, 2));
	const mm = Number(hhmm.slice(3, 5));
	const mins = hh * 60 + mm;
	if (mins < 13 * 60) return "DESAYUNO";
	if (mins < 16 * 60) return "COMIDA";
	if (mins < 19 * 60) return "CAFE";
	return "CENA";
}

function normalizeTurno(raw: unknown, hora: string): string {
	const t = String(raw ?? "").trim().toUpperCase();
	return TURNOS.has(t) ? t : turnoPorHora(hora);
}

function normalizeEstado(raw: unknown): string {
	const e = String(raw ?? "PROXIMA").trim().toUpperCase();
	return ESTADOS.has(e) ? e : "PROXIMA";
}

function positiveInt(name: string) {
	return z.coerce
		.number()
		.int(`${name} invalido`)
		.positive(`${name} invalido`);
}

function idField(name: string) {
	return z.coerce.string().trim().min(1, `${name} invalido`);
}

export const reservaSaveSchema = z
	.object({
		id_reserva: z.coerce.string().trim().min(1).nullable().optional(),
		dia_ymd: z.any(),
		hora: z.any(),
		turno: z.any().optional().nullable(),
		comensales: positiveInt("comensales"),
		nota: z.any().optional().nullable(),
		estado: z.any().optional().nullable(),
		id_mesa: idField("id_mesa"),
		nombre_cliente: z.string().transform((s) => s.trim()),
		telefono: z.any().optional().nullable(),
		email: z.any().optional().nullable(),
		notas_cliente: z.any().optional().nullable(),
	})
	.superRefine((v, ctx) => {
		if (!v.nombre_cliente) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["nombre_cliente"],
				message: "nombre_cliente required",
			});
		}
	})
	.transform((v, ctx) => {
		let dia_ymd = "";
		let hora = "";
		try {
			dia_ymd = normalizeDia(v.dia_ymd);
		} catch (e: any) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["dia_ymd"],
				message: e.message,
			});
		}
		try {
			hora = normalizeHora(v.hora);
		} catch (e: any) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["hora"],
				message: e.message,
			});
		}

		const id_reserva =
			v.id_reserva && v.id_reserva.trim().length > 0 ? v.id_reserva : null;
		const estado = id_reserva ? normalizeEstado(v.estado) : "PROXIMA";
		const turno = hora ? normalizeTurno(v.turno, hora) : "DESAYUNO";

		return {
			id_reserva,
			dia_ymd,
			hora,
			turno,
			comensales: v.comensales,
			nota: cleanOrNull(v.nota),
			estado,
			id_mesa: v.id_mesa,
			nombre_cliente: v.nombre_cliente,
			telefono: cleanOrNull(v.telefono),
			email: cleanEmailOrNull(v.email),
			notas_cliente: cleanOrNull(v.notas_cliente),
		};
	});

export const mesQuerySchema = z.object({
	desde: z.any().transform((v) => normalizeDia(v)),
	hasta: z.any().transform((v) => normalizeDia(v)),
});

type NullableReservaFields =
	| "id_reserva"
	| "turno"
	| "nota"
	| "estado"
	| "telefono"
	| "email"
	| "notas_cliente";

export type ReservaSaveInput = Omit<
	ContractReservaSaveInput,
	NullableReservaFields
> & {
	[K in NullableReservaFields]?: ContractReservaSaveInput[K] | null;
};
