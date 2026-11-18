/** @vitest-environment jsdom */
// Estadísticas no sustituye lo que enseña por «Cargando…» cuando relee.
//
// Clientes y Proveedores cambiaban cada gráfica por un «Cargando…» en cada relectura (la de
// fondo, la de «Recargar», la que dispara una escritura): las lecturas son tan rápidas que se veía
// un parpadeo, no una carga. Ahora sólo la primera carga deja el hueco, sin texto, y una relectura
// deja los datos de antes en pantalla, atenuados, hasta que llegan los nuevos.
//
// ApexCharts se sustituye por una marca: lo que se mira aquí es si la gráfica sigue montada, no
// cómo se dibuja (eso lo hace `etiquetasApexEscapadas.test.tsx`).

import { cleanup, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ClientesStats from "../../src/features/estadisticas/ClientesStats";
import MesasStats from "../../src/features/estadisticas/MesasStats";
import ProductosStats from "../../src/features/estadisticas/ProductosStats";
import ProveedoresStats from "../../src/features/estadisticas/ProveedoresStats";
import ReservasStats from "../../src/features/estadisticas/ReservasStats";
import TrabajadoresStats from "../../src/features/estadisticas/TrabajadoresStats";
import { queryClient } from "../../src/shared/lib/queryClient";
import { ToastProvider } from "../../src/shared/toast";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("react-apexcharts", () => ({ default: () => <div data-grafica="" /> }));

beforeEach(() => {
    queryClient.clear();
    invoke.mockReset();
});

afterEach(cleanup);

const CLIENTES = {
    nuevos: 3,
    recurrentes: 2,
    no_recurrentes: 1,
    ticket_medio_cliente: 1500,
    nuevos_por_bucket: { labels: ["01/11"], values: [1] },
    top_clientes_gasto: { labels: ["Ana"], values: [250000] },
};

const PROVEEDORES = {
    total_gasto: 10000,
    num_gastos: 2,
    gasto_medio: 5000,
    porcentaje_sobre_total_gastos: 50,
    proveedor_top: { nombre: "Bebidas SL", total: 7000 },
    gastos_evolucion: { labels: ["01/11"], values: [3000] },
    gasto_por_proveedor: { labels: ["Bebidas SL"], values: [7000] },
    ultimos_gastos: [{ fecha: "2026-11-01", proveedor: "Bebidas SL", concepto: "Cajas", importe: 7000 }],
};

/** Contesta con `datos` mientras `colgado()` sea falso; si no, deja la lectura sin terminar. */
function responder(comando: string, datos: unknown, colgado: () => boolean) {
    invoke.mockImplementation((nombre: string) => {
        if (nombre !== comando) return Promise.reject(new Error(`comando inesperado: ${nombre}`));
        return colgado() ? new Promise(() => {}) : Promise.resolve(datos);
    });
}

function montar(pantalla: ReactElement) {
    return render(
        <QueryClientProvider client={queryClient}>
            <ToastProvider>{pantalla}</ToastProvider>
        </QueryClientProvider>,
    ).container;
}

async function esperar(que: string, listo: () => boolean) {
    const limite = performance.now() + 4_000;
    while (!listo()) {
        if (performance.now() > limite) throw new Error(`Sigue sin ${que}`);
        await new Promise((seguir) => setTimeout(seguir, 10));
    }
}

const graficas = (pantalla: HTMLElement) => pantalla.querySelectorAll("[data-grafica]").length;

describe.each([
    ["Clientes", () => <ClientesStats range="mes" />, "stats_clientes_resumen", CLIENTES],
    ["Proveedores", () => <ProveedoresStats range="mes" />, "stats_proveedores_resumen", PROVEEDORES],
])("%s", (_nombre, pantallaDe, comando, datos) => {
    it("la primera carga deja el hueco, sin «Cargando…»", async () => {
        responder(comando, datos, () => true);
        const pantalla = montar(pantallaDe());
        await esperar("pintar", () => pantalla.firstChild !== null);
        await esperar("pedir los datos", () => invoke.mock.calls.length > 0);

        expect(pantalla.textContent).not.toContain("Cargando");
        expect(graficas(pantalla)).toBe(0);
    });

    it("una relectura deja las gráficas en pantalla, atenuadas, sin «Cargando…»", async () => {
        let colgado = false;
        responder(comando, datos, () => colgado);
        const pantalla = montar(pantallaDe());
        await esperar("las gráficas", () => graficas(pantalla) > 0);
        const antes = graficas(pantalla);

        colgado = true;
        void queryClient.invalidateQueries();
        await esperar("la relectura", () => queryClient.isFetching() > 0 && pantalla.querySelector(".opacity-60") !== null);

        expect(graficas(pantalla)).toBe(antes);
        expect(pantalla.textContent).not.toContain("Cargando");
    });
});

// El texto «Cargando…» / «Actualizado» de la cabecera también parpadeaba en cada relectura.
describe.each([
    ["Mesas", () => <MesasStats range="mes" />],
    ["Productos", () => <ProductosStats range="mes" />],
    ["Reservas", () => <ReservasStats range="mes" />],
    ["Trabajadores", () => <TrabajadoresStats range="mes" />],
])("%s", (_nombre, pantallaDe) => {
    it("mientras lee no enseña «Cargando…»", async () => {
        invoke.mockImplementation(() => new Promise(() => {}));
        const pantalla = montar(pantallaDe());
        await esperar("pintar", () => pantalla.firstChild !== null);
        await esperar("pedir los datos", () => invoke.mock.calls.length > 0);

        expect(pantalla.textContent).not.toContain("Cargando");
    });
});
