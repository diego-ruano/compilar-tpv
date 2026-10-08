/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import ReabrirCierreModal from "../../src/features/cuentas/ReabrirCierreModal";

vi.mock("../../src/shared/lib/conAviso", () => ({ conAviso: (fn: unknown) => fn }));

it("espera la confirmación, impide repetirla y permite reintentar un fallo", async () => {
    let rechazar!: (error: unknown) => void;
    const confirmar = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { rechazar = reject; }));
    const cancelar = vi.fn();
    render(<ReabrirCierreModal onConfirmar={confirmar} onCancelar={cancelar} />);
    expect(confirmar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reabrir cierre" }));
    const esperando = screen.getByRole("button", { name: "Reabriendo…" });
    expect(esperando).toBeDisabled();
    fireEvent.click(esperando);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(cancelar).not.toHaveBeenCalled();
    rechazar({ code: "conflict", message: "El cierre ha cambiado" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("El cierre ha cambiado"));
    expect(screen.getByRole("button", { name: "Reabrir cierre" })).toBeEnabled();
});
