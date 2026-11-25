// test/rolEnLaIdentidad.test.ts
//
// «Esto sólo lo hace la Main» lo decide un middleware (`soloLaMain…`) con el rol de la fila del
// dispositivo. Las rutas de negocio se ejecutan dentro del TenantHub (`lib/enElHub.ts`), y allí
// ese middleware volvía a la base central a por el rol: un viaje más por petición, desde el DO.
// Ahora el rol lo lee el Worker con la clave pública del dispositivo, en la consulta que ya hacía
// para autenticar, y viaja con la identidad (`IdentidadDelWorker`).
//
// Esto pasa por la `app` entera y por el RPC de verdad (`ejecutarRuta`), con una base central de
// verdad que apunta lo que le piden el Worker y el TenantHub (`helpers/negocioFirmado.ts`), y
// comprueba:
//
// - la Main pasa el veto dentro del DO sin que nadie le pida el rol a la base central, y con la
//   entrada del dispositivo en caché la petición no toca la base central;
// - una Handy se queda fuera, decidido dentro del DO y antes de mirar el cuerpo;
// - el rol no sale de la petición: una cabecera `x-role` no abre nada;
// - en un router que se queda en el Worker (las reservas web de la Main), el veto lee la fila viva;
// - una baja se nota como mucho al caducar la entrada del dispositivo (60 s), que es lo que ya
//   tardaba en notarla `tenantAuth`, y un dispositivo dado de baja nunca entra en la caché.

import { env as entorno } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HANDY, MAIN, conNegocioFirmado, pedirComo, peticionFirmada, viajes } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";

const env = entorno as any;
const deps = { firmarSesion, olvidarLicenciasCacheadas };

/** La consulta de `rolDelDispositivo`: el rol de la fila viva, sin más columnas. */
const PIDE_EL_ROL = /SELECT role FROM devices WHERE tenant_id=\? AND device_id=\? AND revoked_at_ms IS NULL/;

afterEach(() => {
	vi.useRealTimers();
});

describe("el rol del dispositivo viaja con la identidad al TenantHub", () => {
	it("la Main pasa el veto dentro del DO sin que nadie vuelva a la base central a por el rol", async () => {
		await conNegocioFirmado(deps, "rol-main", async (n) => {
			const primera = await pedirComo(deps, app, n, MAIN, "POST", "/v1/sync/changes", { since: 0 });
			expect(primera.status).toBe(200);
			expect(primera.json).toMatchObject({ items: [] });
			expect(primera.viajes).toBe(1);
			// El rol salió de la fila del dispositivo, en la consulta que autentica.
			expect(n.central.some((s) => /SELECT role, revoked_at_ms, device_pubkey_b64 FROM devices/.test(s))).toBe(true);
			expect(n.central.filter((s) => PIDE_EL_ROL.test(s))).toEqual([]);

			// Con el dispositivo y la licencia en caché, la petición entera no toca la base central.
			n.central.length = 0;
			const segunda = await pedirComo(deps, app, n, MAIN, "POST", "/v1/sync/changes", { since: 0 });
			expect(segunda.status).toBe(200);
			expect(segunda.viajes).toBe(1);
			expect(n.central).toEqual([]);
		});
	});

	it("una Handy se queda fuera, decidido dentro del DO y antes de mirar el cuerpo", async () => {
		await conNegocioFirmado(deps, "rol-handy", async (n) => {
			const sync = await pedirComo(deps, app, n, HANDY, "POST", "/v1/sync/changes", { since: 0 });
			expect(sync.status).toBe(403);
			expect(sync.json).toMatchObject({ ok: false, error: "forbidden_not_tpv" });
			expect(sync.viajes).toBe(1);

			// Un cuerpo que no valdría: si el veto fuera detrás de la validación, saldría un 400.
			const cobro = await pedirComo(deps, app, n, HANDY, "POST", "/v1/mesas/cobrar-detalles", { esto: "no es un cobro" });
			expect(cobro.status).toBe(403);
			expect(cobro.json).toMatchObject({ ok: false, error: "cobro_solo_en_main" });
			expect(cobro.viajes).toBe(1);

			expect(n.central.filter((s) => PIDE_EL_ROL.test(s))).toEqual([]);
		});
	});

	it("el rol no sale de la petición: una cabecera no convierte a una Handy en la Main", async () => {
		await conNegocioFirmado(deps, "rol-cabecera", async (n) => {
			const peticion = await peticionFirmada(deps, n, HANDY, "POST", "/v1/sync/changes", {
				cuerpo: { since: 0 },
				cabeceras: { "x-role": "tpv", "x-device-role": "tpv", "x-rol": "tpv" },
			});
			const r = await app.request(peticion, undefined, { ...env, ...n.entorno });
			expect(r.status).toBe(403);
			expect(((await r.json()) as any).error).toBe("forbidden_not_tpv");
			expect(viajes(r, "hub-ruta")).toBe(1);
		});
	});

	it("en un router que se queda en el Worker, el veto lee la fila viva de la base central", async () => {
		await conNegocioFirmado(deps, "rol-worker", async (n) => {
			// Las reservas web de la Main sólo tocan la base central y la agenda: no llevan `alHub`.
			const main = await pedirComo(deps, app, n, MAIN, "POST", "/v1/reservas-web/pendientes", {});
			expect(main.status).toBe(200);
			expect(main.viajes).toBe(0);
			expect(n.central.filter((s) => PIDE_EL_ROL.test(s))).toHaveLength(1);

			const handy = await pedirComo(deps, app, n, HANDY, "POST", "/v1/reservas-web/pendientes", {});
			expect(handy.status).toBe(403);
			expect(handy.json.error).toBe("forbidden_not_tpv");
			expect(n.central.filter((s) => PIDE_EL_ROL.test(s))).toHaveLength(2);
		});
	});
});

describe("una baja no dura en la caché más que antes", () => {
	it("la Main dada de baja deja de pasar al caducar su entrada, a los 60 s", async () => {
		await conNegocioFirmado(deps, "rol-baja", async (n) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const t0 = Date.now();

			expect((await pedirComo(deps, app, n, MAIN, "POST", "/v1/sync/changes", { since: 0 })).status).toBe(200);
			await n.enCentral(`UPDATE devices SET revoked_at_ms = ? WHERE device_id = ?;`, t0, MAIN);

			// Caducada la entrada, se vuelve a leer la fila: ni la clave ni el rol salen de la caché.
			vi.setSystemTime(t0 + 60_001);
			const despues = await pedirComo(deps, app, n, MAIN, "POST", "/v1/sync/changes", { since: 0 });
			expect(despues.status).toBe(401);
			expect(despues.json.error).toBe("device_revoked");
			expect(despues.viajes).toBe(0);
		});
	});

	it("un dispositivo dado de baja no entra en la caché: se rechaza en cada petición", async () => {
		await conNegocioFirmado(deps, "rol-baja-sin-cache", async (n) => {
			await n.enCentral(`UPDATE devices SET revoked_at_ms = ? WHERE device_id = ?;`, Date.now(), MAIN);

			for (let i = 0; i < 2; i++) {
				n.central.length = 0;
				const r = await pedirComo(deps, app, n, MAIN, "POST", "/v1/sync/changes", { since: 0 });
				expect(r.status).toBe(401);
				expect(r.json.error).toBe("device_revoked");
				expect(r.viajes).toBe(0);
				expect(n.central.some((s) => /FROM devices/.test(s))).toBe(true);
			}
		});
	});
});
