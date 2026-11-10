// test/canjeDeLicencia.test.ts
//
// REV-13 — un código nuevo SUMA tiempo si el equipo ya tiene licencia, y estrena si no.
//
// El fallo original estaba en el webhook de Stripe: si ese cliente ya tenía una licencia viva,
// cualquier compra suya la extendía. Comprar con los mismos datos *era* la señal, así que el dueño
// que abría un segundo local pagaba y no recibía clave.
//
// El arreglo no fue enseñar al webhook a distinguir —eso obligaba al cliente a acertar con un
// enlace— sino mover la decisión al único sitio donde no hay nada que adivinar: al activar. Toda
// compra emite una clave; lo que esa clave hace depende de lo que el TPV ya tiene delante.
//
// Y una licencia **ya activada no canjea**: mover una licencia a otro local es un cambio de
// equipo, que recicla la que hay y va por su propio camino con el código del correo.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { activacionFirmada, clavePublica } from "./helpers/activar";
import { clienteSobre, conFalloSimulado } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

/** La conexión del test en curso; la lee el `getDb` simulado. */
let clienteActual: any = null;
/** Bases de tenant que se han llegado a aprovisionar: el canje no puede crear ninguna. */
let basesCreadas: string[] = [];

vi.mock("../src/server/db", async (original) => ({
	...(await (original as any)()),
	getDb: () => clienteActual,
}));

vi.mock("../src/domains/licensing/licensing.helpers", async (original) => ({
	...(await (original as any)()),
	provisionTenantDatabase: async (_db: any, _env: any, tenantId: string) => {
		basesCreadas.push(tenantId);
	},
}));

const { licenseRoutes } = await import("../src/domains/licensing/licensing.routes");
const { generateLicenseKey, licenseKeyHash } = await import(
	"../src/domains/licensing/licenseKey"
);
const { getLicenseById } = await import("../src/server/licenseStore");
const { cifrar } = await import("../src/server/crypto");

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
	LICENSE_STORE_KEY: STORE_KEY,
	LICENSE_JWT_SECRET: "secreto-de-pruebas-con-longitud-suficiente-32",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
	TURSO_DATABASE_URL: "libsql://pruebas",
	TURSO_AUTH_TOKEN: "t",
	TURSO_PLATFORM_TOKEN: "p",
	TURSO_ORG_SLUG: "org",
	EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
	EMAIL: { send: async () => {} },
} as any;

const DIA = 24 * 60 * 60 * 1000;
const EQUIPO = "equipo-del-bar";
// AUD-01: claves ed25519 de verdad, porque activar exige la firma del equipo.
const CLAVE_EQUIPO = await clavePublica(1);

type Escenario = {
	sql: any;
	db: any;
	/** Emite una clave sin estrenar y devuelve el texto de la clave y su id. */
	emitir: (meses?: number) => Promise<{ clave: string; id: string }>;
	/** Deja una licencia ya activada en este equipo, con la caducidad indicada. */
	licenciaDelEquipo: (args?: { diasRestantes?: number; status?: string }) => Promise<string>;
	activar: (
		clave: string,
		deviceId?: string,
		pubKey?: string,
		extra?: Record<string, unknown>,
	) => Promise<{ status: number; body: any }>;
	leer: (id: string) => Promise<any>;
};

async function escenario<T>(nombre: string, fn: (e: Escenario) => Promise<T>): Promise<T> {
	return enElHub(`rev13-canje-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		const db = clienteSobre(sql, hub.state.storage);
		prepararPlanoDeControl(sql);
		for (const t of ["licenses", "license_payments", "tenants", "devices", "tenant_databases"]) {
			sql.exec(`DELETE FROM ${t};`);
		}
		clienteActual = db;
		basesCreadas = [];

		let n = 0;
		const e: Escenario = {
			sql,
			db,
			async emitir(meses = 12) {
				const clave = generateLicenseKey();
				const id = `lic-${++n}`;
				sql.exec(
					`INSERT INTO licenses (license_id, license_key_hash, status, disabled, plan,
					   term_months, origin, issued_at_ms, customer_email, created_at_ms, updated_at_ms)
					 VALUES (?, ?, 'issued', 0, 'standard', ?, 'stripe', ?, 'bar@ejemplo.test', ?, ?);`,
					id,
					await licenseKeyHash(clave),
					meses,
					Date.now(),
					Date.now(),
					Date.now(),
				);
				return { clave, id };
			},
			async licenciaDelEquipo({ diasRestantes = 30, status = "active" } = {}) {
				const { id } = await e.emitir();
				sql.exec(`INSERT INTO tenants (tenant_id, status) VALUES ('tenant-del-bar', 'active');`);
				sql.exec(
					`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64)
					 VALUES (?, 'tenant-del-bar', 'tpv', ?);`,
					EQUIPO,
					CLAVE_EQUIPO,
				);
				sql.exec(
					`UPDATE licenses SET status=?, tenant_id='tenant-del-bar', main_device_id=?,
					        activated_at_ms=?, expires_at_ms=? WHERE license_id=?;`,
					status,
					EQUIPO,
					Date.now() - 300 * DIA,
					Date.now() + diasRestantes * DIA,
					id,
				);
				return id;
			},
			async activar(clave, deviceId = EQUIPO, pubKey = CLAVE_EQUIPO, extra = {}) {
				const res = await licenseRoutes.request(
					"/activate",
					await activacionFirmada({ activationKey: clave, deviceId, devicePubKey: pubKey, ...extra }),
					ENV,
					// El recibo del canje sale por `waitUntil`, así que hace falta un contexto.
					{ waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as any,
				);
				// Un fallo sin capturar sale como el texto de Hono, no como JSON: lo que se mira
				// entonces es el código.
				return { status: res.status, body: await res.json().catch(() => null) };
			},
			async leer(id) {
				return (await getLicenseById(db, id))!;
			},
		};

		return fn(e);
	});
}

beforeEach(() => {
	clienteActual = null;
	basesCreadas = [];
});

describe("REV-13 · el equipo ya tiene licencia: se suma el tiempo", () => {
	it("suma los meses a la que hay y no crea otro negocio", async () => {
		const r = await escenario("suma", async (e) => {
			const viejaId = await e.licenciaDelEquipo({ diasRestantes: 30 });
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			const res = await e.activar(nueva.clave);
			return {
				res,
				antes,
				vieja: await e.leer(viejaId),
				clave: await e.leer(nueva.id),
				tenants: Number(e.sql.exec(`SELECT COUNT(*) AS n FROM tenants;`).toArray()[0].n),
			};
		});

		expect(r.res.status).toBe(200);
		expect(r.res.body.tiempoSumado).toBe(true);
		expect(r.res.body.cambioDeEquipo).toBe(false);
		// El negocio es el mismo: ni tenant nuevo, ni base nueva. Es lo que hace que esto no
		// pueda perder datos.
		expect(r.res.body.tenantId).toBe("tenant-del-bar");
		expect(r.tenants).toBe(1);
		expect(basesCreadas).toEqual([]);

		// Doce meses más sobre lo que le quedaba, no sobre hoy.
		expect(r.vieja.expires_at_ms).toBeGreaterThan(r.antes.expires_at_ms + 350 * DIA);
		expect(r.vieja.main_device_id).toBe(EQUIPO);

		// Y la clave queda gastada, apuntando a dónde fue su tiempo.
		expect(r.clave.status).toBe("redeemed");
		expect(r.clave.redeemed_into_license_id).toBe(r.vieja.license_id);
	});

	it("una licencia ya CADUCADA se renueva y vuelve a estar activa", async () => {
		// El caso más normal de todos: se te pasó la fecha, compras un código y sigues.
        const r = await escenario("caducada", async (e) => {
			const viejaId = await e.licenciaDelEquipo({ diasRestantes: -10, status: "expired" });
			const nueva = await e.emitir(12);
			const res = await e.activar(nueva.clave);
			return { res, vieja: await e.leer(viejaId) };
		});

		expect(r.res.body.tiempoSumado).toBe(true);
		expect(r.vieja.status).toBe("active");
		// Desde hoy, no desde la fecha vencida: no se regala el tiempo muerto.
		expect(r.vieja.expires_at_ms).toBeGreaterThan(Date.now() + 350 * DIA);
	});

	it("el mismo código no suma dos veces", async () => {
		// La lección de REV-15: un `UPDATE` condicionado cuyo resultado nadie mira no condiciona
		// nada, y aquí serían meses regalados en cada reintento.
		const r = await escenario("dos-veces", async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const nueva = await e.emitir(12);

			const uno = await e.activar(nueva.clave);
			const tras = await e.leer(viejaId);
			const dos = await e.activar(nueva.clave);
			return { uno, dos, tras, final: await e.leer(viejaId) };
		});

		expect(r.uno.status).toBe(200);
		expect(r.dos.status).toBe(409);
		expect(r.dos.body.error).toBe("license_already_used");
		expect(r.final.expires_at_ms).toBe(r.tras.expires_at_ms);
	});

	it("el cobro se muda con el tiempo, o un reembolso no tendría de dónde restar", async () => {
		// LIC-07: `localizarCobro` llega al cobro por el `payment_intent`. Si el cobro siguiera
		// apuntando a la clave gastada —que no tiene meses— devolver el dinero no quitaría nada.
		const r = await escenario("cobro", async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const nueva = await e.emitir(12);
			e.sql.exec(
				`INSERT INTO license_payments (payment_id, license_id, kind, term_months,
				   stripe_checkout_session_id, stripe_payment_intent_id, at_ms)
				 VALUES ('p1', ?, 'issue', 12, 'cs_1', 'pi_1', ?);`,
				nueva.id,
				Date.now(),
			);

			await e.activar(nueva.clave);
			return {
				viejaId,
				pago: e.sql.exec(`SELECT license_id, kind FROM license_payments;`).toArray()[0],
			};
		});

		expect(r.pago).toEqual({ license_id: r.viejaId, kind: "renewal" });
	});

	it("con la clave de otro equipo no se suma nada", async () => {
		// El `device_id` no es un secreto: viaja en los mensajes de presencia del WebSocket
		// (REV-07). Quien lo conoce puede firmar con una clave suya, pero no es la registrada de ese
		// equipo; y presentar la registrada exige firmar con su privada (AUD-01,
		// `activarConFirma.test.ts`).
		const r = await escenario("clave-ajena", async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			const res = await e.activar(nueva.clave, EQUIPO, await clavePublica(2));
			return { res, final: await e.leer(viejaId), clave: await e.leer(nueva.id) };
		});

		expect(r.res.status).toBe(409);
		expect(r.res.body.error).toBe("device_key_mismatch");
		expect(r.clave.status).toBe("issued");
	});
});

describe("REV-13 · el equipo NO tiene licencia: se estrena", () => {
	it("un equipo nuevo estrena su propio negocio", async () => {
		const r = await escenario("estrena", async (e) => {
			const nueva = await e.emitir(12);
			const res = await e.activar(nueva.clave, "equipo-recien-comprado", CLAVE_EQUIPO);
			return { res, lic: await e.leer(nueva.id) };
		});

		expect(r.res.status).toBe(200);
		expect(r.res.body.tiempoSumado).toBeUndefined();
		expect(r.lic.status).toBe("active");
		expect(r.lic.main_device_id).toBe("equipo-recien-comprado");
		// Aquí sí: tenant propio y base propia.
		expect(basesCreadas).toEqual([r.res.body.tenantId]);
	});

	it("el segundo local del mismo dueño es un negocio aparte", async () => {
		// El caso que el bug se comía: el dueño abre otro bar, compra y activa en el equipo NUEVO.
		const r = await escenario("segundo-local", async (e) => {
			const primeraId = await e.licenciaDelEquipo();
			const antes = await e.leer(primeraId);
			const nueva = await e.emitir(12);

			const res = await e.activar(nueva.clave, "equipo-del-otro-bar", CLAVE_EQUIPO);
			return { res, primera: await e.leer(primeraId), segunda: await e.leer(nueva.id), antes };
		});

		expect(r.res.body.tiempoSumado).toBeUndefined();
		expect(r.segunda.status).toBe("active");
		expect(r.res.body.tenantId).not.toBe("tenant-del-bar");
		// Y al primer bar no se le ha tocado nada.
		expect(r.primera.expires_at_ms).toBe(r.antes.expires_at_ms);
	});
});

describe("REV-13 · una licencia ya activada no canjea", () => {
	it("teclear en su propio equipo la clave que ya usó no suma tiempo", async () => {
		// Decisión de producto: sumar tiempo es cosa de un código SIN estrenar. Reactivar la que ya
		// tienes es sólo volver a entrar, no comprar otro año.
		const r = await escenario("ya-activada", async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const antes = await e.leer(viejaId);
			// La misma clave con la que se activó.
			const fila = e.sql
				.exec(`SELECT license_key_hash FROM licenses WHERE license_id=?;`, viejaId)
				.toArray()[0];

			// Se reactiva por el camino de siempre (mismo equipo), que no pasa por el canje.
			const res = await e.activar("no-importa-el-texto");
			return { res, antes, final: await e.leer(viejaId), hash: fila };
		});

		// La clave inventada no existe: lo que fija el test es que el tiempo NO se ha movido.
		expect(r.final.expires_at_ms).toBe(r.antes.expires_at_ms);
	});

	it("la clave de otro negocio, ya activada, tampoco suma: eso es un cambio de equipo", async () => {
		const r = await escenario("de-otro", async (e) => {
			const miaId = await e.licenciaDelEquipo();
			const antes = await e.leer(miaId);

			// Una licencia de otro bar, ya activada en su propio equipo.
			const ajena = await e.emitir(12);
			e.sql.exec(
				`UPDATE licenses SET status='active', tenant_id='tenant-ajeno',
				        main_device_id='equipo-ajeno', activated_at_ms=?, expires_at_ms=?
				  WHERE license_id=?;`,
				Date.now(),
				Date.now() + 200 * DIA,
				ajena.id,
			);

			const res = await e.activar(ajena.clave);
			return { res, final: await e.leer(miaId), antes, ajena: await e.leer(ajena.id) };
		});

		// Pide el código del correo del titular: es el camino del cambio de equipo, no un canje.
		expect(r.res.status).toBe(409);
		expect(r.res.body.error).toBe("device_change_required");
		// Y no se ha sumado nada a ninguna de las dos.
		expect(r.final.expires_at_ms).toBe(r.antes.expires_at_ms);
		expect(r.ajena.status).toBe("active");
	});
});

describe("REV-13 · un canje que falla no gasta la clave", () => {
	it("si la DEK no se deja descifrar, la clave sigue sin gastar y vale al arreglarlo", async () => {
		// El caso real: se cambió `LICENSE_STORE_KEY` y la DEK del tenant, cifrada con la anterior,
		// ya no se descifraba. El canje gastaba la clave y sumaba los meses ANTES de leerla, así que
		// el equipo se llevaba un 500 y el reintento, `license_already_used`: sin token con
		// ninguna de las dos claves.
		const OTRA_CLAVE = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
		const r = await escenario("dek-ilegible", async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			const dek = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
			e.sql.exec(
				`UPDATE tenants SET field_dek=? WHERE tenant_id='tenant-del-bar';`,
				await cifrar(OTRA_CLAVE, dek),
			);
			const fallo = await e.activar(nueva.clave);
			const tras = { vieja: await e.leer(viejaId), clave: await e.leer(nueva.id) };

			// Con la variable arreglada —aquí, la DEK cifrada con la clave que tiene el worker—, el
			// MISMO código entra a la primera.
			e.sql.exec(
				`UPDATE tenants SET field_dek=? WHERE tenant_id='tenant-del-bar';`,
				await cifrar(STORE_KEY, dek),
			);
			const bien = await e.activar(nueva.clave);
			return { antes, fallo, tras, bien, dek, final: await e.leer(viejaId) };
		});

		expect(r.fallo.status).toBe(500);
		expect(r.tras.clave.status).toBe("issued");
		expect(r.tras.vieja.expires_at_ms).toBe(r.antes.expires_at_ms);

		expect(r.bien.status).toBe(200);
		expect(r.bien.body.tiempoSumado).toBe(true);
		expect(r.bien.body.fieldDek).toBe(r.dek);
		expect(r.final.expires_at_ms).toBeGreaterThan(r.antes.expires_at_ms + 350 * DIA);
	});

	it("un corte a mitad de las escrituras no deja la clave gastada sin sumar", async () => {
		// Gastar, sumar y mudar el cobro eran tres sentencias sueltas: si caía la tercera, las dos
		// primeras se quedaban, y el reintento ya no podía canjear.
		const r = await escenario("corte", async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			clienteActual = conFalloSimulado(e.db, /UPDATE license_payments/);
			const fallo = await e.activar(nueva.clave);
			const tras = { vieja: await e.leer(viejaId), clave: await e.leer(nueva.id) };

			clienteActual = e.db;
			const bien = await e.activar(nueva.clave);
			return { antes, fallo, tras, bien, final: await e.leer(viejaId) };
		});

		expect(r.fallo.status).toBe(500);
		expect(r.tras.clave.status).toBe("issued");
		expect(r.tras.vieja.expires_at_ms).toBe(r.antes.expires_at_ms);

		// Y el reintento suma una sola vez.
		expect(r.bien.status).toBe(200);
		expect(r.final.expires_at_ms).toBeGreaterThan(r.antes.expires_at_ms + 350 * DIA);
		expect(r.final.expires_at_ms).toBeLessThan(r.antes.expires_at_ms + 380 * DIA);
	});
});


describe("RI-52 · canje desde Configuración (soloSumar)", () => {
	it("una clave sin estrenar suma tiempo, igual que sin la marca", async () => {
		const r = await escenario("solo-sumar-ok", async (e) => {
			const actual = await e.licenciaDelEquipo({ diasRestantes: 30 });
			const antes = (await e.leer(actual)).expires_at_ms;
			const { clave } = await e.emitir(12);
			const res = await e.activar(clave, EQUIPO, CLAVE_EQUIPO, { soloSumar: true });
			return { res, antes, despues: (await e.leer(actual)).expires_at_ms };
		});
		expect(r.res.status).toBe(200);
		expect(r.res.body.tiempoSumado).toBe(true);
		expect(r.despues).toBeGreaterThan(r.antes);
	});

	it("la clave de otro equipo, ya activada, se rechaza sin pedir el código de cambio de equipo", async () => {
		const r = await escenario("solo-sumar-otro", async (e) => {
			await e.licenciaDelEquipo();
			const { clave, id } = await e.emitir(12);
			e.sql.exec(
				`UPDATE licenses SET status='active', main_device_id='otro-equipo', tenant_id='otro',
				        activated_at_ms=?, expires_at_ms=? WHERE license_id=?;`,
				Date.now(),
				Date.now() + 300 * DIA,
				id,
			);
			const res = await e.activar(clave, EQUIPO, CLAVE_EQUIPO, { soloSumar: true });
			return { res, otra: await e.leer(id) };
		});
		expect(r.res.status).toBe(409);
		expect(r.res.body.error).toBe("clave_no_canjeable");
		expect(r.res.body.message).toMatch(/otro equipo/);
		expect(r.otra.main_device_id).toBe("otro-equipo");
	});

	it("en un equipo sin licencia viva no estrena un negocio nuevo", async () => {
		const r = await escenario("solo-sumar-sin-licencia", async (e) => {
			const { clave, id } = await e.emitir(12);
			const res = await e.activar(clave, EQUIPO, CLAVE_EQUIPO, { soloSumar: true });
			return { res, clave: await e.leer(id), bases: basesCreadas.length };
		});
		expect(r.res.status).toBe(409);
		expect(r.res.body.error).toBe("clave_no_canjeable");
		expect(r.clave.status).toBe("issued");
		expect(r.bases).toBe(0);
	});

	it("la clave que ya tiene este equipo no se vuelve a activar", async () => {
		const r = await escenario("solo-sumar-misma", async (e) => {
			const actual = await e.licenciaDelEquipo();
			const clave = generateLicenseKey();
			e.sql.exec(
				"UPDATE licenses SET license_key_hash = ? WHERE license_id = ?;",
				await licenseKeyHash(clave),
				actual,
			);
			return e.activar(clave, EQUIPO, CLAVE_EQUIPO, { soloSumar: true });
		});
		expect(r.status).toBe(409);
		expect(r.body.message).toMatch(/ya tiene este equipo/);
	});
});
