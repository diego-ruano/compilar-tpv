// test/cifradoEnReposo.test.ts
//
// RI-73 · `LICENSE_STORE_KEY` con versión: lo que se cifra con ella dice con qué clave, y cambiarla
// ya no deja ilegible lo anterior.
//
// El 27/09 se regeneraron los secretos del worker. Como el formato era sólo base64(iv‖ct), sin decir
// con qué clave, todo lo cifrado antes —las DEK, los tokens de Turso, las claves de licencia— dejó de
// poder leerse, y `/health` siguió en verde. Lo que se fija aquí:
//   · lo de antes (sin prefijo) se sigue leyendo;
//   · durante una rotación se lee con la anterior y se guarda ya con la actual;
//   · la ruta de recifrar termina la rotación, y dice lo que no puede;
//   · un token de Turso que no se deja descifrar se sustituye en el acto;
//   · `/health` descifra un canario y contesta 503 con una clave equivocada.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { cifrar, descifrar, versionDe } from "../src/server/crypto";
import { getOrCreateTenantFieldDek, recifrarConLaActual } from "../src/server/licenseStore";
import { resolveTenantDbCredentials } from "../src/server/db/tenantDb";
import { comprobarSalud, olvidarSalud, TEXTO_CANARIO } from "../src/server/salud";

const K1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const K2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const OTRA = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

/** En plena rotación: se escribe con K2 y se lee también con K1. */
const ROTANDO = {
	LICENSE_STORE_KEY: K2,
	LICENSE_STORE_KEY_ID: "2",
	LICENSE_STORE_KEY_ANTERIOR: K1,
	LICENSE_STORE_KEY_ANTERIOR_ID: "1",
};

/** Lo que guardaba el worker antes de las versiones: el base64 a secas, cifrado con K1. */
async function comoAntes(texto: string): Promise<string> {
	return (await cifrar(K1, texto)).replace(/^k1:/, "");
}

describe("RI-73 · el formato con versión", () => {
	it("cifra con el prefijo de la clave actual y lo lee sin recifrar", async () => {
		const c = await cifrar(K1, "hola");
		expect(c.startsWith("k1:")).toBe(true);
		expect(await descifrar(K1, c)).toEqual({ texto: "hola", recifrado: null });
	});

	it("lo cifrado antes de las versiones se lee como versión 1", async () => {
		const viejo = await comoAntes("de antes");
		expect(versionDe(viejo)).toBe("1");
		expect((await descifrar(K1, viejo)).texto).toBe("de antes");
	});

	it("en plena rotación se lee con la anterior y sale recifrado con la actual", async () => {
		const viejo = await comoAntes("dek");
		const { texto, recifrado } = await descifrar(ROTANDO, viejo);
		expect(texto).toBe("dek");
		expect(recifrado?.startsWith("k2:")).toBe(true);
		expect(await descifrar({ LICENSE_STORE_KEY: K2, LICENSE_STORE_KEY_ID: "2" }, recifrado!)).toEqual({
			texto: "dek",
			recifrado: null,
		});
	});

	it("una versión que no está configurada es un error claro, no un «Decryption failed»", async () => {
		const c = await cifrar({ LICENSE_STORE_KEY: OTRA, LICENSE_STORE_KEY_ID: "7" }, "x");
		await expect(descifrar(ROTANDO, c)).rejects.toThrow(/versión 7/);
	});

	it("dos claves con la misma versión se rechazan al usarlas", async () => {
		await expect(
			cifrar({ LICENSE_STORE_KEY: K2, LICENSE_STORE_KEY_ANTERIOR: K1 }, "x"),
		).rejects.toThrow(/LICENSE_STORE_KEY_ANTERIOR_ID/);
	});
});

/** La base central de pruebas, vacía de lo que tocan estos casos. */
async function conBaseCentral<T>(nombre: string, prueba: (e: { sql: any; db: any }) => Promise<T>) {
	return enElHub(`cifrado-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const t of ["licenses", "tenant_databases", "tenants", "canario_cifrado"]) sql.exec(`DELETE FROM ${t};`);
		return prueba({ sql, db: clienteSobre(sql) });
	});
}

describe("RI-73 · rotar LICENSE_STORE_KEY sin perder nada", () => {
	it("leer la DEK de un negocio con la clave anterior la deja guardada con la actual", async () => {
		await conBaseCentral("dek", async ({ sql, db }) => {
			sql.exec(`INSERT INTO tenants (tenant_id, field_dek) VALUES ('t1', ?);`, await comoAntes("la-dek"));
			expect(await getOrCreateTenantFieldDek(db, ROTANDO, "t1")).toBe("la-dek");
			const guardada = String(sql.exec(`SELECT field_dek FROM tenants;`).toArray()[0].field_dek);
			expect(versionDe(guardada)).toBe("2");
		});
	});

	it("la ruta de recifrar pasa todo a la actual, y separa lo que no puede leer", async () => {
		await conBaseCentral("recifrar", async ({ sql, db }) => {
			sql.exec(`INSERT INTO tenants (tenant_id, field_dek) VALUES ('t1', ?), ('t2', ?);`,
				await comoAntes("dek-1"),
				await cifrar(ROTANDO, "dek-2"), // ya está con la actual: no se toca
			);
			sql.exec(
				`INSERT INTO tenant_databases (tenant_id, turso_db_name, turso_url, turso_auth_token_enc)
				 VALUES ('t1', 'db', 'libsql://db', ?);`,
				await cifrar(OTRA, "token-ilegible"),
			);
			sql.exec(
				`INSERT INTO licenses (license_id, license_key_hash, license_key_enc, status, term_months, origin,
				                       issued_at_ms, customer_email, created_at_ms, updated_at_ms)
				 VALUES ('l1', 'h1', ?, 'issued', 12, 'manual', 1, 'a@b.test', 1, 1);`,
				await comoAntes("CLAVE-1"),
			);

			const r = await recifrarConLaActual(db, ROTANDO, 100);
			expect(r.recifrados).toEqual({ licencias: 1, deks: 1, tokensTurso: 0 });
			expect(r.ilegibles).toEqual([{ tabla: "tenant_databases", id: "t1" }]);
			expect(r.quedanMas).toBe(false);

			const clave = String(sql.exec(`SELECT license_key_enc FROM licenses;`).toArray()[0].license_key_enc);
			expect(await descifrar(ROTANDO, clave)).toEqual({ texto: "CLAVE-1", recifrado: null });
		});
	});

	it("con más de lo que cabe en una llamada, dice que quedan más", async () => {
		await conBaseCentral("techo", async ({ sql, db }) => {
			sql.exec(`INSERT INTO tenants (tenant_id, field_dek) VALUES ('t1', ?), ('t2', ?);`,
				await comoAntes("a"),
				await comoAntes("b"),
			);
			const r = await recifrarConLaActual(db, ROTANDO, 1);
			expect(r.recifrados.deks).toBe(1);
			expect(r.quedanMas).toBe(true);
			expect((await recifrarConLaActual(db, ROTANDO, 1)).quedanMas).toBe(false);
		});
	});
});

describe("RI-73 · un token de Turso que no se deja descifrar", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("se sustituye en el acto por uno nuevo, sin esperar a la rotación del día siguiente", async () => {
		const pedidos: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			pedidos.push(String(url));
			return new Response(JSON.stringify({ jwt: "token-nuevo" }), { status: 200 });
		});
		await conBaseCentral("token", async ({ sql, db }) => {
			sql.exec(`INSERT INTO tenants (tenant_id) VALUES ('t1');`);
			sql.exec(
				`INSERT INTO tenant_databases (tenant_id, turso_db_name, turso_url, turso_auth_token_enc, rotated_at_ms)
				 VALUES ('t1', 'db', 'libsql://db', ?, ?);`,
				await cifrar(OTRA, "token-viejo"),
				Date.now() - 1000,
			);
			const env = { LICENSE_STORE_KEY: K1, TURSO_PLATFORM_TOKEN: "p", TURSO_ORG_SLUG: "org" };
			const r = await resolveTenantDbCredentials(db, env as any, "t1");
			expect(r.tursoAuthToken).toBe("token-nuevo");
			expect(pedidos.length).toBe(1);
			const guardado = String(sql.exec(`SELECT turso_auth_token_enc FROM tenant_databases;`).toArray()[0].turso_auth_token_enc);
			expect((await descifrar(K1, guardado)).texto).toBe("token-nuevo");
		});
	});
});

describe("RI-73 · el canario de /health", () => {
	beforeEach(() => olvidarSalud());

	it("la primera vez lo crea, y con la misma clave sigue en verde", async () => {
		await conBaseCentral("canario-ok", async ({ db }) => {
			expect(await comprobarSalud(() => db, 1_000, K1)).toEqual({ ok: true, db: "ok", cifrado: "ok" });
			olvidarSalud();
			expect(await comprobarSalud(() => db, 2_000, K1)).toEqual({ ok: true, db: "ok", cifrado: "ok" });
		});
	});

	it("con otra clave contesta que NO: el 27/09 entero, visto en minutos", async () => {
		await conBaseCentral("canario-falla", async ({ db }) => {
			await comprobarSalud(() => db, 1_000, K1);
			olvidarSalud();
			expect(await comprobarSalud(() => db, 2_000, OTRA)).toEqual({ ok: false, db: "ok", cifrado: "falla" });
		});
	});

	it("en plena rotación sigue en verde, y el canario se pasa a la actual", async () => {
		await conBaseCentral("canario-rotacion", async ({ sql, db }) => {
			await comprobarSalud(() => db, 1_000, K1);
			olvidarSalud();
			expect((await comprobarSalud(() => db, 2_000, ROTANDO)).cifrado).toBe("ok");
			const valor = String(sql.exec(`SELECT valor FROM canario_cifrado;`).toArray()[0].valor);
			expect(await descifrar(ROTANDO, valor)).toEqual({ texto: TEXTO_CANARIO, recifrado: null });
		});
	});

	it("sin la tabla todavía, lo dice pero no tumba la sonda", async () => {
		await conBaseCentral("canario-sin-tabla", async ({ sql, db }) => {
			sql.exec(`DROP TABLE canario_cifrado;`);
			expect(await comprobarSalud(() => db, 1_000, K1)).toEqual({ ok: true, db: "ok", cifrado: "sin_comprobar" });
		});
	});
});
