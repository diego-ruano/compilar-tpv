/** @vitest-environment jsdom */
// El formulario de datos fiscales decía siempre «Cobrar y facturar», también desde Cuentas, donde el
// cobro ya está hecho y lo que se hace es emitir o corregir la factura. Y la F3 negativa de una
// corrección salía como «Factura de la devolución», sin haber devolución.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import DatosFiscalesModal from "../../src/shared/ticket/DatosFiscalesModal";
import { etiquetaFactura } from "../../src/shared/ticket/PrintTicketModal";
import { deCentimos } from "../../src/shared/lib/dinero";

afterEach(() => cleanup());

function formulario(accion?: { texto: string; enCurso: string }) {
	render(
		<DatosFiscalesModal
			open
			onClose={() => {}}
			onConfirmar={() => {}}
			importe={deCentimos(1250)}
			limite={deCentimos(40000)}
			obligatorio={false}
			accion={accion}
		/>,
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
	expect(etiquetaFactura({ num_serie: "2026/000027", tipo_factura: "F3", importe: deCentimos(-1250) })).toBe(
		"Anulación de la factura (corrección de datos)",
	);
	expect(etiquetaFactura({ num_serie: "2026/000026", tipo_factura: "F3", importe: deCentimos(1250) })).toBe(
		"Factura completa (canje)",
	);
});
