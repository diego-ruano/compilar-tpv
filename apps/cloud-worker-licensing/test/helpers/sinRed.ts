// test/helpers/sinRed.ts
//
// La guarda de red de la suite. La instala `sinRed.setup.ts` antes de cada fichero de tests, dentro
// de workerd, que es donde corren los tests, el worker y sus Durable Objects: todos comparten este
// `fetch`.
//
// Ningún test puede hablar con un servicio de verdad. Lo que el código llama fuera —la base
// central, Stripe, Axiom, un latido— se
// sustituye en el test por un doble (cómo: docs/arquitectura/worker.md, «Los tests no salen a la
// red»). Lo que llegue aquí es una salida que nadie ha declarado:
//
//   · se rechaza, con un error que dice el método y el origen (nunca la ruta ni la consulta, que
//     es donde viajan los secretos), y
//   · se apunta, y el test falla al terminar aunque el código se haya tragado el error. Un envío
//     a Axiom o un latido no propagan su fallo: sin esto, el test pasaría en silencio.
//
// Detrás hay un segundo cierre que no depende de este fichero: todo lo que sale del worker de
// pruebas —también lo que no pasa por el `fetch` global, como un socket— va a un worker auxiliar
// que lo corta y lo apunta (`outboundService` en `vitest.config.ts`). Lo suyo se recoge aquí
// también, al terminar cada test.

// ⚠️ Nada de `cloudflare:test` aquí: cargarlo carga el worker, y lo que se guarde al cargarse el
// `fetch` o el `WebSocket` globales se saltaría la guarda, que tiene que estar puesta antes. Y en un
// fichero de tests que no lo usa, cargarlo desde el gancho tarda más que el plazo del gancho.
// `cloudflare:workers` es del runtime: no carga nada.
import { env } from "cloudflare:workers";

import { COLECTOR_DE_SALIDAS, SALIDA_BLOQUEADA, describirSalida } from "./entornoDePruebas";

type Guarda = {
	/** El `fetch` de workerd, el que sale del worker de pruebas. */
	fetchDeWorkerd: typeof fetch;
	/** Las salidas sin doble desde la última comprobación: «POST https://host». */
	intentos: string[];
};

// El estado vive en el global y no en el módulo: la guarda es una por fichero de tests aunque este
// módulo se cargara dos veces.
const CLAVE = Symbol.for("tpv.tests.sinRed");

const QUE_HACER =
	"A este test le falta un doble: docs/arquitectura/worker.md, «Los tests no salen a la red».";

function guarda(): Guarda {
	const puesta = (globalThis as any)[CLAVE] as Guarda | undefined;
	if (!puesta) {
		throw new Error(
			"La guarda de red no está puesta: falta `test/helpers/sinRed.setup.ts` en `setupFiles` (vitest.config.ts).",
		);
	}
	return puesta;
}

/** Pone la guarda. La segunda vez no hace nada. */
export function ponerGuardaDeRed(): void {
	const global = globalThis as any;
	if (global[CLAVE]) return;

	// Enlazado: workerd no deja llamar a su `fetch` con otro `this`.
	const puesta: Guarda = { fetchDeWorkerd: globalThis.fetch.bind(globalThis), intentos: [] };
	global[CLAVE] = puesta;

	global.fetch = (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const peticion = entrada instanceof Request ? entrada : null;
		const metodo = String(init?.method ?? peticion?.method ?? "GET").toUpperCase();
		return Promise.reject(rechazar(describirSalida(metodo, peticion ? peticion.url : String(entrada))));
	};

	// Un `new WebSocket(dirección)` sale a la red sin pasar por `fetch`.
	// `instanceof WebSocket` y las constantes siguen valiendo: el `Proxy` sólo corta el `new`.
	global.WebSocket = new Proxy(globalThis.WebSocket, {
		construct(_clase, [direccion]) {
			throw rechazar(describirSalida("WebSocket", String(direccion)));
		},
	});
}

/** Apunta una salida cortada y devuelve el error con el que se rechaza. */
function rechazar(salida: string): Error {
	guarda().intentos.push(salida);
	return new Error(`${SALIDA_BLOQUEADA}: ${salida}. ${QUE_HACER}`);
}

/**
 * El `connect` de `cloudflare:sockets` con la guarda: lo pone `sinRed.setup.ts` con `vi.mock`.
 * El worker auxiliar también corta un socket, pero workerd no se lo pasa, así que no lo puede
 * apuntar; aquí sí. Del destino sólo dice el host y el puerto.
 */
export function conectarConGuarda(direccion: unknown): never {
	const destino =
		typeof direccion === "string"
			? direccion
			: `${(direccion as { hostname?: unknown })?.hostname}:${(direccion as { port?: unknown })?.port}`;
	const valido = /^[a-z0-9.-]+:\d+$/i.test(destino) ? destino : "(dirección que no se puede interpretar)";
	throw rechazar(`TCP ${valido}`);
}

/**
 * Las salidas que ha cortado la guarda desde la última vez que se preguntó, y las olvida. Sólo lo
 * necesita un test que provoque una a propósito para comprobar la guarda.
 */
export function salidasSinDoble(): string[] {
	return guarda().intentos.splice(0);
}

/** Lo mismo para el worker auxiliar: lo que le ha llegado saltándose la guarda, y lo olvida. */
export async function salidasCortadasPorDetras(): Promise<string[]> {
	const colector = (env as unknown as Record<string, Fetcher | undefined>)[COLECTOR_DE_SALIDAS];
	if (!colector) {
		throw new Error(
			`Falta el binding ${COLECTOR_DE_SALIDAS}: el worker auxiliar de vitest.config.ts no está puesto.`,
		);
	}
	return (await (await colector.fetch("http://colector/")).json()) as string[];
}

/**
 * Falla si desde la última comprobación algo ha intentado salir a la red sin un doble, lo cortara
 * la guarda o el worker auxiliar. Es lo que corre después de cada test.
 */
export async function exigirQueNadaHayaSalido(): Promise<void> {
	const salidas = [
		...salidasSinDoble(),
		...(await salidasCortadasPorDetras()).map((s) => `${s} (por detrás de la guarda)`),
	];
	if (salidas.length === 0) return;
	throw new Error(
		`Se ha intentado salir a la red sin un doble (${SALIDA_BLOQUEADA.toLowerCase()}):\n` +
			salidas.map((s) => `  · ${s}`).join("\n") +
			`\n${QUE_HACER}`,
	);
}

/**
 * El `fetch` de workerd sin la guarda. Es sólo para `test/sinRed.test.ts`, que comprueba con él el
 * segundo cierre: tampoco sale nada por aquí.
 */
export function fetchSinGuarda(): typeof fetch {
	return guarda().fetchDeWorkerd;
}
