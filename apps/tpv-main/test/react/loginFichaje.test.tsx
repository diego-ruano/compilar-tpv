/** @vitest-environment jsdom */
// La pantalla de fichar y entrar (`Login.tsx`), con un backend de mentira en lugar del IPC.
//
// - AUT-INC-01: «Mostrar PIN» es de quien lo pulsó; el siguiente trabajador teclea oculto.
// - TRA-INC-04: lo que hacen otros equipos (la réplica) se ve sin volver a tocar nada.
// - AUT-INC-02: si la jornada es de ayer lo dice el backend.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import Login from "../../src/app/pages/Login";
import { useSyncSignal } from "../../src/shared/stores/useSyncSignal";
import { ToastProvider } from "../../src/shared/toast";

type Parte = { parte: number; entrada: string | null; salida: string | null; estado: string | null };
type Estado = { fecha: string; turno_partido: number; partes: Parte[]; jornada_anterior?: boolean };

const { invoke, backend } = vi.hoisted(() => {
    const backend = {
        usuarios: [] as { id_usuario: string; nombre: string; apellido: null; nombre_rol: string; sin_pin: boolean }[],
        estados: new Map<string, Estado>(),
        /** Lo que contesta `punch`: el estado nuevo o un error. */
        punch: null as null | ((args: { id_usuario: string; tipo: string }) => Estado),
        llamadas: [] as { comando: string; args: any }[],
    };
    const invoke = async (comando: string, args?: any): Promise<unknown> => {
        backend.llamadas.push({ comando, args: args?.args ?? args });
        switch (comando) {
            case "list_login_users":
                return backend.usuarios;
            case "get_today_punch_status":
                return backend.estados.get(args.args.id_usuario);
            case "punch": {
                if (!backend.punch) throw { code: "internal", message: "sin punch" };
                const st = backend.punch(args.args);
                backend.estados.set(args.args.id_usuario, st);
                return st;
            }
            default:
                return null;
        }
    };
    return { invoke: vi.fn(invoke), backend };
});

vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke }));
vi.mock("../../src/app/layoutComponent/Titlebar", () => ({ default: () => null }));

const sinFichar = (fecha = "2026-11-18"): Estado => ({
    fecha,
    turno_partido: 0,
    partes: [{ parte: 1, entrada: null, salida: null, estado: null }],
});
const conEntrada = (fecha = "2026-11-18"): Estado => ({
    fecha,
    turno_partido: 0,
    partes: [{ parte: 1, entrada: "09:00", salida: null, estado: "ABIERTO" }],
});

beforeEach(() => {
    backend.usuarios = [
        { id_usuario: "u-ana", nombre: "Ana", apellido: null, nombre_rol: "Camarero", sin_pin: false },
        { id_usuario: "u-luis", nombre: "Luis", apellido: null, nombre_rol: "Camarero", sin_pin: false },
    ];
    backend.estados = new Map([
        ["u-ana", sinFichar()],
        ["u-luis", sinFichar()],
    ]);
    backend.punch = null;
    backend.llamadas = [];
});
afterEach(cleanup);

function pintarLogin() {
    render(
        <ToastProvider>
            <MemoryRouter>
                <Login />
            </MemoryRouter>
        </ToastProvider>,
    );
}

async function elegir(nombre: string) {
    const boton = await waitFor(() => {
        const b = screen.getAllByRole("button", { name: new RegExp(nombre) })[0];
        expect(b).toBeEnabled();
        return b;
    });
    fireEvent.click(boton);
}

async function teclear(pin: string) {
    for (const d of pin) {
        const tecla = await waitFor(() => {
            const b = screen.getByRole("button", { name: d });
            expect(b).toBeEnabled();
            return b;
        });
        fireEvent.click(tecla);
    }
}

async function pulsar(nombre: string | RegExp) {
    const boton = await waitFor(() => {
        const b = screen.getAllByRole("button", { name: nombre })[0];
        expect(b).toBeEnabled();
        return b;
    });
    fireEvent.click(boton);
}

it("«Mostrar PIN» no pasa al siguiente trabajador ni sobrevive al fichaje (AUT-INC-01)", async () => {
    pintarLogin();
    await elegir("Ana");
    await pulsar("Mostrar PIN");
    await screen.findByRole("button", { name: "Ocultar PIN" });

    // Otro trabajador: el ojo vuelve a estar cerrado.
    await elegir("Luis");
    await screen.findByRole("button", { name: "Mostrar PIN" });
    expect(screen.queryByRole("button", { name: "Ocultar PIN" })).toBeNull();

    // «Cambiar usuario» también.
    await pulsar("Mostrar PIN");
    await screen.findByRole("button", { name: "Ocultar PIN" });
    await pulsar("Cambiar usuario");
    await screen.findByRole("button", { name: "Mostrar PIN" });

    // Y tras fichar, para quien teclee después en el mismo equipo.
    backend.punch = () => conEntrada();
    await elegir("Ana");
    await pulsar("Mostrar PIN");
    await teclear("1234");
    await pulsar("Fichar entrada");
    await screen.findAllByRole("button", { name: "Fichar salida" });
    await screen.findByRole("button", { name: "Mostrar PIN" });
});

/** Llega un cambio replicado que ha tocado `tablas`. */
function llegaCambio(tablas: string[]) {
    act(() =>
        useSyncSignal
            .getState()
            .bump({ ids: [], touchedComanda: false, uncertain: false, touchedCatalog: false }, tablas),
    );
}

const lecturas = (comando: string) => backend.llamadas.filter((l) => l.comando === comando).length;

it("un trabajador dado de alta en otro equipo aparece sin «Cargando» (TRA-INC-04)", async () => {
    pintarLogin();
    await screen.findAllByRole("button", { name: /Ana/ });

    backend.usuarios = [
        ...backend.usuarios,
        { id_usuario: "u-marta", nombre: "Marta", apellido: null, nombre_rol: "Cocinero", sin_pin: false },
    ];
    // Un cambio de otra cosa no relee la lista.
    llegaCambio(["productos"]);
    expect(lecturas("list_login_users")).toBe(1);

    llegaCambio(["usuarios"]);
    await screen.findAllByRole("button", { name: /Marta/ });
    expect(screen.queryByText("Cargando usuarios...")).toBeNull();
});

it("quien deja de poder entrar deja de estar seleccionado (TRA-INC-04)", async () => {
    pintarLogin();
    await elegir("Luis");
    await screen.findAllByRole("button", { name: "Fichar entrada" });

    backend.usuarios = backend.usuarios.filter((u) => u.id_usuario !== "u-luis");
    llegaCambio(["usuarios"]);
    await waitFor(() => expect(screen.queryAllByRole("button", { name: /Luis/ })).toHaveLength(0));
    expect(screen.getByText("Sin usuario")).toBeInTheDocument();
});

it("la entrada fichada en otro equipo cambia el botón a «Fichar salida» (TRA-INC-04)", async () => {
    pintarLogin();
    await elegir("Ana");
    await screen.findAllByRole("button", { name: "Fichar entrada" });
    const antes = lecturas("get_today_punch_status");

    backend.estados.set("u-ana", conEntrada());
    llegaCambio(["comandas"]);
    expect(lecturas("get_today_punch_status")).toBe(antes);

    llegaCambio(["fichajes"]);
    await screen.findAllByRole("button", { name: "Fichar salida" });
    // Sin pasar por «Cargando...» mientras relee.
    expect(screen.queryByText("Cargando...")).toBeNull();
});

it("tras un fichaje rechazado relee el estado y deja de ofrecer el botón de antes (TRA-INC-04)", async () => {
    pintarLogin();
    await elegir("Ana");
    await screen.findAllByRole("button", { name: "Fichar entrada" });

    // Otra Handy ya ha fichado la entrada y el aviso todavía no ha llegado.
    backend.estados.set("u-ana", conEntrada());
    backend.punch = () => {
        throw { code: "conflict", message: "Tienes un fichaje abierto. Ficha salida antes de fichar entrada." };
    };
    await teclear("1234");
    await pulsar("Fichar entrada");
    await screen.findAllByRole("button", { name: "Fichar salida" });
});

it("«Jornada de ayer» lo dice el backend, no el reloj del dispositivo (AUT-INC-02)", async () => {
    // Una jornada de hoy del negocio que, para el reloj de este dispositivo, es de otro día.
    backend.estados.set("u-ana", { ...conEntrada("1999-01-01"), jornada_anterior: false });
    backend.estados.set("u-luis", { ...conEntrada("1999-01-01"), jornada_anterior: true });
    pintarLogin();

    await elegir("Ana");
    await screen.findAllByRole("button", { name: "Fichar salida" });
    expect(screen.getByText("Fichaje de hoy")).toBeInTheDocument();
    expect(screen.queryByText("Jornada de ayer")).toBeNull();

    await elegir("Luis");
    await screen.findByText("Jornada de ayer");
});
