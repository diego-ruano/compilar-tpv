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
// - **Lo que no cambia sin querer.** Lo que la base central tiene que tener, leído de la estructura
//   que da SQLite (`pragma_table_xinfo`, `pragma_index_list`…) y no del texto: las tablas que hay,
//   sin vistas ni triggers; las columnas de `tenants`, con su DEFAULT y sus CHECK; el índice único y
//   parcial de `license_payments` por sesión y unidad; y las claves foráneas que borran en cascada.
//   La foto se regenera con `-u`; esto sólo cambia a mano.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { centralDePrueba } from "./helpers/central";

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

describe("lo que la base central tiene que tener", () => {
	it("sus tablas, las columnas y los CHECK de tenants, el índice parcial de los cobros y las cascadas", async () => {
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
