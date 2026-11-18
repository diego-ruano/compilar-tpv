// src/domains/login/login.commands.ts

import { nuevoId } from "../../lib/ids";
import type { ApplyCommand } from "../../lib/hub";
import { INICIO_MAS_ANTIGUO } from "./login.queries";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

/**
 * El turno partido de un día. `fecha` es la fecha efectiva, ya resuelta por la ruta: la que trae la
 * petición o, sin ella, «hoy» de quien la manda.
 *
 * Va como paso `value` y el resultado es `{ fecha, cambiados }`: el DO guarda los literales de los
 * pasos `value` en el `Result_Json` desde el primer intento, así que un reintento con la misma
 * `X-Idempotency-Key` recupera el día que se escribió aunque haya pasado la medianoche; `cambiados`
 * sólo está si el resultado guardado se llegó a refinar. La ruta mira el estado de ESE día
 * cuando no lo está (`decidirPorEstado`; salió en AUD-26). El `cloudPayload` sigue siendo la
 * petición tal cual: es lo que firma el reintento como el mismo.
 */
export function setTurnoPartido(
	input: {
		id_usuario: string;
		fecha: string | null;
		turno_partido: boolean;
	},
	fecha: string,
): BuiltCommand {
	const FECHA = { $ref: "fecha" } as const;
	return {
		commandName: "set_turno_partido_hoy",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{ kind: "value", saveAs: "fecha", sql: "SELECT ?1;", args: [fecha] },
					{
						kind: "execute",
						saveAs: "cambiados",
						sql: `
							INSERT INTO Fichaje_Dia (ID_Usuario, Fecha, Turno_Partido)
							SELECT ?1, ?2, ?3
							WHERE ?3=1 OR NOT EXISTS (
								SELECT 1 FROM Fichajes
								WHERE ID_Usuario=?1 AND Fecha=?2 AND Parte=2
							)
							ON CONFLICT(ID_Usuario, Fecha) DO UPDATE SET
								Turno_Partido = excluded.Turno_Partido;
						`,
						args: [input.id_usuario, FECHA, input.turno_partido ? 1 : 0],
					},
				],
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
//
// TRA-INC-04: si una entrada o una salida toca lo deciden las guardas de cada comando, dentro del
// lote (SYNC-30), y no una lectura de la ruta antes de `apply`: entre las dos puede fichar el mismo
// trabajador en otra Handy o en la Main, y el reintento de un fichaje que ya entró se encontraba a
// sí mismo («Tienes un fichaje abierto», «No hay fichaje abierto»). Las frases son las de la Main
// (`exec_punch`, en `tpv-infra-sqlite/src/login.rs`), con un 409 (AUD-47).

/** Las frases con las que se rechaza un fichaje: las mismas que la Main. */
export const FRASES_FICHAJE = {
	abierto: "Tienes un fichaje abierto. Ficha salida antes de fichar entrada.",
	parteUnoAbierta: "La Parte 1 no está cerrada. Ficha salida primero.",
	partidoCompleto: "Ya has completado el turno partido hoy.",
	sinPartido: "Hoy no tienes turno partido. Ya has fichado el día.",
	// Lo que la ruta leyó ya no es lo que hay: otro equipo ha fichado entre medias.
	cambiado: "El fichaje ha cambiado en otro equipo. Vuelve a intentarlo.",
	salidaYaFichada: "La salida ya está fichada.",
	sinAbierto: "No hay fichaje abierto para cerrar (primero ficha entrada).",
} as const;

/** La jornada en curso de `?1` (RI-05: `INICIO_MAS_ANTIGUO`), como `getOpenPunch`. */
const EN_CURSO = `SELECT 1 FROM Fichajes
	WHERE ID_Usuario = ?1 AND Estado = 'ABIERTO' AND Hora_Entrada IS NOT NULL
		AND Hora_Salida IS NULL AND Hora_Entrada >= ${INICIO_MAS_ANTIGUO}`;

/** Una jornada de `?1` de las mismas horas que ya tiene la salida puesta. */
const CERRADA_HACE_POCO = `SELECT 1 FROM Fichajes
	WHERE ID_Usuario = ?1 AND Hora_Salida IS NOT NULL AND Hora_Entrada >= ${INICIO_MAS_ANTIGUO}`;

/** ¿El turno partido de `?1` el día `?2`? */
const PARTIDO = `COALESCE((SELECT Turno_Partido FROM Fichaje_Dia WHERE ID_Usuario = ?1 AND Fecha = ?2), 0)`;
const PARTE = (n: 1 | 2) => `SELECT 1 FROM Fichajes WHERE ID_Usuario = ?1 AND Fecha = ?2 AND Parte = ${n}`;

function guarda(sql: string, args: unknown[], frase: string) {
	return { kind: "guard", sql, args, error: frase, status: 409 };
}

export function punchEntrada(input: {
	id_usuario: string;
	fecha: string;
	parte: number;
}): BuiltCommand {
	const { id_usuario: usuario, fecha, parte } = input;
	// TRAB-07: el UUID se genera aqui, en un paso `value`, y entra en el INSERT. `ID_Fichaje` es
	// TEXT PRIMARY KEY sin DEFAULT y en SQLite una PK de texto ADMITE NULL: omitirla no daba error,
	// creaba el fichaje sin clave y luego la salida (WHERE ID_Fichaje = ?) no casaba ninguna fila,
	// asi que la jornada no cerraba nunca. Es el patron de docs/arquitectura/sincronizacion.md para toda TEXT PRIMARY KEY.
	const steps: any[] = [
		{ kind: "value", saveAs: "id_fichaje", sql: "SELECT ?1;", args: [nuevoId()] },
		// El día de la jornada, con el resultado: el reintento lo recupera aunque llegue pasada la
		// medianoche, y la ruta devuelve el estado de ESE día.
		{ kind: "value", saveAs: "fecha", sql: "SELECT ?1;", args: [fecha] },
		// En el orden en que lo mira la Main. RI-05: el abierto que bloquea puede ser de ayer.
		guarda(`SELECT NOT EXISTS (${EN_CURSO});`, [usuario], FRASES_FICHAJE.abierto),
		guarda(
			`SELECT NOT EXISTS (${PARTE(1)} AND Hora_Salida IS NULL);`,
			[usuario, fecha],
			FRASES_FICHAJE.parteUnoAbierta,
		),
		guarda(
			`SELECT NOT (${PARTIDO} = 1 AND EXISTS (${PARTE(2)}));`,
			[usuario, fecha],
			FRASES_FICHAJE.partidoCompleto,
		),
		guarda(
			`SELECT NOT (${PARTIDO} = 0 AND EXISTS (${PARTE(1)}));`,
			[usuario, fecha],
			FRASES_FICHAJE.sinPartido,
		),
		// La parte que eligió la ruta sigue siendo la que toca.
		guarda(
			`SELECT ?3 = CASE WHEN EXISTS (${PARTE(1)}) THEN 2 ELSE 1 END;`,
			[usuario, fecha, parte],
			FRASES_FICHAJE.cambiado,
		),
		{
			kind: "execute",
			sql: `
				INSERT INTO Fichajes (
					ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado, Cerrado_Automatico
				)
				VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'), NULL, 'ABIERTO', 0);
			`,
			args: [{ $ref: "id_fichaje" }, usuario, { $ref: "fecha" }, parte],
		},
	];

	return {
		commandName: "punch",
		command: { type: "tenantDb.transaction", payload: { steps } },
		// La petición tal cual, sin lo que la ruta lee de la base: es lo que firma el reintento como
		// el mismo, y el de una entrada que ya entró leería otra parte.
		cloudPayload: { id_usuario: usuario, tipo: "entrada" },
	};
}

/**
 * La salida de la jornada en curso, `id_fichaje`, que la ruta ha leído (`null` si no había ninguna:
 * el lote lo dice con su frase, o el gate contesta lo guardado si es el reintento de una que ya
 * entró). `fecha` es la de esa jornada, la que se devuelve.
 */
export function punchSalida(input: {
	id_usuario: string;
	id_fichaje: string | null;
	fecha: string;
}): BuiltCommand {
	const { id_usuario: usuario, id_fichaje: fichaje, fecha } = input;
	const steps: any[] = [
		{ kind: "value", saveAs: "fecha", sql: "SELECT ?1;", args: [fecha] },
		// Sin jornada en curso: si la salida la acaba de fichar otro equipo, se dice eso, y no que
		// fiche primero la entrada.
		guarda(
			`SELECT EXISTS (${EN_CURSO}) OR NOT EXISTS (${CERRADA_HACE_POCO});`,
			[usuario],
			FRASES_FICHAJE.salidaYaFichada,
		),
		guarda(`SELECT EXISTS (${EN_CURSO});`, [usuario], FRASES_FICHAJE.sinAbierto),
		// La que leyó la ruta sigue abierta.
		guarda(
			`SELECT EXISTS (SELECT 1 FROM Fichajes WHERE ID_Fichaje = ?1 AND ID_Usuario = ?2 AND Hora_Salida IS NULL);`,
			[fichaje ?? "", usuario],
			FRASES_FICHAJE.salidaYaFichada,
		),
		{
			kind: "execute",
			// Con `Hora_Salida IS NULL` también en la sentencia: quien la aplica después (la Main) no
			// pisa una salida que ya tenga.
			sql: `
				UPDATE Fichajes
				SET Hora_Salida = datetime('now','localtime'),
					Estado = 'CERRADO',
					Cerrado_Automatico = 0,
					Cierre_Motivo = NULL,
					Incidencia = NULL
				WHERE ID_Fichaje = ?1 AND Hora_Salida IS NULL;
			`,
			args: [fichaje ?? ""],
		},
	];
	return {
		commandName: "punch",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_usuario: usuario, tipo: "salida" },
	};
}
