// test/centralNoDisponible.test.ts
//
// Cuando la base central no puede atender, la respuesta HTTP es la misma que cuando no atiende el
// objeto de un negocio (`lib/enElHub.ts`): un 503 `external`, no un 500 de fallo del programa ni un
// 401 de token malo (`server/central/sinLaCentral.ts`).
//
//   · saturada: `hub_overloaded` con `Retry-After`; un fallo pasajero de la plataforma o un plazo
//     vencido: `hub_unavailable`. Lo marca `clienteCentral` (`CentralNoDisponible`);
//   · sin aprovisionar, una operación que no conoce, una migración alterada o fallida
//     (`ErrorDeLaCentral` con 503): `hub_unavailable`, sin `Retry-After`;
//   · cada vez, un evento `central_no_disponible` en Axiom con el motivo; a Sentry, sólo lo que no es
//     carga ni un fallo pasajero de la plataforma, tampoco desde el `catch` del piloto del feed;
//   · en `tenantAuth`, sólo un token o una firma que no valen son un 401: cualquier fallo de la central,
//     marcado o no, sube al `onError`.
//
// La central es la de verdad (`centralSinAprovisionar`) o un objeto que falla como dice Cloudflare
// (`overloaded`, `retryable`), siempre detrás del `clienteCentral` de producción: el doble de
// `getDb` sólo decide sobre qué objeto habla.

import { env as entorno } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { centralDePrueba, centralSinAprovisionar } from "./helpers/central";

const { capturados } = vi.hoisted(() => ({ capturados: [] as { operacion: string; mensaje: string }[] }));
let central: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => central };
});

vi.mock("../src/observability/errors", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/errors")>();
	return {
		...original,
		capturarError: (error: unknown, operacion: string) => {
			if (!original.esRechazoEsperado(error)) {
				capturados.push({ operacion, mensaje: String((error as any)?.message ?? error) });
			}
			original.capturarError(error, operacion);
		},
	};
});

const { app } = await import("../src/app");
const { clienteCentral } = await import("../src/server/central/cliente");
const { MENSAJES } = await import("../src/lib/errorCodes");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLoQueLeeElFeed } = await import("../src/domains/updates/updates.routes");

const env = entorno as any;

/** Con Axiom configurado: lo que se le manda, en `enviados`. */
const AXIOM = { AXIOM_TOKEN: "token-de-pruebas", AXIOM_DATASET_SYNC: "sync-de-pruebas" };
let enviados: any[] = [];

// ── Los fallos, como los marca Cloudflare ─────────────────────────────────────

const saturada = () =>
	Object.assign(new Error("Durable Object is overloaded. Too many requests queued."), { overloaded: true });
const pasajera = () =>
	Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true });
/** Saturada viene marcada también como `retryable`: lo que manda es que está saturada. */
const saturadaYPasajera = () =>
	Object.assign(new Error("Durable Object is overloaded. Requests queued for too long."), {
		overloaded: true,
		retryable: true,
	});

/** Una central cuyo objeto contesta con `responder` a todo (lanzando, si es un fallo de la plataforma). */
function centralQue(responder: () => Promise<unknown>, opciones: { plazoMs?: number } = {}) {
	const objeto = { ejecutar: responder, lote: responder, operar: responder };
	return clienteCentral(() => objeto as any, opciones);
}

const lanza = (fallo: () => Error) => () => Promise.reject(fallo());

// ── Las peticiones ─────────────────────────────────────────────────────────────

/** El feed de actualizaciones: anónimo, y lo primero que hace es leer la central. */
const pedirElFeed = () =>
	app.request("https://tpv-api.test/v1/update/windows/x86_64/1.0.0", {}, { ...env, ...AXIOM, LIMITADOR_ACTUALIZACIONES: undefined });

/** Una ruta con `tenantAuth`, con un token bueno: lo primero que lee es el dispositivo, en la central. */
async function pedirAutenticada(): Promise<Response> {
	const deviceId = `equipo-${crypto.randomUUID()}`;
	const token = await firmarSesion(env, { tenantId: "negocio-sin-central", deviceId, licHash: "hash" });
	return app.request(
		"https://tpv-api.test/v1/interruptores",
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"X-Device-Ts": String(Date.now()),
				"X-Device-Sig": `${"A".repeat(86)}==`,
				"content-type": "application/json",
			},
			body: "{}",
		},
		{ ...env, ...AXIOM },
	);
}

/** El WebSocket: el canje del ticket es un lote en la central. */
const pedirElSocket = () =>
	app.request("https://tpv-api.test/ws?ticket=un-ticket", {}, { ...env, ...AXIOM, LIMITADOR_SESION: undefined });

beforeEach(() => {
	capturados.length = 0;
	enviados = [];
	olvidarLoQueLeeElFeed();
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		enviados.push(...JSON.parse(String(init.body)));
		return new Response("{}", { status: 200 });
	});
});

afterEach(() => {
	central = null;
	vi.unstubAllGlobals();
});

async function eventosDeLaCentral(cuantos: number) {
	await vi.waitFor(() => expect(enviados.filter((e) => e.event === "central_no_disponible")).toHaveLength(cuantos));
	return enviados.filter((e) => e.event === "central_no_disponible");
}

describe("la central saturada", () => {
	it("503 `hub_overloaded` con Retry-After, sin Sentry, y su evento en Axiom", async () => {
		for (const fallo of [saturada, saturadaYPasajera]) {
			central = centralQue(lanza(fallo));
			const res = await pedirElFeed();

			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).toBe("2");
			expect(await res.json()).toEqual({
				ok: false,
				code: "external",
				error: "hub_overloaded",
				message: MENSAJES.hub_overloaded,
			});
		}
		// Es carga, no algo que arreglar.
		expect(capturados).toEqual([]);
		const eventos = await eventosDeLaCentral(2);
		expect(eventos.map((e) => [e.motivo, e.metodo, e.ruta])).toEqual([
			["saturada", "GET", "/v1/update/windows/x86_64/1.0.0"],
			["saturada", "GET", "/v1/update/windows/x86_64/1.0.0"],
		]);
		expect(eventos[0].error).toContain("overloaded");
	});

	it("pedido por un TPV (`X-Tpv-Device`): lo mismo, en un solo viaje y sin Sentry", async () => {
		let viajes = 0;
		const objeto = { ejecutar: lanza(saturada), lote: lanza(saturada), operar: lanza(saturada) };
		central = clienteCentral(() => {
			viajes++;
			return objeto as any;
		});
		const res = await app.request(
			"https://tpv-api.test/v1/update/windows/x86_64/1.0.0",
			{ headers: { "X-Tpv-Device": "equipo-de-un-bar" } },
			{ ...env, ...AXIOM, LIMITADOR_ACTUALIZACIONES: undefined },
		);

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("2");
		expect(viajes).toBe(1);
		expect(capturados).toEqual([]);
		expect((await eventosDeLaCentral(1))[0].motivo).toBe("saturada");
	});

	it("con las versiones ya leídas, saturada al mirar si el equipo es piloto: `stable`, sin Sentry", async () => {
		const nombre = `central-sin-piloto-${crypto.randomUUID()}`;
		const { db } = await centralDePrueba(nombre);
		await db.execute({
			sql: `INSERT INTO app_releases (version, target, arch, channel, notes, pub_date, signature, url, is_active)
			      VALUES ('1.1.0', 'windows', 'x86_64', 'stable', '', '2026-01-01', 'sig', 'https://cdn.test/1.1.0.exe', 1);`,
		});
		const id = env.BaseCentral.idFromName(nombre);
		central = clienteCentral(() => {
			const real = env.BaseCentral.get(id);
			return {
				ejecutar: (s: { sql: string }) => (/JOIN tenants/.test(s.sql) ? Promise.reject(saturada()) : real.ejecutar(s)),
				lote: (s: unknown) => real.lote(s),
				operar: (n: string, d: unknown) => real.operar(n, d),
			} as any;
		});
		const res = await app.request(
			"https://tpv-api.test/v1/update/windows/x86_64/1.0.0",
			{ headers: { "X-Tpv-Device": "equipo-de-un-bar" } },
			{ ...env, ...AXIOM, LIMITADOR_ACTUALIZACIONES: undefined },
		);

		expect(res.status).toBe(200);
		expect(((await res.json()) as any).version).toBe("1.1.0");
		expect(capturados).toEqual([]);
	});
});

describe("un fallo pasajero o un plazo vencido", () => {
	it("un fallo pasajero de la plataforma: 503 `hub_unavailable`, sin Retry-After ni Sentry", async () => {
		central = centralQue(lanza(pasajera));
		const res = await pedirElFeed();

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBeNull();
		expect(await res.json()).toEqual({
			ok: false,
			code: "external",
			error: "hub_unavailable",
			message: MENSAJES.hub_unavailable,
		});
		expect(capturados).toEqual([]);
		expect((await eventosDeLaCentral(1))[0].motivo).toBe("pasajera");
	});

	it("un plazo vencido: lo mismo, pero va a Sentry: la central no ha contestado a tiempo", async () => {
		central = centralQue(() => new Promise(() => {}), { plazoMs: 10 });
		const res = await pedirElFeed();

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBeNull();
		expect(((await res.json()) as any).error).toBe("hub_unavailable");
		expect(capturados).toEqual([{ operacion: "GET /v1/update/:target/:arch/:current", mensaje: "hub_unavailable" }]);
		expect((await eventosDeLaCentral(1))[0].motivo).toBe("plazo");
	});
});

describe("la central sin aprovisionar o averiada", () => {
	it("sin aprovisionar (el objeto de verdad): 503 `hub_unavailable` sin Retry-After, y Sentry lo ve", async () => {
		central = centralSinAprovisionar().db;
		const res = await pedirElFeed();

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBeNull();
		expect(await res.json()).toEqual({
			ok: false,
			code: "external",
			error: "hub_unavailable",
			message: MENSAJES.hub_unavailable,
		});
		expect(capturados).toEqual([
			{ operacion: "GET /v1/update/:target/:arch/:current", mensaje: expect.stringContaining("central_sin_aprovisionar") },
		]);
		const [evento] = await eventosDeLaCentral(1);
		expect(evento.motivo).toBe("central_sin_aprovisionar");
	});

	it("una migración alterada o fallida, o una operación que no conoce: igual, con su motivo", async () => {
		for (const codigo of ["central_migracion_alterada", "central_migracion_fallida", "central_operacion_desconocida"]) {
			central = centralQue(async () => ({ ok: false, error: codigo, detalle: "prueba" }));
			const res = await pedirElFeed();
			expect(res.status, codigo).toBe(503);
			expect(res.headers.get("Retry-After"), codigo).toBeNull();
			expect(((await res.json()) as any).error, codigo).toBe("hub_unavailable");
		}
		expect(capturados.map((c) => c.mensaje)).toEqual([
			"central_migracion_alterada: prueba",
			"central_migracion_fallida: prueba",
			"central_operacion_desconocida: prueba",
		]);
		expect((await eventosDeLaCentral(3)).map((e) => e.motivo)).toEqual([
			"central_migracion_alterada",
			"central_migracion_fallida",
			"central_operacion_desconocida",
		]);
	});
});

describe("lo que no es «no puede atender» sigue su camino", () => {
	it("un error de SQL es un 500, sin evento de la central", async () => {
		central = centralQue(async () => ({ ok: false, error: "central_error_sql", detalle: "no such table: x" }));
		const res = await pedirElFeed();

		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).not.toContain("no such table");
		expect(capturados.map((c) => c.mensaje)).toEqual(["central_error_sql: no such table: x"]);
		expect(enviados.filter((e) => e.event === "central_no_disponible")).toEqual([]);
	});

	it("cualquier otro fallo del viaje, el 500 de siempre", async () => {
		central = centralQue(lanza(() => new Error("Serialized RPC arguments or return values are limited to 32MiB")));
		const res = await pedirElFeed();

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).error).toBe("internal_error");
	});
});

describe("en los sitios que no pasan por el `onError`", () => {
	it("`tenantAuth`: la central saturada no es un 401, ni un rechazo del dispositivo", async () => {
		central = centralQue(lanza(saturada));
		const res = await pedirAutenticada();

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("2");
		expect(((await res.json()) as any).error).toBe("hub_overloaded");
		const [evento] = await eventosDeLaCentral(1);
		expect(evento.ruta).toBe("/v1/interruptores");
		expect(enviados.filter((e) => e.event === "device_auth_rechazado")).toEqual([]);
	});

	it("`tenantAuth` con la central sin aprovisionar: 503, no 401", async () => {
		central = centralSinAprovisionar().db;
		const res = await pedirAutenticada();
		expect(res.status).toBe(503);
		expect(((await res.json()) as any).error).toBe("hub_unavailable");
	});

	it("`tenantAuth` con un fallo del viaje que la plataforma no marca: el 500 de siempre, no un 401", async () => {
		central = centralQue(lanza(() => new Error("Durable Object exceeded its memory limit and was reset.")));
		const res = await pedirAutenticada();

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ ok: false, error: "internal_error" });
		expect(capturados.map((c) => c.mensaje)).toEqual(["Durable Object exceeded its memory limit and was reset."]);
	});

	it("el WebSocket: un fallo pasajero al canjear el ticket es un 503, no un 500", async () => {
		central = centralQue(lanza(pasajera));
		const res = await pedirElSocket();

		expect(res.status).toBe(503);
		expect(((await res.json()) as any).error).toBe("hub_unavailable");
		expect(capturados).toEqual([]);
		expect((await eventosDeLaCentral(1))[0]).toMatchObject({ motivo: "pasajera", ruta: "/ws" });
	});
});
