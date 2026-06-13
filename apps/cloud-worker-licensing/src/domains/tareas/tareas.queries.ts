// src/domains/tareas/tareas.queries.ts
//
// Lecturas de tareas. SQL portado de tpv-infra-sqlite/src/tareas.rs y columnas
// en PascalCase para encajar con los DTOs generados de @tpv/contracts.

import type { Client } from "@libsql/client/web";

import type {
	MisTareasRow,
	TareaAdminRow,
	TareaAsignadoRow,
	TareaRow,
	TrabajadorUI,
} from "@tpv/contracts";

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

export async function getTrabajadores(db: Client): Promise<TrabajadorUI[]> {
	const rs = await db.execute(`
		SELECT
			t.ID_Trabajador,
			t.ID_Usuario,
			u.Nombre,
			u.Apellido,
			t.Puesto,
			u.Email
		FROM Trabajadores t
		JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
		WHERE u.Estado = 'Activo'
		ORDER BY u.Nombre ASC;
	`);
	return rows(rs) as TrabajadorUI[];
}

export async function getTareasAdmin(db: Client): Promise<TareaAdminRow[]> {
	const rs = await db.execute(`
		SELECT
			t.ID_Tarea,
			t.Titulo,
			t.Descripcion,
			t.Fecha_Creacion,
			t.Fecha_Limite,
			(
				SELECT COUNT(*)
				FROM Tarea_Asignaciones a
				WHERE a.ID_Tarea = t.ID_Tarea
			) AS Total_Asignados,
			(
				SELECT COUNT(*)
				FROM Tarea_Asignaciones a
				WHERE a.ID_Tarea = t.ID_Tarea
					AND a.Estado = 'FINALIZADA'
			) AS Total_Finalizadas
		FROM Tareas t
		WHERE COALESCE(t.Estado, 'ABIERTA') = 'ABIERTA'
		ORDER BY t.ID_Tarea DESC;
	`);
	return rows(rs) as TareaAdminRow[];
}

export async function getTareaById(
	db: Client,
	idTarea: string,
): Promise<TareaRow | null> {
	const rs = await db.execute({
		sql: `
			SELECT ID_Tarea, Titulo, Descripcion, Fecha_Creacion, Fecha_Limite
			FROM Tareas
			WHERE ID_Tarea = ?1
			LIMIT 1;
		`,
		args: [idTarea],
	});
	return (rows(rs)[0] ?? null) as TareaRow | null;
}

export async function getTareaAsignados(
	db: Client,
	idTarea: string,
): Promise<TareaAsignadoRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				a.ID_Trabajador,
				u.Nombre,
				u.Apellido,
				t.Puesto,
				a.Asignada_At,
				a.Estado,
				a.Finalizada_At
			FROM Tarea_Asignaciones a
			JOIN Trabajadores t ON t.ID_Trabajador = a.ID_Trabajador
			JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
			WHERE a.ID_Tarea = ?1
			ORDER BY u.Nombre ASC;
		`,
		args: [idTarea],
	});
	return rows(rs) as TareaAsignadoRow[];
}

export async function getMisTareas(
	db: Client,
	idTrabajador: string,
): Promise<MisTareasRow[]> {
	const rs = await db.execute({
		sql: `
			SELECT
				t.ID_Tarea,
				t.Titulo,
				t.Descripcion,
				t.Fecha_Limite,
				a.Asignada_At,
				a.Estado,
				a.Finalizada_At
			FROM Tarea_Asignaciones a
			JOIN Tareas t ON t.ID_Tarea = a.ID_Tarea
			WHERE a.ID_Trabajador = ?1
				AND COALESCE(t.Estado, 'ABIERTA') = 'ABIERTA'
				AND (
					a.Estado <> 'FINALIZADA'
					OR date(a.Finalizada_At) = date('now','localtime')
				)
			ORDER BY
				CASE WHEN a.Estado='PENDIENTE' THEN 0 ELSE 1 END,
				t.Fecha_Limite ASC,
				t.ID_Tarea DESC;
		`,
		args: [idTrabajador],
	});
	return rows(rs) as MisTareasRow[];
}
