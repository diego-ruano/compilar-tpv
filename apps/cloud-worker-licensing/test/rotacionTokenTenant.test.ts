// test/rotacionTokenTenant.test.ts
//
// REV-09: que no se pueda rotar el token de Turso no puede tumbar la nube entera.
//
// El token de la base de cada negocio dura 7 días y se rota cada 24 h, así que cuando toca rotar
// suele quedarle casi una semana de vida. Aun así, un fallo de la API de plataforma de Turso —otro
// servicio, con su propia disponibilidad— salía por la misma puerta que un token inservible y
// dejaba sin resolver la credencial: todas las lecturas REST y el Durable Object, de TODOS los
// negocios, mientras durase. Se cambiaba una molestia (no rotar hoy) por una caída.
//
// Lo que se fija aquí son los tres casos, porque el arreglo sólo vale si el tercero sigue fallando:
// tolerar siempre convertiría un 401 permanente en un bucle mudo.

import { describe, expect, it, vi, afterEach } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { resolveTenantDbCredentials } from "../src/server/db/tenantDb";
import { aesGcmEncrypt } from "../src/server/crypto";

const CLAVE = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const ENV = {
	LICENSE_STORE_KEY: CLAVE,
	TURSO_PLATFORM_TOKEN: "token-de-plataforma",
	TURSO_ORG_SLUG: "org",
};
const TENANT = "tenant-1";
const TOKEN_GUARDADO = "jwt-que-sigue-valiendo";
const DIA = 24 * 60 * 60 * 1000;

afterEach(() => {
	vi.unstubAllGlobals();
});

/** La API de plataforma de Turso, caída. */
function tursoCaido() {
	const llamadas = { n: 0 };
	vi.stubGlobal("fetch", async () => {
		llamadas.n++;
		return new Response("upstream unavailable", { status: 503 });
	});
	return llamadas;
}

/** Un tenant aprovisionado cuyo token se rotó hace `rotadoHaceMs`. */
async function conTenant<R>(
	nombre: string,
	rotadoHaceMs: number,
	prueba: (db: any) => Promise<R>,
): Promise<R> {
	return enElHub(`rotacion-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const tabla of ["tenant_databases", "tenants"]) sql.exec(`DELETE FROM ${tabla};`);

		sql.exec(`INSERT INTO tenants (tenant_id) VALUES (?);`, TENANT);
		sql.exec(
			`INSERT INTO tenant_databases (tenant_id, turso_db_name, turso_url, turso_auth_token_enc, rotated_at_ms)
			 VALUES (?, 'db-1', 'libsql://db-1.turso.io', ?, ?);`,
			TENANT,
			await aesGcmEncrypt(CLAVE, TOKEN_GUARDADO),
			Date.now() - rotadoHaceMs,
		);
		return prueba(clienteSobre(sql));
	});
}

describe("REV-09 · rotar el token de un tenant cuando Turso no contesta", () => {
	it("toca rotar y falla: se sigue con el token guardado, que aún vale días", async () => {
		const llamadas = tursoCaido();
		await conTenant("proactiva", 2 * DIA, async (db) => {
			const r = await resolveTenantDbCredentials(db, ENV as any, TENANT);

			expect(llamadas.n).toBeGreaterThan(0); // lo intentó
			expect(r.tursoAuthToken).toBe(TOKEN_GUARDADO);
			expect(r.rotated).toBe(false);
		});
	});

	it("y no se marca como rotado, para que se vuelva a intentar", async () => {
		// Si se escribiera `rotated_at_ms`, el fallo se convertiría en «ya está hecho» y el token
		// no se renovaría hasta el día siguiente, acercándose a su caducidad sin motivo.
		tursoCaido();
		await conTenant("no-marca", 2 * DIA, async (db) => {
			await resolveTenantDbCredentials(db, ENV as any, TENANT);
			const r2 = await resolveTenantDbCredentials(db, ENV as any, TENANT);
			expect(r2.tursoAuthToken).toBe(TOKEN_GUARDADO);
		});
	});

	it("cerca de la caducidad SÍ falla: seguir sería cambiar un error claro por un 401 opaco", async () => {
		// El token dura 7 días. A los 6 días y medio le quedan 12 h, que es el margen.
		tursoCaido();
		await conTenant("caducando", 6.75 * DIA, async (db) => {
			await expect(resolveTenantDbCredentials(db, ENV as any, TENANT)).rejects.toThrow(
				/turso_create_db_token_failed/,
			);
		});
	});

	it("una rotación FORZADA sigue fallando: venimos de un 401, el guardado ya no sirve", async () => {
		// Es la diferencia que hace que esto no sea «ignorar los errores»: reutilizar un token que
		// la base acaba de rechazar es girar en el mismo sitio.
		tursoCaido();
		await conTenant("forzada", 1000, async (db) => {
			await expect(resolveTenantDbCredentials(db, ENV as any, TENANT, true)).rejects.toThrow(
				/turso_create_db_token_failed/,
			);
		});
	});

	it("sin tocar nada, un token reciente ni siquiera intenta rotar", async () => {
		const llamadas = tursoCaido();
		await conTenant("reciente", 1000, async (db) => {
			const r = await resolveTenantDbCredentials(db, ENV as any, TENANT);
			expect(llamadas.n).toBe(0);
			expect(r.tursoAuthToken).toBe(TOKEN_GUARDADO);
		});
	});
});
