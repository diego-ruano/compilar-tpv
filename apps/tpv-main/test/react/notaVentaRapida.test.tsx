/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import TicketPanel from "../../src/features/ventaRapida/ui/TicketPanel";
import { deCentimos } from "../../src/shared/lib/dinero";

vi.mock("../../src/shared/ticket/PrintTicketModal", () => ({ default: () => null }));
vi.mock("../../src/shared/lib/conAviso", () => ({ conAviso: (fn: unknown) => fn }));

it("permite guardar una nota en una línea identificada por UUID", async () => {
    const detalleId = "019ad935-7409-75e9-a716-124382cc9b76";
    const guardar = vi.fn().mockResolvedValue(undefined);
    const nada = () => {};
    render(<TicketPanel
        ticket={[{ id: detalleId, detalleId, productoId: "cafe", nombre: "Café", precio: deCentimos(300), pagado: false, seleccionado: false }]}
        paso="productos" totalPendiente={deCentimos(300)} totalSeleccionado={deCentimos(0)} haySeleccion={false}
        onCobrarTodo={nada} onCobrarFraccionado={nada} onToggleSeleccion={nada} onEliminarLinea={nada}
        onCobrarTarjeta={nada} onStartEfectivo={nada} onCancelarCobro={nada}
        quiereFactura={false} onQuiereFacturaChange={nada} onGuardarNota={guardar}
    />);
    const nota = await screen.findByTitle("Añadir/editar nota");
    expect(nota).toBeEnabled();
    fireEvent.click(nota);
    const campo = await screen.findByRole("textbox");
    fireEvent.change(campo, { target: { value: "Sin azúcar" } });
    await waitFor(() => expect(campo).toHaveValue("Sin azúcar"));
    fireEvent.click(screen.getByRole("button", { name: "Guardar nota" }));
    await waitFor(() => expect(guardar).toHaveBeenCalledWith(detalleId, "Sin azúcar"));
});
