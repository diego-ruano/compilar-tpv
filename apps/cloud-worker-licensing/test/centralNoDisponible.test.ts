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
//     carga ni un fallo pasajero de la plataforma;
//   · el feed de actualizaciones no lee la central que no atiende como «no es piloto»: sale su 503,
//     no el 204 de «estás al día». Un error de SQL al mirarlo sigue siendo «no», y va a Sentry;
//   · en `tenantAuth`, sólo un token o una firma que no valen son un 401: cualquier fallo de la central,
//     marcado o no, sube al `onError`.
//
// La central es la de verdad (`centralSinAprovisionar`), o una cuyo stub falla como dice Cloudflare
// (`overloaded`, `retryable`) o contesta lo que haga falta (`centralInterceptada`). La ruta llega a
// ella como en producción, por `getDb(env)` y el `clienteCentral` de producción.

import { env as entorno } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	centralDePrueba,
	centralInterceptada,
	centralSinAprovisionar,
	type CentralDePrueba,
} from "./helpers/central";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";

const { capturados } = vi.hoisted(() => ({ capturados: [] as { operacion: string; mensaje: string }[] }));

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
const { CentralNoDisponible } = await import("../src/server/central/cliente");
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

/**
 * Una central cuyo stub contesta con `responder` a todo (lanzando, si es un fallo de la plataforma).
 * El objeto de detrás no llega a atender nada.
 */
function centralQue(responder: () => Promise<unknown>): CentralDePrueba {
	return centralInterceptada(centralSinAprovisionar(), () => responder());
}

const lanza = (fallo: () => Error) => () => Promise.reject(fallo());

// ── Las peticiones ─────────────────────────────────────────────────────────────

/** El feed de actualizaciones: anónimo, y lo primero que hace es leer la central. */
const pedirElFeed = (central: CentralDePrueba) =>
	app.request(
		"https://tpv-api.test/v1/update/windows/x86_64/1.0.0",
		{},
		{ ...env, ...AXIOM, LIMITADOR_ACTUALIZACIONES: undefined, ...central.entorno },
	);

/** Una ruta con `tenantAuth`, con un token bueno: lo primero que lee es el dispositivo, en la central. */
async function pedirAutenticada(central: CentralDePrueba): Promise<Response> {
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
		{ ...env, ...AXIOM, ...central.entorno },
	);
}

/** El WebSocket: el canje del ticket es un lote en la central. */
const pedirElSocket = (central: CentralDePrueba) =>
	app.request(
		"https://tpv-api.test/ws?ticket=un-ticket",
		{},
		{ ...env, ...AXIOM, LIMITADOR_SESION: undefined, ...central.entorno },
	);

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
	vi.unstubAllGlobals();
});

async function eventosDeLaCentral(cuantos: number) {
	await vi.waitFor(() => expect(enviados.filter((e) => e.event === "central_no_disponible")).toHaveLength(cuantos));
	return enviados.filter((e) => e.event === "central_no_disponible");
}

describe("la central saturada", () => {
	it("503 `hub_overloaded` con Retry-After, sin Sentry, y su evento en Axiom", async () => {
		for (const fallo of [saturada, saturadaYPasajera]) {
			const res = await pedirElFeed(centralQue(lanza(fallo)));

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
		const central = centralQue(() => {
			viajes++;
			return Promise.reject(saturada());
		});
		const res = await app.request(
			"https://tpv-api.test/v1/update/windows/x86_64/1.0.0",
			{ headers: { "X-Tpv-Device": "equipo-de-un-bar" } },
			{ ...env, ...AXIOM, LIMITADOR_ACTUALIZACIONES: undefined, ...central.entorno },
		);

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("2");
		expect(viajes).toBe(1);
		expect(capturados).toEqual([]);
		expect((await eventosDeLaCentral(1))[0].motivo).toBe("saturada");
	});

	it("con las versiones ya guardadas, saturada al mirar si el equipo es piloto: 503 `hub_overloaded`, no 204", async () => {
		// Sólo hay una beta. Leída la central saturada como «no es piloto», el equipo se quedaría sin
		// candidatas, y el 204 de entonces el updater lo entiende como «estás al día».
		const real = await centralDePrueba();
		await real.db.execute({
			sql: `INSERT INTO app_releases (version, target, arch, channel, notes, pub_date, signature, url, is_active)
			      VALUES ('1.2.0', 'windows', 'x86_64', 'beta', '', '2026-01-01', 'sig', 'https://cdn.test/1.2.0.exe', 1);`,
		});
		const viajes: string[] = [];
		const central = centralInterceptada(real, (metodo, [sentencia], llamar) => {
			const piloto = metodo === "ejecutar" && /JOIN tenants/.test((sentencia as SentenciaEnlazada).sql);
			viajes.push(piloto ? "piloto" : metodo);
			return piloto ? Promise.reject(saturada()) : llamar();
		});
		const pedir = (cabeceras: Record<string, string>) =>
			app.request(
				"https://tpv-api.test/v1/update/windows/x86_64/1.0.0",
				{ headers: cabeceras },
				{ ...env, ...AXIOM, LIMITADOR_ACTUALIZACIONES: undefined, ...central.entorno },
			);

		// Sin equipo no se pregunta por el piloto: las versiones se guardan, y no hay estable que dar.
		expect((await pedir({})).status).toBe(204);
		const res = await pedir({ "X-Tpv-Device": "equipo-de-un-bar" });

		// Las versiones salen de lo guardado: el único viaje de la segunda es el del piloto.
		expect(viajes).toEqual(["ejecutar", "piloto"]);
		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("2");
		expect(((await res.json()) as any).error).toBe("hub_overloaded");
		expect(capturados).toEqual([]);
		expect((await eventosDeLaCentral(1))[0].motivo).toBe("saturada");
	});
});

describe("un fallo pasajero o un plazo vencido", () => {
	it("un fallo pasajero de la plataforma: 503 `hub_unavailable`, sin Retry-After ni Sentry", async () => {
		const res = await pedirElFeed(centralQue(lanza(pasajera)));

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
		// Sólo se fija cómo contesta una ruta a la que le llegara este error. Hoy no le llega a ninguna:
		// `getDb` va sin plazo, y el único que lo pone es el TenantHub (`getCentralDb`), cuyos fallos no
		// pasan por el `onError`. Así que el error lo lanza el stub ya formado, como lo deja el cliente al
		// vencer (`conPlazo`); el temporizador de verdad se prueba en `centralCliente.test.ts` («con
		// plazo») y en el TenantHub (`mainDesplazadaSocket.test.ts`).
		const res = await pedirElFeed(centralQue(() => Promise.reject(new CentralNoDisponible("plazo"))));

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBeNull();
		expect(((await res.json()) as any).error).toBe("hub_unavailable");
		expect(capturados).toEqual([{ operacion: "GET /v1/update/:target/:arch/:current", mensaje: "hub_unavailable" }]);
		expect((await eventosDeLaCentral(1))[0].motivo).toBe("plazo");
	});
});

describe("la central sin aprovisionar o averiada", () => {
	it("sin aprovisionar (el objeto de verdad): 503 `hub_unavailable` sin Retry-After, y Sentry lo ve", async () => {
		const res = await pedirElFeed(centralSinAprovisionar());

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
			const res = await pedirElFeed(centralQue(async () => ({ ok: false, error: codigo, detalle: "prueba" })));
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
		const res = await pedirElFeed(centralQue(async () => ({ ok: false, error: "central_error_sql", detalle: "no such table: x" })));

		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).not.toContain("no such table");
		expect(capturados.map((c) => c.mensaje)).toEqual(["central_error_sql: no such table: x"]);
		expect(enviados.filter((e) => e.event === "central_no_disponible")).toEqual([]);
	});

	it("un error de SQL al mirar si el equipo es piloto: «no es piloto» y a Sentry, como siempre", async () => {
		const real = await centralDePrueba();
		await real.db.execute({
			sql: `INSERT INTO app_releases (version, target, arch, channel, notes, pub_date, signature, url, is_active)
			      VALUES ('1.1.0', 'windows', 'x86_64', 'stable', '', '2026-01-01', 'sig', 'https://cdn.test/1.1.0.exe', 1);`,
		});
		const central = centralInterceptada(real, (metodo, [sentencia], llamar) =>
			metodo === "ejecutar" && /JOIN tenants/.test((sentencia as SentenciaEnlazada).sql)
				? Promise.resolve({ ok: false, error: "central_error_sql", detalle: "no such column: t.piloto" })
				: llamar(),
		);
		const res = await app.request(
			"https://tpv-api.test/v1/update/windows/x86_64/1.0.0",
			{ headers: { "X-Tpv-Device": "equipo-de-un-bar" } },
			{ ...env, ...AXIOM, LIMITADOR_ACTUALIZACIONES: undefined, ...central.entorno },
		);

		expect(res.status).toBe(200);
		expect(((await res.json()) as any).version).toBe("1.1.0");
		expect(capturados).toEqual([{ operacion: "update.pilot_lookup", mensaje: "central_error_sql: no such column: t.piloto" }]);
		expect(enviados.filter((e) => e.event === "central_no_disponible")).toEqual([]);
	});

	it("cualquier otro fallo del viaje, el 500 de siempre", async () => {
		const res = await pedirElFeed(
			centralQue(lanza(() => new Error("Serialized RPC arguments or return values are limited to 32MiB"))),
		);

		expect(res.status).toBe(500);
		expect(((await res.json()) as any).error).toBe("internal_error");
	});
});

describe("en los sitios que no pasan por el `onError`", () => {
	it("`tenantAuth`: la central saturada no es un 401, ni un rechazo del dispositivo", async () => {
		const res = await pedirAutenticada(centralQue(lanza(saturada)));

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("2");
		expect(((await res.json()) as any).error).toBe("hub_overloaded");
		const [evento] = await eventosDeLaCentral(1);
		expect(evento.ruta).toBe("/v1/interruptores");
		expect(enviados.filter((e) => e.event === "device_auth_rechazado")).toEqual([]);
	});

	it("`tenantAuth` con la central sin aprovisionar: 503, no 401", async () => {
		const res = await pedirAutenticada(centralSinAprovisionar());
		expect(res.status).toBe(503);
		expect(((await res.json()) as any).error).toBe("hub_unavailable");
	});

	it("`tenantAuth` con un fallo del viaje que la plataforma no marca: el 500 de siempre, no un 401", async () => {
		const res = await pedirAutenticada(
			centralQue(lanza(() => new Error("Durable Object exceeded its memory limit and was reset."))),
		);

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ ok: false, error: "internal_error" });
		expect(capturados.map((c) => c.mensaje)).toEqual(["Durable Object exceeded its memory limit and was reset."]);
	});

	it("el WebSocket: un fallo pasajero al canjear el ticket es un 503, no un 500", async () => {
		const res = await pedirElSocket(centralQue(lanza(pasajera)));

		expect(res.status).toBe(503);
		expect(((await res.json()) as any).error).toBe("hub_unavailable");
		expect(capturados).toEqual([]);
		expect((await eventosDeLaCentral(1))[0]).toMatchObject({ motivo: "pasajera", ruta: "/ws" });
	});
});

describe("lo que queda en el log", () => {
	/** Lo que se escribe en la consola mientras dura el caso: cada llamada, con sus argumentos juntos. */
	function espiarLaConsola() {
		const escrito: { nivel: string; texto: string }[] = [];
		for (const nivel of ["error", "warn", "log"] as const) {
			vi.spyOn(console, nivel).mockImplementation((...argumentos: unknown[]) => {
				escrito.push({ nivel, texto: argumentos.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
			});
		}
		return escrito;
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** El camino lo escribe quien llama: aquí, con un correo en el lugar de la versión instalada. */
	const CON_UN_CORREO = "https://tpv-api.test/v1/update/windows/x86_64/ana@example.com";

	it("sin la central, la ruta va por su patrón, no por su camino: el correo no llega a la consola", async () => {
		const escrito = espiarLaConsola();
		const res = await app.request(CON_UN_CORREO, {}, {
			...env,
			...AXIOM,
			LIMITADOR_ACTUALIZACIONES: undefined,
			...centralSinAprovisionar().entorno,
		});
		await eventosDeLaCentral(1);

		expect(res.status).toBe(503);
		expect(escrito.filter((e) => e.texto.includes("ana@example.com"))).toEqual([]);
		expect(escrito).toContainEqual({
			nivel: "error",
			texto: expect.stringMatching(/^\[central\] GET \/v1\/update\/:target\/:arch\/:current → central_sin_aprovisionar/),
		});
	});

	it("en el `onError`, igual, y lo que dice el error sale filtrado", async () => {
		const escrito = espiarLaConsola();
		// Un error de SQL que cita lo que le ha llegado: sale por el `onError`, como un 500.
		const central = centralQue(async () => ({ ok: false, error: "central_error_sql", detalle: 'near "ana@example.com": syntax error' }));
		const res = await app.request(CON_UN_CORREO, {}, { ...env, ...AXIOM, LIMITADOR_ACTUALIZACIONES: undefined, ...central.entorno });

		expect(res.status).toBe(500);
		expect(escrito.filter((e) => e.texto.includes("ana@example.com"))).toEqual([]);
		expect(escrito).toContainEqual({
			nivel: "error",
			texto: expect.stringMatching(/^\[onError\] GET \/v1\/update\/:target\/:arch\/:current → ErrorDeLaCentral: central_error_sql: near "\[email\]": syntax error/),
		});
	});
});
