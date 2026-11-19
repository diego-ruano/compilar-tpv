/** @vitest-environment jsdom */
// Borrar una categoría avisa de cuántos productos se lleva y sólo la borra al confirmar.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import BorrarCategoriaModal from "../../src/features/inventario/ui/BorrarCategoriaModal";

const borrar = vi.hoisted(() => ({ mutateAsync: vi.fn(async (_id: string) => {}), isPending: false }));
vi.mock("../../src/features/inventario/inventarioQueries", () => ({ useBorrarCategoria: () => borrar }));

afterEach(() => { cleanup(); borrar.mutateAsync.mockClear(); });

const BAR = { ID_Categoria: "bar", Nombre: "Bar" };

it("dice cuántos productos se eliminan con ella y la borra al confirmar", async () => {
    const onBorrada = vi.fn();
    render(<BorrarCategoriaModal categoria={BAR} numProductos={3} onClose={() => {}} onBorrada={onBorrada} />);

    expect(screen.getByText("¿Seguro que quieres eliminar «Bar»?")).toBeInTheDocument();
    expect(screen.getByText(/Tiene 3 productos y se eliminarán también\./)).toBeInTheDocument();
    expect(borrar.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(onBorrada).toHaveBeenCalled());
    expect(borrar.mutateAsync).toHaveBeenCalledWith("bar");
});

it("una categoría vacía no habla de productos, y cancelar no borra nada", () => {
    const onClose = vi.fn();
    render(<BorrarCategoriaModal categoria={BAR} numProductos={0} onClose={onClose} onBorrada={() => {}} />);

    expect(screen.queryByText(/productos?/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(onClose).toHaveBeenCalled();
    expect(borrar.mutateAsync).not.toHaveBeenCalled();
});
