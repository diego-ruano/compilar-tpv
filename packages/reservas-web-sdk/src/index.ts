// @altarialights/reservas-web-tpv · Las reservas web del TPV desde una web propia: ver qué días y
// horas hay, qué mesas quedan, reservar y cancelar. Es lo mismo que usa el widget por dentro.
//
//   const reservas = reservasWeb({ clave: "rw_…" });
//   const casilla = reservas.verificar(document.querySelector("#robot")!);
//   const r = await reservas.crearReserva({ dia, hora, personas, nombre, correo, telefono }, { verificacion: casilla });
//
// Lo que hace por detrás `crearReserva()`:
//   · la **idempotencia**: cada reserva lleva su clave (`Idempotency-Key`), la misma en todos sus
//     intentos, también si se vuelve a llamar tras un error. Si una respuesta se pierde y se repite,
//     el servidor contesta la reserva que ya hizo en vez de hacer otra. Tras una reserva hecha, la
//     siguiente lleva una clave nueva;
//   · los **reintentos**: sin respuesta, con un fallo del servidor o con la verificación caducada,
//     vuelve a intentarlo (hasta tres veces, con la misma clave y un token nuevo de la casilla);
//   · la **verificación**: el token de Turnstile se usa una vez y la casilla pide otro sola.
//
// Los errores son siempre `ErrorReservas`: se decide por `codigo` y se enseña `message`.

import { ErrorReservas, GENERICO, SIN_RED, VERIFICACION_PENDIENTE } from "./errores";
import type {
	DatosReserva,
	Dia,
	Disponibles,
	Hora,
	InfoNegocio,
	Plano,
	Reserva,
	ResumenReserva,
	Tramo,
} from "./tipos";
import { MESA_AUTOMATICA } from "./tipos";
import { crearVerificacion, tomarToken, type OpcionesVerificacion, type Verificacion } from "./verificacion";

export { ErrorReservas, esError, type CodigoError } from "./errores";
export * from "./tipos";
export type { OpcionesVerificacion, Verificacion } from "./verificacion";

/** El servidor de reservas. */
export const SERVIDOR = "https://reservas-tpv.altarialights.com";

export type OpcionesReservasWeb = {
	/** La clave del restaurante (`rw_…`): la que va en el código para la web del TPV. */
	clave: string;
	/**
	 * Dónde está el servidor de reservas. Por defecto, `SERVIDOR`. Vacío: el mismo origen que la
	 * página (el widget, que se sirve desde él).
	 */
	servidor?: string;
	/** Otro `fetch`, para los tests o un entorno que no lo tenga. */
	fetch?: typeof fetch;
};

export type OpcionesCrearReserva = {
	/**
	 * La casilla de `verificar()` o, si ya se tiene, un token de Turnstile resuelto en el dominio del
	 * servidor (el widget). Con un token suelto no se reintenta: un token sólo vale una vez.
	 */
	verificacion: Verificacion | string;
};

/** Tres intentos: el primero y dos más, con estas esperas antes de cada uno. */
const ESPERAS_REINTENTO_MS = [1000, 3000];
/** Lo que se espera a que la casilla tenga un token: el primero, y el de un reintento. */
const ESPERA_TOKEN_MS = 10_000;
const ESPERA_TOKEN_REINTENTO_MS = 15_000;

const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** La clave de un intento de alta: lo que acepta el servidor (16 a 64 de `[A-Za-z0-9_-]`). */
function nuevaClaveDeIntento(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	// Sin `randomUUID` (una página sin HTTPS): 128 bits en hexadecimal.
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** ¿Merece la pena repetir el alta? Sin respuesta, un fallo del servidor o la verificación caducada. */
function reintentable(e: unknown): boolean {
	return e instanceof ErrorReservas && (e.codigo === "red" || e.estado >= 500 || e.codigo === "verificacion_humana_fallida");
}

function sinOk<T extends { ok?: unknown }>(cuerpo: T): Omit<T, "ok"> {
	const { ok: _ok, ...resto } = cuerpo;
	return resto;
}

export function reservasWeb(opciones: OpcionesReservasWeb) {
	const servidor = (opciones.servidor ?? SERVIDOR).replace(/\/+$/, "");
	const raiz = `${servidor}/v1/publico/reservas/${encodeURIComponent(opciones.clave)}`;
	const hacerFetch: typeof fetch = opciones.fetch ?? ((entrada, init) => fetch(entrada, init));
	/** La clave del alta que está en curso o que falló: la siguiente llamada la repite. */
	let intentoEnCurso: string | null = null;

	async function pedir<T>(ruta: string, init?: RequestInit): Promise<T> {
		let res: Response;
		try {
			res = await hacerFetch(`${raiz}${ruta}`, init);
		} catch {
			throw new ErrorReservas("red", 0, SIN_RED);
		}
		let cuerpo: any = null;
		try {
			cuerpo = await res.json();
		} catch {
			// Sin cuerpo JSON: cuenta como fallo genérico abajo.
		}
		if (!res.ok || !cuerpo || cuerpo.ok === false) {
			// Un dato que no vale trae el texto de su regla en `message`; los `issues` sueltos son de la
			// validación, en inglés, y no se enseñan.
			throw new ErrorReservas(cuerpo?.error ?? "desconocido", res.status, cuerpo?.message ?? GENERICO, cuerpo);
		}
		return cuerpo as T;
	}

	const enviar = (cuerpo: unknown, cabeceras: Record<string, string> = {}): RequestInit => ({
		method: "POST",
		headers: { "content-type": "application/json", ...cabeceras },
		body: JSON.stringify(cuerpo),
	});

	async function token(verificacion: Verificacion | string, esperaMs: number): Promise<string> {
		const t = typeof verificacion === "string" ? verificacion : await tomarToken(verificacion, esperaMs);
		if (!t) throw new ErrorReservas("verificacion_pendiente", 0, VERIFICACION_PENDIENTE);
		return t;
	}

	return {
		/** El restaurante y su calendario: qué días se pueden reservar y para cuántas personas. */
		negocio: async (): Promise<InfoNegocio> => sinOk(await pedir<InfoNegocio & { ok: true }>("/negocio")),

		/** Las horas de llegada que valen ese día (`AAAA-MM-DD`). */
		horas: async (dia: Dia): Promise<Tramo[]> =>
			(await pedir<{ tramos: Tramo[] }>(`/dia?dia=${encodeURIComponent(dia)}`)).tramos,

		/**
		 * Los salones y las mesas, para dibujar el plano. El navegador lo guarda un minuto; `fresco`
		 * lo pide sin esa copia (el restaurante ha cambiado la sala).
		 */
		plano: async (o: { fresco?: boolean } = {}): Promise<Plano> =>
			sinOk(await pedir<Plano & { ok: true }>("/plano", o.fresco ? { cache: "no-cache" } : undefined)),

		/** Las mesas libres para ese día, hora y personas; si no hay, horas cercanas que tienen. */
		disponibles: async (q: { dia: Dia; hora: Hora; personas: number }): Promise<Disponibles> =>
			sinOk(
				await pedir<Disponibles & { ok: true }>(
					`/disponibles?dia=${encodeURIComponent(q.dia)}&hora=${encodeURIComponent(q.hora)}&personas=${q.personas}`,
				),
			),

		/**
		 * La casilla de «no soy un robot», dentro de `hueco`. `crearReserva()` necesita que esté resuelta:
		 * `alCambiar` avisa cuando lo está, para habilitar el botón de reservar.
		 */
		verificar: (hueco: HTMLElement, o?: OpcionesVerificacion): Verificacion =>
			crearVerificacion(hueco, servidor, opciones.clave, o),

		/**
		 * Reserva. Sin `mesa`, la elige el restaurante: la de menos plazas en la que quepan. La respuesta
		 * trae siempre lo que ha quedado reservado: tras un intento cuya respuesta se perdió, puede ser
		 * la reserva de ese intento.
		 */
		async crearReserva(datos: DatosReserva, o: OpcionesCrearReserva): Promise<Reserva> {
			const intento = (intentoEnCurso ??= nuevaClaveDeIntento());
			const cuerpo = { ...datos, mesa: datos.mesa || MESA_AUTOMATICA, nota: datos.nota ?? null };
			let fallo: unknown = null;
			for (let n = 0; ; n++) {
				let t: string;
				try {
					t = await token(o.verificacion, n === 0 ? ESPERA_TOKEN_MS : ESPERA_TOKEN_REINTENTO_MS);
				} catch (e) {
					// Sin token para el reintento (la casilla pide que la marquen otra vez): lo que pasó es lo de antes.
					throw fallo ?? e;
				}
				try {
					const r = sinOk(
						await pedir<Reserva & { ok: true }>("/reservas", enviar(cuerpo, { "X-Turnstile-Token": t, "Idempotency-Key": intento })),
					);
					intentoEnCurso = null;
					return r;
				} catch (e) {
					if (!reintentable(e) || typeof o.verificacion === "string" || n >= ESPERAS_REINTENTO_MS.length) throw e;
					fallo = e;
					await esperar(ESPERAS_REINTENTO_MS[n]);
				}
			}
		},

		/** La reserva del enlace de cancelar del correo (el token va tras `#t=`). */
		consultarReserva: async (tokenDelEnlace: string): Promise<ResumenReserva> =>
			sinOk(await pedir<ResumenReserva & { ok: true }>("/reserva", enviar({ token: tokenDelEnlace }))),

		/** Cancela la reserva del enlace. Cancelar una ya cancelada no es un error. */
		async cancelarReserva(tokenDelEnlace: string): Promise<void> {
			await pedir<{ ok: true }>("/cancelar", enviar({ token: tokenDelEnlace }));
		},
	};
}

export type ReservasWeb = ReturnType<typeof reservasWeb>;
