// apps/tpv-main/test/ticketPayload.test.ts
//
// `payloadDePrecuenta` es lo único que la pantalla compone para imprimir (RI-29): la precuenta.
// Toma las líneas sueltas (una por unidad) más la personalización guardada, y arma el payload que
// Rust convierte en ESC/POS. El ticket de un cobro no pasa por aquí: lo compone Rust desde la base.
//
// Lo que se prueba aquí es la agrupación —de dónde sale el "3 x 1,10" del papel— y que la
// personalización llegue entera. Un fallo en cualquiera de las dos cosas no se ve en pantalla: se
// ve en el ticket que ya se le ha dado al cliente.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { deCentimos, deEuros, redondear } from "../src/shared/lib/dinero";

// El módulo llama a `invokeClient` en las funciones de impresora; los tests de payload no lo tocan,
// pero importar el módulo arrastra el cliente de Tauri, que en node no existe.
const invocaciones: Array<{ cmd: string; args: unknown }> = [];
vi.mock("@tpv/client", () => ({
	invokeClient: async (cmd: string, args: unknown) => {
		invocaciones.push({ cmd, args });
		return null;
	},
	toAppError: (e: unknown) => e,
	esError: () => false,
}));

const {
	payloadDePrecuenta,
	printerOpenDrawer,
	printerSetSelected,
	printerGetSelected,
} = await import("../src/features/configuracion/api/printerApis");
const { useBusinessSettings } = await import("../src/shared/stores/useBusinessSettings");
const { useTicketSettings } = await import("../src/shared/stores/useTicketSettings");

/** Una unidad suelta, como la manda el POS. */
/** Los supuestos se escriben en EUROS; lo que se compara son céntimos. */
function unidad(nombre: string, precio: number, ivaPercent?: number | null) {
	return { nombre, precio: deEuros(precio), ivaPercent };
}

/** Total del payload, que es lo que acaba imprimiéndose como TOTAL. */
function total(items: Array<{ cantidad: number; precio_unitario: number }>) {
	return items.reduce((acc, l) => acc + redondear(l.cantidad * l.precio_unitario), 0);
}

beforeEach(() => {
	invocaciones.length = 0;
	useBusinessSettings.setState({
		businessName: "Bar Pepe",
		logoDataUrl: null,
		direccion: "Calle Mayor 1",
		telefono: "600123456",
		cif: "B12345678",
		razonSocial: "Pepe Hosteleria SL",
		mensajeFooter: "Gracias",
		ivaPercent: 10,
	});
});

describe("agrupación de líneas", () => {
	it("un producto al peso viaja con un importe entero de céntimos (RI-53)", () => {
		// 12,34 € × 0,333 son 410,92 céntimos. Esta función tenía su propia copia de la agrupación y
		// no redondeaba: Rust no puede leer 410,92 como `Dinero` y el ticket no salía. Ahora agrupa
		// `agruparLineas`, la misma que la vista previa, y el papel dice lo mismo que la pantalla.
		const p = payloadDePrecuenta([{ nombre: "Jamon", precio: deCentimos(1234), cantidad: 0.333 }]);
		expect(p.items).toHaveLength(1);
		expect(p.items[0].cantidad).toBe(1);
		expect(p.items[0].precio_unitario).toBe(411);
		expect(Number.isInteger(p.items[0].precio_unitario)).toBe(true);
	});

	it("junta las unidades idénticas en una línea con su cantidad", () => {
		const p = payloadDePrecuenta([
			unidad("Cafe", 1.1),
			unidad("Cafe", 1.1),
			unidad("Cafe", 1.1),
		]);

		expect(p.items).toHaveLength(1);
		expect(p.items[0]).toMatchObject({ nombre: "Cafe", cantidad: 3, precio_unitario: 110 });
	});

	it("no junta el mismo producto vendido a precios distintos", () => {
		// Pasa de verdad: alguien cambia el precio a mitad de comanda, o se aplica un precio de
		// oferta a una unidad. Juntarlas inventaría un precio unitario que no es ninguno de los dos.
		const p = payloadDePrecuenta([unidad("Cafe", 1.1), unidad("Cafe", 1.2)]);

		expect(p.items).toHaveLength(2);
		expect(total(p.items)).toBe(230);
	});

	it("no junta el mismo producto vendido a tipos de IVA distintos", () => {
		// Dos botellas iguales, una consumida en la mesa (10 %) y otra para llevar (21 %): son dos
		// líneas porque el desglose del pie tiene que poder separarlas.
		const p = payloadDePrecuenta([unidad("Vino", 12, 10), unidad("Vino", 12, 21)]);

		expect(p.items).toHaveLength(2);
		expect(p.items.map((l) => l.iva_percent).sort()).toEqual([10, 21]);
	});

	it("trata igual el tipo ausente y el tipo nulo", () => {
		// `undefined` y `null` significan lo mismo (el tipo del negocio): si generaran claves
		// distintas, el ticket sacaría dos líneas del mismo café.
		const p = payloadDePrecuenta([unidad("Cafe", 1.1), unidad("Cafe", 1.1, null)]);

		expect(p.items).toHaveLength(1);
		expect(p.items[0].cantidad).toBe(2);
	});

	it("respeta una cantidad que ya viene contada", () => {
		// Una línea de la comanda puede venir ya contada: "2 unidades a 1,30".
		const p = payloadDePrecuenta([{ nombre: "Cafe", precio: deEuros(1.3), cantidad: 2 }]);

		expect(p.items[0]).toMatchObject({ cantidad: 2, precio_unitario: 130 });
	});

	it("suma las cantidades ya contadas de líneas iguales", () => {
		const p = payloadDePrecuenta([
			{ nombre: "Cafe", precio: deEuros(1.3), cantidad: 2 },
			{ nombre: "Cafe", precio: deEuros(1.3), cantidad: 3 },
		]);

		expect(p.items).toHaveLength(1);
		expect(p.items[0].cantidad).toBe(5);
	});

	it("una cantidad fraccionada no descuadra el total", () => {
		// El ticket cuenta unidades enteras: 0,35 kg de jamón a 60 €/kg no se puede escribir como
		// "0,35 x 60". Se pliega a una unidad de 21 €, que es lo que se cobra.
		const p = payloadDePrecuenta([{ nombre: "Jamon", precio: deEuros(60), cantidad: 0.35 }]);

		expect(p.items[0].cantidad).toBe(1);
		expect(total(p.items)).toBe(2100);
	});

	it("agrupar nunca cambia el dinero", () => {
		// La invariante: se agrupe como se agrupe, el total del payload es el de las unidades que
		// entraron. Es lo único que el cliente comprueba.
		const casos = [
			[unidad("A", 1.15), unidad("A", 1.15), unidad("B", 0.95), unidad("A", 1.15)],
			[unidad("A", 2.5, 21), unidad("A", 2.5, 10), unidad("A", 2.5, 21)],
			[unidad("C", 13.9), unidad("C", 13.9)],
			[],
		];

		for (const items of casos) {
			const esperado = items.reduce((acc, it) => acc + it.precio, 0);
			expect(total(payloadDePrecuenta(items).items)).toBe(esperado);
		}
	});

	it("un ticket sin líneas sigue siendo un payload válido", () => {
		const p = payloadDePrecuenta([]);
		expect(p.items).toEqual([]);
		expect(p.business_name).toBe("Bar Pepe");
	});
});

describe("personalización y datos del cobro", () => {
	it("arrastra los datos del negocio tal y como están guardados", () => {
		const p = payloadDePrecuenta([unidad("Cafe", 1.1)]);

		expect(p).toMatchObject({
			business_name: "Bar Pepe",
			direccion: "Calle Mayor 1",
			telefono: "600123456",
			cif: "B12345678",
			razon_social: "Pepe Hosteleria SL",
			mensaje_footer: "Gracias",
			iva_percent: 10,
		});
	});

	it("el logo viaja como ruta, no como imagen", () => {
		// Rust lo lee del disco: mandar el data URL entero por el IPC en cada ticket es tirar
		// megas por una imagen que ya está guardada.
		useBusinessSettings.setState({ logoDataUrl: "images/logo.png" });
		expect(payloadDePrecuenta([]).logo_path).toBe("images/logo.png");

		useBusinessSettings.setState({ logoDataUrl: null });
		expect(payloadDePrecuenta([]).logo_path).toBeUndefined();
	});

	it("las cinco casillas del panel llegan al payload", () => {
		// Si una se quedara por el camino, la configuración del usuario se ignoraría en silencio.
		const apagado = {
			showLogo: false,
			showBusinessName: false,
			showAddress: false,
			showPhone: false,
			showFooterMessage: false,
		};
		useTicketSettings.setState({
			settings: { ...useTicketSettings.getState().settings, ...apagado },
		});

		const p = payloadDePrecuenta([unidad("Cafe", 1.1)]);

		for (const clave of [
			"show_logo",
			"show_business_name",
			"show_address",
			"show_phone",
			"show_footer_message",
		] as const) {
			expect(p[clave], clave).toBe(false);
		}
	});

	it("la geometría del papel llega al payload", () => {
		useTicketSettings.setState({
			settings: {
				...useTicketSettings.getState().settings,
				paperWidthMm: 58,
				charsPerLine: 32,
				marginLeftMm: 2,
				marginRightMm: 3,
				paperDpi: 300,
			},
		});

		expect(payloadDePrecuenta([])).toMatchObject({
			paper_width_mm: 58,
			chars_per_line: 32,
			margin_left_mm: 2,
			margin_right_mm: 3,
			paper_dpi: 300,
		});
	});

	it("la precuenta no lleva nada fiscal", () => {
		// Sin número, Rust imprime "NO ES UN TICKET DE VENTA". La pantalla no tiene forma de poner
		// un número, un QR, una fecha o un total: eso sólo sale del cobro (RI-29).
		const p = payloadDePrecuenta([unidad("Cafe", 1.1)], "EPSON");

		// Ausentes, no vacíos: el contrato generado los declara opcionales y Rust los lee como `None`.
		expect(p.printer_name).toBe("EPSON");
		expect(p.numero_ticket).toBeUndefined();
		expect(p.fecha).toBeUndefined();
		expect(p.qr_url).toBeUndefined();
		expect(p.metodo_pago).toBeUndefined();
		expect(p.desglose).toBeUndefined();
		expect(p.total).toBeUndefined();
		expect(p.es_copia).toBe(false);
		expect(p.es_anulado).toBe(false);
	});
});

describe("comandos de impresora", () => {
	it("el destino viaja en cada selección de impresora", async () => {
		// La impresora se guarda POR destino (caja / cocina). Sin el destino, elegir la de cocina
		// pisaría la de caja y los tickets saldrían por la cocina.
		await printerSetSelected("EPSON", "cocina");
		await printerGetSelected("cocina");

		expect(invocaciones[0]).toEqual({
			cmd: "printer_set_selected",
			args: { args: { name: "EPSON", destino: "cocina" } },
		});
		expect(invocaciones[1]).toEqual({
			cmd: "printer_get_selected",
			args: { args: { destino: "cocina" } },
		});
	});

	it("sin destino se entiende la caja", async () => {
		await printerGetSelected();
		expect(invocaciones[0].args).toEqual({ args: { destino: "caja" } });
	});

	// SEC-01: quién abre el cajón es el dato por el que se pregunta cuando falta dinero, así que
	// ya no lo manda la pantalla — lo pone la sesión del backend. Que aquí no viaje ningún
	// usuario es justo lo que hay que sostener: si volviera a mandarse, la fila de auditoría
	// registraría de nuevo el nombre que le dijeran.
	it("abrir el cajón a mano no manda quién lo abre", async () => {
		await printerOpenDrawer();
		expect(invocaciones[0]).toEqual({
			cmd: "printer_open_drawer",
			args: undefined,
		});
	});
});
