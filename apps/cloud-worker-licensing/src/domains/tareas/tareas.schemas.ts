// src/domains/tareas/tareas.schemas.ts
//
// Validacion de entrada de tareas. Replica las reglas del dominio Rust:
// titulo requerido, textos opcionales trim -> null, ids positivos y crear con
// al menos un trabajador asignado.

import { z } from "zod";
import type {
	CreateTareaInput as ContractCreateTareaInput,
	FinalizarTareaInput as ContractFinalizarTareaInput,
	SetAsignacionesTareaInput as ContractSetAsignacionesTareaInput,
	UpdateTareaInput as ContractUpdateTareaInput,
} from "@tpv/contracts";

const idStr = z.string().trim().min(1);

function cleanOptional(v: unknown): string | null {
	const t = (v ?? "").toString().trim();
	return t.length ? t : null;
}

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => (s ?? "").toString().trim()).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

const optStr = z.string().nullish().transform(cleanOptional);
const idsTrabajadores = z.array(z.string()).default([]).transform(normalizeIds);

export const createTareaSchema = z.object({
	titulo: z.string().trim().min(1, "titulo required"),
	descripcion: optStr,
	fecha_limite: optStr,
	ids_trabajadores: idsTrabajadores.refine((ids) => ids.length > 0, {
		message: "ids_trabajadores required",
	}),
});

export const updateTareaSchema = z.object({
	titulo: z.string().trim().min(1, "titulo required"),
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
