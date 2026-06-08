// src/domains/tareas/tareas.commands.ts
//
// Escrituras de tareas expresadas como comandos para el Durable Object. El SQL
// replica tpv-infra-sqlite/src/tareas.rs y el DO aporta transaccion,
// idempotencia por Op_Id y broadcast.

import type { ApplyCommand } from "../../lib/hub";
import type {
	CreateTareaInput,
	FinalizarTareaInput,
	SetAsignacionesTareaInput,
	UpdateTareaInput,
} from "./tareas.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID_TAREA = { $ref: "id_tarea" } as const;

function normalizeIds(ids: number[]): number[] {
	const set = new Set(
		(ids ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0).map(Math.trunc),
	);
	return Array.from(set).sort((a, b) => a - b);
}

function cleanOrNull(s: unknown): string | null {
	const t = (s ?? "").toString().trim();
	return t.length ? t : null;
}

function assignmentSteps(idTarea: number | typeof REF_ID_TAREA, idsRaw: number[]): any[] {
	const ids = normalizeIds(idsRaw);
	const steps: any[] = [];

	if (ids.length === 0) {
		steps.push({
			kind: "execute",
			sql: "DELETE FROM Tarea_Asignaciones WHERE ID_Tarea = ?1;",
			args: [idTarea],
		});
		return steps;
	}

	const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
	steps.push({
		kind: "execute",
		sql: `
			DELETE FROM Tarea_Asignaciones
			WHERE ID_Tarea = ?1
				AND ID_Trabajador NOT IN (${placeholders});
		`,
		args: [idTarea, ...ids],
	});

	for (const idTrabajador of ids) {
		steps.push({
			kind: "execute",
			sql: `
				INSERT OR IGNORE INTO Tarea_Asignaciones (
					ID_Tarea,
					ID_Trabajador,
					Asignada_At,
					Estado
				)
				VALUES (
					?1,
					?2,
					datetime('now','localtime'),
					'PENDIENTE'
				);
			`,
			args: [idTarea, idTrabajador],
		});
	}

	return steps;
}

export function createTarea(input: CreateTareaInput): BuiltCommand {
	const ids = normalizeIds(input.ids_trabajadores);
	const cloudPayload = {
		titulo: input.titulo.trim(),
		descripcion: cleanOrNull(input.descripcion),
		fecha_limite: cleanOrNull(input.fecha_limite),
		ids_trabajadores: ids,
	};

	const steps: any[] = [
		{
			kind: "execute",
			sql: `
				INSERT INTO Tareas (
					Titulo,
					Descripcion,
					Fecha_Limite
				)
				VALUES (?1, ?2, ?3);
			`,
			args: [cloudPayload.titulo, cloudPayload.descripcion, cloudPayload.fecha_limite],
		},
		{
			kind: "value",
			saveAs: "id_tarea",
			sql: "SELECT last_insert_rowid();",
		},
		...assignmentSteps(REF_ID_TAREA, ids),
	];

	return {
		commandName: "tareas_create_tarea",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id_tarea" } },
		cloudPayload,
	};
}

export function updateTarea(idTarea: number, input: UpdateTareaInput): BuiltCommand {
	const cloudPayload = {
		id_tarea: idTarea,
		titulo: input.titulo.trim(),
		descripcion: cleanOrNull(input.descripcion),
		fecha_limite: cleanOrNull(input.fecha_limite),
	};

	return {
		commandName: "tareas_update_tarea",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Tareas
					SET
						Titulo = ?2,
						Descripcion = ?3,
						Fecha_Limite = ?4
					WHERE ID_Tarea = ?1;
				`,
				args: [
					cloudPayload.id_tarea,
					cloudPayload.titulo,
					cloudPayload.descripcion,
					cloudPayload.fecha_limite,
				],
			},
		},
		cloudPayload,
	};
}

export function setAsignacionesTarea(
	idTarea: number,
	input: SetAsignacionesTareaInput,
): BuiltCommand {
	const ids = normalizeIds(input.ids_trabajadores);
	const steps = assignmentSteps(idTarea, ids);

	return {
		commandName: "tareas_set_asignaciones_tarea",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_tarea: idTarea, ids_trabajadores: ids },
	};
}

export function deleteTarea(idTarea: number): BuiltCommand {
	const steps: any[] = [
		{
			kind: "execute",
			sql: "DELETE FROM Tarea_Asignaciones WHERE ID_Tarea = ?1;",
			args: [idTarea],
		},
		{
			kind: "execute",
			saveAs: "deleted",
			sql: "DELETE FROM Tareas WHERE ID_Tarea = ?1;",
			args: [idTarea],
		},
	];

	return {
		commandName: "tareas_delete_tarea",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "deleted" } },
		cloudPayload: { id_tarea: idTarea },
	};
}

export function marcarFinalizada(
	idTarea: number,
	input: FinalizarTareaInput,
): BuiltCommand {
	const cloudPayload = {
		id_tarea: idTarea,
		id_trabajador: input.id_trabajador,
	};

	return {
		commandName: "tareas_marcar_tarea_finalizada",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Tarea_Asignaciones
					SET
						Estado = 'FINALIZADA',
						Finalizada_At = COALESCE(Finalizada_At, datetime('now','localtime'))
					WHERE ID_Tarea = ?1
						AND ID_Trabajador = ?2;
				`,
				args: [cloudPayload.id_tarea, cloudPayload.id_trabajador],
			},
		},
		cloudPayload,
	};
}
