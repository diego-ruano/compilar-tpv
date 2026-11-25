// test/copiaCentralSinNuestroCodigo.node.test.ts
//
// La copia de la base central se abre sin nuestro código: `gunzip -c <copia>.sql.gz | sqlite3
// central.db`, que es lo que promete su cabecera (`durableObjects/baseCentral.copia.ts`). Aquí, con lo
// que trae Node: `zlib.gunzipSync` y `node:sqlite`, que ejecuta el volcado entero tal cual, con su
// PRAGMA, su BEGIN y su COMMIT. Por eso corre en Node: workerd no tiene `node:sqlite`.
//
// La copia la escribe el código de verdad (`volcarLaCentral`) sobre una base SQLite de verdad, la de
// Node, con el esquema de las migraciones de la central y valores de todos los tipos; lo único que se
// pone en medio es cómo se le habla a esa base, como le habla el objeto a la suya (`SqlStorage`). Que
// la copia que hace el objeto `BaseCentral` vuelve entera a otro objeto lo comprueba
// `copiaBaseCentral.test.ts`.

import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { volcarLaCentral } from "../src/durableObjects/baseCentral.copia";

/** Las migraciones de la central, por su nombre de fichero, en orden. */
const MIGRACIONES = Object.entries(
	import.meta.glob("../src/server/central/migraciones/*.sql", { query: "?raw", import: "default", eager: true }) as Record<
		string,
		string
	>,
)
	.map(([fichero, sql]) => ({ nombre: fichero.split("/").at(-1)!, sql }))
	.sort((a, b) => (a.nombre < b.nombre ? -1 : 1));

/** Cómo le habla el objeto a su base, sobre una de Node: lo que usa la copia, y nada más. */
function comoElObjeto(db: DatabaseSync): SqlStorage {
	return {
		exec(consulta: string, ...args: never[]) {
			const sentencia = db.prepare(consulta);
			const columnNames = sentencia.columns().map((c) => c.name);
			sentencia.setReturnArrays(true);
			// El objeto da los blobs como ArrayBuffer; Node, como Uint8Array.
			const filas = (sentencia.all(...args) as unknown as unknown[][]).map((f) =>
				f.map((v) => (v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v)),
			);
			return {
				columnNames,
				raw: () => filas[Symbol.iterator](),
				toArray: () => filas.map((f) => Object.fromEntries(columnNames.map((c, i) => [c, f[i]]))),
			};
		},
	} as unknown as SqlStorage;
}

/** Una base central con el esquema de sus migraciones y valores de todos los tipos. */
function centralDeNode(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at INTEGER NOT NULL);");
	for (const m of MIGRACIONES) {
		db.exec(m.sql);
		db.prepare("INSERT INTO _migrations (name, hash, applied_at) VALUES (?, 'h', 1);").run(m.nombre);
	}
	const tenant = db.prepare(
		"INSERT INTO tenants (tenant_id, legal_name, display_name, notes, created_at_ms, updated_at_ms, field_dek) VALUES (?, ?, ?, ?, ?, ?, ?);",
	);
	tenant.run("t-1", "Bar O'Donnell", "Café ☕ 🍺 «Ñandú»", "dos\nlíneas\r\ny fin\n", 1790000000123, 1790000000124, "dek");
	tenant.run("t-2", null, "", "un NUL\0en medio 'y comillas'", 3, 4, new Uint8Array([0, 255, 16]));
	tenant.run("t-3", "grande", "x", `${"línea con 'comillas'\r\n".repeat(5000)}fin`, 5, 6, new Uint8Array(40_000).fill(7));
	// Corta, pero con más saltos de línea de los que caben escritos con `char(10)`.
	tenant.run("t-4", "saltos", "x", JSON.stringify({ lineas: Array.from({ length: 700 }, (_, i) => ({ i })) }, null, 1), 7, 8, null);
	// Y con todos los que caben, y uno más.
	tenant.run("t-5", "40 saltos", "x", `${"línea\n".repeat(40)}fin`, 9, 10, null);
	tenant.run("t-6", "41 saltos", "x", `${"línea\r".repeat(41)}fin`, 11, 12, null);
	db.prepare("INSERT INTO devices (device_id, tenant_id, role, first_seen_at_ms, last_seen_at_ms) VALUES ('d-1', 't-1', 'tpv', 5, 6);").run();
	db.exec(
		`INSERT INTO pair_claim_fallos (ip, fallos, ultimo_fallo_ms, bloqueado_hasta_ms)
		 VALUES ('10.0.0.1', 2.5, 1790000000000, 0), ('10.0.0.2', -0.25, 1e21, 7), ('::1', 3, 0.1, -12);`,
	);
	db.exec(
		`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 999)
		 INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms)
		 SELECT 'a-' || i, 'extend', NULL, json_object('meses', i), 1790000000000 - i FROM n;`,
	);
	return db;
}

/** Cada tabla de la base, sin `_migrations`, con sus filas y el tipo de cada valor. */
function contenido(db: DatabaseSync) {
	const tablas = (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> '_migrations' ORDER BY name;").all() as {
			name: string;
		}[]
	).map((t) => t.name);
	return Object.fromEntries(
		tablas.map((t) => {
			const sentencia = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid;`);
			const columnas = sentencia.columns().map((c) => c.name);
			sentencia.setReturnArrays(true);
			const tipos = db.prepare(`SELECT ${columnas.map((c) => `typeof("${c}")`).join(", ")} FROM "${t}" ORDER BY rowid;`);
			tipos.setReturnArrays(true);
			return [t, { filas: sentencia.all(), tipos: tipos.all() }];
		}),
	);
}

/** El esquema, sin `_migrations`. */
const esquema = (db: DatabaseSync) =>
	db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> '_migrations' ORDER BY type, name;")
		.all();

describe("la copia de la central se abre sin nuestro código", () => {
	it("gunzip y node:sqlite la cargan entera, con su esquema, sus filas y sus tipos", () => {
		const origen = centralDeNode();
		const { gzip, filas, tablas } = volcarLaCentral(comoElObjeto(origen), { ahora: new Date() });

		const texto = gunzipSync(gzip).toString("utf8");
		const abierta = new DatabaseSync(":memory:");
		abierta.exec(texto);

		expect(contenido(abierta)).toEqual(contenido(origen));
		expect(esquema(abierta)).toEqual(esquema(origen));
		expect(filas).toBe(6 + 1 + 3 + 1000);
		expect(tablas).toBe(Object.keys(contenido(origen)).length);
		// Lo incómodo ha vuelto como era.
		const t3 = abierta.prepare("SELECT length(notes) AS n, typeof(field_dek) AS tipo FROM tenants WHERE tenant_id = 't-3';").get();
		expect(t3).toEqual({ n: 5000 * "línea con 'comillas'\r\n".length + 3, tipo: "blob" });
		expect(abierta.prepare("SELECT notes FROM tenants WHERE tenant_id = 't-2';").get()).toEqual({
			notes: "un NUL\0en medio 'y comillas'",
		});
	});
});
