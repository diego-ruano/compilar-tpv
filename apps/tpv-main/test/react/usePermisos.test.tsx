/** @vitest-environment jsdom */
// PERM-CACHE: los permisos de la sesión no se releen por reloj (era una petición cada 30 s, y en la
// Handy un viaje a la nube cada vez). Se releen cuando pueden haber cambiado: al invalidar
// `["permisos"]` (lo que hace un cambio de `usuarios`, `roles` o `roles_permisos` que llega de otro
// equipo, y la pantalla de permisos al guardar) y al volver a la aplicación.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { queryClient } from "../../src/shared/lib/queryClient";
import { featureKeysPorTablas } from "../../src/shared/lib/syncStatements";
import { usePermisos } from "../../src/shared/lib/usePermisos";
import { useAuth } from "../../src/shared/stores/useAuth";

/** Lo que contesta el backend ahora mismo. */
let permisos: string[] = [];

function Menu() {
    const p = usePermisos();
    if (p.isPending) return <p>cargando</p>;
    return <p>{p.puede("stock.ajustar") ? "puede ajustar existencias" : "no puede ajustar existencias"}</p>;
}

const pintar = () => render(<QueryClientProvider client={queryClient}><Menu /></QueryClientProvider>);
const lecturas = () => invoke.mock.calls.filter(([comando]) => comando === "permisos_sesion").length;
/** El `refetchInterval` que tiene ahora la consulta de los permisos de `u-1`. */
function intervalo(): number | false | undefined {
    const consulta = queryClient.getQueryCache().find({ queryKey: ["permisos", "sesion", "u-1"] });
    const opcion = consulta?.observers[0]?.options.refetchInterval;
    return typeof opcion === "function" ? opcion(consulta as never) : (opcion ?? false);
}

beforeEach(() => {
    queryClient.clear();
    invoke.mockReset();
    invoke.mockImplementation(async (comando: string) =>
        comando === "permisos_sesion" ? { rol: "Encargado", permisos } : undefined,
    );
    permisos = ["stock.ajustar"];
    useAuth.setState({ idUsuario: "u-1", role: "Encargado" });
});

afterEach(() => {
    cleanup();
    focusManager.setFocused(undefined);
    useAuth.setState({ idUsuario: null, role: "" });
});

it("no se releen por reloj", async () => {
    pintar();
    await screen.findByText("puede ajustar existencias");

    const consulta = queryClient.getQueryCache().find({ queryKey: ["permisos", "sesion", "u-1"] });
    expect(consulta?.observers).toHaveLength(1);
    expect(intervalo()).toBe(false);
    expect(lecturas()).toBe(1);
});

it("si una relectura falla, se sigue con los últimos leídos y se reintenta sola", async () => {
    pintar();
    await screen.findByText("puede ajustar existencias");

    // Se va la red (en Android, al volver a primer plano): la relectura falla.
    invoke.mockImplementation(async (comando: string) => {
        if (comando === "permisos_sesion") throw { code: "external", message: "Sin conexión" };
        return undefined;
    });
    await queryClient.invalidateQueries({ queryKey: ["permisos"] }).catch(() => {});
    await waitFor(() => expect(queryClient.getQueryState(["permisos", "sesion", "u-1"])?.status).toBe("error"), { timeout: 5_000 });

    // Lo que se pinta sigue siendo lo de antes, no «sin permisos».
    expect(screen.getByText("puede ajustar existencias")).toBeTruthy();
    // Y mientras falle, la relectura tiene reloj.
    expect(intervalo()).toBe(15_000);
});

it("un cambio de usuarios, roles o concesiones que llega de otro equipo los relee", async () => {
    for (const tabla of ["usuarios", "roles", "roles_permisos"]) {
        permisos = ["stock.ajustar"];
        queryClient.clear();
        invoke.mockClear();
        pintar();
        await screen.findByText("puede ajustar existencias");

        // Le quitan el permiso en la Main: el aviso trae la tabla, y de ella salen las claves.
        permisos = [];
        const claves = featureKeysPorTablas([tabla]);
        expect(claves, tabla).toContain("permisos");
        for (const clave of claves!) void queryClient.invalidateQueries({ queryKey: [clave] });

        await screen.findByText("no puede ajustar existencias");
        expect(lecturas(), tabla).toBe(2);
        cleanup();
    }
});

it("un cobro de otro equipo no los relee", async () => {
    pintar();
    await screen.findByText("puede ajustar existencias");

    const claves = featureKeysPorTablas(["comandas", "pagos", "pago_detalles", "movimientos_caja"]);
    expect(claves).not.toContain("permisos");
    for (const clave of claves!) void queryClient.invalidateQueries({ queryKey: [clave] });
    await Promise.resolve();
    expect(lecturas()).toBe(1);
});

it("al volver a la aplicación se releen", async () => {
    pintar();
    await screen.findByText("puede ajustar existencias");

    permisos = [];
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await screen.findByText("no puede ajustar existencias");
    await waitFor(() => expect(lecturas()).toBe(2));
});

it("sin sesión no se pregunta", async () => {
    useAuth.setState({ idUsuario: null });
    pintar();
    await screen.findByText("cargando");
    expect(lecturas()).toBe(0);
});
