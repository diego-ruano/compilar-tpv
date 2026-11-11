// src/domains/login/login.commands.ts

import { nuevoId } from "../../lib/ids";
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
					SELECT ?1, COALESCE(?2, date('now','localtime')), ?3
                    WHERE ?3=1 OR NOT EXISTS (
                        SELECT 1 FROM Fichajes
                        WHERE ID_Usuario=?1 AND Fecha=COALESCE(?2, date('now','localtime')) AND Parte=2
                    )
					ON CONFLICT(ID_Usuario, Fecha) DO UPDATE SET
						Turno_Partido = excluded.Turno_Partido;
				`,
				args: [input.id_usuario, input.fecha, input.turno_partido ? 1 : 0],
			},
		},
		cloudPayload: input,
	};
}

// REV-06: y aquí estaba `completeInitialSetup`, el comando que aquella ruta aplicaba. El setup
// inicial lo escribe la Main en su SQLite y sube por el outbox, que es el camino de verdad.

// La hora del fichaje no viaja en el cuerpo de la petición: se escribe `datetime('now','localtime')`
// y la resuelve el Durable Object al aplicar, con el reloj local del equipo que ficha (CFG-04). La
// fecha la calcula la ruta con ese mismo reloj (REV-03), para que las dos digan lo mismo.
export function punchEntrada(input: {
	id_usuario: string;
	fecha: string;
	parte: number;
}): BuiltCommand {
	// TRAB-07: el UUID se genera aqui, en un paso `value`, y entra en el INSERT. `ID_Fichaje` es
	// TEXT PRIMARY KEY sin DEFAULT y en SQLite una PK de texto ADMITE NULL: omitirla no daba error,
	// creaba el fichaje sin clave y luego la salida (WHERE ID_Fichaje = ?) no casaba ninguna fila,
	// asi que la jornada no cerraba nunca. Es el patron de docs/arquitectura/sincronizacion.md para toda TEXT PRIMARY KEY.
	const steps: any[] = [
		{
			kind: "value",
			saveAs: "id_fichaje",
			sql: "SELECT ?1;",
			args: [nuevoId()],
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
