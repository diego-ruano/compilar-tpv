// test/difusionAjustada.test.ts
//
// Lo que el TenantHub manda por el WebSocket es lo que alguien lee.
//
// - Un `change` lleva la operación, su `Seq` y sus sentencias ya resueltas. Es lo que lee la Main
//   (`replicacion.rs::cambio`: `opId`, `seq`, `statements`) y lo que lee la Handy
//   (`presencia_handy.rs`: `statements`). El comando, el dispositivo que lo mandó, su payload, su
//   resultado y una hora viajaban en cada cambio, a cada dispositivo, sin que nadie los leyera.
// - No hay mensajes de presencia: ningún cliente los leía. Si hay Main se dice con `main_online`,
//   `main_offline` y `main_status`, que sí.
// - No hay mensajes de un dispositivo a los demás (`event`), ni el sondeo de la base que iba con
//   ellos (`tenantDb.ping`): ningún cliente los manda. Llegan como cualquier tipo desconocido.

import { describe, expect, it } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { laMainEs } from "./helpers/mainVigente";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";

const TENANT = "tenant-difusion";
const MAIN = "main-difusion";

type Conexion = { cliente: WebSocket; servidor: WebSocket; recibidos: any[] };

function escuchar(cliente: WebSocket, servidor: WebSocket): Conexion {
	const c: Conexion = { cliente, servidor, recibidos: [] };
	cliente.accept();
	cliente.addEventListener("message", (ev: MessageEvent) => c.recibidos.push(JSON.parse(String(ev.data))));
	return c;
}

/** Un socket aceptado por el DO con el attachment que deja un saludo correcto. */
function conectar(hub: any, deviceId: string, role: "tpv" | "handy"): Conexion {
	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [deviceId]);
	par[1].serializeAttachment({ tenantId: TENANT, deviceId, role, authed: true, pubkeyB64: null, challenge: null, recovering: false });
	return escuchar(par[0], par[1]);
}

/** Un hub con su base de verdad, la Main de la licencia apuntada y la base central sin red. */
function preparar(hub: any): any {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	const db = clienteLocal(hub.state.storage);
	hub.getTenantDb = async () => db;
	hub.touchLastSeen = async () => {};
	hub.emitSyncEvent = () => {};
	laMainEs(hub, MAIN);
	return sql;
}

async function esperar(c: Conexion, pred: (m: any) => boolean): Promise<any> {
	const limite = Date.now() + 3_000;
	while (Date.now() < limite) {
		const m = c.recibidos.find(pred);
		if (m) return m;
		await new Promise((r) => setTimeout(r, 10));
	}
	return undefined;
}

const unMomento = () => new Promise((r) => setTimeout(r, 100));

const altaDeZona = (id: string) => ({
	type: "tenantDb.transaction" as const,
	payload: { steps: [{ kind: "execute" as const, sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);", args: [id, `Zona ${id}`] }] },
});

describe("un cambio lleva lo que se lee, y nada más", () => {
	it("el de una escritura de la Main, a la Handy", async () => {
		await enElHub("difusion-de-la-main", async (hub: any) => {
			const sql = preparar(hub);
			const main = conectar(hub, MAIN, "tpv");
			const handy = conectar(hub, "handy-1", "handy");

			await hub.webSocketMessage(
				main.servidor,
				JSON.stringify({
					type: "apply_lote",
					loteId: "lote-1",
					ops: [{ opId: "op-main", commandName: "zona_alta", command: altaDeZona("z1") }],
				}),
			);
			expect(await esperar(main, (m) => m.type === "apply_lote_ack")).toMatchObject({
				ok: true,
				resultados: [{ opId: "op-main", ok: true, seq: 1 }],
			});

			const cambio = await esperar(handy, (m) => m.type === "change");
			expect(cambio).toEqual({
				type: "change",
				opId: "op-main",
				seq: 1,
				statements: [{ sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);", args: ["z1", "Zona z1"] }],
			});
			// Lo mismo que queda en el log, que es lo que la Main traería por el catch-up.
			const guardado = sql.exec("SELECT Op_Id, Statements_Json FROM Sync_Changes WHERE Seq = 1;").one();
			expect(guardado.Op_Id).toBe(cambio.opId);
			expect(JSON.parse(String(guardado.Statements_Json))).toEqual(cambio.statements);
			// Quien la mandó no recibe su eco.
			expect(main.recibidos.filter((m) => m.type === "change")).toEqual([]);
		});
	});

	it("el de una escritura de la Handy, a la Main y a las demás Handy", async () => {
		await enElHub("difusion-de-la-handy", async (hub: any) => {
			preparar(hub);
			const main = conectar(hub, MAIN, "tpv");
			const handy = conectar(hub, "handy-1", "handy");
			const otra = conectar(hub, "handy-2", "handy");

			const r = await hub.aplicar({
				tenantId: TENANT,
				deviceId: "handy-1",
				opId: "op-handy",
				commandName: "zona_alta",
				command: altaDeZona("z2"),
				cloudPayload: { nombre: "Zona z2", nota: "texto que no tiene por qué viajar" },
				clientNow: "",
			});
			expect(r).toMatchObject({ ok: true });

			const esperado = {
				type: "change",
				opId: "op-handy",
				seq: 1,
				statements: [{ sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);", args: ["z2", "Zona z2"] }],
			};
			expect(await esperar(main, (m) => m.type === "change")).toEqual(esperado);
			expect(await esperar(otra, (m) => m.type === "change")).toEqual(esperado);
			await unMomento();
			expect(handy.recibidos.filter((m) => m.type === "change")).toEqual([]);
			expect(JSON.stringify([...main.recibidos, ...otra.recibidos])).not.toContain("texto que no tiene por qué viajar");
		});
	});

	it("el que se repite al reintentar una operación ya aplicada", async () => {
		// SYNC-03: si la difusión original se perdió, el reintento del emisor la provoca otra vez.
		await enElHub("difusion-repetida", async (hub: any) => {
			preparar(hub);
			const main = conectar(hub, MAIN, "tpv");
			const params = {
				tenantId: TENANT,
				deviceId: "handy-1",
				opId: "op-repetida",
				commandName: "zona_alta",
				command: altaDeZona("z3"),
				cloudPayload: { nombre: "Zona z3" },
				clientNow: "",
			};
			expect(await hub.aplicar(params)).toMatchObject({ ok: true });
			expect(await hub.aplicar(params)).toMatchObject({ ok: true });

			expect(await esperar(main, () => main.recibidos.filter((m) => m.type === "change").length === 2)).toBeTruthy();
			const cambios = main.recibidos.filter((m) => m.type === "change");
			expect(cambios[1]).toEqual(cambios[0]);
			expect(Object.keys(cambios[0]).sort()).toEqual(["opId", "seq", "statements", "type"]);
		});
	});
});

describe("no hay mensajes de presencia", () => {
	it("ni al abrir un socket, ni al autenticarse, ni al irse", async () => {
		await enElHub("difusion-sin-presencia", async (hub: any) => {
			preparar(hub);
			const handy = conectar(hub, "handy-1", "handy");

			// Abrir: el upgrade de verdad. Al que entra, su reto; a los demás, nada.
			const res = await hub.fetch(
				new Request("https://hub/ws", {
					headers: { Upgrade: "websocket", "x-tenant-id": TENANT, "x-device-id": "handy-2", "x-role": "handy" },
				}),
			);
			expect(res.status).toBe(101);
			const servidor = hub.state.getWebSockets("handy-2")[0];
			const nueva = escuchar(res.webSocket as WebSocket, servidor);
			expect(await esperar(nueva, (m) => m.type === "challenge")).toBeTruthy();

			// Autenticarse: el saludo de la Main, sin firmar de verdad (lo que se prueba aquí es lo que se difunde).
			const par = new WebSocketPair();
			hub.state.acceptWebSocket(par[1], [MAIN]);
			par[1].serializeAttachment({ tenantId: TENANT, deviceId: MAIN, role: "tpv", authed: false, pubkeyB64: null, challenge: { nonceB64: "n", expiresAtMs: Date.now() + 60_000 }, recovering: false });
			const main = escuchar(par[0], par[1]);
			hub.verifyHelloSigned = async () => ({ roleFinal: "tpv", pubkeyB64: "pub" });
			await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }));
			expect(await esperar(main, (m) => m.type === "hello_ok")).toMatchObject({ role: "tpv", authed: true });
			expect(await esperar(handy, (m) => m.type === "main_online")).toEqual({ type: "main_online", deviceId: MAIN });

			// Irse.
			main.cliente.close(1000, "se va");
			await hub.webSocketClose(main.servidor, 1000, "se va", true);
			expect(await esperar(handy, (m) => m.type === "main_offline")).toEqual({ type: "main_offline", deviceId: MAIN });
			await unMomento();

			for (const c of [handy, nueva, main]) {
				expect(c.recibidos.filter((m) => m.type === "presence")).toEqual([]);
			}
			// A la Handy que estaba sólo le ha llegado lo que lee: si hay Main.
			expect(handy.recibidos.map((m) => m.type)).toEqual(["main_online", "main_offline"]);
		});
	});
});

describe("un dispositivo no manda mensajes a los demás", () => {
	it("`event` y `tenantDb.ping` se contestan como cualquier tipo desconocido, y no llegan a nadie", async () => {
		await enElHub("difusion-sin-eventos", async (hub: any) => {
			preparar(hub);
			const main = conectar(hub, MAIN, "tpv");
			const handy = conectar(hub, "handy-1", "handy");
			const otra = conectar(hub, "handy-2", "handy");

			await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "event", name: "tenantDb.ping" }));
			await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "event", name: "aviso.cualquiera", payload: { a: 1 } }));
			await hub.webSocketMessage(handy.servidor, JSON.stringify({ type: "event", name: "mesa.abierta", payload: { mesa: "m-1" } }));
			await unMomento();

			expect(main.recibidos).toEqual([
				{ type: "error", error: "unknown_type" },
				{ type: "error", error: "unknown_type" },
			]);
			expect(handy.recibidos).toEqual([{ type: "error", error: "unknown_type" }]);
			expect(otra.recibidos).toEqual([]);
		});
	});
});
