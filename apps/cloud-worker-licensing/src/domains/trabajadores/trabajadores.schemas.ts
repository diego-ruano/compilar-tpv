// src/domains/trabajadores/trabajadores.schemas.ts

import { z } from "zod";

function cleanOrNull(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s.length ? s : null;
}

function requiredString(field: string) {
	return z
		.string()
		.transform((s) => s.trim())
		.refine((s) => s.length > 0, `${field} required`);
}

function positiveInt(field: string) {
	return z.coerce.number().int(`${field} invalido`).positive(`${field} invalido`);
}

function normalizeEstado(v: unknown): string {
	return String(v ?? "").trim().toLowerCase() === "inactivo"
		? "Inactivo"
		: "Activo";
}

function normalizeYmd(raw: unknown): string {
	const s = String(raw ?? "").trim();
	const candidate = s.length >= 10 ? s.slice(0, 10) : "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
		throw new Error("fecha invalida");
	}
	return candidate;
}

function normalizeOptionalTime(raw: unknown): string | null {
	const s = cleanOrNull(raw);
	if (!s) return null;
	const hhmm = s.length >= 5 ? s.slice(0, 5) : "";
	if (!/^\d{2}:\d{2}$/.test(hhmm)) return s;
	return hhmm;
}

export const trabajadorCreateSchema = z
	.object({
		id_rol: positiveInt("id_rol"),
		email: requiredString("email"),
		password_hash: requiredString("password_hash"),
		nombre: requiredString("nombre"),
		apellido: z.any().optional().nullable(),
		estado: z.any(),
		dni: z.any().optional().nullable(),
		telefono: z.any().optional().nullable(),
		puesto: z.any().optional().nullable(),
		iban: z.any().optional().nullable(),
		numero_seguridad_social: z.any().optional().nullable(),
		fecha_inicio_contrato: z.any().optional().nullable(),
		fecha_fin_contrato: z.any().optional().nullable(),
	})
	.transform((v) => ({
		...v,
		apellido: cleanOrNull(v.apellido),
		estado: normalizeEstado(v.estado),
		dni: cleanOrNull(v.dni),
		telefono: cleanOrNull(v.telefono),
		puesto: cleanOrNull(v.puesto),
		iban: cleanOrNull(v.iban),
		numero_seguridad_social: cleanOrNull(v.numero_seguridad_social),
		fecha_inicio_contrato: cleanOrNull(v.fecha_inicio_contrato),
		fecha_fin_contrato: cleanOrNull(v.fecha_fin_contrato),
	}));

export const trabajadorUpdateSchema = z
	.object({
		id_trabajador: positiveInt("id_trabajador"),
		id_usuario: positiveInt("id_usuario"),
		id_rol: positiveInt("id_rol"),
		email: requiredString("email"),
		nombre: requiredString("nombre"),
		apellido: z.any().optional().nullable(),
		estado: z.any(),
		dni: z.any().optional().nullable(),
		telefono: z.any().optional().nullable(),
		puesto: z.any().optional().nullable(),
		iban: z.any().optional().nullable(),
		numero_seguridad_social: z.any().optional().nullable(),
		fecha_inicio_contrato: z.any().optional().nullable(),
		fecha_fin_contrato: z.any().optional().nullable(),
		password_hash: z.any().optional().nullable(),
	})
	.transform((v) => ({
		...v,
		apellido: cleanOrNull(v.apellido),
		estado: normalizeEstado(v.estado),
		dni: cleanOrNull(v.dni),
		telefono: cleanOrNull(v.telefono),
		puesto: cleanOrNull(v.puesto),
		iban: cleanOrNull(v.iban),
		numero_seguridad_social: cleanOrNull(v.numero_seguridad_social),
		fecha_inicio_contrato: cleanOrNull(v.fecha_inicio_contrato),
		fecha_fin_contrato: cleanOrNull(v.fecha_fin_contrato),
		password_hash: cleanOrNull(v.password_hash),
	}));

export const asignacionCreateSchema = z
	.object({
		id_trabajador: positiveInt("id_trabajador"),
		fecha: z.any().transform((v) => normalizeYmd(v)),
		id_turno: positiveInt("id_turno"),
		area: requiredString("area"),
		hora_inicio: z.any().optional().nullable(),
		hora_fin: z.any().optional().nullable(),
		notas: z.any().optional().nullable(),
	})
	.transform((v) => ({
		...v,
		hora_inicio: normalizeOptionalTime(v.hora_inicio),
		hora_fin: normalizeOptionalTime(v.hora_fin),
		notas: cleanOrNull(v.notas),
	}));

export const asignacionUpdateSchema = z
	.object({
		id_asignacion: positiveInt("id_asignacion"),
		id_turno: positiveInt("id_turno"),
		area: requiredString("area"),
		hora_inicio: z.any().optional().nullable(),
		hora_fin: z.any().optional().nullable(),
		notas: z.any().optional().nullable(),
	})
	.transform((v) => ({
		...v,
		hora_inicio: normalizeOptionalTime(v.hora_inicio),
		hora_fin: normalizeOptionalTime(v.hora_fin),
		notas: cleanOrNull(v.notas),
	}));

export const copySemanaSchema = z.object({
	from_monday: z.any().transform((v) => normalizeYmd(v)),
	to_monday: z.any().transform((v) => normalizeYmd(v)),
	overwrite: z.boolean().optional().default(false),
});

export const fechaLunesSchema = z.object({
	fecha_lunes: z.any().transform((v) => normalizeYmd(v)),
});

export type TrabajadorCreateInput = z.infer<typeof trabajadorCreateSchema>;
export type TrabajadorUpdateInput = z.infer<typeof trabajadorUpdateSchema>;
export type AsignacionCreateInput = z.infer<typeof asignacionCreateSchema>;
export type AsignacionUpdateInput = z.infer<typeof asignacionUpdateSchema>;
export type CopySemanaInput = z.infer<typeof copySemanaSchema>;
