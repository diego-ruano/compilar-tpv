/** @vitest-environment jsdom */

// El widget de punta a punta contra un `fetch` simulado (docs/estudios/reservas-web.md §7.2):
// reservar paso a paso, la hora limitada a los tramos del día, «esa mesa acaba de ocuparse» al
// confirmar, las reservas cerradas y la página de cancelar.
//
// Se espera a cada pintado con las consultas `find*` (ver la nota de `apps/tpv-main/test/react/
// shared-ui.test.tsx`: aquí React pinta de forma asíncrona). Konva no tiene canvas en jsdom: el plano
// se prueba por su lista de mesas, que es la misma.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../src/App";

vi.mock("react-konva", () => {
	const Nada = () => null;
	return { Stage: Nada, Layer: Nada, Rect: Nada, Line: Nada, Group: Nada, Text: Nada, Circle: Nada };
});

// Turnstile resuelto en el acto, como el de verdad: un token nuevo cada vez que se monta o se
// reinicia (tras un intento de alta), nunca el mismo.
const turnstile = vi.hoisted(() => ({ emitidos: 0 }));
vi.mock("../src/Turnstile", () => ({
	default: ({ onToken, ref }: { onToken: (t: string | null) => void; ref?: any }) => {
		useImperativeHandle(ref, () => ({
			reiniciar: () => {
				onToken(null);
				setTimeout(() => onToken(`tok-${++turnstile.emitidos}`), 0);
			},
		}));
		useEffect(() => onToken(`tok-${++turnstile.emitidos}`), []);
		return <div data-testid="turnstile" />;
	},
}));

const CLAVE = "rw_AAAAAAAAAAAAAAAAAAAAAA";
const BASE = `/v1/publico/reservas/${CLAVE}`;

const INFO = {
	ok: true,
	negocio: { nombre: "Bar Pepe", direccion: "Calle Mayor 1", telefono: "950 000 000", logo: null, razon_social: "Pepe SL", cif: "B00000000" },
	hoy: "2026-11-10",
	primer_dia: "2026-11-11",
	ultimo_dia: "2026-12-10",
	dias_abiertos: ["2026-11-20", "2026-11-21"],
	max_personas: 6,
	duracion_min: 120,
	turnstile: "0xT",
};

const PLANO = {
	ok: true,
	completo: true,
	salones: [{ id: "z1", nombre: "Salón", puntos: "[0,0,400,0,400,300,0,300]" }],
	mesas: [
		{ id: "m2", id_salon: "z1", numero: "2", forma: "rect", x: 10, y: 10, ancho: 80, alto: 80, radio: null, capacidad: 2, reservable: true },
		{ id: "m4", id_salon: "z1", numero: "4", forma: "rect", x: 110, y: 10, ancho: 80, alto: 80, radio: null, capacidad: 4, reservable: true },
	],
};

type Llamada = { url: string; init?: RequestInit };

/** Un `fetch` que contesta por ruta con lo que diga cada prueba, y apunta lo que le piden. */
function simular(rutas: Record<string, (init?: RequestInit) => unknown | Promise<unknown>>) {
	const llamadas: Llamada[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			llamadas.push({ url, init });
			const ruta = Object.keys(rutas).find((r) => url.startsWith(r));
			if (!ruta) return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
			const r: any = await rutas[ruta](init);
			return r?.__http ? new Response(JSON.stringify(r.cuerpo), { status: r.__http }) : new Response(JSON.stringify(r), { status: 200 });
		}),
	);
	return llamadas;
}

/** Una respuesta con otro estado HTTP que 200. */
const respuesta = (http: number, cuerpo: unknown) => ({ __http: http, cuerpo });

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("reservar desde la web", () => {
	it("de punta a punta: el día, la hora dentro de su tramo, la mesa, los datos y hecho", async () => {
		let altas = 0;
		const llamadas = simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/dia?dia=2026-11-20`]: () => ({ ok: true, dia: "2026-11-20", tramos: [{ desde: "19:40", hasta: "21:50" }] }),
			[`${BASE}/plano`]: () => PLANO,
			[`${BASE}/disponibles`]: () => ({ ok: true, mesas: altas === 0 ? ["m2"] : ["m4"], alternativas: [] }),
			[`${BASE}/reservas`]: () =>
				altas++ === 0
					? respuesta(409, { ok: false, error: "mesa_no_disponible", message: "Esa mesa acaba de ocuparse. Elige otra de las que quedan libres." })
					: { ok: true, codigo: "ABC123", dia: "2026-11-20", hora: "20:07", personas: 2, mesa: "4" },
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);

		await screen.findByRole("heading", { name: "Bar Pepe" });
		// Al abrirse no se lleva el foco: es de la web donde va incrustado.
		expect(document.activeElement).toBe(document.body);
		// Sólo se pueden pulsar los días abiertos.
		expect(screen.getByRole("button", { name: "2026-11-19" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "2026-11-20" }));

		// La hora empieza en la primera del día y sólo vale dentro de sus tramos, al minuto.
		const campo = (await screen.findByDisplayValue("19:40")) as HTMLInputElement;
		fireEvent.change(campo, { target: { value: "17:00" } });
		expect(await screen.findByText(/A esa hora no se puede/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Ver mesas" })).toBeDisabled();
		fireEvent.change(campo, { target: { value: "20:07" } });
		await waitFor(() => expect(screen.getByRole("button", { name: "Ver mesas" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Ver mesas" }));

		// El plano, con las libres en botones; el foco, en el título del paso nuevo.
		const pasoMesa = await screen.findByRole("region", { name: "Mesa" });
		await waitFor(() => expect(document.activeElement).toBe(within(pasoMesa).getByRole("heading")));
		fireEvent.click(await screen.findByRole("button", { name: "Mesa 2 · 2 plazas" }));
		expect(llamadas.some((l) => l.url.includes("/disponibles?dia=2026-11-20&hora=20%3A07&personas=2"))).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "Continuar" }));

		fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Ana Pérez" } });
		fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "ana@correo.es" } });
		fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "600 112 233" } });
		fireEvent.click(screen.getByLabelText("He leído la información sobre privacidad"));
		expect(screen.getByText(/Pepe SL \(B00000000\)/)).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: "Confirmar" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

		// Se la han quitado: vuelta al plano con lo que queda libre, y el aviso.
		expect(await screen.findByText("Esa mesa acaba de ocuparse. Elige otra de las que quedan libres.")).toBeInTheDocument();
		fireEvent.click(await screen.findByRole("button", { name: "Mesa 4 · 4 plazas" }));
		fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Confirmar" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

		expect(await screen.findByText("✓ Reserva confirmada")).toBeInTheDocument();
		expect(screen.getByText("ABC123")).toBeInTheDocument();
		expect(screen.getByText("2 personas · Mesa 4")).toBeInTheDocument();
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "✓ Reserva confirmada" })));

		const envios = llamadas.filter((l) => l.url === `${BASE}/reservas`);
		// Un token de Turnstile es de un solo uso: el segundo intento no puede llevar el del primero.
		const tokens = envios.map((l) => (l.init?.headers as Record<string, string>)["X-Turnstile-Token"]);
		expect(tokens).toHaveLength(2);
		expect(tokens[0]).toMatch(/^tok-/);
		expect(tokens[1]).not.toBe(tokens[0]);
		// La clave del intento, en cambio, es la misma: si el primero se hubiera guardado sin contestar,
		// el worker devolvería esa reserva en vez de dar otra.
		const intentos = envios.map((l) => (l.init?.headers as Record<string, string>)["Idempotency-Key"]);
		expect(intentos[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(intentos[1]).toBe(intentos[0]);
		expect(JSON.parse(String(envios[1].init?.body))).toEqual({
			dia_ymd: "2026-11-20",
			hora: "20:07",
			personas: 2,
			id_mesa: "m4",
			nombre: "Ana Pérez",
			email: "ana@correo.es",
			telefono: "600 112 233",
			nota: null,
		});
	});

	it("si cambia de día antes de que llegue el horario del anterior, se queda con el del último", async () => {
		let soltarElPrimero!: () => void;
		const primero = new Promise<void>((r) => (soltarElPrimero = r));
		simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/dia?dia=2026-11-20`]: async () => {
				await primero;
				return { ok: true, dia: "2026-11-20", tramos: [{ desde: "12:00", hasta: "13:00" }] };
			},
			[`${BASE}/dia?dia=2026-11-21`]: () => ({ ok: true, dia: "2026-11-21", tramos: [{ desde: "20:00", hasta: "21:00" }] }),
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);

		fireEvent.click(await screen.findByRole("button", { name: "2026-11-20" }));
		fireEvent.click(screen.getByRole("button", { name: "2026-11-21" }));
		expect(await screen.findByDisplayValue("20:00")).toBeInTheDocument();
		soltarElPrimero();
		await new Promise((r) => setTimeout(r, 10));
		expect(screen.getByDisplayValue("20:00")).toBeInTheDocument();
		expect(screen.getByText(/de 20:00 a 21:00/)).toBeInTheDocument();
	});

	it("si no llega el horario del día, lo dice y deja reintentarlo", async () => {
		let pedidas = 0;
		simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/dia?dia=2026-11-20`]: () =>
				pedidas++ === 0
					? respuesta(503, { ok: false, error: "tenant_unavailable", message: "El servicio no está disponible ahora." })
					: { ok: true, dia: "2026-11-20", tramos: [{ desde: "20:00", hasta: "21:00" }] },
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);

		fireEvent.click(await screen.findByRole("button", { name: "2026-11-20" }));
		expect(await screen.findByText("El servicio no está disponible ahora.")).toBeInTheDocument();
		expect(screen.queryByText("Buscando horas…")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
		expect(await screen.findByDisplayValue("20:00")).toBeInTheDocument();
		expect(screen.queryByText("El servicio no está disponible ahora.")).not.toBeInTheDocument();
	});

	it("si lo libre trae una mesa que no está en el plano guardado, se vuelve a pedir el plano", async () => {
		let buscadas = 0;
		const conLaNueve = { ...PLANO, mesas: [...PLANO.mesas, { ...PLANO.mesas[1], id: "m9", numero: "9", x: 210 }] };
		const llamadas = simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/dia?dia=2026-11-20`]: () => ({ ok: true, dia: "2026-11-20", tramos: [{ desde: "20:00", hasta: "21:00" }] }),
			[`${BASE}/plano`]: (init) => (init?.cache === "no-cache" ? conLaNueve : PLANO),
			[`${BASE}/disponibles`]: () => ({ ok: true, mesas: buscadas++ === 0 ? ["m2"] : ["m9"], alternativas: [] }),
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);

		fireEvent.click(await screen.findByRole("button", { name: "2026-11-20" }));
		await screen.findByDisplayValue("20:00");
		fireEvent.click(screen.getByRole("button", { name: "Ver mesas" }));
		expect(await screen.findByRole("button", { name: "Mesa 2 · 2 plazas" })).toBeInTheDocument();

		// Mientras, el restaurante ha puesto la mesa 9: la segunda búsqueda la trae y el plano se renueva.
		fireEvent.click(screen.getByRole("button", { name: "Atrás" }));
		fireEvent.click(await screen.findByRole("button", { name: "Ver mesas" }));
		fireEvent.click(await screen.findByRole("button", { name: "Mesa 9 · 4 plazas" }));
		expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
		const planos = llamadas.filter((l) => l.url === `${BASE}/plano`);
		expect(planos.map((l) => l.init?.cache ?? null)).toEqual([null, "no-cache"]);
	});

	it("sin mesas a esa hora, ofrece las horas cercanas que tienen; elegir una enseña sus mesas", async () => {
		simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/dia?dia=2026-11-20`]: () => ({ ok: true, dia: "2026-11-20", tramos: [{ desde: "19:40", hasta: "21:50" }] }),
			[`${BASE}/plano`]: () => PLANO,
			[`${BASE}/disponibles?dia=2026-11-20&hora=19%3A40`]: () => ({ ok: true, mesas: [], alternativas: ["21:30", "21:45"] }),
			[`${BASE}/disponibles?dia=2026-11-20&hora=21%3A30`]: () => ({ ok: true, mesas: ["m4"], alternativas: [] }),
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);

		fireEvent.click(await screen.findByRole("button", { name: "2026-11-20" }));
		await screen.findByDisplayValue("19:40");
		fireEvent.click(screen.getByRole("button", { name: "Ver mesas" }));
		expect(await screen.findByText("No quedan mesas para 2 personas a las 19:40.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "21:30" }));
		fireEvent.click(await screen.findByRole("button", { name: "Mesa 4 · 4 plazas" }));
		expect(screen.getByRole("heading", { name: /21:30/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
	});

	it("si vuelve atrás mientras busca una hora cercana, lo que llegue no le devuelve al plano", async () => {
		let soltar!: () => void;
		const espera = new Promise<void>((r) => (soltar = r));
		simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/dia?dia=2026-11-20`]: () => ({ ok: true, dia: "2026-11-20", tramos: [{ desde: "19:40", hasta: "21:50" }] }),
			[`${BASE}/plano`]: () => PLANO,
			[`${BASE}/disponibles?dia=2026-11-20&hora=19%3A40`]: () => ({ ok: true, mesas: [], alternativas: ["21:30"] }),
			[`${BASE}/disponibles?dia=2026-11-20&hora=21%3A30`]: async () => {
				await espera;
				return { ok: true, mesas: ["m4"], alternativas: [] };
			},
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);

		fireEvent.click(await screen.findByRole("button", { name: "2026-11-20" }));
		await screen.findByDisplayValue("19:40");
		fireEvent.click(screen.getByRole("button", { name: "Ver mesas" }));
		fireEvent.click(await screen.findByRole("button", { name: "21:30" }));
		fireEvent.click(screen.getByRole("button", { name: "Atrás" }));
		expect(await screen.findByRole("heading", { name: "¿Qué día?" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Ver mesas" })).toBeEnabled();

		soltar();
		await new Promise((r) => setTimeout(r, 10));
		expect(screen.getByRole("heading", { name: "¿Qué día?" })).toBeInTheDocument();
		expect(screen.getByDisplayValue("19:40")).toBeInTheDocument();
	});

	it("con las reservas cerradas, dice a quién llamar", async () => {
		simular({
			[`${BASE}/negocio`]: () =>
				respuesta(409, { ok: false, error: "reserva_web_cerrada", negocio: { nombre: "Bar Pepe", telefono: "950 000 000" } }),
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);
		expect(await screen.findByText(/Ahora no se pueden hacer reservas online\. Llama al 950 000 000\./)).toBeInTheDocument();
	});

	it("una clave que no existe: reservas no disponibles", async () => {
		simular({});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);
		expect(await screen.findByText("Reservas no disponibles.")).toBeInTheDocument();
	});
	it("si cambia las personas mientras busca mesas, lo que llegue de la búsqueda anterior no se aplica", async () => {
		let soltar!: () => void;
		const lenta = new Promise<void>((r) => (soltar = r));
		simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/dia?dia=2026-11-20`]: () => ({ ok: true, dia: "2026-11-20", tramos: [{ desde: "19:40", hasta: "21:50" }] }),
			[`${BASE}/plano`]: () => PLANO,
			[`${BASE}/disponibles`]: async () => {
				await lenta;
				return { ok: true, mesas: ["m2"], alternativas: [] };
			},
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);

		fireEvent.click(await screen.findByRole("button", { name: "2026-11-20" }));
		await screen.findByDisplayValue("19:40");
		fireEvent.click(screen.getByRole("button", { name: "Ver mesas" }));
		await screen.findByRole("button", { name: "Buscando…" });
		// Cambia de idea antes de que conteste.
		fireEvent.click(screen.getByRole("button", { name: "Una persona más" }));
		soltar();
		await new Promise((r) => setTimeout(r, 20));
		// Sigue en el primer paso, con 3 personas, sin el plano de la pregunta de 2.
		expect(screen.getByText("3", { selector: "span[aria-live]" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Mesa 2 · 2 plazas" })).toBeNull();
		expect(screen.getByRole("button", { name: "Ver mesas" })).toBeEnabled();
	});
	it("si Turnstile no da por buena la verificación, no se reenvía su token: hace falta uno nuevo", async () => {
		let altas = 0;
		const llamadas = simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/dia?dia=2026-11-20`]: () => ({ ok: true, dia: "2026-11-20", tramos: [{ desde: "19:40", hasta: "21:50" }] }),
			[`${BASE}/plano`]: () => PLANO,
			[`${BASE}/disponibles`]: () => ({ ok: true, mesas: ["m2"], alternativas: [] }),
			[`${BASE}/reservas`]: () =>
				altas++ === 0
					? respuesta(403, { ok: false, error: "verificacion_humana_fallida", message: "No hemos podido comprobar que no eres un robot." })
					: { ok: true, codigo: "ABC123", dia: "2026-11-20", hora: "19:40", personas: 2, mesa: "2" },
		});
		render(<App ruta={{ clave: CLAVE, vista: "reservar", token: null }} />);

		fireEvent.click(await screen.findByRole("button", { name: "2026-11-20" }));
		await screen.findByDisplayValue("19:40");
		fireEvent.click(screen.getByRole("button", { name: "Ver mesas" }));
		fireEvent.click(await screen.findByRole("button", { name: "Mesa 2 · 2 plazas" }));
		fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
		fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Ana" } });
		fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "ana@correo.es" } });
		fireEvent.change(screen.getByLabelText("Teléfono"), { target: { value: "600112233" } });
		fireEvent.click(screen.getByLabelText("He leído la información sobre privacidad"));
		await waitFor(() => expect(screen.getByRole("button", { name: "Confirmar" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

		// Sigue en sus datos, sin volver a montar Turnstile: el reinicio es lo que da otro token.
		expect(await screen.findByText("No hemos podido comprobar que no eres un robot.")).toBeInTheDocument();
		await waitFor(() => expect(screen.getByRole("button", { name: "Confirmar" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
		expect(await screen.findByText("✓ Reserva confirmada")).toBeInTheDocument();

		const tokens = llamadas
			.filter((l) => l.url === `${BASE}/reservas`)
			.map((l) => (l.init?.headers as Record<string, string>)["X-Turnstile-Token"]);
		expect(tokens).toHaveLength(2);
		expect(tokens[1]).not.toBe(tokens[0]);
	});
});

describe("cancelar desde el enlace", () => {
	it("enseña la reserva y sólo la cancela tras confirmarlo", async () => {
		const llamadas = simular({
			[`${BASE}/negocio`]: () => INFO,
			// La mesa, con el nombre que propone la Main: no sale «Mesa Mesa 2».
			[`${BASE}/reserva`]: () => ({ ok: true, dia: "2026-11-20", hora: "21:00", personas: 2, mesa: "Mesa 2", estado: "confirmada", cancelable: true }),
			[`${BASE}/cancelar`]: () => ({ ok: true }),
		});
		render(<App ruta={{ clave: CLAVE, vista: "cancelar", token: "TOKEN" }} />);

		expect(await screen.findByText("Tu reserva en Bar Pepe")).toBeInTheDocument();
		expect(screen.getByText("2 personas · Mesa 2")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Cancelar la reserva" }));
		expect(llamadas.some((l) => l.url.endsWith("/cancelar"))).toBe(false);
		// El foco, en el «No»; al decir que no, vuelve a su botón.
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "No" })));
		fireEvent.click(screen.getByRole("button", { name: "No" }));
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancelar la reserva" })));
		fireEvent.click(screen.getByRole("button", { name: "Cancelar la reserva" }));
		fireEvent.click(await screen.findByRole("button", { name: "Sí, cancelarla" }));
		expect(await screen.findByText("Esta reserva está cancelada.")).toBeInTheDocument();
		await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Tu reserva en Bar Pepe" })));
		const cancelar = llamadas.find((l) => l.url.endsWith("/cancelar"));
		expect(JSON.parse(String(cancelar?.init?.body))).toEqual({ token: "TOKEN" });
	});

	it("con las reservas cerradas el enlace sigue valiendo", async () => {
		simular({
			[`${BASE}/negocio`]: () => respuesta(409, { ok: false, error: "reserva_web_cerrada", negocio: { nombre: "Bar Pepe", telefono: "" } }),
			[`${BASE}/reserva`]: () => ({ ok: true, dia: "2026-11-20", hora: "21:00", personas: 2, mesa: "2", estado: "confirmada", cancelable: true }),
		});
		render(<App ruta={{ clave: CLAVE, vista: "cancelar", token: "TOKEN" }} />);
		expect(await screen.findByRole("button", { name: "Cancelar la reserva" })).toBeInTheDocument();
	});

	it("sin token, el enlace no vale", async () => {
		simular({ [`${BASE}/negocio`]: () => INFO });
		render(<App ruta={{ clave: CLAVE, vista: "cancelar", token: null }} />);
		expect(await screen.findByText("Este enlace no es válido o ha caducado.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
	});

	it("un enlace que no vale no se reintenta; un fallo del servidor, sí", async () => {
		let pedidas = 0;
		simular({
			[`${BASE}/negocio`]: () => INFO,
			[`${BASE}/reserva`]: (init) =>
				JSON.parse(String(init?.body)).token === "MALO"
					? respuesta(404, { ok: false, error: "enlace_no_valido", message: "Este enlace no es válido o ha caducado." })
					: pedidas++ === 0
						? respuesta(503, { ok: false, error: "tenant_unavailable", message: "El servicio no está disponible ahora." })
						: { ok: true, dia: "2026-11-20", hora: "21:00", personas: 2, mesa: "2", estado: "confirmada", cancelable: true },
		});
		const { unmount } = render(<App ruta={{ clave: CLAVE, vista: "cancelar", token: "MALO" }} />);
		expect(await screen.findByText("Este enlace no es válido o ha caducado.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
		unmount();

		render(<App ruta={{ clave: CLAVE, vista: "cancelar", token: "TOKEN" }} />);
		expect(await screen.findByText("El servicio no está disponible ahora.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
		expect(await screen.findByRole("button", { name: "Cancelar la reserva" })).toBeInTheDocument();
	});
});
