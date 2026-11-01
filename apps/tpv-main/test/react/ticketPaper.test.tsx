/** @vitest-environment jsdom */
// INC-20261031-026: con pocas columnas (58 mm, escala 2) la vista previa partía el importe y el «€»
// saltaba de línea. El papel medía sus columnas con el relleno dentro (Tailwind pone `border-box` a
// todo), el hueco entre nombre e importe era de 8 px en vez de un carácter y el importe se podía
// partir. jsdom no mide, pero sí puede comprobar esas tres cosas.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import TicketPaper from "../../src/shared/ticket/TicketPaper";
import { payloadDePrecuenta } from "../../src/features/configuracion/api/printerApis";
import { deEuros } from "../../src/shared/lib/dinero";

vi.mock("@tpv/client", () => ({ commands: { printerTicketCols: async () => 16 } }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ resolveImageUrl: async () => "" }));

afterEach(() => cleanup());

it("el papel mide sus columnas sin el relleno y el importe no se parte", async () => {
    const payload = payloadDePrecuenta([{ nombre: "Tostada", precio: deEuros(2.4), iva_percent: 10 }]);
    render(<TicketPaper payload={payload} />);
    const importe = (await screen.findAllByText("2,40 €")).find((e) => e.tagName === "STRONG")!;
    await waitFor(() => expect(importe.closest("div[style*='16ch']")).not.toBeNull());

    const papel = importe.closest<HTMLElement>("div[style*='16ch']")!;
    expect(papel.style.boxSizing).toBe("content-box");
    const fila = importe.parentElement!.parentElement!;
    expect(fila.style.gap).toBe("1ch");
    expect(importe.parentElement!.style.whiteSpace).toBe("nowrap");
});

// OBS-20261031-022: un ticket anulado por ERROR cuyas líneas se retiraron después de la mesa se queda
// sin ellas (lo borra el esquema) pero con su total. La copia dice por qué, en vez de «No hay
// productos» junto a un total que no cuadra.
it("la copia de un ticket anulado sin líneas explica por qué no las tiene", async () => {
    const vacio = payloadDePrecuenta([]);
    const { rerender } = render(<TicketPaper payload={{ ...vacio, es_anulado: true }} />);
    expect(await screen.findByText("Las líneas de este ticket se retiraron de la mesa después de anularlo.")).toBeInTheDocument();
    rerender(<TicketPaper payload={vacio} />);
    expect(screen.getByText("No hay productos en el ticket.")).toBeInTheDocument();
});
