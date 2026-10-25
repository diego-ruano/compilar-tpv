// La casilla de «no soy un robot» para un formulario propio (la `verificar()` del SDK,
// `packages/reservas-web-sdk/src/verificacion.ts`). La web la mete en un iframe: Turnstile corre
// aquí, en el dominio del servidor de reservas, y el token se le pasa a la web con `postMessage`.
//
// Sólo a `destino` (el `?origen=` de la página), que el worker ha comprobado que es una web del
// negocio antes de servirla, y que es la única que puede incrustarla (`frame-ancestors`): el token no
// sale hacia otra. La web puede pedir otra comprobación (tras gastar el token) con un mensaje, que
// sólo se atiende si viene de su ventana y de ese mismo origen.
//
// Aparte de `verificar.ts`, que sólo la monta, para probarla con una ventana y un Turnstile de mentira.

import { cargarTurnstile } from "./turnstileScript";

export const MENSAJE = "tpv-reservas-verificacion";
export const REINICIAR = "tpv-reservas-reiniciar";

type Turnstile = NonNullable<Window["turnstile"]>;

export function montarCasilla(p: {
	casilla: HTMLElement | null;
	sitekey: string;
	destino: string;
	/** La página (para escuchar los mensajes de la web). */
	ventana: Window;
	/** La web que la incrusta: `window.parent`. */
	padre: Window;
	cargar?: () => Promise<Turnstile | undefined>;
}): void {
	const cargar = p.cargar ?? (() => cargarTurnstile().then(() => window.turnstile));
	let turnstile: Turnstile | undefined;
	let id: string | null = null;

	function avisar(datos: { token: string | null; fallo?: boolean }) {
		if (!p.destino || p.padre === p.ventana) return;
		p.padre.postMessage({ tipo: MENSAJE, ...datos }, p.destino);
	}

	p.ventana.addEventListener("message", (e) => {
		if (e.source !== p.padre || e.origin !== p.destino) return;
		if (e.data?.tipo !== REINICIAR || !id || !turnstile) return;
		avisar({ token: null });
		turnstile.reset(id);
	});

	const casilla = p.casilla;
	if (!casilla || !p.sitekey || !p.destino) {
		avisar({ token: null, fallo: true });
		return;
	}
	cargar().then(
		(t) => {
			if (!t) return avisar({ token: null, fallo: true });
			turnstile = t;
			id = t.render(casilla, {
				sitekey: p.sitekey,
				language: "es",
				size: "flexible",
				callback: (token: string) => avisar({ token }),
				"expired-callback": () => avisar({ token: null }),
				"error-callback": () => avisar({ token: null, fallo: true }),
			});
		},
		() => avisar({ token: null, fallo: true }),
	);
}
