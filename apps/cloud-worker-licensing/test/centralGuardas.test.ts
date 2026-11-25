// test/centralGuardas.test.ts
//
// Lo que cuida la `BaseCentral` (`durableObjects/baseCentral.ts`) porque un objeto mal pedido o
// tocado a mano no falla en voz alta:
//
//   · sin aprovisionar no atiende, y no crea nada: ni al arrancar, ni con lo que le pidan;
//   · sólo ejecuta sentencias de filas, una a una (`baseCentral.guardas.ts`);
//   · reafirma las claves foráneas y los CHECK al empezar cada llamada, y avisa;
//   · se pone al día con sus migraciones al arrancar, y si una aplicada ha cambiado o una nueva no
//     entra, no atiende.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Migracion } from "../src/durableObjects/sqliteDelObjeto";
import { centralDePrueba, centralSinAprovisionar, codigoDe, tablasPropias } from "./helpers/central";

const { deMas, capturados } = vi.hoisted(() => ({
	/** Las migraciones de la central que «trae el despliegue», detrás de las de verdad. */
	deMas: [] as Migracion[],
	/** Lo que se ha mandado a Sentry (`capturarError`), con su operación. */
	capturados: [] as { operacion: string; mensaje: string }[],
}));

vi.mock("../src/server/central/migraciones", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/central/migraciones")>();
	return {
		...original,
		get MIGRACIONES_DE_LA_CENTRAL() {
			return [...original.MIGRACIONES_DE_LA_CENTRAL, ...deMas];
		},
	};
});

vi.mock("../src/observability/errors", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/errors")>();
	return {
		...original,
		capturarError: (error: unknown, operacion: string) => {
			capturados.push({ operacion, mensaje: String((error as any)?.message ?? error) });
			original.capturarError(error, operacion);
		},
	};
});

const { BaseCentral } = await import("../src/durableObjects/baseCentral");
const { centralDe } = await import("../src/lib/objetosDelNegocio");

afterEach(() => {
	deMas.length = 0;
	capturados.length = 0;
});

const pragma = (sql: SqlStorage, nombre: string): number =>
	Number((sql.exec(`PRAGMA ${nombre};`).toArray()[0] as any)?.[nombre]);

/** La misma base, arrancada otra vez: lo que haría el objeto tras un despliegue o al despertar. */
const otraVez = (state: DurableObjectState) => new BaseCentral(state, env as any);

describe("sin aprovisionar", () => {
	it("no atiende nada, y no crea nada", async () => {
		const { db, stub } = centralSinAprovisionar();
		expect(await codigoDe(db.execute("SELECT 1;"))).toBe("central_sin_aprovisionar");
		expect(await codigoDe(db.execute({ sql: "INSERT INTO tenants (tenant_id) VALUES (?1);", args: ["t"] }))).toBe(
			"central_sin_aprovisionar",
		);
		expect(await codigoDe(db.batch(["SELECT 1;"]))).toBe("central_sin_aprovisionar");
		expect(await codigoDe(db.operar("revocarAMano", { licenseId: "x", ahoraMs: 0 }))).toBe("central_sin_aprovisionar");
		expect(await stub.copiar("2026-01-01")).toEqual({ ok: false, error: "central_sin_aprovisionar" });
		expect(await codigoDe(db.execute("CREATE TABLE tenants (tenant_id TEXT);"))).toBe("central_sentencia_prohibida");

		expect(await stub.estado()).toEqual({
			aprovisionada: false,
			migraciones: [],
			averia: null,
			enCurso: { restauracion: null, vuelta: null },
			filas: {},
			bytes: expect.any(Number),
		});
		expect(await runInDurableObject(stub, (_c, state) => tablasPropias(state.storage.sql))).toEqual([]);
	});

	it("arrancar otra vez tampoco crea el esquema", async () => {
		const { stub } = centralSinAprovisionar();
		const tablas = await runInDurableObject(stub, async (_c, state) => {
			await otraVez(state).estado();
			return tablasPropias(state.storage.sql);
		});
		expect(tablas).toEqual([]);
	});

	it("aprovisionar crea el esquema una vez; la segunda, no toca nada", async () => {
		const { stub } = centralSinAprovisionar();
		const primera = await stub.aprovisionar();
		expect(primera.ok).toBe(true);
		const estado = await stub.estado();
		expect(estado.aprovisionada).toBe(true);
		expect(estado.migraciones.map((m) => m.nombre)).toEqual(["0001_inicial.sql"]);
		expect(estado.migraciones[0].hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await stub.aprovisionar()).toEqual({ ok: false, error: "central_ya_aprovisionada" });
		expect(await runInDurableObject(stub, (_c, state) => tablasPropias(state.storage.sql))).toContain("licenses");
	});

	it("si una migración no entra al aprovisionar, la base se queda a medias y no atiende", async () => {
		deMas.push({
			name: "9002_rota.sql",
			sql: "CREATE TABLE de_la_migracion_rota (a TEXT); INSERT INTO tabla_que_no_existe (a) VALUES (1);",
		});
		const { db, stub } = centralSinAprovisionar();
		expect(await stub.aprovisionar()).toEqual({
			ok: false,
			error: "central_migracion_fallida",
			detalle: expect.stringMatching(/no such table/),
		});

		const estado = await stub.estado();
		expect(estado.aprovisionada).toBe(true);
		expect(estado.migraciones.map((m) => m.nombre)).toEqual(["0001_inicial.sql"]);
		expect(estado.averia?.error).toBe("central_migracion_fallida");
		expect(await codigoDe(db.execute("SELECT COUNT(*) AS n FROM tenants;"))).toBe("central_migracion_fallida");
		expect(await codigoDe(db.execute({ sql: "INSERT INTO tenants (tenant_id) VALUES (?1);", args: ["t"] }))).toBe(
			"central_migracion_fallida",
		);
		expect(await codigoDe(db.operar("revocarAMano", { licenseId: "x", ahoraMs: 0 }))).toBe("central_migracion_fallida");
		expect(await runInDurableObject(stub, (_c, state) => tablasPropias(state.storage.sql))).not.toContain(
			"de_la_migracion_rota",
		);
	});
});

describe("sólo sentencias de filas, una a una", () => {
	const PROHIBIDAS = [
		"SELECT 1; SELECT 2;",
		"INSERT INTO tenants (tenant_id) VALUES ('a'); DELETE FROM tenants;",
		"SELECT 1;;",
		// Un comentario detrás del `;` es, para el SQLite de un DO, una sentencia vacía que no ejecuta.
		"SELECT 1; -- y nada más",
		"SELECT 1; /* y nada más */",
		"PRAGMA foreign_keys = OFF;",
		"PRAGMA defer_foreign_keys = ON;",
		"PRAGMA ignore_check_constraints = ON;",
		"BEGIN;",
		"BEGIN IMMEDIATE;",
		"COMMIT;",
		"END;",
		"ROLLBACK;",
		"SAVEPOINT s;",
		"RELEASE s;",
		"ATTACH DATABASE 'otra' AS otra;",
		"DETACH DATABASE otra;",
		"VACUUM;",
		"ANALYZE;",
		"REINDEX;",
		"EXPLAIN SELECT 1;",
		"CREATE TABLE nueva (a TEXT);",
		"CREATE INDEX ix_nuevo ON tenants (email);",
		"ALTER TABLE tenants ADD COLUMN otra TEXT;",
		"DROP TABLE devices;",
		"DROP INDEX idx_tenants_status;",
		"REPLACE INTO tenants (tenant_id) VALUES ('a');",
		// Detrás de un WITH, el verbo es WITH: lo que borra en cascada es el REPLACE.
		"WITH x AS (SELECT 1) REPLACE INTO tenants (tenant_id) VALUES ('a');",
		"WITH RECURSIVE x(n) AS (SELECT 1) REPLACE /* y */ INTO tenants (tenant_id) VALUES ('a');",
		"WITH x AS (SELECT 1) INSERT OR REPLACE INTO tenants (tenant_id) VALUES ('a');",
		"INSERT OR REPLACE INTO tenants (tenant_id) VALUES ('a');",
		"insert or replace into tenants (tenant_id) values ('a');",
		"INSERT/**/OR/**/REPLACE INTO tenants (tenant_id) VALUES ('a');",
		"UPDATE OR REPLACE tenants SET tenant_id = 'b';",
		"INSERT OR ROLLBACK INTO tenants (tenant_id) VALUES ('a');",
		"UPDATE OR ROLLBACK tenants SET notes = 'x';",
		"DELETE FROM _migrations;",
		'UPDATE "_migrations" SET hash = \'otro\';',
		"-- un comentario delante: la sentencia no dice qué es\nDELETE FROM tenants;",
	];

	it.each(PROHIBIDAS)("%s", async (sentencia) => {
		const { db, stub } = await centralDePrueba();
		await db.execute({ sql: "INSERT INTO tenants (tenant_id) VALUES (?1);", args: ["t"] });
		const comoEsta = () =>
			runInDurableObject(stub, (_c, state) => ({
				tablas: tablasPropias(state.storage.sql),
				tenants: state.storage.sql.exec("SELECT tenant_id FROM tenants;").toArray(),
				migraciones: state.storage.sql.exec("SELECT name, hash FROM _migrations;").toArray(),
				fk: pragma(state.storage.sql, "foreign_keys"),
				checks: pragma(state.storage.sql, "ignore_check_constraints"),
			}));
		const antes = await comoEsta();

		expect(await codigoDe(db.execute(sentencia))).toBe("central_sentencia_prohibida");
		expect(await codigoDe(db.batch([sentencia]))).toBe("central_sentencia_prohibida");

		expect(await comoEsta()).toEqual(antes);
		expect(antes).toMatchObject({ tenants: [{ tenant_id: "t" }], fk: 1, checks: 0 });
	});

	it("una prohibida en un lote no deja entrar ninguna de las demás", async () => {
		const { db } = await centralDePrueba();
		const lote = db.batch([{ sql: "INSERT INTO tenants (tenant_id) VALUES ('a');" }, "DROP TABLE devices;"]);
		expect(await codigoDe(lote)).toBe("central_sentencia_prohibida");
		expect((await db.execute("SELECT COUNT(*) AS n FROM tenants;")).rows[0].n).toBe(0);
	});

	it("el detalle dice por qué, para quien escribió la sentencia", async () => {
		const { db } = await centralDePrueba();
		const error: any = await db.execute("SELECT 1; SELECT 2;").catch((e) => e);
		expect(error.detalle).toMatch(/una sola sentencia/);
		expect(error.message).toMatch(/^central_sentencia_prohibida: /);
	});

	it.each([
		["un ; dentro de un texto", "SELECT 'a;b' AS v;"],
		["«or replace» dentro de un texto, y la función replace", "SELECT replace('or replace', 'or ', '') AS v;"],
		["la función replace detrás de un OR", "SELECT 1 AS v WHERE 0 OR replace('ab', 'b', '') = 'a';"],
		[
			"la función replace en el WHERE de un UPDATE",
			"UPDATE tenants SET notes = 'x' WHERE notes IS NULL OR replace(email, 'a', 'b') = 'c';",
		],
		["comentarios dentro", "SELECT /* la cuenta */ 1 AS v -- de una fila\n;"],
		["espacios detrás del ;", "SELECT 1 AS v ;  \n"],
		["un identificador entre comillas", 'SELECT "tenant_id" AS v FROM tenants;'],
		["INSERT OR IGNORE", "INSERT OR IGNORE INTO tenants (tenant_id) VALUES ('x');"],
	])("sí ejecuta %s", async (_que, sentencia) => {
		const { db } = await centralDePrueba();
		await expect(db.execute(sentencia)).resolves.toBeDefined();
	});
});

describe("la conexión se reafirma al empezar cada llamada", () => {
	it("con las claves foráneas apagadas y los CHECK desactivados a mano, lo siguiente los respeta", async () => {
		const { db, stub } = await centralDePrueba();
		const tocadas = await runInDurableObject(stub, (_c, state) => {
			const sql = state.storage.sql;
			sql.exec("PRAGMA foreign_keys = OFF;");
			sql.exec("PRAGMA ignore_check_constraints = ON;");
			return { fk: pragma(sql, "foreign_keys"), checks: pragma(sql, "ignore_check_constraints") };
		});
		// Lo que se cambió por debajo se ha quedado puesto: es lo que la central tiene que deshacer.
		expect(tocadas).toEqual({ fk: 0, checks: 1 });

		await expect(
			db.execute({ sql: "INSERT INTO devices (device_id, tenant_id, role) VALUES ('d', 'no-existe', 'tpv');" }),
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
		await expect(
			db.execute({ sql: "INSERT INTO tenants (tenant_id, status) VALUES ('t', 'inventado');" }),
		).rejects.toThrow(/CHECK constraint failed/);

		const despues = await runInDurableObject(stub, (_c, state) => ({
			fk: pragma(state.storage.sql, "foreign_keys"),
			checks: pragma(state.storage.sql, "ignore_check_constraints"),
		}));
		expect(despues).toEqual({ fk: 1, checks: 0 });
		expect(capturados.filter((c) => c.operacion === "central.pragmas")).toEqual([
			{ operacion: "central.pragmas", mensaje: expect.stringMatching(/ignore_check_constraints y foreign_keys/) },
		]);
	});

	it("si están bien, no avisa", async () => {
		const { db } = await centralDePrueba();
		await db.execute("SELECT 1;");
		expect(capturados).toEqual([]);
	});
});

describe("las migraciones de la central, al arrancar", () => {
	it("una nueva se aplica al arrancar, si la base está aprovisionada", async () => {
		const { stub } = await centralDePrueba();
		deMas.push({ name: "9001_prueba.sql", sql: "CREATE TABLE prueba_de_la_central (a TEXT);" });
		const resultado = await runInDurableObject(stub, async (_c, state) => {
			const estado = await otraVez(state).estado();
			return { estado, tablas: tablasPropias(state.storage.sql) };
		});
		expect(resultado.estado.averia).toBeNull();
		expect(resultado.estado.migraciones.map((m) => m.nombre)).toEqual(["0001_inicial.sql", "9001_prueba.sql"]);
		expect(resultado.tablas).toContain("prueba_de_la_central");
	});

	it("si una ya aplicada ha cambiado, no atiende, y lo dice en cada llamada", async () => {
		const { stub } = await centralDePrueba();
		const respuestas = await runInDurableObject(stub, async (_c, state) => {
			state.storage.sql.exec("UPDATE _migrations SET hash = 'otro' WHERE name = '0001_inicial.sql';");
			const central = otraVez(state);
			return {
				ejecutar: await central.ejecutar({ sql: "SELECT 1;", args: [] }),
				lote: await central.lote([{ sql: "SELECT 1;", args: [] }]),
				operar: await central.operar("cualquiera", {}),
				estado: await central.estado(),
			};
		});
		for (const r of [respuestas.ejecutar, respuestas.lote, respuestas.operar]) {
			expect(r).toEqual({ ok: false, error: "central_migracion_alterada", detalle: expect.stringMatching(/fue modificada/) });
		}
		expect(respuestas.estado.averia?.error).toBe("central_migracion_alterada");
		expect(capturados.map((c) => c.operacion)).toContain("central.migracion");
	});

	it("si una nueva no entra, no atiende, y no queda nada de ella", async () => {
		const { stub } = await centralDePrueba();
		deMas.push({
			name: "9002_rota.sql",
			sql: "CREATE TABLE de_la_migracion_rota (a TEXT); INSERT INTO tabla_que_no_existe (a) VALUES (1);",
		});
		const resultado = await runInDurableObject(stub, async (_c, state) => {
			const central = otraVez(state);
			return {
				ejecutar: await central.ejecutar({ sql: "SELECT 1;", args: [] }),
				tablas: tablasPropias(state.storage.sql),
				fk: pragma(state.storage.sql, "foreign_keys"),
			};
		});
		expect(resultado.ejecutar).toEqual({
			ok: false,
			error: "central_migracion_fallida",
			detalle: expect.stringMatching(/no such table/),
		});
		expect(resultado.tablas).not.toContain("de_la_migracion_rota");
		expect(resultado.fk).toBe(1);
	});
});

describe("el objeto de producción", () => {
	it("`centralDe` da un objeto que atiende también en local, con su pista de región", async () => {
		const estado = await centralDe(env as any).estado();
		expect(typeof estado.aprovisionada).toBe("boolean");
	});
});

describe("el prototipo RPC", () => {
	it("sólo tiene sus métodos: lo demás vive en funciones de módulo", () => {
		expect(Object.getOwnPropertyNames(BaseCentral.prototype).sort()).toEqual(
			["constructor", "ejecutar", "lote", "operar", "copiar", "estado", "aprovisionar", "prepararVuelta", "reiniciar"].sort(),
		);
	});
});
