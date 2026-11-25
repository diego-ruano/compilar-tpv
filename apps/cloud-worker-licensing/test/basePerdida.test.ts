// test/basePerdida.test.ts
//
// DO-PERDIDA · Un negocio que ya nació y no tiene base no es un negocio sin estrenar.
//
// Un TenantHub vacío no dice por qué lo está: el negocio no ha nacido todavía, o su base está en
// otro objeto (otro espacio de nombres, otra jurisdicción) o se borró por error. Lo distingue la
// base central, sin tocar su esquema: un negocio nace al activarse su primera licencia, y la
// activación crea la base antes de apuntar la licencia (`lib/basePerdida.ts`). Con los objetos de
// verdad y por la `app` entera, aquí se fija que:
//
//   · `provisionTenantDatabase` sólo crea la base de un negocio que no ha nacido; para uno que ya
//     nació y no la tiene, lanza `tenant_db_perdida` sin crear nada;
//   · un negocio que ya nació y se encuentra sin base recibe `tenant_db_perdida` (503, `external`,
//     con su frase) en la descarga de la recuperación, en `/v1/sync/initialize-empty` y en las
//     lecturas de la Handy, y la base no se crea;
//   · uno que no ha nacido sigue recibiendo `tenant_db_not_provisioned`, y puede crear su base;
//   · si la base central no contesta a la pregunta, no se sabe: 500, y tampoco se crea nada;
//   · se avisa una vez por negocio, no una por petición.

import { env as entorno } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { centralDePrueba, centralInterceptada, filasDe } from "./helpers/central";
import { HANDY, MAIN, conNegocioFirmado, pedirFirmado, peticionFirmada, type Negocio } from "./helpers/negocioFirmado";

const { avisos } = vi.hoisted(() => ({ avisos: [] as string[] }));

// Lo que se manda a Sentry, apuntado por operación: aquí interesa el aviso de la base perdida.
vi.mock("../src/observability/errors", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/errors")>();
	return {
		...original,
		capturarError: (error: unknown, operacion: string) => {
			if (!original.esRechazoEsperado(error)) avisos.push(operacion);
		},
	};
});

const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");
const { provisionTenantDatabase } = await import("../src/domains/licensing/licensing.helpers");
const { MENSAJES } = await import("../src/lib/errorCodes");
const { olvidarAvisosDeBasePerdida } = await import("../src/lib/basePerdida");

const env = entorno as any;
const deps = { firmarSesion, olvidarLicenciasCacheadas };

const USUARIO = "00000000-0000-7000-8000-000000000001";
const PERDIDA = { ok: false, code: "external", error: "tenant_db_perdida", message: MENSAJES.tenant_db_perdida };

/** Un negocio con licencia activada y sin base. */
const sinBase = <R>(nombre: string, prueba: (n: Negocio, hub: any) => Promise<R>) =>
	conNegocioFirmado(deps, nombre, prueba, { sinBase: true });

/** Como lo deja el alta mientras la licencia no se ha activado: el negocio no ha nacido. */
const sinNacer = (n: Negocio) =>
	n.enCentral(`UPDATE licenses SET activated_at_ms = NULL WHERE tenant_id = ?;`, n.tenantId);

const inicializarVacia = async (n: Negocio) =>
	app.request(await peticionFirmada(deps, n, MAIN, "POST", "/v1/sync/initialize-empty"), undefined, {
		...env,
		...n.entorno,
	});

const avisosDeBasePerdida = () => avisos.filter((operacion) => operacion === "tenant_db.perdida").length;

beforeEach(() => {
	avisos.length = 0;
	olvidarAvisosDeBasePerdida();
});

describe("la base sólo se crea para un negocio que no ha nacido", () => {
	/** Una central con la licencia del negocio `tenantId`: activada (el negocio ha nacido) o no. */
	async function central(tenantId: string, nacido: boolean) {
		const c = await centralDePrueba();
		await filasDe(
			c,
			`INSERT INTO licenses (license_id, license_key_hash, tenant_id, status, term_months, origin,
			                       issued_at_ms, activated_at_ms, customer_email, created_at_ms, updated_at_ms)
			 VALUES ('lic-1', 'hash-1', ?, ?, 12, 'manual', 1, ?, 'bar@a.test', 1, 1);`,
			tenantId,
			nacido ? "active" : "issued",
			nacido ? 1 : null,
		);
		return c;
	}
	const stub = (tenantId: string) => env.TenantHub.get(env.TenantHub.idFromName(tenantId));

	it("un negocio que no ha nacido estrena su base; con ella ya creada, no hay nada que hacer", async () => {
		const tenantId = "base-perdida-nace";
		expect(await provisionTenantDatabase((await central(tenantId, false)).db, env, tenantId)).toEqual({ reused: false });
		expect(await stub(tenantId).estaAprovisionado()).toBe(true);
		// Ya nacido y con su base: lo de siempre.
		expect(await provisionTenantDatabase((await central(tenantId, true)).db, env, tenantId)).toEqual({ reused: true });
	});

	it("uno que ya nació y no la tiene no recibe una vacía", async () => {
		const tenantId = "base-perdida-nacido";
		await expect(provisionTenantDatabase((await central(tenantId, true)).db, env, tenantId)).rejects.toMatchObject({
			code: "tenant_db_perdida",
			status: 503,
		});
		expect(await stub(tenantId).estaAprovisionado()).toBe(false);
	});

	it("si la base central no contesta, tampoco", async () => {
		const tenantId = "base-perdida-sin-central";
		const caida = centralInterceptada(await central(tenantId, false), () =>
			Promise.reject(new Error("la base central no contesta")),
		);
		await expect(provisionTenantDatabase(caida.db, env, tenantId)).rejects.toThrow("la base central no contesta");
		expect(await stub(tenantId).estaAprovisionado()).toBe(false);
	});
});

describe("un negocio que ya nació y se encuentra sin base", () => {
	it("recibe tenant_db_perdida al descargar la nube, y no el código que ofrece empezar de cero", async () => {
		await sinBase("base-perdida-descarga", async (n) => {
			const res = await pedirFirmado(deps, app, n, "/v1/sync/bootstrap");
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual(PERDIDA);
		});
	});

	it("no puede crear una base vacía, y la base sigue sin existir", async () => {
		await sinBase("base-perdida-vacia", async (n, hub) => {
			const res = await inicializarVacia(n);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual(PERDIDA);
			expect(hub.estaAprovisionado()).toBe(false);
		});
	});

	it("la Handy lo ve igual en sus lecturas", async () => {
		await sinBase("base-perdida-handy", async (n) => {
			const res = await app.request(
				await peticionFirmada(deps, n, HANDY, "GET", `/v1/trabajadores/permisos/${USUARIO}`),
				undefined,
				{ ...env, ...n.entorno },
			);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual(PERDIDA);
		});
	});

	it("se avisa una vez por negocio, no una por petición", async () => {
		await sinBase("base-perdida-aviso", async (n) => {
			for (let i = 0; i < 3; i++) await pedirFirmado(deps, app, n, "/v1/sync/bootstrap");
			await inicializarVacia(n);
			expect(avisosDeBasePerdida()).toBe(1);
		});
	});
});

describe("un negocio que no ha nacido", () => {
	it("sigue recibiendo tenant_db_not_provisioned y puede crear su base", async () => {
		await sinBase("base-perdida-sin-nacer", async (n, hub) => {
			await sinNacer(n);

			const bajada = await pedirFirmado(deps, app, n, "/v1/sync/bootstrap");
			expect(bajada.status).toBe(404);
			expect(await bajada.json()).toMatchObject({ ok: false, code: "tenant_db_not_provisioned" });
			expect(avisosDeBasePerdida()).toBe(0);

			const res = await inicializarVacia(n);
			expect(res.status).toBe(200);
			expect(hub.estaAprovisionado()).toBe(true);
		});
	});
});

describe("si la base central no contesta a la pregunta", () => {
	it("no se sabe si el negocio nació: 500, y ni se ofrece ni se crea nada", async () => {
		await sinBase("base-perdida-central-caida", async (n, hub) => {
			// La primera pasa por la base central y deja en caché el dispositivo y la licencia.
			expect((await pedirFirmado(deps, app, n, "/v1/sync/bootstrap")).status).toBe(503);

			// Desde aquí, la central no contesta, ni al Worker ni al TenantHub.
			n.interceptarLaCentral(() => Promise.reject(new Error("la base central no contesta")));
			const pedidasAntes = n.central.length;

			const descarga = await pedirFirmado(deps, app, n, "/v1/sync/bootstrap");
			expect(descarga.status).toBe(500);
			expect(await descarga.json()).toMatchObject({ ok: false, code: "internal", error: "internal_error" });

			const vacia = await inicializarVacia(n);
			expect(vacia.status).toBe(500);
			expect(hub.estaAprovisionado()).toBe(false);
			// Las dos han llegado a preguntárselo, y la central no ha contestado.
			expect(n.central.slice(pedidasAntes).filter((q) => /activated_at_ms IS NOT NULL/.test(q))).toHaveLength(2);
		});
	});
});
