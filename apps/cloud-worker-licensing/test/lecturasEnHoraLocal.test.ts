// test/lecturasEnHoraLocal.test.ts
//
// REV-03: «hoy» es el del bar, no el de Turso.
//
// Las lecturas de la Handy se ejecutan en Turso, que corre en UTC, así que un `date('now','localtime')`
// dentro de la consulta devolvía el día del servidor. Entre medianoche y las dos de la mañana (verano
// en España) todavía era ayer, y eso salía en las tareas «de hoy», en las estadísticas, en las
// reservas próximas — y en la fecha con la que se guardaba un fichaje, que es un registro de jornada
// obligatorio y que además quedaba contradiciendo a su propia `Hora_Entrada` (ésa sí la fija el
// emisor, CFG-04).
//
// Lo que se fija aquí: que la hora de quien pregunta se resuelve a literal ANTES de ejecutar, con la
// misma función que usan las escrituras, y que eso alcanza a las consultas de verdad.
//
// Este harness no lo ve el de contrato (`contractLectura.test.ts`) y no puede verlo: compara las dos
// implementaciones corriendo en la misma zona horaria, así que las dos se equivocan igual.

import { describe, expect, it } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { conLaHoraDeQuienPregunta } from "../src/lib/tenantClient";
import { punchStatus } from "../src/domains/login/login.queries";

/** Las 00:30 del 2 de enero para quien pregunta. En UTC eso sería todavía el día 1. */
const MADRUGADA = "2020-01-02 00:30:00";

/** Un cliente que no ejecuta nada: sólo apunta el SQL que le llega ya reescrito. */
function clienteQueApunta() {
	const vistas: string[] = [];
	const falso = {
		execute: async (stmt: any) => {
			vistas.push(typeof stmt === "string" ? stmt : stmt.sql);
			return { rows: [], columns: [] };
		},
		batch: async (stmts: any[]) => {
			for (const s of stmts) vistas.push(typeof s === "string" ? s : s.sql);
			return [];
		},
	} as any;
	return { vistas, db: conLaHoraDeQuienPregunta(falso, MADRUGADA) };
}

describe("la hora de quien pregunta se fija antes de ejecutar", () => {
	it("las tres formas de pedir «ahora» quedan resueltas a literal", async () => {
		const { vistas, db } = clienteQueApunta();

		await db.execute("SELECT date('now','localtime') AS fecha;");
		await db.execute({ sql: "SELECT datetime('now','localtime') AS t;", args: [] });
		await db.execute({
			sql: "SELECT datetime('now','localtime','-6 days','start of day') AS desde;",
			args: [],
		});

		expect(vistas[0]).toBe("SELECT '2020-01-02' AS fecha;");
		expect(vistas[1]).toBe(`SELECT '${MADRUGADA}' AS t;`);
		// Los modificadores se conservan detrás: dan el mismo valor sobre la fecha ya fijada.
		expect(vistas[2]).toBe(`SELECT datetime('${MADRUGADA}','-6 days','start of day') AS desde;`);
	});

	it("también en un `batch`, que es la otra puerta por la que sale SQL", async () => {
		const { vistas, db } = clienteQueApunta();

		await (db as any).batch([
			{ sql: "SELECT date('now','localtime');", args: [] },
			"SELECT 1;",
		]);

		expect(vistas).toEqual(["SELECT '2020-01-02';", "SELECT 1;"]);
	});

	it("no toca los argumentos ni un texto que hable de «now»", async () => {
		const falso = {
			execute: async (stmt: any) => {
				expect(stmt.sql).toBe("INSERT INTO Notas (Texto) VALUES (?1);");
				expect(stmt.args).toEqual(["reunión 'now' a las 9"]);
				return { rows: [], columns: [] };
			},
		} as any;

		await conLaHoraDeQuienPregunta(falso, MADRUGADA).execute({
			sql: "INSERT INTO Notas (Texto) VALUES (?1);",
			args: ["reunión 'now' a las 9"],
		});
	});

	it("prohibe abrir una transaccion, porque su SQL se escaparía sin fijar", () => {
		// La tercera puerta por la que sale SQL. Si una lectura la usara, su `'now'` lo resolvería
		// Turso y el resultado sería de otro día: sin error, sin síntoma, sin nadie que lo note. Vale
		// más que reviente aquí, delante de quien lo está escribiendo.
		const db = conLaHoraDeQuienPregunta({ execute: async () => ({}) } as any, MADRUGADA) as any;
		expect(() => db.transaction("write")).toThrow(/no abre transacciones/);
	});

	it("delega lo que no sea ejecutar sin romper el cliente de verdad", async () => {
		let cerrado = false;
		const falso = {
			closed: false,
			close: function () {
				cerrado = true;
			},
			execute: async () => ({ rows: [], columns: [] }),
		} as any;

		const db = conLaHoraDeQuienPregunta(falso, MADRUGADA) as any;
		expect(db.closed).toBe(false);
		db.close();
		expect(cerrado).toBe(true);
	});
});

describe("el fichaje de madrugada", () => {
	/**
	 * El caso que motiva todo esto. A las 00:30 del día 2, `punchStatus` preguntaba por los fichajes
	 * del día 1 (el de Turso) y la ruta escribía ESA fecha en `Fichajes.Fecha`, mientras la
	 * `Hora_Entrada` del mismo INSERT se resolvía con la hora del emisor: el día 2. La fila se
	 * contradecía a sí misma y viajaba así a la Main.
	 */
	it("mira el día de quien ficha, no el del servidor", async () => {
		await enElHub("lecturas-hora-local", async (hub: any) => {
			const sqlStorage = hub.state.storage.sql;
			crearEsquemaTenant(sqlStorage);
			const db = clienteSobre(sqlStorage);

			// El rol lo siembra el propio esquema; aqui solo hace falta alguien que fiche.
			sqlStorage.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
				 SELECT 'u1', ID_Rol, 'ana@bar.test', 'x', 'Ana' FROM Roles WHERE Nombre_Rol='Camarero';`,
			);
			sqlStorage.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado, Cerrado_Automatico)
				 VALUES ('f1', 'u1', '2020-01-02', 1, '2020-01-02 00:30:00', NULL, 'ABIERTO', 0);`,
			);

			const conLaHora = await punchStatus(conLaHoraDeQuienPregunta(db, MADRUGADA), "u1");
			expect(conLaHora.fecha).toBe("2020-01-02");
			expect(conLaHora.partes).toHaveLength(1);

			// Y sin decir la hora manda el reloj de la base, que es como se comportaba antes: la
			// prueba de que esto no adivina nada por su cuenta.
			const delServidor = await punchStatus(db, "u1");
			const leido: any = await db.execute("SELECT date('now','localtime') AS d;");
			const hoyDeLaBase = String(leido.rows?.[0]?.d ?? "");
			expect(delServidor.fecha).toBe(hoyDeLaBase);
		});
	});

	/**
	 * RI-05: el turno de noche. Lo que decide si la jornada sigue en curso es la hora de entrada
	 * contra un margen (`datetime('now','localtime','-16 hours')`), y ese «ahora» tiene que ser el de
	 * quien ficha también cuando lleva modificadores detrás.
	 */
	it("a la 01:30 sigue en curso la jornada que entró ayer a las 18:00", async () => {
		await enElHub("lecturas-hora-local-noche", async (hub: any) => {
			const sqlStorage = hub.state.storage.sql;
			crearEsquemaTenant(sqlStorage);
			const db = clienteSobre(sqlStorage);

			sqlStorage.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
				 SELECT 'u1', ID_Rol, 'ana@bar.test', 'x', 'Ana' FROM Roles WHERE Nombre_Rol='Camarero';`,
			);
			sqlStorage.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado, Cerrado_Automatico)
				 VALUES ('noche', 'u1', '2020-01-01', 1, '2020-01-01 18:00:00', NULL, 'ABIERTO', 0);`,
			);

			// La pantalla elige entre entrada y salida con este estado: tiene que ser el de ayer.
			const deMadrugada = await punchStatus(
				conLaHoraDeQuienPregunta(db, "2020-01-02 01:30:00"),
				"u1",
			);
			expect(deMadrugada.fecha).toBe("2020-01-01");
			expect(deMadrugada.partes).toHaveLength(1);

			// Al mediodía siguiente (18 h después) ya no es una jornada en curso, sino una olvidada.
			const alMediodia = await punchStatus(
				conLaHoraDeQuienPregunta(db, "2020-01-02 12:00:00"),
				"u1",
			);
			expect(alMediodia.fecha).toBe("2020-01-02");
			expect(alMediodia.partes).toHaveLength(0);
		});
	});
});
