/** @vitest-environment jsdom */
// SYNC-36: cambios hechos desde las Handy que este TPV lleva una semana sin poder aplicar (un cambio
// en cuarentena que no sale o, SYNC-38, filas que había que traer de la nube y no entran).
// Conectividad lo explica y ofrece traer el estado actual de la
// nube, sólo si es seguro (nada de este TPV por subir) y con confirmación; al traerlo se cierra la
// sesión y sigue la pantalla de recuperación. Corre el panel de verdad; sólo se sustituye el IPC.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { SyncHealth } from "@tpv/contracts";
import { SaludSync } from "../../src/features/configuracion/sections/Conectividad";
import { useAuth } from "../../src/shared/stores/useAuth";
import { useEstadoSync } from "../../src/shared/stores/useEstadoSync";
import { ToastProvider } from "../../src/shared/toast";

const backend = vi.hoisted(() => ({ salud: null as unknown, llamadas: [] as string[] }));
vi.mock("@tauri-apps/api/core", async (original) => ({
    ...(await original<object>()),
    invoke: async (comando: string) => {
        backend.llamadas.push(comando);
        if (comando === "sync_health") return backend.salud;
        if (comando === "sync_bootstrap_desde_nube") {
            return { seq: 10, filas_restauradas: 5, tablas_restauradas: [], tablas_desconocidas: [] };
        }
        return null;
    },
}));

const SANA: SyncHealth = {
    outbox_pending: 0,
    last_seq: 40,
    quarantined: 1,
    failing: 0,
    subida_fallando: 0,
    subida_en_cuarentena: 0,
    bajada_atascada: 1,
};

const authInicial = useAuth.getState();
const syncInicial = useEstadoSync.getState();
afterEach(() => {
    cleanup();
    backend.llamadas = [];
    useAuth.setState(authInicial, true);
    useEstadoSync.setState(syncInicial, true);
});

function pintar(salud: SyncHealth) {
    backend.salud = salud;
    useAuth.setState({ role: "Administrador", idUsuario: "u1" });
    render(
        <ToastProvider>
            <SaludSync darkMode={false} />
        </ToastProvider>,
    );
}

it("con nada por subir, lo explica y trae la nube tras confirmar: la sesión se cierra y sigue la recuperación", async () => {
    pintar(SANA);

    expect(await screen.findByText("Hay cambios hechos desde las Handy que este TPV no ha podido aplicar")).toBeTruthy();
    expect(screen.getByText(/las comprobaciones diarias con la nube no lo pueden arreglar/)).toBeTruthy();

    // Primero se pide confirmación, diciendo lo que pasa mientras tanto.
    screen.getByRole("button", { name: "Recuperar el estado actual de la nube" }).click();
    expect(await screen.findByText(/no se podrá vender en este TPV ni en las Handy/)).toBeTruthy();
    expect(backend.llamadas).not.toContain("sync_bootstrap_desde_nube");

    screen.getByRole("button", { name: "Sí, recuperar ahora" }).click();
    await vi.waitFor(() => expect(useAuth.getState().role).toBe(""));
    expect(backend.llamadas).toContain("sync_bootstrap_desde_nube");
    expect(backend.llamadas).toContain("logout");
    expect(useEstadoSync.getState().reconciliacionPendiente).toBe(true);
});

it("con algo por subir no lo ofrece: dice que espere a que se sincronice", async () => {
    pintar({ ...SANA, outbox_pending: 3 });

    expect(await screen.findByText(/Antes tiene que subir a la nube lo que este TPV tiene pendiente \(3\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Recuperar el estado actual de la nube" })).toBeNull();
});

it("con cambios de este TPV que la nube rechazó no lo ofrece: se perderían", async () => {
    pintar({ ...SANA, subida_en_cuarentena: 2 });

    expect(await screen.findByText(/2 cambio\(s\) que la nube no ha aceptado/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Recuperar el estado actual de la nube" })).toBeNull();
});

it("sin nada atascado no aparece", async () => {
    pintar({ ...SANA, bajada_atascada: 0 });

    expect(await screen.findByText("Pendientes de subir")).toBeTruthy();
    expect(screen.queryByText("Hay cambios hechos desde las Handy que este TPV no ha podido aplicar")).toBeNull();
});

it("lo apartado de la bajada dice lo que hace la comprobación con la nube, sin prometer que se arregla solo", async () => {
    // SYN-INC-07: decía que «normalmente se arreglan solos», y un correo repetido o una columna que
    // esta versión no tiene se quedaban para siempre. Ahora dice qué intenta y qué se queda.
    pintar({ ...SANA, bajada_atascada: 0 });

    const aviso = await screen.findByText(/cambio\(s\) de la nube que no se pudieron aplicar/);
    expect(aviso.textContent).toMatch(/intenta\s+traerlos tal como están en la nube/);
    expect(aviso.textContent).toMatch(/mismo correo/);
    expect(aviso.textContent).toMatch(/se queda\s+apartado/);
    expect(aviso.textContent).not.toMatch(/se arreglan solos/);
});
