// test/sinRed.test.ts
//
// La suite no sale a la red (docs/arquitectura/worker.md, «Los tests no salen a la red»).
//
// La configuración de los tests reutiliza `wrangler.json`, el de producción: con sus `vars`, un
// test al que le faltara un doble construía un cliente contra la base central de verdad, y la
// petición salía. Aquí se fijan las cosas que lo impiden:
//
//   · el worker de pruebas recibe los textos de `helpers/entornoDePruebas.ts` y vacío todo lo
//     demás, digan lo que digan `wrangler.json`, el `.dev.vars` del equipo o su `.env`, y Vite no
//     le pasa ningún `.env` por `import.meta.env` ni `process.env`;
//   · una salida sin doble se rechaza diciendo el método y el origen, sin la ruta ni la consulta
//     (`helpers/sinRed.ts`);
//   · aunque algo se salte esa guarda, el worker de pruebas no tiene por dónde salir
//     (`outboundService` en `vitest.config.ts`);
//   · un socket TCP de `cloudflare:sockets` se corta y se apunta en la guarda;
//   · y todo eso hace fallar al test aunque el código se trague el error: lo comprueba el propio
//     Vitest, con tests que tienen que acabar en fallo por culpa del gancho.
//
// Todo lo que se intenta aquí va a hosts `.invalid`, que no resuelven nunca.

import { createClient } from "@libsql/client/web";
import { connect } from "cloudflare:sockets";
import { env } from "cloudflare:test";
import { describe, expect, it, onTestFinished } from "vitest";

import wrangler from "../wrangler.json";
import {
	ENTORNO_DE_PRUEBAS,
	IGUAL_QUE_EN_PRODUCCION,
	SALIDA_BLOQUEADA,
	describirSalida,
} from "./helpers/entornoDePruebas";
import { enElHub } from "./helpers/hub";
import { fetchSinGuarda, salidasCortadasPorDetras, salidasSinDoble } from "./helpers/sinRed";

const entorno = env as unknown as Record<string, unknown>;

const SIN_INTERPRETAR = "(dirección que no se puede interpretar)";

/** Lo que Vite y Vitest ponen en `import.meta.env` y `process.env` por su cuenta. No son secretos. */
const PUESTAS_POR_VITE = new Set(["BASE_URL", "DEV", "MODE", "PROD", "SSR"]);
const PUESTAS_POR_VITEST = new Set([...PUESTAS_POR_VITE, "VITEST_POOL_ID", "VITEST_WORKER_ID"]);

describe("el entorno de la suite es de pruebas", () => {
	it("el worker de pruebas recibe los textos de la tabla, digan lo que digan wrangler.json y .dev.vars", () => {
		const recibidos = Object.fromEntries(Object.keys(ENTORNO_DE_PRUEBAS).map((nombre) => [nombre, entorno[nombre]]));
		expect(recibidos).toEqual(ENTORNO_DE_PRUEBAS);
	});

	it("cualquier otro texto llega vacío", () => {
		// Lo que haya de más en el `.dev.vars` (o el `.env`) del equipo: `vitest.config.ts` lo pone a
		// vacío. Sin ese fichero no hay nada de más y esto no mira nada; con él, sí.
		const deMas = Object.entries(entorno)
			.filter(([nombre]) => !(nombre in ENTORNO_DE_PRUEBAS))
			.filter(([, valor]) => ["string", "number", "boolean"].includes(typeof valor))
			.filter(([, valor]) => valor !== "")
			.map(([nombre]) => nombre);
		expect(deMas).toEqual([]);
	});

	it("Vite no pasa ningún .env: import.meta.env sólo trae lo suyo", () => {
		// Sin `envDir: false`, una `VITE_*` del `.env` de la carpeta llegaba aquí con su valor.
		const deMas = Object.keys((import.meta as unknown as { env: Record<string, unknown> }).env).filter(
			(nombre) => !PUESTAS_POR_VITE.has(nombre),
		);
		expect(deMas).toEqual([]);
	});

	it("process.env no trae nada con valor que no sea de la tabla", () => {
		// workerd lo rellena con los textos del entorno (la tabla, y vacío lo de más), y Vitest le
		// añade lo de Vite: sin `envDir: false`, también las `VITE_*` del `.env`.
		const procesoEnv = (globalThis as unknown as { process: { env: Record<string, unknown> } }).process.env;
		const conValor = Object.entries(procesoEnv)
			.filter(([nombre]) => !PUESTAS_POR_VITEST.has(nombre))
			.filter(([nombre, valor]) =>
				nombre in ENTORNO_DE_PRUEBAS
					? valor !== ENTORNO_DE_PRUEBAS[nombre as keyof typeof ENTORNO_DE_PRUEBAS]
					: valor !== "",
			)
			.map(([nombre]) => nombre);
		expect(conValor).toEqual([]);
	});

	it("ninguna variable de wrangler.json llega con su valor de producción", () => {
		const vars = Object.entries(wrangler.vars as Record<string, unknown>);
		// Si `vars` se quedara vacío, este test pasaría sin mirar nada.
		expect(vars.length).toBeGreaterThan(0);

		// Una variable nueva necesita su valor de pruebas: va a `Env` y a la tabla.
		expect(vars.map(([nombre]) => nombre).filter((nombre) => !(nombre in ENTORNO_DE_PRUEBAS))).toEqual([]);

		const comoEnProduccion = vars
			.filter(([nombre]) => !(nombre in IGUAL_QUE_EN_PRODUCCION))
			.filter(([nombre, valor]) => JSON.stringify(entorno[nombre]) === JSON.stringify(valor))
			.map(([nombre]) => nombre);
		expect(comoEnProduccion).toEqual([]);
	});

	it("nada de lo que recibe nombra un host de verdad", () => {
		// Una dirección, un correo o un dominio: lo que lleve un punto entre dos nombres.
		const hosts = Object.entries(ENTORNO_DE_PRUEBAS).flatMap(([nombre, valor]) =>
			(valor.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []).map((host) => `${nombre}: ${host}`),
		);
		expect(hosts.length).toBeGreaterThan(0);
		expect(hosts.filter((h) => !h.endsWith(".invalid"))).toEqual([]);
	});
});

describe("lo que dice una salida bloqueada", () => {
	it("el método y el origen; nunca la ruta, la consulta ni el usuario", () => {
		// La dirección de un latido de Better Stack es un secreto entera: va en la ruta.
		expect(describirSalida("GET", "https://latido.invalid/api/v1/heartbeat/SECRETO?token=SECRETO")).toBe(
			"GET https://latido.invalid",
		);
		expect(describirSalida("POST", "https://usuario:SECRETO@base.invalid:8443/v2/pipeline")).toBe(
			"POST https://base.invalid:8443",
		);
		expect(describirSalida("WebSocket", "wss://base.invalid/SECRETO")).toBe("WebSocket wss://base.invalid");
		// Lo que no se deja interpretar no se repite: podría ser el secreto mismo.
		expect(describirSalida("GET", "latido SECRETO")).toBe(`GET ${SIN_INTERPRETAR}`);
	});

	it("la guarda lo dice así, también con una dirección mal formada", async () => {
		const errores: string[] = [];
		for (const direccion of ["https://latido.invalid/api/v1/heartbeat/SECRETO?token=SECRETO", "latido SECRETO"]) {
			await fetch(direccion).catch((e: unknown) => errores.push(String((e as Error).message)));
		}
		expect(errores).toHaveLength(2);
		expect(errores[0].startsWith(`${SALIDA_BLOQUEADA}: GET https://latido.invalid. `)).toBe(true);
		expect(errores[1].startsWith(`${SALIDA_BLOQUEADA}: GET ${SIN_INTERPRETAR}. `)).toBe(true);

		const apuntadas = salidasSinDoble();
		expect(apuntadas).toEqual(["GET https://latido.invalid", `GET ${SIN_INTERPRETAR}`]);
		expect(JSON.stringify([errores, apuntadas])).not.toContain("SECRETO");
	});

	it("el worker auxiliar lo dice igual", async () => {
		const r = await fetchSinGuarda()("https://latido.invalid/api/v1/heartbeat/SECRETO?token=SECRETO");
		const texto = await r.text();
		expect([r.status, texto]).toEqual([599, `${SALIDA_BLOQUEADA}: GET https://latido.invalid`]);
		expect(await salidasCortadasPorDetras()).toEqual(["GET https://latido.invalid"]);
	});
});

describe("una salida a la red sin doble", () => {
	it("el cliente de la base central que monta el TenantHub no llega a ninguna parte", async () => {
		// Lo que pasa cuando a un test del Durable Object le falta el doble de la base central.
		const central = new URL(ENTORNO_DE_PRUEBAS.TURSO_DATABASE_URL).host;
		expect(central.endsWith(".invalid")).toBe(true);

		await enElHub("sin-red-base-central", async (hub: any) => {
			await expect(hub.getCentralDb().execute("SELECT 1;")).rejects.toThrow(
				`${SALIDA_BLOQUEADA}: POST https://${central}. `,
			);
		});

		const salidas = salidasSinDoble();
		expect(salidas.length).toBeGreaterThan(0);
		expect(salidas.filter((s) => s !== `POST https://${central}`)).toEqual([]);
	});

	it("el cliente de libsql no sale ni por `fetch` ni por WebSocket", async () => {
		const porHttp = createClient({ url: "libsql://base-sin-doble.invalid", authToken: "x" });
		await expect(porHttp.execute("SELECT 1;")).rejects.toThrow(SALIDA_BLOQUEADA);

		// Con una dirección `wss:` no usa `fetch`: abre un WebSocket.
		const porWebSocket = async () =>
			createClient({ url: "wss://base-sin-doble.invalid", authToken: "x" }).execute("SELECT 1;");
		await expect(porWebSocket()).rejects.toThrow(SALIDA_BLOQUEADA);

		const salidas = salidasSinDoble();
		expect(salidas).toContain("POST https://base-sin-doble.invalid");
		expect(salidas).toContain("WebSocket wss://base-sin-doble.invalid");
	});

	it("un doble declarado no cuenta como salida", async () => {
		const fetchDeLaSuite = globalThis.fetch;
		(globalThis as any).fetch = async () => new Response("doble");
		try {
			expect(await (await fetch("https://servicio-con-doble.invalid/")).text()).toBe("doble");
		} finally {
			(globalThis as any).fetch = fetchDeLaSuite;
		}
		expect(salidasSinDoble()).toEqual([]);
		expect(await salidasCortadasPorDetras()).toEqual([]);
	});

	it("un socket TCP de cloudflare:sockets se corta y se apunta, con el host y el puerto", () => {
		expect(() => connect({ hostname: "tcp-sin-doble.invalid", port: 443 })).toThrow(
			`${SALIDA_BLOQUEADA}: TCP tcp-sin-doble.invalid:443. `,
		);
		expect(() => connect("otro-tcp.invalid:8443")).toThrow(`${SALIDA_BLOQUEADA}: TCP otro-tcp.invalid:8443. `);
		expect(() => connect("no es un destino SECRETO")).toThrow(`${SALIDA_BLOQUEADA}: TCP ${SIN_INTERPRETAR}. `);
		expect(salidasSinDoble()).toEqual([
			"TCP tcp-sin-doble.invalid:443",
			"TCP otro-tcp.invalid:8443",
			`TCP ${SIN_INTERPRETAR}`,
		]);
	});

	it("nadie abre un socket por node:net o node:tls, que el worker auxiliar corta pero no puede apuntar", () => {
		// Un `connect()` no llega al worker auxiliar (workerd no le pasa la conexión), y el de
		// `node:net` y `node:tls` va por dentro del runtime, sin pasar por la sustitución de
		// `cloudflare:sockets`: uno tragado no haría fallar al test. Se cierra por el otro lado:
		// ni el worker ni los tests los importan. Lo que haga una dependencia por dentro no se ve aquí.
		const fuentes = {
			...import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
			...import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true }),
		};
		const propias = Object.keys(fuentes).filter((ruta) => !ruta.endsWith(".d.ts"));
		expect(propias.some((ruta) => ruta.startsWith("../src/"))).toBe(true);
		expect(propias.some((ruta) => ruta.startsWith("./helpers/"))).toBe(true);
		// Este fichero los nombra para buscarlos, y la guarda del proyecto `node` (que corre en Node,
		// no en workerd) los sustituye y los prueba.
		const QUE_LOS_NOMBRAN = new Set([
			"./sinRed.test.ts",
			"./sinRed.node.test.ts",
			"./helpers/sinRed.node.ts",
		]);
		const conSockets = propias
			.filter((ruta) => !QUE_LOS_NOMBRAN.has(ruta))
			.filter((ruta) => /["'](?:node:)?(?:net|tls)["']/.test(fuentes[ruta]));
		expect(conSockets).toEqual([]);
	});
});

// Lo que vio cada uno de los tests de abajo al terminar, para comprobarlo en el último.
type Final = { llegoAlFinal: boolean; errores: string[]; respuesta?: [number, string] };
const visto: Record<"guarda" | "muro" | "socket", Final> = {
	guarda: { llegoAlFinal: false, errores: [] },
	muro: { llegoAlFinal: false, errores: [] },
	socket: { llegoAlFinal: false, errores: [] },
};

/** Apunta los errores con los que acaba el test en curso: los del gancho, que corre antes. */
function apuntarComoAcaba(final: Final): void {
	onTestFinished(({ task }) => {
		final.errores = (task.result?.errors ?? []).map((e) => String(e?.message));
	});
}

describe("el gancho hace fallar al test, aunque el código se trague el error", () => {
	// `it.fails`: Vitest da por bueno el test sólo si falla. El cuerpo no falla: lo hace fallar el
	// `afterEach` de `helpers/sinRed.setup.ts`. Sin ese gancho, estos tests salen en rojo.

	it.fails("una salida que corta la guarda", async () => {
		apuntarComoAcaba(visto.guarda);
		await fetch("https://salida-tragada.invalid/api/v1/heartbeat/SECRETO").catch(() => {});
		visto.guarda.llegoAlFinal = true;
	});

	it.fails("una salida que se salta la guarda y corta el worker auxiliar", async () => {
		apuntarComoAcaba(visto.muro);
		const r = await fetchSinGuarda()("https://comprobacion-del-bloqueo.invalid/sinRed.test.ts?token=SECRETO");
		visto.muro.respuesta = [r.status, await r.text()];
		visto.muro.llegoAlFinal = true;
	});

	it.fails("un socket TCP", () => {
		apuntarComoAcaba(visto.socket);
		try {
			connect({ hostname: "socket-tragado.invalid", port: 443 });
		} catch {
			// Tragado a propósito.
		}
		visto.socket.llegoAlFinal = true;
	});

	it("y fallaron por eso, con el origen y sin el secreto", async () => {
		// Que el cuerpo llegó al final: si no, habrían «fallado» por otra cosa.
		expect([visto.guarda.llegoAlFinal, visto.muro.llegoAlFinal, visto.socket.llegoAlFinal]).toEqual([
			true,
			true,
			true,
		]);

		expect(visto.socket.errores).toHaveLength(1);
		expect(visto.socket.errores[0]).toContain("  · TCP socket-tragado.invalid:443\n");

		expect(visto.guarda.errores).toHaveLength(1);
		expect(visto.guarda.errores[0]).toContain("Se ha intentado salir a la red sin un doble");
		expect(visto.guarda.errores[0]).toContain("  · GET https://salida-tragada.invalid\n");

		expect(visto.muro.respuesta).toEqual([599, `${SALIDA_BLOQUEADA}: GET https://comprobacion-del-bloqueo.invalid`]);
		expect(visto.muro.errores).toHaveLength(1);
		expect(visto.muro.errores[0]).toContain(
			"  · GET https://comprobacion-del-bloqueo.invalid (por detrás de la guarda)\n",
		);

		expect(JSON.stringify(visto)).not.toContain("SECRETO");
		// Y la cuenta volvió a cero: el fallo fue de quien lo provocó, no de este test.
		expect(salidasSinDoble()).toEqual([]);
		expect(await salidasCortadasPorDetras()).toEqual([]);
	});
});
