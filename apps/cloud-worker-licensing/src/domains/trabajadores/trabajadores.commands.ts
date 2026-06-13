// src/domains/trabajadores/trabajadores.commands.ts

import type { ApplyCommand } from "../../lib/hub";
import type { PredeterminadoItem } from "./trabajadores.queries";
import type {
	AsignacionCreateInput,
	AsignacionUpdateInput,
	CopySemanaInput,
	TrabajadorCreateInput,
	TrabajadorUpdateInput,
} from "./trabajadores.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID_USUARIO = { $ref: "id_usuario" } as const;
const REF_ID_TRABAJADOR = { $ref: "id_trabajador" } as const;

export function createTrabajador(input: TrabajadorCreateInput): BuiltCommand {
	const steps = [
		{
			kind: "value",
			saveAs: "id_usuario",
			sql: "SELECT ?1;",
			args: [crypto.randomUUID()],
		},
		{
			kind: "execute",
			sql: `
				INSERT INTO Usuarios (
					ID_Usuario,
					ID_Rol,
					Email,
					Password_Hash,
					Nombre,
					Apellido,
					Estado
				)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);
			`,
			args: [
				REF_ID_USUARIO,
				input.id_rol,
				input.email,
				input.password_hash,
				input.nombre,
				input.apellido,
				input.estado,
			],
		},
		{
			kind: "value",
			saveAs: "id_trabajador",
			sql: "SELECT ?1;",
			args: [crypto.randomUUID()],
		},
		{
			kind: "execute",
			sql: `
				INSERT INTO Trabajadores (
					ID_Trabajador,
					ID_Usuario,
					DNI,
					Telefono,
					Puesto,
					IBAN,
					Numero_Seguridad_Social,
					Fecha_Inicio_Contrato,
					Fecha_Fin_Contrato
				)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);
			`,
			args: [
				REF_ID_TRABAJADOR,
				REF_ID_USUARIO,
				input.dni,
				input.telefono,
				input.puesto,
				input.iban,
				input.numero_seguridad_social,
				input.fecha_inicio_contrato,
				input.fecha_fin_contrato,
			],
		},
	];

	return {
		commandName: "trabajadores_create",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "id_trabajador" },
		},
		cloudPayload: input,
	};
}

export function updateTrabajador(
	idTrabajador: string,
	input: TrabajadorUpdateInput,
): BuiltCommand {
	const updateUsuario = input.password_hash
		? {
				kind: "execute",
				sql: `
					UPDATE Usuarios
					SET
						ID_Rol = ?1,
						Email = ?2,
						Nombre = ?3,
						Apellido = ?4,
						Estado = ?5,
						Password_Hash = ?6
					WHERE ID_Usuario = ?7;
				`,
				args: [
					input.id_rol,
					input.email,
					input.nombre,
					input.apellido,
					input.estado,
					input.password_hash,
					input.id_usuario,
				],
			}
		: {
				kind: "execute",
				sql: `
					UPDATE Usuarios
					SET
						ID_Rol = ?1,
						Email = ?2,
						Nombre = ?3,
						Apellido = ?4,
						Estado = ?5
					WHERE ID_Usuario = ?6;
				`,
				args: [
					input.id_rol,
					input.email,
					input.nombre,
					input.apellido,
					input.estado,
					input.id_usuario,
				],
			};

	return {
		commandName: "trabajadores_update",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					updateUsuario,
					{
						kind: "execute",
						sql: `
							UPDATE Trabajadores
							SET
								DNI = ?1,
								Telefono = ?2,
								Puesto = ?3,
								IBAN = ?4,
								Numero_Seguridad_Social = ?5,
								Fecha_Inicio_Contrato = ?6,
								Fecha_Fin_Contrato = ?7
							WHERE ID_Trabajador = ?8;
						`,
						args: [
							input.dni,
							input.telefono,
							input.puesto,
							input.iban,
							input.numero_seguridad_social,
							input.fecha_inicio_contrato,
							input.fecha_fin_contrato,
							idTrabajador,
						],
					},
				],
			},
		},
		cloudPayload: { ...input, id_trabajador: idTrabajador },
	};
}

export function createAsignacion(input: AsignacionCreateInput): BuiltCommand {
	const idAsignacion = crypto.randomUUID();
	return {
		commandName: "horarios_create_asignacion",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "execute",
						sql: `
							INSERT INTO Asignacion_Turnos (
								ID_Asignacion,
								ID_Trabajador,
								Fecha,
								ID_Turno,
								Area,
								Hora_Inicio,
								Hora_Fin,
								Notas
							)
							VALUES (?1, ?2, date(?3), ?4, ?5, ?6, ?7, ?8);
						`,
						args: [
							idAsignacion,
							input.id_trabajador,
							input.fecha,
							input.id_turno,
							input.area,
							input.hora_inicio,
							input.hora_fin,
							input.notas,
						],
					},
					{
						kind: "value",
						saveAs: "id_asignacion",
						sql: "SELECT ?1;",
						args: [idAsignacion],
					},
				],
				resultKey: "id_asignacion",
			},
		},
		cloudPayload: input,
	};
}

export function updateAsignacion(
	idAsignacion: string,
	input: AsignacionUpdateInput,
): BuiltCommand {
	return {
		commandName: "horarios_update_asignacion",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Asignacion_Turnos
					SET
						ID_Turno = ?2,
						Area = ?3,
						Hora_Inicio = ?4,
						Hora_Fin = ?5,
						Notas = ?6
					WHERE ID_Asignacion = ?1;
				`,
				args: [
					idAsignacion,
					input.id_turno,
					input.area,
					input.hora_inicio,
					input.hora_fin,
					input.notas,
				],
			},
		},
		cloudPayload: { ...input, id_asignacion: idAsignacion },
	};
}

export function deleteAsignacion(idAsignacion: string): BuiltCommand {
	return {
		commandName: "horarios_delete_asignacion",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: "DELETE FROM Asignacion_Turnos WHERE ID_Asignacion = ?1;",
				args: [idAsignacion],
			},
		},
		cloudPayload: { id_asignacion: idAsignacion },
	};
}

export function copySemana(input: CopySemanaInput): BuiltCommand {
	const steps: any[] = [];
	if (input.overwrite) {
		steps.push({
			kind: "execute",
			sql: `
				DELETE FROM Asignacion_Turnos
				WHERE Fecha >= date(?1)
					AND Fecha < date(?1, '+7 day');
			`,
			args: [input.to_monday],
		});
	}
	steps.push({
		kind: "execute",
		saveAs: "inserted",
		sql: `
			INSERT INTO Asignacion_Turnos (
				ID_Asignacion,
				ID_Trabajador,
				Fecha,
				ID_Turno,
				Area,
				Hora_Inicio,
				Hora_Fin,
				Notas
			)
			SELECT
				lower(hex(randomblob(16))),
				a.ID_Trabajador,
				date(a.Fecha, printf('%+d day',
					CAST((julianday(date(?2)) - julianday(date(?1))) AS INTEGER)
				)),
				a.ID_Turno,
				a.Area,
				a.Hora_Inicio,
				a.Hora_Fin,
				a.Notas
			FROM Asignacion_Turnos a
			WHERE a.Fecha >= date(?1)
				AND a.Fecha < date(?1, '+7 day');
		`,
		args: [input.from_monday, input.to_monday],
	});

	return {
		commandName: "horarios_copy_semana_asignaciones",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "inserted" },
		},
		cloudPayload: input,
	};
}

export function setPredeterminadoDesdeSemana(
	fechaLunes: string,
	items: PredeterminadoItem[],
): BuiltCommand {
	if (!items.length) {
		return {
			commandName: "horarios_set_predeterminado_desde_semana",
			command: {
				type: "tenantDb.transaction",
				payload: {
					steps: [{ kind: "value", saveAs: "ok", sql: "SELECT 0;" }],
					resultKey: "ok",
				},
			},
			cloudPayload: { fecha_lunes: fechaLunes, items: [] },
		};
	}

	const trabajadores = Array.from(
		new Set(items.map((it) => it.id_trabajador)),
	).sort();

	const steps: any[] = trabajadores.map((idTrabajador) => ({
		kind: "execute",
		sql: "DELETE FROM Horario_Predeterminado WHERE ID_Trabajador = ?1;",
		args: [idTrabajador],
	}));

	for (const it of items) {
		steps.push({
			kind: "execute",
			sql: `
				INSERT INTO Horario_Predeterminado (
					ID_Default,
					ID_Trabajador,
					Weekday,
					Orden,
					ID_Turno,
					Area,
					Hora_Inicio,
					Hora_Fin,
					Notas
				)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);
			`,
			args: [
				crypto.randomUUID(),
				it.id_trabajador,
				it.weekday,
				it.orden,
				it.id_turno,
				it.area,
				it.hora_inicio,
				it.hora_fin,
				it.notas,
			],
		});
	}

	steps.push({ kind: "value", saveAs: "ok", sql: "SELECT 1;" });

	return {
		commandName: "horarios_set_predeterminado_desde_semana",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "ok" },
		},
		cloudPayload: { fecha_lunes: fechaLunes, items },
	};
}
