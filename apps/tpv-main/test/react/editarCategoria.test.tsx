/** @vitest-environment jsdom */
// Una categoría se edita desde su propio modal: sale con lo que tiene, guarda con su id (el comando
// actualiza en vez de crear otra) y desde ahí se pide eliminarla.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import AddCategoryModal from "../../src/features/inventario/ui/AddCategoryModal";
import type { CategoriaDisplay } from "../../src/features/inventario/hooks/useInventario";

const datos = vi.hoisted(() => ({
    concedidos: new Set<string>(["catalogo.editar", "catalogo.borrar"]),
    crear: { mutateAsync: vi.fn(async (_args: unknown) => {}) },
    borrarImagen: vi.fn(async (_args: unknown) => "OK"),
    guardarImagen: vi.fn(async (_f: File, _c: string) => ({ nombre: "nueva.png", ruta: "categorias/nueva.png" })),
}));
vi.mock("../../src/features/inventario/inventarioQueries", () => ({ useCreateCategoria: () => datos.crear }));
vi.mock("../../src/shared/lib/usePermisos", () => ({ usePermisos: () => ({ puede: (c: string) => datos.concedidos.has(c) }) }));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock("../../src/shared/lib/imageUrl", () => ({ triggerImageUploadDrain: vi.fn() }));
vi.mock("../../src/shared/lib/guardarImagen", () => ({ guardarImagen: datos.guardarImagen }));
vi.mock("@tpv/client", () => ({
    commands: { imagesDelete: datos.borrarImagen },
    toAppError: (e: unknown) => ({ code: "internal", message: String(e) }),
}));

afterEach(() => {
    cleanup();
    datos.crear.mutateAsync.mockClear();
    datos.borrarImagen.mockClear();
    datos.guardarImagen.mockClear();
    datos.concedidos = new Set(["catalogo.editar", "catalogo.borrar"]);
});

const BEBIDAS: CategoriaDisplay = {
    ID_Categoria: "beb",
    Nombre: "Bebidas",
    Nombre_Imagen: "bebidas.png",
    Ruta_Imagen: "categorias/bebidas.png",
    Vendible: 0,
    Pasa_Cocina: 1,
    urlImagen: "blob:bebidas",
};

const editar = (extra: Partial<React.ComponentProps<typeof AddCategoryModal>> = {}) =>
    render(
        <AddCategoryModal open categoria={BEBIDAS} onClose={() => {}} onSaved={() => {}} onEliminar={() => {}} {...extra} />,
    );

it("sale con lo que tiene la categoría y guarda con su id, conservando la imagen", async () => {
    const onSaved = vi.fn();
    editar({ onSaved });

    expect(screen.getByText("Editar categoría")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Bebidas")).toBeInTheDocument();
    expect(screen.getByAltText("Imagen actual")).toHaveAttribute("src", "blob:bebidas");

    fireEvent.change(screen.getByDisplayValue("Bebidas"), { target: { value: "Refrescos" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(datos.crear.mutateAsync).toHaveBeenCalledWith({
        id_categoria: "beb",
        nombre: "Refrescos",
        nombre_imagen: "bebidas.png",
        ruta_imagen: "categorias/bebidas.png",
        vendible: false,
        pasa_cocina: true,
    });
    expect(datos.borrarImagen).not.toHaveBeenCalled();
});

it("quitar la imagen la deja sin ella y limpia la anterior", async () => {
    const onSaved = vi.fn();
    editar({ onSaved });

    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    expect(screen.queryByAltText("Imagen actual")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(datos.crear.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id_categoria: "beb", nombre_imagen: "", ruta_imagen: "" }),
    );
    expect(datos.borrarImagen).toHaveBeenCalledWith({ rel_path: "categorias/bebidas.png" });
});

it("cambiar la imagen guarda la nueva y limpia la anterior", async () => {
    const onSaved = vi.fn();
    const { container } = editar({ onSaved });

    const nueva = new File(["x"], "nueva.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [nueva] } });
    expect(screen.getByText("nueva.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(datos.guardarImagen).toHaveBeenCalledWith(nueva, "categorias");
    expect(datos.crear.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ id_categoria: "beb", nombre_imagen: "nueva.png", ruta_imagen: "categorias/nueva.png" }),
    );
    expect(datos.borrarImagen).toHaveBeenCalledWith({ rel_path: "categorias/bebidas.png" });
});

it("con una imagen que no se puede mostrar, dice que la tiene y deja quitarla", async () => {
    const onSaved = vi.fn();
    editar({ onSaved, categoria: { ...BEBIDAS, urlImagen: "" } });

    expect(screen.getByText("Imagen actual")).toBeInTheDocument();
    expect(screen.getByText("No se puede mostrar ahora")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    expect(screen.getByText("Sube una imagen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(datos.crear.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ ruta_imagen: "" }));
});

it("desde la edición se pide eliminarla, y sin permiso de borrar el botón lo dice", () => {
    const onEliminar = vi.fn();
    editar({ onEliminar });
    fireEvent.click(screen.getByRole("button", { name: "Eliminar categoría" }));
    expect(onEliminar).toHaveBeenCalled();
    cleanup();

    datos.concedidos = new Set(["catalogo.editar"]);
    editar();
    const eliminar = screen.getByRole("button", { name: "Eliminar categoría" });
    expect(eliminar).toBeDisabled();
    expect(eliminar).toHaveAttribute("title", "No tienes permiso para eliminar categorías");
});

it("quien sólo puede borrar ve la categoría sin poder cambiarla", () => {
    datos.concedidos = new Set(["catalogo.borrar"]);
    editar();
    expect(screen.getByText("No tienes permiso para editar categorías.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Bebidas")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Eliminar categoría" })).toBeEnabled();
});

it("dar de alta no manda id ni ofrece eliminar", async () => {
    const onSaved = vi.fn();
    render(<AddCategoryModal open onClose={() => {}} onSaved={onSaved} />);

    expect(screen.getByText("Añadir categoría")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Eliminar categoría" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Bebidas, Cocina/), { target: { value: "Postres" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar categoría" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(datos.crear.mutateAsync).toHaveBeenCalledWith({
        id_categoria: null,
        nombre: "Postres",
        nombre_imagen: "",
        ruta_imagen: "",
        vendible: true,
        pasa_cocina: false,
    });
});
