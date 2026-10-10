// test/clavesAusentes.test.ts
//
// Qué pasa cuando el cuerpo de una petición NO trae una clave. zod 4 rechaza una clave ausente si
// su schema no es `.optional()`, aunque acepte `undefined` (zod 3 la dejaba pasar). Esto fija las
// dos caras del contrato con los clientes ya instalados:
//
//   · Los campos que un cliente puede no mandar siguen siendo opcionales: llevan `.optional()`
//     escrito, y el schema les da el mismo valor que siempre.
//   · Un id obligatorio que no llega es un 400. Con zod 3 entraba como el texto "undefined".

import { describe, expect, it } from "vitest";

import {
	abrirComandaSchema,
	cobrarDetallesSchema,
	kitchenStateSchema,
} from "../src/domains/mesas/mesas.schemas";
import { reservaSaveSchema } from "../src/domains/reservas/reservas.schemas";
import {
	trabajadorCreateSchema,
	trabajadorUpdateSchema,
} from "../src/domains/trabajadores/trabajadores.schemas";
import {
	cobrarFraccionadoSchema,
	deleteLineaSchema,
	idsSchema,
} from "../src/domains/venta_rapida/venta_rapida.schemas";

/** El mensaje de cada problema, por ruta, para comparar sin depender del texto propio de zod. */
function problemas(r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
	expect(r.success).toBe(false);
	return Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join("."), i.message]));
}

describe("campos que un cliente puede no mandar", () => {
	it("cobrar detalles sin `tipo` es un cobro TOTAL, y sin `detalle_ids` falla por su regla", () => {
		const sinTipo = cobrarDetallesSchema.parse({ id_comanda: "c1", metodo: "efectivo", detalle_ids: ["d1"] });
		expect(sinTipo.tipo).toBe("TOTAL");
		expect(sinTipo.detalle_ids).toEqual(["d1"]);

		const sinDetalles = cobrarDetallesSchema.safeParse({ id_comanda: "c1", metodo: "efectivo" });
		expect(problemas(sinDetalles)).toEqual({ detalle_ids: "detalle_ids required" });
	});

	it("una reserva sin día ni hora conserva sus mensajes propios", () => {
		const r = reservaSaveSchema.safeParse({ comensales: 2 });
		expect(problemas(r)).toEqual({ dia_ymd: "dia_ymd invalido", hora: "hora invalida" });
	});

	it("un trabajador sin `estado` queda Activo, al crearlo y al editarlo", () => {
		const base = { id_rol: "r1", email: "a@b.es", nombre: "Ana" };
		expect(trabajadorCreateSchema.parse({ ...base, pin: "1234" }).estado).toBe("Activo");
		expect(
			trabajadorUpdateSchema.parse({ ...base, id_trabajador: "t1", id_usuario: "u1" }).estado,
		).toBe("Activo");
	});

	it("el cobro fraccionado sin `detalles` falla por su regla, y la consulta sin `ids` es una lista vacía", () => {
		const base = { id_comanda: "c1", metodo: "tarjeta", importe_total: 1250 };
		expect(problemas(cobrarFraccionadoSchema.safeParse(base))).toEqual({ detalles: "detalles required" });
		expect(cobrarFraccionadoSchema.parse({ ...base, detalles: ["d1"] }).detalles).toEqual(["d1"]);
		expect(idsSchema.parse({})).toEqual({ ids: [] });
	});
});

describe("ids obligatorios que no llegan", () => {
	it("son un error de validación, no el texto \"undefined\"", () => {
		expect(Object.keys(problemas(abrirComandaSchema.safeParse({})))).toEqual(["id_mesa"]);
		expect(Object.keys(problemas(deleteLineaSchema.safeParse({ id_detalle: "d1" })))).toEqual(["id_comanda"]);
		expect(Object.keys(problemas(kitchenStateSchema.safeParse({ id_detalle: "d1", estado: "PENDIENTE" })))).toEqual([
			"id_usuario_cocinero",
		]);
		expect(
			Object.keys(
				problemas(
					trabajadorUpdateSchema.safeParse({ id_trabajador: "t1", id_rol: "r1", email: "a@b.es", nombre: "Ana" }),
				),
			),
		).toEqual(["id_usuario"]);
	});
});
