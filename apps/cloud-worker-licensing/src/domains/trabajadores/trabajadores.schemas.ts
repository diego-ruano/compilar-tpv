// src/domains/trabajadores/trabajadores.schemas.ts

import { z } from "zod";

import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	AsignacionCreateInput as ContractAsignacionCreateInput,
	AsignacionUpdateInput as ContractAsignacionUpdateInput,
	CopySemanaInput as ContractCopySemanaInput,
	TrabajadorCreateInput as ContractTrabajadorCreateInput,
	TrabajadorUpdateInput as ContractTrabajadorUpdateInput,
} from "@tpv/contracts";

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

function idField(field: string) {
	return z.coerce.string().trim().min(1, `${field} invalido`);
}

/**
 * RI-63: el PIN que se puede teclear en el login, de 4 a 6 cifras (espejo de `pin_de_teclado` en
 * `tpv-domain/src/login.rs`). Llega en claro y lo hashea la ruta con `hashPin`: así no se guarda un
 * hash hecho fuera, con las iteraciones que sea.
 */
const PIN_DE_TECLADO = /^\d{4,6}$/;
const MSG_PIN = "El PIN tiene que tener entre 4 y 6 cifras";

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
		id_rol: idField("id_rol"),
		email: requiredString("email"),
		pin: z
			.string()
			.transform((s) => s.trim())
			.refine((s) => PIN_DE_TECLADO.test(s), MSG_PIN),
		nombre: requiredString("nombre"),
		apellido: z.any().optional().nullable(),
		estado: z.any(),
		// TRAB-03: dni / iban / numero_seguridad_social NO se aceptan aquí. Van cifrados con una
		// clave que sólo tiene la Main; si la Handy los mandara, se escribirían en claro en la
		// nube. Rechazarlos en el borde es mejor que aceptarlos y tirarlos en silencio: quien
		// los envíe recibe un error en vez de creerse que se han guardado.
		telefono: z.any().optional().nullable(),
		puesto: z.any().optional().nullable(),
		fecha_inicio_contrato: z.any().optional().nullable(),
		fecha_fin_contrato: z.any().optional().nullable(),
	})
	.transform((v) => ({
		...v,
		apellido: cleanOrNull(v.apellido),
		estado: normalizeEstado(v.estado),
		telefono: cleanOrNull(v.telefono),
		puesto: cleanOrNull(v.puesto),
		fecha_inicio_contrato: cleanOrNull(v.fecha_inicio_contrato),
		fecha_fin_contrato: cleanOrNull(v.fecha_fin_contrato),
	}));

export const trabajadorUpdateSchema = z
	.object({
		id_trabajador: idField("id_trabajador"),
		id_usuario: idField("id_usuario"),
		id_rol: idField("id_rol"),
		email: requiredString("email"),
		nombre: requiredString("nombre"),
		apellido: z.any().optional().nullable(),
		estado: z.any(),
		// TRAB-03: dni / iban / numero_seguridad_social NO se aceptan aquí. Van cifrados con una
		// clave que sólo tiene la Main; si la Handy los mandara, se escribirían en claro en la
		// nube. Rechazarlos en el borde es mejor que aceptarlos y tirarlos en silencio: quien
		// los envíe recibe un error en vez de creerse que se han guardado.
		telefono: z.any().optional().nullable(),
		puesto: z.any().optional().nullable(),
		fecha_inicio_contrato: z.any().optional().nullable(),
		fecha_fin_contrato: z.any().optional().nullable(),
		// Vacío o ausente: el PIN no se cambia.
		pin: z
			.string()
			.optional()
			.nullable()
			.transform((v) => cleanOrNull(v))
			.refine((v) => v === null || PIN_DE_TECLADO.test(v), MSG_PIN),
	})
	.transform((v) => ({
		...v,
		apellido: cleanOrNull(v.apellido),
		estado: normalizeEstado(v.estado),
		telefono: cleanOrNull(v.telefono),
		puesto: cleanOrNull(v.puesto),
		fecha_inicio_contrato: cleanOrNull(v.fecha_inicio_contrato),
		fecha_fin_contrato: cleanOrNull(v.fecha_fin_contrato),
	}));

export const asignacionCreateSchema = z
	.object({
		id_trabajador: idField("id_trabajador"),
		fecha: z.any().transform((v) => normalizeYmd(v)),
		id_turno: idField("id_turno"),
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
		id_asignacion: idField("id_asignacion"),
		id_turno: idField("id_turno"),
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

/**
 * TRAB-03: campos que el worker **no gestiona**. Van cifrados con una clave que sólo tiene la
 * Main, así que aquí no se aceptan, no se escriben y no se devuelven.
 *
 * Están declarados como un tipo con nombre, y no simplemente ausentes, porque el drift-guard
 * de abajo compara claves en las dos direcciones: sin esta exclusión explícita el módulo no
 * compila. Es deliberado — que quitar un campo del contrato obligue a decir *por qué*.
 */
type PiiSoloMain = "dni" | "iban" | "numero_seguridad_social";

type NullableTrabajadorCreateFields =
	| "apellido"
	| "telefono"
	| "puesto"
	| "fecha_inicio_contrato"
	| "fecha_fin_contrato";

type NullableTrabajadorUpdateFields =
	| NullableTrabajadorCreateFields
	| "pin";

type NullableAsignacionFields = "hora_inicio" | "hora_fin" | "notas";

export type TrabajadorCreateInput = Omit<
	ContractTrabajadorCreateInput,
	NullableTrabajadorCreateFields | PiiSoloMain
> & {
	[K in NullableTrabajadorCreateFields]?: ContractTrabajadorCreateInput[K] | null;
};

export type TrabajadorUpdateInput = Omit<
	ContractTrabajadorUpdateInput,
	NullableTrabajadorUpdateFields | PiiSoloMain
> & {
	[K in NullableTrabajadorUpdateFields]?: ContractTrabajadorUpdateInput[K] | null;
};

export type AsignacionCreateInput = Omit<
	ContractAsignacionCreateInput,
	NullableAsignacionFields
> & {
	[K in NullableAsignacionFields]?: ContractAsignacionCreateInput[K] | null;
};

export type AsignacionUpdateInput = Omit<
	ContractAsignacionUpdateInput,
	NullableAsignacionFields
> & {
	[K in NullableAsignacionFields]?: ContractAsignacionUpdateInput[K] | null;
};

export type CopySemanaInput = Required<ContractCopySemanaInput>;

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GTrabajadorCreate = Assert<SameKeys<z.infer<typeof trabajadorCreateSchema>, TrabajadorCreateInput>>;
type _GTrabajadorUpdate = Assert<SameKeys<z.infer<typeof trabajadorUpdateSchema>, TrabajadorUpdateInput>>;
type _GAsignacionCreate = Assert<SameKeys<z.infer<typeof asignacionCreateSchema>, AsignacionCreateInput>>;
type _GAsignacionUpdate = Assert<SameKeys<z.infer<typeof asignacionUpdateSchema>, AsignacionUpdateInput>>;
type _GCopySemana = Assert<SameKeys<z.infer<typeof copySemanaSchema>, CopySemanaInput>>;
