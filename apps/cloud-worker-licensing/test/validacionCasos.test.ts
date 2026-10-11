// test/validacionCasos.test.ts
//
// La validación de entrada del worker contra la tabla que comparte con la Main
// (`crates/tpv-domain/src/validacion_casos.json`, RI-78).
//
// El arnés de contrato compara el EFECTO de un comando y entra por debajo de la validación: llama
// a los constructores de `*.commands.ts`, no a los schemas. Lo que cada lado acepta o rechaza no lo
// miraba nadie, y habían divergido (un 31 de febrero, una caducidad «31/12/2026», un IVA del
// 210 %). Aquí la misma entrada tiene que pasar o no pasar que en Rust
// (`crates/tpv-domain/src/validacion_casos.rs`), y normalizarse al mismo valor.

import { describe, expect, it } from "vitest";
import type * as z from "zod";

import casosJson from "../../../crates/tpv-domain/src/validacion_casos.json?raw";
import { reservaSaveSchema } from "../src/domains/reservas/reservas.schemas";

type Caso = {
	nombre: string;
	cambios: Record<string, unknown>;
	acepta: boolean;
	queda?: Record<string, unknown>;
};
type Bloque = { base: Record<string, unknown>; casos: Caso[] };

const { "//": _comentario, ...tabla } = JSON.parse(casosJson) as Record<string, Bloque>;

/** El schema que valida cada dominio de la tabla. */
const SCHEMAS: Record<string, z.ZodType> = {
	reserva: reservaSaveSchema,
};

describe("la validación del worker cuadra con la tabla compartida", () => {
	it("no hay ningún dominio de la tabla sin schema", () => {
		// Un dominio nuevo en el JSON que no se cablee aquí se quedaría sin comprobar en silencio.
		expect(Object.keys(tabla).filter((d) => !(d in SCHEMAS))).toEqual([]);
	});

	for (const [dominio, bloque] of Object.entries(tabla)) {
		const schema = SCHEMAS[dominio];
		if (!schema) continue;

		it.each(bloque.casos)(`${dominio} · $nombre`, (caso) => {
			const r = schema.safeParse({ ...bloque.base, ...caso.cambios });
			expect(r.success, JSON.stringify(r.error?.issues)).toBe(caso.acepta);
			if (r.success && caso.queda) {
				expect(r.data).toMatchObject(caso.queda);
			}
		});
	}
});
