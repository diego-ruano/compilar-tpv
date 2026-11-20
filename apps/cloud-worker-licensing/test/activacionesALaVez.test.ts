// test/activacionesALaVez.test.ts
//
// AUD-09 · Activar la misma clave varias veces a la vez, o reintentarlo tras un fallo, no estrena
// un negocio por petición.
//
// La primera activación crea el negocio y su base en el TenantHub ANTES de apuntar la licencia (la
// base va antes, DO-PERDIDA). El negocio salía de cada petición (`crypto.randomUUID()`): en una
// ráfaga ganaba una y las demás contestaban 409, pero cada una había dejado su negocio, su fila de
// equipo y su TenantHub aprovisionado, que ninguna licencia apuntaba ni nada borraba. Y cada
// reintento tras un fallo a medias, otro más.
//
// Ahora el negocio se reserva en la licencia en una sola sentencia antes de crear nada
// (`reservarNegocioDeLaClave`), y el equipo y los datos del negocio esperan a ganarla. Aquí, por la
// ruta entera, con la base central sobre el SQLite de un Durable Object y las bases de los negocios
// en sus TenantHub de verdad:
//
//   · cinco activaciones simultáneas de la misma clave: una gana, cuatro reciben 409, y sólo hay un
//     negocio y un objeto aprovisionado, sin filas de equipo de las perdedoras;
//   · un fallo después de crear la base deja la clave sin estrenar y con su negocio reservado, y el
//     reintento —del mismo equipo o de otro— vuelve a ese negocio y a esa base;
//   · reservar no es nacer: la base de un negocio reservado se puede crear, y no se toma por perdida;
//   · una clave reservada que se canjea suelta su negocio.

import { env as entorno } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { activacionFirmada, clavePublica } from "./helpers/activar";
import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

/** La conexión del test en curso; la lee el `getDb` simulado. */
let clienteActual: any = null;
/** Los negocios cuya base ha pedido crear la activación, en orden. La base es la de verdad. */
let basesPedidas: string[] = [];
/** La próxima activación se corta justo DESPUÉS de crear la base. */
let cortarTrasAprovisionar = false;

vi.mock("../src/server/db", async (original) => ({
	...(await (original as any)()),
	getDb: () => clienteActual,
}));

vi.mock("../src/domains/licensing/licensing.helpers", async (original) => {
	const real = (await (original as any)()) as typeof import("../src/domains/licensing/licensing.helpers");
	return {
		...real,
		// La de verdad (su TenantHub), apuntando a qué negocio se le pide.
		provisionTenantDatabase: async (db: any, env: any, tenantId: string) => {
			basesPedidas.push(tenantId);
			const r = await real.provisionTenantDatabase(db, env, tenantId);
			if (cortarTrasAprovisionar) {
				cortarTrasAprovisionar = false;
				throw new Error("corte_tras_aprovisionar");
			}
			return r;
		},
	};
});

const { licenseRoutes } = await import("../src/domains/licensing/licensing.routes");
const { generateLicenseKey, licenseKeyHash } = await import("../src/domains/licensing/licenseKey");
const { canjearLicencia, eraLaMainDeOtroNegocio, reservarNegocioDeLaClave } = await import(
	"../src/server/licenseStore"
);

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
	...(entorno as any),
	LICENSE_STORE_KEY: STORE_KEY,
	LICENSE_JWT_SECRET: "secreto-de-pruebas-con-longitud-suficiente-32",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
	TURSO_DATABASE_URL: "libsql://pruebas",
	TURSO_AUTH_TOKEN: "t",
	// El limitador por IP de las rutas anónimas no es lo que se prueba: todas llegan desde la misma.
	LIMITADOR_LICENCIA: undefined,
};
const CTX = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {}, props: {} } as any;

const DIA = 24 * 60 * 60 * 1000;

const stub = (tenantId: string) => (entorno as any).TenantHub.get((entorno as any).TenantHub.idFromName(tenantId));

type Ctx = {
	sql: any;
	db: any;
	/** Una clave sin estrenar: su texto y su id. */
	emitir: () => Promise<{ clave: string; id: string }>;
	activar: (
		clave: string,
		deviceId: string,
		pub: string,
		extra?: Record<string, unknown>,
	) => Promise<{ status: number; body: any }>;
	licencia: (id: string) => any;
	filas: (sql: string, ...args: unknown[]) => any[];
};

/** La base central en el SQLite de un Durable Object propio del test (`nombre`). */
async function escenario<T>(nombre: string, prueba: (c: Ctx) => Promise<T>): Promise<T> {
	return enElHub(`aud09-central-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const t of ["licenses", "license_payments", "tenants", "devices"]) sql.exec(`DELETE FROM ${t};`);
		const db = clienteSobre(sql, hub.state.storage);
		clienteActual = db;
		let n = 0;
		const c: Ctx = {
			sql,
			db,
			async emitir() {
				const clave = generateLicenseKey();
				const id = `lic-${nombre}-${++n}`;
				sql.exec(
					`INSERT INTO licenses (license_id, license_key_hash, status, disabled, plan, term_months, origin,
					   issued_at_ms, customer_email, created_at_ms, updated_at_ms)
					 VALUES (?, ?, 'issued', 0, 'standard', 12, 'stripe', ?, 'bar@ejemplo.test', ?, ?);`,
					id,
					await licenseKeyHash(clave),
					Date.now(),
					Date.now(),
					Date.now(),
				);
				return { clave, id };
			},
			async activar(clave, deviceId, pub, extra = {}) {
				const res = await licenseRoutes.request(
					"/activate",
					await activacionFirmada({ activationKey: clave, deviceId, devicePubKey: pub, ...extra }),
					ENV,
					CTX,
				);
				// Un fallo sin capturar sale como el texto de Hono, no como JSON.
				return { status: res.status, body: await res.json().catch(() => null) };
			},
			licencia: (id) =>
				sql
					.exec(`SELECT status, tenant_id, main_device_id, activated_at_ms FROM licenses WHERE license_id = ?;`, id)
					.toArray()[0],
			filas: (q, ...args) => sql.exec(q, ...args).toArray(),
		};
		return prueba(c);
	});
}

/**
 * El cliente de la base central, pero las `n` primeras lecturas de la licencia por su clave no
 * vuelven hasta que han llegado todas: las `n` activaciones la leen sin estrenar antes de que
 * ninguna escriba nada. Es la carrera de verdad, montada desde la ruta.
 */
function conBarrera(db: any, n: number) {
	let llegadas = 0;
	let soltar!: () => void;
	const todas = new Promise<void>((r) => (soltar = r));
	return {
		...db,
		async execute(q: any) {
			const r = await db.execute(q);
			const texto = String(typeof q === "string" ? q : q.sql);
			if (llegadas < n && /FROM licenses WHERE license_key_hash/.test(texto)) {
				if (++llegadas === n) soltar();
				await todas;
			}
			return r;
		},
	} as any;
}

/** El mismo cliente, pero la primera sentencia que case con `patron` revienta. */
function conCorte(db: any, patron: RegExp) {
	let pendiente = true;
	return {
		...db,
		async execute(q: any) {
			const texto = String(typeof q === "string" ? q : q.sql);
			if (pendiente && patron.test(texto)) {
				pendiente = false;
				throw new Error("corte_simulado");
			}
			return db.execute(q);
		},
	} as any;
}

beforeEach(() => {
	clienteActual = null;
	basesPedidas = [];
	cortarTrasAprovisionar = false;
});

describe("AUD-09 · cinco activaciones simultáneas de la misma clave", () => {
	it("una gana, cuatro reciben 409, y sólo hay un negocio y un objeto aprovisionado", async () => {
		const tenantId = await escenario("rafaga", async (c) => {
			const k = await c.emitir();
			const equipos = await Promise.all(
				[0, 1, 2, 3, 4].map(async (i) => ({ id: `equipo-${i}`, pub: await clavePublica(0x60 + i) })),
			);
			clienteActual = conBarrera(c.db, equipos.length);

			const respuestas = await Promise.all(
				equipos.map((e, i) => c.activar(k.clave, e.id, e.pub, { tenantInfo: { displayName: `Bar ${i}` } })),
			);
			clienteActual = c.db;

			const ganadoras = respuestas.filter((r) => r.status === 200);
			const perdedoras = respuestas.filter((r) => r.status !== 200);
			expect(ganadoras).toHaveLength(1);
			expect(perdedoras.map((r) => [r.status, r.body?.error])).toEqual(
				Array(4).fill([409, "device_replaced"]),
			);
			// Ninguna perdedora se lleva credenciales.
			for (const r of perdedoras) {
				expect(r.body.token).toBeUndefined();
				expect(r.body.fieldDek).toBeUndefined();
			}

			const ganadora = ganadoras[0].body;
			const ganador = equipos[respuestas.indexOf(ganadoras[0])];
			const tenantId = ganadora.tenantId;

			// Todas pidieron la base del MISMO negocio: un solo objeto, aprovisionado.
			expect(basesPedidas).toHaveLength(5);
			expect(new Set(basesPedidas)).toEqual(new Set([tenantId]));
			expect(await stub(tenantId).estaAprovisionado()).toBe(true);

			// Un negocio, con los datos de la ganadora; la licencia, suya.
			expect(c.filas(`SELECT tenant_id, display_name FROM tenants;`)).toEqual([
				{ tenant_id: tenantId, display_name: `Bar ${respuestas.indexOf(ganadoras[0])}` },
			]);
			expect(c.licencia(k.id)).toMatchObject({ status: "active", tenant_id: tenantId, main_device_id: ganador.id });
			// Y sólo la fila de su equipo: las perdedoras no han escrito la suya en su negocio.
			expect(c.filas(`SELECT device_id, tenant_id, role FROM devices;`)).toEqual([
				{ device_id: ganador.id, tenant_id: tenantId, role: "tpv" },
			]);
			return tenantId as string;
		});

		// Las cinco altas fueron al mismo objeto a la vez, y su alta es idempotente: un administrador.
		const usuarios = await enElHub(tenantId, (hub: any) =>
			Number(hub.state.storage.sql.exec("SELECT COUNT(*) AS n FROM Usuarios;").toArray()[0].n),
		);
		expect(usuarios).toBe(1);
	});

	it("el doble envío del mismo equipo acaba con su fila en el negocio de la licencia", async () => {
		// Antes, la fila del equipo se quedaba en el negocio de la última petición que la mudaba, que
		// podía ser el de una perdedora, hasta que `/status` la devolvía (`readmitirMain`).
		await escenario("doble-envio", async (c) => {
			const k = await c.emitir();
			const pub = await clavePublica(0x70);
			clienteActual = conBarrera(c.db, 3);

			const respuestas = await Promise.all([0, 1, 2].map(() => c.activar(k.clave, "equipo-unico", pub)));
			clienteActual = c.db;

			expect(respuestas.map((r) => r.status).sort()).toEqual([200, 409, 409]);
			const tenantId = respuestas.find((r) => r.status === 200)!.body.tenantId;
			expect(new Set(basesPedidas)).toEqual(new Set([tenantId]));
			expect(c.filas(`SELECT COUNT(*) AS n FROM tenants;`)[0].n).toBe(1);
			expect(c.filas(`SELECT tenant_id FROM devices WHERE device_id = 'equipo-unico';`)).toEqual([
				{ tenant_id: tenantId },
			]);
		});
	});
});

describe("AUD-09 · el reintento tras un fallo vuelve al mismo negocio", () => {
	const casos = [
		{
			como: "justo después de crear la base",
			id: "tras-base",
			preparar: () => void (cortarTrasAprovisionar = true),
			fallo: [500, "tenant_db_provision_failed"],
		},
		{
			como: "al apuntar la licencia",
			id: "al-apuntar",
			preparar: (c: Ctx) => void (clienteActual = conCorte(c.db, /UPDATE licenses\s+SET status='active'/)),
			fallo: [500, undefined],
		},
	] as const;

	for (const caso of casos) {
		for (const quien of ["el mismo equipo", "otro equipo"] as const) {
			it(`si falla ${caso.como} y reintenta ${quien}`, async () => {
				await escenario(`${caso.id}-${quien === "el mismo equipo" ? "mismo" : "otro"}`, async (c) => {
					const k = await c.emitir();
					const primero = { id: "equipo-que-falla", pub: await clavePublica(0x71) };
					const segundo = quien === "el mismo equipo" ? primero : { id: "equipo-de-recambio", pub: await clavePublica(0x72) };

					caso.preparar(c);
					const cortada = await c.activar(k.clave, primero.id, primero.pub);
					clienteActual = c.db;
					expect([cortada.status, cortada.body?.error]).toEqual(caso.fallo);

					// La clave sigue sin estrenar, con su negocio reservado y su base ya creada. Ni el
					// equipo ni el negocio sin licencia que lo reclame: sólo el reservado.
					const tras = c.licencia(k.id);
					expect(tras).toMatchObject({ status: "issued", main_device_id: null, activated_at_ms: null });
					expect(tras.tenant_id).toBeTruthy();
					expect(await stub(tras.tenant_id).estaAprovisionado()).toBe(true);
					expect(c.filas(`SELECT tenant_id FROM tenants;`)).toEqual([{ tenant_id: tras.tenant_id }]);
					expect(c.filas(`SELECT COUNT(*) AS n FROM devices;`)[0].n).toBe(0);

					const bien = await c.activar(k.clave, segundo.id, segundo.pub);
					expect(bien.status).toBe(200);
					expect(bien.body.tenantId).toBe(tras.tenant_id);
					expect(bien.body.cambioDeEquipo).toBe(false);
					expect(basesPedidas).toEqual([tras.tenant_id, tras.tenant_id]);
					expect(c.filas(`SELECT COUNT(*) AS n FROM tenants;`)[0].n).toBe(1);
					expect(c.licencia(k.id)).toMatchObject({
						status: "active",
						tenant_id: tras.tenant_id,
						main_device_id: segundo.id,
					});
				});
			});
		}
	}
});

describe("AUD-09 · reservar no es nacer", () => {
	it("la base de un negocio reservado se crea, y no se toma por perdida", async () => {
		// DO-PERDIDA: un negocio con una licencia activada y sin base es uno que la ha perdido. Uno que
		// sólo tiene reservado su negocio no ha nacido: su base se crea con la activación.
		await escenario("reservado-sin-base", async (c) => {
			const k = await c.emitir();
			const tenantId = await reservarNegocioDeLaClave(c.db, k.id, crypto.randomUUID(), Date.now());
			expect(tenantId).toBeTruthy();
			expect(await stub(tenantId!).estaAprovisionado()).toBe(false);

			const r = await c.activar(k.clave, "equipo-nuevo", await clavePublica(0x73));
			expect(r.status).toBe(200);
			expect(r.body.tenantId).toBe(tenantId);
			expect(await stub(tenantId!).estaAprovisionado()).toBe(true);
		});
	});

	it("la reserva se queda con el primer negocio y sólo vale para una clave sin estrenar", async () => {
		await escenario("reserva", async (c) => {
			const k = await c.emitir();
			const primera = await reservarNegocioDeLaClave(c.db, k.id, "negocio-a", 1);
			const segunda = await reservarNegocioDeLaClave(c.db, k.id, "negocio-b", 2);
			expect([primera, segunda]).toEqual(["negocio-a", "negocio-a"]);

			c.sql.exec(`UPDATE licenses SET status = 'active', main_device_id = 'la-main' WHERE license_id = ?;`, k.id);
			expect(await reservarNegocioDeLaClave(c.db, k.id, "negocio-c", 3)).toBeNull();

			const anulada = await c.emitir();
			c.sql.exec(`UPDATE licenses SET disabled = 1 WHERE license_id = ?;`, anulada.id);
			expect(await reservarNegocioDeLaClave(c.db, anulada.id, "negocio-d", 4)).toBeNull();
			expect(c.licencia(anulada.id).tenant_id).toBeNull();
		});
	});
});

describe("AUD-09 · una clave reservada que se canjea", () => {
	it("suelta su negocio, y el equipo que lo dejó a medias no es la Main de otro negocio", async () => {
		await escenario("canjeada", async (c) => {
			const k = await c.emitir();
			// Un estreno que se cortó después de crear la base, como lo dejaba la ruta antes de que el
			// equipo esperase a ganar la licencia: con la fila del equipo en el negocio reservado.
			const tenantId = (await reservarNegocioDeLaClave(c.db, k.id, crypto.randomUUID(), Date.now()))!;
			c.sql.exec(`INSERT INTO tenants (tenant_id, status) VALUES (?, 'active');`, tenantId);
			c.sql.exec(
				`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64) VALUES ('equipo-a-medias', ?, 'tpv', 'k');`,
				tenantId,
			);
			// No ha nacido: una clave reservada no hace de nadie la Main de ese negocio.
			expect(await eraLaMainDeOtroNegocio(c.db, "equipo-a-medias", tenantId)).toBe(false);

			// La canjea la Main de otro negocio.
			const viva = await c.emitir();
			c.sql.exec(
				`UPDATE licenses SET status = 'active', tenant_id = 'otro-negocio', main_device_id = 'otra-main',
				        activated_at_ms = ?, expires_at_ms = ? WHERE license_id = ?;`,
				Date.now(),
				Date.now() + 30 * DIA,
				viva.id,
			);
			expect(await canjearLicencia(c.db, k.id, viva.id)).toBe(true);
			expect(c.licencia(k.id)).toMatchObject({ status: "redeemed", tenant_id: null, main_device_id: null });

			// Y aunque una fila canjeada vieja conservase el negocio (antes el canje no lo soltaba),
			// tampoco: no se activó nunca.
			c.sql.exec(`UPDATE licenses SET tenant_id = ? WHERE license_id = ?;`, tenantId, k.id);
			expect(await eraLaMainDeOtroNegocio(c.db, "equipo-a-medias", tenantId)).toBe(false);

			// Con una licencia que sí se activó en ese negocio, sí lo era (AUD-06).
			c.sql.exec(
				`UPDATE licenses SET tenant_id = ?, activated_at_ms = ? WHERE license_id = ?;`,
				tenantId,
				Date.now(),
				viva.id,
			);
			expect(await eraLaMainDeOtroNegocio(c.db, "equipo-a-medias", tenantId)).toBe(true);
		});
	});
});
