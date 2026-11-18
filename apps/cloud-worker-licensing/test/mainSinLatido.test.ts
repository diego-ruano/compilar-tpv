// test/mainSinLatido.test.ts
//
// SYN-INC-01 · Con el cable de la Main cortado, la Handy seguía escribiendo varios minutos. Un corte
// sin cierre deja el socket «abierto» hasta que vence el TCP, y el veto de escritura sólo miraba
// `readyState`. El latido lo contesta el borde sin despertar al DO, así que el DO no tenía cómo
// enterarse.
//
// Ahora una sesión de Main cuenta sólo si da señales de vida: su último latido
// (`getWebSocketAutoResponseTimestamp`) o, si aún no ha mandado ninguno, la hora a la que se
// autenticó (`autenticadaMs`). Una que no da ninguna en 90 s se cierra (`main_sin_latido`) cuando
// hace falta saberlo —una escritura de una Handy o un saludo—, sin alarmas, y las Handy reciben
// `main_offline`.
//
// Sockets reales aceptados con la Hibernation API: decide el censo de producción.

import { describe, expect, it } from "vitest";

import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { laMainEs } from "./helpers/mainVigente";

const TENANT = "tenant-latido";
const MAIN = "main-latido";
const HACE_MUCHO = 5 * 60 * 1000;

type Conexion = { cliente: WebSocket; servidor: WebSocket; recibidos: any[]; cierre: { code: number; reason: string } | null };

function conectar(hub: any, deviceId: string, role: "tpv" | "handy", autenticadaMs: number): Conexion {
	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [deviceId]);
	par[1].serializeAttachment({ tenantId: TENANT, deviceId, role, authed: true, autenticadaMs, pubkeyB64: null, challenge: null, recovering: false });
	const c: Conexion = { cliente: par[0], servidor: par[1], recibidos: [], cierre: null };
	par[0].accept();
	par[0].addEventListener("message", (ev: MessageEvent) => {
		c.recibidos.push(JSON.parse(String(ev.data)));
	});
	par[0].addEventListener("close", (ev: CloseEvent) => {
		c.cierre = { code: ev.code, reason: ev.reason };
	});
	return c;
}

function preparar(hub: any): void {
	crearEsquemaTenant(hub.state.storage.sql);
	const db = clienteLocal(hub.state.storage);
	hub.getTenantDb = async () => db;
	hub.touchLastSeen = async () => {};
	hub.emitSyncEvent = () => {};
	laMainEs(hub, MAIN);
}

async function esperar(pred: () => boolean): Promise<boolean> {
	const limite = Date.now() + 3_000;
	while (Date.now() < limite) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return pred();
}

const escrituraDeLaHandy = (opId: string) => ({
	tenantId: TENANT,
	deviceId: "handy-1",
	opId,
	commandName: "zona_alta",
	command: {
		type: "tenantDb.transaction" as const,
		payload: { steps: [{ kind: "execute" as const, sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, 'Terraza');", args: [opId] }] },
	},
	cloudPayload: {},
	clientNow: "",
});

async function intentar(hub: any, opId: string): Promise<any> {
	try {
		return await hub.aplicar(escrituraDeLaHandy(opId));
	} catch (e: any) {
		return { ok: false, error: e?.code ?? e?.message ?? String(e) };
	}
}

describe("una Main que no da señales de vida no autoriza a las Handy", () => {
	it("sin latido desde hace más de 90 s, la escritura de la Handy no entra, la sesión se cierra y las Handy se enteran", async () => {
		await enElHub("latido-cortado", async (hub: any) => {
			preparar(hub);
			const main = conectar(hub, MAIN, "tpv", Date.now() - HACE_MUCHO);
			const handy = conectar(hub, "handy-1", "handy", Date.now());

			const r = await intentar(hub, "op-sin-main");
			expect(JSON.stringify(r)).toContain("main_offline");
			expect(hub.state.storage.sql.exec("SELECT COUNT(*) AS n FROM Zonas;").one().n).toBe(0);

			expect(main.servidor.deserializeAttachment()).toMatchObject({ authed: false, fuera: true });
			expect(await esperar(() => main.cierre !== null)).toBe(true);
			expect(main.cierre).toMatchObject({ code: 4002, reason: "main_sin_latido" });
			expect(await esperar(() => handy.recibidos.some((m) => m.type === "main_offline"))).toBe(true);
		});
	});

	it("recién autenticada y sin latido todavía, cuenta como conectada", async () => {
		await enElHub("latido-recien-saludada", async (hub: any) => {
			preparar(hub);
			const main = conectar(hub, MAIN, "tpv", Date.now());
			conectar(hub, "handy-1", "handy", Date.now());

			expect(await intentar(hub, "op-con-main")).toMatchObject({ ok: true });
			expect(main.cierre).toBeNull();
		});
	});

	it("autenticada hace mucho pero con latido reciente, cuenta como conectada", async () => {
		await enElHub("latido-reciente", async (hub: any) => {
			preparar(hub);
			const main = conectar(hub, MAIN, "tpv", Date.now() - HACE_MUCHO);
			conectar(hub, "handy-1", "handy", Date.now());

			// El latido de verdad: el borde lo contesta sin pasar por `webSocketMessage` y apunta la hora.
			main.cliente.send(JSON.stringify({ type: "ping" }));
			expect(await esperar(() => main.recibidos.some((m) => m.type === "pong"))).toBe(true);
			expect(hub.state.getWebSocketAutoResponseTimestamp(main.servidor)).not.toBeNull();

			expect(await intentar(hub, "op-con-latido")).toMatchObject({ ok: true });
			expect(main.cierre).toBeNull();
		});
	});

	it("el saludo de una Handy no le dice que hay Main si la que hay no da señales de vida", async () => {
		await enElHub("latido-saludo-handy", async (hub: any) => {
			preparar(hub);
			const main = conectar(hub, MAIN, "tpv", Date.now() - HACE_MUCHO);

			const par = new WebSocketPair();
			hub.state.acceptWebSocket(par[1], ["handy-2"]);
			par[1].serializeAttachment({
				tenantId: TENANT,
				deviceId: "handy-2",
				role: "handy",
				authed: false,
				pubkeyB64: null,
				challenge: { nonceB64: "n", expiresAtMs: Date.now() + 60_000 },
				recovering: false,
			});
			const recibidos: any[] = [];
			par[0].accept();
			par[0].addEventListener("message", (ev: MessageEvent) => {
				recibidos.push(JSON.parse(String(ev.data)));
			});
			hub.verifyHelloSigned = async () => ({ roleFinal: "handy", pubkeyB64: "pub" });
			hub.comprobarMain = () => null;

			await hub.webSocketMessage(par[1], JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }));
			expect(await esperar(() => recibidos.some((m) => m.type === "main_status"))).toBe(true);
			expect(recibidos.find((m) => m.type === "main_status")).toMatchObject({ online: false });
			expect(await esperar(() => main.cierre !== null)).toBe(true);
			expect(main.cierre).toMatchObject({ code: 4002, reason: "main_sin_latido" });
		});
	});
});
