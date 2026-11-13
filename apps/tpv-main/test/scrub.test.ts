// apps/tpv-main/test/scrub.test.ts
//
// El filtro de datos personales de la Webview (OBS-01). Lo que se prueba es lo único que importa de
// él: que un error que llega a Sentry no lleve el DNI, el IBAN, el número de la Seguridad Social, el
// teléfono o el correo de nadie, escritos como se escriben de verdad —con puntos, espacios, en
// minúsculas—, y que a cambio no destroce lo que hace falta para diagnosticar.
//
// Los casos vienen de `crates/tpv-telemetry/src/scrub_casos.json`, la tabla que comparten las tres
// copias del filtro (ésta, Rust y el worker). Antes de este test la copia de la Webview no tenía
// ninguno y dejaba pasar, por ejemplo, un IBAN con espacios como `ES[num]005 1332`.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-telemetry/src/scrub_casos.json?raw";
import fuenteDelWorker from "../../cloud-worker-licensing/src/observability/scrub.ts?raw";
import fuenteDeLaWebview from "../src/shared/observability/scrub.ts?raw";
import { scrub, scrubDeep, scrubEvent } from "../src/shared/observability/scrub";

const casos = JSON.parse(casosJson) as { redacta: [string, string][]; no_toca: string[]; objetos: [unknown, unknown][] };

describe("la copia de la Webview y la del worker", () => {
	// AUD-32: el coste del filtro se mide en la copia del worker (`test/scrubCoste.test.ts`), que
	// es la que recibe texto de fuera. Vale para ésta porque es el mismo código.
	it("son el mismo código por debajo de la cabecera", () => {
		const cuerpo = (fuente: string) => {
			const inicio = fuente.indexOf("\ntype Regla = ");
			expect(inicio).toBeGreaterThan(0);
			return fuente.slice(inicio).replace(/\r\n/g, "\n");
		};
		expect(cuerpo(fuenteDeLaWebview).length).toBeGreaterThan(5000);
		expect(cuerpo(fuenteDeLaWebview)).toBe(cuerpo(fuenteDelWorker));
	});
});

describe("scrub, con la tabla que comparten las tres copias", () => {
	it.each(casos.objetos)("filtra un objeto conservando timestamps e identificadores", (entrada, salida) => {
		const value: unknown = structuredClone(entrada);
		scrubDeep(value);
		expect(value).toEqual(salida);
		scrubDeep(value);
		expect(value).toEqual(salida);
	});

	it.each(casos.redacta)("«%s» → «%s»", (entrada, salida) => {
		expect(scrub(entrada)).toBe(salida);
	});

	it.each(casos.no_toca)("«%s» sale tal cual", (texto) => {
		expect(scrub(texto)).toBe(texto);
	});

	it("aplicarlo dos veces da lo mismo: un marcador no vuelve a disparar ninguna regla", () => {
		for (const [entrada] of casos.redacta) {
			const una = scrub(entrada);
			let siguiente = una;
			for (let i = 0; i < 3; i++) {
				siguiente = scrub(siguiente);
				expect(siguiente, entrada).toBe(una);
			}
		}
	});

	it("un mensaje con varios datos los quita todos, estén donde estén", () => {
		const dentro = casos.redacta.map(([entrada]) => entrada).join(" | ");
		const fuera = scrub(dentro);
		for (const [entrada, salida] of casos.redacta) {
			if (entrada !== salida) expect(fuera).not.toContain(entrada);
		}
	});
});

describe("scrubEvent: todo lo que la app puede escribir en un evento", () => {
	const DATOS = [
		"ana@example.com",
		"12.345.678-Z",
		"x1234567l",
		"ES91 2100 0418 4502 0005 1332",
		"28/12345678/40",
		"612 345 678",
		"hunter2",
	];

	function eventoConDatos() {
		return {
			event_id: "9d2f3a1b7c4e4f0a8b6d5c3e2f1a0b9c",
			release: "tpv@0.1.0",
			level: "error",
			timestamp: 1_758_000_000,
			message: "no se pudo avisar a ana@example.com",
			logentry: { message: "trabajador %s con DNI %s", params: ["12.345.678-Z", { iban: "ES91 2100 0418 4502 0005 1332" }] },
			exception: { values: [{ type: "AppError", value: "NIE x1234567l duplicado" }] },
			breadcrumbs: [
				{ category: "ui.click", message: "botón Guardar" },
				// La consola entera acaba en los breadcrumbs, con sus argumentos tal cual.
				{
					category: "console",
					message: "guardando trabajador",
					data: { logger: "console", arguments: ["NSS", { nss: "28/12345678/40", tel: ["612 345 678"] }] },
				},
			],
			extra: { fase: "guardar_trabajador", destino: { correo: "ana@example.com" }, intentos: 3 },
			tags: { fase: "trabajadores", clave: "password=hunter2" },
			request: { url: "tauri://localhost/trabajadores?correo=ana@example.com", query_string: "correo=ana@example.com" },
		};
	}

	it("no deja ninguno de los datos personales en ningún sitio del evento", () => {
		const evento = scrubEvent(eventoConDatos());
		const todo = JSON.stringify(evento);
		for (const dato of DATOS) {
			expect(todo, dato).not.toContain(dato);
		}
	});

	it("conserva lo que hace falta para diagnosticar", () => {
		const evento = scrubEvent(eventoConDatos());
		expect(evento.event_id).toBe("9d2f3a1b7c4e4f0a8b6d5c3e2f1a0b9c");
		expect(evento.release).toBe("tpv@0.1.0");
		expect(evento.timestamp).toBe(1_758_000_000);
		expect(evento.exception.values[0].type).toBe("AppError");
		expect(evento.exception.values[0].value).toBe("NIE [id] duplicado");
		expect(evento.breadcrumbs[0].message).toBe("botón Guardar");
		expect(evento.extra.fase).toBe("guardar_trabajador");
		expect(evento.extra.intentos).toBe(3);
		expect(evento.tags.fase).toBe("trabajadores");
		expect(evento.logentry.message).toBe("trabajador %s con DNI %s");
	});

	it("un evento sin nada de eso no revienta", () => {
		expect(scrubEvent({})).toEqual({});
		expect(scrubEvent({ breadcrumbs: [{}], exception: { values: [{}] }, request: {} })).toEqual({
			breadcrumbs: [{}],
			exception: { values: [{}] },
			request: {},
		});
	});
});
