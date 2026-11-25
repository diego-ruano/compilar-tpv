// test/serverTimingSoloAlDispositivo.test.ts
//
// El desglose del tiempo de cada petición (`Server-Timing`, `observability/tiempos.ts`) lo lee el
// generador de carga para saber dónde se va el tiempo. Cuenta cuánto tardan la base central y el
// TenantHub y en qué centro de datos se atiende: eso sólo se le enseña a un dispositivo de un negocio
// que ha pasado `tenantAuth`. Aquí se fija, por la `app` entera:
//
//   · que una ruta pública o anónima (la salud, el preflight, las actualizaciones, el widget y la
//     API pública de las reservas web, el emparejamiento) no lo lleva, conteste lo que conteste;
//   · que una petición firmada de un dispositivo sí, con el viaje al TenantHub;
//   · que una firmada que `tenantAuth` rechaza no lo lleva, tampoco por la licencia.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { centralDePrueba } from "./helpers/central";
import { MAIN, conNegocioFirmado, peticionFirmada, viajes } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";

const env = entorno as any;
const deps = { firmarSesion, olvidarLicenciasCacheadas };

describe("lo que no es de un dispositivo no lleva el desglose", () => {
	it.each([
		["la salud", "GET", "/health"],
		["el preflight", "OPTIONS", "/v1/login/users"],
		["el preflight de la API pública", "OPTIONS", "/v1/publico/reservas/rw_AAAAAAAAAAAAAAAAAAAAAA/negocio"],
		["las actualizaciones", "GET", "/v1/update/windows/x86_64/0.0.1"],
		["la API pública de las reservas web", "GET", "/v1/publico/reservas/rw_AAAAAAAAAAAAAAAAAAAAAA/negocio"],
		["el widget", "GET", "/reservas-web/v1/embed.js"],
		["el emparejamiento", "POST", "/v1/pair/claim"],
		["una ruta de negocio sin firmar", "GET", "/v1/login/users"],
	])("%s", async (_que, metodo, ruta) => {
		const central = await centralDePrueba();
		const res = await app.request(
			ruta,
			{
				method: metodo,
				...(metodo === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
			},
			{ ...env, ...central.entorno },
		);
		// Conteste lo que conteste (200, 204, 401, 404…), sin desglose.
		expect(res.status, ruta).toBeGreaterThan(0);
		expect(res.headers.get("Server-Timing"), `${metodo} ${ruta} (${res.status})`).toBeNull();
	});
});

describe("a un dispositivo del negocio, sí", () => {
	it("una petición firmada lleva su viaje al TenantHub", async () => {
		await conNegocioFirmado(deps, "server-timing", async (n) => {
			const res = await app.request(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"), undefined, { ...env, ...n.entorno });
			expect(res.status).toBe(200);
			expect(res.headers.get("Server-Timing")).toMatch(/total;dur=/);
			expect(viajes(res, "hub-ruta")).toBe(1);
		});
	});

	it("una firmada con la licencia anulada, tampoco: `tenantAuth` la rechaza después de saber quién es", async () => {
		await conNegocioFirmado(deps, "server-timing-licencia-anulada", async (n) => {
			await n.enCentral("UPDATE licenses SET status = 'revoked';");
			const res = await app.request(await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users"), undefined, { ...env, ...n.entorno });
			expect(res.status).toBe(403);
			expect(res.headers.get("Server-Timing")).toBeNull();
		});
	});

	it("una firmada que no pasa `tenantAuth`, no", async () => {
		await conNegocioFirmado(deps, "server-timing-mal-firmada", async (n) => {
			const peticion = await peticionFirmada(deps, n, MAIN, "GET", "/v1/login/users");
			const mal = new Request(peticion, { headers: new Headers(peticion.headers) });
			mal.headers.set("X-Device-Sig", "A".repeat(88));
			const res = await app.request(mal, undefined, { ...env, ...n.entorno });
			expect(res.status).toBe(401);
			expect(res.headers.get("Server-Timing")).toBeNull();
		});
	});
});
