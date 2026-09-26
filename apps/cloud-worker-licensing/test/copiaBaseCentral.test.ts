// test/copiaBaseCentral.test.ts
//
// La copia diaria de la base central a R2 (PROD-02, `server/copiaBaseCentral.ts`).
//
// Lo único que demuestra que una copia sirve es restaurarla, así que eso es lo que se hace aquí: se
// copia una base central con datos incómodos, se baja el fichero del bucket, se carga en un SQLite
// vacío y se compara tabla a tabla. Una prueba que sólo mirara que «se subió algo» pasaría igual con
// una copia que no se puede leer, que es el fallo que no se descubre hasta el día que hace falta.

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { copiarBaseCentral, literal, PREFIJO_COPIAS } from "../src/server/copiaBaseCentral";

const AHORA = Date.UTC(2026, 8, 26, 7, 0, 0);
const bucket = () => (env as any).COPIAS as R2Bucket;

/** Las tablas de la base central tal como las ve SQLite, sin las internas del Durable Object. */
function tablasDe(sql: any): string[] {
	return sql
		.exec(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			 ORDER BY name;`,
		)
		.toArray()
		.map((r: any) => String(r.name));
}

function contenido(sql: any): Record<string, string> {
	const out: Record<string, string> = {};
	for (const t of tablasDe(sql)) {
		out[t] = JSON.stringify(sql.exec(`SELECT * FROM "${t}" ORDER BY rowid;`).toArray());
	}
	return out;
}

function sembrar(sql: any) {
	sql.exec(
		`INSERT INTO tenants (tenant_id, legal_name, notes, created_at_ms, updated_at_ms, field_dek)
		 VALUES ('t-1', 'Bar O''Donnell', 'dos
		 líneas', 1, 2, 'dek-cifrada'),
		        ('t-2', NULL, 'un NUL' || char(0) || 'en medio', 3, 4, NULL);`,
	);
	sql.exec(
		`INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms)
		 VALUES ('d-1', 't-1', 'tpv', 5, 6);`,
	);
	// Más filas que una página, para que la paginación por `rowid` tenga que dar la vuelta.
	for (let i = 0; i < 1234; i++) {
		sql.exec(
			`INSERT INTO pair_claim_fallos (ip, fallos, ultimo_fallo_ms, bloqueado_hasta_ms)
			 VALUES (?, ?, ?, 0);`,
			`10.0.${Math.floor(i / 256)}.${i % 256}`,
			i,
			AHORA - i,
		);
	}
}

async function bajar(clave: string): Promise<string> {
	const objeto = await bucket().get(clave);
	expect(objeto, `no está ${clave} en el bucket`).not.toBeNull();
	const flujo = objeto!.body.pipeThrough(new DecompressionStream("gzip"));
	return await new Response(flujo).text();
}

/**
 * Carga la copia en un SQLite vacío. `sqlite3` y `turso db create --from-dump` la leen tal cual; el
 * SQLite de un Durable Object tiene dos manías que aquí hay que sortear, y ninguna es de la copia:
 *   · no acepta `BEGIN`/`COMMIT` ni ese `PRAGMA` (sus transacciones van por `transactionSync`), así
 *     que se quitan esas tres líneas;
 *   · no acepta un texto de más de 100 KB por llamada (SQLITE_TOOBIG), así que se ejecuta por
 *     trozos, cortando sólo delante de una línea que empieza sentencia. Un valor de texto con un
 *     salto de línea sigue en su trozo porque su continuación no empieza por INSERT ni CREATE.
 */
function restaurar(sql: any, volcado: string) {
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
	it("se restaura en una base vacía y queda IDÉNTICA, tabla a tabla", async () => {
		const origen = await enElHub("copia-origen", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			sembrar(sql);
			const hecha = await copiarBaseCentral(clienteSobre(sql, hub.state.storage), bucket(), {
				ahoraMs: AHORA,
			});
			return { hecha, contenido: contenido(sql), tablas: tablasDe(sql) };
		});

		expect(origen.hecha.clave).toBe(`${PREFIJO_COPIAS}2026-09-26.sql.gz`);
		expect(origen.hecha.tablas).toBe(origen.tablas.length);
		expect(origen.hecha.filas).toBe(2 + 1 + 1234);

		const volcado = await bajar(origen.hecha.clave);

		const restaurada = await enElHub("copia-destino", async (hub: any) => {
			const sql = hub.state.storage.sql;
			restaurar(sql, volcado);
			return contenido(sql);
		});

		// Compara TODAS las tablas, no sólo las sembradas: una tabla que la copia se callara
		// saldría aquí como ausente, que es el fallo que importa.
		expect(restaurada).toEqual(origen.contenido);
	});

	it("restaura también los índices: la estructura vuelve entera, no sólo los datos", async () => {
		const clave = await enElHub("copia-indices-origen", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			return (await copiarBaseCentral(clienteSobre(sql), bucket(), { ahoraMs: AHORA })).clave;
		});
		const volcado = await bajar(clave);

		const indices = (sql: any) =>
			sql
				.exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name;`)
				.toArray()
				.map((r: any) => r.name);

		const esperados = await enElHub("copia-indices-origen", (hub: any) => indices(hub.state.storage.sql));
		const restaurados = await enElHub("copia-indices-destino", (hub: any) => {
			restaurar(hub.state.storage.sql, volcado);
			return indices(hub.state.storage.sql);
		});

		expect(esperados.length).toBeGreaterThan(0);
		expect(restaurados).toEqual(esperados);
	});

	it("una copia demasiado grande FALLA en vez de subir media base", async () => {
		const claveDelDia = `${PREFIJO_COPIAS}2031-01-01.sql.gz`;
		await enElHub("copia-tope", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			sembrar(sql);
			await expect(
				copiarBaseCentral(clienteSobre(sql), bucket(), {
					ahoraMs: Date.UTC(2031, 0, 1),
					topeCaracteres: 10_000,
				}),
			).rejects.toThrow(/copia_demasiado_grande/);
		});

		// Y no deja nada: una copia a medias en el bucket es peor que ninguna, porque parece buena.
		expect(await bucket().head(claveDelDia)).toBeNull();
	});
});

describe("los valores se escriben como SQL que vuelve a dar lo mismo", () => {
	it("texto, números, NULL y binario", () => {
		expect(literal(null)).toBe("NULL");
		expect(literal(undefined)).toBe("NULL");
		expect(literal(42)).toBe("42");
		expect(literal(1.5)).toBe("1.5");
		expect(literal(12345678901234567890n)).toBe("12345678901234567890");
		expect(literal("O'Donnell")).toBe("'O''Donnell'");
		expect(literal(new Uint8Array([0, 15, 255]))).toBe("X'000fff'");
	});

	it("un NUL dentro del texto no corta la cadena", () => {
		expect(literal("a\0b")).toBe("CAST(X'610062' AS TEXT)");
	});

	it("un número que no es finito no se disfraza de NULL", () => {
		expect(() => literal(Number.NaN)).toThrow(/copia_valor_no_finito/);
		expect(() => literal(Infinity)).toThrow(/copia_valor_no_finito/);
	});
});
