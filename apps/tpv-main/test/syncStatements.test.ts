import { describe, it, expect } from "vitest";
import { featureKeysPorTablas, ajustesPorTablas, shouldReloadTicket, type ComandaSyncInfo } from "../src/shared/lib/syncStatements";

describe("metadatos nativos y cachés de presentación", () => {
    it("deduplica las áreas y distingue ajustes de tablas desconocidas", () => {
        expect(featureKeysPorTablas(["pagos", "productos"])).toEqual(["cuentas", "stats", "inventario", "proveedores"]);
        expect(featureKeysPorTablas(["business_settings"])).toEqual([]);
        expect(featureKeysPorTablas(["tabla_nueva"])).toBeNull();
        expect(featureKeysPorTablas(null)).toBeNull();
    });
    it("una reserva que cambia en otro sitio refresca también el plano de mesas y los clientes", () => {
        // Una reserva web recogida o cancelada, una de la Handy o el «No vino» automático: el plano
        // pinta la de cada mesa y el resumen de Clientes cuenta las pendientes.
        expect(featureKeysPorTablas(["reservas"])).toEqual(["reservas", "mesas", "clientes", "stats"]);
    });
    it("vincular un producto o mover su stock refresca la ficha del proveedor", () => {
        // INC-20261030-013: vincular es un UPDATE de Productos, y la lista de vinculados enseña el
        // stock y la última entrada, que salen de los lotes.
        expect(featureKeysPorTablas(["productos"])).toContain("proveedores");
        expect(featureKeysPorTablas(["lotes_producto"])).toContain("proveedores");
    });
    it("los tres ajustes y un cambio sin clasificación obligan a releer stores", () => {
        for (const tabla of ["business_settings", "ticket_settings", "contact_settings"]) expect(ajustesPorTablas([tabla])).toBe(true);
        expect(ajustesPorTablas(null)).toBe(true); expect(ajustesPorTablas(["pagos"])).toBe(false);
    });
});

describe("shouldReloadTicket · si hay que recargar el ticket abierto", () => {
	const info = (parcial: Partial<ComandaSyncInfo>) => ({
		ids: [],
		touchedComanda: false,
		uncertain: false,
		touchedCatalog: false,
		...parcial,
	});

	it("recarga si el lote toca la comanda abierta", () => {
		expect(shouldReloadTicket(info({ ids: ["com-1"], touchedComanda: true }), "com-1")).toBe(true);
	});

	it("no recarga si toca la comanda de otro dispositivo", () => {
		expect(shouldReloadTicket(info({ ids: ["com-2"], touchedComanda: true }), "com-1")).toBe(false);
	});

	it("ante la duda, recarga", () => {
		expect(shouldReloadTicket(info({ touchedComanda: true, uncertain: true }), "com-1")).toBe(true);
	});

	it("sin ticket abierto no hay nada que recargar", () => {
		expect(shouldReloadTicket(info({ ids: ["com-1"], touchedComanda: true }), null)).toBe(false);
	});
});
