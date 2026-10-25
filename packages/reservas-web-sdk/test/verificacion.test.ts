// @vitest-environment jsdom
//
// La casilla de «no soy un robot» (`src/verificacion.ts`) y los reintentos de `crearReserva()`, que
// necesitan un token nuevo de la casilla cada vez. La página de verificación del servidor se simula:
// es la que, dentro del iframe, manda el token con `postMessage`.

import { afterEach, describe, expect, it, vi } from "vitest";

import { esError, reservasWeb } from "../src/index";

const SERVIDOR = "https://reservas.test";
const CLAVE = "rw_AAAAAAAAAAAAAAAAAAAAAA";

/** Lo que haría la página de verificación: avisar a la web, desde el iframe y desde el servidor. */
function desdeLaCasilla(iframe: HTMLIFrameElement, datos: Record<string, unknown>, origen = SERVIDOR, source: any = iframe.contentWindow) {
	window.dispatchEvent(new MessageEvent("message", { origin: origen, source, data: { tipo: "tpv-reservas-verificacion", ...datos } }));
}

function montar(fetch: typeof globalThis.fetch = (async () => new Response("{}")) as any) {
	const hueco = document.createElement("div");
	document.body.appendChild(hueco);
	const reservas = reservasWeb({ clave: CLAVE, servidor: SERVIDOR, fetch });
	const cambios: boolean[] = [];
	const casilla = reservas.verificar(hueco, { alCambiar: (l) => cambios.push(l) });
	const iframe = hueco.querySelector("iframe")!;
	const alIframe = vi.spyOn(iframe.contentWindow!, "postMessage");
	return { reservas, casilla, iframe, cambios, alIframe, hueco };
}

const json = (cuerpo: unknown, status = 200) =>
	new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

const RESERVA = { ok: true, codigo: "ABC123", dia: "2026-11-20", hora: "21:00", personas: 2, mesa: "m2", mesa_nombre: "2", correo_enviado: true };
const DATOS = { dia: "2026-11-20", hora: "21:00", personas: 2, nombre: "Ana", correo: "ana@correo.es", telefono: "600112233" };

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("la casilla de verificación", () => {
	it("es la página de verificación del servidor, para el origen de esta web", () => {
		const { iframe } = montar();
		const src = new URL(iframe.src);
		expect(src.origin).toBe(SERVIDOR);
		expect(src.pathname).toBe(`/reservas-web/v1/w/${CLAVE}/verificar`);
		expect(src.searchParams.get("origen")).toBe(window.location.origin);
		expect(iframe.title).toBeTruthy();
	});

	it("sólo hace caso a su iframe y a su servidor", () => {
		const { casilla, iframe, cambios } = montar();
		desdeLaCasilla(iframe, { token: "t1" }, "https://otra.web");
		desdeLaCasilla(iframe, { token: "t1" }, SERVIDOR, window);
		expect(casilla.lista).toBe(false);
		desdeLaCasilla(iframe, { token: "t1" });
		expect(casilla.lista).toBe(true);
		expect(cambios).toEqual([true]);
		// Caducado: deja de estar lista.
		desdeLaCasilla(iframe, { token: null });
		expect(casilla.lista).toBe(false);
	});

	it("el token se gasta al reservar y la casilla pide otro sola", async () => {
		const pedido: string[] = [];
		const { reservas, iframe, casilla, alIframe } = montar((async (_u: string, init?: RequestInit) => {
			pedido.push(new Headers(init?.headers).get("X-Turnstile-Token")!);
			return json(RESERVA);
		}) as any);
		desdeLaCasilla(iframe, { token: "t1" });
		await reservas.crearReserva(DATOS, { verificacion: casilla });
		expect(pedido).toEqual(["t1"]);
		expect(casilla.lista).toBe(false);
		expect(alIframe).toHaveBeenCalledWith({ tipo: "tpv-reservas-reiniciar" }, SERVIDOR);
	});

	it("sin la casilla resuelta, crearReserva espera un poco y dice que hay que marcarla", async () => {
		vi.useFakeTimers();
		const { reservas, casilla } = montar();
		const intento = reservas.crearReserva(DATOS, { verificacion: casilla }).catch((e) => e);
		await vi.advanceTimersByTimeAsync(10_000);
		const e = await intento;
		expect(esError(e, "verificacion_pendiente")).toBe(true);
		expect(e.message).toMatch(/robot/);
	});

	it("si la casilla se resuelve mientras espera, reserva con ese token", async () => {
		const { reservas, iframe, casilla } = montar((async () => json(RESERVA)) as any);
		const intento = reservas.crearReserva(DATOS, { verificacion: casilla });
		desdeLaCasilla(iframe, { token: "t1" });
		expect((await intento).codigo).toBe("ABC123");
	});

	it("sin respuesta, reintenta con la misma clave y un token nuevo, y devuelve la reserva", async () => {
		vi.useFakeTimers();
		const pedidos: { token: string; intento: string }[] = [];
		let primera = true;
		const { reservas, iframe, casilla } = montar((async (_u: string, init?: RequestInit) => {
			const h = new Headers(init?.headers);
			pedidos.push({ token: h.get("X-Turnstile-Token")!, intento: h.get("Idempotency-Key")! });
			if (primera) {
				primera = false;
				// La casilla ya tiene el siguiente cuando falla la red.
				desdeLaCasilla(iframe, { token: "t2" });
				throw new TypeError("Failed to fetch");
			}
			return json({ ...RESERVA, correo_enviado: null });
		}) as any);
		desdeLaCasilla(iframe, { token: "t1" });
		const intento = reservas.crearReserva(DATOS, { verificacion: casilla });
		await vi.advanceTimersByTimeAsync(1000);
		expect((await intento).correo_enviado).toBeNull();
		expect(pedidos.map((p) => p.token)).toEqual(["t1", "t2"]);
		expect(pedidos[1].intento).toBe(pedidos[0].intento);
	});

	it("si para el reintento no llega token, el error es el de antes (sin conexión)", async () => {
		vi.useFakeTimers();
		const { reservas, iframe, casilla } = montar((async () => {
			throw new TypeError("Failed to fetch");
		}) as any);
		desdeLaCasilla(iframe, { token: "t1" });
		const intento = reservas.crearReserva(DATOS, { verificacion: casilla }).catch((e) => e);
		await vi.advanceTimersByTimeAsync(1000 + 15_000);
		expect(esError(await intento, "red")).toBe(true);
	});

	it("un rechazo que no se arregla repitiendo no se reintenta", async () => {
		let llamadas = 0;
		const { reservas, iframe, casilla } = montar((async () => {
			llamadas++;
			return json({ ok: false, error: "limite_reservas_correo", message: "Ya tienes muchas reservas activas con este correo." }, 409);
		}) as any);
		desdeLaCasilla(iframe, { token: "t1" });
		const e = await reservas.crearReserva(DATOS, { verificacion: casilla }).catch((x) => x);
		expect(esError(e, "limite_reservas_correo")).toBe(true);
		expect(llamadas).toBe(1);
	});

	it("destruir la quita de la página y deja de escuchar", () => {
		const { casilla, iframe, hueco } = montar();
		casilla.destruir();
		expect(hueco.querySelector("iframe")).toBeNull();
		desdeLaCasilla(iframe, { token: "t1" });
		expect(casilla.lista).toBe(false);
	});
});
