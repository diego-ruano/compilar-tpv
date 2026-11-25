// test/logSinLoQueEscribeQuienLlama.test.ts
//
// AUD-27 · Lo que el Worker escribe en la consola no lleva tal cual lo que escribe quien llama. El log
// de Workers guarda cada línea sin pasar por el filtro de datos personales (OBS-01), y un camino o un
// mensaje de error pueden traer un correo, un teléfono o un token. Una línea que puede citar lo que
// llegó en la petición lleva la ruta por su patrón, y entera pasa por el filtro y su tope (`acotar`
// con `scrub`), como lo que va a telemetría:
//
//   · la del feed de actualizaciones (`[update] check`), con el sistema, la arquitectura y la versión
//     instalada, que van en el camino;
//   · la del objeto de un negocio que no ha atendido (`[alHub]`, `lib/enElHub.ts::sinElObjeto`), con
//     el mensaje y la traza del error;
//   · la del `/ws` que no se ha podido abrir, con el mensaje y la traza del error.
//
// Las del `onError` y de la central que no atiende están en `centralNoDisponible.test.ts`. La central
// es una de verdad (`centralDePrueba`), o una cuyo stub contesta lo que haga falta.

import { env as entorno } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { centralDePrueba, centralInterceptada, centralSinAprovisionar, filasDe } from "./helpers/central";
import { enElHub } from "./helpers/hub";
import { MAIN, conNegocioFirmado, peticionFirmada } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { olvidarLoQueLeeElFeed } from "../src/domains/updates/updates.routes";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";
import { firmarSesion } from "../src/lib/sesion";
import { bytesUtf8 } from "../src/lib/texto";
import { MAX_BYTES } from "../src/observability/tope";

const env = entorno as any;
const deps = { firmarSesion, olvidarLicenciasCacheadas };

/** Lo que se escribe en la consola mientras dura el caso: cada llamada, con sus argumentos juntos. */
function espiarLaConsola() {
	const escrito: { nivel: string; texto: string }[] = [];
	for (const nivel of ["error", "warn", "log"] as const) {
		vi.spyOn(console, nivel).mockImplementation((...argumentos: unknown[]) => {
			escrito.push({ nivel, texto: argumentos.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
		});
	}
	return escrito;
}

const conElCorreo = (escrito: { texto: string }[]) => escrito.filter((e) => e.texto.includes("ana@example.com"));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("el feed de actualizaciones (`[update] check`)", () => {
	/** El feed, con la central `central`: anónimo, y sin el filtro por IP, que no es lo que se prueba. */
	const pedirElFeed = (ruta: string, central: { entorno: object }) => {
		olvidarLoQueLeeElFeed();
		return app.request(`https://tpv-api.test${ruta}`, {}, { ...env, LIMITADOR_ACTUALIZACIONES: undefined, ...central.entorno });
	};

	it("lleva el patrón de la ruta y lo que sirve a quién", async () => {
		const central = await centralDePrueba();
		await filasDe(
			central,
			`INSERT INTO app_releases (version, target, arch, channel, notes, pub_date, signature, url, is_active)
			 VALUES ('1.2.0', 'windows', 'x86_64', 'stable', '', '2026-01-01', 'sig', 'https://cdn.test/1.2.0.exe', 1);`,
		);
		const escrito = espiarLaConsola();
		const res = await pedirElFeed("/v1/update/windows/x86_64/1.0.0", central);

		expect(res.status).toBe(200);
		expect(escrito).toEqual([
			{
				nivel: "log",
				texto:
					'[update] check GET /v1/update/:target/:arch/:current {"target":"windows","arch":"x86_64","current":"1.0.0","piloto":false,"serving":"1.2.0"}',
			},
		]);
	});

	it("lo que va en el camino sale filtrado: un correo en el lugar de la versión no llega a la consola", async () => {
		const escrito = espiarLaConsola();
		const res = await pedirElFeed("/v1/update/windows/x86_64/ana@example.com", await centralDePrueba());

		expect(res.status).toBe(204);
		expect(conElCorreo(escrito)).toEqual([]);
		expect(escrito).toEqual([
			{
				nivel: "log",
				texto: expect.stringMatching(/^\[update\] check GET \/v1\/update\/:target\/:arch\/:current \{.*"current":"\[email\]"/),
			},
		]);
	});

	it("y acotado: un camino enorme no sale entero", async () => {
		const escrito = espiarLaConsola();
		const res = await pedirElFeed(`/v1/update/windows/x86_64/${"v".repeat(40_000)}`, await centralDePrueba());

		expect(res.status).toBe(204);
		expect(escrito).toHaveLength(1);
		expect(bytesUtf8(escrito[0].texto)).toBeLessThanOrEqual(MAX_BYTES);
	});
});

describe("el objeto del negocio que no atiende (`[alHub]`)", () => {
	it("lleva el patrón de la ruta, no su camino, y el mensaje y la traza filtrados", async () => {
		await conNegocioFirmado(deps, "log-sin-el-objeto", async (n) => {
			// Fuera de la `app`: lo que una ruta lanza dentro lo recoge su `onError`, y no llega aquí.
			await enElHub(n.tenantId, (hub: any) => {
				hub.ejecutarRuta = async () => {
					throw new Error("el objeto no ha podido con ana@example.com (prueba)");
				};
			});
			const escrito = espiarLaConsola();
			const res = await app.request(
				await peticionFirmada(deps, n, MAIN, "GET", "/v1/trabajadores/permisos/ana@example.com"),
				undefined,
				{ ...env, ...n.entorno },
			);

			expect(res.status).toBe(503);
			expect(conElCorreo(escrito)).toEqual([]);
			expect(escrito).toContainEqual({
				nivel: "error",
				texto: expect.stringMatching(/^\[alHub\] GET \/v1\/trabajadores\/\* → Error: el objeto no ha podido con \[email\] \(prueba\)\n/),
			});
		});
	});
});

describe("el `/ws` que no se ha podido abrir", () => {
	it("lleva la ruta, y el mensaje y la traza filtrados", async () => {
		// Un error de SQL que cita lo que le ha llegado: no es la central que no atiende, así que sale
		// por el `catch` del `/ws` como un 500.
		const central = centralInterceptada(centralSinAprovisionar(), async () => ({
			ok: false,
			error: "central_error_sql",
			detalle: 'near "ana@example.com": syntax error',
		}));
		const escrito = espiarLaConsola();
		const res = await app.request("https://tpv-api.test/ws?ticket=un-ticket", {}, {
			...env,
			LIMITADOR_SESION: undefined,
			...central.entorno,
		});

		expect(res.status).toBe(500);
		expect(conElCorreo(escrito)).toEqual([]);
		expect(escrito).toContainEqual({
			nivel: "error",
			texto: expect.stringMatching(
				/^\[ws\] GET \/ws → no se pudo abrir el WebSocket: ErrorDeLaCentral: central_error_sql: near "\[email\]": syntax error\n/,
			),
		});
	});
});
