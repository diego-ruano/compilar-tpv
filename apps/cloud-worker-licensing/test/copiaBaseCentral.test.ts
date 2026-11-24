// test/copiaBaseCentral.test.ts
//
// La copia diaria de la base central a R2 (PROD-02, `durableObjects/baseCentral.copia.ts`), la que
// hace el objeto `BaseCentral` cuando se la pide el cron (`copiar`).
//
// Lo único que demuestra que una copia sirve es restaurarla, así que eso es lo que se hace aquí: se
// copia una base central con datos incómodos, se baja el fichero del bucket, se carga en un SQLite
// vacío y se compara tabla a tabla. Una prueba que sólo mirara que «se subió algo» pasaría igual con
// una copia que no se puede leer, que es el fallo que no se descubre hasta el día que hace falta.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

import { centralDePrueba, centralSinAprovisionar, filasDe, type CentralDePrueba } from "./helpers/central";
import { enElHub } from "./helpers/hub";
import { copiarLaCentral, PREFIJO_COPIAS } from "../src/durableObjects/baseCentral.copia";

const DIA = "2026-09-26";
const bucket = () => (env as any).COPIAS as R2Bucket;

/** Las tablas de un SQLite tal como las ve SQLite, sin las internas del Durable Object. */
function tablasDe(sql: SqlStorage): string[] {
	return sql
		.exec(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			 ORDER BY name;`,
		)
		.toArray()
		.map((r) => String(r.name));
}

function contenido(sql: SqlStorage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const t of tablasDe(sql)) {
		out[t] = JSON.stringify(sql.exec(`SELECT * FROM "${t}" ORDER BY rowid;`).toArray());
	}
	return out;
}

/** Lo que hay en la central, leído en su SQLite. */
const enLaCentral = <T>(central: CentralDePrueba, leer: (sql: SqlStorage) => T) =>
	runInDurableObject(central.stub, (_objeto, state) => leer(state.storage.sql));

async function sembrar(central: CentralDePrueba) {
	await filasDe(
		central,
		`INSERT INTO tenants (tenant_id, legal_name, notes, created_at_ms, updated_at_ms, field_dek)
		 VALUES ('t-1', 'Bar O''Donnell', 'dos
		 líneas', 1, 2, 'dek-cifrada'),
		        ('t-2', NULL, 'un NUL' || char(0) || 'en medio', 3, 4, NULL);`,
	);
	await filasDe(
		central,
		`INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms)
		 VALUES ('d-1', 't-1', 'tpv', 5, 6);`,
	);
	// Muchas filas, en una sola sentencia: la copia las lee todas de una pasada.
	await filasDe(
		central,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1233)
		 INSERT INTO pair_claim_fallos (ip, fallos, ultimo_fallo_ms, bloqueado_hasta_ms)
		 SELECT '10.0.' || (i / 256) || '.' || (i % 256), i, 1790000000000 - i, 0 FROM n;`,
	);
}

async function bajar(clave: string): Promise<string> {
	const objeto = await bucket().get(clave);
	expect(objeto, `no está ${clave} en el bucket`).not.toBeNull();
	const flujo = objeto!.body.pipeThrough(new DecompressionStream("gzip"));
	return await new Response(flujo).text();
}

/**
 * Carga la copia en un SQLite vacío. `sqlite3` la lee tal cual; el SQLite de un Durable Object tiene
 * dos manías que aquí hay que sortear, y ninguna es de la copia:
 *   · no acepta `BEGIN`/`COMMIT` ni ese `PRAGMA` (sus transacciones van por `transactionSync`), así
 *     que se quitan esas tres líneas;
 *   · no acepta un texto de más de 100 KB por llamada (SQLITE_TOOBIG), así que se ejecuta por
 *     trozos, cortando sólo delante de una línea que empieza sentencia. Cada INSERT es una línea; un
 *     CREATE de varias sigue en su trozo porque sus otras líneas no empiezan por INSERT ni CREATE.
 */
function restaurar(sql: SqlStorage, volcado: string) {
	const lineas = volcado
		.split("\n")
		.filter((l) => !/^(PRAGMA foreign_keys|BEGIN TRANSACTION;|COMMIT;)/.test(l));

	let trozo: string[] = [];
	let largo = 0;
	const soltar = () => {
		if (trozo.length) sql.exec(trozo.join("\n"));
		trozo = [];
		largo = 0;
	};
	for (const l of lineas) {
		if (largo > 50_000 && /^(INSERT INTO |CREATE )/.test(l)) soltar();
		trozo.push(l);
		largo += l.length + 1;
	}
	soltar();
}

describe("la copia de la base central", () => {
	it("la hace el objeto, y se restaura en una base vacía IDÉNTICA, tabla a tabla", async () => {
		const central = await centralDePrueba();
		await sembrar(central);

		const respuesta = await central.stub.copiar(DIA);
		if (!respuesta.ok) throw new Error(respuesta.error);
		const hecha = respuesta.valor;
		const origen = await enLaCentral(central, (sql) => ({ contenido: contenido(sql), tablas: tablasDe(sql) }));

		expect(hecha.clave).toBe(`${PREFIJO_COPIAS}${DIA}.sql.gz`);
		expect(hecha.tablas).toBe(origen.tablas.length);
		// `_migrations` va dentro: dice en qué versión del esquema está la copia.
		expect(origen.tablas).toContain("_migrations");
		expect(hecha.filas).toBe(2 + 1 + 1234 + 1);

		const volcado = await bajar(hecha.clave);
		// La cabecera dice cómo abrirla en local, sin nada nuestro.
		expect(volcado).toContain("-- Abrir en local: gunzip -c <este fichero> | sqlite3 central.db");
		// Cada fila es una línea, también la del texto con un salto de línea dentro.
		const inserts = volcado.split("\n").filter((l) => l.startsWith("INSERT INTO "));
		expect(inserts).toHaveLength(hecha.filas);
		expect(inserts.every((l) => l.endsWith(");"))).toBe(true);

		const restaurada = await enElHub("copia-destino", async (hub: any) => {
			const sql = hub.state.storage.sql as SqlStorage;
			restaurar(sql, volcado);
			return contenido(sql);
		});

		// Compara TODAS las tablas, no sólo las sembradas: una tabla que la copia se callara
		// saldría aquí como ausente, que es el fallo que importa.
		expect(restaurada).toEqual(origen.contenido);
	});

	it("restaura también los índices: la estructura vuelve entera, no sólo los datos", async () => {
		const central = await centralDePrueba();
		const respuesta = await central.stub.copiar("2026-09-27");
		if (!respuesta.ok) throw new Error(respuesta.error);
		const volcado = await bajar(respuesta.valor.clave);

		const indices = (sql: SqlStorage) =>
			sql
				.exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name;`)
				.toArray()
				.map((r) => r.name);

		const esperados = await enLaCentral(central, indices);
		const restaurados = await enElHub("copia-indices-destino", (hub: any) => {
			restaurar(hub.state.storage.sql, volcado);
			return indices(hub.state.storage.sql);
		});

		expect(esperados.length).toBeGreaterThan(0);
		expect(restaurados).toEqual(esperados);
	});

	it("una copia demasiado grande FALLA en vez de subir media base", async () => {
		const central = await centralDePrueba();
		await sembrar(central);
		const claveDelDia = `${PREFIJO_COPIAS}2031-01-01.sql.gz`;

		// El techo de verdad es de 32 MB comprimida; aquí, uno pequeño, con la copia corriendo dentro
		// del objeto.
		const error = await runInDurableObject(central.stub, (_objeto, state) =>
			copiarLaCentral(state.storage.sql, bucket(), "2031-01-01", 1_000).catch((e: unknown) => e),
		);
		expect(String((error as Error)?.message)).toMatch(/copia_demasiado_grande/);

		// Y no deja nada: una copia a medias en el bucket es peor que ninguna, porque parece buena.
		expect(await bucket().head(claveDelDia)).toBeNull();
	});

	it("de una central sin aprovisionar no hay copia: lo dice, y no sube nada", async () => {
		const { stub } = centralSinAprovisionar();
		expect(await stub.copiar("2031-01-02")).toEqual({ ok: false, error: "central_sin_aprovisionar" });
		expect(await bucket().head(`${PREFIJO_COPIAS}2031-01-02.sql.gz`)).toBeNull();
	});

	it("sólo copia un día con su forma: el nombre del fichero sale de él", async () => {
		const central = await centralDePrueba();
		const error = await runInDurableObject(central.stub, (_objeto, state) =>
			copiarLaCentral(state.storage.sql, bucket(), "../otra-carpeta/x").catch((e: unknown) => e),
		);
		expect(error).toBeInstanceOf(RangeError);
		expect((await bucket().list({ prefix: "../" })).objects).toEqual([]);
	});

	it("si no llega a subirla, el objeto lo contesta como valor, sin lanzar, y sigue atendiendo", async () => {
		const central = await centralDePrueba();
		await runInDurableObject(central.stub, (objeto) => {
			const conEntorno = objeto as unknown as { env: Record<string, unknown> };
			conEntorno.env = {
				...conEntorno.env,
				COPIAS: {
					put: async () => {
						throw new Error("R2 no contesta");
					},
				},
			};
		});

		expect(await central.stub.copiar("2031-01-03")).toEqual({
			ok: false,
			error: "central_copia_fallida",
			detalle: "R2 no contesta",
		});
		expect((await central.db.execute("SELECT 1 AS uno;")).rows[0].uno).toBe(1);
	});
});
