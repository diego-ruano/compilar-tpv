// apps/tpv-main/test/socketHandy.test.ts
//
// El socket del Handy. No tiene base de datos: todo lo que enseña lo lee de la nube, y este socket es
// lo único que le dice dos cosas sin las que trabaja a ciegas:
//
//   · si hay una Main activa. Sin ella el Handy se bloquea entero, y lo que no puede pasar es lo
//     contrario: que se quede operando sobre una nube congelada, o bloqueado con la Main ahí;
//   · que algo ha cambiado en la nube, para volver a leerlo. Si no llega, el camarero ve una mesa
//     que ya no es como está.
//
// Se prueba sin React, con los mismos dobles que el socket de la Main (`test/helpers/socketFalso.ts`)
// y un backend de Tauri en memoria con los tres comandos que usa.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { queryClient } from "../src/shared/lib/queryClient";
import { iniciarSocketHandy, type SocketHandy } from "../src/shared/lib/socketHandy";
import { affectedFeatureKeys, tocaAjustes } from "../src/shared/lib/syncStatements";
import { useBusinessSettings } from "../src/shared/stores/useBusinessSettings";
import { useMainPresence } from "../src/shared/stores/useMainPresence";
import { useSyncSignal } from "../src/shared/stores/useSyncSignal";
import { useTicketSettings } from "../src/shared/stores/useTicketSettings";
import { asentar, avanzar, conPong, SocketFalso, ultimo } from "./helpers/socketFalso";

function crearBackend() {
	const b = {
		auth: { token: "jwt", tenantId: "t1" } as { token: string; tenantId: string } | null,
		deviceId: "h1",
		ticket: (): unknown => ({ ticket: "tk" }),
		/** PROD-04: la hora de la nube que da Rust para firmar; `null` = no contesta. */
		horaNube: null as number | null,
		llamadas: [] as { cmd: string; args: any }[],
	};
	h.invoke.mockImplementation(async (cmd: string, args: any = {}) => {
		b.llamadas.push({ cmd, args });
		switch (cmd) {
			case "handy_get_tenant":
				return b.auth?.tenantId ?? null;
			case "device_get_identity":
				return { deviceId: b.deviceId };
			case "device_firmar_hello": {
                const ts = b.horaNube ?? Date.now();
                return { ts, sigB64: `firma:${ts}\nWS_HELLO\n${b.auth?.tenantId}\n${b.deviceId}\n${args.args.nonce_b64}` };
            }
			case "device_hora_para_firmar":
				return b.horaNube;
			case "tpv_server_post_json":
				if (args.args.path === "/v1/ws/ticket") return b.ticket();
				throw new Error(`ruta inesperada ${args.args.path}`);
			default:
				return null;
		}
	});
	return b;
}
type Backend = ReturnType<typeof crearBackend>;

const cuenta = (b: Backend, cmd: string) => b.llamadas.filter((l) => l.cmd === cmd).length;
const presencia = () => useMainPresence.getState();

/** Lo que hace el TenantHub con un Handy: pide la firma y, si vale, le cuenta si hay Main. */
async function conectar(s: SocketFalso, estado = { online: true, volcando: false }) {
	s.abrir();
	await s.recibir({ type: "challenge", nonceB64: "bm9uY2U=" });
	await s.recibir({ type: "main_status", ...estado });
	await asentar();
}

let arrancado: SocketHandy | null = null;

async function montar() {
	arrancado = iniciarSocketHandy("handy");
	await asentar();
	return arrancado!;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	vi.spyOn(Math, "random").mockReturnValue(0);
	vi.stubGlobal("WebSocket", SocketFalso);
	SocketFalso.reiniciar();
	h.invoke.mockReset();
	useMainPresence.setState({ mainOnline: null, volcando: false, retryTick: 0, rechazo: null });
});

afterEach(async () => {
	arrancado?.detener();
	arrancado = null;
	await asentar();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("cuándo se intenta", () => {
	it("sólo en un Handy: en una Main, o sin modo todavía, no hace nada", async () => {
		const b = crearBackend();
		expect(iniciarSocketHandy("tpv")).toBeNull();
		expect(iniciarSocketHandy(null)).toBeNull();
		expect(iniciarSocketHandy("loading")).toBeNull();
		await asentar();
		expect(b.llamadas).toEqual([]);
	});

	it("sin emparejar no abre nada y lo vuelve a mirar con espera creciente", async () => {
		const b = crearBackend();
		b.auth = null;
		await montar();
		expect(SocketFalso.creados).toHaveLength(0);
		for (const [i, espera] of [3_000, 6_000, 12_000, 24_000, 30_000, 30_000].entries()) {
			await avanzar(espera - 1);
			expect(cuenta(b, "handy_get_tenant"), `el intento ${i + 2} llegó antes de tiempo`).toBe(i + 1);
			await avanzar(1);
			expect(cuenta(b, "handy_get_tenant"), `el intento ${i + 2} no llegó`).toBe(i + 2);
		}
		expect(SocketFalso.creados).toHaveLength(0);
	});

	it("sin ticket tampoco abre, y reintenta", async () => {
		const b = crearBackend();
		b.ticket = () => {
			throw new Error("sin red");
		};
		await montar();
		await avanzar(3_000);
		expect(SocketFalso.creados).toHaveLength(0);
		expect(cuenta(b, "handy_get_tenant")).toBe(2);
	});
});

describe("cuando la nube dice que no", () => {
	// El token de una Handy caduca a los 30 días y la nube también puede revocarla. Eso llega como
	// un código del catálogo, no como un fallo de red, y la diferencia es todo: un corte se reintenta
	// y se pasa solo; esto no se pasa hasta que alguien va y lo arregla. Mientras se trataron igual,
	// la pantalla decía «Conectando…» para siempre y nadie llegaba a enterarse.
	const rechazando = (b: Backend, code: string) => {
		b.ticket = () => {
			throw { code, message: "lo que diga la nube" };
		};
	};

	it("a un dispositivo revocado se le dice, y se deja de insistir cada pocos segundos", async () => {
		const b = crearBackend();
		rechazando(b, "device_revoked");
		await montar();

		expect(presencia().rechazo).toBe("dispositivo");
		expect(SocketFalso.creados).toHaveLength(0);
		// Y sigue bloqueado: un rechazo no es permiso para operar a ciegas.
		expect(presencia().mainOnline).toBeNull();

		// La espera pasa a ser de cinco minutos, no la corta de un corte de red.
		await avanzar(5 * 60_000 - 1);
		expect(cuenta(b, "tpv_server_post_json")).toBe(1);
		await avanzar(1);
		expect(cuenta(b, "tpv_server_post_json")).toBe(2);
	});

	it("una licencia caída se cuenta distinto: eso no se arregla aquí", async () => {
		const b = crearBackend();
		rechazando(b, "license_expired");
		await montar();
		expect(presencia().rechazo).toBe("licencia");
	});

	it("lo que no reconoce sigue siendo falta de red, y se reintenta enseguida", async () => {
		const b = crearBackend();
		rechazando(b, "internal");
		await montar();
		expect(presencia().rechazo).toBeNull();
		await avanzar(3_000);
		expect(cuenta(b, "tpv_server_post_json")).toBe(2);
	});

	it("y al volver a dejarle entrar, el aviso se retira solo", async () => {
		const b = crearBackend();
		let rechazar = true;
		b.ticket = () => {
			if (rechazar) throw { code: "device_revoked", message: "lo que diga la nube" };
			return { ticket: "tk" };
		};
		await montar();
		expect(presencia().rechazo).toBe("dispositivo");

		rechazar = false;
		await avanzar(5 * 60_000);
		await conectar(ultimo());

		expect(presencia().rechazo).toBeNull();
		expect(presencia().mainOnline).toBe(true);
	});

	it("volver a primer plano no vuelve a preguntar mientras el rechazo siga en pie", async () => {
		const b = crearBackend();
		rechazando(b, "device_revoked");
		const s = await montar();

		const antes = cuenta(b, "tpv_server_post_json");
		s.reconectarSiHaceFalta();
		await asentar();
		expect(cuenta(b, "tpv_server_post_json")).toBe(antes);
	});
});

describe("conexión", () => {
	it("abre con el ticket de un solo uso en la URL, nunca con el token", async () => {
		const b = crearBackend();
		b.ticket = () => ({ ticket: "a b/c" });
		await montar();
		expect(ultimo().url).toBe("wss://tpv-api.altarialights.workers.dev/ws?ticket=a%20b%2Fc");
		expect(ultimo().url).not.toContain("jwt");
	});

	it("contesta al challenge con la firma del dispositivo y del tenant emparejado", async () => {
		const b = crearBackend();
		// PROD-04: con el reloj del equipo adelantado, la firma lleva la hora de la nube.
		const ts = Date.now() - 5 * 60_000;
		b.horaNube = ts;
		await montar();
		const s = ultimo();
		s.abrir();
		await s.recibir({ type: "challenge", nonceB64: "bm9uY2U=" });
		await asentar();
		expect(s.enviados).toEqual([
			{ type: "helloSigned", ts, nonceB64: "bm9uY2U=", sigB64: `firma:${ts}\nWS_HELLO\nt1\nh1\nbm9uY2U=` },
		]);
	});

	it("una conexión que llega a saber de la Main devuelve la espera a 3 s", async () => {
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
		const antes = SocketFalso.creados.length;
		await avanzar(2_999);
		expect(SocketFalso.creados).toHaveLength(antes);
		await avanzar(1);
		expect(SocketFalso.creados).toHaveLength(antes + 1);
	});

	it("con la Main respondiendo al latido, late cada 30 s y el socket sigue abierto", async () => {
		crearBackend();
		await montar();
		const s = ultimo();
		conPong(s);
		await conectar(s);
		await avanzar(10 * 60_000);
		expect(s.readyState).toBe(SocketFalso.OPEN);
		expect(s.pings()).toBe(20);
	});

	it("un socket medio muerto —sin respuesta al latido— se cierra, y la Handy vuelve a conectar", async () => {
		// Un TCP medio-abierto (suspensión del móvil, cambio de red) no dispara `onclose`: el socket
		// sigue OPEN y la Main «confirmada», así que la Handy se da por sana, no reconecta ni al volver
		// a primer plano y enseña datos viejos sin avisar. Es el caso que el vigía de SYNC-17 cubre en
		// la Main.
		crearBackend();
		await montar();
		const s = ultimo();
		await conectar(s);

		await avanzar(60_000);
		expect(s.readyState).toBe(SocketFalso.OPEN);
		await avanzar(30_000);
		expect(s.readyState).toBe(SocketFalso.CLOSING);

		s.cerrar();
		await avanzar(3_000);
		expect(SocketFalso.creados).toHaveLength(2);
	});

	it("un pong perdido suelto no cierra nada", async () => {
		crearBackend();
		await montar();
		const s = ultimo();
		let responder = true;
		s.nube = (m) => {
			if (m.type !== "ping") return undefined;
			const r = responder ? { type: "pong" } : undefined;
			responder = false;
			return r;
		};
		await conectar(s);
		await avanzar(90_000);
		expect(s.readyState).toBe(SocketFalso.OPEN);
		await avanzar(30_000);
		expect(s.readyState).toBe(SocketFalso.CLOSING);
	});
});

describe("la presencia de la Main", () => {
	it("main_status fija si hay Main y si está volcando; los avisos en vivo la actualizan", async () => {
		crearBackend();
		await montar();
		const s = ultimo();
		await conectar(s, { online: true, volcando: true });
		expect(presencia().mainOnline).toBe(true);
		expect(presencia().volcando).toBe(true);

		await s.recibir({ type: "main_volcando", volcando: false });
		expect(presencia().volcando).toBe(false);
		await s.recibir({ type: "main_offline" });
		expect(presencia().mainOnline).toBe(false);
		await s.recibir({ type: "main_online" });
		expect(presencia().mainOnline).toBe(true);
	});

	it("hasta saber de la Main, el Handy no se da por desbloqueado", async () => {
		crearBackend();
		await montar();
		const s = ultimo();
		s.abrir();
		await s.recibir({ type: "challenge", nonceB64: "n" });
		await asentar();
		expect(presencia().mainOnline).toBeNull();
	});

	it("una caída breve no bloquea: si vuelve la presencia en menos de 5 s, nunca pasa por «desconocida»", async () => {
		crearBackend();
		await montar();
		await conectar(ultimo());
		const vistos: (boolean | null)[] = [];
		const desuscribir = useMainPresence.subscribe((p) => vistos.push(p.mainOnline));

		ultimo().cerrar();
		await avanzar(3_000);
		await conectar(ultimo());
		await avanzar(10_000);
		desuscribir();

		expect(vistos).not.toContain(null);
		expect(presencia().mainOnline).toBe(true);
	});

	it("si no vuelve en 5 s, pasa a «desconocida», que es lo que bloquea el Handy", async () => {
		const b = crearBackend();
		await montar();
		await conectar(ultimo());
		b.ticket = () => {
			throw new Error("sin red");
		};

		ultimo().cerrar();
		await avanzar(4_999);
		expect(presencia().mainOnline).toBe(true);
		await avanzar(1);
		expect(presencia().mainOnline).toBeNull();
	});
});

describe("los cambios de la nube", () => {
	it("un cambio hace releer lo que toca, sin aplicar nada (el Handy no tiene base de datos)", async () => {
		const b = crearBackend();
		const invalidar = vi.spyOn(queryClient, "invalidateQueries");
		await montar();
		const s = ultimo();
		await conectar(s);
		const tick = useSyncSignal.getState().tick;

		const sentencia = { sql: "UPDATE Clientes SET Nombre = 'r' WHERE ID = 1", args: [] };
		await s.recibir({ type: "change", opId: "rem-1", seq: 1, statements: [sentencia] });
		await asentar();

		const claves = affectedFeatureKeys([sentencia]) ?? [];
		expect(claves.length).toBeGreaterThan(0);
		expect(invalidar.mock.calls.map((c) => c[0])).toEqual(claves.map((k) => ({ queryKey: [k] })));
		expect(useSyncSignal.getState().tick).toBe(tick + 1);
		expect(cuenta(b, "sync_apply_changes")).toBe(0);
	});

	it("si la Main cambia los ajustes del negocio o del ticket, se recargan", async () => {
		crearBackend();
		const negocio = vi.spyOn(useBusinessSettings.getState(), "init").mockResolvedValue(undefined);
		const ticket = vi.spyOn(useTicketSettings.getState(), "init").mockResolvedValue(undefined);
		await montar();
		const s = ultimo();
		await conectar(s);

		const sentencia = { sql: "UPDATE Business_Settings SET Business_Name = 'Bar' WHERE ID = 1", args: [] };
		expect(tocaAjustes([sentencia])).toBe(true);
		await s.recibir({ type: "change", opId: "rem-2", seq: 2, statements: [sentencia] });
		await asentar();

		expect(negocio).toHaveBeenCalledOnce();
		expect(ticket).toHaveBeenCalledOnce();
	});

	it("lo que no es un mensaje se ignora", async () => {
		crearBackend();
		await montar();
		const s = ultimo();
		await conectar(s);
		await s.recibirTexto("{roto");
		await s.recibir({ foo: 1 });
		expect(presencia().mainOnline).toBe(true);
	});
});

describe("reconectar ya", () => {
	it("con el socket abierto y la Main confirmada no toca nada", async () => {
		crearBackend();
		const socket = await montar();
		await conectar(ultimo());
		socket.reconectarSiHaceFalta();
		await asentar();
		expect(SocketFalso.creados).toHaveLength(1);
	});

	it("mientras el socket se abre no abre otro", async () => {
		crearBackend();
		const socket = await montar();
		socket.reconectarSiHaceFalta();
		await asentar();
		expect(SocketFalso.creados).toHaveLength(1);
	});

	it("con el socket abierto pero sin saber de la Main, lo cierra y abre otro al momento", async () => {
		crearBackend();
		const socket = await montar();
		const s1 = ultimo();
		s1.abrir();
		socket.reconectarSiHaceFalta();
		await asentar();
		expect(s1.readyState).toBe(SocketFalso.CLOSING);
		expect(SocketFalso.creados).toHaveLength(2);
	});

	it("el cierre tardío del socket abandonado no bloquea el Handy ni abre otro", async () => {
		crearBackend();
		const socket = await montar();
		const s1 = ultimo();
		s1.abrir();
		socket.reconectarSiHaceFalta();
		await asentar();
		await conectar(ultimo());

		s1.cerrar();
		await avanzar(10_000);
		expect(presencia().mainOnline).toBe(true);
		expect(SocketFalso.creados).toHaveLength(2);
	});
});

describe("detener", () => {
	it("cierra el socket, deja la presencia como desconocida y no vuelve a intentarlo", async () => {
		const b = crearBackend();
		const socket = await montar();
		const s = ultimo();
		await conectar(s);

		socket.detener();
		arrancado = null;
		expect(s.readyState).toBe(SocketFalso.CLOSING);
		expect(presencia().mainOnline).toBeNull();

		s.cerrar();
		const pingsAntes = s.pings();
		await avanzar(10 * 60_000);
		expect(cuenta(b, "handy_get_tenant")).toBe(1);
		expect(s.pings()).toBe(pingsAntes);
	});
});
