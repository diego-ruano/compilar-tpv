/** @vitest-environment jsdom */
// MES-INC-04: el nombre de una reserva larga no puede bajar encima del aforo en una mesa pequeña.
// Konva parte en varias líneas un texto con ancho; cada texto de la mesa va en una sola, con «…».
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { NodoMesa, type AspectoMesa, type MesaPlano } from "@tpv/plano";

const textos = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("react-konva", () => ({
    Group: ({ children }: { children: unknown }) => children,
    Circle: () => null,
    Rect: () => null,
    Text: (props: Record<string, unknown>) => {
        textos.push(props);
        return null;
    },
}));

afterEach(() => {
    cleanup();
    textos.length = 0;
});

const aspecto: AspectoMesa = {
    relleno: "#000",
    borde: "#000",
    grosorBorde: 1,
    texto: "#fff",
    subtexto: "#fff",
    etiqueta: "Mesa 2 · Reserva Bartolomé de las Casas",
    subetiqueta: "4 pax",
    pulsable: false,
};
const mesa = (shape: string): MesaPlano => ({
    id: "m", name: "Mesa 2", x: 0, y: 0, width: 120, height: 80, radius: 30, seats: 4, shape,
});

it.each(["circle", "rect"])("en una mesa %s cada texto va en una línea y se corta si no cabe", async (forma) => {
    render(<NodoMesa mesa={mesa(forma)} aspecto={aspecto} />);
    // El primer pintado llega asíncrono (cabecera de `vitest.config.ts`).
    await waitFor(() => expect(textos).toHaveLength(2));
    for (const t of textos) {
        expect(t).toMatchObject({ wrap: "none", ellipsis: true });
        expect(t.width).toBeGreaterThan(0);
    }
});
