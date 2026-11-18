/** @vitest-environment jsdom */
// INI-06: en Android, al desplazar la lista del selector inicial saltaba «Activa tu TPV». Un click
// que llega al final de un gesto que ha desplazado algo, o cuyo dedo se ha movido, no elige el
// modo; un toque quieto, un click de ratón o el teclado, sí.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import SelectorModo from "../../src/app/arranque/SelectorModo";

afterEach(cleanup);

async function pintar() {
    const onElegir = vi.fn(async () => {});
    render(<SelectorModo logoSrc="" business_name="Bar" ocupado={false} error={null} handyVinculada={false} onElegir={onElegir} />);
    const tpv = await screen.findByRole("button", { name: /Configurar como TPV/ });
    return { onElegir, tpv };
}

it("arrastrar la lista por encima de la tarjeta no la elige", async () => {
    const { onElegir, tpv } = await pintar();
    fireEvent.pointerDown(tpv, { clientX: 100, clientY: 400 });
    fireEvent.scroll(window);
    fireEvent.click(tpv, { detail: 1, clientX: 100, clientY: 400 });
    expect(onElegir).not.toHaveBeenCalled();
});

it("un dedo que se ha movido tampoco", async () => {
    const { onElegir, tpv } = await pintar();
    fireEvent.pointerDown(tpv, { clientX: 100, clientY: 400 });
    fireEvent.click(tpv, { detail: 1, clientX: 100, clientY: 260 });
    expect(onElegir).not.toHaveBeenCalled();
});

it("ni un gesto que el navegador se ha quedado para desplazar", async () => {
    const { onElegir, tpv } = await pintar();
    fireEvent.pointerDown(tpv, { clientX: 100, clientY: 400 });
    fireEvent.pointerCancel(tpv);
    fireEvent.click(tpv, { detail: 1, clientX: 100, clientY: 400 });
    expect(onElegir).not.toHaveBeenCalled();
});

it("un toque quieto elige, y el teclado también", async () => {
    const { onElegir, tpv } = await pintar();
    fireEvent.pointerDown(tpv, { clientX: 100, clientY: 400 });
    fireEvent.click(tpv, { detail: 1, clientX: 104, clientY: 403 });
    expect(onElegir).toHaveBeenLastCalledWith("tpv");

    const handy = screen.getByRole("button", { name: /Configurar como Handy/ });
    fireEvent.click(handy, { detail: 0 });
    expect(onElegir).toHaveBeenLastCalledWith("handy");
    expect(onElegir).toHaveBeenCalledTimes(2);
});
