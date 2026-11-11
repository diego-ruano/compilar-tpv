// test/sinRed.node.test.ts
//
// El proyecto `node` tampoco sale a la red (docs/arquitectura/worker.md, «Los tests no salen a la
// red»). Sus tests leen el fuente y nada más, así que la guarda es barata
// (`helpers/sinRed.node.ts`): `fetch`, `WebSocket`, `node:net`, `node:tls` y los agentes de
// `node:http` y `node:https` lanzan, y el gancho hace fallar al test que lo intente aunque se trague
// el error. Y Vite no le pasa ningún `.env`.
//
// Todo lo que se intenta aquí va a hosts `.invalid`.

import http from "node:http";
import https from "node:https";
import { connect } from "node:net";
import tls from "node:tls";

import { describe, expect, it, onTestFinished } from "vitest";

import { SALIDA_BLOQUEADA } from "./helpers/entornoDePruebas";
import { salidasSinDobleEnNode } from "./helpers/sinRed.node";

const PUESTAS_POR_VITE = new Set(["BASE_URL", "DEV", "MODE", "PROD", "SSR"]);

describe("el proyecto node no sale a la red", () => {
	it("Vite no pasa ningún .env: import.meta.env sólo trae lo suyo", () => {
		const deMas = Object.keys((import.meta as unknown as { env: Record<string, unknown> }).env).filter(
			(nombre) => !PUESTAS_POR_VITE.has(nombre),
		);
		expect(deMas).toEqual([]);
	});

	it("fetch, con el método y el origen y sin la ruta", async () => {
		await expect(fetch("https://latido.invalid/api/v1/heartbeat/SECRETO?token=SECRETO")).rejects.toThrow(
			`${SALIDA_BLOQUEADA}: GET https://latido.invalid. `,
		);
		expect(salidasSinDobleEnNode()).toEqual(["GET https://latido.invalid"]);
	});

	it("un WebSocket", () => {
		expect(() => new WebSocket("wss://base.invalid/SECRETO")).toThrow(
			`${SALIDA_BLOQUEADA}: WebSocket wss://base.invalid. `,
		);
		expect(salidasSinDobleEnNode()).toEqual(["WebSocket wss://base.invalid"]);
	});

	it("node:net, también importado por nombre, y node:tls", () => {
		expect(() => connect(443, "tcp.invalid")).toThrow(`${SALIDA_BLOQUEADA}: TCP tcp.invalid:443. `);
		expect(() => tls.connect({ host: "tls.invalid", port: 8443 })).toThrow(
			`${SALIDA_BLOQUEADA}: TCP tls.invalid:8443. `,
		);
		expect(salidasSinDobleEnNode()).toEqual(["TCP tcp.invalid:443", "TCP tls.invalid:8443"]);
	});

	it("node:http y node:https, que van por sus agentes", () => {
		expect(() => http.get("http://http.invalid/SECRETO")).toThrow(`${SALIDA_BLOQUEADA}: TCP http.invalid:80. `);
		expect(() => https.get("https://https.invalid/SECRETO")).toThrow(
			`${SALIDA_BLOQUEADA}: TCP https.invalid:443. `,
		);
		const salidas = salidasSinDobleEnNode();
		expect(salidas).toEqual(["TCP http.invalid:80", "TCP https.invalid:443"]);
	});
});

const visto = { llegoAlFinal: false, errores: [] as string[] };

describe("el gancho hace fallar al test, aunque el código se trague el error", () => {
	// `it.fails`: el cuerpo no falla; lo hace fallar el `afterEach` de `helpers/sinRed.node.setup.ts`.
	it.fails("una salida tragada", async () => {
		onTestFinished(({ task }) => {
			visto.errores = (task.result?.errors ?? []).map((e) => String(e?.message));
		});
		await fetch("https://salida-tragada.invalid/SECRETO").catch(() => {});
		try {
			connect(443, "socket-tragado.invalid");
		} catch {
			// Tragado a propósito.
		}
		visto.llegoAlFinal = true;
	});

	it("y falló por eso, sin el secreto", () => {
		expect(visto.llegoAlFinal).toBe(true);
		expect(visto.errores).toHaveLength(1);
		expect(visto.errores[0]).toContain("  · GET https://salida-tragada.invalid\n");
		expect(visto.errores[0]).toContain("  · TCP socket-tragado.invalid:443\n");
		expect(JSON.stringify(visto)).not.toContain("SECRETO");
		expect(salidasSinDobleEnNode()).toEqual([]);
	});
});
