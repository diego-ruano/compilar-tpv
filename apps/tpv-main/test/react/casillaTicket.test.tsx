/** @vitest-environment jsdom */
// DOC-INC-01: al elegir varios tickets para una factura, uno que no se puede facturar sale con la
// casilla desactivada y el motivo, en vez de dejarlo marcar y rechazarlo al emitir.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import CasillaTicket from "../../src/features/cuentas/CasillaTicket";

afterEach(() => cleanup());

it("un ticket ya facturado no se deja marcar y dice por qué", () => {
	const alternar = vi.fn();
	render(<CasillaTicket marcada={false} motivo="Ya facturado: 2026/000026" onClick={alternar} />);

	expect(screen.getByText("Ya facturado: 2026/000026")).toBeTruthy();
	const casilla = screen.getByRole("button", { name: /No se puede añadir a la factura/ });
	expect(casilla).toBeDisabled();
	fireEvent.click(casilla);
	expect(alternar).not.toHaveBeenCalled();
});

it("uno que se puede facturar se marca", () => {
	const alternar = vi.fn();
	render(<CasillaTicket marcada={false} motivo={null} onClick={alternar} />);

	fireEvent.click(screen.getByRole("button", { name: "Añadir a la factura" }));
	expect(alternar).toHaveBeenCalledTimes(1);
});
