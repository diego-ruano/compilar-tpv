// test/adminLicenciaReversible.test.ts
//
// Los dos endpoints de administración que deshacen lo que `revoke` y `extend` hacen:
//
//   POST /v1/admin/licenses/:id/unrevoke  → deshace una revocación
//   POST /v1/admin/licenses/:id/shorten   → resta meses (puede dejarla caducada)
//
// Las operaciones de fondo (`reactivateLicense`, `shortenLicense`) ya existían desde LIC-07, pero
// sólo las alcanzaba el webhook de Stripe: no había forma de deshacer a mano una revocación hecha
// a mano. Lo que se prueba aquí es la capa de ruta —quién contesta qué— porque es donde estaba
// todo lo nuevo: los códigos de conflicto y que el estado al que se vuelve no se invente nada.
//
// Corre contra el esquema real del control-plane sobre el SQLite del Durable Object, igual que
// `stripeReversal.test.ts`.

import { describe, it, expect, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import {
	activateLicenseFirstTime,
	ensureLicensingSchema,
	getLicenseById,
	issueLicense,
	revokeLicense,
	type LicenseRow,
} from "../src/server/licenseStore";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const TOKEN = "token-de-pruebas";

/**
 * El cliente SQL que verán las rutas. `getDb` construye un cliente de Turso y lo cachea en una
 * variable de módulo, así que no hay por dónde inyectar: se sustituye esa única función y se deja
 * el resto del módulo (`exec`, `execMany`) intacto, que es de lo que tira `licenseStore`.
 */
let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

type Escenario = {
	/** Golpea una ruta de admin con el token bueno. */
	post: (ruta: string, cuerpo?: unknown) => Promise<Response>;
	emitir: () => Promise<LicenseRow>;
	activar: (licenseId: string) => Promise<void>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	db: never;
};

/**
 * Un único Durable Object para todos los casos, limpiando filas entre ellos: `ensureLicensingSchema`
 * recuerda por isolate que ya creó las tablas, así que un DO nuevo por test se encontraría el flag
 * puesto y la base vacía.
 */
async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub("admin-reversible", async (hub: any) => {
		const db = clienteSobre(hub.state.storage.sql);
		dbDePruebas = db;
		await ensureLicensingSchema(db);
		for (const tabla of ["licenses", "license_payments", "admin_audit"]) {
			hub.state.storage.sql.exec(`DELETE FROM ${tabla};`);
		}

		// El `Env` que ven las rutas: el token de admin y una `getDb` que devuelve este SQLite.
		// `ensureLicensingSchemaMw` vuelve a pasar por aquí y es idempotente.
		const env = {
			ADMIN_API_TOKEN: TOKEN,
			LICENSE_STORE_KEY: STORE_KEY,
		} as unknown as Parameters<typeof adminRoutes.fetch>[1];

		const e: Escenario = {
			db: db as never,
			// `Hono.fetch` está tipado como `Response | Promise<Response>`; aquí siempre es lo
			// segundo, y esperarlo deja la firma en `Promise<Response>` sin castear nada.
			post: async (ruta, cuerpo) =>
				await adminRoutes.fetch(
					new Request(`https://api${ruta}`, {
						method: "POST",
						headers: {
							authorization: `Bearer ${TOKEN}`,
							"content-type": "application/json",
						},
						body: JSON.stringify(cuerpo ?? {}),
					}),
					env,
				),
			async emitir() {
				const { license } = await issueLicense(db, {
					storeKeyB64: STORE_KEY,
					termMonths: 12,
					origin: "manual",
					customerEmail: "bar@ejemplo.test",
				});
				return license;
			},
			async activar(licenseId) {
				await activateLicenseFirstTime(db, {
					licenseId,
					tenantId: "tenant-1",
					deviceId: "device-main",
					termMonths: 12,
				});
			},
			async leer(licenseId) {
				return (await getLicenseById(db, licenseId))!;
			},
		};

		return fn(e);
	});
}

describe("admin · deshacer una revocación", () => {
	it("una licencia activada vuelve a active", async () => {
		await escenario(async (e) => {
			const lic = await e.emitir();
			await e.activar(lic.license_id);
			await revokeLicense(e.db as never, lic.license_id);

			const res = await e.post(`/licenses/${lic.license_id}/unrevoke`);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true, status: "active" });

			const despues = await e.leer(lic.license_id);
			expect(despues.status).toBe("active");
			expect(Boolean(despues.disabled)).toBe(false);
		});
	});

	it("una que nunca se activó vuelve a issued, no a active", async () => {
		// Su reloj no había arrancado: devolverla a `active` le inventaría una caducidad.
		await escenario(async (e) => {
			const lic = await e.emitir();
			await revokeLicense(e.db as never, lic.license_id);

			const res = await e.post(`/licenses/${lic.license_id}/unrevoke`);

			expect(await res.json()).toMatchObject({ ok: true, status: "issued" });
		});
	});

	it("se niega si la licencia no está revocada", async () => {
		await escenario(async (e) => {
			const lic = await e.emitir();
			await e.activar(lic.license_id);

			const res = await e.post(`/licenses/${lic.license_id}/unrevoke`);

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ ok: false, error: "license_not_revoked" });
		});
	});

	it("404 si el id no existe", async () => {
		await escenario(async (e) => {
			const res = await e.post("/licenses/no-existe/unrevoke");
			expect(res.status).toBe(404);
		});
	});
});

describe("admin · acortar la caducidad", () => {
	it("resta los meses pedidos", async () => {
		await escenario(async (e) => {
			const lic = await e.emitir();
			await e.activar(lic.license_id);
			const antes = (await e.leer(lic.license_id)).expires_at_ms!;

			const res = await e.post(`/licenses/${lic.license_id}/shorten`, { months: 3 });

			expect(res.status).toBe(200);
			const cuerpo = (await res.json()) as { expiresAt: string; caducada: boolean };
			expect(new Date(cuerpo.expiresAt).getTime()).toBeLessThan(antes);
			expect(cuerpo.caducada).toBe(false);
		});
	});

	it("puede dejarla caducada, y lo dice", async () => {
		// Es el caso por el que existe el endpoint: sin él no había forma de ensayar qué hace la
		// aplicación cuando la licencia caduca sin esperar meses de calendario.
		await escenario(async (e) => {
			const lic = await e.emitir();
			await e.activar(lic.license_id);

			const res = await e.post(`/licenses/${lic.license_id}/shorten`, { months: 24 });

			const cuerpo = (await res.json()) as { caducada: boolean; expiresAt: string };
			expect(cuerpo.caducada).toBe(true);
			expect(new Date(cuerpo.expiresAt).getTime()).toBeLessThan(Date.now());
		});
	});

	it("se niega sobre una licencia sin activar: su reloj no ha arrancado", async () => {
		await escenario(async (e) => {
			const lic = await e.emitir();

			const res = await e.post(`/licenses/${lic.license_id}/shorten`, { months: 1 });

			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ ok: false, error: "license_not_activated" });
		});
	});

	it("rechaza un número de meses que no es un entero positivo", async () => {
		await escenario(async (e) => {
			const lic = await e.emitir();
			await e.activar(lic.license_id);

			for (const months of [0, -3, 1.5, 999]) {
				const res = await e.post(`/licenses/${lic.license_id}/shorten`, { months });
				expect(res.status, `months=${months}`).toBe(400);
			}
		});
	});
});
