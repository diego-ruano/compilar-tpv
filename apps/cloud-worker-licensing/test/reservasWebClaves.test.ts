// test/reservasWebClaves.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): la clave pública de cada negocio, contra
// la estructura de verdad de la base central (`docs/sql/control-plane/esquema-actual.sql`).

import { beforeEach, describe, expect, it } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import {
	CLAVE_RE,
	claveDelNegocio,
	codigoParaLaWeb,
	generarClave,
	negocioDeLaClave,
	olvidarClavesCacheadas,
} from "../src/domains/reservas_web/claves";

beforeEach(() => olvidarClavesCacheadas());

async function conBaseCentral(nombre: string, prueba: (db: any, sql: any) => Promise<void>) {
	await enElHub(nombre, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		sql.exec(`INSERT INTO tenants (tenant_id) VALUES ('t1'), ('t2');`);
		await prueba(clienteSobre(sql), sql);
	});
}

describe("la clave pública de la reserva web", () => {
	it("es «rw_» y 128 bits aleatorios: no se repite ni se adivina", () => {
		const claves = new Set(Array.from({ length: 200 }, generarClave));
		expect(claves.size).toBe(200);
		for (const c of claves) expect(c).toMatch(CLAVE_RE);
	});

	it("un negocio tiene una sola clave activa aunque la pidan dos a la vez", async () => {
		await conBaseCentral("rw-claves-una", async (db, sql) => {
			const [a, b] = await Promise.all([claveDelNegocio(db, "t1", 1), claveDelNegocio(db, "t1", 2)]);
			expect(a).toBe(b);
			expect(await claveDelNegocio(db, "t1", 3)).toBe(a);
			const activas = sql
				.exec(`SELECT COUNT(*) AS n FROM reserva_web_claves WHERE tenant_id = 't1' AND revoked_at_ms IS NULL;`)
				.toArray()[0].n;
			expect(activas).toBe(1);
			expect(await claveDelNegocio(db, "t2", 4)).not.toBe(a);
		});
	});

	it("una clave revocada ya no lleva a ningún negocio, y una inventada tampoco", async () => {
		await conBaseCentral("rw-claves-revocada", async (db, sql) => {
			const clave = await claveDelNegocio(db, "t1", 1);
			expect(await negocioDeLaClave(db, clave)).toBe("t1");

			sql.exec(`UPDATE reserva_web_claves SET revoked_at_ms = 5 WHERE clave = ?;`, clave);
			olvidarClavesCacheadas();
			expect(await negocioDeLaClave(db, clave)).toBeNull();
			expect(await negocioDeLaClave(db, generarClave())).toBeNull();
			expect(await negocioDeLaClave(db, "t1")).toBeNull();
			// Tras revocarla, pedir la clave del negocio da otra nueva.
			const nueva = await claveDelNegocio(db, "t1", 6);
			expect(nueva).not.toBe(clave);
		});
	});

	it("la línea que se pega lleva la clave y el script del mismo origen", () => {
		const codigo = codigoParaLaWeb("https://tpv-api.ejemplo.dev", "rw_AAAAAAAAAAAAAAAAAAAAAA");
		expect(codigo).toContain('data-negocio="rw_AAAAAAAAAAAAAAAAAAAAAA"');
		expect(codigo).toContain('src="https://tpv-api.ejemplo.dev/reservas-web/v1/embed.js"');
	});
});
