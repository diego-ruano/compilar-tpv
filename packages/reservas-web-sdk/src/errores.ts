// Los errores del SDK. Uno solo, `ErrorReservas`: se decide por `codigo` y se enseña `message`, que
// viene en español y listo para poner en pantalla (lo pone el servidor; los de aquí, el SDK).

/** Los códigos que puede traer un error. Puede llegar otro que no esté aquí: se trata como uno genérico. */
export type CodigoError =
	// Del servidor.
	/** El restaurante no tiene la reserva web disponible (clave, licencia o servicio). */
	| "reserva_web_no_disponible"
	/** El restaurante tiene apagadas las reservas por internet. `cuerpo.negocio` trae nombre y teléfono. */
	| "reserva_web_cerrada"
	/** Demasiadas peticiones seguidas desde esta conexión. */
	| "reserva_web_demasiadas"
	| "dia_no_reservable"
	| "hora_fuera_de_franja"
	/** La mesa elegida se ha ocupado: hay que volver a pedir `disponibles()`. */
	| "mesa_no_disponible"
	/** Con la mesa automática: no queda ninguna a esa hora. Hay que probar otra hora u otro día. */
	| "sin_mesa_libre"
	| "limite_reservas_correo"
	| "tope_reservas_negocio"
	/** Desde esta conexión ya se han hecho muchas reservas hoy en este restaurante: que llamen. */
	| "tope_reservas_conexion"
	/** Turnstile no ha dado por buena la comprobación. */
	| "verificacion_humana_fallida"
	| "reserva_no_cancelable"
	| "enlace_no_valido"
	/** Un dato no vale: `message` dice cuál y qué hacer («El correo no es válido»). */
	| "validation_error"
	// Del SDK.
	/** No ha habido respuesta: sin conexión, o el servidor no contesta. */
	| "red"
	/** `crearReserva()` sin la casilla de «no soy un robot» resuelta. */
	| "verificacion_pendiente";

export const SIN_RED = "No hay conexión. Comprueba tu internet y vuelve a intentarlo.";
export const GENERICO = "Algo ha fallado. Vuelve a intentarlo dentro de un momento.";
export const VERIFICACION_PENDIENTE = "Marca la casilla «No soy un robot» antes de reservar.";

export class ErrorReservas extends Error {
	override name = "ErrorReservas";

	constructor(
		/** Qué ha pasado (`mesa_no_disponible`, `red`…). */
		readonly codigo: CodigoError | (string & {}),
		/** El estado HTTP, o 0 si no hubo respuesta. */
		readonly estado: number,
		mensaje: string,
		/** La respuesta entera, por si trae algo más (`reserva_web_cerrada` trae el negocio). */
		readonly cuerpo: any = null,
	) {
		super(mensaje);
	}
}

/** ¿Es un `ErrorReservas` con ese código? */
export function esError(e: unknown, codigo: CodigoError): e is ErrorReservas {
	return e instanceof ErrorReservas && e.codigo === codigo;
}
