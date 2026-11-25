// test/centralNoDisponibleEnElHub.test.ts
//
// El `TenantHub` también le habla a la base central por su cuenta: para saber quién es la Main (al
// saludar un `tpv`, cada minuto con actividad, con el aviso de un cambio de licencia y antes de
// rechazar una ruta de un `tpv`) y para apuntar el `last_seen` de un equipo. Cuando la central no le
// atiende, queda lo mismo que en el Worker (`server/central/sinLaCentral.ts`):
//
//   · cada vez, el evento `central_no_disponible` en Axiom, con el motivo, `metodo: "hub"` y, en
//     `ruta`, lo que hacía el hub (`sync.main_vigente`, `sync.last_seen`);
//   · a Sentry, sólo lo que no es carga ni un fallo pasajero de la plataforma: un rechazo del viaje
//     sin marcas, con su causa, o un plazo vencido. Con la central saturada, cada hub con actividad
//     no puede mandar un evento por minuto, y otro por equipo cada cinco;
//   · lo que la central lanza por otra cosa (un error de SQL) no es «no puede atender»: va a Sentry,
//     como siempre, y no deja el evento. Un saludo que no vale (la firma) tampoco deja nada.
//
// El hub es el de verdad, con la central puesta (`ponerLaCentral`) y su stub fallando como dice
// Cloudflare (`centralInterceptada`), y con Axiom configurado: lo que se le manda, en `enviados`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { centralInterceptada, centralSinAprovisionar, type CentralDePrueba } from "./helpers/central";
import { enElHub, ponerLaCentral } from "./helpers/hub";
import { laTablaDiceQueLaMainEs } from "./helpers/mainVigente";

const { capturados } = vi.hoisted(() => ({
	capturados: [] as { operacion: string; mensaje: string; causa?: string }[],
}));

// Lo que se manda a Sentry: la operación, el mensaje y, si lo lleva, el de su causa.
vi.mock("../src/observability/errors", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/errors")>();
	return {
		...original,
		capturarError: (error: unknown, operacion: string) => {
			if (!original.esRechazoEsperado(error)) {
				const causa = (error as any)?.cause;
				capturados.push({
					operacion,
					mensaje: String((error as any)?.message ?? error),
					...(causa === undefined ? {} : { causa: String(causa?.message ?? causa) }),
				});
			}
			original.capturarError(error, operacion);
		},
	};
});

const { CentralNoDisponible } = await import("../src/server/central/cliente");

const TENANT = "negocio-sin-central";
const AXIOM = { AXIOM_TOKEN: "token-de-pruebas", AXIOM_DATASET_SYNC: "sync-de-pruebas" };
let enviados: any[] = [];

beforeEach(() => {
	capturados.length = 0;
	enviados = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		enviados.push(...JSON.parse(String(init.body)));
		return new Response("{}", { status: 200 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ── Los fallos, como los marca Cloudflare ─────────────────────────────────────

const saturada = () =>
	Object.assign(new Error("Durable Object is overloaded. Too many requests queued."), { overloaded: true });
const pasajera = () =>
	Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true });
/** Sin ninguna de las dos marcas: la plataforma no dice por qué, o es un fallo del programa en el objeto. */
const SIN_MARCAS = "Durable Object exceeded its memory limit and was reset.";
const sinMarcas = () => new Error(SIN_MARCAS);
/** Como lo deja el cliente al vencer su plazo (`conPlazo`): el temporizador se prueba en `centralCliente.test.ts`. */
const plazo = () => new CentralNoDisponible("plazo");

/** Una central cuyo stub falla siempre con `fallo`: el objeto de detrás no llega a atender nada. */
const centralQueFalla = (fallo: () => Error): CentralDePrueba =>
	centralInterceptada(centralSinAprovisionar(), () => Promise.reject(fallo()));

/** Una central que contesta que no ha hecho la consulta: un error de SQL no es «no puede atender». */
const centralConErrorDeSql = (): CentralDePrueba =>
	centralInterceptada(centralSinAprovisionar(), async () => ({ ok: false, error: "central_error_sql", detalle: "no such column: x" }));

/** El hub con la central `central` detrás y Axiom configurado, para lo que le quede de vida a su instancia. */
function conLaCentral(hub: any, central: CentralDePrueba): void {
	ponerLaCentral(hub, central);
	hub.env = { ...hub.env, ...AXIOM };
}

async function eventosDeLaCentral(cuantos: number): Promise<any[]> {
	await vi.waitFor(() => expect(enviados.filter((e) => e.event === "central_no_disponible")).toHaveLength(cuantos));
	return enviados.filter((e) => e.event === "central_no_disponible");
}

/** Lo que dejaría el evento: el motivo, el método, la ruta y el negocio. */
const resumen = (eventos: any[]) => eventos.map((e) => [e.motivo, e.metodo, e.ruta, e.tenant_id]);

/** Deja pasar lo que hubiera quedado en vuelo: un evento que no debería salir. */
const unMomento = () => new Promise((r) => setTimeout(r, 150));

// ── Sockets ───────────────────────────────────────────────────────────────────

type Conexion = { cliente: WebSocket; servidor: WebSocket; recibidos: any[] };

/** Un socket aceptado por el hub con el attachment que le da `autenticada`: saludado o a punto de saludar. */
function conectar(hub: any, deviceId: string, autenticada: boolean): Conexion {
	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [deviceId]);
	par[1].serializeAttachment({
		tenantId: TENANT,
		deviceId,
		role: "tpv",
		authed: autenticada,
		...(autenticada ? { autenticadaMs: Date.now() } : {}),
		pubkeyB64: null,
		challenge: autenticada ? null : { nonceB64: "n", expiresAtMs: Date.now() + 60_000 },
		recovering: false,
	});
	const c: Conexion = { cliente: par[0], servidor: par[1], recibidos: [] };
	c.cliente.accept();
	c.cliente.addEventListener("message", (ev: MessageEvent) => c.recibidos.push(JSON.parse(String(ev.data))));
	return c;
}

async function esperar(c: Conexion, casa: (m: any) => boolean): Promise<any> {
	await vi.waitFor(() => expect(c.recibidos.some(casa)).toBe(true), { timeout: 5_000 });
	return c.recibidos.find(casa);
}

/** El saludo de un `tpv` cuya firma se da por buena (o no, con `firma`): lo que se prueba es lo de después. */
async function saludaUnTpv(hub: any, c: Conexion, firma: () => Promise<unknown> = async () => ({ roleFinal: "tpv", pubkeyB64: "x" })) {
	hub.verifyHelloSigned = firma;
	await hub.webSocketMessage(c.servidor, JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }));
	return esperar(c, (m) => m.type === "hello_ok" || m.type === "error");
}

const cerrar = (c: Conexion) => {
	try {
		c.cliente.close(1000, "fin");
	} catch {}
};

// ══════════════════════════════════════════════════════════════════════════════

describe("el `last_seen` (`touchLastSeen`)", () => {
	it("con la central saturada o con un fallo pasajero: sin Sentry, y su evento en Axiom", async () => {
		for (const [nombre, fallo] of [["saturada", saturada], ["pasajera", pasajera]] as const) {
			await enElHub(`hub-sin-central-last-seen-${nombre}`, async (hub: any) => {
				conLaCentral(hub, centralQueFalla(fallo));
				await hub.touchLastSeen(TENANT, "equipo-1");
			});
		}

		expect(capturados).toEqual([]);
		expect(resumen(await eventosDeLaCentral(2))).toEqual([
			["saturada", "hub", "sync.last_seen", TENANT],
			["pasajera", "hub", "sync.last_seen", TENANT],
		]);
	});

	it("con un rechazo del viaje sin marcas: a Sentry con su causa, y su evento en Axiom", async () => {
		await enElHub("hub-sin-central-last-seen-rechazo", async (hub: any) => {
			conLaCentral(hub, centralQueFalla(sinMarcas));
			await hub.touchLastSeen(TENANT, "equipo-1");
		});

		expect(capturados).toEqual([{ operacion: "sync.last_seen", mensaje: "hub_unavailable", causa: SIN_MARCAS }]);
		expect(await eventosDeLaCentral(1)).toMatchObject([{ motivo: "rechazo", metodo: "hub", ruta: "sync.last_seen", error: SIN_MARCAS }]);
	});

	it("un error de SQL no es «no puede atender»: a Sentry, como siempre, y sin evento", async () => {
		await enElHub("hub-sin-central-last-seen-sql", async (hub: any) => {
			conLaCentral(hub, centralConErrorDeSql());
			await hub.touchLastSeen(TENANT, "equipo-1");
		});

		expect(capturados).toEqual([{ operacion: "sync.last_seen", mensaje: "central_error_sql: no such column: x" }]);
		await unMomento();
		expect(enviados.filter((e) => e.event === "central_no_disponible")).toEqual([]);
	});
});

describe("quién es la Main", () => {
	it("la comprobación por actividad (`comprobarMain`) con un fallo pasajero: sin Sentry, y su evento", async () => {
		await enElHub("hub-sin-central-comprobar", async (hub: any) => {
			conLaCentral(hub, centralQueFalla(pasajera));
			const main = conectar(hub, "main-1", true);
			try {
				const comprobando = hub.comprobarMain();
				expect(comprobando).not.toBeNull();
				await comprobando;
			} finally {
				cerrar(main);
			}
		});

		expect(capturados).toEqual([]);
		expect(resumen(await eventosDeLaCentral(1))).toEqual([["pasajera", "hub", "sync.main_vigente", TENANT]]);
	});

	it("la comprobación por actividad sin respuesta (un rechazo sin marcas, un plazo vencido): a Sentry, y su evento", async () => {
		for (const [nombre, fallo] of [["rechazo", sinMarcas], ["plazo", plazo]] as const) {
			await enElHub(`hub-sin-central-comprobar-${nombre}`, async (hub: any) => {
				conLaCentral(hub, centralQueFalla(fallo));
				const main = conectar(hub, "main-1", true);
				try {
					await hub.comprobarMain();
				} finally {
					cerrar(main);
				}
			});
		}

		expect(capturados).toEqual([
			{ operacion: "sync.main_vigente", mensaje: "hub_unavailable", causa: SIN_MARCAS },
			{ operacion: "sync.main_vigente", mensaje: "hub_unavailable" },
		]);
		expect(resumen(await eventosDeLaCentral(2))).toEqual([
			["rechazo", "hub", "sync.main_vigente", TENANT],
			["plazo", "hub", "sync.main_vigente", TENANT],
		]);
	});

	it("un error de SQL al comprobar sigue yendo a Sentry, sin evento", async () => {
		await enElHub("hub-sin-central-comprobar-sql", async (hub: any) => {
			conLaCentral(hub, centralConErrorDeSql());
			const main = conectar(hub, "main-1", true);
			try {
				await hub.comprobarMain();
			} finally {
				cerrar(main);
			}
		});

		expect(capturados).toEqual([{ operacion: "sync.main_vigente", mensaje: "central_error_sql: no such column: x" }]);
		await unMomento();
		expect(enviados.filter((e) => e.event === "central_no_disponible")).toEqual([]);
	});

	it("el aviso de un cambio de licencia (`releerMain`) con la central saturada: sin Sentry, y su evento", async () => {
		await enElHub("hub-sin-central-releer", async (hub: any) => {
			conLaCentral(hub, centralQueFalla(saturada));
			laTablaDiceQueLaMainEs(hub, "main-1");
			await hub.releerMain(TENANT);
		});

		expect(capturados).toEqual([]);
		expect(resumen(await eventosDeLaCentral(1))).toEqual([["saturada", "hub", "sync.main_vigente", TENANT]]);
	});

	it("una ruta de un `tpv` que la tabla no da por Main (`vetoDeMain`): 503 `main_sin_comprobar`, sin Sentry, y su evento", async () => {
		const res = await enElHub("hub-sin-central-veto", async (hub: any) => {
			conLaCentral(hub, centralQueFalla(pasajera));
			laTablaDiceQueLaMainEs(hub, "otra-main");
			const r: Response = await hub.ejecutarRuta(
				new Request("https://tpv-api.test/v1/sync/changes", { method: "POST", body: "{}" }),
				{ tenantId: TENANT, deviceId: "main-1", token: "token", licHash: "hash", rol: "tpv" },
			);
			return { status: r.status, cuerpo: await r.json() };
		});

		expect(res).toMatchObject({ status: 503, cuerpo: { ok: false, code: "external", error: "main_sin_comprobar" } });
		expect(capturados).toEqual([]);
		expect(resumen(await eventosDeLaCentral(1))).toEqual([["pasajera", "hub", "sync.main_vigente", TENANT]]);
	});
});

describe("el saludo de un `tpv`, que sin la central no entra", () => {
	it("con la central saturada: `hello_failed`, sin Sentry, y su evento en Axiom", async () => {
		await enElHub("hub-sin-central-saludo", async (hub: any) => {
			conLaCentral(hub, centralQueFalla(saturada));
			const main = conectar(hub, "main-1", false);
			try {
				expect(await saludaUnTpv(hub, main)).toMatchObject({ type: "error", error: "hello_failed" });
			} finally {
				cerrar(main);
			}
		});

		expect(capturados).toEqual([]);
		expect(resumen(await eventosDeLaCentral(1))).toEqual([["saturada", "hub", "sync.main_vigente", TENANT]]);
	});

	it("con un rechazo del viaje sin marcas: a Sentry con su causa, y su evento", async () => {
		await enElHub("hub-sin-central-saludo-rechazo", async (hub: any) => {
			conLaCentral(hub, centralQueFalla(sinMarcas));
			const main = conectar(hub, "main-1", false);
			try {
				expect(await saludaUnTpv(hub, main)).toMatchObject({ type: "error", error: "hello_failed" });
			} finally {
				cerrar(main);
			}
		});

		expect(capturados).toEqual([{ operacion: "sync.main_vigente", mensaje: "hub_unavailable", causa: SIN_MARCAS }]);
		expect(resumen(await eventosDeLaCentral(1))).toEqual([["rechazo", "hub", "sync.main_vigente", TENANT]]);
	});

	it("un saludo cuya firma no vale no llega a la central y no deja nada", async () => {
		await enElHub("hub-sin-central-saludo-firma", async (hub: any) => {
			conLaCentral(hub, centralQueFalla(sinMarcas));
			const main = conectar(hub, "main-1", false);
			try {
				const respuesta = await saludaUnTpv(hub, main, async () => {
					throw new Error("bad_signature");
				});
				expect(respuesta).toMatchObject({ type: "error", error: "hello_failed", details: "bad_signature" });
			} finally {
				cerrar(main);
			}
		});

		await unMomento();
		expect(capturados).toEqual([]);
		expect(enviados.filter((e) => e.event === "central_no_disponible")).toEqual([]);
	});
});
