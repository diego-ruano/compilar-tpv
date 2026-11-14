// test/tenantHubTiempo.test.ts
//
// SYNC-04 — determinismo temporal de las escrituras replicadas.
//
// Esta es la lógica que garantiza que una escritura produzca **la misma fila** en la nube, en
// la Main y en la Handy. Cuando falla no revienta nada: deja filas con fechas distintas en
// cada sitio, que es la peor forma de fallar que tiene el sistema porque nadie se entera hasta
// que alguien cuadra una caja y no le salen los números.
//
// Los casos no salen de leer la implementación sino de lo que el resto del sistema da por
// cierto: qué se reescribe, qué NO debe reescribirse, y qué horas se aceptan.

import { describe, it, expect, vi, afterEach } from "vitest";

import {
	commandHasNowLiteral,
	horaSinFijar,
	horaSinFijarEnSql,
	parseClientNow,
	rewriteCmdNowLiterals,
	rewriteNowInSql,
	serverNowFixed,
	sqlHasNowLiteral,
} from "../src/durableObjects/tenantHub.tiempo";
import type { InternalApplyCommand } from "../src/durableObjects/tenantHub.types";

const DT = "2026-08-18 13:45:07";
const HOY = "2026-08-18";

afterEach(() => {
	vi.useRealTimers();
});

/* =========================================================
   parseClientNow — el borde por el que entra la hora
========================================================= */

describe("parseClientNow", () => {
	it("acepta el formato exacto que manda el cliente", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-18T13:45:00Z"));

		expect(parseClientNow("2026-08-18 13:45:07")).toBe("2026-08-18 13:45:07");
		expect(parseClientNow("  2026-08-18 13:45:07  ")).toBe("2026-08-18 13:45:07");
	});

	it("rechaza cualquier formato que no sea el canónico", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-18T13:45:00Z"));

		const malos = [
			"2026-08-18T13:45:07", // ISO con T
			"2026-08-18 13:45", // sin segundos
			"2026-08-18 13:45:07.123", // con milisegundos
			"2026-8-18 13:45:07", // mes sin cero
			"18-08-2026 13:45:07", // orden europeo
			"2026-08-18 13:45:07Z", // con zona
			"",
			"   ",
			"ayer",
		];

		for (const v of malos) {
			expect(parseClientNow(v), `debería rechazar ${JSON.stringify(v)}`).toBeNull();
		}
	});

	it("no revienta con tipos que no son texto", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-18T13:45:00Z"));

		for (const v of [null, undefined, 0, 123456789, {}, [], true]) {
			expect(() => parseClientNow(v)).not.toThrow();
			expect(parseClientNow(v)).toBeNull();
		}
	});

	// El margen existe para admitir cualquier zona horaria legítima (±14 h) más deriva de
	// reloj, y a la vez impedir que alguien inyecte una fecha arbitraria.
	it("admite husos horarios reales", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));

		// Kiribati (UTC+14) y Baker Island (UTC-12): los dos extremos del planeta.
		expect(parseClientNow("2026-08-19 02:00:00")).toBe("2026-08-19 02:00:00");
		expect(parseClientNow("2026-08-18 00:00:00")).toBe("2026-08-18 00:00:00");
	});

	it("rechaza fechas fuera de toda deriva creíble", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));

		expect(parseClientNow("2020-01-01 00:00:00")).toBeNull();
		expect(parseClientNow("2030-01-01 00:00:00")).toBeNull();
		// Justo pasado el límite (14 h 5 min): 14 h 10 min por delante.
		expect(parseClientNow("2026-08-19 02:10:00")).toBeNull();
	});

	// AUD-21: con un componente imposible `new Date(...)` da `NaN`, y la deriva comparada con `NaN`
	// nunca pasaba del margen: la hora valía como «ahora» en lo que escribe y lee la Handy.
	it("rechaza una hora con la forma buena y un componente imposible, esté cerca o lejos", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));

		const imposibles = [
			"2020-01-01 24:30:00", // hora 24 con minutos
			"2026-08-18 24:00:01", // hora 24 con segundos
			"2026-08-18 24:00:00",
			"2026-13-01 10:00:00", // mes 13
			"2026-00-10 10:00:00", // mes 00
			"2026-08-32 10:00:00", // día 32
			"2026-08-00 10:00:00", // día 00
			"2026-08-18 25:00:00", // hora 25
			"2026-08-18 12:60:00", // minuto 60
			"2026-08-18 12:00:60", // segundo 60
			"1999-99-99 99:99:99",
		];
		for (const v of imposibles) {
			expect(parseClientNow(v), `debería rechazar ${JSON.stringify(v)}`).toBeNull();
		}
	});

	// Un día que no existe pero que `Date` desborda al mes siguiente: no da `NaN`, da otra fecha, y
	// cerca de ella entraba por la deriva con el texto del día que no existe.
	it("rechaza un día que no existe aunque caiga dentro de la deriva", () => {
		vi.useFakeTimers();

		vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
		expect(parseClientNow("2026-02-29 12:00:00")).toBeNull(); // 2026 no es bisiesto
		expect(parseClientNow("2026-03-01 12:00:00")).toBe("2026-03-01 12:00:00");

		vi.setSystemTime(new Date("2026-03-03T10:00:00Z"));
		expect(parseClientNow("2026-02-31 10:00:00")).toBeNull();
	});

	it("acepta el 29 de febrero de un año bisiesto", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2028-02-29T12:00:00Z"));

		expect(parseClientNow("2028-02-29 12:00:00")).toBe("2028-02-29 12:00:00");
		// Y los extremos de un día de verdad.
		expect(parseClientNow("2028-02-29 00:00:00")).toBe("2028-02-29 00:00:00");
		expect(parseClientNow("2028-02-29 23:59:59")).toBe("2028-02-29 23:59:59");
	});
});

describe("serverNowFixed", () => {
	it("produce el mismo formato que se le exige al cliente", () => {
		expect(serverNowFixed()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("lo que genera el servidor lo acepta el propio validador", () => {
		// Si no fuera así, el camino de respaldo (cliente sin hora) produciría un literal que
		// el sistema considera inválido en cualquier otra parte.
		expect(parseClientNow(serverNowFixed())).not.toBeNull();
	});
});

/* =========================================================
   Reescritura del SQL
========================================================= */

describe("rewriteNowInSql", () => {
	it("resuelve las dos formas canónicas", () => {
		expect(rewriteNowInSql("SELECT datetime('now','localtime');", DT)).toBe(
			`SELECT '${DT}';`,
		);
		expect(rewriteNowInSql("SELECT date('now','localtime');", DT)).toBe(`SELECT '${HOY}';`);
	});

	it("resuelve TODAS las apariciones, no sólo la primera", () => {
		// Un INSERT con Creado_En y Actualizado_En es el caso normal: si sólo se reescribiera
		// la primera, la segunda se reevaluaría en cada apply y divergiría.
		const sql = `INSERT INTO T (a,b,c) VALUES (datetime('now','localtime'), datetime('now','localtime'), date('now','localtime'));`;
		const out = rewriteNowInSql(sql, DT);

		expect(out).toBe(`INSERT INTO T (a,b,c) VALUES ('${DT}', '${DT}', '${HOY}');`);
		expect(out).not.toContain("'now'");
	});

	// Las formas con modificador SE fijan, y el modificador se queda: la hora fija ocupa el lugar del
	// `'now','localtime'` y el `-2 days` sigue restando dos días a esa hora. Lo que sí sería un error de
	// cálculo silencioso es sustituir la expresión entera por la fecha de hoy (CFG-04).
	it("fija la hora de las formas con modificador y conserva el modificador", () => {
		expect(rewriteNowInSql("datetime('now','localtime','-2 days')", DT)).toBe(
			`datetime('${DT}','-2 days')`,
		);
		expect(rewriteNowInSql("date('now', 'localtime', '+1 month')", DT)).toBe(
			`date('${DT}', '+1 month')`,
		);
		expect(rewriteNowInSql("strftime('%H','NOW','localtime')", DT)).toBe(`strftime('%H','${DT}')`);
	});

	// Un `'now'` sin `localtime` es UTC, y la hora del emisor es local: no hay con qué fijarlo. Se deja
	// como está para que `horaSinFijar` lo rechace; no se le inventa una zona.
	it("no se inventa la hora UTC de un 'now' sin localtime", () => {
		const sql = "datetime('now','start of month')";
		expect(rewriteNowInSql(sql, DT)).toBe(sql);
	});

	it("no toca un 'now' que sea un dato del usuario", () => {
		// Una nota de comanda que diga "now" no puede acabar convertida en una fecha.
		const sql = "INSERT INTO Notas (texto) VALUES ('now');";
		expect(rewriteNowInSql(sql, DT)).toBe(sql);
		// Ni aunque la siguiente diga "localtime": no son argumentos de una función de fecha.
		const dos = "INSERT INTO Notas (a, b) VALUES ('now','localtime');";
		expect(rewriteNowInSql(dos, DT)).toBe(dos);
	});

	it("deja intacto el SQL que no menciona 'now'", () => {
		const sql = "UPDATE Mesas SET Estado = 'Libre' WHERE ID_Mesa = ?1;";
		expect(rewriteNowInSql(sql, DT)).toBe(sql);
	});

	it("es idempotente: reescribir dos veces no cambia nada", () => {
		// El motor puede reintentar; una segunda pasada no debe alterar el literal ya fijado.
		const sql = "INSERT INTO T VALUES (datetime('now','localtime'));";
		const una = rewriteNowInSql(sql, DT);
		expect(rewriteNowInSql(una, "2099-01-01 00:00:00")).toBe(una);
	});

	it("no revienta con entradas que no son texto", () => {
		for (const v of [null, undefined, 42, {}]) {
			expect(() => rewriteNowInSql(v as any, DT)).not.toThrow();
		}
	});
});

/* =========================================================
   Detección: ¿este comando necesita hora del cliente?
========================================================= */

const exec = (sql: string): InternalApplyCommand => ({
	type: "tenantDb.exec",
	payload: { sql },
});

const tx = (sqls: string[]): InternalApplyCommand => ({
	type: "tenantDb.transaction",
	payload: { steps: sqls.map((sql) => ({ kind: "execute" as const, sql })) },
});

describe("commandHasNowLiteral", () => {
	it("detecta el 'now' en un comando simple", () => {
		expect(commandHasNowLiteral(exec("INSERT INTO T VALUES (datetime('now','localtime'));"))).toBe(
			true,
		);
		expect(commandHasNowLiteral(exec("INSERT INTO T VALUES ('2026-01-01');"))).toBe(false);
	});

	it("detecta el 'now' aunque esté en el ÚLTIMO paso de la transacción", () => {
		// Si sólo mirara el primero, una transacción larga colaría un `now` sin resolver y la
		// fecha divergiría entre la nube y la Main.
		expect(
			commandHasNowLiteral(
				tx([
					"UPDATE A SET x = 1;",
					"UPDATE B SET y = 2;",
					"INSERT INTO C VALUES (datetime('now','localtime'));",
				]),
			),
		).toBe(true);
	});

	it("no se inventa un 'now' donde no lo hay", () => {
		expect(commandHasNowLiteral(tx(["UPDATE A SET x = 1;", "UPDATE B SET y = 2;"]))).toBe(false);
		expect(commandHasNowLiteral({ type: "tenantDb.ping" } as any)).toBe(false);
	});

	it("aguanta payloads incompletos", () => {
		expect(() => commandHasNowLiteral({ type: "tenantDb.transaction", payload: {} } as any)).not.toThrow();
		expect(commandHasNowLiteral({ type: "tenantDb.transaction", payload: {} } as any)).toBe(false);
		expect(commandHasNowLiteral({ type: "tenantDb.exec", payload: {} } as any)).toBe(false);
	});

	it("sqlHasNowLiteral sólo mira strings", () => {
		expect(sqlHasNowLiteral("datetime('now','localtime')")).toBe(true);
		expect(sqlHasNowLiteral(null)).toBe(false);
		expect(sqlHasNowLiteral(123)).toBe(false);
	});
});

/* =========================================================
   Reescritura del comando entero
========================================================= */

describe("rewriteCmdNowLiterals", () => {
	it("deja el comando sin ningún 'now' pendiente", () => {
		const cmd = tx([
			"INSERT INTO A VALUES (datetime('now','localtime'));",
			"UPDATE B SET f = date('now','localtime');",
		]);

		const out = rewriteCmdNowLiterals(cmd, DT);
		expect(commandHasNowLiteral(out)).toBe(false);
		expect(JSON.stringify(out)).toContain(DT);
		expect(JSON.stringify(out)).toContain(HOY);
	});

	it("conserva el resto de campos de cada paso", () => {
		// `saveAs` y `args` son lo que sostiene el mecanismo de $ref: perderlos al reescribir
		// rompería la transacción entera.
		const cmd: InternalApplyCommand = {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{ kind: "value", sql: "SELECT ?1", args: ["id-1"], saveAs: "id" },
					{
						kind: "execute",
						sql: "INSERT INTO T (id, creado) VALUES (?1, datetime('now','localtime'));",
						args: [{ $ref: "id" }],
					},
				],
				resultKey: "id",
				beginMode: "immediate",
			},
		};

		const out: any = rewriteCmdNowLiterals(cmd, DT);

		expect(out.payload.steps[0].saveAs).toBe("id");
		expect(out.payload.steps[0].args).toEqual(["id-1"]);
		expect(out.payload.steps[1].args).toEqual([{ $ref: "id" }]);
		expect(out.payload.resultKey).toBe("id");
		expect(out.payload.beginMode).toBe("immediate");
	});

	it("no muta el comando original", () => {
		// El motor reutiliza el comando para hashear e idempotencia; mutarlo in situ haría que
		// el hash dependiera del orden de las operaciones.
		const cmd = exec("INSERT INTO T VALUES (datetime('now','localtime'));");
		const antes = JSON.stringify(cmd);

		rewriteCmdNowLiterals(cmd, DT);

		expect(JSON.stringify(cmd)).toBe(antes);
	});

	it("con la misma hora produce siempre lo mismo", () => {
		// La propiedad que da nombre a todo esto: dos aplicaciones del mismo comando con la
		// misma hora tienen que dar SQL idéntico, byte a byte.
		const cmd = tx([
			"INSERT INTO A VALUES (datetime('now','localtime'));",
			"UPDATE B SET f = date('now','localtime');",
		]);

		expect(JSON.stringify(rewriteCmdNowLiterals(cmd, DT))).toBe(
			JSON.stringify(rewriteCmdNowLiterals(cmd, DT)),
		);
	});

	it("con horas distintas produce resultados distintos", () => {
		const cmd = exec("INSERT INTO T VALUES (datetime('now','localtime'));");

		expect(JSON.stringify(rewriteCmdNowLiterals(cmd, DT))).not.toBe(
			JSON.stringify(rewriteCmdNowLiterals(cmd, "2026-08-18 13:45:08")),
		);
	});

	it("un comando sin 'now' sale igual que entró", () => {
		const cmd = exec("UPDATE Mesas SET Estado = 'Libre';");
		expect(rewriteCmdNowLiterals(cmd, DT)).toEqual(cmd);
	});

	it("un comando de un tipo que no existe no lleva SQL y pasa de largo", () => {
		const raro = { type: "tenantDb.ping" } as unknown as InternalApplyCommand;
		expect(rewriteCmdNowLiterals(raro, DT)).toEqual(raro);
	});
});

/* =========================================================
   La propiedad de extremo a extremo
========================================================= */

describe("la cadena completa", () => {
	it("una hora válida del cliente acaba en un SQL sin 'now' y con esa hora", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-18T13:45:00Z"));

		const cmd = exec("INSERT INTO Comandas (Abierta_En) VALUES (datetime('now','localtime'));");

		expect(commandHasNowLiteral(cmd)).toBe(true);

		const dt = parseClientNow("2026-08-18 15:45:07");
		expect(dt).not.toBeNull();

		const out: any = rewriteCmdNowLiterals(cmd, dt!);

		expect(commandHasNowLiteral(out)).toBe(false);
		expect(out.payload.sql).toContain("'2026-08-18 15:45:07'");
		expect(out.payload.sql).not.toContain("now");
	});

	it("una hora inaceptable no llega a reescribir nada", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-18T13:45:00Z"));

		// El guard `missing_client_now` del motor depende de esto: si `parseClientNow`
		// devolviera una hora aunque fuese basura, se escribiría con una fecha inventada.
		expect(parseClientNow("1999-01-01 00:00:00")).toBeNull();
		expect(parseClientNow("no es una fecha")).toBeNull();
	});
});

/* =========================================================
   CFG-04: lo que la nube no puede fijar no se aplica
========================================================= */

describe("horaSinFijar", () => {
	it("no ve nada en un comando ya fijado", () => {
		const cmd = rewriteCmdNowLiterals(
			tx([
				"INSERT INTO A VALUES (datetime('now','localtime'));",
				"UPDATE B SET f = datetime('now','localtime','start of day');",
			]),
			DT,
		);
		expect(horaSinFijar(cmd)).toBeNull();
	});

	it("rechaza la hora que tendría que elegir la base", () => {
		const casos: Array<[string, string]> = [
			["INSERT INTO A VALUES (datetime('now'));", "'now'"],
			["UPDATE A SET f = CURRENT_TIMESTAMP;", "CURRENT_*"],
			["UPDATE A SET f = datetime(Fecha_Utc,'localtime');", "'localtime'"],
			["UPDATE A SET f = datetime(?1,'utc');", "'utc'"],
		];
		for (const [sql, token] of casos) {
			const cmd = rewriteCmdNowLiterals(exec(sql), DT);
			expect(horaSinFijar(cmd), sql).toBe(token);
		}
	});

	it("mira sólo lo que se escribe: una lectura dentro del comando no viaja", () => {
		const cmd: InternalApplyCommand = {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{ kind: "value", sql: "SELECT CURRENT_TIMESTAMP", saveAs: "t" },
					{ kind: "execute", sql: "UPDATE A SET x = 1;" },
				],
			},
		};
		expect(horaSinFijar(cmd)).toBeNull();
	});

	it("no confunde una columna que se llame parecido con CURRENT_TIMESTAMP", () => {
		expect(horaSinFijarEnSql("UPDATE A SET Mi_Current_Time_X = 1;")).toBeNull();
	});
});
