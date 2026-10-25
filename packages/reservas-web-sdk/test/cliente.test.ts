// Lo que hace el SDK por detrás contra un `fetch` simulado: a qué rutas llama y con qué, que la
// idempotencia y los errores son los que dice `src/index.ts`. Lo que pasa con la casilla de
// verificación (el iframe y los reintentos con token nuevo), en `verificacion.test.ts`.

import { describe, expect, it } from "vitest";

import { ErrorReservas, MESA_AUTOMATICA, SERVIDOR, esError, reservasWeb } from "../src/index";

const CLAVE = "rw_AAAAAAAAAAAAAAAAAAAAAA";

type Llamada = { url: string; init?: RequestInit };

/** Un `fetch` que contesta en orden lo que se le da (`Error` = sin red) y apunta lo que le piden. */
function servidor(...respuestas: (Response | Error)[]) {
	const llamadas: Llamada[] = [];
	const fetch = (async (url: string, init?: RequestInit) => {
		llamadas.push({ url, init });
		const r = respuestas.shift();
		if (!r) throw new Error("no se esperaba otra petición");
		if (r instanceof Error) throw r;
		return r;
	}) as typeof globalThis.fetch;
	return { fetch, llamadas };
}

const json = (cuerpo: unknown, status = 200) =>
	new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

const RESERVA = { ok: true, codigo: "ABC123", dia: "2026-11-20", hora: "21:00", personas: 2, mesa: "m2", mesa_nombre: "2", correo_enviado: true };

const DATOS = { dia: "2026-11-20", hora: "21:00", personas: 2, nombre: "Ana", correo: "ana@correo.es", telefono: "600112233" };

const cabecera = (l: Llamada, nombre: string) => new Headers(l.init?.headers).get(nombre);

describe("el cliente de las reservas web", () => {
	it("llama al servidor de reservas por defecto, o al mismo origen con `servidor: \"\"`", async () => {
		const a = servidor(json({ ok: true, completo: true, salones: [], mesas: [] }));
		await reservasWeb({ clave: CLAVE, fetch: a.fetch }).plano();
		expect(a.llamadas[0].url).toBe(`${SERVIDOR}/v1/publico/reservas/${CLAVE}/plano`);

		const b = servidor(json({ ok: true, completo: true, salones: [], mesas: [] }));
		await reservasWeb({ clave: CLAVE, servidor: "", fetch: b.fetch }).plano({ fresco: true });
		expect(b.llamadas[0].url).toBe(`/v1/publico/reservas/${CLAVE}/plano`);
		expect(b.llamadas[0].init?.cache).toBe("no-cache");

		const c = servidor(json({ ok: true, completo: true, salones: [], mesas: [] }));
		await reservasWeb({ clave: CLAVE, servidor: "https://otro.test/", fetch: c.fetch }).plano();
		expect(c.llamadas[0].url).toBe(`https://otro.test/v1/publico/reservas/${CLAVE}/plano`);
	});

	it("devuelve lo que contesta la API, sin su `ok`", async () => {
		const s = servidor(
			json({ ok: true, dia: "2026-11-20", tramos: [{ desde: "19:40", hasta: "21:50" }] }),
			json({ ok: true, mesas: ["m2"], alternativas: [] }),
		);
		const r = reservasWeb({ clave: CLAVE, fetch: s.fetch });
		expect(await r.horas("2026-11-20")).toEqual([{ desde: "19:40", hasta: "21:50" }]);
		expect(await r.disponibles({ dia: "2026-11-20", hora: "21:00", personas: 2 })).toEqual({ mesas: ["m2"], alternativas: [] });
		expect(s.llamadas[0].url).toContain("/dia?dia=2026-11-20");
		expect(s.llamadas[1].url).toContain("/disponibles?dia=2026-11-20&hora=21%3A00&personas=2");
	});

	it("crearReserva manda los datos con los nombres de la API, la mesa automática si no se elige, el token y la clave del intento", async () => {
		const s = servidor(json(RESERVA));
		const r = await reservasWeb({ clave: CLAVE, fetch: s.fetch }).crearReserva(DATOS, { verificacion: "token-1" });
		expect(r).toEqual({ codigo: "ABC123", dia: "2026-11-20", hora: "21:00", personas: 2, mesa: "m2", mesa_nombre: "2", correo_enviado: true });

		const [alta] = s.llamadas;
		expect(alta.url).toBe(`${SERVIDOR}/v1/publico/reservas/${CLAVE}/reservas`);
		expect(alta.init?.method).toBe("POST");
		expect(JSON.parse(String(alta.init?.body))).toEqual({ ...DATOS, mesa: MESA_AUTOMATICA, nota: null });
		expect(cabecera(alta, "X-Turnstile-Token")).toBe("token-1");
		expect(cabecera(alta, "Idempotency-Key")).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
	});

	it("la clave del intento se repite tras un fallo, y es otra tras una reserva hecha", async () => {
		const s = servidor(new Error("sin red"), json(RESERVA), json(RESERVA));
		const r = reservasWeb({ clave: CLAVE, fetch: s.fetch });
		// Con un token suelto no se reintenta solo: un token sólo vale una vez.
		const fallo = await r.crearReserva(DATOS, { verificacion: "t1" }).catch((e) => e);
		expect(esError(fallo, "red")).toBe(true);
		expect(fallo.message).toMatch(/conexión/);
		await r.crearReserva(DATOS, { verificacion: "t2" });
		await r.crearReserva({ ...DATOS, mesa: "m4" }, { verificacion: "t3" });

		const [primera, repetida, otra] = s.llamadas.map((l) => cabecera(l, "Idempotency-Key"));
		expect(repetida).toBe(primera);
		expect(otra).not.toBe(primera);
		expect(s.llamadas).toHaveLength(3);
	});

	it("un rechazo del servidor es un ErrorReservas con su código, su estado y su frase, y no se reintenta", async () => {
		const s = servidor(json({ ok: false, error: "mesa_no_disponible", message: "Esa mesa acaba de ocuparse." }, 409));
		const e = await reservasWeb({ clave: CLAVE, fetch: s.fetch })
			.crearReserva({ ...DATOS, mesa: "m2" }, { verificacion: "t1" })
			.catch((x) => x);
		expect(e).toBeInstanceOf(ErrorReservas);
		expect(e).toMatchObject({ codigo: "mesa_no_disponible", estado: 409, message: "Esa mesa acaba de ocuparse." });
		expect(s.llamadas).toHaveLength(1);
	});

	it("una respuesta sin JSON o sin frase da un mensaje genérico, nunca un identificador", async () => {
		const s = servidor(new Response("<html>", { status: 502 }), json({ ok: false, error: "algo_raro" }, 400));
		const r = reservasWeb({ clave: CLAVE, fetch: s.fetch });
		expect(await r.negocio().catch((e) => e)).toMatchObject({ codigo: "desconocido", estado: 502, message: expect.stringMatching(/Algo ha fallado/) });
		const e = await r.negocio().catch((x) => x);
		expect(e).toMatchObject({ codigo: "algo_raro" });
		expect(e.message).not.toContain("algo_raro");
	});

	it("con las reservas cerradas, el error trae el negocio para decir a quién llamar", async () => {
		const s = servidor(json({ ok: false, error: "reserva_web_cerrada", negocio: { nombre: "Bar Pepe", telefono: "950 000 000" } }, 409));
		const e = await reservasWeb({ clave: CLAVE, fetch: s.fetch }).negocio().catch((x) => x);
		expect(esError(e, "reserva_web_cerrada")).toBe(true);
		expect(e.cuerpo.negocio).toEqual({ nombre: "Bar Pepe", telefono: "950 000 000" });
	});

	it("consultar y cancelar mandan el token del enlace en el cuerpo, nunca en la URL", async () => {
		const s = servidor(
			json({ ok: true, dia: "2026-11-20", hora: "21:00", personas: 2, mesa: "m2", mesa_nombre: "2", estado: "confirmada", cancelable: true }),
			json({ ok: true }),
		);
		const r = reservasWeb({ clave: CLAVE, fetch: s.fetch });
		expect((await r.consultarReserva("tok")).estado).toBe("confirmada");
		await r.cancelarReserva("tok");
		for (const l of s.llamadas) {
			expect(l.url).not.toContain("tok");
			expect(JSON.parse(String(l.init?.body))).toEqual({ token: "tok" });
		}
		expect(s.llamadas.map((l) => l.url.split("/").pop())).toEqual(["reserva", "cancelar"]);
	});
});
