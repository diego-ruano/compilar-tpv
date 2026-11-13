import { describe, it, expect } from "vitest";
import { featureKeysPorTablas, ajustesPorTablas, shouldReloadTicket, tablasConArea, type ComandaSyncInfo } from "../src/shared/lib/syncStatements";
// La foto del esquema, la misma que vigila `schema_snapshot` en Rust: de ahí salen las tablas.
import esquema from "../../../packages/database/schema.snapshot.sql?raw";

/**
 * Lo que hay en el esquema y no es del negocio: el andamiaje de la réplica en la nube (el mismo
 * `TABLAS_DE_ANDAMIAJE` del worker, `domains/sync/bootstrap.ventana.ts`). Nunca viaja en un aviso
 * de cambio. Lo que empieza por `_` es estado local del equipo y tampoco se replica.
 */
const ANDAMIAJE = new Set(["sync_changes", "applied_operations", "sync_main_checkpoints"]);

const tablasDelEsquema = [...esquema.matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1].toLowerCase());
const tablasDeNegocio = tablasDelEsquema.filter((t) => !t.startsWith("_") && !ANDAMIAJE.has(t));

describe("toda tabla de negocio dice qué pantallas la enseñan", () => {
    it("la foto del esquema se lee: están las tablas de siempre", () => {
        expect(tablasDeNegocio.length).toBeGreaterThan(40);
        for (const tabla of ["pagos", "movimientos_caja", "registros_facturacion", "reserva_web_mesas"]) {
            expect(tablasDeNegocio).toContain(tabla);
        }
    });
    it("ninguna tabla de negocio obliga a releerlo todo", () => {
        // Una tabla sin entrada devuelve `null`, y eso es `invalidateQueries()` de todo en todos los
        // equipos: en una Handy, un viaje al Durable Object por cada consulta abierta. Si esto
        // falla es que el esquema tiene una tabla nueva: dale su entrada en `TABLE_TO_FEATURES`
        // con las pantallas que la enseñan (o `[]` y por qué ninguna).
        const sinEntrada = tablasDeNegocio.filter((t) => featureKeysPorTablas([t]) === null);
        expect(sinEntrada).toEqual([]);
    });
    it("no queda ninguna entrada de una tabla que ya no existe", () => {
        expect(tablasConArea().filter((t) => !tablasDeNegocio.includes(t))).toEqual([]);
    });
    it("un cobro refresca lo que cambia, no todo", () => {
        // Lo que escribe un cobro con su stock, su apunte de caja y su registro de facturación.
        const cobro = [
            "comandas", "pagos", "pago_detalles", "lotes_producto", "lote_consumos", "productos",
            "suelto_consumos", "movimientos_caja", "serie_facturacion", "registros_facturacion",
        ];
        const areas = featureKeysPorTablas(cobro);
        expect(areas).not.toBeNull();
        expect([...areas!].sort()).toEqual(["cuentas", "inventario", "mesas", "proveedores", "stats"]);
        expect(ajustesPorTablas(cobro)).toEqual([]);
    });
    it("un cobro parcial, una baja o una devolución refrescan el plano aunque no toquen la comanda", () => {
        // El plano enseña lo que queda por cobrar de cada mesa, que sale de las líneas cobradas. Estos
        // lotes no llevan `comandas`: quien tiene que traer `mesas` es `pagos`.
        const cobroParcial = ["pagos", "pago_detalles", "lotes_producto", "lote_consumos", "movimientos_caja", "serie_facturacion", "registros_facturacion"];
        const devolucion = ["pagos", "devolucion_lineas", "lotes_producto", "movimientos_caja", "serie_facturacion", "registros_facturacion"];
        const baja = ["pagos", "lotes_producto", "lote_consumos", "movimientos_caja", "registros_facturacion"];
        for (const lote of [cobroParcial, devolucion, baja]) {
            const areas = featureKeysPorTablas(lote);
            expect(areas).toContain("mesas");
            expect(areas).toContain("cuentas");
            expect(areas).toContain("stats");
        }
        expect(featureKeysPorTablas(["pago_detalles"])).toContain("mesas");
    });
    it("la caja, el stock y las reservas web refrescan su pantalla; lo fiscal, ninguna", () => {
        for (const tabla of ["movimientos_caja", "aperturas_cajon", "cierres_caja", "cierre_denominaciones", "cierre_rectificaciones"]) {
            expect(featureKeysPorTablas([tabla])).toEqual(["cuentas"]);
        }
        for (const tabla of ["movimientos_stock", "suelto_consumos"]) expect(featureKeysPorTablas([tabla])).toEqual(["inventario"]);
        for (const tabla of ["reserva_web_mesas", "reserva_web_franjas", "reserva_web_cierres"]) {
            expect(featureKeysPorTablas([tabla])).toEqual(["reservas"]);
        }
        for (const tabla of ["registros_facturacion", "serie_facturacion", "intentos_login"]) expect(featureKeysPorTablas([tabla])).toEqual([]);
    });
    it("el nombre de la tabla llega como lo escribió el SQL, y un nombre raro no es una entrada", () => {
        expect(featureKeysPorTablas(["Movimientos_Caja"])).toEqual(["cuentas"]);
        expect(featureKeysPorTablas(["constructor"])).toBeNull();
    });
});

describe("metadatos nativos y cachés de presentación", () => {
    it("deduplica las áreas y distingue ajustes de tablas desconocidas", () => {
        expect(featureKeysPorTablas(["pagos", "productos"])).toEqual(["cuentas", "stats", "mesas", "inventario", "proveedores"]);
        expect(featureKeysPorTablas(["pagos", "pago_detalles", "cuentas_gastos"])).toEqual(["cuentas", "stats", "mesas"]);
        expect(featureKeysPorTablas(["ticket_settings"])).toEqual([]);
        expect(featureKeysPorTablas(["tabla_nueva"])).toBeNull();
        expect(featureKeysPorTablas(null)).toBeNull();
    });
    it("una reserva que cambia en otro sitio refresca también el plano de mesas y los clientes", () => {
        // Una reserva web recogida o cancelada, una de la Handy o el «No vino» automático: el plano
        // pinta la de cada mesa y el resumen de Clientes cuenta las pendientes.
        expect(featureKeysPorTablas(["reservas"])).toEqual(["reservas", "mesas", "clientes", "cuentas", "stats"]);
    });
    it("una tabla refresca también las pantallas que la enseñan a través de otra", () => {
        // El nombre de una mesa o de una zona: Reservas, la última reserva de cada cliente, cada
        // cobro de Cuentas, las estadísticas.
        expect(featureKeysPorTablas(["mesas"])).toEqual(["mesas", "reservas", "clientes", "cuentas", "stats"]);
        expect(featureKeysPorTablas(["zonas"])).toEqual(["mesas", "reservas", "stats"]);
        // El nombre de un cliente: la reserva de cada mesa del plano y sus cobros.
        for (const area of ["mesas", "cuentas"]) expect(featureKeysPorTablas(["clientes"])).toContain(area);
        // Las estadísticas de trabajadores: tareas hechas, cuadrante, fichajes y rol.
        for (const tabla of ["tarea_asignaciones", "asignacion_turnos", "fichajes", "roles", "usuarios"]) {
            expect(featureKeysPorTablas([tabla])).toContain("stats");
        }
        // El nombre de un usuario y su rol.
        for (const area of ["tareas", "cuentas", "notificaciones"]) expect(featureKeysPorTablas(["usuarios"])).toContain(area);
        // Lo que hay pendiente en cocina depende de `Pasa_Cocina`, y Proveedores lista las categorías.
        expect(featureKeysPorTablas(["categorias_producto"])).toEqual(["inventario", "proveedores", "mesas", "stats"]);
        expect(featureKeysPorTablas(["productos"])).toContain("mesas");
        // La reserva de cada mesa del plano depende de la duración por defecto y de la zona horaria.
        expect(featureKeysPorTablas(["business_settings"])).toEqual(["mesas"]);
    });
    it("añadir líneas a una comanda no hace releer Cuentas", () => {
        // A sabiendas: la mesa y el cliente de un cobro se fijan al cobrar, con su `pagos`.
        for (const tabla of ["comandas", "detalle_comanda"]) expect(featureKeysPorTablas([tabla])).toEqual(["mesas", "stats"]);
    });
    it("vincular un producto o mover su stock refresca la ficha del proveedor", () => {
        // INC-20261030-013: vincular es un UPDATE de Productos, y la lista de vinculados enseña el
        // stock y la última entrada, que salen de los lotes.
        expect(featureKeysPorTablas(["productos"])).toContain("proveedores");
        expect(featureKeysPorTablas(["lotes_producto"])).toContain("proveedores");
    });
    it("cada tabla de ajustes relee sólo su store, y un cambio sin clasificación los tres", () => {
        for (const tabla of ["business_settings", "ticket_settings", "contact_settings"]) expect(ajustesPorTablas([tabla])).toEqual([tabla]);
        expect(ajustesPorTablas(["Contact_Settings", "pagos"])).toEqual(["contact_settings"]);
        expect(ajustesPorTablas(["ticket_settings", "business_settings", "ticket_settings"])).toEqual(["business_settings", "ticket_settings"]);
        expect(ajustesPorTablas(null)).toEqual(["business_settings", "ticket_settings", "contact_settings"]);
        expect(ajustesPorTablas(["pagos"])).toEqual([]);
        // Una tabla sin entrada obliga a releer las consultas, pero no dice nada de los ajustes.
        expect(ajustesPorTablas(["tabla_nueva"])).toEqual([]);
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
