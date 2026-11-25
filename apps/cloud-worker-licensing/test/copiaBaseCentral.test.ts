// test/copiaBaseCentral.test.ts
//
// Las copias de la base central a R2 (PROD-02, `durableObjects/baseCentral.copia.ts`): la del día,
// que pide el cron, y la de a mano, que pide la administración. Las hace el objeto `BaseCentral`
// (`copiar`).
//
// Lo único que demuestra que una copia sirve es restaurarla, así que eso es lo que se hace aquí: se
// siembra una central con las operaciones de verdad (cobros, un canje, un reembolso, lo de la
// administración) y con valores incómodos, se copia, se devuelve a un objeto nuevo
// (`aprovisionar({ claveDeCopia })`, `baseCentral.restaurar.ts`) y se compara tabla a tabla, con el
// tipo de cada valor, y el esquema entero. Una prueba que sólo mirara que «se subió algo» pasaría
// igual con una copia que no se puede leer, que es el fallo que no se descubre hasta el día que hace
// falta. Que se abre sin nuestro código lo comprueba `copiaCentralSinNuestroCodigo.node.test.ts`; lo
// que pasa con una copia que no vale, con una restauración a medias y con muchas filas,
// `centralRestaurar.test.ts`. Al final, que el cron avisa cuando la copia ya no se restauraría de una
// vez.

import {
	createExecutionContext,
	createScheduledController,
	env,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";

import { centralDePrueba, centralSinAprovisionar, conR2Caido, filasDe, type CentralDePrueba } from "./helpers/central";
import { cumplir, revertir } from "../src/domains/stripe/stripe.routes";
import {
	claveDelDia,
	COPIA_A_MANO,
	copiarLaCentral,
	PREFIJO_COPIAS,
} from "../src/durableObjects/baseCentral.copia";
import { FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ } from "../src/durableObjects/baseCentral.restaurar";
import { MIGRACIONES_DE_LA_CENTRAL } from "../src/server/central/migraciones";

const worker = (await import("../src/index")).default as ExportedHandler<any>;

const DIA = "2026-09-26";
const bucket = () => (env as any).COPIAS as R2Bucket;
const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = { LICENSE_STORE_KEY: STORE_KEY } as any;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Las tablas de la base (sin las de SQLite, las del objeto ni `_migrations`): filas, tipos y columnas. */
function contenido(sql: SqlStorage) {
	const tablas = sql
		.exec(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name <> '_migrations'
			   AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			 ORDER BY name;`,
		)
		.toArray()
		.map((r) => String(r.name));
	return Object.fromEntries(
		tablas.map((t) => {
			// Una tabla WITHOUT ROWID no tiene rowid: sin orden, sale por su clave, que es como la guarda.
			const sinRowid = Boolean(sql.exec("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?;", t).one().wr);
			const orden = sinRowid ? "" : " ORDER BY rowid";
			const cursor = sql.exec(`SELECT * FROM "${t}"${orden};`);
			const columnas = [...cursor.columnNames];
			const filas = [...cursor.raw()].map((f) => f.map((v) => (v instanceof ArrayBuffer ? { blob: hex(v) } : v)));
			const tipos = [...sql.exec(`SELECT ${columnas.map((c) => `typeof("${c}")`).join(", ")} FROM "${t}"${orden};`).raw()];
			return [t, { columnas, filas, tipos }];
		}),
	);
}

/** El esquema entero tal como lo guarda SQLite: tablas, índices, vistas y triggers. */
const esquema = (sql: SqlStorage) =>
	sql
		.exec(
			`SELECT type, name, tbl_name, sql FROM sqlite_master
			 WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND tbl_name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			 ORDER BY type, name;`,
		)
		.toArray();

const migraciones = (sql: SqlStorage) => sql.exec("SELECT name, hash FROM _migrations ORDER BY rowid;").toArray();

/** Lo que hay en la central, leído en su SQLite. */
const enLaCentral = <T>(central: Pick<CentralDePrueba, "stub">, leer: (sql: SqlStorage) => T) =>
	runInDurableObject(central.stub, (_objeto, state) => leer(state.storage.sql));

/** Una sesión de Stripe pagada, con una línea por duración. */
const sesion = (id: string, intent: string, meses: number[]) => ({
	id,
	payment_status: "paid",
	payment_intent: intent,
	customer: `cus_${id}`,
	customer_details: { email: "bar@ejemplo.test", name: "Bar O'Donnell\nSegunda línea" },
	line_items: { data: meses.map((m) => ({ price: { id: `price_${m}`, metadata: { term_months: String(m) } } })) },
});

/**
 * Una central como las de verdad: con lo que escriben sus operaciones, y con todos los tipos que
 * guarda SQLite, también lo que no cabe en una sentencia de 100 KB.
 */
async function sembrar(central: CentralDePrueba) {
	const ahora = Date.now();
	const alta = await cumplir(ENV, central.db, sesion("cs_alta", "pi_alta", [12]));
	if (alta.accion !== "emitida") throw new Error(alta.accion);
	const [licencia] = alta.license_ids;
	await filasDe(
		central,
		`UPDATE licenses SET status = 'active', tenant_id = 't-1', main_device_id = 'equipo-1', activated_at_ms = ?1,
		   expires_at_ms = ?1 + 31536000000 WHERE license_id = ?2;`,
		ahora,
		licencia,
	);
	const renovacion = await cumplir(ENV, central.db, sesion("cs_renovacion", "pi_renovacion", [3]));
	if (renovacion.accion !== "emitida") throw new Error(renovacion.accion);
	const canje = await central.db.operar("canjearClave", {
		claveId: renovacion.license_ids[0],
		licenciaId: licencia,
		deviceId: "equipo-1",
		meses: 3,
		ahoraMs: ahora,
	});
	if (canje.resultado !== "sumado") throw new Error(canje.resultado);
	const pack = await cumplir(ENV, central.db, sesion("cs_pack", "pi_pack", [12, 1]));
	if (pack.accion !== "emitida") throw new Error(pack.accion);
	await revertir(central.db, {
		id: "evt_reembolso",
		type: "charge.refunded",
		data: { object: { object: "charge", id: "ch_pack", payment_intent: "pi_pack", amount: 13000, amount_refunded: 13000 } },
	});
	await central.db.operar("revocarAMano", { licenseId: licencia, ahoraMs: ahora });
	await central.db.operar("desrevocar", { licenseId: licencia, ahoraMs: ahora });
	await central.db.operar("extenderAMano", { licenseId: licencia, meses: 12, ahoraMs: ahora });
	await central.db.operar("acortarAMano", { licenseId: licencia, meses: 1, ahoraMs: ahora });

	await filasDe(
		central,
		`INSERT INTO tenants (tenant_id, legal_name, display_name, notes, created_at_ms, updated_at_ms, field_dek)
		 VALUES ('t-1', 'Bar O''Donnell', 'Café ☕ 🍺 «Ñandú»', 'dos' || char(10) || 'líneas' || char(13) || char(10) || 'y fin' || char(10),
		         1790000000123, 1790000000124, 'dek-cifrada'),
		        ('t-2', NULL, '', 'un NUL' || char(0) || 'en medio ''y comillas''', 3, 4, X'00ff10'),
		        ('t-3', ?1, 'grande', ?2, 5, 6, ?3),
		        ('t-4', 'con muchos saltos', 'json', ?4, 7, 8, NULL);`,
		// Lo que no cabe en una sentencia de 100 KB: viaja como argumento al restaurarlo.
		`Una fila de verdad grande ${"🍺".repeat(10)}`,
		Array.from({ length: 3000 }, (_, i) => `línea ${i}: 'comillas' y "dobles"\r\n`).join("") + "fin",
		new Uint8Array(60_000).map((_, i) => i % 256).buffer,
		// Una fila corta con más saltos de línea de los que caben escritos con `char(10)`, como el
		// cuerpo de un evento de Stripe con su sangría.
		JSON.stringify({ lineas: Array.from({ length: 700 }, (_, i) => ({ i })) }, null, 1),
	);
	await filasDe(
		central,
		`INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms, device_pubkey_b64)
		 VALUES ('equipo-1', 't-1', 'tpv', 5, 6, 'clave'), ('handy-1', 't-1', 'handy', 7, 8, NULL);`,
	);
	// El cuerpo de un evento de Stripe, que llega con su sangría: una fila corta con más saltos de
	// línea de los que caben escritos con `char(10)` en el SQLite de un objeto (con 50 ya no cabe).
	const evento = {
		id: "evt_reembolso",
		object: "event",
		type: "charge.refunded",
		data: { object: Object.fromEntries(Array.from({ length: 110 }, (_, i) => [`campo_${i}`, i % 3 ? `valor ${i}` : null])) },
	};
	await filasDe(
		central,
		`INSERT INTO webhook_events (event_uid, event_name, resource_type, resource_id, body_sha256, payload_json, received_at_ms, processed_ok)
		 VALUES ('evt_reembolso', 'charge.refunded', 'charge', 'ch_pack', 'sha', ?, 1790000000000, 1);`,
		JSON.stringify(evento, null, 2),
	);
	// Reales en una columna de enteros (no se pueden convertir sin perder), y uno negativo.
	await filasDe(
		central,
		`INSERT INTO pair_claim_fallos (ip, fallos, ultimo_fallo_ms, bloqueado_hasta_ms)
		 VALUES ('10.0.0.1', 2.5, 1790000000000, 0), ('10.0.0.2', -0.25, 1e21, 7), ('::1', 3, 0.1, -12);`,
	);
	// Muchas filas, en una sola sentencia: la copia las lee todas de una pasada.
	await filasDe(
		central,
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1233)
		 INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms)
		 SELECT 'a-' || i, 'extend', NULL, json_object('meses', i, 'nota', 'con ''comilla'''), 1790000000000 - i FROM n;`,
	);
}

async function bajar(clave: string): Promise<string> {
	const objeto = await bucket().get(clave);
	expect(objeto, `no está ${clave} en el bucket`).not.toBeNull();
	const flujo = objeto!.body.pipeThrough(new DecompressionStream("gzip"));
	return await new Response(flujo).text();
}

describe("la copia de la base central", () => {
	it("ida y vuelta: restaurada en un objeto nuevo es IDÉNTICA, tabla a tabla, con los tipos y el esquema", async () => {
		const central = await centralDePrueba();
		await sembrar(central);

		const respuesta = await central.stub.copiar(DIA);
		if (!respuesta.ok) throw new Error(respuesta.error);
		const hecha = respuesta.valor;
		const origen = await enLaCentral(central, (sql) => ({
			contenido: contenido(sql),
			esquema: esquema(sql),
			migraciones: migraciones(sql),
		}));
		expect(hecha.clave).toBe(`${PREFIJO_COPIAS}${DIA}.sql.gz`);
		expect(hecha.tablas).toBe(Object.keys(origen.contenido).length);

		const destino = centralSinAprovisionar();
		const restaurada = await destino.stub.aprovisionar({ claveDeCopia: hecha.clave });
		if (!restaurada.ok) throw new Error(`${restaurada.error}: ${restaurada.detalle}`);
		expect(restaurada.valor.copia).toEqual({ clave: hecha.clave, filas: hecha.filas, tablas: expect.any(Number) });
		expect(restaurada.valor.aprovisionada).toBe(true);

		const vuelta = await enLaCentral(destino, (sql) => ({
			contenido: contenido(sql),
			esquema: esquema(sql),
			migraciones: migraciones(sql),
		}));
		// Compara TODAS las tablas, no sólo las sembradas: una tabla que la copia se callara saldría aquí
		// como vacía, que es el fallo que importa. Y lo sembrado está: no se compara nada vacío.
		expect(vuelta.contenido).toEqual(origen.contenido);
		expect(
			Object.entries(origen.contenido)
				.filter(([, t]) => t.filas.length > 0)
				.map(([nombre]) => nombre),
		).toEqual(["admin_audit", "devices", "license_payments", "licenses", "pair_claim_fallos", "tenants", "webhook_events"]);
		expect(origen.contenido.licenses.filas.length).toBe(4);
		expect(origen.contenido.pair_claim_fallos.tipos).toEqual([
			["text", "real", "integer", "integer"],
			["text", "real", "real", "integer"],
			["text", "integer", "real", "integer"],
		]);
		expect(origen.contenido.tenants.tipos.map((t) => t[11])).toEqual(["text", "blob", "blob", "null"]);
		// El esquema sale de las migraciones de este worker: el mismo, con sus índices.
		expect(vuelta.esquema).toEqual(origen.esquema);
		expect(origen.esquema.some((o) => o.type === "index" && o.sql)).toBe(true);
		expect(vuelta.migraciones).toEqual(origen.migraciones);
		// Y la central restaurada atiende.
		expect((await destino.db.execute("SELECT COUNT(*) AS n FROM licenses;")).rows[0].n).toBe(4);
	});

	it("dice con qué migraciones se hizo, lleva una fila por línea y su fin, y no lleva _migrations", async () => {
		const central = await centralDePrueba();
		await sembrar(central);
		const respuesta = await central.stub.copiar("2026-09-27");
		if (!respuesta.ok) throw new Error(respuesta.error);
		const volcado = await bajar(respuesta.valor.clave);
		const lineas = volcado.split("\n");

		// La cabecera dice con qué esquema se hizo, antes del esquema, y cómo abrirla en local.
		const deMigraciones = lineas.findIndex((l) => l.startsWith("-- Migraciones: "));
		expect(lineas[deMigraciones]).toBe(`-- Migraciones: ${MIGRACIONES_DE_LA_CENTRAL.map((m) => m.name).join(",")}`);
		expect(deMigraciones).toBeLessThan(lineas.findIndex((l) => l.startsWith("CREATE ")));
		expect(volcado).toContain("-- Abrir en local: gunzip -c <este fichero> | sqlite3 central.db");
		// Cada fila es una línea, también la de un texto con saltos de línea dentro.
		const inserts = lineas.filter((l) => l.startsWith('INSERT INTO "'));
		expect(inserts).toHaveLength(respuesta.valor.filas);
		expect(inserts.every((l) => l.endsWith(");"))).toBe(true);
		expect(lineas.at(-3)).toBe(`-- Fin de la copia: ${respuesta.valor.filas} filas en ${respuesta.valor.tablas} tablas`);
		// `_migrations` no va: el esquema lo ponen las migraciones al restaurar.
		expect(lineas.filter((l) => /^(CREATE TABLE|INSERT INTO) "?_migrations/.test(l))).toEqual([]);
		const metadatos = (await bucket().head(respuesta.valor.clave))?.customMetadata;
		expect(metadatos).toMatchObject({
			filas: String(respuesta.valor.filas),
			tablas: String(respuesta.valor.tablas),
			ultimaMigracion: MIGRACIONES_DE_LA_CENTRAL.at(-1)!.name,
		});
	});

	it("una tabla WITHOUT ROWID entra en la copia como las demás, sin hacerla fallar (copias-1)", async () => {
		const central = await centralDePrueba();
		await sembrar(central);
		// Una tabla que una migración de mañana podría crear así: sin rowid por el que ordenar.
		await enLaCentral(central, (sql) => {
			sql.exec("CREATE TABLE sin_rowid (clave TEXT PRIMARY KEY, valor INTEGER NOT NULL) WITHOUT ROWID;");
			sql.exec("INSERT INTO sin_rowid (clave, valor) VALUES ('b', 2), ('a', 1);");
		});

		const respuesta = await central.stub.copiar("2026-09-28");
		if (!respuesta.ok) throw new Error(`${respuesta.error}: ${respuesta.detalle}`);
		const lineas = (await bajar(respuesta.valor.clave)).split("\n");
		expect(lineas).toContain("CREATE TABLE sin_rowid (clave TEXT PRIMARY KEY, valor INTEGER NOT NULL) WITHOUT ROWID;");
		expect(lineas.filter((l) => l.startsWith('INSERT INTO "sin_rowid"')).sort()).toEqual([
			`INSERT INTO "sin_rowid" ("clave", "valor") VALUES ('a', 1);`,
			`INSERT INTO "sin_rowid" ("clave", "valor") VALUES ('b', 2);`,
		]);
		// Todas las filas de la central, las de esa tabla también.
		const origen = await enLaCentral(central, contenido);
		expect(origen.sin_rowid.filas).toEqual([
			["a", 1],
			["b", 2],
		]);
		expect(respuesta.valor.filas).toBe(Object.values(origen).reduce((n, t) => n + t.filas.length, 0));
	});

	it("a mano: con la hora en la clave, sin pisar la del día", async () => {
		const central = await centralDePrueba();
		const antes = Date.now();
		const r = await central.stub.copiar(COPIA_A_MANO);
		if (!r.ok) throw new Error(r.error);
		expect(r.valor.clave).toMatch(/^base-central\/a-mano-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.sql\.gz$/);
		const hora = r.valor.clave.slice("base-central/a-mano-".length, -".sql.gz".length).replace(/T(\d{2})-(\d{2})-/, "T$1:$2:");
		expect(Date.parse(hora)).toBeGreaterThanOrEqual(antes - 1000);
		expect(await bucket().head(r.valor.clave)).not.toBeNull();
	});

	it("una copia demasiado grande FALLA en vez de subir media base", async () => {
		const central = await centralDePrueba();
		await sembrar(central);
		const claveDelDiaFuturo = claveDelDia("2031-01-01");

		// El techo de verdad es de 32 MB comprimida; aquí, uno pequeño, con la copia corriendo dentro
		// del objeto.
		const error = await runInDurableObject(central.stub, (_objeto, state) =>
			copiarLaCentral(state.storage.sql, bucket(), claveDelDiaFuturo, 1_000).catch((e: unknown) => e),
		);
		expect(String((error as Error)?.message)).toMatch(/copia_demasiado_grande/);

		// Y no deja nada: una copia a medias en el bucket es peor que ninguna, porque parece buena.
		expect(await bucket().head(claveDelDiaFuturo)).toBeNull();
	});

	it("de una central sin aprovisionar no hay copia: lo dice, y no sube nada", async () => {
		const { stub } = centralSinAprovisionar();
		expect(await stub.copiar("2031-01-02")).toEqual({ ok: false, error: "central_sin_aprovisionar" });
		expect(await bucket().head(`${PREFIJO_COPIAS}2031-01-02.sql.gz`)).toBeNull();
	});

	it("la del cron sólo es de un día con su forma: el nombre del fichero sale de él", async () => {
		const central = await centralDePrueba();
		expect(() => claveDelDia("../otra-carpeta/x")).toThrow(RangeError);
		expect(await central.stub.copiar("../otra-carpeta/x")).toEqual({
			ok: false,
			error: "central_copia_fallida",
			detalle: expect.stringMatching(/AAAA-MM-DD/),
		});
		expect((await bucket().list({ prefix: "../" })).objects).toEqual([]);
	});

	it("si no llega a subirla, el objeto lo contesta como valor, sin lanzar, y sigue atendiendo", async () => {
		const central = await centralDePrueba();
		await conR2Caido(central);

		expect(await central.stub.copiar("2031-01-03")).toEqual({
			ok: false,
			error: "central_copia_fallida",
			detalle: "R2 no contesta",
		});
		expect((await central.db.execute("SELECT 1 AS uno;")).rows[0].uno).toBe(1);
	});
});

describe("la copia del cron", () => {
	it("con más filas de las que se restauran de una vez, la sube igual y avisa", async () => {
		const central = await centralDePrueba();
		const filas = FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ + 1;
		await filasDe(
			central,
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			 INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms) SELECT 'a-' || i, 'extend', NULL, NULL, i FROM n;`,
			filas,
		);
		const avisos: string[] = [];
		const espia = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			avisos.push(args.map(String).join(" "));
		});
		const clave = claveDelDia(new Date().toISOString().slice(0, 10));
		try {
			const ctx = createExecutionContext();
			await worker.scheduled!(
				createScheduledController({ scheduledTime: Date.now(), cron: "0 7 * * *" }),
				{ ...(env as any), ...central.entorno },
				ctx,
			);
			await waitOnExecutionContext(ctx);
			expect((await bucket().head(clave))?.customMetadata).toMatchObject({ filas: String(filas) });
		} finally {
			espia.mockRestore();
			await bucket().delete(clave);
		}
		expect(avisos.filter((a) => a.includes("restauran"))).toEqual([expect.stringContaining(`${filas} filas`)]);
	}, 60_000);
});
