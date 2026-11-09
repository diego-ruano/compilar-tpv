import { createClient, type Client } from "@libsql/client/web";

export type DbConfig = {
	url: string;
	authToken: string;
	/** AUD-18: plazo de cada petición, en milisegundos (ver `fetchConPlazo`). Sin él, ninguno. */
	plazoMs?: number;
};

/**
 * AUD-18 · Plazo de cada petición del Durable Object a la base de su tenant.
 *
 * Una escritura tarda milisegundos, y el lote más grande de la cola (50 operaciones) poco más:
 * quince segundos es una petición que no va a volver.
 */
export const PLAZO_TURSO_MS = 15_000;

type Fetch = (peticion: Request, init?: RequestInit) => Promise<Response>;

/**
 * AUD-18 · Un `fetch` con plazo para el cliente de libsql.
 *
 * Una petición colgada retenía el turno del log del DO (`tenantHub.turno.ts`), y con él todas las
 * escrituras del negocio, sin límite: la hibernación no la corta, porque espera a que no quede nada
 * en vuelo. Vencido el plazo se aborta —también si ya habían llegado las cabeceras y se colgó el
 * cuerpo— y sale como un fallo de transporte más: quien escribe lo trata como una confirmación
 * incierta.
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

export function createDbClient(cfg: DbConfig): Client {
	return createClient({
		url: cfg.url,
		authToken: cfg.authToken,
		...(cfg.plazoMs ? { fetch: fetchConPlazo(cfg.plazoMs) } : {}),
	});
}
