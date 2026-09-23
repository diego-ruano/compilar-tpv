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

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import { CACHE_MS, comprobarSalud, olvidarSalud } from "../src/server/salud";
import { latir } from "../src/observability/latido";

const AHORA = 1_800_000_000_000;

/** Una base que contesta, contando cuántas veces se le ha preguntado. */
function baseViva() {
	const llamadas = { n: 0 };
	return {
		llamadas,
		abrir: () => ({
			execute: async () => {
				llamadas.n++;
				return { rows: [] } as any;
			},
		}),
	};
}

/** Una base que no contesta, con un error del estilo de los que suelta libsql. */
function baseMuerta(mensaje = "connect failed: libsql://tpvcontrol-secreto.turso.io token=abc123") {
	const llamadas = { n: 0 };
	return {
		llamadas,
		abrir: () => ({
			execute: async () => {
				llamadas.n++;
				throw new Error(mensaje);
			},
		}),
	};
}

describe("el veredicto de /health", () => {
	beforeEach(() => {
		olvidarSalud();
	});

	it("con la base central viva, dice que sí", async () => {
		const base = baseViva();
		expect(await comprobarSalud(base.abrir, AHORA)).toEqual({ ok: true, db: "ok" });
		expect(base.llamadas.n).toBe(1);
	});

	it("con la base central caída, dice que NO — el caso entero por el que esto existe", async () => {
		const base = baseMuerta();
		expect(await comprobarSalud(base.abrir, AHORA)).toEqual({ ok: false, db: "inalcanzable" });
	});

	it("sin credenciales configuradas falla igual que si la base no contestara", async () => {
		// Un worker desplegado sin `TURSO_AUTH_TOKEN` está exactamente igual de roto, y resolver
		// las credenciales es lo que hace el thunk: por eso entra en el mismo `try`.
		const abrir = () => {
			throw new Error("missing_env_TURSO_AUTH_TOKEN");
		};
		expect(await comprobarSalud(abrir, AHORA)).toEqual({ ok: false, db: "inalcanzable" });
	});

	it("no cuenta POR QUÉ falla: el cuerpo lo lee cualquiera", async () => {
		const base = baseMuerta();
		const salud = await comprobarSalud(base.abrir, AHORA);
		// El error de libsql llevaba dentro la URL de la base y un token. Nada de eso puede salir
		// por un endpoint público y sin autenticar.
		expect(JSON.stringify(salud)).not.toContain("turso.io");
		expect(JSON.stringify(salud)).not.toContain("abc123");
		expect(Object.keys(salud).sort()).toEqual(["db", "ok"]);
	});

	it("dentro de su ventana contesta de memoria, sin volver a preguntar", async () => {
		const base = baseViva();
		await comprobarSalud(base.abrir, AHORA);
		await comprobarSalud(base.abrir, AHORA + CACHE_MS - 1);
		// Es lo que impide que un endpoint público y sin autenticar sea un generador gratuito de
		// consultas contra la base central.
		expect(base.llamadas.n).toBe(1);
	});

	it("pasada la ventana vuelve a preguntar, y una base que revive se nota", async () => {
		const muerta = baseMuerta();
		expect(await comprobarSalud(muerta.abrir, AHORA)).toEqual({ ok: false, db: "inalcanzable" });

		const viva = baseViva();
		expect(await comprobarSalud(viva.abrir, AHORA + CACHE_MS)).toEqual({ ok: true, db: "ok" });
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
