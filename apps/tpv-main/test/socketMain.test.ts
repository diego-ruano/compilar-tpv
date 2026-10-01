// apps/tpv-main/test/socketMain.test.ts
//
// El socket de la Main: conectar, ponerse al día con la nube, subir el outbox y reconectar. Es el
// núcleo de la replicación (docs/arquitectura/sincronizacion.md), y cada regla de aquí es una que, rota, deja a un TPV
// vendiendo sin que la nube se entere o a una Handy enseñando otra cosa, sin ningún error visible.
//
// Se prueba entero, sin React, con tres dobles:
//
//   · `SocketFalso` (`test/helpers/socketFalso.ts`, lo comparte con el test de la Handy): un
//     WebSocket que no conecta a nada, que cierra y recibe como el de un navegador.
//   · un backend de Tauri en memoria (`crearBackend`) que hace de outbox, checkpoint y worker.
//   · el reloj de Vitest: los latidos, los reintentos y las esperas corren cuando el test lo dice.
//
// Lo que NO se prueba aquí es el cableado del hook `useMainSocket` (los eventos del navegador y el
// `pulso`): es enchufar `reconectarSiHaceFalta`, y lo que ese método hace sí está probado.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	invoke: vi.fn(),
	oyentes: new Map<string, () => void>(),
	captureException: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (evento: string, cb: () => void) => {
		h.oyentes.set(evento, cb);
		return () => h.oyentes.delete(evento);
	},
}));
vi.mock("../src/shared/observability/sentry", () => ({ captureException: h.captureException }));

import { queryClient } from "../src/shared/lib/queryClient";
import { iniciarSocketMain, type EntradaSocketMain, type SocketMain } from "../src/shared/lib/socketMain";
import { affectedFeatureKeys } from "../src/shared/lib/syncStatements";
import { useEstadoSync } from "../src/shared/stores/useEstadoSync";
import { useSyncSignal } from "../src/shared/stores/useSyncSignal";
import { asentar, avanzar, conPong, SocketFalso, ultimo, type Mensaje } from "./helpers/socketFalso";

let seqNube = 100;
/** La nube de un día normal: aplica todo lo que le llega. */
const nubeQueAcepta = (m: Mensaje): Mensaje | undefined =>
	m.type === "apply"
		? { type: "apply_ack", opId: m.opId, ok: true, seq: ++seqNube }
		: m.type === "bulk_apply"
			? { type: "bulk_ack", ok: true }
			: undefined;

type Op = { seq: number; op_id: string; command_name: string; statements: { sql: string; args: unknown[] }[] };
/** Una escritura local en el outbox. */
const op = (n: number, sql = `UPDATE Clientes SET Nombre = 'x' WHERE ID = ${n}`): Op => ({
	seq: n,
	op_id: `op-${n}`,
	command_name: "clientes_update",
	statements: [{ sql, args: [] }],
});
/** Un cambio que llega de la nube (de otra Main o de una Handy). */
const cambio = (n: number, sql = `UPDATE Clientes SET Nombre = 'r' WHERE ID = ${n}`) => ({
	opId: `rem-${n}`,
	seq: n,
	statements: [{ sql, args: [] }],
});

/** Los comandos de Tauri que usa el socket, sobre un outbox en memoria. */
function crearBackend() {
	const b = {
		licencia: { tenant_id: "t1" } as { tenant_id: string } | null,
		deviceId: "d1",
		checkpoint: 0,
		outbox: [] as Op[],
		encoladas: new Set<string>(),
		apartadas: new Set<string>(),
		enviadas: [] as { opId: string; seq: number }[],
		intentos: new Map<string, number>(),
		marcarFalloRompe: false,
		aplicados: [] as string[][],
		aplicar: (ids: string[]): string[] => ids,
		ticket: (): unknown => ({ ticket: "tk" }),
		/** PROD-04: la hora de la nube que da Rust para firmar; `null` = no contesta. */
		horaNube: null as number | null,
		cambios: (since: number): unknown => ({ items: [], nextSince: since, highWater: 0 }),
		imagenes: "vacio",
		salud: { outbox_pending: 0, last_seq: 0, quarantined: 0, failing: 0, subida_fallando: 0, subida_en_cuarentena: 0 },
		llamadas: [] as { cmd: string; args: any }[],
		/** PROD-06: lo que la nube tiene apagado; una función que lanza = el comando falla. */
		apagados: (): unknown => [],
	};
	h.invoke.mockImplementation(async (cmd: string, args: any = {}) => {
		b.llamadas.push({ cmd, args });
		switch (cmd) {
			case "license_get_state":
				return b.licencia;
			case "device_get_identity":
				return { deviceId: b.deviceId };
			case "device_sign_b64":
				return { sigB64: `firma:${args.args.payload}` };
			case "device_hora_para_firmar":
				return b.horaNube;
			case "tpv_server_post_json": {
				const { path, body } = args.args;
				if (path === "/v1/ws/ticket") return b.ticket();
				if (path === "/v1/sync/changes") return b.cambios(body.since);
				throw new Error(`ruta inesperada ${path}`);
			}
			case "sync_get_checkpoint":
				return b.checkpoint;
			case "sync_apply_changes": {
				const ids = args.args.changes.map((c: any) => c.op_id);
				const aplicadas = b.aplicar(ids);
				b.aplicados.push(ids);
				return { aplicadas };
			}
			case "sync_liberar_encoladas":
				return 0;
			case "sync_outbox_pending":
				return b.outbox.filter((o) => !b.encoladas.has(o.op_id) && !b.apartadas.has(o.op_id)).slice(0, args.limit);
			case "sync_outbox_mark_sent":
				b.enviadas.push({ opId: args.opId, seq: args.seq });
				b.outbox = b.outbox.filter((o) => o.op_id !== args.opId);
				return null;
			case "sync_outbox_mark_encolada":
				for (const id of args.opIds) b.encoladas.add(id);
				return null;
			case "sync_outbox_mark_failed": {
				if (b.marcarFalloRompe) throw new Error("bd bloqueada");
				const intentos = (b.intentos.get(args.opId) ?? 0) + 1;
				b.intentos.set(args.opId, intentos);
				const apartada = Boolean(args.permanente);
				if (apartada) b.apartadas.add(args.opId);
				return {
					apartada,
					intentos,
					command_name: b.outbox.find((o) => o.op_id === args.opId)?.command_name ?? "",
				};
			}
			case "images_drain_pending":
				return b.imagenes;
			case "sync_health":
				return b.salud;
			case "interruptores_apagados":
				return b.apagados();
			default:
				return null;
		}
	});
	return b;
}
type Backend = ReturnType<typeof crearBackend>;

const estado = () => useEstadoSync.getState().estado;
const cuenta = (b: Backend, cmd: string) => b.llamadas.filter((l) => l.cmd === cmd).length;
const tickets = (b: Backend) =>
	b.llamadas.filter((l) => l.cmd === "tpv_server_post_json" && l.args.args.path === "/v1/ws/ticket").length;
/** Lo que hace el TenantHub al aceptar un socket: pide la firma y, si vale, lo da por bueno. */
async function conectar(s: SocketFalso) {
	s.abrir();
	await s.recibir({ type: "challenge", nonceB64: "bm9uY2U=" });
	await s.recibir({ type: "hello_ok" });
	await asentar();
}
let arrancado: SocketMain | null = null;

async function montar(entrada: Partial<EntradaSocketMain> = {}) {
	const completa: EntradaSocketMain = {
		modo: "tpv",
		hidratada: true,
		preferencia: "auto",
		datosPerdidos: false,
		reconciliacionPendiente: false,
		...entrada,
	};
	arrancado = iniciarSocketMain(completa);
	await asentar();
	const socket = arrancado;
	return {
		socket,
		volverLaRed: async () => {
			socket?.reconectarSiHaceFalta(false);
			await asentar();
		},
		pulso: async () => {
			socket?.reconectarSiHaceFalta(true);
			await asentar();
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	vi.spyOn(Math, "random").mockReturnValue(0);
	vi.stubGlobal("WebSocket", SocketFalso);
	SocketFalso.creados = [];
	SocketFalso.nubePorDefecto = nubeQueAcepta;
	h.oyentes.clear();
	h.captureException.mockReset();
	h.invoke.mockReset();
	useEstadoSync.setState({
		estado: "conectando",
		detalle: null,
		faseRecuperacion: "inactiva",
		errorRecuperacion: null,
		fallosRecuperacion: 0,
		reconciliacionPendiente: false,
	});
});

afterEach(async () => {
	arrancado?.detener();
	arrancado = null;
	// Lo que quedara en vuelo tiene que terminar ANTES de que el test siguiente cambie los dobles.
	await asentar();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("cuándo se intenta", () => {
	it("con la palanca en off se publica pausada y no se toca la red", async () => {
		const b = crearBackend();
		const { socket } = await montar({ preferencia: "off" });
		expect(socket).toBeNull();
		expect(estado()).toBe("pausada");
		expect(b.llamadas).toEqual([]);
	});

	it("con los datos perdidos se publica pausada: un catch-up desde cero sobre una BD vacía sólo haría daño", async () => {
		const b = crearBackend();
		const { socket } = await montar({ datosPerdidos: true });
		expect(socket).toBeNull();
		expect(estado()).toBe("pausada");
		expect(b.llamadas).toEqual([]);
	});

	it("en una Handy, o sin haber leído la palanca, no hace nada", async () => {
		const b = crearBackend();
		expect((await montar({ modo: "handy" })).socket).toBeNull();
		expect((await montar({ hidratada: false })).socket).toBeNull();
		expect(estado()).toBe("conectando");
		expect(b.llamadas).toEqual([]);
	});
});

describe("conexión", () => {
	it("sin licencia no hay a dónde conectarse: sin_identidad, y lo vuelve a mirar al minuto, no antes", async () => {
		const b = crearBackend();
		b.licencia = null;
		await montar();
		expect(estado()).toBe("sin_identidad");
		expect(SocketFalso.creados).toHaveLength(0);
		await avanzar(59_000);
		expect(cuenta(b, "license_get_state")).toBe(1);
		await avanzar(1_000);
		expect(cuenta(b, "license_get_state")).toBe(2);
	});

	it("si el worker rechaza el ticket: rechazado, pide el veredicto de la licencia y espera cinco minutos", async () => {
		const b = crearBackend();
		b.ticket = () => {
			throw { code: "license_expired", message: "Licencia caducada" };
		};
		await montar();
		expect(estado()).toBe("rechazado");
		expect(useEstadoSync.getState().detalle).toBe("Licencia caducada");
		// Es lo que convierte un 403 en la pantalla de licencia sin esperar seis horas al job.
		expect(cuenta(b, "license_check_now")).toBe(1);
		expect(SocketFalso.creados).toHaveLength(0);
		await avanzar(299_000);
		expect(tickets(b)).toBe(1);
		await avanzar(1_000);
		expect(tickets(b)).toBe(2);
	});

	it("rechazado: volver la red no insiste con la misma licencia; el pulso sí", async () => {
		const b = crearBackend();
		b.ticket = () => {
			throw { code: "device_revoked", message: "revocado" };
		};
		const m = await montar();
		await m.volverLaRed();
		expect(tickets(b)).toBe(1);
		await m.pulso();
		expect(tickets(b)).toBe(2);
	});

	it("sin red reintenta con espera creciente, sin pasar de 30 s", async () => {
		const b = crearBackend();
		b.ticket = () => {
			throw new Error("sin red");
		};
		await montar();
		expect(estado()).toBe("reintentando");
		for (const [i, espera] of [3_000, 6_000, 12_000, 24_000, 30_000, 30_000].entries()) {
			await avanzar(espera - 1);
			expect(tickets(b), `el intento ${i + 2} llegó antes de tiempo`).toBe(i + 1);
			await avanzar(1);
			expect(tickets(b), `el intento ${i + 2} no llegó`).toBe(i + 2);
		}
	});

	it("una conexión que llega a autenticarse devuelve la espera a 3 s", async () => {
		const b = crearBackend();
		let fallar = true;
		b.ticket = () => {
			if (fallar) throw new Error("sin red");
			return { ticket: "tk" };
		};
		await montar();
		await avanzar(3_000);
		await avanzar(6_000);
		fallar = false;
		await avanzar(12_000);
		await conectar(ultimo());
		ultimo().cerrar();
		await asentar();
		const antes = tickets(b);
		await avanzar(2_999);
		expect(tickets(b)).toBe(antes);
		await avanzar(1);
		expect(tickets(b)).toBe(antes + 1);
	});

	it("el socket se abre con el ticket de un solo uso en la URL, codificado", async () => {
		const b = crearBackend();
		b.ticket = () => ({ ticket: "a b/c" });
		await montar();
		expect(ultimo().url).toBe("wss://tpv-api.altarialights.workers.dev/ws?ticket=a%20b%2Fc");
	});

	it("contesta al challenge con la firma del dispositivo, y sólo hello_ok la da por conectada", async () => {
		const b = crearBackend();
		// PROD-04: el equipo va tres minutos atrasado. El hub rechaza más de dos: la firma tiene que
		// llevar la hora de la nube que da Rust, no la de este reloj.
		const ts = Date.now() + 3 * 60_000;
		b.horaNube = ts;
		await montar();
		const s = ultimo();
		s.abrir();
		await s.recibir({ type: "challenge", nonceB64: "bm9uY2U=" });
		await asentar();
		expect(s.enviados).toContainEqual({
			type: "helloSigned",
			ts,
			nonceB64: "bm9uY2U=",
			sigB64: `firma:${ts}\nWS_HELLO\nt1\nd1\nbm9uY2U=`,
			recovering: false,
		});
		expect(estado()).not.toBe("conectado");
		await s.recibir({ type: "hello_ok" });
		expect(estado()).toBe("conectado");
	});

	it("un fallo al subir las imágenes pendientes se reporta", async () => {
		const b = crearBackend();
		b.imagenes = "subidas=2 error=timeout";
		await montar();
		await conectar(ultimo());
		expect(h.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: "images_drain_con_errores" }),
			{ resultado: "subidas=2 error=timeout" },
		);
	});

	it("con respuesta al latido el socket sigue abierto indefinidamente", async () => {
		crearBackend();
		await montar();
		const s = ultimo();
		conPong(s);
		await conectar(s);
		await avanzar(10 * 60_000);
		expect(s.readyState).toBe(SocketFalso.OPEN);
		expect(s.tipos().filter((t) => t === "ping")).toHaveLength(20);
	});

	it("un pong perdido suelto no cierra nada; dos latidos y medio sin respuesta, sí", async () => {
		crearBackend();
		await montar();
		const s = ultimo();
		let responder = true;
		s.nube = (m) => {
			if (m.type !== "ping") return nubeQueAcepta(m);
			const r = responder ? { type: "pong" } : undefined;
			responder = false;
			return r;
		};
		await conectar(s);
		await avanzar(90_000);
		expect(s.readyState).toBe(SocketFalso.OPEN);
		await avanzar(30_000);
		// Un TCP medio-abierto no dispara `onclose`: sin esto la Main se quedaría muda para siempre.
		expect(s.readyState).toBe(SocketFalso.CLOSING);
		expect(s.tipos().filter((t) => t === "ping")).toHaveLength(3);
	});

	it("si se cae con una subida en vuelo, la subida no se queda colgada y sale por la conexión siguiente", async () => {
		const b = crearBackend();
		b.outbox = [op(1)];
		SocketFalso.nubePorDefecto = () => undefined;
		await montar();
		const s1 = ultimo();
		await conectar(s1);
		expect(s1.applies()).toEqual(["op-1"]);
		s1.cerrar();
		await asentar();
		expect(estado()).toBe("reintentando");
		SocketFalso.nubePorDefecto = nubeQueAcepta;
		await avanzar(3_000);
		const s2 = ultimo();
		await conectar(s2);
		expect(s2.applies()).toEqual(["op-1"]);
		expect(b.enviadas.map((e) => e.opId)).toEqual(["op-1"]);
	});

	it("volver la red con el socket sano, o mientras se abre, no abre otro", async () => {
		crearBackend();
		const m = await montar();
		await m.volverLaRed();
		expect(SocketFalso.creados).toHaveLength(1);
		await conectar(ultimo());
		await m.volverLaRed();
		expect(SocketFalso.creados).toHaveLength(1);
	});

	it("volver la red con un socket abierto pero sin autenticar lo cierra y abre otro", async () => {
		crearBackend();
		const m = await montar();
		const s1 = ultimo();
		s1.abrir();
		await m.volverLaRed();
		expect(s1.readyState).toBe(SocketFalso.CLOSING);
		expect(SocketFalso.creados).toHaveLength(2);
	});

	it("detener cierra el socket, deja de escuchar el outbox y no vuelve a intentarlo", async () => {
		const b = crearBackend();
		const { socket } = await montar();
		const s = ultimo();
		await conectar(s);
		socket?.detener();
		arrancado = null;
		expect(s.readyState).toBe(SocketFalso.CLOSING);
		s.cerrar();
		await avanzar(10 * 60_000);
		expect(tickets(b)).toBe(1);
		expect(h.oyentes.has("outbox:pending")).toBe(false);
	});

	it("un pair_request invalida la lista de emparejamientos; lo que no es un mensaje se ignora", async () => {
		crearBackend();
		const invalidar = vi.spyOn(queryClient, "invalidateQueries");
		await montar();
		const s = ultimo();
		await conectar(s);
		invalidar.mockClear();
		await s.recibir({ type: "pair_request" });
		expect(invalidar).toHaveBeenCalledWith({ queryKey: ["pairing"] });
		await s.recibirTexto("{roto");
		await s.recibir({ foo: 1 });
		expect(estado()).toBe("conectado");
	});
});

describe("bajada: de la nube a la Main", () => {
	it("el catch-up empieza en el checkpoint y pagina hasta que el cursor deja de avanzar", async () => {
		const b = crearBackend();
		b.checkpoint = 7;
		const paginas: Record<number, unknown> = {
			7: { items: [cambio(8), cambio(9)], nextSince: 9, highWater: 12 },
			9: { items: [cambio(12)], nextSince: 12, highWater: 12 },
			12: { items: [], nextSince: 12, highWater: 12 },
		};
		b.cambios = (since) => paginas[since];
		await montar();
		await conectar(ultimo());
		const pedidas = b.llamadas.filter((l) => l.args?.args?.path === "/v1/sync/changes");
		expect(pedidas.map((l) => l.args.args.body.since)).toEqual([7, 9, 12]);
		expect(b.aplicados).toEqual([["rem-8", "rem-9"], ["rem-12"]]);
	});

	it("lo que llega en vivo durante el catch-up espera, y se aplica después y en orden de seq", async () => {
		const b = crearBackend();
		let soltar!: (v: unknown) => void;
		b.cambios = (since) =>
			since === 0
				? new Promise((r) => {
						soltar = r;
					})
				: { items: [], nextSince: since, highWater: 3 };
		await montar();
		const s = ultimo();
		await conectar(s);
		await s.recibir({ type: "change", ...cambio(5) });
		await s.recibir({ type: "change", ...cambio(4) });
		await asentar();
		// Aplicarlos ya sería meter el futuro antes que el pasado que todavía está bajando.
		expect(b.aplicados).toEqual([]);
		soltar({ items: [cambio(1), cambio(2), cambio(3)], nextSince: 3, highWater: 3 });
		await asentar();
		expect(b.aplicados).toEqual([["rem-1", "rem-2", "rem-3"], ["rem-4", "rem-5"]]);
		await s.recibir({ type: "change", ...cambio(6) });
		await asentar();
		expect(b.aplicados[b.aplicados.length - 1]).toEqual(["rem-6"]);
	});

	it("acepta op_id además de opId, e ignora un cambio sin sentencias", async () => {
		const b = crearBackend();
		await montar();
		const s = ultimo();
		await conectar(s);
		await s.recibir({ type: "change", op_id: "snake", seq: 1, statements: [{ sql: "UPDATE Clientes SET a = 1", args: [] }] });
		await s.recibir({ type: "change", opId: "vacio", seq: 2, statements: [] });
		await asentar();
		expect(b.aplicados).toEqual([["snake"]]);
	});

	it("sólo reacciona a lo que Rust aplicó de verdad, y con las sentencias de eso", async () => {
		const b = crearBackend();
		const invalidar = vi.spyOn(queryClient, "invalidateQueries");
		await montar();
		const s = ultimo();
		await conectar(s);
		invalidar.mockClear();
		const tick = useSyncSignal.getState().tick;

		// Todo eran ecos: nada cambió en esta BD, así que no se recarga nada.
		b.aplicar = () => [];
		await s.recibir({ type: "change", ...cambio(1) });
		await asentar();
		expect(invalidar).not.toHaveBeenCalled();
		expect(useSyncSignal.getState().tick).toBe(tick);

		// De dos cambios se aplica uno: se recarga lo que toca ESE, no lo del otro.
		const proveedores = { sql: "UPDATE Proveedores SET Nombre = 'p' WHERE ID = 1", args: [] };
		b.aplicar = (ids) => ids.filter((id) => id === "rem-3");
		await s.recibir({ type: "change", ...cambio(2) });
		await s.recibir({ type: "change", opId: "rem-3", seq: 3, statements: [proveedores] });
		await asentar();
		const claves = affectedFeatureKeys([proveedores]) ?? [];
		expect(invalidar.mock.calls.map((c) => c[0])).toEqual(claves.map((k) => ({ queryKey: [k] })));
		expect(useSyncSignal.getState().tick).toBe(tick + 1);
	});

	it("un fallo al aplicar se reporta y no corta el flujo vivo", async () => {
		const b = crearBackend();
		let romper = true;
		b.aplicar = (ids) => {
			if (romper) {
				romper = false;
				throw new Error("disco lleno");
			}
			return ids;
		};
		await montar();
		const s = ultimo();
		await conectar(s);
		await s.recibir({ type: "change", ...cambio(1) });
		await asentar();
		expect(h.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: "disco lleno" }), {
			fase: "sync_apply_changes",
		});
		await s.recibir({ type: "change", ...cambio(2) });
		await asentar();
		expect(b.aplicados).toEqual([["rem-2"]]);
	});

	it("un catch-up que agota el tope de páginas se reporta en vez de cortarse en silencio", async () => {
		const b = crearBackend();
		b.cambios = (since) => ({ items: [cambio(since + 1)], nextSince: since + 1, highWater: 99_999 });
		await montar();
		await conectar(ultimo());
		expect(h.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: "sync_catchup_cap_reached" }),
			{ pages: 2000, lastSince: 2000 },
		);
	});
});

describe("subida: de la Main a la nube", () => {
	it("con poco atraso sube de una en una, en orden, y no manda la siguiente sin confirmar la anterior", async () => {
		const b = crearBackend();
		b.outbox = [op(1), op(2), op(3)];
		SocketFalso.nubePorDefecto = () => undefined;
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.applies()).toEqual(["op-1"]);
		expect(s.enviados.find((m) => m.type === "apply")).toEqual({
			type: "apply",
			opId: "op-1",
			commandName: "clientes_update",
			command: {
				type: "tenantDb.transaction",
				payload: { steps: [{ kind: "execute", sql: op(1).statements[0].sql, args: [] }] },
			},
		});
		await s.recibir({ type: "apply_ack", opId: "op-1", ok: true, seq: 41 });
		await asentar();
		expect(s.applies()).toEqual(["op-1", "op-2"]);
		await s.recibir({ type: "apply_ack", opId: "op-2", ok: true, seq: 42 });
		await asentar();
		await s.recibir({ type: "apply_ack", opId: "op-3", ok: true, seq: 43 });
		await asentar();
		// El seq que asignó la nube es el que retira el anti-eco cuando el checkpoint lo supera.
		expect(b.enviadas).toEqual([
			{ opId: "op-1", seq: 41 },
			{ opId: "op-2", seq: 42 },
			{ opId: "op-3", seq: 43 },
		]);
	});

	it("un rechazo transitorio para la cola y la operación se reintenta en la pasada siguiente", async () => {
		const b = crearBackend();
		b.outbox = [op(1), op(2)];
		SocketFalso.nubePorDefecto = (m) =>
			m.type === "apply" ? { type: "apply_ack", opId: m.opId, ok: false, error: "SQLITE_BUSY", permanente: false } : undefined;
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.applies()).toEqual(["op-1"]);
		expect(b.llamadas.filter((l) => l.cmd === "sync_outbox_mark_failed").map((l) => l.args)).toEqual([
			{ opId: "op-1", error: "SQLITE_BUSY", permanente: false },
		]);
		await avanzar(3_000);
		expect(s.applies()).toEqual(["op-1", "op-1"]);
	});

	it("un rechazo definitivo aparta la operación y la cola sigue, y el aviso no lleva las sentencias (SYNC-20)", async () => {
		const b = crearBackend();
		b.outbox = [op(1), op(2)];
		SocketFalso.nubePorDefecto = (m) =>
			m.type === "apply" && m.opId === "op-1"
				? { type: "apply_ack", opId: m.opId, ok: false, error: "no such column: Foo", permanente: true }
				: nubeQueAcepta(m);
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.applies()).toEqual(["op-1", "op-2"]);
		expect(b.enviadas.map((e) => e.opId)).toEqual(["op-2"]);
		expect(h.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: "outbox_op_apartada" }), {
			fase: "drain_outbox",
			op_id: "op-1",
			command_name: "clientes_update",
			intentos: 1,
			permanente: true,
			error_nube: "no such column: Foo",
		});
		// Por las sentencias pasan datos del negocio y PII: a Sentry sólo va con qué comando.
		expect(JSON.stringify(h.captureException.mock.calls)).not.toContain("UPDATE Clientes");
	});

	it("si ni siquiera se puede anotar el rechazo, para: es lo seguro", async () => {
		const b = crearBackend();
		b.outbox = [op(1), op(2)];
		b.marcarFalloRompe = true;
		SocketFalso.nubePorDefecto = (m) =>
			m.type === "apply" ? { type: "apply_ack", opId: m.opId, ok: false, error: "x", permanente: true } : undefined;
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.applies()).toEqual(["op-1"]);
	});

	it("una confirmación de «encolada» no es un envío: se anota como tal y se sigue con la siguiente (SYNC-18)", async () => {
		const b = crearBackend();
		b.outbox = [op(1), op(2)];
		SocketFalso.nubePorDefecto = (m) =>
			m.type === "apply" && m.opId === "op-1" ? { type: "apply_ack", opId: m.opId, ok: true, encolada: true } : nubeQueAcepta(m);
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(b.encoladas.has("op-1")).toBe(true);
		expect(b.enviadas.map((e) => e.opId)).toEqual(["op-2"]);
	});

	it("sin confirmación en 10 s se para, pero NO se le gasta un intento a la operación", async () => {
		// REV-11: que no llegue el ack no dice nada de la operación, dice que no hay línea. Y
		// apartarla no desatascaría nada, porque lo que viene detrás está parado por lo mismo — es
		// el mismo cable. Contarlo costaba ~5 intentos por cada socket medio muerto, así que cuatro
		// baches de red apartaban una venta buena, con su aviso falso a Sentry y la nube divergente.
		const b = crearBackend();
		b.outbox = [op(1)];
		SocketFalso.nubePorDefecto = () => undefined;
		await montar();
		await conectar(ultimo());

		// Varias vueltas del drenado: el timeout, el reintento a los 3 s, y otra vez.
		await avanzar(10_000);
		await avanzar(3_000);
		await avanzar(10_000);
		await avanzar(3_000);
		await avanzar(10_000);

		expect(cuenta(b, "sync_outbox_mark_failed")).toBe(0);
		// Y sigue en la cola, en su sitio: no se ha perdido ni se ha adelantado nadie.
		expect(b.apartadas.size).toBe(0);
		expect(b.enviadas).toEqual([]);
		expect(b.outbox.map((o) => o.op_id)).toEqual(["op-1"]);
	});

	it("un rechazo pasajero de la nube tampoco gasta intento", async () => {
		// REV-11: el DO lo clasifica (`tenantHub.errores.ts`) y lo dice en el ack. Una caída de
		// Turso no es un rechazo de la operación; el cliente no puede deducirlo del texto porque los
		// mensajes de libsql cambian de redacción entre versiones.
		const b = crearBackend();
		b.outbox = [op(1)];
		SocketFalso.nubePorDefecto = (m) =>
			m.type === "apply"
				? {
						type: "apply_ack",
						opId: m.opId,
						ok: false,
						error: "fetch failed: connect ECONNREFUSED",
						permanente: false,
						transitorio: true,
					}
				: undefined;
		await montar();
		await conectar(ultimo());
		await avanzar(3_000);
		await avanzar(3_000);

		expect(cuenta(b, "sync_outbox_mark_failed")).toBe(0);
		expect(b.outbox.map((o) => o.op_id)).toEqual(["op-1"]);
	});

	it("un rechazo que no sabemos clasificar SÍ cuenta, y acaba apartándose", async () => {
		// La otra mitad, y la que impide que esto se convierta en «no apartar nunca»: lo desconocido
		// sigue la política de siempre —fallar hacia transitorio, pero con un tope—, porque una
		// operación que la nube no puede aplicar no puede detener el día de ventas que tiene detrás.
		const b = crearBackend();
		b.outbox = [op(1)];
		SocketFalso.nubePorDefecto = (m) =>
			m.type === "apply"
				? { type: "apply_ack", opId: m.opId, ok: false, error: "algo raro" }
				: undefined;
		await montar();
		await conectar(ultimo());
		await avanzar(3_000);

		expect(b.llamadas.find((l) => l.cmd === "sync_outbox_mark_failed")?.args).toEqual({
			opId: "op-1",
			error: "algo raro",
			permanente: false,
		});
	});

	it("soltar el socket al reconectar no le gasta un intento al que iba en vuelo", async () => {
		// `soltarSocket` resuelve como fallo los acks colgados para no dejar promesas vivas. Eso es
		// correcto, pero es un fallo de transporte: sin decirlo, cada reconexión le costaba un
		// intento a la operación que estuviera esperando su ack.
		const b = crearBackend();
		b.outbox = [op(1)];
		SocketFalso.nubePorDefecto = () => undefined; // nadie contesta: el ack se queda en vuelo
		const { volverLaRed } = await montar();
		await conectar(ultimo());
		await avanzar(1_000);

		// Vuelve la red con el socket a medio morir: se suelta el anterior sin esperar su onclose.
		ultimo().cerrar();
		await volverLaRed();

		expect(cuenta(b, "sync_outbox_mark_failed")).toBe(0);
	});

	it("con más de 100 pendientes al conectar vuelca por trozos de 200 a la cola de la nube (SYNC-18)", async () => {
		const b = crearBackend();
		b.outbox = Array.from({ length: 250 }, (_, i) => op(i + 1));
		await montar();
		const s = ultimo();
		await conectar(s);
		const liberar = b.llamadas.findIndex((l) => l.cmd === "sync_liberar_encoladas");
		const muestra = b.llamadas.findIndex((l) => l.cmd === "sync_outbox_pending");
		// Antes de medir el atraso se sueltan las encoladas que la nube no confirmó en una hora.
		expect(b.llamadas[liberar].args).toEqual({ antiguedadMs: 3_600_000 });
		expect(liberar).toBeLessThan(muestra);
		expect(b.llamadas[muestra].args).toEqual({ limit: 101 });
		expect(s.enviados.filter((m) => m.type === "bulk_apply").map((m) => m.ops.length)).toEqual([200, 50]);
		expect(s.applies()).toEqual([]);
		expect(b.encoladas.size).toBe(250);
	});

	it("con el volcado apagado desde la nube sube de una en una aunque haya atraso (PROD-06)", async () => {
		const b = crearBackend();
		b.outbox = Array.from({ length: 250 }, (_, i) => op(i + 1));
		b.apagados = () => [{ interruptor: "volcado_atraso", motivo: "Turso saturado", hasta_ms: Date.now() + 3_600_000 }];
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.tipos()).not.toContain("bulk_apply");
		expect(b.encoladas.size).toBe(0);
		// No se para nada: sólo cambia de vía.
		expect(b.enviadas.length).toBeGreaterThan(0);
	});

	it("otro interruptor apagado no afecta al volcado (PROD-06)", async () => {
		const b = crearBackend();
		b.outbox = Array.from({ length: 250 }, (_, i) => op(i + 1));
		b.apagados = () => [{ interruptor: "reparacion_nube", motivo: "x", hasta_ms: Date.now() + 3_600_000 }];
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.enviados.filter((m) => m.type === "bulk_apply").map((m) => m.ops.length)).toEqual([200, 50]);
	});

	it("si no se puede saber qué está apagado, vuelca como siempre (PROD-06)", async () => {
		const b = crearBackend();
		b.outbox = Array.from({ length: 250 }, (_, i) => op(i + 1));
		b.apagados = () => {
			throw new Error("comando no disponible");
		};
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.enviados.filter((m) => m.type === "bulk_apply").map((m) => m.ops.length)).toEqual([200, 50]);
	});

	it("con justo 100 pendientes todavía sube de una en una", async () => {
		const b = crearBackend();
		b.outbox = Array.from({ length: 100 }, (_, i) => op(i + 1));
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.tipos()).not.toContain("bulk_apply");
		expect(b.enviadas).toHaveLength(100);
	});

	it("un trozo se cierra al pasar de 256 KB aunque no llegue a 200 operaciones", async () => {
		const b = crearBackend();
		const grande = "x".repeat(100 * 1024);
		b.outbox = Array.from({ length: 150 }, (_, i) => op(i + 1, `INSERT INTO Notas VALUES ('${grande}')`));
		await montar();
		const s = ultimo();
		await conectar(s);
		const trozos = s.enviados.filter((m) => m.type === "bulk_apply").map((m) => m.ops.length);
		expect(trozos).toEqual(Array<number>(50).fill(3));
	});

	it("si la nube no acepta un trozo, se para sin marcar nada como encolado", async () => {
		const b = crearBackend();
		b.outbox = Array.from({ length: 250 }, (_, i) => op(i + 1));
		SocketFalso.nubePorDefecto = (m) => (m.type === "bulk_apply" ? { type: "bulk_ack", ok: false, error: "llena" } : undefined);
		await montar();
		const s = ultimo();
		await conectar(s);
		expect(s.enviados.filter((m) => m.type === "bulk_apply")).toHaveLength(1);
		expect(b.encoladas.size).toBe(0);
	});

	it("una escritura local sube en el momento; sin autenticar no sube nada", async () => {
		const b = crearBackend();
		await montar();
		const s = ultimo();
		s.abrir();
		b.outbox.push(op(1));
		h.oyentes.get("outbox:pending")!();
		await asentar();
		expect(s.applies()).toEqual([]);
		await s.recibir({ type: "challenge", nonceB64: "n" });
		b.outbox = [];
		await s.recibir({ type: "hello_ok" });
		await asentar();
		b.outbox.push(op(2));
		h.oyentes.get("outbox:pending")!();
		await asentar();
		expect(s.applies()).toEqual(["op-2"]);
	});
});

describe("recuperación de una BD restaurada", () => {
	it("catch-up, subida, verificación y sólo entonces desbloqueo", async () => {
		const b = crearBackend();
		b.cambios = (since) => ({ items: [], nextSince: since, highWater: 5 });
		b.salud = { ...b.salud, last_seq: 5 };
		b.outbox = [op(1)];
		await montar({ reconciliacionPendiente: true });
		const s = ultimo();
		await conectar(s);
		expect(s.enviados.find((m) => m.type === "helloSigned")?.recovering).toBe(true);
		// Tras restaurar no se sabe si una marca de encolada sigue viva: se reofrece todo, una vez.
		expect(b.llamadas.filter((l) => l.cmd === "sync_liberar_encoladas").map((l) => l.args)).toEqual([
			{ antiguedadMs: 0 },
		]);
		expect(b.enviadas.map((e) => e.opId)).toEqual(["op-1"]);
		expect(b.llamadas.find((l) => l.cmd === "recovery_complete")?.args).toEqual({ cloudHighWater: 5 });
		expect(s.tipos()).toContain("recovery_ready");
		expect(useEstadoSync.getState().faseRecuperacion).toBe("completada");
	});

	it("si la nube no informa del high-water, la verificación falla cerrada y no desbloquea", async () => {
		const b = crearBackend();
		b.cambios = (since) => ({ items: [], nextSince: since });
		await montar({ reconciliacionPendiente: true });
		const s = ultimo();
		await conectar(s);
		expect(useEstadoSync.getState().faseRecuperacion).toBe("error");
		expect(useEstadoSync.getState().errorRecuperacion).toMatch(/no informa del punto de sincronización/);
		expect(cuenta(b, "recovery_complete")).toBe(0);
		expect(s.readyState).toBe(SocketFalso.CLOSING);
	});

	it("bloqueada: cierra, se queda en pausa y sólo el pulso la reanuda", async () => {
		crearBackend();
		useEstadoSync.setState({ faseRecuperacion: "bloqueada" });
		const m = await montar({ reconciliacionPendiente: true });
		const s = ultimo();
		await conectar(s);
		expect(s.readyState).toBe(SocketFalso.CLOSING);
		s.cerrar();
		await asentar();
		expect(estado()).toBe("pausada");
		await avanzar(10 * 60_000);
		await m.volverLaRed();
		expect(SocketFalso.creados).toHaveLength(1);
		await m.pulso();
		expect(SocketFalso.creados).toHaveLength(2);
	});
});

describe("un socket que ya no es el actual no toca nada", () => {
	// Se reconecta sin esperar al cierre del socket anterior cuando vuelve la red con uno abierto
	// sin autenticar, o con uno que el vigía ya cerró pero cuyo cierre no ha terminado (un TCP
	// medio-abierto puede tardar mucho). Su `onclose` llega entonces con otro socket en su sitio. Y
	// el TenantHub cierra el socket anterior de un dispositivo en cuanto conecta el nuevo
	// («replaced»), así que un socket de más no se queda en uno.

	it("el cierre tardío del anterior no le quita nada a la conexión nueva", async () => {
		const b = crearBackend();
		const m = await montar();
		const s1 = ultimo();
		s1.abrir();
		await m.volverLaRed();
		const s2 = ultimo();
		conPong(s2);
		await conectar(s2);

		s1.cerrar();
		await asentar();

		expect(estado()).toBe("conectado");
		await s2.recibir({ type: "change", ...cambio(1) });
		await asentar();
		expect(b.aplicados, "lo que llega en vivo se sigue aplicando").toEqual([["rem-1"]]);
		b.outbox.push(op(9));
		await avanzar(3_000);
		expect(s2.applies(), "la subida periódica sigue en marcha").toEqual(["op-9"]);
		await avanzar(57_000);
		expect(s2.tipos().filter((t) => t === "ping"), "el latido sigue en marcha").toHaveLength(2);
		expect(SocketFalso.creados, "no se abre ningún socket más").toHaveLength(2);
	});

	it("con la nube echando al socket anterior, no entra en un bucle de reconexiones", async () => {
		crearBackend();
		const m = await montar();
		const s1 = ultimo();
		s1.abrir();
		await m.volverLaRed();
		await conectar(ultimo());
		s1.cerrar();
		await asentar();
		// Durante un minuto, cada socket nuevo que se autentica hace que la nube cierre el anterior.
		for (let i = 0; i < 20; i++) {
			await avanzar(3_000);
			const n = SocketFalso.creados.length;
			if (SocketFalso.creados[n - 1].readyState === SocketFalso.CONNECTING) {
				await conectar(SocketFalso.creados[n - 1]);
				SocketFalso.creados[n - 2].cerrar();
				await asentar();
			}
		}
		expect(SocketFalso.creados).toHaveLength(2);
	});

	it("si el vigía cerró uno medio muerto y vuelve la red, el nuevo no sube nada antes de autenticarse", async () => {
		const b = crearBackend();
		const m = await montar();
		const s1 = ultimo();
		await conectar(s1);
		await avanzar(90_000);
		expect(s1.readyState).toBe(SocketFalso.CLOSING);

		await m.volverLaRed();
		const s2 = ultimo();
		expect(s2).not.toBe(s1);
		s2.abrir();
		b.outbox.push(op(1));
		h.oyentes.get("outbox:pending")!();
		await asentar();
		// Sin autenticar, la nube lo rechazaría y contaría como un intento fallido de esa operación.
		expect(s2.applies()).toEqual([]);

		await s2.recibir({ type: "challenge", nonceB64: "n" });
		await s2.recibir({ type: "hello_ok" });
		await asentar();
		expect(s2.applies()).toEqual(["op-1"]);

		s1.cerrar();
		await asentar();
		expect(estado()).toBe("conectado");
		expect(SocketFalso.creados).toHaveLength(2);
	});

	it("al arrancar de nuevo (acaba una recuperación, cambia la palanca), el cierre del socket anterior no publica nada", async () => {
		crearBackend();
		const { socket } = await montar();
		const s1 = ultimo();
		await conectar(s1);
		socket?.detener();

		await montar();
		const s2 = ultimo();
		await conectar(s2);
		s1.cerrar();
		await asentar();
		expect(estado()).toBe("conectado");
	});
});

describe("REV-04 · lo que la nube aparta de su cola", () => {
	it("se pone en cuarentena aquí y se acusa, para que la nube deje de guardarlo", async () => {
		// La nube apartó dos operaciones del atraso. No es un reintento pendiente: es que allí falta
		// un dato que aquí sí está. Marcarlas es lo que pone su fila en cuarentena y encola la
		// reparación por ESTADO (SYNC-22), que es lo único que repara la divergencia — reenviar la
		// sentencia rechazada daría el mismo rechazo.
		const b = crearBackend();
		b.outbox = [op(1), op(2)];
		await montar();
		const s = ultimo();
		await conectar(s);

		await s.recibir({
			type: "cola_apartada",
			ops: [
				{ opId: "op-1", commandName: "clientes_update", error: "no such column: X" },
				{ opId: "op-2", commandName: "clientes_update", error: "no such column: X" },
			],
		});
		await asentar();

		const marcados = b.llamadas.filter((l) => l.cmd === "sync_outbox_mark_failed");
		expect(marcados.map((l) => l.args.opId)).toEqual(["op-1", "op-2"]);
		// `permanente`, porque el DO ya agotó los suyos: un intento más aquí sería el mismo rechazo.
		expect(marcados.every((l) => l.args.permanente === true)).toBe(true);
		expect(b.apartadas).toEqual(new Set(["op-1", "op-2"]));

		const ack = s.enviados.find((m) => m.type === "cola_apartada_ack");
		expect(ack?.opIds).toEqual(["op-1", "op-2"]);

		// Y que se entere quien puede arreglarlo, con el camino por el que vino.
		const aviso = h.captureException.mock.calls.find(
			(c: any[]) => c[1]?.fase === "cola_de_la_nube",
		);
		expect(aviso).toBeTruthy();
		expect(aviso?.[1].op_id).toBe("op-1");
	});

	it("lo que no se ha podido anotar NO se acusa", async () => {
		// El acuse es lo que hace que la nube tire la fila. Acusar algo que no se ha llegado a
		// registrar aquí sería perder el único rastro de la divergencia: si esto falla, lo correcto
		// es callarse y que la nube lo vuelva a ofrecer en la conexión siguiente.
		const b = crearBackend();
		b.outbox = [op(1)];
		b.marcarFalloRompe = true;
		await montar();
		const s = ultimo();
		await conectar(s);

		await s.recibir({
			type: "cola_apartada",
			ops: [{ opId: "op-1", commandName: "clientes_update", error: "no such column: X" }],
		});
		await asentar();

		expect(s.enviados.some((m) => m.type === "cola_apartada_ack")).toBe(false);
		expect(b.apartadas.size).toBe(0);
	});
});
