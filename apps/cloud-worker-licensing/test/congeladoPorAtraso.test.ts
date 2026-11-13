// test/congeladoPorAtraso.test.ts
//
// AUD-15 · La Main saluda siempre con `recovering` (`use_cases/replicacion.rs::saludar`) y manda
// `recovery_ready` cuando se ha puesto al día: lo que hizo sin conexión ha subido, la cola del DO
// está vacía y lo que el DO apartó de ella está reparado. Aquí se fija la mitad del DO: con ese
// saludo congela a las Handy (`main_volcando`) mientras deja pasar la subida de la Main y
// `recovery_ready` las suelta; lo apartado llega a la Main antes de `main_status`, que cierra el
// saludo y dice lo que queda en la cola (`cola`), y al vaciarse la cola se lo dice con `cola: 0`
// después de avisar de lo que apartó.
//
// Sin sustituir `isMainConnected` ni `isMainReady`: la Main y la Handy son sockets reales aceptados
// con `state.acceptWebSocket`, así que decide el censo de producción. Se sustituye sólo lo que
// saldría del DO: la firma del saludo, `last_seen` y la base del tenant (el SQLite del propio DO).

import { describe, expect, it } from "vitest";

import { deleteComandaIfSafe } from "../src/domains/venta_rapida/venta_rapida.commands";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { laMainEs } from "./helpers/mainVigente";

const TENANT = "tenant-1";

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

/** Una operación del atraso de la Main tal y como sube por el camino en vivo (`apply`). */
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

/** Una operación que la base no sabe aplicar (`no such table`): el drenado la aparta en el acto. */
function opRota(n: number) {
	const op = opDelAtraso(n);
	op.command.payload.steps[0].sql = "INSERT INTO Tabla_Que_No_Existe (a) VALUES (?1);";
	return op;
}

/** La misma operación tal y como la guarda la cola del DO (`encolar`). */
function paraLaCola(op: ReturnType<typeof opDelAtraso>) {
	return {
		opId: op.opId,
		commandName: op.commandName,
		cmd: op.command,
		deviceId: "device-main",
		requestPayloadJson: "{}",
		cloudPayloadJson: "{}",
		clientNow: "2026-01-01 12:30:00",
	};
}

function prepararHub(hub: any) {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	for (const s of SEMILLA) sql.exec(s);

	const base = clienteSobre(sql, hub.state.storage);
	// Cuenta los lotes que llegan a la base y, si se le pide, rechaza los que lleven un texto. El
	// rechazo es de la base (no deja la confirmación en duda) pero no es de los definitivos: cuenta
	// como un intento de la operación.
	const control = { lotes: 0, rompe: null as string | null };
	const db = {
		...base,
		async batch(sentencias: any[], modo?: string) {
			control.lotes++;
			if (control.rompe && JSON.stringify(sentencias).includes(control.rompe)) {
				throw Object.assign(new Error("SQLite error: la operación no cuadra todavía"), { code: "SQLITE_ERROR" });
			}
			return base.batch(sentencias, modo);
		},
	};
	hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
	hub.touchLastSeen = async () => {};
	// Ningún camino de esta prueba debe tocar la base central.
	hub.getCentralDb = () => {
		throw new Error("la prueba no tiene base central");
	};
	// AUD-02: la Main de estas pruebas es la de la licencia, y su saludo lo pregunta a un doble.
	laMainEs(hub, "device-main");
	hub.asegurarCola();
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

/** La Main sube una operación de su atraso por el camino en vivo y espera su `apply_ack`. */
async function subeEnVivo(hub: any, main: ReturnType<typeof socketReal>, op: any) {
	await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "apply", ...op, clientNow: "2026-01-01 12:30:00" }));
	expect(await esperar(() => main.recibidos.some((m) => m.type === "apply_ack" && m.opId === op.opId))).toBe(true);
	return main.recibidos.find((m) => m.type === "apply_ack" && m.opId === op.opId);
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
			const { sql } = prepararHub(hub);
			const handy = socketReal(hub, "device-handy", "handy", true);
			const main = socketReal(hub, "device-main", "tpv", false);

			await saludaLaMain(hub, main, true);
			// La Handy sabe que hay Main, y que todavía no puede escribir.
			expect(await esperar(() => handy.recibidos.some((m) => m.type === "main_online"))).toBe(true);
			expect(
				await esperar(() => handy.recibidos.some((m) => m.type === "main_volcando" && m.volcando === true)),
			).toBe(true);

			// El atraso de la Main sube por el camino en vivo, sin cola de por medio...
			const ack = await subeEnVivo(hub, main, opDelAtraso(1));
			expect(ack).toMatchObject({ ok: true });
			expect(ack.encolada).toBeUndefined();

			// ...y lo que escribe la Handy mientras tanto espera, sin tocar la nube.
			const congelada = await hub.aplicar(borradoDeLaHandy("op-handy-1"));
			expect(congelada).toMatchObject({ ok: false, error: "main_volcando" });
			expect(ticketsDeBarra(sql)).toBe(1);

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
			main.cliente.close();
		});
	});

	it("lo apartado le llega a la Main antes de main_status, que cierra el saludo y dice lo que queda en la cola", async () => {
		await enElHub("aud15-saludo", async (hub: any) => {
			prepararHub(hub);
			// Sin Main, el DO drenó y apartó una operación de su cola...
			hub.colaPausada = async () => null;
			hub.encolar(TENANT, [paraLaCola(opRota(2))]);
			await hub.drenarCola();
			expect(hub.apartadasPendientes().map((o: any) => o.opId)).toEqual(["op-2"]);
			// ...y le queda otra, con el drenado en pausa.
			hub.colaPausada = async () => ({ hasta_ms: Date.now() + 10 * 60_000 });
			hub.encolar(TENANT, [paraLaCola(opDelAtraso(3))]);

			const main = socketReal(hub, "device-main", "tpv", false);
			await saludaLaMain(hub, main, true);
			expect(await esperar(() => main.recibidos.some((m) => m.type === "main_status"))).toBe(true);

			const tipos = main.recibidos.map((m) => m.type);
			expect(tipos.indexOf("cola_apartada")).toBeGreaterThan(tipos.indexOf("hello_ok"));
			expect(tipos.indexOf("cola_apartada")).toBeLessThan(tipos.indexOf("main_status"));
			expect(main.recibidos.find((m) => m.type === "main_status")).toMatchObject({ cola: 1 });

			hub.sacarDeLaCola(["op-3"]);
			await hub.state.storage.deleteAlarm();
			main.cliente.close();
		});
	});

	it("al vaciarse la cola la Main recibe lo apartado y después cola: 0, y las Handy esperan a su recovery_ready", async () => {
		await enElHub("aud15-volcado", async (hub: any) => {
			const { sql } = prepararHub(hub);
			hub.colaPausada = async () => null;
			const handy = socketReal(hub, "device-handy", "handy", true);
			const main = socketReal(hub, "device-main", "tpv", false);
			await saludaLaMain(hub, main, true);

			await hub.webSocketMessage(
				main.servidor,
				JSON.stringify({ type: "bulk_apply", ops: [opDelAtraso(1), opRota(2), opDelAtraso(3)] }),
			);
			expect(await esperar(() => main.recibidos.some((m) => m.type === "bulk_ack"))).toBe(true);
			expect(main.recibidos.find((m) => m.type === "main_volcando")).toMatchObject({ volcando: true, cola: 3 });

			await hub.drenarCola();

			// La Main se entera de lo apartado y, después, de que la cola está vacía.
			expect(await esperar(() => main.recibidos.some((m) => m.type === "main_volcando" && m.cola === 0))).toBe(true);
			const tipos = main.recibidos.map((m) => `${m.type}${m.cola === 0 ? ":0" : ""}`);
			expect(tipos.indexOf("cola_apartada")).toBeGreaterThan(-1);
			expect(tipos.indexOf("cola_apartada")).toBeLessThan(tipos.indexOf("main_volcando:0"));

			// Las Handy siguen congeladas: la Main todavía tiene que reparar lo apartado.
			expect(
				await esperar(() => handy.recibidos.some((m) => m.type === "main_volcando" && m.cola === 0)),
			).toBe(true);
			expect(handy.recibidos.filter((m) => m.type === "main_volcando").at(-1)).toMatchObject({ volcando: true });
			expect(await hub.aplicar(borradoDeLaHandy("op-handy-1"))).toMatchObject({ ok: false, error: "main_volcando" });
			expect(ticketsDeBarra(sql)).toBe(1);

			// Reparado, `recovery_ready` las suelta.
			await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "recovery_ready" }));
			expect(
				await esperar(() => handy.recibidos.some((m) => m.type === "main_volcando" && m.volcando === false)),
			).toBe(true);
			expect(await hub.aplicar(borradoDeLaHandy("op-handy-2"))).toMatchObject({ ok: true });

			handy.cliente.close();
			main.cliente.close();
		});
	});

	it("una escritura de la Handy admitida con la Main lista no entra si deja de estarlo mientras espera su turno", async () => {
		await enElHub("aud15-turno", async (hub: any) => {
			const { sql, db, control } = prepararHub(hub);
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
			prepararHub(hub);
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
			prepararHub(hub);
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
			prepararHub(hub);
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

	it("si el quinto fallo aparta la última de la cola, se avisa de que está vacía", async () => {
		await enElHub("aud15-agotada", async (hub: any) => {
			const { control } = prepararHub(hub);
			// Sólo drenan las vueltas de la prueba: una alarma de fondo encontraría la cola en pausa.
			let aMano = false;
			hub.colaPausada = async () => (aMano ? null : { hasta_ms: Date.now() + 10 * 60_000 });
			const drenar = async () => {
				aMano = true;
				try {
					await hub.drenarCola();
				} finally {
					aMano = false;
				}
				await hub.state.storage.deleteAlarm();
			};
			const handy = socketReal(hub, "device-handy", "handy", true);
			const main = socketReal(hub, "device-main", "tpv", false);
			await saludaLaMain(hub, main, true);
			await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "recovery_ready" }));

			// Lo único que queda en la cola falla cada vez, sin ser un rechazo definitivo.
			control.rompe = "det-9";
			hub.encolar(TENANT, [paraLaCola(opDelAtraso(9))]);
			await hub.state.storage.deleteAlarm();
			// Lo que llegue después del aviso de que hay cola es del drenado (el `recovery_ready` de
			// antes ya dijo `cola: 0`).
			const conCola = (m: any) => m.type === "main_volcando" && m.cola === 1;
			expect(await esperar(() => main.recibidos.some(conCola) && handy.recibidos.some(conCola))).toBe(true);
			const mainDesde = main.recibidos.findIndex(conCola) + 1;
			const handyDesde = handy.recibidos.findIndex(conCola) + 1;
			const aMain = () => main.recibidos.slice(mainDesde);
			const aHandy = () => handy.recibidos.slice(handyDesde);

			for (let i = 0; i < 4; i++) await drenar();
			expect(aMain().some((m) => m.type === "cola_apartada")).toBe(false);
			await drenar();
			expect(hub.apartadasPendientes().map((o: any) => o.opId)).toEqual(["op-9"]);

			// El quinto intento la aparta: la Main se entera y, después, la cola está vacía.
			expect(await esperar(() => aMain().some((m) => m.type === "main_volcando" && m.cola === 0))).toBe(true);
			const tipos = aMain().map((m) => `${m.type}${m.cola === 0 ? ":0" : ""}`);
			expect(tipos.indexOf("cola_apartada")).toBeGreaterThan(-1);
			expect(tipos.indexOf("cola_apartada")).toBeLessThan(tipos.indexOf("main_volcando:0"));
			expect(
				await esperar(() => aHandy().some((m) => m.type === "main_volcando" && m.volcando === false)),
			).toBe(true);

			await hub.state.storage.deleteAlarm();
			handy.cliente.close();
			main.cliente.close();
		});
	});

	it("una alarma que encuentra la cola vacía repite el aviso que se perdiera", async () => {
		await enElHub("aud15-aviso-perdido", async (hub: any) => {
			prepararHub(hub);
			const handy = socketReal(hub, "device-handy", "handy", true);
			const main = socketReal(hub, "device-main", "tpv", false);
			await saludaLaMain(hub, main, true);
			await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "recovery_ready" }));

			// La cola se vació sin que nadie avisara: la Handy se quedó esperando.
			hub.encolar(TENANT, [paraLaCola(opDelAtraso(9))]);
			hub.sacarDeLaCola(["op-9"]);
			const avisos = () => handy.recibidos.filter((m) => m.type === "main_volcando").length;
			const antes = avisos();

			await hub.drenarCola();
			expect(await esperar(() => avisos() > antes)).toBe(true);
			expect(handy.recibidos.filter((m) => m.type === "main_volcando").at(-1)).toMatchObject({ volcando: false, cola: 0 });

			await hub.state.storage.deleteAlarm();
			handy.cliente.close();
			main.cliente.close();
		});
	});
});
