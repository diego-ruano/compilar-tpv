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
// Lo que se entrega a `waitUntil` tampoco puede acabar en un rechazo: no lo espera nadie, y el
// runtime lo da por un error sin recoger. El `last_seen` que la central no apunta se recoge en el hub
// y va a Sentry.
//
// Aquí el socket va por el camino de producción: el upgrade entra por el `fetch` del DO, y los
// mensajes los entrega el runtime al TenantHub instrumentado, con el SDK de verdad. Lo único que se
// cambia es el `ctx` que recibe el objeto al construirse, para apuntar cada promesa que se le pasa a
// `waitUntil` y saber si termina y cómo.

import { env as entorno, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { centralQueApunta, centralSinAprovisionar } from "./helpers/central";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub, ponerLaCentral } from "./helpers/hub";
import { centralDe } from "../src/lib/objetosDelNegocio";
import { bytesToB64 } from "../src/server/utils/base64";

const { pendientes, entregadas, rechazadas, enviados } = vi.hoisted(() => ({
	pendientes: new Set<Promise<unknown>>(),
	entregadas: { n: 0 },
	/** Lo que ha rechazado cada promesa de `waitUntil` que ha acabado mal. */
	rechazadas: [] as unknown[],
	/** Lo que el SDK de Sentry ha entregado a su transporte. */
	enviados: [] as any[],
}));

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
						p.then(quitar, (e) => {
							rechazadas.push(e);
							quitar();
						});
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

/**
 * Una Handy del negocio `tenant` abre su socket por el `fetch` del TenantHub `nombre` y saluda, como
 * en producción. Devuelve su lado del socket, lo que ha recibido y cómo esperar lo siguiente.
 */
async function saludaUnaHandy(nombre: string, tenant: string) {
	const claves = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const clave = bytesToB64(new Uint8Array((await crypto.subtle.exportKey("raw", claves.publicKey)) as ArrayBuffer));
	const ns = env.TenantHub as DurableObjectNamespace;
	const res = await ns.get(ns.idFromName(nombre)).fetch(
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
	return { cliente, recibidos, esperar };
}

/** Los eventos de error que el SDK ha entregado al transporte. */
const eventos = (): any[] =>
	enviados.flatMap((sobre) => sobre[1].filter((item: any) => item[0].type === "event").map((item: any) => item[1]));

describe("el TenantHub no se queda despierto con un socket abierto (AUD-46)", () => {
	it("tras el saludo y varios mensajes no queda ninguna promesa de waitUntil sin terminar", async () => {
		const nombre = "hub-hiberna";
		const rechazadasAntes = rechazadas.length;

		// La base del negocio con su esquema, y la base central de verdad, la que el hub pide con
		// `centralDe` (aprovisionada): el bloqueo sólo salta si, al acabar el evento, al hub le queda
		// algo propio en vuelo por `waitUntil` (aquí, el `last_seen`, que va a la central por RPC; en
		// producción también Axiom o la purga del log). Las promesas de la central, que también está
		// instrumentada, cuentan igual: tampoco puede quedarse despierta.
		expect(await centralDe(env).aprovisionar()).toMatchObject({ ok: true });
		await enElHub(nombre, (hub: any) => {
			crearEsquemaTenant(hub.state.storage.sql);
		});
		const { cliente, recibidos, esperar } = await saludaUnaHandy(nombre, "negocio-hiberna");

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
		expect(rechazadas.slice(rechazadasAntes)).toEqual([]);

		cliente.close(1000, "fin");
	});

	it("si la central no apunta el `last_seen`, su promesa termina igual, sin un rechazo que no recoja nadie", async () => {
		const nombre = "hub-hiberna-sin-central";
		// La central de este hub, sin aprovisionar: a todo contesta `central_sin_aprovisionar`. Se le
		// pone y no se le quita, porque el socket le habla después, desde fuera de `enElHub`.
		const central = centralQueApunta(centralSinAprovisionar());
		await enElHub(nombre, (hub: any) => {
			crearEsquemaTenant(hub.state.storage.sql);
			ponerLaCentral(hub, central);
		});
		const { cliente, recibidos, esperar } = await saludaUnaHandy(nombre, "negocio-sin-central");
		const antes = { entregadas: entregadas.n, rechazadas: rechazadas.length, eventos: eventos().length };

		// Sin el freno (SYNC-08): el upgrade acaba de marcar el instante, y el mensaje no iría a la central.
		await enElHub(nombre, (hub: any) => hub.lastSeenPushedAtMs.clear());
		const desde = recibidos.length;
		cliente.send(JSON.stringify({ type: "sin_uso" }));
		expect(await esperar((m) => m.type === "error", desde)).toMatchObject({ error: "unknown_type" });
		expect(entregadas.n).toBeGreaterThan(antes.entregadas);
		await vi.waitFor(() => expect(pendientes.size).toBe(0), { timeout: 3_000, interval: 50 });

		// El hub se lo ha pedido a la central, que no lo ha hecho, y el fallo no ha salido por `waitUntil`.
		expect(central.pedido).toEqual(["UPDATE devices SET last_seen_at_ms=? WHERE tenant_id=? AND device_id=?"]);
		expect(rechazadas.slice(antes.rechazadas)).toEqual([]);
		// Lo ha recogido el hub, y ha ido a Sentry con su operación.
		await vi.waitFor(() => expect(eventos().length).toBeGreaterThan(antes.eventos), { timeout: 3_000 });
		expect(eventos().slice(antes.eventos)).toEqual([
			expect.objectContaining({
				tags: expect.objectContaining({ operation: "sync.last_seen" }),
				exception: expect.objectContaining({
					values: [expect.objectContaining({ value: expect.stringContaining("central_sin_aprovisionar") })],
				}),
			}),
		]);

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
