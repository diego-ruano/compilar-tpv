// test/horaDeLaHandy.test.ts
//
// MES-INC-03 · La Handy manda su hora con su desfase, y el TenantHub la pasa a la hora del negocio
// antes de ejecutar la ruta. Antes la mandaba sin él y valía como la del negocio: un Android en GMT
// en un bar de Madrid iba una hora por detrás en todo lo que escribía y leía (la reserva próxima no
// salía en el plano, «hoy» cambiaba a las once de la noche).

import { describe, expect, it } from "vitest";

import { instanteDeClientNow } from "../src/durableObjects/tenantHub.tiempo";
import { enElHub } from "./helpers/hub";

describe("instanteDeClientNow", () => {
	it("lee el instante de una hora con desfase", () => {
		expect(instanteDeClientNow("2026-11-16 20:58:17+00:00")).toBe(Date.UTC(2026, 10, 16, 20, 58, 17));
		expect(instanteDeClientNow("2026-11-16 21:58:17+01:00")).toBe(Date.UTC(2026, 10, 16, 20, 58, 17));
		expect(instanteDeClientNow("2026-11-16 17:28:17-03:30")).toBe(Date.UTC(2026, 10, 16, 20, 58, 17));
	});

	it("sin desfase, o con uno que no es una hora, no hay nada que pasar", () => {
		for (const raw of [
			"2026-11-16 20:58:17", // la de la Main y la de una Handy de antes
			"2026-11-16T20:58:17+00:00",
			"2026-11-16 20:58:17Z",
			"2026-11-16 24:30:00+00:00",
			"2026-02-30 10:00:00+01:00",
			"",
			null,
			undefined,
		]) {
			expect(instanteDeClientNow(raw), String(raw)).toBeNull();
		}
	});
});

describe("el TenantHub pasa la hora de la Handy a la del negocio", () => {
	const pedir = (clientNow: string, cuerpo?: string) =>
		new Request("https://tpv-api.test/v1/mesas/meta", {
			method: cuerpo === undefined ? "GET" : "POST",
			headers: { "x-client-now": clientNow, ...(cuerpo === undefined ? {} : { "content-type": "application/json" }) },
			...(cuerpo === undefined ? {} : { body: cuerpo }),
		});

	it.each([
		["Europe/Madrid", "2026-01-15 11:00:00+00:00", "2026-01-15 12:00:00"],
		["Europe/Madrid", "2026-07-15 23:30:00+00:00", "2026-07-16 01:30:00"],
		["Atlantic/Canary", "2026-01-15 12:00:00+01:00", "2026-01-15 11:00:00"],
	])("negocio en %s, Handy con %s → %s", async (zona, handy, negocio) => {
		const tenantId = `hora-handy-${zona}-${handy}`;
		await enElHub(tenantId, async (hub: any) => {
			await hub.aprovisionar(tenantId);
			hub.state.storage.sql.exec("UPDATE Business_Settings SET Zona_Horaria = ? WHERE ID = 1;", zona);
			const peticion = await hub.conLaHoraDelNegocio(pedir(handy, '{"dato":"á"}'), tenantId);
			expect(peticion.headers.get("x-client-now")).toBe(negocio);
			// Lo demás de la petición, intacto.
			expect(peticion.method).toBe("POST");
			expect(peticion.headers.get("content-type")).toBe("application/json");
			expect(await peticion.text()).toBe('{"dato":"á"}');
		});
	});

	it("una hora sin desfase (la Main, una Handy de antes) pasa tal cual", async () => {
		await enElHub("hora-handy-sin-desfase", async (hub: any) => {
			await hub.aprovisionar("hora-handy-sin-desfase");
			const original = pedir("2026-01-15 11:00:00");
			expect(await hub.conLaHoraDelNegocio(original, "hora-handy-sin-desfase")).toBe(original);
		});
	});

	it("sin base todavía, la zona de por defecto", async () => {
		await enElHub("hora-handy-sin-base", async (hub: any) => {
			const peticion = await hub.conLaHoraDelNegocio(pedir("2026-01-15 11:00:00+00:00"), "hora-handy-sin-base");
			expect(peticion.headers.get("x-client-now")).toBe("2026-01-15 12:00:00");
		});
	});
});
