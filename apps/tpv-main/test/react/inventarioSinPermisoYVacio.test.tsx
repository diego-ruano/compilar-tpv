/** @vitest-environment jsdom */
// INV-MEJ-01: sin permiso, «Nueva categoría» y «Nuevo producto» estaban desactivados pero se veían
// igual que activos y no decían por qué; y en un móvil la tabla de caducidades vacía obligaba a
// desplazarse de lado para leer que no había nada.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import InventoryHeader from "../../src/features/inventario/ui/InventoryHeader";
import SummarySection from "../../src/features/inventario/ui/SummarySection";

const permisos = vi.hoisted(() => ({ concedidos: new Set<string>() }));
vi.mock("../../src/shared/lib/usePermisos", () => ({
    usePermisos: () => ({ puede: (c: string) => permisos.concedidos.has(c) }),
}));

afterEach(() => { cleanup(); permisos.concedidos.clear(); });

const cabecera = (categoria: unknown) => (
    <InventoryHeader titulo="Inventario" categoriaSeleccionada={categoria} onBack={() => {}}
        onNewCategory={() => {}} onNewProduct={() => {}} onIngredientes={() => {}} onEditCategory={() => {}} />
);

it("sin permiso, el botón desactivado dice por qué al pasar por encima", () => {
    render(cabecera(null));
    const nueva = screen.getByRole("button", { name: "Nueva categoría" });
    expect(nueva).toBeDisabled();
    expect(nueva).toHaveAttribute("title", "No tienes permiso para crear categorías");
    cleanup();

    permisos.concedidos.add("catalogo.editar"); // sin precios no se puede dar de alta un producto
    render(cabecera({ ID_Categoria: "beb" }));
    expect(screen.getByRole("button", { name: "Nuevo producto" })).toHaveAttribute("title", "No tienes permiso para crear productos");
    // Con permiso de editar (aunque no de borrar) se entra a editar la categoría.
    expect(screen.getByRole("button", { name: "Editar categoría" })).toBeEnabled();
    cleanup();

    permisos.concedidos.clear();
    render(cabecera({ ID_Categoria: "beb" }));
    const editar = screen.getByRole("button", { name: "Editar categoría" });
    expect(editar).toBeDisabled();
    expect(editar).toHaveAttribute("title", "No tienes permiso para editar categorías");
});

it("quien sólo puede borrar también entra a la edición, que es donde se elimina", () => {
    permisos.concedidos.add("catalogo.borrar");
    render(cabecera({ ID_Categoria: "beb" }));
    expect(screen.getByRole("button", { name: "Editar categoría" })).toBeEnabled();
});

it("con permiso, no lleva el aviso", () => {
    permisos.concedidos.add("catalogo.editar");
    render(cabecera(null));
    expect(screen.getByRole("button", { name: "Nueva categoría" })).not.toHaveAttribute("title");
});

it("una lista vacía enseña su mensaje sin la tabla", () => {
    render(<SummarySection proximosCaducar={[]} menosCantidad={[]} />);
    expect(screen.getByText("No hay productos con caducidad.")).toBeInTheDocument();
    expect(screen.queryByText("Caducidad")).not.toBeInTheDocument();
});
