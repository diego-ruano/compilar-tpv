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

import casosJson from "../../../crates/tpv-domain/src/validacion_casos.json?raw";
import { negocioPatchSchema } from "../src/domains/configuracion/configuracion.schemas";
import {
	createLoteSchema,
	updateLoteSchema,
	upsertProductoSchema,
} from "../src/domains/inventario/inventario.schemas";
import { reservaSaveSchema } from "../src/domains/reservas/reservas.schemas";
import { setReservaEstadoSchema } from "../src/domains/mesas/mesas.schemas";
import { altaReservaWebSchema } from "../src/domains/reservas_web/reservasWeb.schemas";
import {
	asignacionCreateSchema,
	copySemanaSchema,
	fechaLunesSchema,
} from "../src/domains/trabajadores/trabajadores.schemas";

type Entrada = Record<string, unknown>;
type Caso = {
	nombre: string;
	cambios: Entrada;
	acepta: boolean;
	queda?: Entrada;
};
type Bloque = { base: Entrada; casos: Caso[] };
type Resultado = { success: boolean; data?: unknown; error?: { issues: unknown[] } };

const { "//": _comentario, ...tabla } = JSON.parse(casosJson) as Record<string, Bloque>;

/**
 * Lo que valida cada dominio de la tabla: el schema que lleva su ruta en `cuerpo(...)`, con la
 * entrada colocada como llega por la API. Devuelve lo validado con la forma de la entrada.
 */
const VALIDADORES: Record<string, (entrada: Entrada) => Resultado> = {
	reserva: (e) => reservaSaveSchema.safeParse(e),
	lote: (e) => createLoteSchema.safeParse(e),
	lote_edicion: (e) => updateLoteSchema.safeParse(e),
	producto: (e) => upsertProductoSchema.safeParse(e),
	horario_alta: (e) => asignacionCreateSchema.safeParse(e),
	horario_copia: (e) => copySemanaSchema.safeParse(e),
	horario_semana: (e) => fechaLunesSchema.safeParse(e),
	reserva_web: (e) => altaReservaWebSchema.safeParse(e),
	reserva_estado_mesa: (e) => setReservaEstadoSchema.safeParse(e),
	negocio: (e) => {
		const r = negocioPatchSchema.safeParse({ patch: e });
		return r.success ? { success: true, data: r.data.patch } : r;
	},
};

describe("la validación del worker cuadra con la tabla compartida", () => {
	it("no hay ningún dominio de la tabla sin validador", () => {
		// Un dominio nuevo en el JSON que no se cablee aquí se quedaría sin comprobar en silencio.
		expect(Object.keys(tabla).filter((d) => !(d in VALIDADORES))).toEqual([]);
	});

	for (const [dominio, bloque] of Object.entries(tabla)) {
		const validar = VALIDADORES[dominio];
		if (!validar) continue;

		it.each(bloque.casos)(`${dominio} · $nombre`, (caso) => {
			const r = validar({ ...bloque.base, ...caso.cambios });
			expect(r.success, JSON.stringify(r.error?.issues)).toBe(caso.acepta);
			if (r.success && caso.queda) {
				expect(r.data).toMatchObject(caso.queda);
			}
		});
	}
});
