// test/validacionCasos.test.ts
//
// La validación de entrada del worker contra la tabla que comparte con la Main
// (`crates/tpv-domain/src/validacion_casos.json`, RI-78).
//
// El arnés de contrato compara el EFECTO de un comando y entra por debajo de la validación: llama
// a los constructores de `*.commands.ts`, no a los schemas. Lo que cada lado acepta o rechaza no lo
// miraba nadie, y habían divergido (un 31 de febrero, una caducidad «31/12/2026», un IVA del
// 210 %). Aquí la misma entrada tiene que pasar o no pasar que en Rust
// (`crates/tpv-domain/src/validacion_casos.rs`), normalizarse al mismo valor y, si se rechaza,
// decirle lo mismo a quien está delante (VALID-03): el `message` de la respuesta, que sale de
// `validarConMensaje`, igual que en la ruta.

import { describe, expect, it } from "vitest";

import casosJson from "../../../crates/tpv-domain/src/validacion_casos.json?raw";
import { negocioPatchSchema } from "../src/domains/configuracion/configuracion.schemas";
import {
	createLoteSchema,
	guardarCategoriaIngredienteSchema,
	guardarIngredienteSchema,
	updateLoteSchema,
	upsertProductoSchema,
} from "../src/domains/inventario/inventario.schemas";
import { reservaSaveSchema } from "../src/domains/reservas/reservas.schemas";
import { validarConMensaje } from "../src/lib/validacion";
import {
	cambiosIngredientesSchema,
	saveLayoutSchema,
	setReservaEstadoSchema,
} from "../src/domains/mesas/mesas.schemas";
import { altaReservaWebSchema } from "../src/domains/reservas_web/reservasWeb.schemas";
import {
	asignacionCreateSchema,
	copySemanaSchema,
	fechaLunesSchema,
	trabajadorCreateSchema,
	trabajadorUpdateSchema,
} from "../src/domains/trabajadores/trabajadores.schemas";
import {
	pedidoActualizarSchema,
	pedidoCrearSchema,
	pedidoEstadoSchema,
} from "../src/domains/pedidos_proveedor/pedidos_proveedor.schemas";

type Entrada = Record<string, unknown>;
type Caso = {
	nombre: string;
	cambios: Entrada;
	acepta: boolean;
	queda?: Entrada;
	mensaje?: string;
};
type Bloque = { base: Entrada; casos: Caso[] };
type Resultado = { success: boolean; data?: unknown; error?: { issues: unknown[] }; mensaje?: string };

const { "//": _comentario, ...tabla } = JSON.parse(casosJson) as Record<string, Bloque>;

/**
 * Lo que valida cada dominio de la tabla: el schema que lleva su ruta en `cuerpo(...)`, con la
 * entrada colocada como llega por la API. Devuelve lo validado con la forma de la entrada.
 */
const VALIDADORES: Record<string, (entrada: Entrada) => Promise<Resultado>> = {
	reserva: (e) => validarConMensaje(reservaSaveSchema, e),
	lote: (e) => validarConMensaje(createLoteSchema, e),
	lote_edicion: (e) => validarConMensaje(updateLoteSchema, e),
	producto: (e) => validarConMensaje(upsertProductoSchema, e),
	horario_alta: (e) => validarConMensaje(asignacionCreateSchema, e),
	horario_copia: (e) => validarConMensaje(copySemanaSchema, e),
	horario_semana: (e) => validarConMensaje(fechaLunesSchema, e),
	reserva_web: (e) => validarConMensaje(altaReservaWebSchema, e),
	reserva_estado_mesa: (e) => validarConMensaje(setReservaEstadoSchema, e),
	plano: (e) => validarConMensaje(saveLayoutSchema, e),
	categoria_ingrediente: (e) => validarConMensaje(guardarCategoriaIngredienteSchema, e),
	ingrediente: (e) => validarConMensaje(guardarIngredienteSchema, e),
	cambios_ingredientes: (e) => validarConMensaje(cambiosIngredientesSchema, e),
	// Crear y editar validan lo mismo; al editar, el id va en el camino (`PUT /:id`).
	pedido: async (e) => {
		const alta: Resultado = await validarConMensaje(pedidoCrearSchema, e);
		const { id_pedido: _id, ...sinId } = e;
		const edicion: Resultado = await validarConMensaje(pedidoActualizarSchema, sinId);
		if (alta.mensaje !== "Falta el pedido.") {
			expect({ success: edicion.success, mensaje: edicion.mensaje }).toEqual({
				success: alta.success,
				mensaje: alta.mensaje,
			});
		}
		return alta;
	},
	pedido_estado: (e) => validarConMensaje(pedidoEstadoSchema, e),
	// El alta y la edición validan las fechas del contrato igual: tienen que decir lo mismo.
	trabajador: async (e) => {
		const alta: Resultado = await validarConMensaje(trabajadorCreateSchema, e);
		const edicion: Resultado = await validarConMensaje(trabajadorUpdateSchema, {
			...e,
			id_trabajador: "t1",
			id_usuario: "u1",
			pin: null,
		});
		expect({ success: edicion.success, mensaje: edicion.mensaje }).toEqual({
			success: alta.success,
			mensaje: alta.mensaje,
		});
		return alta;
	},
	negocio: async (e) => {
		const r = await validarConMensaje(negocioPatchSchema, { patch: e });
		return r.success ? { success: true, data: (r.data as { patch: unknown }).patch } : r;
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

		it.each(bloque.casos)(`${dominio} · $nombre`, async (caso) => {
			const r = await validar({ ...bloque.base, ...caso.cambios });
			expect(r.success, JSON.stringify(r.error?.issues)).toBe(caso.acepta);
			if (r.success && caso.queda) {
				expect(r.data).toMatchObject(caso.queda);
			}
			if (!r.success) {
				expect(caso.mensaje, "un rechazo sin «mensaje»").toBeTruthy();
				expect(r.mensaje).toBe(caso.mensaje);
			}
		});
	}
});
