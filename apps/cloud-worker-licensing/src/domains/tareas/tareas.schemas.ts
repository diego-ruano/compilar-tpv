// src/domains/tareas/tareas.schemas.ts
//
// Validacion de entrada de tareas. Replica las reglas del dominio Rust:
// titulo requerido, textos opcionales trim -> null, ids positivos y crear con
// al menos un trabajador asignado.

import * as z from "zod";

import { recortar } from "../../lib/texto";
import type { Assert, SameKeys } from "../../lib/typeGuards";
import type {
	CreateTareaInput as ContractCreateTareaInput,
	FinalizarTareaInput as ContractFinalizarTareaInput,
	SetAsignacionesTareaInput as ContractSetAsignacionesTareaInput,
	UpdateTareaInput as ContractUpdateTareaInput,
} from "@tpv/contracts";

const idStr = z.string().overwrite(recortar).min(1);

function cleanOptional(v: unknown): string | null {
	const t = recortar((v ?? "").toString());
	return t.length ? t : null;
}

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => recortar((s ?? "").toString())).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

const optStr = z.string().nullish().transform(cleanOptional);
const idsTrabajadores = z.array(z.string()).default([]).transform(normalizeIds);

export const createTareaSchema = z.object({
	titulo: z.string().overwrite(recortar).min(1, "Escribe el título de la tarea."),
	descripcion: optStr,
	fecha_limite: optStr,
	ids_trabajadores: idsTrabajadores.refine((ids) => ids.length > 0, {
		message: "Asigna la tarea a alguien.",
	}),
});

export const updateTareaSchema = z.object({
	titulo: z.string().overwrite(recortar).min(1, "Escribe el título de la tarea."),
	descripcion: optStr,
	fecha_limite: optStr,
});

export const setAsignacionesTareaSchema = z.object({
	ids_trabajadores: idsTrabajadores,
});

export const finalizarTareaSchema = z.object({
	id_trabajador: idStr,
});

type NullableTareaFields = "descripcion" | "fecha_limite";

export type CreateTareaInput = Omit<
	ContractCreateTareaInput,
	NullableTareaFields
> & {
	[K in NullableTareaFields]?: ContractCreateTareaInput[K] | null;
};

export type UpdateTareaInput = Omit<
	ContractUpdateTareaInput,
	"id_tarea" | NullableTareaFields
> & {
	[K in NullableTareaFields]?: ContractUpdateTareaInput[K] | null;
};

export type SetAsignacionesTareaInput = Omit<
	ContractSetAsignacionesTareaInput,
	"id_tarea"
>;

export type FinalizarTareaInput = Omit<ContractFinalizarTareaInput, "id_tarea">;

// ── Drift-guard con los DTOs de Rust (ARCH-03) ───────────────────────────────
// Una línea por schema: comprueba en LAS DOS DIRECCIONES que las claves del zod y
// las del DTO coinciden. Si en Rust se añade, quita o renombra un campo, este módulo
// deja de compilar y el error nombra el campo. Ver `lib/typeGuards.ts`.
type _GCreateTarea = Assert<SameKeys<z.infer<typeof createTareaSchema>, CreateTareaInput>>;
type _GUpdateTarea = Assert<SameKeys<z.infer<typeof updateTareaSchema>, UpdateTareaInput>>;
type _GSetAsignacionesTarea = Assert<SameKeys<z.infer<typeof setAsignacionesTareaSchema>, SetAsignacionesTareaInput>>;
type _GFinalizarTarea = Assert<SameKeys<z.infer<typeof finalizarTareaSchema>, FinalizarTareaInput>>;
