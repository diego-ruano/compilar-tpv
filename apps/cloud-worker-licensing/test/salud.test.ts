// test/salud.test.ts
//
// La sonda de la monitorización externa (PROD-01): `/health` y el latido del cron.
//
// Lo que se fija aquí es sobre todo una cosa, y es la que se rompe sola: que un `/health` cuya
// base central no contesta NO puede salir con un veredicto bueno. Es la única avería de todo el
// sistema que un monitor no puede descubrir por su cuenta — si alguien devuelve esto a un
// `{ ok: true }` que no comprueba nada, el panel se queda verde durante la caída entera y nadie
// se entera nunca. El resto de casos protegen lo de siempre: que el endpoint público no cuente de
// más y que el latido no pueda tumbar al cron que lo lleva.

import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import { centralDePrueba, centralInterceptada, centralQueApunta, centralSinAprovisionar } from "./helpers/central";
import type { RespuestaDeLaCentral } from "../src/durableObjects/baseCentral.rpc";
import { app } from "../src/app";
import { CACHE_MS, comprobarSalud, olvidarSalud } from "../src/server/salud";
import { latir } from "../src/observability/latido";

const AHORA = 1_800_000_000_000;

/** Una base central de verdad que contesta; en `pedido`, lo que se le ha preguntado. */
const centralViva = async () => centralQueApunta(await centralDePrueba());

/**
 * Una base central que no contesta: su stub responde con un fallo de SQL cuyo detalle lleva dentro
 * lo que no se le puede contar a nadie. En `pedido`, lo que se le ha preguntado.
 */
const centralMuerta = async () =>
	centralQueApunta(await centralDePrueba(), async () => {
		const fallo: RespuestaDeLaCentral<never> = {
			ok: false,
			error: "central_error_sql",
			detalle: "no such table: cuentas_de_bar-secreto (token=abc123)",
		};
		return fallo;
	});

describe("el veredicto de /health", () => {
	beforeEach(() => {
		olvidarSalud();
	});

	it("con la base central viva, dice que sí", async () => {
		const central = await centralViva();
		expect(await comprobarSalud(central.db, AHORA)).toEqual({ ok: true, db: "ok", cifrado: "sin_comprobar" });
		expect(central.pedido).toEqual(["SELECT 1"]);
	});

	it("con la base central caída, dice que NO — el caso entero por el que esto existe", async () => {
		const central = await centralMuerta();
		expect(await comprobarSalud(central.db, AHORA)).toEqual({ ok: false, db: "inalcanzable", cifrado: "sin_comprobar" });
		expect(central.pedido).toEqual(["SELECT 1"]);
	});

	it("no cuenta POR QUÉ falla: el cuerpo lo lee cualquiera", async () => {
		const central = await centralMuerta();
		// El error lleva dentro el detalle de la base y un token. Nada de eso puede salir por un
		// endpoint público y sin autenticar.
		await expect(central.db.execute("SELECT 1")).rejects.toThrow(
			"central_error_sql: no such table: cuentas_de_bar-secreto (token=abc123)",
		);
		const salud = await comprobarSalud(central.db, AHORA);
		expect(JSON.stringify(salud)).not.toContain("bar-secreto");
		expect(JSON.stringify(salud)).not.toContain("abc123");
		expect(Object.keys(salud).sort()).toEqual(["cifrado", "db", "ok"]);
	});

	it("dentro de su ventana contesta de memoria, sin volver a preguntar", async () => {
		const central = await centralViva();
		await comprobarSalud(central.db, AHORA);
		await comprobarSalud(central.db, AHORA + CACHE_MS - 1);
		// Es lo que impide que un endpoint público y sin autenticar sea un generador gratuito de
		// consultas contra la base central.
		expect(central.pedido).toHaveLength(1);
	});

	it("pasada la ventana vuelve a preguntar, y una base que revive se nota", async () => {
		const muerta = await centralMuerta();
		expect(await comprobarSalud(muerta.db, AHORA)).toEqual({ ok: false, db: "inalcanzable", cifrado: "sin_comprobar" });

		const viva = await centralViva();
		expect(await comprobarSalud(viva.db, AHORA + CACHE_MS)).toEqual({ ok: true, db: "ok", cifrado: "sin_comprobar" });
		expect(viva.pedido).toHaveLength(1);
	});
});

describe("/health toca la central de verdad", () => {
	beforeEach(() => {
		olvidarSalud();
	});

	/** `GET /health` con la central que lleve `entorno`. */
	const sonda = async (entorno: Record<string, unknown>) => {
		const res = await app.fetch(new Request("https://tpv-api.invalid/health"), { ...env, ...entorno } as any);
		return { status: res.status, cuerpo: (await res.json()) as any };
	};

	it("con la central aprovisionada, 200", async () => {
		const central = await centralDePrueba();
		const r = await sonda(central.entorno);
		expect(r.status).toBe(200);
		expect(r.cuerpo).toMatchObject({ ok: true, db: "ok" });
	});

	it("con la central sin aprovisionar, 503", async () => {
		const r = await sonda(centralSinAprovisionar().entorno);
		expect(r.status).toBe(503);
		expect(r.cuerpo).toMatchObject({ ok: false, db: "inalcanzable" });
	});

	it("si la plataforma dice que la central no está disponible, 503", async () => {
		// Lo que marca Cloudflare en el error de una llamada a un Durable Object que no puede atender
		// (`.retryable`, `.overloaded`): `CentralNoDisponible` en el cliente.
		const central = await centralDePrueba();
		for (const marca of ["retryable", "overloaded"]) {
			olvidarSalud();
			const caida = Object.assign(new Error("Durable Object reset because its code was updated."), { [marca]: true });
			const r = await sonda(centralInterceptada(central, () => Promise.reject(caida)).entorno);
			expect(r.status, marca).toBe(503);
			expect(r.cuerpo, marca).toMatchObject({ ok: false, db: "inalcanzable" });
		}
	});
});

describe("el latido del cron", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sin el secreto configurado no llama a nadie", async () => {
		const llamadas: string[] = [];
		vi.stubGlobal("fetch", async (url: any) => {
			llamadas.push(String(url));
			return new Response("ok");
		});

		await latir({});
		await latir({ BETTERSTACK_HEARTBEAT_URL: "   " });

		// Se puede desplegar antes de crear el heartbeat, igual que pasa con el DSN de Sentry.
		expect(llamadas).toEqual([]);
	});

	it("con el secreto, pulsa la URL", async () => {
		const llamadas: string[] = [];
		vi.stubGlobal("fetch", async (url: any) => {
			llamadas.push(String(url));
			return new Response("ok");
		});

		await latir({ BETTERSTACK_HEARTBEAT_URL: "https://uptime.betterstack.com/api/v1/heartbeat/xxx" });

		expect(llamadas).toEqual(["https://uptime.betterstack.com/api/v1/heartbeat/xxx"]);
	});

	it("una URL mal escrita contesta 404 y eso se anota: `fetch` no lanza nada", async () => {
		vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		await latir({ BETTERSTACK_HEARTBEAT_URL: "https://uptime.betterstack.com/api/v1/heartbeat/mal" });

		const dicho = log.mock.calls.map((c) => c.join(" ")).join(" | ");
		expect(dicho).toContain("404");
		// La URL es el secreto con el que se silencia la alarma: no se registra.
		expect(dicho).not.toContain("heartbeat/mal");
		log.mockRestore();
	});

	it("si la monitorización está caída, NO se lleva por delante al cron", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("network unreachable");
		});

		// Esto corre dentro del `scheduled`: si propagara, se llevaría por delante el resto del
		// cron. Que Better Stack no conteste no puede impedir avisar a un cliente de que le vence
		// la licencia.
		await expect(
			latir({ BETTERSTACK_HEARTBEAT_URL: "https://uptime.betterstack.com/api/v1/heartbeat/xxx" }),
		).resolves.toBeUndefined();
	});
});
