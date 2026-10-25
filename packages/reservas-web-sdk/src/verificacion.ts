// La casilla de «no soy un robot» (Turnstile) para un formulario propio.
//
// Turnstile sólo funciona en los dominios dados de alta en su widget, y la web de cada restaurante no
// está entre ellos. Por eso la casilla no se pinta en la web: va en una página diminuta del servidor
// de reservas (`/reservas-web/v1/w/:clave/verificar`), metida en un iframe. Para Turnstile, la página
// es siempre la nuestra; cuando la persona pasa la prueba, la página le da el token a la web con
// `postMessage`, y `crearReserva()` lo manda. El servidor sólo sirve esa página a las webs dadas de
// alta para el negocio, y sólo se deja incrustar en ellas.
//
// Un token vale para un intento: al usarlo se pide otro solo, para que un reintento lo tenga listo.

const MENSAJE = "tpv-reservas-verificacion";
const REINICIAR = "tpv-reservas-reiniciar";

export type OpcionesVerificacion = {
	/** Cada vez que cambia: `true` cuando la casilla está resuelta y se puede reservar. */
	alCambiar?: (lista: boolean) => void;
	/** Si la casilla no puede cargar o Turnstile falla. Se arregla con `reiniciar()` o recargando. */
	alFallar?: () => void;
};

export interface Verificacion {
	/** ¿Está la casilla resuelta, con un token listo para reservar? */
	readonly lista: boolean;
	/** Pide otra comprobación. `crearReserva()` lo hace sola tras usar el token. */
	reiniciar(): void;
	/** Quita la casilla de la página y deja de escuchar. */
	destruir(): void;
}

type Interno = { tomar: (esperaMs: number) => Promise<string | null> };

/** Lo que usa `crearReserva()` y no forma parte de lo que se ofrece. */
const internos = new WeakMap<Verificacion, Interno>();

/**
 * El token de la casilla, esperando hasta `esperaMs` a que lo haya; `null` si no llega. Se gasta al
 * tomarlo y la casilla pide otro.
 */
export function tomarToken(v: Verificacion, esperaMs: number): Promise<string | null> {
	return internos.get(v)?.tomar(esperaMs) ?? Promise.resolve(null);
}

export function crearVerificacion(
	hueco: HTMLElement,
	/** El servidor de reservas (`https://…`), o vacío si es el mismo origen que la página. */
	servidor: string,
	clave: string,
	opciones: OpcionesVerificacion = {},
): Verificacion {
	const origenServidor = servidor ? new URL(servidor).origin : window.location.origin;
	const iframe = document.createElement("iframe");
	iframe.src = `${servidor}/reservas-web/v1/w/${encodeURIComponent(clave)}/verificar?origen=${encodeURIComponent(window.location.origin)}`;
	iframe.title = "Comprobación de seguridad";
	iframe.style.width = "100%";
	iframe.style.height = "65px";
	iframe.style.border = "0";
	iframe.style.display = "block";
	hueco.appendChild(iframe);

	let token: string | null = null;
	let esperando: ((t: string | null) => void)[] = [];

	const avisar = (lista: boolean) => opciones.alCambiar?.(lista);

	function alMensaje(e: MessageEvent) {
		if (e.origin !== origenServidor || e.source !== iframe.contentWindow) return;
		const datos = e.data;
		if (!datos || datos.tipo !== MENSAJE) return;
		if (datos.fallo) opciones.alFallar?.();
		token = typeof datos.token === "string" && datos.token ? datos.token : null;
		// Uno que esperaba se lo lleva en el acto (y se gasta); si no, queda listo.
		const siguiente = token ? esperando.shift() : undefined;
		if (siguiente) {
			const t = token;
			token = null;
			siguiente(t);
			pedirOtro();
		} else {
			avisar(token !== null);
		}
	}
	window.addEventListener("message", alMensaje);

	function pedirOtro() {
		token = null;
		avisar(false);
		iframe.contentWindow?.postMessage({ tipo: REINICIAR }, origenServidor);
	}

	const verificacion: Verificacion = {
		get lista() {
			return token !== null;
		},
		reiniciar: pedirOtro,
		destruir() {
			window.removeEventListener("message", alMensaje);
			iframe.remove();
			for (const e of esperando) e(null);
			esperando = [];
		},
	};

	internos.set(verificacion, {
		tomar(esperaMs) {
			if (token) {
				const t = token;
				pedirOtro();
				return Promise.resolve(t);
			}
			return new Promise((resolver) => {
				const plazo = setTimeout(() => {
					esperando = esperando.filter((e) => e !== listo);
					resolver(null);
				}, esperaMs);
				const listo = (t: string | null) => {
					clearTimeout(plazo);
					resolver(t);
				};
				esperando.push(listo);
			});
		},
	});
	return verificacion;
}
