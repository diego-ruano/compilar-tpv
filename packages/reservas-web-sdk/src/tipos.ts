// Lo que va y viene por las rutas públicas de la reserva web (`/v1/publico/reservas/:clave/…`), con
// los nombres de la API. Sin nada del navegador: el worker importa estos tipos para comprobar que sus
// respuestas son éstas (`publico.routes.ts`, con `satisfies`), y así el SDK y la API no se separan.

/** Un día, `AAAA-MM-DD`. */
export type Dia = string;
/** Una hora, `HH:MM`. */
export type Hora = string;

export type Negocio = {
	nombre: string;
	direccion: string;
	telefono: string;
	/** Quién trata los datos de quien reserva: para el texto de privacidad. */
	razon_social: string;
	cif: string;
};

/** Lo del negocio y su calendario (`negocio()`). */
export type InfoNegocio = {
	negocio: Negocio;
	/** Hoy, en la hora del restaurante. */
	hoy: Dia;
	/** El primer y el último día que se pueden reservar. */
	primer_dia: Dia;
	ultimo_dia: Dia;
	/** Los días con alguna hora para reservar y sin cierre, entre esos dos. */
	dias_abiertos: Dia[];
	/** Cuántas personas caben, como mucho, en una reserva. */
	max_personas: number;
	/** Lo que dura una reserva, en minutos. */
	duracion_min: number;
	/** La clave pública de Turnstile. Sólo la usa el widget; con el SDK, `verificar()`. */
	turnstile: string | null;
};

/** Un tramo de horas de llegada válidas, los dos extremos incluidos. */
export type Tramo = { desde: Hora; hasta: Hora };

export type Salon = {
	id: string;
	nombre: string;
	/** El contorno del salón, en JSON: `[x, y, x, y, …]` o `[[x, y], …]`. */
	puntos: string;
};

export type Mesa = {
	id: string;
	id_salon: string;
	/** El nombre que tiene en el restaurante («5», «Terraza 3»). */
	nombre: string;
	/** `rect`, `round`… */
	forma: string;
	x: number;
	y: number;
	ancho: number;
	alto: number;
	radio: number | null;
	capacidad: number;
	/** Si se puede reservar desde la web (en algún momento). */
	reservable: boolean;
};

/** Los salones y las mesas, para dibujar el plano. `completo: false` si hay más de las que caben. */
export type Plano = { completo: boolean; salones: Salon[]; mesas: Mesa[] };

/**
 * Las mesas libres y adecuadas para ese día, hora y personas (sus `id`). Si no hay ninguna,
 * `alternativas`: hasta cuatro horas cercanas que sí tienen.
 */
export type Disponibles = { mesas: string[]; alternativas: Hora[] };

/** Pedir que se elija la mesa sola: la de menos plazas en la que quepan. */
export const MESA_AUTOMATICA = "auto";

/** Lo que se manda para reservar. */
export type DatosReserva = {
	dia: Dia;
	hora: Hora;
	personas: number;
	/** El `id` de una mesa de `disponibles()`, o `"auto"` (lo que se usa si no se pone). */
	mesa?: string;
	nombre: string;
	correo: string;
	telefono: string;
	nota?: string | null;
};

/** Una reserva hecha. */
export type Reserva = {
	/** La referencia corta para hablar con el restaurante. */
	codigo: string;
	dia: Dia;
	hora: Hora;
	personas: number;
	/** El `id` de la mesa que ha quedado (la elegida, o la que se asignó con `"auto"`). */
	mesa: string;
	mesa_nombre: string;
	/**
	 * Si ha salido el correo de confirmación, con el enlace para cancelar. `null` cuando la respuesta es
	 * la de un intento repetido (la reserva ya estaba hecha): su correo salió con el primero.
	 */
	correo_enviado: boolean | null;
};

/** Una reserva vista desde el enlace de cancelar del correo. */
export type ResumenReserva = {
	dia: Dia;
	hora: Hora;
	personas: number;
	mesa: string | null;
	/** Vacío si no se sabe. */
	mesa_nombre: string;
	estado: "confirmada" | "cancelada" | "pasada";
	cancelable: boolean;
};
