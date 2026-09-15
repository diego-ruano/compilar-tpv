// test/scrub.test.ts
//
// OBS-01 — el filtro de datos personales de los errores que el worker manda a Sentry.
//
// Antes no había ninguno: `sendDefaultPii: false` quita cabeceras, cookies e IP, pero el mensaje de
// una excepción de una ruta de licencias o de trabajadores salía tal cual, con el correo o el DNI que
// llevara dentro.
//
// Los casos vienen de `crates/tpv-telemetry/src/scrub_casos.json`, la tabla que comparten las tres
// copias del filtro (ésta, Rust y la Webview): si una cambia de criterio, falla el test de las otras.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-telemetry/src/scrub_casos.json?raw";
import { scrub } from "../src/observability/scrub";
import { sentryOptions } from "../src/observability/sentry";
import type { Env } from "../src/env";

const casos = JSON.parse(casosJson) as { redacta: [string, string][]; no_toca: string[] };

describe("scrub, con la tabla que comparten las tres copias", () => {
	it.each(casos.redacta)("«%s» → «%s»", (entrada, salida) => {
		expect(scrub(entrada)).toBe(salida);
	});

	it.each(casos.no_toca)("«%s» sale tal cual", (texto) => {
		expect(scrub(texto)).toBe(texto);
	});
});

describe("las opciones de Sentry del worker filtran antes de enviar", () => {
	const beforeSend = sentryOptions({} as Env).beforeSend;

	it("un error de una ruta sale sin los datos personales que llevaba", () => {
		const evento = beforeSend({
			event_id: "9d2f3a1b7c4e4f0a8b6d5c3e2f1a0b9c",
			exception: { values: [{ type: "Error", value: "no se pudo enviar el código a ana@example.com" }] },
			breadcrumbs: [{ category: "console", message: "trabajador 12.345.678-Z", data: { iban: "ES91 2100 0418 4502 0005 1332" } }],
			extra: { destino: "ana@example.com" },
			request: {
				url: "https://tpv-api.altarialights.workers.dev/v1/login/recuperar-pin?correo=ana@example.com",
				query_string: "correo=ana@example.com",
			},
		});

		const todo = JSON.stringify(evento);
		for (const dato of ["ana@example.com", "12.345.678-Z", "ES91 2100 0418 4502 0005 1332"]) {
			expect(todo, dato).not.toContain(dato);
		}
		expect(evento?.event_id).toBe("9d2f3a1b7c4e4f0a8b6d5c3e2f1a0b9c");
		expect(evento?.exception.values[0].value).toBe("no se pudo enviar el código a [email]");
	});

	it("si el filtro no puede con el evento, no se envía: es más seguro que enviarlo sin filtrar", () => {
		const roto = {
			get message(): string {
				throw new Error("getter roto");
			},
		};
		expect(beforeSend(roto)).toBeNull();
	});
});
