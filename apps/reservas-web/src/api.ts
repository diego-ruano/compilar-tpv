// Las rutas públicas del worker (docs/estudios/reservas-web.md §4.2). Mismo origen que el widget:
// rutas relativas y sin CORS. Un error trae su identificador (`error`) y la frase para enseñar
// (`message`, que el worker pone a todos los suyos).

import type { Tramo } from "./logica";

type Negocio = {
	nombre: string;
	direccion: string;
	telefono: string;
	logo: string | null;
	razon_social: string;
	cif: string;
};

export type InfoNegocio = {
	negocio: Negocio;
	hoy: string;
	primer_dia: string;
	ultimo_dia: string;
	dias_abiertos: string[];
	max_personas: number;
	duracion_min: number;
	turnstile: string | null;
};

type SalonPublico = { id: string; nombre: string; puntos: string };
export type MesaPublica = {
	id: string;
	id_salon: string;
	numero: string;
	forma: string;
	x: number;
	y: number;
	ancho: number;
	alto: number;
	radio: number | null;
	capacidad: number;
	reservable: boolean;
};
export type PlanoPublico = { completo: boolean; salones: SalonPublico[]; mesas: MesaPublica[] };

export type Disponibles = { mesas: string[]; alternativas: string[] };

export type Alta = {
	dia_ymd: string;
	hora: string;
	personas: number;
	id_mesa: string;
	nombre: string;
	email: string;
	telefono: string;
	nota: string | null;
};

export type Confirmada = { codigo: string; dia: string; hora: string; personas: number; mesa: string };

export type Resumen = {
	dia: string;
	hora: string;
	personas: number;
	mesa: string;
	estado: "confirmada" | "cancelada" | "pasada";
	cancelable: boolean;
};

export class ErrorApi extends Error {
	constructor(
		/** El identificador del worker (`mesa_no_disponible`…), o `red` sin conexión. */
		readonly codigo: string,
		readonly estado: number,
		mensaje: string,
		/** El cuerpo entero, por si trae algo más (el negocio al estar cerradas, los `issues`). */
		readonly cuerpo: any = null,
	) {
		super(mensaje);
	}
}

const SIN_RED = "No hay conexión. Comprueba tu internet y vuelve a intentarlo.";
const GENERICO = "Algo ha fallado. Vuelve a intentarlo dentro de un momento.";

async function pedir<T>(ruta: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(ruta, init);
	} catch {
		throw new ErrorApi("red", 0, SIN_RED);
	}
	let cuerpo: any = null;
	try {
		cuerpo = await res.json();
	} catch {
		// Sin cuerpo JSON: cuenta como fallo genérico abajo.
	}
	if (!res.ok || !cuerpo || cuerpo.ok === false) {
		const primerIssue = Array.isArray(cuerpo?.issues) ? cuerpo.issues[0]?.message : undefined;
		throw new ErrorApi(cuerpo?.error ?? "desconocido", res.status, cuerpo?.message ?? primerIssue ?? GENERICO, cuerpo);
	}
	return cuerpo as T;
}

function enviar(cuerpo: unknown, cabeceras: Record<string, string> = {}): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...cabeceras },
		body: JSON.stringify(cuerpo),
	};
}

export function apiDe(clave: string) {
	const base = `/v1/publico/reservas/${encodeURIComponent(clave)}`;
	return {
		negocio: () => pedir<InfoNegocio>(`${base}/negocio`),
		dia: (dia: string) => pedir<{ dia: string; tramos: Tramo[] }>(`${base}/dia?dia=${dia}`),
		// `fresco`: sin la caché del navegador (la ruta la permite un minuto), cuando el que se tiene se ha quedado viejo.
		plano: (fresco = false) => pedir<PlanoPublico>(`${base}/plano`, fresco ? { cache: "no-cache" } : undefined),
		disponibles: (dia: string, hora: string, personas: number) =>
			pedir<Disponibles>(`${base}/disponibles?dia=${dia}&hora=${encodeURIComponent(hora)}&personas=${personas}`),
		reservar: (alta: Alta, tokenTurnstile: string, intento: string) =>
			pedir<Confirmada>(`${base}/reservas`, enviar(alta, { "X-Turnstile-Token": tokenTurnstile, "Idempotency-Key": intento })),
		reserva: (token: string) => pedir<Resumen>(`${base}/reserva`, enviar({ token })),
		cancelar: (token: string) => pedir<{ ok: true }>(`${base}/cancelar`, enviar({ token })),
	};
}

export type Api = ReturnType<typeof apiDe>;
