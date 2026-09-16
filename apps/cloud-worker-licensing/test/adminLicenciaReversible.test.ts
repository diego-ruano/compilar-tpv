// test/adminLicenciaReversible.test.ts
//
// Los endpoints de administración que mueven la vigencia de una licencia a mano:
//
//   POST /v1/admin/licenses/:id/revoke    → anula (y le corta el socket a la Main)
//   POST /v1/admin/licenses/:id/unrevoke  → deshace una revocación
//   POST /v1/admin/licenses/:id/shorten   → resta meses (puede dejarla caducada)
//
// Las operaciones de fondo (`reactivateLicense`, `shortenLicense`) ya existían desde LIC-07, pero
// sólo las alcanzaba el webhook de Stripe: no había forma de deshacer a mano una revocación hecha
// a mano. Lo que se prueba aquí es la capa de ruta —quién contesta qué— porque es donde estaba
// todo lo nuevo: los códigos de conflicto, que el estado al que se vuelve no se invente nada, y el
// aviso al `TenantHub` que hace que anular surta efecto en segundos y no en seis horas.
//
// Corre contra el esquema real del control-plane sobre el SQLite del Durable Object, igual que
// `stripeReversal.test.ts`.

import { describe, it, expect, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import { verifyInternalWorkerRequest } from "../src/lib/internalAuth";
import {
	activateLicenseFirstTime,
	getLicenseById,
	issueLicense,
	revokeLicense,
	type LicenseRow,
} from "../src/server/licenseStore";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const TOKEN = "token-de-pruebas";
const JWT_SECRET = "secreto-interno-de-pruebas";

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

/** Una llamada que la ruta le hizo al `TenantHub`, tal cual salió. */
type LlamadaAlHub = { nombreDO: string; request: Request; rawBody: string };

type Escenario = {
	/** Golpea una ruta de admin con el token bueno. */
	post: (ruta: string, cuerpo?: unknown) => Promise<Response>;
	emitir: () => Promise<LicenseRow>;
	activar: (licenseId: string) => Promise<void>;
	leer: (licenseId: string) => Promise<LicenseRow>;
	/** Lo que la ruta le mandó al Durable Object, en orden. */
	llamadasAlHub: LlamadaAlHub[];
	/** Hace que el DO reviente, para comprobar que anular no depende de que conteste. */
	romperElHub: () => void;
	db: never;
};

/**
 * Un `TenantHub` de mentira que anota lo que le llega.
 *
 * No se puede usar el binding de verdad: `enElHub` ya está *dentro* de un Durable Object y lo que
 * interesa comprobar no es lo que el DO hace con el aviso (eso es cosa suya y de sus tests) sino
 * que la ruta se lo manda —al DO correcto, en la ruta correcta y con la firma correcta—, que es lo
 * único que puede romperse desde aquí sin que nadie se entere.
 */
function hubDeMentira() {
	const llamadas: LlamadaAlHub[] = [];
	let roto = false;

	const ns = {
		idFromName: (nombre: string) => ({ nombre }),
		get: ({ nombre }: { nombre: string }) => ({
			fetch: async (url: string, init: RequestInit) => {
				if (roto) throw new Error("el DO no contesta");
				const request = new Request(url, init);
				llamadas.push({ nombreDO: nombre, request, rawBody: String(init.body ?? "") });
				return new Response("OK", { status: 200 });
			},
		}),
	} as unknown as DurableObjectNamespace;

	return { ns, llamadas, romper: () => (roto = true) };
}

/**
 * Un único Durable Object para todos los casos, limpiando filas entre ellos: las tablas se crean
 * una vez, a partir del esquema de producción (`helpers/planoDeControl.ts`).
 */
async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub("admin-reversible", async (hub: any) => {
		const db = clienteSobre(hub.state.storage.sql);
		dbDePruebas = db;
		prepararPlanoDeControl(hub.state.storage.sql);
		for (const tabla of ["licenses", "license_payments", "admin_audit"]) {
			hub.state.storage.sql.exec(`DELETE FROM ${tabla};`);
		}

		// El `Env` que ven las rutas: el token de admin y una `getDb` que devuelve este SQLite.
		const hubFalso = hubDeMentira();
		const env = {
			ADMIN_API_TOKEN: TOKEN,
			LICENSE_STORE_KEY: STORE_KEY,
			LICENSE_JWT_SECRET: JWT_SECRET,
			TenantHub: hubFalso.ns,
		} as unknown as Parameters<typeof adminRoutes.fetch>[1];

		const e: Escenario = {
			db: db as never,
			llamadasAlHub: hubFalso.llamadas,
			romperElHub: hubFalso.romper,
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

describe("admin · anular corta el socket de la Main", () => {
	// Por qué existe esto: el TPV pregunta por su licencia cada 6 horas (job `licencia`), y en la
	// aplicación no hay ningún botón de "comprueba ahora" mientras todo va bien. Así que anular una
	// licencia dejaba al equipo vendiendo hasta medio día con ella ya muerta.
	//
	// Lo que lo arregla NO es un mensaje nuevo del Durable Object: es cerrarle el socket. El cliente
	// reconecta a los 3 s, `/v1/ws/ticket` le contesta 403 y `useMainSocket` traduce ese rechazo en
	// un `license_check_now`, que emite `license:changed` y tapa la aplicación. La pieza frágil, y
	// por tanto lo que se fija aquí, es que el aviso salga bien formado: al DO del tenant correcto,
	// a `/internal/revoke`, con el `deviceId` de la Main y con la firma que ese endpoint verifica.

	it("avisa al TenantHub del tenant, firmado y con el dispositivo de la Main", async () => {
		await escenario(async (e) => {
			const lic = await e.emitir();
			await e.activar(lic.license_id);

			const res = await e.post(`/licenses/${lic.license_id}/revoke`);
			expect(res.status).toBe(200);

			expect(e.llamadasAlHub).toHaveLength(1);
			const [llamada] = e.llamadasAlHub;

			// El DO se direcciona por `tenantId`: uno distinto sería avisar a otro negocio.
			expect(llamada.nombreDO).toBe("tenant-1");
			expect(new URL(llamada.request.url).pathname).toBe("/internal/revoke");
			expect(JSON.parse(llamada.rawBody)).toEqual({ deviceId: "device-main" });

			// Y la firma tiene que pasar el MISMO verificador que corre en el DO. Comprobar que
			// los headers "están" no prueba nada: el payload firmado incluye el método, el
			// pathname y el cuerpo, así que basta desalinear cualquiera de los tres para que el
			// DO conteste 401 y el corte no ocurra — en silencio, porque es best-effort.
			await expect(
				verifyInternalWorkerRequest(llamada.request, JWT_SECRET, llamada.rawBody),
			).resolves.toBeUndefined();
		});
	});

	it("una licencia que nunca se activó no avisa a nadie", async () => {
		// Sin activar no hay tenant ni `main_device_id`: el aviso iría a un DO inventado.
		await escenario(async (e) => {
			const lic = await e.emitir();

			const res = await e.post(`/licenses/${lic.license_id}/revoke`);

			expect(res.status).toBe(200);
			expect(e.llamadasAlHub).toHaveLength(0);
		});
	});

	it("si el DO no contesta, la licencia se anula igual", async () => {
		// Es best-effort a propósito, y tiene que serlo: lo que manda es el control-plane, y esto
		// sólo adelanta el momento en que el equipo se entera. Que un DO caído pudiera impedir
		// anular una licencia sería cambiar un retraso por una operación que no se puede hacer.
		await escenario(async (e) => {
			const lic = await e.emitir();
			await e.activar(lic.license_id);
			e.romperElHub();

			const res = await e.post(`/licenses/${lic.license_id}/revoke`);

			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true, status: "revoked" });
			expect((await e.leer(lic.license_id)).status).toBe("revoked");
		});
	});

	it("404 si el id no existe, y sin tocar el hub", async () => {
		await escenario(async (e) => {
			const res = await e.post("/licenses/no-existe/revoke");

			expect(res.status).toBe(404);
			expect(e.llamadasAlHub).toHaveLength(0);
		});
	});
});

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
