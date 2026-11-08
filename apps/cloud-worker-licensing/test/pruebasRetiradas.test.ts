// test/pruebasRetiradas.test.ts
//
// POST /v1/admin/pruebas/retirar: borra los negocios que deja el E2E, con su base de Turso.
//
// Es una ruta que borra bases en producción, así que lo que más importa aquí es lo que NO toca: un
// negocio con una licencia que no sea de pruebas, aunque tenga también una de pruebas. Corre contra
// el esquema real del control-plane sobre el SQLite de un Durable Object, como
// `adminLicenciaReversible.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import { CORREO_DE_PRUEBAS } from "../src/domains/admin/pruebas";
import { activateLicenseFirstTime, getLicenseById, issueLicense } from "../src/server/licenseStore";
import type { LicenseOrigin } from "../src/shared";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const TOKEN = "token-de-pruebas";

let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type Escenario = {
	post: (ruta: string, cuerpo?: unknown) => Promise<Response>;
	/** Emite una licencia y, si se da `tenantId`, la activa en ese negocio, que tendrá su base. */
	negocio: (origen: LicenseOrigin, correo: string, tenantId?: string) => Promise<string>;
	estadoDelNegocio: (tenantId: string) => string | null;
	tieneBase: (tenantId: string) => boolean;
	estadoDeLicencia: (licenseId: string) => Promise<string>;
	/** Las bases que se le pidió a Turso borrar, en orden. */
	borradasEnTurso: string[];
	/** Lo que contesta Turso a cada borrado, por nombre de base (200 si no se dice). */
	turso: Map<string, number>;
};

async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub("pruebas-retiradas", async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql);
		dbDePruebas = db;
		prepararPlanoDeControl(sql);
		for (const tabla of ["licenses", "tenant_databases", "tenants", "admin_audit"]) {
			sql.exec(`DELETE FROM ${tabla};`);
		}

		const borradasEnTurso: string[] = [];
		const turso = new Map<string, number>();
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			const base = decodeURIComponent(String(url).split("/databases/")[1] ?? "");
			if (init?.method !== "DELETE" || !String(url).startsWith("https://api.turso.tech/")) {
				throw new Error(`petición inesperada: ${init?.method} ${url}`);
			}
			borradasEnTurso.push(base);
			const status = turso.get(base) ?? 200;
			return new Response(JSON.stringify({ database: base }), { status });
		});

		const env = {
			ADMIN_API_TOKEN: TOKEN,
			LICENSE_STORE_KEY: STORE_KEY,
			TURSO_DATABASE_URL: "libsql://central.turso.io",
			TURSO_AUTH_TOKEN: "token-central",
			TURSO_PLATFORM_TOKEN: "token-de-plataforma",
			TURSO_ORG_SLUG: "org",
		} as unknown as Parameters<typeof adminRoutes.fetch>[1];

		return fn({
			borradasEnTurso,
			turso,
			post: async (ruta, cuerpo) =>
				await adminRoutes.fetch(
					new Request(`https://api${ruta}`, {
						method: "POST",
						headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
						body: JSON.stringify(cuerpo ?? {}),
					}),
					env,
				),
			async negocio(origen, correo, tenantId) {
				const { license } = await issueLicense(db, {
					claves: STORE_KEY,
					termMonths: 12,
					origin: origen,
					customerEmail: correo,
				});
				if (tenantId) {
					sql.exec(`INSERT OR IGNORE INTO tenants (tenant_id) VALUES (?);`, tenantId);
					sql.exec(
						`INSERT OR IGNORE INTO tenant_databases (tenant_id, turso_db_name, turso_url)
						 VALUES (?, ?, ?);`,
						tenantId,
						`tpv-${tenantId}`,
						`libsql://tpv-${tenantId}.turso.io`,
					);
					await activateLicenseFirstTime(db, {
						licenseId: license.license_id,
						tenantId,
						deviceId: `equipo-${license.license_id}`,
						termMonths: 12,
					});
				}
				return license.license_id;
			},
			estadoDelNegocio: (tenantId) =>
				sql.exec(`SELECT status FROM tenants WHERE tenant_id = ?;`, tenantId).toArray()[0]?.status ?? null,
			tieneBase: (tenantId) =>
				sql.exec(`SELECT 1 FROM tenant_databases WHERE tenant_id = ?;`, tenantId).toArray().length > 0,
			estadoDeLicencia: async (licenseId) => (await getLicenseById(db, licenseId))!.status,
		});
	});
}

describe("admin · retirar los negocios de pruebas del E2E", () => {
	it("borra la base y el negocio de las licencias de pruebas, y anula las licencias", async () => {
		await escenario(async (e) => {
			const deTanda = await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-tanda");
			// Las que emitía el E2E antes de la marca: manuales, con su correo.
			const antigua = await e.negocio("manual", CORREO_DE_PRUEBAS, "t-antigua");
			const sinActivar = await e.negocio("pruebas", CORREO_DE_PRUEBAS);

			const res = await e.post("/pruebas/retirar");
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true, negocios: 2, bases: 2, licencias: 3, fallos: [] });

			expect(e.borradasEnTurso.sort()).toEqual(["tpv-t-antigua", "tpv-t-tanda"]);
			for (const t of ["t-tanda", "t-antigua"]) {
				expect(e.estadoDelNegocio(t)).toBe("deleted");
				expect(e.tieneBase(t)).toBe(false);
			}
			for (const id of [deTanda, antigua, sinActivar]) {
				expect(await e.estadoDeLicencia(id)).toBe("revoked");
			}
		});
	});

	it("no toca un negocio de verdad, ni uno que tenga además una licencia de verdad", async () => {
		await escenario(async (e) => {
			const deVerdad = await e.negocio("manual", "bar@ejemplo.test", "t-bar");
			const deStripe = await e.negocio("stripe", CORREO_DE_PRUEBAS, "t-stripe");
			// Un negocio de verdad al que se le sumó una clave de pruebas.
			const mezclaDeVerdad = await e.negocio("stripe", "otro@ejemplo.test", "t-mezcla");
			const mezclaDePruebas = await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-mezcla");

			const res = await e.post("/pruebas/retirar");
			expect(await res.json()).toMatchObject({ negocios: 0, bases: 0, licencias: 0 });

			expect(e.borradasEnTurso).toEqual([]);
			for (const t of ["t-bar", "t-stripe", "t-mezcla"]) {
				expect(e.estadoDelNegocio(t)).toBe("active");
				expect(e.tieneBase(t)).toBe(true);
			}
			for (const id of [deVerdad, deStripe, mezclaDeVerdad, mezclaDePruebas]) {
				expect(await e.estadoDeLicencia(id)).toBe("active");
			}
		});
	});

	it("si Turso falla, el negocio se queda como estaba y el siguiente intento lo retira", async () => {
		await escenario(async (e) => {
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-uno");
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-dos");
			e.turso.set("tpv-t-uno", 503);

			const primero = (await (await e.post("/pruebas/retirar")).json()) as any;
			expect(primero).toMatchObject({ negocios: 1, bases: 1 });
			expect(primero.fallos).toHaveLength(1);
			expect(primero.fallos[0].tenantId).toBe("t-uno");
			expect(e.tieneBase("t-uno")).toBe(true);
			expect(e.estadoDelNegocio("t-uno")).toBe("active");

			e.turso.delete("tpv-t-uno");
			e.borradasEnTurso.length = 0;
			const segundo = await (await e.post("/pruebas/retirar")).json();
			expect(segundo).toMatchObject({ negocios: 1, bases: 1, fallos: [] });
			expect(e.borradasEnTurso).toEqual(["tpv-t-uno"]);
			expect(e.estadoDelNegocio("t-uno")).toBe("deleted");
		});
	});

	it("una base que ya no existe en Turso cuenta como retirada, y repetir no hace nada", async () => {
		await escenario(async (e) => {
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-ya-borrada");
			e.turso.set("tpv-t-ya-borrada", 404);

			expect(await (await e.post("/pruebas/retirar")).json()).toMatchObject({ negocios: 1, bases: 0 });
			expect(e.estadoDelNegocio("t-ya-borrada")).toBe("deleted");

			e.borradasEnTurso.length = 0;
			expect(await (await e.post("/pruebas/retirar")).json()).toMatchObject({
				negocios: 0,
				bases: 0,
				licencias: 0,
			});
			expect(e.borradasEnTurso).toEqual([]);
		});
	});

	it("emitir con `pruebas: true` deja la licencia marcada como de pruebas", async () => {
		await escenario(async (e) => {
			const res = await e.post("/licenses", { termMonths: 12, email: CORREO_DE_PRUEBAS, pruebas: true });
			const { licenseId } = (await res.json()) as { licenseId: string };
			expect((await getLicenseById(dbDePruebas as any, licenseId))!.origin).toBe("pruebas");

			const normal = await e.post("/licenses", { termMonths: 12, email: "bar@ejemplo.test" });
			const { licenseId: otra } = (await normal.json()) as { licenseId: string };
			expect((await getLicenseById(dbDePruebas as any, otra))!.origin).toBe("manual");
		});
	});
});
