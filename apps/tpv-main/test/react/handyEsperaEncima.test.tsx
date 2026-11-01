/** @vitest-environment jsdom */
// INC-20261030-014: quedarse sin Main bloqueaba el Handy sustituyendo la aplicación entera por la
// pantalla de espera. Al volver la Main, cada página empezaba de cero y se perdía lo que se estaba
// editando. Una vez ha trabajado con ese vínculo, la espera se pone encima y lo de debajo se queda.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import AppBoot from "../../src/app/AppBoot";
import { useMainPresence } from "../../src/shared/stores/useMainPresence";
import { useMode } from "../../src/shared/stores/useMode";

vi.mock("@tpv/client", () => ({ commands: { logout: async () => {} } }));
vi.mock("../../src/shared/lib/useHandySocket", () => ({ useHandySocket: () => {} }));
vi.mock("../../src/shared/lib/useMainSocket", () => ({ useMainSocket: () => {} }));
vi.mock("../../src/shared/lib/useImageUrl", () => ({ useImageUrl: () => "" }));
vi.mock("../../src/shared/ui/UpdateBanner", () => ({ default: () => null }));
vi.mock("../../src/app/layoutComponent/Titlebar", () => ({ default: () => null }));
vi.mock("../../src/shared/stores/useEstadoSync", () => ({
    useEstadoSync: (sel: (s: unknown) => unknown) => sel({ hidratar: async () => {}, reintentar: () => {} }),
}));
vi.mock("../../src/app/arranque/useLicencia", () => ({
    useLicencia: () => ({ lic: null, gate: "loading", refrescarLicencia: async () => {}, refrescarGate: async () => {} }),
}));
vi.mock("../../src/app/arranque/useModoDispositivo", () => ({
    useModoDispositivo: () => ({ ocupado: false, error: null, elegir: () => {}, volverAlSelector: () => {} }),
}));
vi.mock("../../src/app/arranque/useEmparejamientoHandy", () => ({
    useEmparejamientoHandy: () => ({ estado: { step: "paired" }, volverAVincular: () => {} }),
}));

/** Una página con un borrador sin guardar, como la ficha de un producto a medio editar. */
function Ficha() {
    const [nombre, setNombre] = useState("");
    return <input aria-label="Nombre del producto" value={nombre} onChange={(e) => setNombre(e.target.value)} />;
}

afterEach(() => cleanup());

function presencia(mainOnline: boolean | null, generacion = 1) {
    act(() => useMainPresence.setState({ mainOnline, volcando: false, rechazo: null, generacion }));
}

it("al quedarse sin Main, el borrador sigue ahí cuando vuelve", async () => {
    useMode.setState({ mode: "handy" });
    presencia(true);
    render(<AppBoot router={createMemoryRouter([{ path: "/", element: <Ficha /> }])} />);
    fireEvent.change(await screen.findByLabelText("Nombre del producto"), { target: { value: "Croquetas" } });

    presencia(false);
    expect(await screen.findByText("La Main no está activa")).toBeInTheDocument();
    presencia(true);
    await waitFor(() => expect(screen.queryByText("La Main no está activa")).not.toBeInTheDocument());

    expect(screen.getByLabelText("Nombre del producto")).toHaveValue("Croquetas");
});

it("con la espera encima, lo de debajo no se puede tocar", async () => {
    useMode.setState({ mode: "handy" });
    presencia(true);
    render(<AppBoot router={createMemoryRouter([{ path: "/", element: <Ficha /> }])} />);
    const campo = await screen.findByLabelText("Nombre del producto");
    presencia(false);
    await screen.findByText("La Main no está activa");
    expect(campo.closest("[inert]")).not.toBeNull();
});

it("un vínculo nuevo empieza sin nada que conservar: la espera es la pantalla entera", async () => {
    useMode.setState({ mode: "handy" });
    presencia(true, 1);
    render(<AppBoot router={createMemoryRouter([{ path: "/", element: <Ficha /> }])} />);
    await screen.findByLabelText("Nombre del producto");
    presencia(null, 2);
    expect(await screen.findByText("Conectando con la Main…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre del producto")).not.toBeInTheDocument();
});
