import { expect, it, vi } from "vitest";
import { vrBootstrap, vrCreateComandaBarra } from "../src/features/ventaRapida/ventaRapidaAPI";

const comandos = vi.hoisted(() => ({
    vrCreateComandaBarra: vi.fn(async () => "comanda"),
    vrListCategoriasVendibles: vi.fn(async () => []),
    vrGetLineasComanda: vi.fn(async () => []),
}));
vi.mock("@tpv/client", () => ({ commands: comandos }));

it("al entrar en venta rápida se retoma el ticket abierto, y sólo «Nuevo ticket» estrena otro", async () => {
    await vrBootstrap("trabajador");
    expect(comandos.vrCreateComandaBarra).toHaveBeenLastCalledWith({ id_trabajador: "trabajador", get_or_create: true });
    expect(comandos.vrGetLineasComanda).toHaveBeenLastCalledWith({ id_comanda: "comanda" });

    await vrCreateComandaBarra("trabajador");
    expect(comandos.vrCreateComandaBarra).toHaveBeenLastCalledWith({ id_trabajador: "trabajador", get_or_create: false });
});
