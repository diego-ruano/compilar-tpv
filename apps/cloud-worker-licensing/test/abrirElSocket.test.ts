// test/abrirElSocket.test.ts
//
// Abrir el WebSocket de un negocio (`GET /ws`, `app.ts`) cuesta un viaje a la base central.
//
// Costaba cuatro: el Worker canjeaba el ticket y cargaba el dispositivo, y el TenantHub, al
// saludar, volvía a cargar el mismo dispositivo y apuntaba su `last_seen`. Ahora el canje, la fila y
// el `last_seen` van en un lote (`domains/ws/canje.ts`), y el TenantHub se fía de lo que el Worker
// le pasa en las cabeceras de identidad. Aquí se fija:
//
//   · por el Worker: un solo viaje; lo que llega al TenantHub es la fila de la base central, y las
//     cabeceras de identidad que mande el cliente se quitan (también la clave pública cuando el
//     dispositivo no tiene ninguna: ése ya no abre el socket); el ticket es de un solo uso, y uno
//     caducado, revocado o sin clave no apunta `last_seen`;
//   · por el TenantHub: el upgrade y un saludo firmado de verdad entran sin pedirle nada del
//     dispositivo a la base central.
//
// La base central es una de verdad, nueva en cada caso (`helpers/central.ts`): el Worker llega a ella
// por su `entorno`, y el TenantHub, porque se le pone.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { centralDePrueba, centralInterceptada, centralQueApunta, filasDe, type CentralDePrueba } from "./helpers/central";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { app } from "../src/app";
import { bytesToB64 } from "../src/server/utils/base64";

const env = entorno as any;
const TENANT = "negocio-socket";
const CLAVE = "Q2xhdmVQdWJsaWNhRGVQcnVlYmFzMDEyMzQ1Njc4OTA=";

/** La base central de la prueba, y sus viajes: el método de cada llamada que le llega (un lote es una). */
type Central = { central: CentralDePrueba; viajes: string[] };

/** La base central de la prueba, con un ticket de cada clase y sus dispositivos. */
async function conCentral<R>(prueba: (central: Central) => Promise<R>): Promise<R> {
	const real = await centralDePrueba();
	const ahora = Date.now();
	await filasDe(real, `INSERT INTO tenants (tenant_id) VALUES (?);`, TENANT);
	for (const [id, rol, clave, revocado] of [
		["main-1", "tpv", CLAVE, null],
		["handy-sin-clave", "handy", null, null],
		["handy-de-baja", "handy", CLAVE, ahora - 1000],
	] as const) {
		await filasDe(
			real,
			`INSERT INTO devices (device_id, tenant_id, role, device_pubkey_b64, pubkey_alg, revoked_at_ms, last_seen_at_ms)
			 VALUES (?, ?, ?, ?, 'ed25519', ?, 0);`,
			id,
			TENANT,
			rol,
			clave,
			revocado,
		);
	}
	for (const [ticket, device, caduca] of [
		["t-bueno", "main-1", ahora + 30_000],
		["t-caducado", "main-1", ahora - 1],
		["t-sin-clave", "handy-sin-clave", ahora + 30_000],
		["t-de-baja", "handy-de-baja", ahora + 30_000],
		["t-sin-fila", "nadie", ahora + 30_000],
	] as const) {
		await filasDe(
			real,
			`INSERT INTO Ws_Tickets (ticket, tenant_id, device_id, expires_at_ms) VALUES (?, ?, ?, ?);`,
			ticket,
			TENANT,
			device,
			caduca,
		);
	}
	const viajes: string[] = [];
	const central = centralInterceptada(real, (metodo, _argumentos, llamar) => {
		viajes.push(metodo);
		return llamar();
	});
	return prueba({ central, viajes });
}

/** Un `TenantHub` de mentira que apunta la petición que le pasa el Worker. */
function hubQueApunta() {
	const recibidas: Request[] = [];
	const TenantHub = {
		idFromName: (n: string) => n,
		get: () => ({
			fetch: async (r: Request) => {
				recibidas.push(r);
				return new Response("hub");
			},
		}),
	};
	return { recibidas, TenantHub };
}

/** Lo que manda un cliente que intenta colarle su identidad al TenantHub. */
const CABECERAS_DEL_CLIENTE = {
	Upgrade: "websocket",
	"x-tenant-id": "otro-negocio",
	"x-device-id": "otro-equipo",
	"x-role": "tpv",
	"x-device-pubkey-b64": "Q2xhdmVEZWxDbGllbnRlUXVlTm9EZWJlUGFzYXIwMDA=",
	"x-ws-canje-ms": "99999999999999",
};

const ultimaVez = async (central: CentralDePrueba, deviceId: string) =>
	Number((await filasDe(central, `SELECT last_seen_at_ms AS t FROM devices WHERE device_id = ?;`, deviceId))[0].t);

const quedanTickets = async (central: CentralDePrueba, ticket: string) =>
	(await filasDe(central, `SELECT COUNT(*) AS n FROM Ws_Tickets WHERE ticket = ?;`, ticket))[0].n;

describe("GET /ws en el Worker: un viaje a la base central", () => {
	it("canjea el ticket, lee la fila y apunta last_seen en un lote, y pasa la identidad de la base central", async () => {
		await conCentral(async ({ central, viajes }) => {
			const { recibidas, TenantHub } = hubQueApunta();
			const antes = Date.now();
			const res = await app.request(
				"/ws?ticket=t-bueno",
				{ headers: CABECERAS_DEL_CLIENTE },
				{ ...env, ...central.entorno, TenantHub },
			);
			expect(await res.text()).toBe("hub");

			expect(viajes).toEqual(["lote"]);

			expect(recibidas).toHaveLength(1);
			const h = recibidas[0].headers;
			expect(new URL(recibidas[0].url).pathname).toBe("/ws");
			expect(h.get("upgrade")).toBe("websocket");
			expect(h.get("x-tenant-id")).toBe(TENANT);
			expect(h.get("x-device-id")).toBe("main-1");
			expect(h.get("x-role")).toBe("tpv");
			expect(h.get("x-device-pubkey-b64")).toBe(CLAVE);
			// La hora del canje, del Worker: la del cliente no pasa.
			const canje = Number(h.get("x-ws-canje-ms"));
			expect(canje).toBeGreaterThanOrEqual(antes);
			expect(canje).toBeLessThanOrEqual(Date.now());

			expect(await ultimaVez(central, "main-1")).toBeGreaterThanOrEqual(antes);
			expect(await quedanTickets(central, "t-bueno")).toBe(0);

			// Un solo uso: el mismo ticket otra vez no encuentra nada.
			const otra = await app.request(
				"/ws?ticket=t-bueno",
				{ headers: CABECERAS_DEL_CLIENTE },
				{ ...env, ...central.entorno, TenantHub },
			);
			expect(otra.status).toBe(401);
			expect(await otra.json()).toMatchObject({ error: "invalid_ticket" });
			expect(recibidas).toHaveLength(1);
		});
	});

	it.each([
		["t-caducado", "main-1", "expired_ticket"],
		["t-sin-clave", "handy-sin-clave", "device_pubkey_not_registered"],
		["t-de-baja", "handy-de-baja", "device_revoked"],
		["t-sin-fila", null, "device_not_registered"],
		["t-que-no-existe", null, "invalid_ticket"],
	] as const)("%s: no llega al TenantHub (%s), contesta %s y no apunta last_seen", async (ticket, deviceId, error) => {
		await conCentral(async ({ central, viajes }) => {
			const { recibidas, TenantHub } = hubQueApunta();
			// La clave que manda el cliente no sustituye a la que falta en la base central.
			const res = await app.request(
				`/ws?ticket=${ticket}`,
				{ headers: CABECERAS_DEL_CLIENTE },
				{ ...env, ...central.entorno, TenantHub },
			);
			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({ error });
			expect(recibidas).toEqual([]);
			expect(viajes).toEqual(["lote"]);
			if (deviceId) expect(await ultimaVez(central, deviceId)).toBe(0);
			// El ticket se gasta igual.
			expect(await quedanTickets(central, ticket)).toBe(0);
		});
	});
});

// El ticket es de un solo uso porque lo decide el `DELETE … RETURNING`, en el mismo lote que lee la
// fila. Aquí, N aperturas a la vez con el mismo ticket contra la central de verdad: una barrera en su
// stub no deja pasar ningún canje hasta que han llegado los N. El caso de control es la carrera sin
// el lote: leyendo el ticket en un viaje y borrándolo en otro, con el mismo cruce, entran todas.
describe("GET /ws con el mismo ticket a la vez", () => {
	const N = 5;

	/**
	 * La central `central`, con una barrera en su stub: las `n` primeras llamadas del método `metodo`
	 * esperan a que hayan llegado las `n`; con `antes`, antes de ir a la central, y si no, ya
	 * contestadas. En `llegadas`, cuántas han llegado.
	 */
	function conBarrera(central: CentralDePrueba, metodo: string, n: number, antes: boolean) {
		let llegadas = 0;
		let soltar!: () => void;
		const todas = new Promise<void>((resolve) => (soltar = resolve));
		const vista = centralInterceptada(central, async (llamado, _argumentos, llamar) => {
			if (llamado !== metodo || llegadas >= n) return llamar();
			if (++llegadas === n) soltar();
			if (antes) await todas;
			const respuesta = await llamar();
			if (!antes) await todas;
			return respuesta;
		});
		return { vista, llegadas: () => llegadas };
	}

	it("entra una sola: las demás no encuentran el ticket y no llegan al TenantHub", async () => {
		await conCentral(async ({ central }) => {
			const { recibidas, TenantHub } = hubQueApunta();
			const { vista, llegadas } = conBarrera(central, "lote", N, true);
			const respuestas = await Promise.all(
				Array.from({ length: N }, () =>
					app.request("/ws?ticket=t-bueno", { headers: CABECERAS_DEL_CLIENTE }, { ...env, ...vista.entorno, TenantHub }),
				),
			);

			expect(llegadas()).toBe(N);
			const cuerpos = await Promise.all(respuestas.map((r) => r.text()));
			expect(cuerpos.filter((c) => c === "hub")).toHaveLength(1);
			const rechazos = respuestas.flatMap((r, i) => (cuerpos[i] === "hub" ? [] : [[r.status, JSON.parse(cuerpos[i]).error]]));
			expect(rechazos).toEqual(Array(N - 1).fill([401, "invalid_ticket"]));
			expect(recibidas).toHaveLength(1);
			expect(recibidas[0].headers.get("x-device-id")).toBe("main-1");
			expect(await quedanTickets(central, "t-bueno")).toBe(0);
		});
	});

	it("control: leyendo el ticket en un viaje y borrándolo en otro, con el mismo cruce, lo encuentran todas", async () => {
		await conCentral(async ({ central }) => {
			const { vista, llegadas } = conBarrera(central, "ejecutar", N, false);
			const encontrado = await Promise.all(
				Array.from({ length: N }, async () => {
					const leido = await vista.db.execute({ sql: "SELECT device_id FROM Ws_Tickets WHERE ticket = ?1;", args: ["t-bueno"] });
					await vista.db.execute({ sql: "DELETE FROM Ws_Tickets WHERE ticket = ?1;", args: ["t-bueno"] });
					return leido.rows.length;
				}),
			);

			expect(llegadas()).toBe(N);
			expect(encontrado).toEqual(Array(N).fill(1));
			expect(await quedanTickets(central, "t-bueno")).toBe(0);
		});
	});
});

describe("el TenantHub se fía de la identidad que le pasa el Worker", () => {
	it("el upgrade y un saludo firmado entran sin pedir el dispositivo a la base central", async () => {
		const claves = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const clave = bytesToB64(new Uint8Array((await crypto.subtle.exportKey("raw", claves.publicKey)) as ArrayBuffer));

		// Lo que se le pida a la base central queda apuntado; del dispositivo, nada.
		const central = centralQueApunta(await centralDePrueba());
		await enElHub("socket-hub-confia", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);

			const res = await hub.fetch(
				new Request("https://hub/ws", {
					headers: {
						Upgrade: "websocket",
						"x-tenant-id": "negocio-confia",
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

			const esperar = async (pred: (m: any) => boolean) => {
				const limite = Date.now() + 2000;
				while (Date.now() < limite) {
					const m = recibidos.find(pred);
					if (m) return m;
					await new Promise((r) => setTimeout(r, 5));
				}
				throw new Error(`no llegó: ${JSON.stringify(recibidos)}`);
			};

			const reto = await esperar((m) => m.type === "challenge");
			const ts = Date.now();
			const firmado = new TextEncoder().encode(`WS_HANDY_HELLO\n${ts}\nnegocio-confia\nhandy-1\n${reto.nonceB64}`);
			const firma = bytesToB64(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, claves.privateKey, firmado)));
			const servidor = hub.state.getWebSockets("handy-1")[0];
			await hub.webSocketMessage(servidor, JSON.stringify({ type: "helloSigned", ts, nonceB64: reto.nonceB64, sigB64: firma }));

			expect(await esperar((m) => m.type === "hello_ok" || m.type === "error")).toMatchObject({ type: "hello_ok", role: "handy" });
			expect(central.pedido.filter((s) => /\bdevices\b/i.test(s))).toEqual([]);
		}, { central });
	});

	it("una baja entre el canje del ticket y el upgrade no deja entrar el socket", async () => {
		await enElHub("socket-hub-baja-antes", async (hub: any) => {
			const upgrade = (canjeMs: number) =>
				hub.fetch(
					new Request("https://hub/ws", {
						headers: {
							Upgrade: "websocket",
							"x-tenant-id": "negocio-baja",
							"x-device-id": "handy-1",
							"x-role": "handy",
							"x-device-pubkey-b64": CLAVE,
							"x-ws-canje-ms": String(canjeMs),
						},
					}),
				);
			const canjeado = Date.now();
			// La baja llega antes que el socket: no tiene nada que cerrar.
			await hub.revocarDispositivo("handy-1");

			const tarde = await upgrade(canjeado);
			expect(tarde.status).toBe(401);
			expect(await tarde.json()).toMatchObject({ error: "device_revoked" });
			expect(hub.state.getWebSockets("handy-1")).toEqual([]);

			// Un canje posterior a la baja (el dispositivo se volvió a dar de alta) sí entra.
			const despues = await upgrade(Date.now() + 10_000);
			expect(despues.status).toBe(101);
			(despues.webSocket as WebSocket).accept();
			expect(hub.state.getWebSockets("handy-1")).toHaveLength(1);
		});
	});
});
