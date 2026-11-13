// src/domains/tareas/tareas.commands.ts
//
// Escrituras de tareas expresadas como comandos para el Durable Object. El SQL
// replica tpv-infra-sqlite/src/tareas.rs y el DO aporta transaccion,
// idempotencia por Op_Id y broadcast.

import { nuevoId } from "../../lib/ids";
import { recortar } from "../../lib/texto";
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

function normalizeIds(ids: string[]): string[] {
	const set = new Set(
		(ids ?? []).map((s) => recortar((s ?? "").toString())).filter((s) => s.length > 0),
	);
	return Array.from(set).sort();
}

function cleanOrNull(s: unknown): string | null {
	const t = recortar((s ?? "").toString());
	return t.length ? t : null;
}

function assignmentSteps(idTarea: string | typeof REF_ID_TAREA, idsRaw: string[]): any[] {
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

	// DO-01: los asignados que se quedan, en un solo parámetro (un array JSON): esta sentencia se
	// replica y el SQLite del DO admite 100 parámetros por sentencia. Igual que la Main
	// (`apply_set_asignaciones_core`).
	steps.push({
		kind: "execute",
		sql: `
			DELETE FROM Tarea_Asignaciones
			WHERE ID_Tarea = ?1
				AND ID_Trabajador NOT IN (SELECT value FROM json_each(?2));
		`,
		args: [idTarea, JSON.stringify(ids)],
	});

	// TAR-02 (semántica decidida): `INSERT OR IGNORE` es intencional. Un trabajador que ya finalizó
	// y sigue en el conjunto conserva su FINALIZADA (re-guardar no reabre); solo quien se quita se
	// borra arriba, y si se le re-añade luego entra como fila nueva ('PENDIENTE'). Espejo del repo.
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
	const ids = normalizeIds(input.ids_trabajadores ?? []);
	const cloudPayload = {
		titulo: recortar(input.titulo),
		descripcion: cleanOrNull(input.descripcion),
		fecha_limite: cleanOrNull(input.fecha_limite),
		ids_trabajadores: ids,
	};

	const steps: any[] = [
		{
			kind: "value",
			saveAs: "id_tarea",
			sql: "SELECT ?1;",
			args: [nuevoId()],
		},
		{
			kind: "execute",
			sql: `
				INSERT INTO Tareas (
					ID_Tarea,
					Titulo,
					Descripcion,
					Fecha_Limite,
					Fecha_Creacion
				)
				VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'));
			`,
			args: [
				REF_ID_TAREA,
				cloudPayload.titulo,
				cloudPayload.descripcion,
				cloudPayload.fecha_limite,
			],
		},
		...assignmentSteps(REF_ID_TAREA, ids),
	];

	return {
		commandName: "tareas_create_tarea",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id_tarea" } },
		cloudPayload,
	};
}

export function updateTarea(idTarea: string, input: UpdateTareaInput): BuiltCommand {
	const cloudPayload = {
		id_tarea: idTarea,
		titulo: recortar(input.titulo),
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
	idTarea: string,
	input: SetAsignacionesTareaInput,
): BuiltCommand {
	const ids = normalizeIds(input.ids_trabajadores ?? []);
	const steps = assignmentSteps(idTarea, ids);

	return {
		commandName: "tareas_set_asignaciones_tarea",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_tarea: idTarea, ids_trabajadores: ids },
	};
}

// TAR-05: borrar es mandar a la papelera. Las listas ya filtraban por
// `COALESCE(Estado,'ABIERTA')='ABIERTA'`, asi que la tarea desaparece de la UI igual que antes,
// pero conserva sus asignaciones para poder restaurarla tal cual estaba.
export function deleteTarea(idTarea: string): BuiltCommand {
	return {
		commandName: "tareas_delete_tarea",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Tareas
					SET Estado = 'ELIMINADA'
					WHERE ID_Tarea = ?1
						AND COALESCE(Estado, 'ABIERTA') <> 'ELIMINADA';
				`,
				args: [idTarea],
			},
		},
		cloudPayload: { id_tarea: idTarea },
	};
}

export function restaurarTarea(idTarea: string): BuiltCommand {
	return {
		commandName: "tareas_restaurar_tarea",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Tareas
					SET Estado = 'ABIERTA'
					WHERE ID_Tarea = ?1
						AND COALESCE(Estado, 'ABIERTA') = 'ELIMINADA';
				`,
				args: [idTarea],
			},
		},
		cloudPayload: { id_tarea: idTarea },
	};
}

// Vaciar la papelera es lo unico que borra de verdad. Las asignaciones se borran a mano antes que
// las tareas: el CASCADE de la FK esta en el esquema, pero en la nube puede no aplicarse (DB-03).
export function vaciarPapelera(): BuiltCommand {
	const steps: any[] = [
		{
			kind: "execute",
			sql: `
				DELETE FROM Tarea_Asignaciones
				WHERE ID_Tarea IN (
					SELECT ID_Tarea FROM Tareas WHERE COALESCE(Estado, 'ABIERTA') = 'ELIMINADA'
				);
			`,
			args: [],
		},
		{
			kind: "execute",
			saveAs: "borradas",
			sql: "DELETE FROM Tareas WHERE COALESCE(Estado, 'ABIERTA') = 'ELIMINADA';",
			args: [],
		},
	];

	return {
		commandName: "tareas_vaciar_papelera",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "borradas" } },
		cloudPayload: {},
	};
}

export function marcarFinalizada(
	idTarea: string,
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
