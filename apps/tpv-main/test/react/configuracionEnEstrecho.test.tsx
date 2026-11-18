/** @vitest-environment jsdom */
// CFG-INC-03: en Android «Guardar cambios» de Configuración quedaba fuera de la pantalla. En
// estrecho, el contenido lleva encima el selector de secciones (`md:hidden`) y debajo el scroll;
// la sección no era columna flex y el scroll medía `h-full`, el 100 % más el selector, así que el
// `overflow-hidden` de fuera recortaba el final. jsdom no maqueta: se comprueba la estructura que lo
// evita, que es lo que se rompió.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../src/features/configuracion/api/configApis", () => ({
    configGetBusinessSettings: vi.fn(() => new Promise(() => {})), configPatchBusinessSettings: vi.fn(),
    configGetTicketSettings: vi.fn(() => new Promise(() => {})), configPatchTicketSettings: vi.fn(),
    configGetContactSettings: vi.fn(() => new Promise(() => {})), configPatchContactSettings: vi.fn(),
}));
vi.mock("../../src/shared/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const { default: Configuracion } = await import("../../src/app/pages/Configuracion");

afterEach(cleanup);

it("el contenido es una columna y el scroll ocupa lo que deja el selector de secciones", async () => {
    render(
        <MemoryRouter>
            <Configuracion />
        </MemoryRouter>,
    );
    const contenido = await screen.findByTestId("cfg-contenido");
    const scroll = screen.getByTestId("cfg-scroll");

    expect(contenido.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-0"]));
    // El selector móvil y el scroll son hermanos dentro de la columna.
    expect(scroll.parentElement).toBe(contenido);
    const clases = scroll.className.split(/\s+/);
    expect(clases).toEqual(expect.arrayContaining(["flex-1", "min-h-0", "overflow-auto"]));
    expect(clases).not.toContain("h-full");
});
