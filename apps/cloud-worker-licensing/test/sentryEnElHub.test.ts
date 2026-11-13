// test/sentryEnElHub.test.ts
//
// Una ruta de negocio se ejecuta dentro del TenantHub (`lib/enElHub.ts`), y para Sentry tiene que
// ser una petición como las del Worker: su ámbito de aislamiento y su cliente. Sin eso, el SDK deja
// las etiquetas de cada petición (`registrarPeticion`, `registrarCuerpoValidado`) en el ámbito
// global del isolate, que comparten todas las peticiones y los DO de todos los negocios, y lo que
// se captura dentro de una ruta que llega sin los datos de traza del Worker se pierde.
//
// Va con el SDK de verdad: lo único que se le cambia son las opciones al entrar, que llevan un DSN
// de mentira y un transporte que apunta lo que se le entrega en vez de mandarlo.

import { createExecutionContext, env as entorno, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { enElHub } from "./helpers/hub";
import { MAIN, conNegocioFirmado, peticionFirmada, viajes, type Negocio } from "./helpers/negocioFirmado";

const { enviados } = vi.hoisted(() => ({ enviados: [] as any[] }));
let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbCentral };
});

vi.mock("@sentry/cloudflare", async (importOriginal) => {
	const sdk = await importOriginal<typeof import("@sentry/cloudflare")>();
	const conTransporte = (opciones: any) => ({
		...opciones,
		dsn: "https://public@sentry.invalid/1",
		transport: () => ({
			send: async (sobre: unknown) => {
				enviados.push(structuredClone(sobre));
				return { statusCode: 200 };
			},
			flush: async () => true,
		}),
	});
	return {
		...sdk,
		withSentry: (opciones: any, handler: any) => sdk.withSentry((env: any) => conTransporte(opciones(env)), handler),
		instrumentDurableObjectWithSentry: (opciones: any, clase: any) =>
			sdk.instrumentDurableObjectWithSentry((env: any) => conTransporte(opciones(env)), clase),
		wrapRequestHandler: (envoltorio: any, manejar: any) =>
			sdk.wrapRequestHandler({ ...envoltorio, options: conTransporte(envoltorio.options) }, manejar),
	};
});

const Sentry = await import("@sentry/cloudflare");
const { default: worker } = await import("../src/index");
const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");

const env = entorno as any;
const deps = {
	ponerCentral: (db: unknown) => void (dbCentral = db),
	firmarSesion,
	olvidarLicenciasCacheadas,
};

/** Los eventos de error que el SDK ha entregado al transporte. */
function eventos(): any[] {
	return enviados.flatMap((sobre) =>
		sobre[1].filter((item: any) => item[0].type === "event").map((item: any) => item[1]),
	);
}

/** Por el `fetch` del worker, como en producción: Sentry delante y el entorno instrumentado. */
async function porElWorker(peticion: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch!(peticion as any, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** Hace que la base del negocio no abra: la ruta falla dentro del DO con un error inesperado. */
async function romperLaBase(n: Negocio, motivo: string): Promise<void> {
	await enElHub(n.tenantId, (hub: any) => {
		hub.getTenantDb = async () => {
			throw new Error(motivo);
		};
	});
}

/** Espera a que el DO entregue lo capturado (lo hace por `waitUntil`, después de contestar). */
async function esperarEventos(cuantos: number): Promise<any[]> {
	await vi.waitFor(() => expect(eventos().length).toBeGreaterThanOrEqual(cuantos), { timeout: 5_000 });
	return eventos();
}

beforeEach(() => {
	enviados.length = 0;
});

describe("un fallo dentro de una ruta que corre en el TenantHub llega a Sentry", () => {
	it("con su operación, por el camino de producción (Worker con Sentry → RPC → DO)", async () => {
		await conNegocioFirmado(deps, "sentry-worker", async (n) => {
			await romperLaBase(n, "la base no abre (prueba del worker)");

			const res = await porElWorker(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"));
			expect(res.status).toBe(500);
			expect(viajes(res, "hub-ruta")).toBe(1);
			expect(await res.json()).toMatchObject({ ok: false, error: "internal_error" });

			const [evento, ...resto] = await esperarEventos(1);
			expect(resto).toEqual([]);
			expect(evento.exception.values[0].value).toContain("la base no abre (prueba del worker)");
			expect(evento.tags).toMatchObject({ operation: "GET /v1/login/users" });
			expect(evento.request.url).toBe("https://tpv-api.test/v1/login/users");

			// Lo que identifica a quien llama no sale: ni el token ni la firma del dispositivo.
			const salida = JSON.stringify(enviados);
			expect(salida).not.toContain("Bearer ");
			expect(salida).not.toMatch(/x-device-sig/i);
		});
	});

	it("también cuando la llamada llega sin los datos de traza del Worker", async () => {
		await conNegocioFirmado(deps, "sentry-sin-traza", async (n) => {
			await romperLaBase(n, "la base no abre (prueba sin traza)");

			// `app.request` no pasa por `withSentry`: el entorno no va instrumentado y el RPC sale
			// sin `__sentry_rpc_meta__`, así que el SDK no envuelve el método del DO.
			const res = await app.request(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"), undefined, env);
			expect(res.status).toBe(500);
			expect(viajes(res, "hub-ruta")).toBe(1);

			const [evento, ...resto] = await esperarEventos(1);
			expect(resto).toEqual([]);
			expect(evento.exception.values[0].value).toContain("la base no abre (prueba sin traza)");
			expect(evento.tags).toMatchObject({ operation: "GET /v1/login/users" });
		});
	});
});

describe("las etiquetas de una petición acaban con ella", () => {
	it("no pasan a la petición siguiente ni al fallo de otro negocio", async () => {
		await conNegocioFirmado(deps, "sentry-a", async (a) => {
			// Un negocio deja en su ámbito la versión del cliente y los importes de su cuerpo.
			const conEtiquetas = { cabeceras: { "X-TPV-Version": "9.9.9", "X-TPV-Variant": "android" } };
			const lectura = await porElWorker(await peticionFirmada(deps, a, MAIN, "GET", "/v1/login/users", conEtiquetas));
			expect(lectura.status).toBe(200);
			const escritura = await porElWorker(
				await peticionFirmada(deps, a, MAIN, "POST", "/v1/inventario/categorias", {
					...conEtiquetas,
					cuerpo: { id_categoria: null, nombre: "Bebidas", vendible: true, pasa_cocina: false },
				}),
			);
			// Validada (ahí se apunta el cuerpo) y rechazada después: sin Main conectada no se escribe.
			expect(escritura.status).toBe(400);
			expect(await escritura.json()).toMatchObject({ error: "main_offline" });
			expect(eventos()).toEqual([]);
		});

		// Después, en el mismo isolate, falla una petición de otro negocio que no trae nada de eso.
		await conNegocioFirmado(deps, "sentry-b", async (b) => {
			await romperLaBase(b, "la base de otro negocio no abre");
			const res = await porElWorker(await peticionFirmada(deps, b, MAIN, "GET", "/v1/inventario/categorias"));
			expect(res.status).toBe(500);

			const [evento, ...resto] = await esperarEventos(1);
			expect(resto).toEqual([]);
			expect(evento.tags.operation).toBe("GET /v1/inventario/categorias");
			expect(evento.tags.client_version).toBeUndefined();
			expect(evento.tags.client_variant).toBeUndefined();
			expect(evento.contexts?.request_input).toBeUndefined();
			const salida = JSON.stringify(evento);
			expect(salida).not.toContain("9.9.9");
			expect(salida).not.toContain("android");
		});
	});

	it("ni se quedan en el ámbito global del isolate", async () => {
		await conNegocioFirmado(deps, "sentry-global", async (n) => {
			const res = await app.request(
				await peticionFirmada(deps, n, MAIN, "POST", "/v1/inventario/categorias", {
					cabeceras: { "X-TPV-Version": "9.9.9", "X-TPV-Variant": "android" },
					cuerpo: { id_categoria: null, nombre: "Bebidas", vendible: true, pasa_cocina: false },
				}),
				undefined,
				env,
			);
			expect(res.status).toBe(400);
			expect(viajes(res, "hub-ruta")).toBe(1);

			// Aquí fuera no hay ninguna petición en curso: es el ámbito que ven todas al empezar. El
			// cuerpo se valida dentro del DO (`cuerpo(schema)` va detrás de `alHub`), y lo que se
			// apunta de él (`registrarCuerpoValidado`) no puede quedarse aquí.
			expect(Sentry.getIsolationScope().getScopeData().contexts.request_input).toBeUndefined();
		});
	});
});
