/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { ConfiguracionPermisos } from "@tpv/contracts";
import { Permisos } from "../../src/features/configuracion/sections/Permisos";
import { queryClient } from "../../src/shared/lib/queryClient";
const { invoke } = vi.hoisted(() => ({ invoke:vi.fn() }));
vi.mock("@tpv/client", () => ({invokeClient:invoke,toAppError:(e: Error) => e}));
const matriz: ConfiguracionPermisos = {
    catalogo:[{codigo:"catalogo.editar",nombre:"Editar catálogo",grupo:"Inventario"}],
    roles:[{id_rol:"admin",nombre:"Administrador",permisos:[]},{id_rol:"encargado",nombre:"Encargado",permisos:["catalogo.editar"]}],
};
beforeEach(() => { queryClient.clear(); invoke.mockReset(); invoke.mockImplementation(async (comando: string) => comando === "permisos_configuracion" ? matriz : undefined); });
it("conserva la base de una edición aunque la matriz se refresque mientras se edita", async () => {
    render(<QueryClientProvider client={queryClient}><Permisos /></QueryClientProvider>);
    const casilla = await screen.findByRole("checkbox", {name:"Editar catálogo"});
    expect(screen.queryByRole("option", {name:"Administrador"})).toBeNull();
    fireEvent.click(casilla);
    await waitFor(() => expect(casilla).not.toBeChecked());
    queryClient.setQueryData(["permisos","configuracion"], { ...matriz,roles:[{id_rol:"encargado",nombre:"Encargado",permisos:["catalogo.editar","stock.recibir"]}] });
    fireEvent.click(screen.getByRole("button", {name:"Guardar permisos"}));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("permisos_guardar", {args:{id_rol:"encargado",permisos_vistos:["catalogo.editar"],permisos:[]}}));
    await screen.findByRole("status");
});
