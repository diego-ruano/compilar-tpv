// test/congeladoPorAtraso.test.ts
//
// AUD-15 · La Main saluda siempre con `recovering` (`use_cases/replicacion.rs::saludar`) y manda
// `recovery_ready` cuando se ha puesto al día: con su outbox vacío, lo que la nube rechazó ya
// reparado. Aquí se fija la mitad del DO: con ese saludo congela a las Handy (`main_volcando`)
// mientras deja pasar la subida de la Main (`apply_lote`) y `recovery_ready` las suelta.
//
// Sin sustituir `isMainConnected` ni `isMainReady`: la Main y la Handy son sockets reales aceptados
// con `state.acceptWebSocket`, así que decide el censo de producción. Se sustituye sólo la firma del
// saludo. La base del tenant es el SQLite del propio DO, con su cliente de producción, y la base
// central, una de verdad con la licencia del negocio.

import { afterEach, describe, expect, it } from "vitest";

import { deleteComandaIfSafe } from "../src/domains/venta_rapida/venta_rapida.commands";
import type { RespuestaDeLaCentral, SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { centralInterceptada } from "./helpers/central";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub, ponerLaCentral } from "./helpers/hub";
import { centralConLaMain } from "./helpers/mainVigente";

const TENANT = "tenant-1";

/** Lo único que esta prueba deja pedir a la base central: quién es la Main y el `last_seen`. */
const LO_QUE_SE_PIDE_A_LA_CENTRAL = /SELECT main_device_id\s+FROM\s+licenses|UPDATE devices SET last_seen_at_ms/;

/**
 * Lo demás que le ha llegado a la base central en el caso en curso. Se apunta en vez de lanzar: el
 * `last_seen` va por `waitUntil`, y lo que se lanzara por ahí no lo recogería nadie y el caso pasaría
 * igual. Lo comprueba el `afterEach`.
 */
const inesperadas: string[] = [];

afterEach(() => {
	expect(inesperadas.splice(0), "la prueba no espera esto en la base central").toEqual([]);
});

const SEMILLA = [
	"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');",
	"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '1', 4, 0, 0, 'rect', 80, 80);",
	"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Bebidas');",
	"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-1', 'cat-1', 'Cerveza', 300);",
	"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('comanda-1', 'MESA', 'mesa-1', '2026-01-01 12:00:00', 'Abierta');",
	// El ticket de barra que la Main cobró sin conexión: en la nube sigue abierto y sin pagos.
	"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('ticket-barra', 'BARRA', NULL, '2026-01-01 11:50:00', 'Abierta');",
	"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('det-barra', 'ticket-barra', 'prod-1', 1, 300);",
];

/** Una operación del atraso de la Main tal y como la sube (`replicacion.rs::operacion`). */
function opDelAtraso(n: number) {
	return {
		opId: `op-${n}`,
		commandName: "add_linea",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "execute",
						sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES (?1, 'comanda-1', 'prod-1', 1, 300);",
						args: [`det-${n}`],
					},
				],
			},
		},
	};
}

async function prepararHub(hub: any) {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	for (const s of SEMILLA) sql.exec(s);

	const base = clienteLocal(hub.state.storage);
	// Cuenta los lotes que llegan a la base y, si se le pide, rechaza los que lleven un texto. El
	// rechazo es de la base (no deja la confirmación en duda) pero no es de los definitivos: cuenta
	// como un intento de la operación.
	const control = { lotes: 0, rompe: null as string | null };
	const db = {
		...base,
		async batch(sentencias: any[]) {
			control.lotes++;
			if (control.rompe && JSON.stringify(sentencias).includes(control.rompe)) {
				throw Object.assign(new Error("SQLite error: la operación no cuadra todavía"), { code: "SQLITE_ERROR" });
			}
			return base.batch(sentencias);
		},
	};
	hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
	// AUD-02: la Main de estas pruebas es la de la licencia, y su saludo se lo pregunta a la base
	// central. Ningún otro camino de esta prueba debe tocarla: lo demás que le llegue se contesta con
	// un rechazo y hace fallar el caso (`inesperadas`).
	const central = await centralConLaMain(hub, TENANT, "device-main");
	ponerLaCentral(
		hub,
		centralInterceptada(central, async (metodo, [s], llamar) => {
			const texto = metodo === "ejecutar" ? (s as SentenciaEnlazada).sql : "";
			if (LO_QUE_SE_PIDE_A_LA_CENTRAL.test(texto)) return llamar();
			inesperadas.push(`${metodo} ${texto}`.trim());
			const rechazo: RespuestaDeLaCentral<never> = { ok: false, error: "central_error_sql", detalle: "la prueba no lo espera" };
			return rechazo;
		}),
	);
	return { sql, db, control };
}

/**
 * Una sesión de Main ya autenticada cuyo cliente no llega a contestar al cierre: al reemplazarla se
 * queda en `CLOSING` y `getWebSockets()` la sigue devolviendo, que es el caso que hay que cubrir.
 */
function mainSinCerrar(hub: any, recovering: boolean) {
	const par = new WebSocketPair();
	const servidor = par[1];
	hub.state.acceptWebSocket(servidor, ["device-main"]);
	servidor.serializeAttachment({
		tenantId: TENANT,
		deviceId: "device-main",
		role: "tpv",
		authed: true,
		autenticadaMs: Date.now(),
		pubkeyB64: "x",
		challenge: null,
		recovering,
	});
	return { cliente: par[0], servidor, recibidos: [] as any[] };
}

/** La Main reconecta de verdad: el DO abre su socket nuevo y echa el anterior (`abrirWebSocket`). */
async function reconectaLaMain(hub: any, anterior: { servidor: WebSocket }) {
	const res = await hub.fetch(
		new Request("https://hub/ws", {
			headers: { Upgrade: "websocket", "x-tenant-id": TENANT, "x-device-id": "device-main", "x-role": "tpv" },
		}),
	);
	const cliente = res.webSocket as WebSocket;
	cliente.accept();
	const recibidos: any[] = [];
	cliente.addEventListener("message", (ev: MessageEvent) => recibidos.push(JSON.parse(String(ev.data))));
	const servidor = hub.state
		.getWebSockets("device-main")
		.find((ws: WebSocket) => ws !== anterior.servidor && ws.readyState === 1);
	expect(servidor).toBeDefined();
	return { cliente, servidor, recibidos };
}

/** Un socket real del DO (lado servidor aceptado con la Hibernation API) y lo que recibe su cliente. */
function socketReal(hub: any, deviceId: string, role: "tpv" | "handy", authed: boolean) {
	const par = new WebSocketPair();
	const cliente = par[0];
	const servidor = par[1];
	hub.state.acceptWebSocket(servidor, [deviceId]);
	servidor.serializeAttachment({
		tenantId: TENANT,
		deviceId,
		role,
		authed,
		autenticadaMs: Date.now(),
		pubkeyB64: null,
		challenge: authed ? null : { nonceB64: "n", expiresAtMs: Date.now() + 60_000 },
		recovering: false,
	});
	const recibidos: any[] = [];
	cliente.accept();
	cliente.addEventListener("message", (ev: MessageEvent) => {
		recibidos.push(JSON.parse(String(ev.data)));
	});
	return { cliente, servidor, recibidos };
}

async function esperar(cond: () => boolean, ms = 3000): Promise<boolean> {
	const limite = Date.now() + ms;
	while (Date.now() < limite) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return cond();
}

/** La Main saluda como `saludo_socket::saludar` y espera a quedar autenticada. */
async function saludaLaMain(hub: any, main: ReturnType<typeof socketReal>, recovering: boolean) {
	hub.verifyHelloSigned = async () => ({ roleFinal: "tpv", pubkeyB64: "x" });
	await hub.webSocketMessage(
		main.servidor,
		JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s", recovering }),
	);
	expect(await esperar(() => main.recibidos.some((m) => m.type === "hello_ok"))).toBe(true);
}

/** La Main sube su atraso en un lote y espera su acuse. */
async function subeEnUnLote(hub: any, main: ReturnType<typeof socketReal>, ops: any[]) {
	const loteId = `lote-${ops[0].opId}`;
	await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "apply_lote", loteId, ops }));
	expect(await esperar(() => main.recibidos.some((m) => m.type === "apply_lote_ack" && m.loteId === loteId))).toBe(true);
	return main.recibidos.find((m) => m.type === "apply_lote_ack" && m.loteId === loteId);
}

/** Lo que manda `venta_rapida.routes.ts` para `POST /comandas/delete-if-safe`, por el RPC `aplicar`. */
function borradoDeLaHandy(opId: string) {
	const built = deleteComandaIfSafe("ticket-barra");
	return {
		tenantId: TENANT,
		deviceId: "device-handy",
		opId,
		commandName: built.commandName,
		command: built.command,
		cloudPayload: built.cloudPayload,
		clientNow: "2026-01-01 12:31:00",
	};
}

const ticketsDeBarra = (sql: any) =>
	Number(sql.exec("SELECT COUNT(*) AS n FROM Comandas WHERE ID_Comanda = 'ticket-barra';").toArray()[0].n);

describe("AUD-15 · la Main con atraso congela a las Handy hasta subirlo", () => {
	it("el saludo con atraso congela a la Handy, la subida de la Main pasa y recovery_ready la suelta", async () => {
		await enElHub("aud15-congelado", async (hub: any) => {
			const { sql } = await prepararHub(hub);
			const handy = socketReal(hub, "device-handy", "handy", true);
			const main = socketReal(hub, "device-main", "tpv", false);

			await saludaLaMain(hub, main, true);
			// La Handy sabe que hay Main, y que todavía no puede escribir.
			expect(await esperar(() => handy.recibidos.some((m) => m.type === "main_online"))).toBe(true);
			expect(
				await esperar(() => handy.recibidos.some((m) => m.type === "main_volcando" && m.volcando === true)),
			).toBe(true);

			// El atraso de la Main sube, en un lote o en varios...
			const acuse = await subeEnUnLote(hub, main, [opDelAtraso(1), opDelAtraso(2)]);
			expect(acuse).toMatchObject({ ok: true, resultados: [{ opId: "op-1", ok: true }, { opId: "op-2", ok: true }] });
			expect(await subeEnUnLote(hub, main, [opDelAtraso(3)])).toMatchObject({ ok: true, resultados: [{ opId: "op-3", ok: true }] });
			expect(Number(sql.exec("SELECT COUNT(*) AS n FROM Detalle_Comanda WHERE ID_Comanda = 'comanda-1';").one().n)).toBe(3);

			// ...y lo que escribe la Handy mientras tanto espera, sin tocar la nube.
			const congelada = await hub.aplicar(borradoDeLaHandy("op-handy-1"));
			expect(congelada).toMatchObject({ ok: false, error: "main_volcando" });
			expect(ticketsDeBarra(sql)).toBe(1);

			// Una Handy que saluda ahora se entera de que tiene que esperar.
			const otra = socketReal(hub, "device-handy-2", "handy", false);
			hub.verifyHelloSigned = async () => ({ roleFinal: "handy", pubkeyB64: "x" });
			await hub.webSocketMessage(otra.servidor, JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }));
			expect(await esperar(() => otra.recibidos.some((m) => m.type === "main_status"))).toBe(true);
			expect(otra.recibidos.find((m) => m.type === "main_status")).toMatchObject({ online: true, volcando: true });
			// Y no puede soltarse a sí misma: eso sólo lo hace la Main.
			await hub.webSocketMessage(otra.servidor, JSON.stringify({ type: "recovery_ready" }));
			expect(await esperar(() => otra.recibidos.some((m) => m.type === "error"))).toBe(true);
			expect(otra.recibidos).toContainEqual({ type: "error", error: "forbidden_not_tpv" });
			expect(hub.isMainRecovering()).toBe(true);

			// Subido el atraso, `recovery_ready` la suelta.
			await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "recovery_ready" }));
			expect(await esperar(() => main.recibidos.some((m) => m.type === "recovery_ready_ack"))).toBe(true);
			expect(
				await esperar(() => handy.recibidos.some((m) => m.type === "main_volcando" && m.volcando === false)),
			).toBe(true);
			const suelta = await hub.aplicar(borradoDeLaHandy("op-handy-2"));
			expect(suelta).toMatchObject({ ok: true });
			expect(ticketsDeBarra(sql)).toBe(0);

			handy.cliente.close();
			otra.cliente.close();
			main.cliente.close();
		});
	});

	it("una escritura de la Handy admitida con la Main lista no entra si deja de estarlo mientras espera su turno", async () => {
		await enElHub("aud15-turno", async (hub: any) => {
			const { sql, control } = await prepararHub(hub);
			const handy = socketReal(hub, "device-handy", "handy", true);
			const main = socketReal(hub, "device-main", "tpv", false);
			await saludaLaMain(hub, main, true);
			await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "recovery_ready" }));
			expect(hub.isMainReady()).toBe(true);

			// Otra escritura tiene el turno del log; la de la Handy pasa las guardias de entrada y
			// se queda esperando.
			let soltarTurno = () => {};
			const ocupado = new Promise<void>((r) => (soltarTurno = r));
			const turno = hub.enTurnoDelLog(() => ocupado);
			const escritura = hub.aplicar(borradoDeLaHandy("op-handy"));
			await new Promise((r) => setTimeout(r, 20));

			// Mientras espera, la Main deja de estar lista (vuelve a saludar congelando).
			main.servidor.serializeAttachment({ ...main.servidor.deserializeAttachment(), recovering: true });
			const lotesAntes = control.lotes;
			soltarTurno();
			await turno;

			expect(await escritura).toMatchObject({ ok: false, error: "main_volcando" });
			expect(control.lotes).toBe(lotesAntes);
			expect(ticketsDeBarra(sql)).toBe(1);

			handy.cliente.close();
			main.cliente.close();
		});
	});

	it("una Main reemplazada deja de autorizar a las Handy mientras se cierra", async () => {
		await enElHub("aud15-reemplazo-lista", async (hub: any) => {
			await prepararHub(hub);
			const handy = socketReal(hub, "device-handy", "handy", true);
			const vieja = mainSinCerrar(hub, false);
			expect(hub.isMainReady()).toBe(true);

			// La Main reconecta: la sesión vieja queda cerrándose y ya no cuenta, ni por su
			// attachment ni por su estado.
			const nueva = await reconectaLaMain(hub, vieja);
			expect(vieja.servidor.readyState).toBe(2);
			expect(vieja.servidor.deserializeAttachment()).toMatchObject({ authed: false });
			expect(hub.isMainConnected()).toBe(false);

			// La nueva saluda congelando: la Handy espera, aunque la vieja estuviera lista.
			hub.verifyHelloSigned = async () => ({ roleFinal: "tpv", pubkeyB64: "x" });
			await hub.webSocketMessage(
				nueva.servidor,
				JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s", recovering: true }),
			);
			expect(await esperar(() => nueva.recibidos.some((m) => m.type === "hello_ok"))).toBe(true);
			expect(hub.isMainReady()).toBe(false);
			expect(await hub.aplicar(borradoDeLaHandy("op-handy"))).toMatchObject({ ok: false, error: "main_volcando" });
			expect(vieja.servidor.readyState).toBe(2);

			handy.cliente.close();
			nueva.cliente.close();
		});
	});

	it("una Main cuyo socket ya ha cerrado el DO no cuenta, aunque siga en getWebSockets", async () => {
		await enElHub("aud15-cerrando", async (hub: any) => {
			await prepararHub(hub);
			const handy = socketReal(hub, "device-handy", "handy", true);
			const main = mainSinCerrar(hub, false);
			expect(hub.isMainReady()).toBe(true);

			// Un cierre que inicia el DO (una revocación, una confirmación incierta) sin tocar su
			// attachment: mientras termina de cerrarse, ni autoriza ni congela.
			main.servidor.close(4004, "prueba");
			expect(main.servidor.readyState).toBe(2);
			expect(hub.state.getWebSockets("device-main")).toContain(main.servidor);
			expect(main.servidor.deserializeAttachment()).toMatchObject({ authed: true });
			expect(hub.isMainConnected()).toBe(false);
			expect(await hub.aplicar(borradoDeLaHandy("op-handy"))).toMatchObject({ ok: false, error: "main_offline" });

			handy.cliente.close();
		});
	});

	it("una Main reemplazada que estaba congelando no retiene a las Handy cuando la nueva las suelta", async () => {
		await enElHub("aud15-reemplazo-congelando", async (hub: any) => {
			await prepararHub(hub);
			const handy = socketReal(hub, "device-handy", "handy", true);
			const vieja = mainSinCerrar(hub, true);

			const nueva = await reconectaLaMain(hub, vieja);
			expect(vieja.servidor.readyState).toBe(2);
			hub.verifyHelloSigned = async () => ({ roleFinal: "tpv", pubkeyB64: "x" });
			await hub.webSocketMessage(
				nueva.servidor,
				JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s", recovering: true }),
			);
			expect(await esperar(() => nueva.recibidos.some((m) => m.type === "hello_ok"))).toBe(true);

			await hub.webSocketMessage(nueva.servidor, JSON.stringify({ type: "recovery_ready" }));
			expect(hub.isMainRecovering()).toBe(false);
			expect(
				await esperar(() => handy.recibidos.some((m) => m.type === "main_volcando" && m.volcando === false)),
			).toBe(true);
			expect(await hub.aplicar(borradoDeLaHandy("op-handy"))).toMatchObject({ ok: true });
			expect(vieja.servidor.readyState).toBe(2);

			handy.cliente.close();
			nueva.cliente.close();
		});
	});
});
