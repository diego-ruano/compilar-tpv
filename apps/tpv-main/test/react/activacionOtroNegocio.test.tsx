/** @vitest-environment jsdom */
// AUD-06: activar una licencia cuya base no es la que había (de otro negocio, o de antes de un
// traslado) no puede dejar la aplicación abierta con la sesión de antes: la pantalla retira la del
// webview y lo que tenga en caché, que se leyó de esa base. Con la de otro negocio, avisa del reinicio.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ActivacionLicencia, { AVISO_DE_REINICIO } from "../../src/app/arranque/ActivacionLicencia";
import { useAuth } from "../../src/shared/stores/useAuth";
import { queryClient } from "../../src/shared/lib/queryClient";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const SESION = {
    role: "Administrador",
    idUsuario: "u1",
    nombre: "Ana",
    idTrabajador: null,
    requiresSetup: false,
    email: null,
};

beforeEach(() => {
    invoke.mockReset();
    useAuth.setState({ ...SESION });
    queryClient.setQueryData(["clientes"], [{ id: "de-la-base-de-antes" }]);
});
afterEach(cleanup);

async function rellenarYActivar(cambioDeEquipo: boolean, reinicia: boolean) {
    invoke.mockImplementation(async (comando: string) =>
        comando === "license_activate"
            ? { outcome: "activated", state: null, email_hint: null, cambio_de_equipo: cambioDeEquipo, tiempo_sumado: false, reinicia }
            : null,
    );
    const onActivada = vi.fn(async () => {});
    render(
        <ActivacionLicencia rechazoPrevio={null} volviendo={false} errorAlVolver={null} onVolver={async () => {}} onActivada={onActivada} />,
    );
    for (const [campo, valor] of [
        ["activation-license-key", "TPV-AAAAA-BBBBB-CCCCC-DDDDD"],
        ["activation-legal-name", "Bar de Pruebas S.L."],
        ["activation-business-name", "Bar de Pruebas"],
        ["activation-phone", "+34 600 000 000"],
        ["activation-country", "España"],
    ]) {
        fireEvent.change(document.getElementById(campo)!, { target: { value: valor } });
    }
    fireEvent.submit(document.querySelector("form")!);
    return onActivada;
}

async function activar(cambioDeEquipo: boolean) {
    const onActivada = await rellenarYActivar(cambioDeEquipo, false);
    await waitFor(() => expect(onActivada).toHaveBeenCalled());
}

it("si la base deja de ser la que había, se retira la sesión de la pantalla y su caché", async () => {
    await activar(true);

    expect(useAuth.getState().role).toBe("");
    expect(useAuth.getState().idUsuario).toBeNull();
    expect(queryClient.getQueryData(["clientes"])).toBeUndefined();
});

it("si es la misma base (la misma licencia que vuelve), la sesión sigue", async () => {
    await activar(false);

    expect(useAuth.getState().role).toBe("Administrador");
    expect(screen.queryByText(/no se ha podido/i)).toBeNull();
});

it("con la licencia de otro negocio avisa de que el TPV se reinicia y no sigue con los datos de ahora", async () => {
    const onActivada = await rellenarYActivar(true, true);

    expect(await screen.findByText(AVISO_DE_REINICIO)).toBeInTheDocument();
    expect(onActivada).not.toHaveBeenCalled();
    expect(useAuth.getState().role).toBe("");
    expect(queryClient.getQueryData(["clientes"])).toBeUndefined();
});
