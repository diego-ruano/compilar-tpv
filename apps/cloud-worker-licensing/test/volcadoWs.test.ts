// test/volcadoWs.test.ts
//
// SYNC-18 · el PROTOCOLO del volcado, no su motor.
//
// Los otros dos ficheros prueban el lote y la cola llamando a los métodos por dentro. Esto prueba
// lo de fuera: que un `bulk_apply` que llega por el socket se parsea, se encola y se confirma; que
// un `apply` en vivo con atraso por delante se pone a la cola en vez de adelantarlo; y que quien
// se autentica a mitad de un volcado se entera. Es la parte que ningún test tocaría si sólo se
// probara el motor — y también la más fácil de romper sin querer al renombrar un campo.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { laMainEs } from "./helpers/mainVigente";


const TENANT = "tenant-1";

const SEMILLA = [
	"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');",
	"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '1', 4, 0, 0, 'rect', 80, 80);",
	"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Bebidas');",
	"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-1', 'cat-1', 'Cerveza', 3.0);",
	"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('comanda-1', 'MESA', 'mesa-1', '2026-01-01 12:00:00', 'Abierta');",
];

/** El mensaje tal y como lo manda `useMainSocket`: una operación del outbox. */
function opDelOutbox(n: number) {
	return {
		opId: `op-${n}`,
		commandName: "add_linea",
		command: {
			type: "tenantDb.transaction",
			payload: {
				steps: [
					{
						kind: "execute",
						sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES (?1, 'comanda-1', 'prod-1', 1, 3.0);",
						args: [`det-${n}`],
					},
				],
			},
		},
	};
}

/** Un socket de mentira: guarda lo que le mandan y lleva su propio attachment. */
function socketFalso(role: "tpv" | "handy" = "tpv") {
	const enviados: any[] = [];
	let attachment: any = {
		tenantId: TENANT,
		deviceId: role === "tpv" ? "device-main" : "device-handy",
		role,
		authed: true,
		pubkeyB64: null,
		challenge: null,
	};
	return {
		enviados,
		ws: {
			readyState: 1,
			send: (txt: string) => enviados.push(JSON.parse(txt)),
			deserializeAttachment: () => attachment,
			serializeAttachment: (v: any) => {
				attachment = v;
			},
			close: () => {},
		} as any,
	};
}

function prepararHub(hub: any) {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	for (const s of SEMILLA) sql.exec(s);

	const db = clienteSobre(sql, hub.state.storage);
	hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
	// `last_seen` va contra la BD central, que aquí no existe y tampoco es lo que se prueba.
	hub.touchLastSeen = async () => {};
	// AUD-02: la Main de estas pruebas es la de la licencia (lo otro, en `mainDesplazadaSocket.test.ts`).
	laMainEs(hub, "device-main");
	hub.isMainConnected = () => true;
	hub.isMainReady = () => true;
	// Las tablas de la cola las crea `encolar`, pero los tests que comprueban que NO se encoló nada
	// necesitan poder leerlas igualmente.
	hub.asegurarCola();
	// El interruptor `cola_do` se lee de la base central, que aquí no existe: nadie ha pausado la cola.
	hub.colaPausada = async () => null;
	return { sql, db };
}

/**
 * El camino en vivo se resuelve dentro de un `waitUntil`, así que `webSocketMessage` vuelve antes
 * de que llegue el ack. Se espera a que aparezca en vez de dormir a ciegas.
 */
async function esperarMensaje(enviados: any[], tipo: string, ms = 3000): Promise<any> {
	const limite = Date.now() + ms;
	while (Date.now() < limite) {
		const m = enviados.find((x) => x.type === tipo);
		if (m) return m;
		await new Promise((r) => setTimeout(r, 10));
	}
	return undefined;
}

const enCola = (sql: any) =>
	sql.exec("SELECT Op_Id FROM _Cola_Entrada ORDER BY Seq;").toArray().map((f: any) => f.Op_Id);

describe("SYNC-18 · protocolo del volcado por WebSocket", () => {
	it("un bulk_apply se encola entero y se confirma con los ids aceptados", async () => {
		await enElHub("ws-bulk", async (hub: any) => {
			const { sql } = prepararHub(hub);
			const { ws, enviados } = socketFalso("tpv");

			await hub.webSocketMessage(
				ws,
				JSON.stringify({
					type: "bulk_apply",
					ops: [opDelOutbox(1), opDelOutbox(2), opDelOutbox(3)],
					clientNow: "2026-01-01 12:30:00",
				}),
			);

			const ack = enviados.find((m) => m.type === "bulk_ack");
			expect(ack?.ok).toBe(true);
			expect(ack?.opIds).toEqual(["op-1", "op-2", "op-3"]);
			expect(enCola(sql)).toEqual(["op-1", "op-2", "op-3"]);

			// El ack llega SIN haber tocado la BD del tenant: es lo que lo hace inmediato.
			expect(sql.exec("SELECT COUNT(*) AS n FROM Detalle_Comanda;").toArray()[0].n).toBe(0);
		});
	});

	it("una Handy no puede volcar", async () => {
		// El volcado es SQL crudo: mismo criterio que el `apply` suelto, sólo la Main.
		await enElHub("ws-bulk-rol", async (hub: any) => {
			const { sql } = prepararHub(hub);
			const { ws, enviados } = socketFalso("handy");

			await hub.webSocketMessage(
				ws,
				JSON.stringify({ type: "bulk_apply", ops: [opDelOutbox(1)] }),
			);

			expect(enviados.find((m) => m.type === "bulk_ack")).toMatchObject({
				ok: false,
				error: "forbidden_not_tpv",
			});
			expect(enCola(sql)).toEqual([]);
		});
	});

	it("un trozo con una operación incompleta se rechaza entero", async () => {
		await enElHub("ws-bulk-malo", async (hub: any) => {
			const { sql } = prepararHub(hub);
			const { ws, enviados } = socketFalso("tpv");

			const sinNombre: any = opDelOutbox(2);
			delete sinNombre.commandName;

			await hub.webSocketMessage(
				ws,
				JSON.stringify({ type: "bulk_apply", ops: [opDelOutbox(1), sinNombre] }),
			);

			expect(enviados.find((m) => m.type === "bulk_ack")).toMatchObject({
				ok: false,
				error: "missing_apply_fields",
			});
			expect(enCola(sql)).toEqual([]);
		});
	});

	it("con atraso por delante, un apply en vivo se encola en vez de adelantarlo", async () => {
		// Es lo que mantiene el orden: el outbox de la Main está ordenado y sus operaciones se
		// apoyan unas en otras. La respuesta lo dice (`encolada`), para que la Main no la dé por
		// aplicada y conserve su copia.
		await enElHub("ws-apply-con-cola", async (hub: any) => {
			const { sql } = prepararHub(hub);
			const { ws, enviados } = socketFalso("tpv");

			hub.encolar(TENANT, [
				{
					opId: "op-atraso",
					commandName: "add_linea",
					cmd: opDelOutbox(9).command,
					deviceId: "device-main",
					requestPayloadJson: "{}",
					cloudPayloadJson: "{}",
					clientNow: "2026-01-01 12:30:00",
				},
			]);

			await hub.webSocketMessage(
				ws,
				JSON.stringify({
					type: "apply",
					...opDelOutbox(1),
					clientNow: "2026-01-01 12:31:00",
				}),
			);

			expect(enviados.find((m) => m.type === "apply_ack")).toMatchObject({
				opId: "op-1",
				ok: true,
				encolada: true,
			});
			// Detrás del atraso, no delante.
			expect(enCola(sql)).toEqual(["op-atraso", "op-1"]);
			expect(sql.exec("SELECT COUNT(*) AS n FROM Detalle_Comanda;").toArray()[0].n).toBe(0);
		});
	});

	it("quien se autentica a mitad de un volcado se entera por el main_status", async () => {
		// Una Handy que entra justo mientras la Main sube su atraso tiene que bloquear igual. Con
		// `online` a secas no se enteraría: la Main SÍ está conectada, lo que pasa es que la nube
		// todavía no refleja su estado.
		await enElHub("ws-status-volcando", async (hub: any) => {
			prepararHub(hub);
			const { ws, enviados } = socketFalso("handy");
			// La verificación de la firma no es lo que se prueba aquí (y exige cripto real).
			hub.verifyHelloSigned = async () => ({ roleFinal: "handy", pubkeyB64: "x" });

			hub.encolar(TENANT, [
				{
					opId: "op-atraso",
					commandName: "add_linea",
					cmd: opDelOutbox(9).command,
					deviceId: "device-main",
					requestPayloadJson: "{}",
					cloudPayloadJson: "{}",
					clientNow: "2026-01-01 12:30:00",
				},
			]);

			await hub.webSocketMessage(
				ws,
				JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }),
			);

			const status = await esperarMensaje(enviados, "main_status");
			expect(status).toMatchObject({ online: true, volcando: true });
		});
	});

	it("una Handy que entra durante una recuperación también queda congelada", async () => {
		await enElHub("ws-status-recovery", async (hub: any) => {
			prepararHub(hub);
			hub.isMainRecovering = () => true;
			const { ws, enviados } = socketFalso("handy");
			hub.verifyHelloSigned = async () => ({ roleFinal: "handy", pubkeyB64: "x" });

			await hub.webSocketMessage(
				ws,
				JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }),
			);

			const status = await esperarMensaje(enviados, "main_status");
			expect(status).toMatchObject({ online: true, volcando: true });
		});
	});

	it("sólo la Main puede declarar terminada su recuperación", async () => {
		await enElHub("ws-recovery-ready", async (hub: any) => {
			prepararHub(hub);
			const main = socketFalso("tpv");
			await hub.webSocketMessage(main.ws, JSON.stringify({ type: "recovery_ready" }));
			expect(main.enviados).toContainEqual({ type: "recovery_ready_ack" });
			expect(main.ws.deserializeAttachment().recovering).toBe(false);

			const handy = socketFalso("handy");
			await hub.webSocketMessage(handy.ws, JSON.stringify({ type: "recovery_ready" }));
			expect(handy.enviados).toContainEqual({
				type: "error",
				error: "forbidden_not_tpv",
			});
		});
	});

	it("sin atraso, un apply en vivo se aplica al momento", async () => {
		// La otra mitad del contrato: si no hay cola, nada cambia respecto a antes.
		await enElHub("ws-apply-sin-cola", async (hub: any) => {
			const { sql } = prepararHub(hub);
			const { ws, enviados } = socketFalso("tpv");

			await hub.webSocketMessage(
				ws,
				JSON.stringify({
					type: "apply",
					...opDelOutbox(1),
					clientNow: "2026-01-01 12:31:00",
				}),
			);

			const ack = await esperarMensaje(enviados, "apply_ack");
			expect(ack).toMatchObject({ opId: "op-1", ok: true });
			expect(ack?.encolada).toBeUndefined();
			expect(sql.exec("SELECT COUNT(*) AS n FROM Detalle_Comanda;").toArray()[0].n).toBe(1);
			expect(enCola(sql)).toEqual([]);
		});
	});
});
