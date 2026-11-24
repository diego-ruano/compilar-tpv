import { createClient } from "@libsql/client/web";

import type { Base } from "../../lib/sql";
import { baseSobreTurso } from "../db";

export type DbConfig = {
	url: string;
	authToken: string;
	/** Plazo de cada petición, en milisegundos (ver `fetchConPlazo`). Sin él, ninguno. */
	plazoMs?: number;
};

type Fetch = (peticion: Request, init?: RequestInit) => Promise<Response>;

/**
 * Un `fetch` con plazo para el cliente de libsql.
 *
 * AUD-02: el `TenantHub` pregunta a la base central quién es la Main delante de una escritura o
 * dentro del turno del log, y una petición colgada lo retendría sin límite: la hibernación no la
 * corta, porque espera a que no quede nada en vuelo. Vencido el plazo se aborta —también si ya
 * habían llegado las cabeceras y se colgó el cuerpo— y sale como un fallo de transporte más: una
 * lectura que no ha contestado.
 *
 * El temporizador vive lo que vive su petición: se quita en cuanto la respuesta se ha leído entera,
 * falla o se cancela. Así nunca deja al DO despierto ni le impide hibernar (SYNC-16).
 */
export function fetchConPlazo(plazoMs: number, base: Fetch = (p, i) => fetch(p, i)): Fetch {
	return async (peticion, init) => {
		const control = new AbortController();
		const propia = init?.signal ?? peticion?.signal;
		const seguirPropia = () => control.abort(propia?.reason);
		if (propia?.aborted) seguirPropia();
		else propia?.addEventListener("abort", seguirPropia, { once: true });

		let temporizador: ReturnType<typeof setTimeout> | undefined = setTimeout(
			() => control.abort(new Error(`Turso no ha respondido en ${plazoMs} ms (timeout)`)),
			plazoMs,
		);
		const soltar = () => {
			if (temporizador !== undefined) clearTimeout(temporizador);
			temporizador = undefined;
			propia?.removeEventListener("abort", seguirPropia);
		};

		let respuesta: Response;
		try {
			respuesta = await base(peticion, { ...init, signal: control.signal });
		} catch (e) {
			soltar();
			throw e;
		}
		if (!respuesta.body) {
			soltar();
			return respuesta;
		}

		// El plazo cubre también el cuerpo: se suelta al terminar de leerlo, o si falla o se cancela.
		const lector = respuesta.body.getReader();
		const cuerpo = new ReadableStream<Uint8Array>({
			async pull(destino) {
				try {
					const { done, value } = await lector.read();
					if (done) {
						soltar();
						destino.close();
					} else {
						destino.enqueue(value);
					}
				} catch (e) {
					soltar();
					destino.error(e);
				}
			},
			cancel(motivo) {
				soltar();
				return lector.cancel(motivo);
			},
		});
		return new Response(cuerpo, {
			status: respuesta.status,
			statusText: respuesta.statusText,
			headers: respuesta.headers,
		});
	};
}

/** Un cliente de la base central (Turso). La base de cada negocio es el SQLite de su TenantHub. */
export function createDbClient(cfg: DbConfig): Base {
	return baseSobreTurso(
		createClient({
			url: cfg.url,
			authToken: cfg.authToken,
			...(cfg.plazoMs ? { fetch: fetchConPlazo(cfg.plazoMs) } : {}),
		}),
	);
}
