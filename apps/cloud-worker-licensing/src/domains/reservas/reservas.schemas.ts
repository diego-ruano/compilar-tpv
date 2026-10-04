// src/domains/reservas/reservas.schemas.ts

import { z } from "zod";

import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	ReservaBuscarClienteArgs,
	ReservaSaveInput as ContractReservaSaveInput,
} from "@tpv/contracts";

const ESTADOS = new Set([
	"PROXIMA",
	"ACTIVA",
	"FINALIZADA",
	"CANCELADA",
	"NO_SHOW",
]);

const TURNOS = new Set(["DESAYUNO", "COMIDA", "CAFE", "CENA"]);

/** Mismo texto que `MSG_CLIENTE_SIN_NOMBRE` en la Main (`tpv-domain/src/reservas.rs`). */
const MSG_CLIENTE_SIN_NOMBRE =
	"Para dar de alta al cliente hace falta su nombre. Si no quieres ficha de cliente, deja vacíos el teléfono y el email.";

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
		id_mesa: z.any().optional().nullable(),
		// RI-61: el cliente es opcional y explícito (ver `ClienteReserva::desde` en la Main).
		id_cliente: z.any().optional().nullable(),
		nombre_cliente: z.any().optional().nullable(),
		telefono: z.any().optional().nullable(),
		email: z.any().optional().nullable(),
		notas_cliente: z.any().optional().nullable(),
	})
	.superRefine((v, ctx) => {
		const sinFicha = !cleanOrNull(v.id_cliente) && !cleanOrNull(v.nombre_cliente);
		if (sinFicha && (cleanOrNull(v.telefono) || cleanOrNull(v.email))) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["nombre_cliente"],
				message: MSG_CLIENTE_SIN_NOMBRE,
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
			id_mesa: cleanOrNull(v.id_mesa),
			id_cliente: cleanOrNull(v.id_cliente),
			nombre_cliente: cleanOrNull(v.nombre_cliente),
			telefono: cleanOrNull(v.telefono),
			email: cleanEmailOrNull(v.email),
			notas_cliente: cleanOrNull(v.notas_cliente),
		};
	});

/** RI-61: la búsqueda del cliente antes de asignarle una reserva. */
export const buscarClienteSchema = z
	.object({
		telefono: z.any().optional().nullable(),
		email: z.any().optional().nullable(),
	})
	.transform((v) => ({
		telefono: cleanOrNull(v.telefono),
		email: cleanEmailOrNull(v.email),
	}));

export const mesQuerySchema = z.object({
	desde: z.any().transform((v) => normalizeDia(v)),
	hasta: z.any().transform((v) => normalizeDia(v)),
});

type NullableReservaFields =
	| "id_reserva"
	| "id_mesa"
	| "id_cliente"
	| "nombre_cliente"
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

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GReservaSave = Assert<SameKeys<z.infer<typeof reservaSaveSchema>, ReservaSaveInput>>;
type _GBuscarCliente = Assert<
	SameKeys<z.infer<typeof buscarClienteSchema>, Required<ReservaBuscarClienteArgs>>
>;
