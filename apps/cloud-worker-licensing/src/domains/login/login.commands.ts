// src/domains/login/login.commands.ts

import type { ApplyCommand } from "../../lib/hub";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

export function setTurnoPartido(input: {
	id_usuario: string;
	fecha: string | null;
	turno_partido: boolean;
}): BuiltCommand {
	return {
		commandName: "set_turno_partido_hoy",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					INSERT INTO Fichaje_Dia (ID_Usuario, Fecha, Turno_Partido)
					VALUES (?1, COALESCE(?2, date('now','localtime')), ?3)
					ON CONFLICT(ID_Usuario, Fecha) DO UPDATE SET
						Turno_Partido = excluded.Turno_Partido;
				`,
				args: [input.id_usuario, input.fecha, input.turno_partido ? 1 : 0],
			},
		},
		cloudPayload: input,
	};
}

export function completeInitialSetup(input: {
	id_usuario: string;
	email_nuevo: string;
	password_hash: string;
}): BuiltCommand {
	return {
		commandName: "complete_initial_setup",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Usuarios
					SET Email = ?2, Password_Hash = ?3, Requiere_Setup = 0
					WHERE ID_Usuario = ?1;
				`,
				args: [input.id_usuario, input.email_nuevo, input.password_hash],
			},
		},
		cloudPayload: { id_usuario: input.id_usuario, email_nuevo: input.email_nuevo },
	};
}

// TRAB-02: la hora de fichaje la fija SIEMPRE el backend (datetime('now','localtime'), que el DO
// resuelve a literal al aplicar); nunca la envía el cliente, para que el control horario sea veraz.
// La fecha viene ya calculada en servidor por la ruta.
export function punchEntrada(input: {
	id_usuario: string;
	fecha: string;
	parte: number;
}): BuiltCommand {
	// TRAB-07: el UUID se genera aqui, en un paso `value`, y entra en el INSERT. `ID_Fichaje` es
	// TEXT PRIMARY KEY sin DEFAULT y en SQLite una PK de texto ADMITE NULL: omitirla no daba error,
	// creaba el fichaje sin clave y luego la salida (WHERE ID_Fichaje = ?) no casaba ninguna fila,
	// asi que la jornada no cerraba nunca. Es el patron de CLAUDE.md §9 para toda TEXT PRIMARY KEY.
	const steps: any[] = [
		{
			kind: "value",
			saveAs: "id_fichaje",
			sql: "SELECT ?1;",
			args: [crypto.randomUUID()],
		},
		{
			kind: "execute",
			sql: `
				INSERT INTO Fichajes (
					ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado, Cerrado_Automatico
				)
				VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'), NULL, 'ABIERTO', 0);
			`,
			args: [{ $ref: "id_fichaje" }, input.id_usuario, input.fecha, input.parte],
		},
	];

	return {
		commandName: "punch",
		command: {
			type: "tenantDb.transaction",
			payload: { steps, resultKey: "id_fichaje" },
		},
		cloudPayload: { ...input, tipo: "entrada" },
	};
}

export function punchSalida(input: {
	id_usuario: string;
	id_fichaje: string;
}): BuiltCommand {
	return {
		commandName: "punch",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Fichajes
					SET Hora_Salida = datetime('now','localtime'),
						Estado = 'CERRADO',
						Cerrado_Automatico = 0,
						Cierre_Motivo = NULL,
						Incidencia = NULL
					WHERE ID_Fichaje = ?1;
				`,
				args: [input.id_fichaje],
			},
		},
		cloudPayload: { ...input, tipo: "salida" },
	};
}
