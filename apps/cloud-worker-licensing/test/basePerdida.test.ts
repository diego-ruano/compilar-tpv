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

import { HANDY, MAIN, conNegocioFirmado, pedirFirmado, peticionFirmada, type Negocio } from "./helpers/negocioFirmado";

let dbCentral: unknown = null;
const { avisos } = vi.hoisted(() => ({ avisos: [] as string[] }));

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbCentral };
});

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
const deps = {
	ponerCentral: (db: unknown) => void (dbCentral = db),
	firmarSesion,
	olvidarLicenciasCacheadas,
};

const USUARIO = "00000000-0000-7000-8000-000000000001";
const PERDIDA = { ok: false, code: "external", error: "tenant_db_perdida", message: MENSAJES.tenant_db_perdida };

/**
 * Un negocio con licencia y sin base. La base central va en el SQLite de su propio TenantHub, para
 * que también la lea la ruta que se ejecuta dentro de él.
 */
const sinBase = <R>(nombre: string, prueba: (n: Negocio, hub: any) => Promise<R>) =>
	conNegocioFirmado(deps, nombre, prueba, { sinBase: true, centralEnElNegocio: true });

/** Como lo deja el alta mientras la licencia no se ha activado: el negocio no ha nacido. */
const sinNacer = (n: Negocio) =>
	n.enCentral(`UPDATE licenses SET activated_at_ms = NULL WHERE tenant_id = ?;`, n.tenantId);

const inicializarVacia = async (n: Negocio) =>
	app.request(await peticionFirmada(deps, n, MAIN, "POST", "/v1/sync/initialize-empty"), undefined, env);

const avisosDeBasePerdida = () => avisos.filter((operacion) => operacion === "tenant_db.perdida").length;

beforeEach(() => {
	avisos.length = 0;
	olvidarAvisosDeBasePerdida();
});

describe("la base sólo se crea para un negocio que no ha nacido", () => {
	const central = (nacido: boolean) =>
		({ execute: async () => ({ rows: nacido ? [{ 1: 1 }] : [] }) }) as any;
	const stub = (tenantId: string) => env.TenantHub.get(env.TenantHub.idFromName(tenantId));

	it("un negocio que no ha nacido estrena su base; con ella ya creada, no hay nada que hacer", async () => {
		const tenantId = "base-perdida-nace";
		expect(await provisionTenantDatabase(central(false), env, tenantId)).toEqual({ reused: false });
		expect(await stub(tenantId).estaAprovisionado()).toBe(true);
		// Ya nacido y con su base: lo de siempre.
		expect(await provisionTenantDatabase(central(true), env, tenantId)).toEqual({ reused: true });
	});

	it("uno que ya nació y no la tiene no recibe una vacía", async () => {
		const tenantId = "base-perdida-nacido";
		await expect(provisionTenantDatabase(central(true), env, tenantId)).rejects.toMatchObject({
			code: "tenant_db_perdida",
			status: 503,
		});
		expect(await stub(tenantId).estaAprovisionado()).toBe(false);
	});

	it("si la base central no contesta, tampoco", async () => {
		const tenantId = "base-perdida-sin-central";
		const caida = { execute: async () => Promise.reject(new Error("la base central no contesta")) } as any;
		await expect(provisionTenantDatabase(caida, env, tenantId)).rejects.toThrow("la base central no contesta");
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
				env,
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
			sinNacer(n);

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

			const caida = async () => Promise.reject(new Error("la base central no contesta"));
			deps.ponerCentral({ execute: caida, batch: caida });

			const descarga = await pedirFirmado(deps, app, n, "/v1/sync/bootstrap");
			expect(descarga.status).toBe(500);
			expect(await descarga.json()).toMatchObject({ ok: false, code: "internal", error: "internal_error" });

			const vacia = await inicializarVacia(n);
			expect(vacia.status).toBe(500);
			expect(hub.estaAprovisionado()).toBe(false);
		});
	});
});
