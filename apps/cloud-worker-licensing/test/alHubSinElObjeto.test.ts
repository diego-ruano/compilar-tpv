// test/alHubSinElObjeto.test.ts
//
// Las rutas de negocio viajan enteras al TenantHub (`lib/enElHub.ts`). Si ese viaje falla porque el
// objeto no está para atender —saturado, reiniciándose tras un despliegue— no es un fallo del
// programa, y salía como uno: `internal_error`, 500. Ahora:
//
// - saturado: 503 `hub_overloaded` con `Retry-After`, sin repetir (sería más carga);
// - un fallo pasajero en una lectura: se repite una vez, con una petición y un stub nuevos;
// - lo demás: 503 `hub_unavailable`.
//
// Los dos salen como `external`. Los fallos de la plataforma no se pueden provocar en workerd, así
// que el objeto es aquí un doble que falla como dice Cloudflare (`overloaded`, `retryable`); el
// último test pasa por el RPC de verdad, con una excepción lanzada dentro del DO.

import { env as entorno } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enElHub } from "./helpers/hub";
import { MAIN, conNegocioFirmado, peticionFirmada } from "./helpers/negocioFirmado";

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
const { alHub } = await import("../src/lib/enElHub");
const { lecturaPorPost } = await import("../src/lib/rutas");
const { MENSAJES, wireToCode } = await import("../src/lib/errorCodes");
const { completarErrores } = await import("../src/middleware/completarErrores");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");

const env = entorno as any;
const deps = { firmarSesion, olvidarLicenciasCacheadas };

// ── Los fallos, como los marca Cloudflare ─────────────────────────────────────

const saturado = () =>
	Object.assign(new Error("Durable Object is overloaded. Too many requests queued."), { overloaded: true });
const pasajero = () =>
	Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true });
/** Saturado viene marcado también como `retryable`: lo que manda es que está saturado. */
const saturadoYPasajero = () =>
	Object.assign(new Error("Durable Object is overloaded. Requests queued for too long."), {
		overloaded: true,
		retryable: true,
	});
const otro = () => new Error("Serialized RPC arguments or return values are limited to 32MiB");

// ── Un router con `alHub` y un objeto de mentira ──────────────────────────────

type Llamada = { metodo: string; ruta: string; cuerpo: string; rol: string; stub: number };

/** Lo que hace el objeto en cada llamada, en orden: contestar o fallar. */
function montar(guion: (() => Response | Error)[]) {
	const llamadas: Llamada[] = [];
	let stubs = 0;
	const TenantHub = {
		idFromName: (nombre: string) => nombre,
		get: () => {
			const stub = ++stubs;
			return {
				async ejecutarRuta(peticion: Request, identidad: { rol: string }) {
					llamadas.push({
						metodo: peticion.method,
						ruta: new URL(peticion.url).pathname,
						cuerpo: await peticion.text(),
						rol: identidad.rol,
						stub,
					});
					const paso = guion.shift();
					if (!paso) throw new Error("el guion no esperaba otra llamada");
					const r = paso();
					if (r instanceof Error) throw r;
					return r;
				},
			};
		},
	};

	const rutas = new Hono<any>();
	rutas.use("*", completarErrores);
	rutas.use("/busqueda", lecturaPorPost());
	rutas.use(
		"*",
		async (c, next) => {
			c.set("tenantId", "negocio-del-doble");
			c.set("deviceId", "equipo");
			c.set("token", "token");
			c.set("licHash", "hash");
			c.set("rol", "tpv");
			await next();
		},
		alHub,
	);
	// Con `alHub` delante, estas no llegan a ejecutarse en el Worker.
	rutas.all("*", (c) => c.json({ donde: "worker" }));

	const pedir = (metodo: string, ruta: string, cuerpo?: unknown, entorno: Record<string, unknown> = {}) =>
		rutas.request(
			ruta,
			{
				method: metodo,
				...(cuerpo === undefined
					? {}
					: { body: JSON.stringify(cuerpo), headers: { "content-type": "application/json" } }),
			},
			{ TenantHub, ...entorno },
		);

	return { llamadas, pedir };
}

const delObjeto = () => Response.json({ donde: "objeto" });

beforeEach(() => {
	capturados.length = 0;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("el objeto del negocio está saturado", () => {
	it("contesta 503 con Retry-After y no repite la petición, aunque sea una lectura", async () => {
		for (const fallo of [saturado, saturadoYPasajero]) {
			const { llamadas, pedir } = montar([fallo]);
			const res = await pedir("GET", "/lectura");

			expect(res.status).toBe(503);
			expect(res.headers.get("Retry-After")).toBe("2");
			expect(await res.json()).toEqual({
				ok: false,
				code: "external",
				error: "hub_overloaded",
				message: MENSAJES.hub_overloaded,
			});
			expect(llamadas).toHaveLength(1);
		}
		// Es carga, no un fallo que arreglar: no va a Sentry.
		expect(capturados).toEqual([]);
	});
});

describe("un fallo pasajero del objeto", () => {
	it("en una lectura se repite una vez, con una petición y un stub nuevos", async () => {
		const { llamadas, pedir } = montar([pasajero, delObjeto]);
		const res = await pedir("GET", "/lectura?desde=2026-11-01");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ donde: "objeto" });
		expect(llamadas.map((l) => [l.metodo, l.ruta, l.rol])).toEqual([
			["GET", "/lectura", "tpv"],
			["GET", "/lectura", "tpv"],
		]);
		expect(llamadas.map((l) => l.stub)).toEqual([1, 2]);
		expect(capturados).toEqual([]);
	});

	it("una lectura que va por POST también, con su cuerpo entero", async () => {
		const { llamadas, pedir } = montar([pasajero, delObjeto]);
		const res = await pedir("POST", "/busqueda", { query: "croquetas" });

		expect(res.status).toBe(200);
		expect(llamadas.map((l) => l.cuerpo)).toEqual(['{"query":"croquetas"}', '{"query":"croquetas"}']);
	});

	it("si la repetición también falla, 503 `hub_unavailable`: no se insiste más", async () => {
		const { llamadas, pedir } = montar([pasajero, pasajero, delObjeto]);
		const res = await pedir("GET", "/lectura");

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBeNull();
		expect(await res.json()).toEqual({
			ok: false,
			code: "external",
			error: "hub_unavailable",
			message: MENSAJES.hub_unavailable,
		});
		expect(llamadas).toHaveLength(2);
		expect(capturados).toEqual([]);
	});

	it("si en la repetición está saturado, lo dice con su Retry-After", async () => {
		const { llamadas, pedir } = montar([pasajero, saturado]);
		const res = await pedir("GET", "/lectura");

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("2");
		expect((await res.json() as any).error).toBe("hub_overloaded");
		expect(llamadas).toHaveLength(2);
	});

	it("una escritura no se repite aquí: la repite el cliente con su misma clave", async () => {
		for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) {
			const { llamadas, pedir } = montar([pasajero, delObjeto]);
			const res = await pedir(metodo, "/escritura", { nombre: "Ana" });

			expect(res.status, metodo).toBe(503);
			expect((await res.json() as any).error, metodo).toBe("hub_unavailable");
			expect(llamadas, metodo).toHaveLength(1);
		}
	});
});

describe("cualquier otro fallo del viaje", () => {
	it("es un 503 `external`, no un `internal_error`, y va a Sentry: puede haber algo que arreglar", async () => {
		for (const metodo of ["GET", "POST"]) {
			capturados.length = 0;
			const { llamadas, pedir } = montar([otro, delObjeto]);
			const res = await pedir(metodo, "/lectura", metodo === "GET" ? undefined : {});

			expect(res.status, metodo).toBe(503);
			expect(await res.json(), metodo).toEqual({
				ok: false,
				code: "external",
				error: "hub_unavailable",
				message: MENSAJES.hub_unavailable,
			});
			// Sin la marca de pasajero no se repite ni una lectura.
			expect(llamadas, metodo).toHaveLength(1);
			expect(capturados, metodo).toEqual([
				{ operacion: "hub.ejecutar_ruta", mensaje: expect.stringContaining("32MiB") },
			]);
		}
	});

	it("los dos identificadores son `external` también para quien sólo vea el identificador", () => {
		for (const status of [500, 503]) {
			expect(wireToCode("hub_overloaded", status)).toBe("external");
			expect(wireToCode("hub_unavailable", status)).toBe("external");
		}
	});
});

describe("lo que queda anotado", () => {
	it("cada vez que el objeto no atiende, un evento en Axiom con el motivo y sin el cuerpo", async () => {
		const enviados: any[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			enviados.push(...JSON.parse(String(init.body)));
			return new Response("{}", { status: 200 });
		});
		const axiom = { AXIOM_TOKEN: "token-de-pruebas", AXIOM_DATASET_SYNC: "sync-de-pruebas" };

		const sat = montar([saturado]);
		await sat.pedir("GET", "/lectura", undefined, axiom);
		const rep = montar([pasajero, pasajero]);
		await rep.pedir("GET", "/lectura", undefined, axiom);
		const esc = montar([otro]);
		await esc.pedir("POST", "/escritura", { nombre: "Ana López" }, axiom);

		await vi.waitFor(() => expect(enviados).toHaveLength(3));
		expect(enviados.map((e) => [e.event, e.tenant_id, e.motivo, e.repetida, e.metodo, e.ruta])).toEqual([
			["hub_no_disponible", "negocio-del-doble", "saturado", false, "GET", "/lectura"],
			["hub_no_disponible", "negocio-del-doble", "pasajero", true, "GET", "/lectura"],
			["hub_no_disponible", "negocio-del-doble", "otro", false, "POST", "/escritura"],
		]);
		expect(JSON.stringify(enviados)).not.toContain("Ana López");
	});
});

describe("por el RPC de verdad", () => {
	it("una excepción que sale de `ejecutarRuta` no llega al cliente como `internal_error`", async () => {
		await conNegocioFirmado(deps, "sin-el-objeto", async (n) => {
			// Fuera de la `app`: lo que una ruta lanza dentro lo recoge su `onError`, y no llega aquí.
			await enElHub(n.tenantId, (hub: any) => {
				hub.ejecutarRuta = async () => {
					throw new Error("el objeto no ha podido atender (prueba)");
				};
			});

			const res = await app.request(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"), undefined, {
				...env,
				...n.entorno,
			});
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({
				ok: false,
				code: "external",
				error: "hub_unavailable",
				message: MENSAJES.hub_unavailable,
			});
			expect(capturados.map((c) => c.operacion)).toEqual(["hub.ejecutar_ruta"]);
		});
	});
});
