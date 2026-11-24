// test/centralEsquema.test.ts
//
// El esquema de la base central, en dos comprobaciones:
//
// - **La foto.** Las migraciones de la central (`server/central/migraciones/`) dan exactamente el
//   esquema de `server/central/esquema.snapshot.sql`: el SQL que guarda SQLite de cada tabla e
//   índice, con los espacios normalizados, como la foto de la base de cada negocio
//   (`migrations.rs::schema_snapshot_no_drift`). Un cambio de esquema a propósito la regenera con
//   `pnpm --filter tpv-api exec vitest run test/centralEsquema.test.ts -u`, y el cambio de la foto
//   se revisa con el de la migración.
// - **La 0001 es la base de producción.** La primera migración crea EXACTAMENTE la base que hay en
//   producción, fotografiada en `docs/sql/control-plane/esquema-actual.sql`: las mismas tablas, con
//   sus columnas en el mismo orden y con el mismo tipo, NOT NULL, DEFAULT y clave primaria; los
//   mismos índices, con sus columnas y su WHERE; las mismas claves foráneas y los mismos CHECK. Es
//   lo que permite cargar en el objeto un volcado de la base de hoy sin traducir nada. Se compara la
//   estructura que da SQLite (`pragma_table_xinfo`, `pragma_index_list`…), no el texto: los
//   comentarios no cuentan, y un espacio de más tampoco.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { centralDePrueba, centralSinAprovisionar } from "./helpers/central";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
/** Un trozo de SQL sin espacios que no cuentan: los de más y los de junto a un paréntesis o una coma. */
const normalizado = (s: string) =>
	s
		.replace(/\s+/g, " ")
		.replace(/\s*([(),])\s*/g, "$1")
		.trim();

/** Lo que va dentro de cada `CHECK (…)` de una sentencia CREATE TABLE, en orden. */
function checksDe(crear: string): string[] {
	const texto = sinComentarios(crear);
	const checks: string[] = [];
	const inicio = /\bCHECK\s*\(/gi;
	for (let m = inicio.exec(texto); m; m = inicio.exec(texto)) {
		let nivel = 1;
		let i = inicio.lastIndex;
		while (i < texto.length && nivel > 0) {
			if (texto[i] === "(") nivel++;
			else if (texto[i] === ")") nivel--;
			i++;
		}
		checks.push(normalizado(texto.slice(inicio.lastIndex, i - 1)));
	}
	return checks;
}

/** La estructura de una base: todo lo que decide qué filas admite y cómo se guardan. */
function estructura(sql: SqlStorage) {
	const filas = (consulta: string, ...args: unknown[]) => sql.exec(consulta, ...args).toArray() as any[];
	const tablas = filas(
		`SELECT name, sql FROM sqlite_master
		 WHERE type = 'table' AND name <> '_migrations'
		   AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
		 ORDER BY name;`,
	);
	const dondeDe = (indice: string): string | null => {
		const crear = filas("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1;", indice)[0]?.sql;
		if (!crear) return null;
		const donde = /\bWHERE\b([\s\S]*)$/i.exec(sinComentarios(String(crear)));
		return donde ? normalizado(donde[1]) : null;
	};
	return {
		vistasYTriggers: filas("SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger');"),
		tablas: Object.fromEntries(
			tablas.map((t) => [
				t.name,
				{
					forma: filas(
						"SELECT type, ncol, wr, strict FROM pragma_table_list WHERE schema = 'main' AND name = ?1;",
						t.name,
					),
					columnas: filas(
						`SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?1) ORDER BY cid;`,
						t.name,
					),
					indices: filas(`SELECT name, "unique", origin, partial FROM pragma_index_list(?1) ORDER BY name;`, t.name).map(
						(i) => ({
							...i,
							columnas: filas(
								`SELECT seqno, cid, name, "desc", coll, key FROM pragma_index_xinfo(?1) ORDER BY seqno;`,
								i.name,
							),
							donde: dondeDe(i.name),
						}),
					),
					foraneas: filas(
						`SELECT id, seq, "table", "from", "to", on_update, on_delete, "match"
						 FROM pragma_foreign_key_list(?1) ORDER BY id, seq;`,
						t.name,
					),
					checks: checksDe(String(t.sql)),
				},
			]),
		),
	};
}

type Estructura = ReturnType<typeof estructura>;

/**
 * La foto del esquema: el SQL de cada tabla e índice tal como lo guarda SQLite, sin las tablas de
 * SQLite, las del Durable Object ni `_migrations`, y con los espacios normalizados.
 */
function fotoDe(sql: SqlStorage): string {
	return sql
		.exec(
			`SELECT sql FROM sqlite_master
			 WHERE sql IS NOT NULL AND name <> '_migrations'
			   AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
			 ORDER BY type, name;`,
		)
		.toArray()
		.map((r: any) => `${String(r.sql).split(/\s+/).filter(Boolean).join(" ")};\n`)
		.join("");
}

describe("la foto del esquema de la central", () => {
	it("las migraciones dan la foto", async () => {
		const foto = await runInDurableObject((await centralDePrueba()).stub, (_c, state) => fotoDe(state.storage.sql));
		expect(foto).toMatch(/^CREATE INDEX /);
		await expect(foto).toMatchFileSnapshot("../src/server/central/esquema.snapshot.sql");
	});
});

describe("la 0001 de la central es la base de producción", () => {
	it("crea exactamente la misma estructura que la foto", async () => {
		const migrada: Estructura = await runInDurableObject((await centralDePrueba()).stub, (_c, state) =>
			estructura(state.storage.sql),
		);
		const foto: Estructura = await runInDurableObject(centralSinAprovisionar().stub, (_c, state) => {
			prepararPlanoDeControl(state.storage.sql);
			return estructura(state.storage.sql);
		});

		expect(migrada).toEqual(foto);
	});

	it("y la comparación mira de verdad: columnas, índices parciales, claves foráneas y CHECK", async () => {
		const { tablas, vistasYTriggers } = await runInDurableObject((await centralDePrueba()).stub, (_c, state) =>
			estructura(state.storage.sql),
		);
		expect(Object.keys(tablas)).toHaveLength(22);
		expect(vistasYTriggers).toEqual([]);

		expect(tablas.tenants.columnas.map((c: any) => c.name)).toEqual([
			"tenant_id", "status", "legal_name", "display_name", "email", "phone", "country", "timezone", "notes",
			"created_at_ms", "updated_at_ms", "field_dek", "piloto",
		]);
		expect(tablas.tenants.columnas[9]).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "unixepoch()*1000" });
		expect(tablas.tenants.checks).toEqual(["status IN('active','suspended','deleted')", "piloto IN(0,1)"]);

		const porSesion = tablas.license_payments.indices.find((i: any) => i.name === "ux_license_payments_session_unidad");
		expect(porSesion).toMatchObject({ unique: 1, partial: 1, donde: "stripe_checkout_session_id IS NOT NULL" });
		expect(porSesion.columnas.filter((c: any) => c.key).map((c: any) => c.name)).toEqual([
			"stripe_checkout_session_id",
			"unidad",
		]);

		for (const hija of ["devices", "reserva_web_claves", "reserva_web_dominios"]) {
			expect(tablas[hija].foraneas, hija).toEqual([
				expect.objectContaining({ table: "tenants", from: "tenant_id", to: "tenant_id", on_delete: "CASCADE" }),
			]);
		}
	});
});
