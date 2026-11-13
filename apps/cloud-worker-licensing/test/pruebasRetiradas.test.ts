// test/pruebasRetiradas.test.ts
//
// POST /v1/admin/pruebas/retirar: borra los negocios que deja el E2E, con todo lo que guardan en la
// nube: la base de su TenantHub, su agenda de reservas web y sus imágenes.
//
// Es una ruta que borra bases en producción, así que lo que más importa aquí es lo que NO toca: un
// negocio con una licencia que no sea de pruebas, aunque tenga también una de pruebas, ni uno al
// que se le haya canjeado una clave de verdad, también si el canje llega mientras se retira. Corre
// contra el esquema real del control-plane sobre el SQLite de un Durable Object, como
// `adminLicenciaReversible.test.ts`. Los objetos de los negocios y el bucket son de mentira: sólo
// apuntan qué se borró. Lo que borra cada uno de verdad está en `retirarUnNegocio.test.ts`.

import { describe, expect, it, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import { CORREO_DE_PRUEBAS, NEGOCIOS_POR_LLAMADA } from "../src/domains/admin/pruebas";
import {
	activateLicenseFirstTime,
	getLicenseById,
	issueLicense,
	reactivateLicense,
	sigueSiendoLaLicenciaDelEquipo,
} from "../src/server/licenseStore";
import type { LicenseOrigin } from "../src/shared";

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const TOKEN = "token-de-pruebas";

let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

type Escenario = {
	post: (ruta: string, cuerpo?: unknown) => Promise<Response>;
	/** Emite una licencia y, si se da `tenantId`, la activa en ese negocio, que tendrá su base. */
	negocio: (origen: LicenseOrigin, correo: string, tenantId?: string) => Promise<string>;
	estadoDelNegocio: (tenantId: string) => string | null;
	tieneBase: (tenantId: string) => boolean;
	estadoDeLicencia: (licenseId: string) => Promise<string>;
	/** Las bases que se borraron, en orden. */
	borradas: string[];
	/** Los negocios cuyo TenantHub no contesta. */
	noContestan: Set<string>;
	/** Las agendas de reservas web que se borraron, en orden. */
	agendas: string[];
	/** Los negocios cuya agenda no contesta. */
	sinAgenda: Set<string>;
	/** Las claves que hay en el bucket de imágenes. */
	imagenes: Set<string>;
	/** Canjea la clave `claveId` (sin activar) sobre la licencia `sobreLicenciaId`: le suma su tiempo. */
	canjear: (claveId: string, sobreLicenciaId: string) => void;
	/** Algo que pasa justo después de que la ruta liste los negocios que va a retirar. */
	trasListar: (fn: () => Promise<void>) => void;
	/** Algo que pasa justo después de que la ruta anule las licencias de pruebas. */
	trasAnular: (fn: () => Promise<void>) => void;
	/** Desanula una licencia, como `/unrevoke` de la administración. */
	desanular: (licenseId: string) => Promise<void>;
	/** Algo que pasa cuando la ruta va a borrar la base de un negocio: lo último antes de lo que no se deshace. */
	alBorrarLaBase: (fn: (tenantId: string) => Promise<void>) => void;
	/**
	 * Lo que pregunta el canje dentro de su transacción, antes de gastar una clave sobre esta licencia
	 * (`/v1/license/activate`): ¿sigue siendo la licencia viva de su Main?
	 */
	admiteUnCanje: (licenseId: string) => Promise<boolean>;
};

async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub("pruebas-retiradas", async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql);
		let alListar: (() => Promise<void>) | null = null;
		let alAnular: (() => Promise<void>) | null = null;
		dbDePruebas = {
			...db,
			async execute(entrada: any) {
				const r = await db.execute(entrada);
				const texto = String(entrada?.sql ?? entrada);
				if (alListar && /SELECT DISTINCT l\.tenant_id/.test(texto)) {
					const fn = alListar;
					alListar = null;
					await fn();
				}
				if (alAnular && /UPDATE licenses SET status = 'revoked'/.test(texto)) {
					const fn = alAnular;
					alAnular = null;
					await fn();
				}
				return r;
			},
		};
		prepararPlanoDeControl(sql);
		for (const tabla of ["licenses", "tenants", "admin_audit"]) {
			sql.exec(`DELETE FROM ${tabla};`);
		}

		const conBase = new Set<string>();
		const borradas: string[] = [];
		const noContestan = new Set<string>();
		let alBorrar: ((tenantId: string) => Promise<void>) | null = null;
		const TenantHub = {
			idFromName: (nombre: string) => nombre,
			get: (tenantId: string) => ({
				async borrarTodo() {
					await alBorrar?.(tenantId);
					if (noContestan.has(tenantId)) throw new Error("el TenantHub no contesta");
					borradas.push(tenantId);
					conBase.delete(tenantId);
				},
			}),
		};

		const agendas: string[] = [];
		const sinAgenda = new Set<string>();
		const AgendaWeb = {
			idFromName: (nombre: string) => nombre,
			get: (tenantId: string) => ({
				async borrarTodo() {
					if (sinAgenda.has(tenantId)) throw new Error("la agenda no contesta");
					agendas.push(tenantId);
				},
			}),
		};
		const imagenes = new Set<string>();
		const IMAGES = {
			async list({ prefix }: { prefix: string }) {
				const objects = [...imagenes].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key }));
				return { objects, truncated: false };
			},
			async delete(claves: string[]) {
				for (const k of claves) imagenes.delete(k);
			},
		};

		const env = {
			ADMIN_API_TOKEN: TOKEN,
			LICENSE_STORE_KEY: STORE_KEY,
			TURSO_DATABASE_URL: "libsql://central.turso.io",
			TURSO_AUTH_TOKEN: "token-central",
			TenantHub,
			AgendaWeb,
			IMAGES,
		} as unknown as Parameters<typeof adminRoutes.fetch>[1];

		return fn({
			borradas,
			noContestan,
			agendas,
			sinAgenda,
			imagenes,
			canjear: (claveId, sobreLicenciaId) => {
				sql.exec(
					`UPDATE licenses SET status = 'redeemed', redeemed_into_license_id = ? WHERE license_id = ?;`,
					sobreLicenciaId,
					claveId,
				);
			},
			trasListar: (fn) => {
				alListar = fn;
			},
			trasAnular: (fn) => {
				alAnular = fn;
			},
			desanular: (licenseId) => reactivateLicense(db, licenseId),
			alBorrarLaBase: (fn) => {
				alBorrar = fn;
			},
			// El equipo con el que `negocio` activa cada licencia.
			admiteUnCanje: (licenseId) => sigueSiendoLaLicenciaDelEquipo(db, licenseId, `equipo-${licenseId}`),
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
					conBase.add(tenantId);
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
			tieneBase: (tenantId) => conBase.has(tenantId),
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
			expect(await res.json()).toMatchObject({ ok: true, negocios: 2, bases: 2, licencias: 3, fallos: [], quedan: false });

			expect(e.borradas.sort()).toEqual(["t-antigua", "t-tanda"]);
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

			expect(e.borradas).toEqual([]);
			for (const t of ["t-bar", "t-stripe", "t-mezcla"]) {
				expect(e.estadoDelNegocio(t)).toBe("active");
				expect(e.tieneBase(t)).toBe(true);
			}
			for (const id of [deVerdad, deStripe, mezclaDeVerdad, mezclaDePruebas]) {
				expect(await e.estadoDeLicencia(id)).toBe("active");
			}
		});
	});

	it("un negocio de pruebas al que se le canjeó una clave de verdad no se toca", async () => {
		// Una clave canjeada no lleva negocio: le suma su tiempo a la licencia que apunta (REV-13). Con
		// mirar sólo las licencias del negocio, éste parecía de pruebas y se borraba con tiempo pagado.
		await escenario(async (e) => {
			const dePruebas = await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-con-canje");
			const comprada = await e.negocio("stripe", "cliente@ejemplo.test");
			e.canjear(comprada, dePruebas);
			e.imagenes.add("t-con-canje/images/logo/logo.png");
			// Y uno de pruebas al que se le canjeó otra clave de pruebas: ése sí se retira.
			const otra = await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-canje-de-pruebas");
			const claveDePruebas = await e.negocio("pruebas", CORREO_DE_PRUEBAS);
			e.canjear(claveDePruebas, otra);

			const res = await e.post("/pruebas/retirar");
			expect(await res.json()).toMatchObject({ negocios: 1, bases: 1, fallos: [] });

			expect(e.borradas).toEqual(["t-canje-de-pruebas"]);
			expect(e.agendas).toEqual(["t-canje-de-pruebas"]);
			expect(e.estadoDelNegocio("t-con-canje")).toBe("active");
			expect(e.tieneBase("t-con-canje")).toBe(true);
			expect([...e.imagenes]).toEqual(["t-con-canje/images/logo/logo.png"]);
			expect(await e.estadoDeLicencia(dePruebas)).toBe("active");
			expect(await e.estadoDeLicencia(comprada)).toBe("redeemed");
		});
	});

	it("si recibe una licencia de verdad entre la lista y su turno, ya no se toca", async () => {
		await escenario(async (e) => {
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-a");
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-b");
			e.imagenes.add("t-b/images/productos/p.jpg");
			e.trasListar(async () => {
				await e.negocio("stripe", "cliente@ejemplo.test", "t-b");
			});

			const res = await e.post("/pruebas/retirar");
			expect(await res.json()).toMatchObject({ negocios: 1, bases: 1, fallos: [] });

			expect(e.borradas).toEqual(["t-a"]);
			expect(e.agendas).toEqual(["t-a"]);
			expect(e.estadoDelNegocio("t-b")).toBe("active");
			expect(e.tieneBase("t-b")).toBe(true);
			expect([...e.imagenes]).toEqual(["t-b/images/productos/p.jpg"]);
		});
	});

	it("si se le canjea una clave de verdad entre la lista y la anulación, ni se anula su licencia ni se toca", async () => {
		await escenario(async (e) => {
			const dePruebas = await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-canje-a-tiempo");
			const comprada = await e.negocio("stripe", "cliente@ejemplo.test");
			e.trasListar(async () => e.canjear(comprada, dePruebas));

			const res = await e.post("/pruebas/retirar");
			expect(await res.json()).toMatchObject({ negocios: 0, bases: 0, licencias: 0, fallos: [] });

			expect(e.borradas).toEqual([]);
			expect(e.estadoDelNegocio("t-canje-a-tiempo")).toBe("active");
			expect(e.tieneBase("t-canje-a-tiempo")).toBe(true);
			expect(await e.estadoDeLicencia(dePruebas)).toBe("active");
			expect(await e.admiteUnCanje(dePruebas)).toBe(true);
		});
	});

	it("cuando llega a borrar la base, la licencia ya está anulada: una clave de verdad ya no se canjea sobre ella", async () => {
		// Entre volver a mirar el negocio y borrar su base cabía un canje: el negocio se quedaba con
		// tiempo pagado y sin sus datos. El canje pregunta por la licencia dentro de su transacción
		// (AUD-01), así que con la licencia anulada antes de mirar no hay canje que entre después.
		await escenario(async (e) => {
			const dePruebas = await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-carrera");
			const comprada = await e.negocio("stripe", "cliente@ejemplo.test");
			expect(await e.admiteUnCanje(dePruebas)).toBe(true);

			const alBorrar: { tenantId: string; licencia: string; admiteUnCanje: boolean }[] = [];
			e.alBorrarLaBase(async (tenantId) => {
				alBorrar.push({
					tenantId,
					licencia: await e.estadoDeLicencia(dePruebas),
					admiteUnCanje: await e.admiteUnCanje(dePruebas),
				});
			});

			const res = await e.post("/pruebas/retirar");
			expect(await res.json()).toMatchObject({ negocios: 1, bases: 1, licencias: 1, fallos: [] });

			expect(alBorrar).toEqual([{ tenantId: "t-carrera", licencia: "revoked", admiteUnCanje: false }]);
			// La clave de verdad sigue sin gastar.
			expect(await e.estadoDeLicencia(comprada)).toBe("issued");
		});
	});

	it("si alguien desanula su licencia entre la anulación y su turno, no se borra; la siguiente llamada lo retira", async () => {
		// Con una licencia viva otra vez, sobre el negocio cabe un canje: no es momento de borrarlo.
		await escenario(async (e) => {
			const licencia = await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-desanulado");
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-otro");
			e.imagenes.add("t-desanulado/images/logo/logo.png");
			e.trasAnular(() => e.desanular(licencia));

			const primero = await (await e.post("/pruebas/retirar")).json();
			expect(primero).toMatchObject({ negocios: 1, bases: 1, licencias: 2, fallos: [] });
			expect(e.borradas).toEqual(["t-otro"]);
			expect(e.estadoDelNegocio("t-desanulado")).toBe("active");
			expect(e.tieneBase("t-desanulado")).toBe(true);
			expect(e.imagenes.size).toBe(1);
			expect(await e.estadoDeLicencia(licencia)).toBe("active");

			const segundo = await (await e.post("/pruebas/retirar")).json();
			expect(segundo).toMatchObject({ negocios: 1, bases: 1, licencias: 1, fallos: [] });
			expect(e.borradas).toEqual(["t-otro", "t-desanulado"]);
			expect(e.estadoDelNegocio("t-desanulado")).toBe("deleted");
			expect(await e.estadoDeLicencia(licencia)).toBe("revoked");
		});
	});

	it("borra también la agenda de reservas web y las imágenes del negocio, y sólo las suyas", async () => {
		await escenario(async (e) => {
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-1");
			await e.negocio("stripe", "bar@ejemplo.test", "t-10");
			for (const clave of [
				"t-1/images/productos/a.jpg",
				"t-1/images/logo/logo.png",
				// El id de un negocio de verdad empieza igual: su carpeta es otra.
				"t-10/images/productos/b.jpg",
			]) {
				e.imagenes.add(clave);
			}

			const res = await e.post("/pruebas/retirar");
			expect(await res.json()).toMatchObject({ ok: true, negocios: 1, bases: 1, imagenes: 2, fallos: [] });

			expect(e.borradas).toEqual(["t-1"]);
			expect(e.agendas).toEqual(["t-1"]);
			expect([...e.imagenes]).toEqual(["t-10/images/productos/b.jpg"]);
		});
	});

	it("si su agenda falla, el negocio no se da por borrado y el siguiente intento lo acaba", async () => {
		await escenario(async (e) => {
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-agenda");
			e.imagenes.add("t-agenda/images/logo/logo.png");
			e.sinAgenda.add("t-agenda");

			const primero = (await (await e.post("/pruebas/retirar")).json()) as any;
			expect(primero).toMatchObject({ negocios: 0, bases: 1, imagenes: 0 });
			expect(primero.fallos).toEqual([{ tenantId: "t-agenda", error: "la agenda no contesta" }]);
			expect(e.estadoDelNegocio("t-agenda")).toBe("active");
			expect(e.imagenes.size).toBe(1);

			e.sinAgenda.delete("t-agenda");
			const segundo = await (await e.post("/pruebas/retirar")).json();
			expect(segundo).toMatchObject({ negocios: 1, imagenes: 1, fallos: [] });
			expect(e.agendas).toEqual(["t-agenda"]);
			expect(e.estadoDelNegocio("t-agenda")).toBe("deleted");
			expect(e.imagenes.size).toBe(0);
		});
	});

	it("si su TenantHub falla, el negocio se queda como estaba y el siguiente intento lo retira", async () => {
		await escenario(async (e) => {
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-uno");
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-dos");
			e.noContestan.add("t-uno");

			const primero = (await (await e.post("/pruebas/retirar")).json()) as any;
			expect(primero).toMatchObject({ negocios: 1, bases: 1 });
			expect(primero.fallos).toHaveLength(1);
			expect(primero.fallos[0].tenantId).toBe("t-uno");
			expect(e.tieneBase("t-uno")).toBe(true);
			expect(e.estadoDelNegocio("t-uno")).toBe("active");

			e.noContestan.delete("t-uno");
			e.borradas.length = 0;
			const segundo = await (await e.post("/pruebas/retirar")).json();
			expect(segundo).toMatchObject({ negocios: 1, bases: 1, fallos: [] });
			expect(e.borradas).toEqual(["t-uno"]);
			expect(e.estadoDelNegocio("t-uno")).toBe("deleted");
		});
	});

	it("repetir la retirada no hace nada", async () => {
		await escenario(async (e) => {
			await e.negocio("pruebas", CORREO_DE_PRUEBAS, "t-una-vez");

			expect(await (await e.post("/pruebas/retirar")).json()).toMatchObject({ negocios: 1, bases: 1 });
			expect(e.estadoDelNegocio("t-una-vez")).toBe("deleted");

			e.borradas.length = 0;
			expect(await (await e.post("/pruebas/retirar")).json()).toMatchObject({
				negocios: 0,
				bases: 0,
				licencias: 0,
			});
			expect(e.borradas).toEqual([]);
		});
	});

	it("retira como mucho NEGOCIOS_POR_LLAMADA por llamada y dice si quedan más", async () => {
		// Cada negocio son peticiones salientes, y el Worker tiene un tope por llamada.
		await escenario(async (e) => {
			for (let i = 0; i < NEGOCIOS_POR_LLAMADA + 2; i++) {
				await e.negocio("pruebas", CORREO_DE_PRUEBAS, `t-${String(i).padStart(2, "0")}`);
			}

			const primero = await (await e.post("/pruebas/retirar")).json();
			expect(primero).toMatchObject({ negocios: NEGOCIOS_POR_LLAMADA, quedan: true });
			const segundo = await (await e.post("/pruebas/retirar")).json();
			expect(segundo).toMatchObject({ negocios: 2, quedan: false });
			expect(new Set(e.borradas).size).toBe(NEGOCIOS_POR_LLAMADA + 2);
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
