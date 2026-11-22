/** @vitest-environment jsdom */
// El formulario de datos fiscales decía siempre «Cobrar y facturar», también desde Cuentas, donde el
// cobro ya está hecho y lo que se hace es emitir o corregir la factura. Y la F3 negativa de una
// corrección salía como «Factura de la devolución», sin haber devolución.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import DatosFiscalesModal from "../../src/shared/ticket/DatosFiscalesModal";
import { etiquetaFactura } from "../../src/shared/ticket/PrintTicketModal";
import { deCentimos } from "../../src/shared/lib/dinero";
import { ToastProvider } from "../../src/shared/toast";

afterEach(() => cleanup());

function formulario(accion?: { texto: string; enCurso: string }) {
	// FISCAL-02: el formulario pide las fichas de cliente (en la Main) y puede guardarlas: va dentro
	// de los proveedores de la aplicación.
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ToastProvider>
				<DatosFiscalesModal
					open
					onClose={() => {}}
					onConfirmar={() => {}}
					importe={deCentimos(1250)}
					limite={deCentimos(40000)}
					obligatorio={false}
					accion={accion}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
}

it("en el TPV el botón cobra y factura", () => {
	formulario();
	expect(screen.getByRole("button", { name: "Cobrar y facturar" })).toBeTruthy();
});

it("desde Cuentas dice lo que hace: emitir o corregir", () => {
	formulario({ texto: "Emitir factura", enCurso: "Emitiendo…" });
	expect(screen.getByRole("button", { name: "Emitir factura" })).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Cobrar y facturar" })).toBeNull();
	cleanup();
	formulario({ texto: "Corregir factura", enCurso: "Corrigiendo…" });
	expect(screen.getByRole("button", { name: "Corregir factura" })).toBeTruthy();
});

it("la F3 negativa de una corrección no se llama «de la devolución»", () => {
	expect(
		etiquetaFactura({
			num_serie: "2026/000027",
			tipo_factura: "F3",
			importe: deCentimos(-1250),
			contrarresta: "correccion_de_datos",
		}),
	).toBe("Anulación de la factura (corrección de datos)");
	expect(
		etiquetaFactura({ num_serie: "2026/000026", tipo_factura: "F3", importe: deCentimos(1250), contrarresta: null }),
	).toBe("Factura completa (canje)");
});

// Las otras dos F3 en negativo salían también como «corrección de datos»: la que sigue a la R5 de
// la devolución de un ticket canjeado y la que saca de una F3 de varios un cobro dado de baja.
it("cada F3 negativa se llama por lo que contrarresta", () => {
	const negativa = (contrarresta: "devolucion" | "baja_por_error" | null) =>
		etiquetaFactura({ num_serie: "2026/000030", tipo_factura: "F3", importe: deCentimos(-300), contrarresta });
	expect(negativa("devolucion")).toBe("Factura de la devolución");
	expect(negativa("baja_por_error")).toBe("Anulación del ticket en la factura (cobro dado de baja por error)");
	expect(negativa(null)).toBe("Factura completa en negativo");
});
