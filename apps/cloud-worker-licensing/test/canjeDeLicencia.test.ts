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
import {
	centralDePrueba,
	centralInterceptada,
	conFalloEnLasOperaciones,
	filasDe,
	type CentralDePrueba,
} from "./helpers/central";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";

/** Bases de tenant que se han llegado a aprovisionar: el canje no puede crear ninguna. */
let basesCreadas: string[] = [];
/** Lo que pasa mientras se aprovisiona una base, para intercalar otra petición (AUD-07). */
let alAprovisionar: (() => Promise<void>) | null = null;

vi.mock("../src/domains/licensing/licensing.helpers", async (original) => ({
	...(await (original as any)()),
	provisionTenantDatabase: async (_db: any, _env: any, tenantId: string) => {
		basesCreadas.push(tenantId);
		const intercalar = alAprovisionar;
		alAprovisionar = null;
		if (intercalar) await intercalar();
	},
}));

const { licenseRoutes } = await import("../src/domains/licensing/licensing.routes");
const { generateLicenseKey, licenseKeyHash } = await import(
	"../src/domains/licensing/licenseKey"
);
const { activateLicenseFirstTime, ensureDevice, getLicenseById, reassignMainDevice } = await import(
	"../src/server/licenseStore"
);
const { cifrar } = await import("../src/server/crypto");

const STORE_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = {
	LICENSE_STORE_KEY: STORE_KEY,
	LICENSE_JWT_SECRET: "secreto-de-pruebas-con-longitud-suficiente-32",
	LICENSE_SIGNING_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
	EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
	EMAIL: { send: async () => {} },
} as any;

const DIA = 24 * 60 * 60 * 1000;
const EQUIPO = "equipo-del-bar";
// AUD-01: claves ed25519 de verdad, porque activar exige la firma del equipo.
const CLAVE_EQUIPO = await clavePublica(1);

type Escenario = {
	central: CentralDePrueba;
	/**
	 * La central a la que llega `/activate` (por `getDb(env)`): la de verdad, o la misma a través de un
	 * stub que corta una sentencia a mitad de un estreno.
	 */
	deLaRuta: CentralDePrueba;
	/** Una sentencia directa en el SQLite de la central, por fuera de sus guardas (`filasDe`). */
	sql: (texto: string, ...args: unknown[]) => Promise<Record<string, any>[]>;
	db: CentralDePrueba["db"];
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

async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	{
		const central = await centralDePrueba();
		const db = central.db;
		const sql = (texto: string, ...args: unknown[]) => filasDe(central, texto, ...args);
		basesCreadas = [];

		let n = 0;
		const e: Escenario = {
			central,
			deLaRuta: central,
			sql,
			db,
			async emitir(meses = 12) {
				const clave = generateLicenseKey();
				const id = `lic-${++n}`;
				await sql(
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
				await sql(`INSERT INTO tenants (tenant_id, status) VALUES ('tenant-del-bar', 'active');`);
				await sql(
					`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64)
					 VALUES (?, 'tenant-del-bar', 'tpv', ?);`,
					EQUIPO,
					CLAVE_EQUIPO,
				);
				await sql(
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
					{ ...ENV, ...e.deLaRuta.entorno },
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
	}
}

/** Lo que hace `POST /v1/admin/licenses/:id/revoke` en la central. */
const revocar = (e: Escenario, licenseId: string) => e.db.operar("revocarAMano", { licenseId, ahoraMs: Date.now() });

/** Lo que hace `POST /v1/admin/licenses/:id/unrevoke` en la central. */
const desrevocar = (e: Escenario, licenseId: string) => e.db.operar("desrevocar", { licenseId, ahoraMs: Date.now() });

beforeEach(() => {
	basesCreadas = [];
	alAprovisionar = null;
});

describe("REV-13 · el equipo ya tiene licencia: se suma el tiempo", () => {
	it("suma los meses a la que hay y no crea otro negocio", async () => {
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo({ diasRestantes: 30 });
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			const res = await e.activar(nueva.clave);
			return {
				res,
				antes,
				vieja: await e.leer(viejaId),
				clave: await e.leer(nueva.id),
				tenants: Number((await e.sql(`SELECT COUNT(*) AS n FROM tenants;`))[0].n),
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
        const r = await escenario(async (e) => {
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
		const r = await escenario(async (e) => {
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
		// Al equipo que la canjeó se le dice que su tiempo ya está sumado, no que fue a otra licencia.
		expect(r.dos.body.message).toMatch(/ya está sumado a la licencia de este equipo/);
		expect(r.final.expires_at_ms).toBe(r.tras.expires_at_ms);
	});

	it("una clave ya canjeada no estrena otro negocio en un equipo sin licencia (AUD-07)", async () => {
		// El canje deja la clave `redeemed` con `main_device_id` a NULL, y `/activate` sólo miraba esto
		// último: la misma clave, tecleada en la pantalla de activación de otro ordenador, estrenaba un
		// negocio nuevo con su plazo entero mientras el primero se quedaba los meses sumados.
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo({ diasRestantes: 30 });
			const nueva = await e.emitir(12);

			const uno = await e.activar(nueva.clave);
			const tras = await e.leer(viejaId);
			const dos = await e.activar(nueva.clave, "equipo-sin-licencia", await clavePublica(4), {
				tenantInfo: { displayName: "Bar 2" },
			});
			return {
				viejaId,
				uno,
				dos,
				tras,
				vieja: await e.leer(viejaId),
				clave: await e.leer(nueva.id),
				tenants: Number((await e.sql(`SELECT COUNT(*) AS n FROM tenants;`))[0].n),
				equipoNuevo: await e.sql(`SELECT 1 FROM devices WHERE device_id = 'equipo-sin-licencia';`),
			};
		});

		expect(r.uno.status).toBe(200);
		expect(r.uno.body.tiempoSumado).toBe(true);

		expect(r.dos.status).toBe(409);
		expect(r.dos.body.error).toBe("license_already_used");
		// La frase es la de la tabla (se sumó a otra licencia): no es el equipo que la canjeó.
		expect(r.dos.body.message).toBeUndefined();
		expect(r.dos.body.token).toBeUndefined();
		expect(r.dos.body.fieldDek).toBeUndefined();
		expect(r.dos.body.tenantId).toBeUndefined();

		// La clave sigue gastada donde se gastó, y no hay negocio, base ni equipo nuevos.
		expect(r.clave).toMatchObject({
			status: "redeemed",
			main_device_id: null,
			expires_at_ms: null,
			redeemed_into_license_id: r.viejaId,
		});
		expect(r.tenants).toBe(1);
		expect(basesCreadas).toEqual([]);
		expect(r.equipoNuevo).toEqual([]);
		expect(r.vieja.expires_at_ms).toBe(r.tras.expires_at_ms);
	});

	it("el alta no estrena una clave canjeada aunque llegue hasta ella (AUD-07)", async () => {
		// La segunda barrera, la del `UPDATE`: no basta con que la ruta mire el estado al leer.
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo({ diasRestantes: 30 });
			const nueva = await e.emitir(12);
			await e.activar(nueva.clave);
			const antes = await e.leer(nueva.id);

			const resultado = await activateLicenseFirstTime(e.db, {
				licenseId: nueva.id,
				tenantId: "tenant-cualquiera",
				deviceId: "equipo-cualquiera",
				termMonths: 12,
			});
			return { viejaId, antes, resultado, despues: await e.leer(nueva.id) };
		});

		expect(r.antes.status).toBe("redeemed");
		expect(r.resultado).toBeNull();
		expect(r.despues).toMatchObject({
			status: "redeemed",
			main_device_id: null,
			tenant_id: null,
			expires_at_ms: null,
			redeemed_into_license_id: r.viejaId,
		});
	});

	it("anular y desanular una clave canjeada no la deja otra vez sin estrenar (AUD-07)", async () => {
		// Nunca se activó, así que deshacer su anulación la devolvía a `issued`: se podía estrenar con
		// ella un negocio, o sumarla otra vez.
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo({ diasRestantes: 30 });
			const nueva = await e.emitir(12);
			await e.activar(nueva.clave);
			const tras = await e.leer(viejaId);

			await revocar(e, nueva.id);
			const anulada = await e.activar(nueva.clave, "equipo-sin-licencia", await clavePublica(4));
			await desrevocar(e, nueva.id);
			const desanulada = await e.leer(nueva.id);

			const enOtroEquipo = await e.activar(nueva.clave, "equipo-sin-licencia", await clavePublica(4));
			const enElMismo = await e.activar(nueva.clave);
			return { viejaId, tras, anulada, desanulada, enOtroEquipo, enElMismo, vieja: await e.leer(viejaId) };
		});

		expect([r.anulada.status, r.anulada.body.error]).toEqual([403, "license_revoked"]);
		expect(r.desanulada).toMatchObject({
			status: "redeemed",
			disabled: 0,
			main_device_id: null,
			redeemed_into_license_id: r.viejaId,
		});
		expect([r.enOtroEquipo.status, r.enOtroEquipo.body.error]).toEqual([409, "license_already_used"]);
		expect([r.enElMismo.status, r.enElMismo.body.error]).toEqual([409, "license_already_used"]);
		expect(basesCreadas).toEqual([]);
		expect(r.vieja.expires_at_ms).toBe(r.tras.expires_at_ms);
	});

	it("si el canje entra mientras otro equipo aprovisiona su base con esa clave, gana el canje y sólo él (AUD-07)", async () => {
		// Lo que el rechazo de la ruta no ve: el equipo nuevo leyó la clave cuando aún era `issued`, y
		// el canje la gasta antes de su `UPDATE`. Ganaban los dos: 12 meses al primer local y un
		// negocio nuevo con otros 12.
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo({ diasRestantes: 30 });
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			let estadoAlAprovisionar: string | null = null;
			let canje: { status: number; body: any } | null = null;
			alAprovisionar = async () => {
				estadoAlAprovisionar = (await e.leer(nueva.id)).status;
				canje = await e.activar(nueva.clave);
			};
			const nuevo = await e.activar(nueva.clave, "equipo-sin-licencia", await clavePublica(4));
			return {
				viejaId,
				antes,
				estadoAlAprovisionar,
				canje: canje as { status: number; body: any } | null,
				nuevo,
				vieja: await e.leer(viejaId),
				clave: await e.leer(nueva.id),
			};
		});

		expect(r.estadoAlAprovisionar).toBe("issued");
		expect(r.canje?.status).toBe(200);
		expect(r.canje?.body.tiempoSumado).toBe(true);
		expect(r.vieja.expires_at_ms).toBeGreaterThan(r.antes.expires_at_ms + 350 * DIA);

		// Al equipo nuevo se le dice que la clave ya está usada, no que está en otro equipo.
		expect(r.nuevo.status).toBe(409);
		expect(r.nuevo.body.error).toBe("license_already_used");
		expect(r.nuevo.body.token).toBeUndefined();
		expect(r.nuevo.body.fieldDek).toBeUndefined();
		expect(r.clave).toMatchObject({
			status: "redeemed",
			main_device_id: null,
			redeemed_into_license_id: r.viejaId,
		});
	});

	it("el cobro se muda con el tiempo, o un reembolso no tendría de dónde restar", async () => {
		// LIC-07: `localizarCobro` llega al cobro por el `payment_intent`. Si el cobro siguiera
		// apuntando a la clave gastada —que no tiene meses— devolver el dinero no quitaría nada.
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const nueva = await e.emitir(12);
			await e.sql(
				`INSERT INTO license_payments (payment_id, license_id, kind, term_months,
				   stripe_checkout_session_id, stripe_payment_intent_id, at_ms)
				 VALUES ('p1', ?, 'issue', 12, 'cs_1', 'pi_1', ?);`,
				nueva.id,
				Date.now(),
			);

			await e.activar(nueva.clave);
			return {
				viejaId,
				pago: (await e.sql(`SELECT license_id, kind FROM license_payments;`))[0],
			};
		});

		expect(r.pago).toEqual({ license_id: r.viejaId, kind: "renewal" });
	});

	it("con la clave de otro equipo no se suma nada", async () => {
		// El `device_id` no es un secreto: viaja en los mensajes de presencia del WebSocket
		// (REV-07). Quien lo conoce puede firmar con una clave suya, pero no es la registrada de ese
		// equipo; y presentar la registrada exige firmar con su privada (AUD-01,
		// `activarConFirma.test.ts`).
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			const res = await e.activar(nueva.clave, EQUIPO, await clavePublica(2));
			return { res, antes, final: await e.leer(viejaId), clave: await e.leer(nueva.id) };
		});

		expect(r.res.status).toBe(409);
		expect(r.res.body.error).toBe("device_key_mismatch");
		// Ni un día más en la licencia del equipo, ni ninguna otra cosa suya cambiada.
		expect(r.final.expires_at_ms).toBe(r.antes.expires_at_ms);
		expect(r.final).toEqual(r.antes);
		expect(r.clave.status).toBe("issued");
	});
});

describe("REV-13 · el equipo NO tiene licencia: se estrena", () => {
	it("un equipo nuevo estrena su propio negocio", async () => {
		const r = await escenario(async (e) => {
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
		const r = await escenario(async (e) => {
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

describe("AUD-06 · una clave sin estrenar en un equipo que era de otro negocio", () => {
	// Con la licencia anulada o trasladada, el equipo ya no tiene una licencia viva a la que sumar
	// tiempo, así que la clave nueva estrena otro negocio. Pero su base local es la del anterior: si
	// el servidor contesta `cambioDeEquipo: false`, la Main abre el login con los usuarios de aquél
	// —y el código para restablecer el PIN de su administrador va al comprador de la clave— y
	// después sube sus filas a la nube del nuevo. La Main sólo aparta la base si se lo dicen.

	/** El negocio en el que está la fila del equipo, o `null` si no la tiene. */
	const negocioDelEquipo = async (e: Escenario): Promise<string | null> => {
		const fila = (await e.sql(`SELECT tenant_id FROM devices WHERE device_id = ?;`, EQUIPO))[0];
		return fila ? String(fila.tenant_id) : null;
	};

	/** La misma central, pero la primera sentencia suelta que case con `patron` revienta en su stub. */
	function conCorte(central: CentralDePrueba, patron: RegExp): CentralDePrueba {
		let pendiente = true;
		return centralInterceptada(central, (metodo, [entrada], llamar) => {
			if (metodo === "ejecutar" && pendiente && patron.test((entrada as SentenciaEnlazada).sql)) {
				pendiente = false;
				return Promise.reject(new Error("corte_simulado"));
			}
			return llamar();
		});
	}

	for (const previo of ["anulada", "trasladada"] as const) {
		it(`con la licencia del negocio anterior ${previo}, el estreno avisa de que la base no vale`, async () => {
			const r = await escenario(async (e) => {
				const viejaId = await e.licenciaDelEquipo();
				if (previo === "anulada") {
					await revocar(e, viejaId);
				} else {
					// Lo que hace `/activate` en un cambio de equipo con el código del correo.
					const otra = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
					await ensureDevice(e.db, "tenant-del-bar", "equipo-nuevo-del-bar", "tpv", otra);
					await reassignMainDevice(e.db, {
						licenseId: viejaId,
						fromDeviceId: EQUIPO,
						toDeviceId: "equipo-nuevo-del-bar",
					});
				}
				const nueva = await e.emitir(12);

				const res = await e.activar(nueva.clave);
				return {
					res,
					vieja: await e.leer(viejaId),
					nueva: await e.leer(nueva.id),
					negocio: await negocioDelEquipo(e),
				};
			});

			expect(r.res.status).toBe(200);
			expect(r.res.body.cambioDeEquipo).toBe(true);
			// Sigue siendo un estreno: negocio nuevo, con su base, y no tiempo sumado al anterior.
			expect(r.res.body.tiempoSumado).toBeUndefined();
			expect(r.res.body.tenantId).not.toBe("tenant-del-bar");
			expect(basesCreadas).toEqual([r.res.body.tenantId]);
			expect(r.negocio).toBe(r.res.body.tenantId);
			expect(r.nueva.status).toBe("active");
			expect(r.nueva.tenant_id).toBe(r.res.body.tenantId);
			expect(r.nueva.main_device_id).toBe(EQUIPO);
			// Y a la licencia del negocio anterior no se le toca nada.
			expect(r.vieja.tenant_id).toBe("tenant-del-bar");
		});
	}

	it("un equipo nuevo no tiene nada que apartar", async () => {
		const r = await escenario(async (e) => {
			// Otro negocio con su licencia, en su equipo: no es el que activa.
			await e.licenciaDelEquipo();
			const nueva = await e.emitir(12);
			return e.activar(nueva.clave, "equipo-recien-comprado", CLAVE_EQUIPO);
		});

		expect(r.status).toBe(200);
		expect(r.body.cambioDeEquipo).toBe(false);
	});

	it("el mismo negocio, reactivado en su equipo, conserva su base", async () => {
		// Una anulación por error que se deshace: la misma clave vuelve a activar el mismo equipo.
		const r = await escenario(async (e) => {
			const mia = await e.emitir(12);
			const estreno = await e.activar(mia.clave);
			await revocar(e, mia.id);
			await desrevocar(e, mia.id);
			const vuelta = await e.activar(mia.clave);
			return { estreno, vuelta };
		});

		expect(r.estreno.body.cambioDeEquipo).toBe(false);
		expect(r.vuelta.status).toBe(200);
		expect(r.vuelta.body.cambioDeEquipo).toBe(false);
		expect(r.vuelta.body.tenantId).toBe(r.estreno.body.tenantId);
	});

	it("el equipo que pasó por otro negocio y vuelve a su licencia también la conserva", async () => {
		// Una Main que se usó como Handy de otro negocio: su fila se mudó allí, pero su base sigue
		// siendo la de su licencia. No es una primera activación, así que no hay nada que apartar.
		const r = await escenario(async (e) => {
			const mia = await e.emitir(12);
			const estreno = await e.activar(mia.clave);

			const ajena = await e.emitir(12);
			await e.sql(`INSERT INTO tenants (tenant_id, status) VALUES ('otro-negocio', 'active');`);
			await e.sql(
				`UPDATE licenses SET status='active', tenant_id='otro-negocio', main_device_id='main-del-otro',
				        activated_at_ms=?, expires_at_ms=? WHERE license_id=?;`,
				Date.now(),
				Date.now() + 200 * DIA,
				ajena.id,
			);
			await e.sql(`UPDATE devices SET tenant_id='otro-negocio', role='handy' WHERE device_id=?;`, EQUIPO);

			const vuelta = await e.activar(mia.clave);
			return { estreno, vuelta, negocio: await negocioDelEquipo(e) };
		});

		expect(r.vuelta.status).toBe(200);
		expect(r.vuelta.body.cambioDeEquipo).toBe(false);
		expect(r.vuelta.body.tenantId).toBe(r.estreno.body.tenantId);
		expect(r.negocio).toBe(r.estreno.body.tenantId);
	});

	it("el reintento de un estreno que falló a medias no es de otro negocio", async () => {
		// El primer intento crea el negocio y su base y falla al apuntar la licencia. AUD-09: el
		// negocio queda reservado en la clave y el equipo sin dar de alta (eso espera a ganar la
		// licencia), así que el reintento vuelve al mismo negocio sin nada que apartar. Si contara
		// como otro, el equipo nuevo que reintenta acabaría en la pantalla de recuperación.
		const r = await escenario(async (e) => {
			const nueva = await e.emitir(12);

			e.deLaRuta = conCorte(e.central, /UPDATE licenses\s+SET status='active'/);
			const fallo = await e.activar(nueva.clave);
			const trasElFallo = { negocio: await negocioDelEquipo(e), clave: await e.leer(nueva.id) };

			e.deLaRuta = e.central;
			const bien = await e.activar(nueva.clave);
			return { fallo, trasElFallo, bien, negocio: await negocioDelEquipo(e) };
		});

		expect(r.fallo.status).toBe(500);
		expect(r.trasElFallo.clave).toMatchObject({ status: "issued", main_device_id: null, activated_at_ms: null });
		expect(r.trasElFallo.clave.tenant_id).toBeTruthy();
		expect(r.trasElFallo.negocio).toBeNull();
		expect(r.bien.status).toBe(200);
		expect(r.bien.body.tenantId).toBe(r.trasElFallo.clave.tenant_id);
		expect(r.bien.body.cambioDeEquipo).toBe(false);
		expect(r.negocio).toBe(r.bien.body.tenantId);
		// La misma base las dos veces: el alta del TenantHub es idempotente.
		expect(basesCreadas).toEqual([r.bien.body.tenantId, r.bien.body.tenantId]);
	});

	for (const como of ["sin estrenar", "canjeada después"] as const) {
		it(`la fila en un negocio que una clave ${como} sólo tenía reservado no cuenta`, async () => {
			// AUD-09: lo que dejaba un estreno a medias antes de que el equipo esperase a ganar la
			// licencia para darse de alta: su fila en el negocio que la clave tiene reservado y sin
			// activar. Ese negocio no ha nacido (`activated_at_ms`), así que su base no es de nadie.
			// Y una clave canjeada después lo arrastraba con su `tenant_id` (ahora el canje lo suelta).
			const r = await escenario(async (e) => {
				const reservada = await e.emitir(12);
				await e.sql(`INSERT INTO tenants (tenant_id, status) VALUES ('negocio-reservado', 'active');`);
				await e.sql(
					`UPDATE licenses SET tenant_id='negocio-reservado', status=? WHERE license_id=?;`,
					como === "sin estrenar" ? "issued" : "redeemed",
					reservada.id,
				);
				await e.sql(
					`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64)
					 VALUES (?, 'negocio-reservado', 'tpv', ?);`,
					EQUIPO,
					CLAVE_EQUIPO,
				);
				const nueva = await e.emitir(12);
				return e.activar(nueva.clave);
			});

			expect(r.status).toBe(200);
			expect(r.body.tenantId).not.toBe("negocio-reservado");
			expect(r.body.cambioDeEquipo).toBe(false);
		});
	}

	it("un negocio retirado no cuenta: su equipo estrena el siguiente sin nada que apartar", async () => {
		// Lo que deja cada tanda del E2E (`admin/pruebas.ts`): el negocio dado por borrado y su
		// licencia anulada. El equipo conserva la identidad y estrena la tanda siguiente con la
		// carpeta de datos recién borrada.
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			await revocar(e, viejaId);
			await e.sql(`UPDATE tenants SET status='deleted' WHERE tenant_id='tenant-del-bar';`);
			const nueva = await e.emitir(12);
			return e.activar(nueva.clave);
		});

		expect(r.status).toBe(200);
		expect(r.body.tiempoSumado).toBeUndefined();
		expect(r.body.cambioDeEquipo).toBe(false);
	});
});

describe("REV-13 · una licencia ya activada no canjea", () => {
	it("teclear en su propio equipo la clave que ya usó no suma tiempo", async () => {
		// Decisión de producto: sumar tiempo es cosa de un código SIN estrenar. Reactivar la que ya
		// tienes es sólo volver a entrar, no comprar otro año.
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const antes = await e.leer(viejaId);
			// La misma clave con la que se activó.
			const fila = (await e.sql(`SELECT license_key_hash FROM licenses WHERE license_id=?;`, viejaId))[0];

			// Se reactiva por el camino de siempre (mismo equipo), que no pasa por el canje.
			const res = await e.activar("no-importa-el-texto");
			return { res, antes, final: await e.leer(viejaId), hash: fila };
		});

		// La clave inventada no existe: lo que fija el test es que el tiempo NO se ha movido.
		expect(r.final.expires_at_ms).toBe(r.antes.expires_at_ms);
	});

	it("la clave de otro negocio, ya activada, tampoco suma: eso es un cambio de equipo", async () => {
		const r = await escenario(async (e) => {
			const miaId = await e.licenciaDelEquipo();
			const antes = await e.leer(miaId);

			// Una licencia de otro bar, ya activada en su propio equipo.
			const ajena = await e.emitir(12);
			await e.sql(
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
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			const dek = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
			await e.sql(
				`UPDATE tenants SET field_dek=? WHERE tenant_id='tenant-del-bar';`,
				await cifrar(OTRA_CLAVE, dek),
			);
			const fallo = await e.activar(nueva.clave);
			const tras = { vieja: await e.leer(viejaId), clave: await e.leer(nueva.id) };

			// Con la variable arreglada —aquí, la DEK cifrada con la clave que tiene el worker—, el
			// MISMO código entra a la primera.
			await e.sql(
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
		const r = await escenario(async (e) => {
			const viejaId = await e.licenciaDelEquipo();
			const antes = await e.leer(viejaId);
			const nueva = await e.emitir(12);

			e.deLaRuta = conFalloEnLasOperaciones(e.central, /UPDATE license_payments/);
			const fallo = await e.activar(nueva.clave);
			const tras = { vieja: await e.leer(viejaId), clave: await e.leer(nueva.id) };

			e.deLaRuta = e.central;
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
		const r = await escenario(async (e) => {
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
		const r = await escenario(async (e) => {
			await e.licenciaDelEquipo();
			const { clave, id } = await e.emitir(12);
			await e.sql(
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
		const r = await escenario(async (e) => {
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
		const r = await escenario(async (e) => {
			const actual = await e.licenciaDelEquipo();
			const clave = generateLicenseKey();
			await e.sql(
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
