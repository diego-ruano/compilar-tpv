import { describe, expect, it } from "vitest";
import { zMetodoPago, zEstadoCocina } from "../src/lib/pago";
import { updatePagoSchema } from "../src/domains/cuentas/cuentas.schemas";
import { cobrarFraccionadoSchema } from "../src/domains/venta_rapida/venta_rapida.schemas";
import { cobrarDetallesSchema, kitchenStateSchema } from "../src/domains/mesas/mesas.schemas";

describe("RI-48: valores de dominio cerrados", () => {
    it("rechaza metodos desconocidos en las tres entradas de cobro", () => {
        for (const metodo of ["bizum", "Otro", "", "card", null]) {
            expect(zMetodoPago.safeParse(metodo).success).toBe(false);
            expect(updatePagoSchema.safeParse({ fecha_hora: "2030-01-01", metodo, importe: 100 }).success).toBe(false);
            expect(cobrarFraccionadoSchema.safeParse({ id_comanda: "com", metodo, importe_total: 100, detalles: ["d"] }).success).toBe(false);
            expect(cobrarDetallesSchema.safeParse({ id_comanda: "com", metodo, tipo: "COBRO", detalle_ids: ["d"] }).success).toBe(false);
        }
        expect(zMetodoPago.parse(" TARJETA ")).toBe("Tarjeta");
        expect(zMetodoPago.parse(" efectivo ")).toBe("Efectivo");
    });
    it("la cocina admite sus estados conocidos y rechaza errores de entrada", () => {
        expect(zEstadoCocina.parse(" preparado ")).toBe("PREPARADO");
        for (const estado of ["servido", "cocinando", "", null]) {
            expect(kitchenStateSchema.safeParse({ id_detalle: "d", id_usuario_cocinero: "u", estado }).success).toBe(false);
        }
    });
});
