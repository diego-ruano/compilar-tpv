// test/elHubPuedeHibernar.test.ts
//
// AUD-46: un Durable Object no hiberna mientras le quede una promesa de `ctx.waitUntil` sin
// terminar (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
// y lo que está despierto se factura por duración aunque no haga nada.
//
// Con `@sentry/cloudflare` 10.62, el envoltorio del DO (`instrumentDurableObjectWithSentry`)
// entregaba en cada evento, a partir del segundo, un vaciado del cliente que se esperaba a sí mismo
// y no terminaba nunca (getsentry/sentry-javascript#22328): el TenantHub de un negocio con la Main
// conectada se quedaba despierto las 24 horas, se usara o no.
//
// Aquí el socket va por el camino de producción: el upgrade entra por el `fetch` del DO, y los
// mensajes los entrega el runtime al TenantHub instrumentado, con el SDK de verdad. Lo único que se
// cambia es el `ctx` que recibe el objeto al construirse, para apuntar cada promesa que se le pasa a
// `waitUntil` y saber si termina.

import { env as entorno, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { bytesToB64 } from "../src/server/utils/base64";

const { pendientes, entregadas } = vi.hoisted(() => ({ pendientes: new Set<Promise<unknown>>(), entregadas: { n: 0 } }));

vi.mock("@sentry/cloudflare", async (importOriginal) => {
	const sdk = await importOriginal<typeof import("@sentry/cloudflare")>();
	const conTransporte = (opciones: any) => ({
		...opciones,
		dsn: "https://public@sentry.invalid/1",
		transport: () => ({ send: async () => ({ statusCode: 200 }), flush: async () => true }),
	});
	return {
		...sdk,
		instrumentDurableObjectWithSentry: (opciones: any, clase: any) => {
			const instrumentada = sdk.instrumentDurableObjectWithSentry((env: any) => conTransporte(opciones(env)), clase);
			// Por fuera del SDK: lo que se apunta aquí es lo que llega de verdad al runtime.
			return new Proxy(instrumentada, {
				construct(objetivo, [ctx, env], nuevo) {
					const original = ctx.waitUntil.bind(ctx);
					ctx.waitUntil = (p: Promise<unknown>) => {
						pendientes.add(p);
						entregadas.n++;
						const quitar = () => void pendientes.delete(p);
						p.then(quitar, quitar);
						return original(p);
					};
					return Reflect.construct(objetivo, [ctx, env], nuevo);
				},
			});
		},
	};
});

// El DO que se instancia es el que exporta el worker, con el SDK de arriba.
await import("../src/index");

const env = entorno as any;

describe("el TenantHub no se queda despierto con un socket abierto (AUD-46)", () => {
	it("tras el saludo y varios mensajes no queda ninguna promesa de waitUntil sin terminar", async () => {
		const tenant = "negocio-hiberna";
		const nombre = "hub-hiberna";
		const claves = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const clave = bytesToB64(new Uint8Array((await crypto.subtle.exportKey("raw", claves.publicKey)) as ArrayBuffer));

		// La base del negocio con su esquema, y una base central que tarda lo que tarda la red: el
		// bloqueo sólo salta si, al acabar el evento, al hub le queda algo propio en vuelo por
		// `waitUntil` (aquí, el `last_seen`; en producción también Axiom o la purga del log).
		const red = () => new Promise((r) => setTimeout(r, 50));
		await enElHub(nombre, (hub: any) => {
			crearEsquemaTenant(hub.state.storage.sql);
			hub.getCentralDb = () => ({
				execute: async () => (await red(), { rows: [], rowsAffected: 0 }),
				batch: async (ss: unknown[]) => (await red(), ss.map(() => ({ rows: [], rowsAffected: 0 }))),
			});
		});

		const ns = env.TenantHub as DurableObjectNamespace;
		const stub = ns.get(ns.idFromName(nombre));
		const res = await stub.fetch(
			new Request("https://hub/ws", {
				headers: {
					Upgrade: "websocket",
					"x-tenant-id": tenant,
					"x-device-id": "handy-1",
					"x-role": "handy",
					"x-device-pubkey-b64": clave,
				},
			}),
		);
		expect(res.status).toBe(101);
		const cliente = res.webSocket as WebSocket;
		const recibidos: any[] = [];
		cliente.accept();
		cliente.addEventListener("message", (ev: MessageEvent) => recibidos.push(JSON.parse(String(ev.data))));

		const esperar = async (casa: (m: any) => boolean, desde = 0) => {
			await vi.waitFor(() => expect(recibidos.slice(desde).some(casa)).toBe(true), { timeout: 3_000 });
			return recibidos.slice(desde).find(casa);
		};

		const reto = await esperar((m) => m.type === "challenge");
		const ts = Date.now();
		const firmado = new TextEncoder().encode(`WS_HANDY_HELLO\n${ts}\n${tenant}\nhandy-1\n${reto.nonceB64}`);
		const firma = bytesToB64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, claves.privateKey, firmado)));
		cliente.send(JSON.stringify({ type: "helloSigned", ts, nonceB64: reto.nonceB64, sigB64: firma }));
		expect(await esperar((m) => m.type === "hello_ok" || m.type === "error")).toMatchObject({ type: "hello_ok" });

		// Cada mensaje es un evento del DO envuelto por Sentry, y cada uno entrega su `touchLastSeen`
		// por `waitUntil`. Se le quita el freno (SYNC-08) para que cada uno vaya de verdad a la red.
		for (let i = 0; i < 4; i++) {
			await enElHub(nombre, (hub: any) => hub.lastSeenPushedAtMs.clear());
			const desde = recibidos.length;
			cliente.send(JSON.stringify({ type: "sin_uso" }));
			expect(await esperar((m) => m.type === "error", desde)).toMatchObject({ error: "unknown_type" });
		}

		// Que se ha medido algo: el envoltorio y el hub han entregado promesas a `waitUntil`.
		expect(entregadas.n).toBeGreaterThan(4);
		await vi.waitFor(() => expect(pendientes.size).toBe(0), { timeout: 3_000, interval: 50 });

		cliente.close(1000, "fin");
	});

	it("DO-03: la alarma de la copia diaria tampoco deja nada sin terminar", async () => {
		const tenant = "negocio-hiberna-copia";
		const ns = env.TenantHub as DurableObjectNamespace;
		const stub = ns.get(ns.idFromName(tenant)) as any;
		await stub.aprovisionar(tenant);

		// Con Axiom configurado y tardando lo que tarda la red: la traza de la copia es lo único que la
		// alarma deja en `waitUntil`, y tiene que terminar.
		vi.stubGlobal("fetch", async () => (await new Promise((r) => setTimeout(r, 50)), new Response("{}")));
		try {
			await enElHub(tenant, (hub: any) => {
				hub.env = { ...hub.env, AXIOM_TOKEN: "t", AXIOM_DATASET_SYNC: "d" };
			});
			const antes = entregadas.n;
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(entregadas.n).toBeGreaterThan(antes);
			await vi.waitFor(() => expect(pendientes.size).toBe(0), { timeout: 3_000, interval: 50 });
			expect(await env.COPIAS_NEGOCIOS.head(`negocios/${tenant}/${new Date().toISOString().slice(0, 10)}.sql.gz`)).not.toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
