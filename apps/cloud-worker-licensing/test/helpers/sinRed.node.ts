// test/helpers/sinRed.node.ts
//
// La guarda de red del proyecto `node` (los `*.node.test.ts`, que leen el fuente con el analizador
// de TypeScript y no corren en workerd). Aquí no hay worker auxiliar ni colector: es lo único que
// hay. La instala `sinRed.node.setup.ts` antes de cada fichero.
//
// Hoy esos tests sólo leen ficheros. Si uno intenta salir —`fetch`, un `WebSocket`, un socket de
// `node:net` o `node:tls`, o `node:http`/`node:https`, que van por ellos—, se rechaza diciendo el
// método y el origen (o el host y el puerto) y el test falla al terminar, aunque se trague el error.
// No cubre lo que llame directamente a la resolución de nombres (`node:dns`) ni un binario hijo.

import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

import { SALIDA_BLOQUEADA, describirSalida } from "./entornoDePruebas";

const QUE_HACER =
	"Un test de Node no sale a la red: docs/arquitectura/worker.md, «Los tests no salen a la red».";

const CLAVE = Symbol.for("tpv.tests.sinRed.node");

type Guarda = { intentos: string[] };

function guarda(): Guarda {
	const puesta = (globalThis as any)[CLAVE] as Guarda | undefined;
	if (!puesta) {
		throw new Error(
			"La guarda de red no está puesta: falta `test/helpers/sinRed.node.setup.ts` en `setupFiles` (vitest.config.ts).",
		);
	}
	return puesta;
}

function rechazar(salida: string): Error {
	guarda().intentos.push(salida);
	return new Error(`${SALIDA_BLOQUEADA}: ${salida}. ${QUE_HACER}`);
}

/** «TCP host:puerto», sea cual sea la forma en que se pidió: (puerto, host), ({ host, port }), ruta. */
function destinoTcp(argumentos: unknown[]): string {
	const [primero, segundo] = argumentos;
	let host: unknown;
	let puerto: unknown;
	if (primero && typeof primero === "object") {
		const o = primero as { host?: unknown; hostname?: unknown; port?: unknown; path?: unknown };
		// Sin host ni puerto, `path` es un socket local; con ellos (lo que manda un agente de
		// `node:http`), es la ruta de la URL, y no se repite.
		if (o.port === undefined && o.host === undefined && o.hostname === undefined && o.path !== undefined) {
			return "TCP (una ruta local)";
		}
		host = o.host ?? o.hostname ?? "localhost";
		puerto = o.port;
	} else {
		puerto = primero;
		host = typeof segundo === "string" ? segundo : "localhost";
	}
	const destino = `${host}:${puerto}`;
	return /^[a-z0-9.-]+:\d+$/i.test(destino) ? `TCP ${destino}` : "TCP (dirección que no se puede interpretar)";
}

/** Pone la guarda. La segunda vez no hace nada. */
export function ponerGuardaDeRedEnNode(): void {
	const global = globalThis as any;
	if (global[CLAVE]) return;
	global[CLAVE] = { intentos: [] } satisfies Guarda;

	global.fetch = (entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const peticion = entrada instanceof Request ? entrada : null;
		const metodo = String(init?.method ?? peticion?.method ?? "GET").toUpperCase();
		return Promise.reject(rechazar(describirSalida(metodo, peticion ? peticion.url : String(entrada))));
	};

	const WebSocketBloqueado = function (direccion: unknown) {
		throw rechazar(describirSalida("WebSocket", String(direccion)));
	};
	global.WebSocket = global.WebSocket
		? new Proxy(global.WebSocket, { construct: (_clase, [direccion]) => WebSocketBloqueado(direccion) })
		: WebSocketBloqueado;

	const conectar = (...argumentos: unknown[]): never => {
		throw rechazar(destinoTcp(argumentos));
	};
	net.connect = conectar as typeof net.connect;
	net.createConnection = conectar as typeof net.createConnection;
	tls.connect = conectar as typeof tls.connect;
	// Los agentes de `node:http` y `node:https` se guardan su `createConnection` al cargarse.
	http.Agent.prototype.createConnection = conectar as any;
	https.Agent.prototype.createConnection = conectar as any;
	// Que `import { connect } from "node:net"` vea también la sustitución.
	syncBuiltinESMExports();
}

/** Las salidas cortadas desde la última vez que se preguntó, y las olvida. */
export function salidasSinDobleEnNode(): string[] {
	return guarda().intentos.splice(0);
}

/** Falla si desde la última comprobación algo ha intentado salir a la red. */
export function exigirQueNadaHayaSalidoEnNode(): void {
	const salidas = salidasSinDobleEnNode();
	if (salidas.length === 0) return;
	throw new Error(
		`Se ha intentado salir a la red desde un test de Node (${SALIDA_BLOQUEADA.toLowerCase()}):\n` +
			salidas.map((s) => `  · ${s}`).join("\n") +
			`\n${QUE_HACER}`,
	);
}
