// test/helpers/socketFalso.ts
//
// Los dobles que comparten los tests de los dos sockets (`socketMain.test.ts` y
// `socketHandy.test.ts`):
//
//   · `SocketFalso`: un WebSocket que no conecta a nada. Como el de un navegador, `close()` no
//     dispara `onclose` en el acto —el cierre termina cuando el test llama a `cerrar()`— y un mensaje
//     que llega con el socket no abierto se descarta, que es lo que manda la especificación.
//   · `asentar` y `avanzar`: dejar correr las promesas, y el reloj falso de Vitest.
//
// No es un fichero `*.test.ts`, así que Vitest no lo ejecuta por su cuenta.

import { vi } from "vitest";

export type Mensaje = Record<string, any>;

export class SocketFalso {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static creados: SocketFalso[] = [];
	/** Qué contesta la nube a lo que envían los sockets creados a partir de ahora. */
	static nubePorDefecto: (m: Mensaje) => Mensaje | undefined = () => undefined;

	/** Olvida los sockets creados y deja una nube que no contesta nada. Para el `beforeEach`. */
	static reiniciar() {
		SocketFalso.creados = [];
		SocketFalso.nubePorDefecto = () => undefined;
	}

	readyState = SocketFalso.CONNECTING;
	enviados: Mensaje[] = [];
	/** Qué contesta la nube a cada mensaje que envía este socket; `undefined` es que no contesta. */
	nube = SocketFalso.nubePorDefecto;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => unknown) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(readonly url: string) {
		SocketFalso.creados.push(this);
	}
	send(data: string) {
		const m = JSON.parse(data) as Mensaje;
		this.enviados.push(m);
		const respuesta = this.nube(m);
		if (respuesta) setImmediate(() => void this.recibir(respuesta));
	}
	close() {
		if (this.readyState < SocketFalso.CLOSING) this.readyState = SocketFalso.CLOSING;
	}
	abrir() {
		this.readyState = SocketFalso.OPEN;
		this.onopen?.();
	}
	async recibir(m: Mensaje) {
		await this.recibirTexto(JSON.stringify(m));
	}
	async recibirTexto(texto: string) {
		if (this.readyState !== SocketFalso.OPEN) return;
		await this.onmessage?.({ data: texto });
	}
	cerrar() {
		if (this.readyState === SocketFalso.CLOSED) return;
		this.readyState = SocketFalso.CLOSED;
		this.onclose?.();
	}
	tipos() {
		return this.enviados.map((m) => m.type);
	}
	/** Los `opId` de los `apply` que ha enviado, en orden. */
	applies() {
		return this.enviados.filter((m) => m.type === "apply").map((m) => m.opId);
	}
	pings() {
		return this.tipos().filter((t) => t === "ping").length;
	}
}

/** El último socket que se ha creado. */
export const ultimo = () => SocketFalso.creados[SocketFalso.creados.length - 1];

/** Hace que la nube conteste al latido de `s`, conservando lo que ya contestaba al resto. */
export function conPong(s: SocketFalso) {
	const nube = s.nube;
	s.nube = (m) => (m.type === "ping" ? { type: "pong" } : nube(m));
}

/** Deja correr todo lo que no espera a un temporizador: promesas y respuestas de la nube. */
export async function asentar() {
	for (let i = 0; i < 200; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Adelanta el reloj falso y deja correr lo que eso haya disparado. */
export async function avanzar(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
	await asentar();
}
