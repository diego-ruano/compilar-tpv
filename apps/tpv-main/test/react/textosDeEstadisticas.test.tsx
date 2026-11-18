/** @vitest-environment jsdom */
// Estadísticas no enseña texto de programador.
//
// Proveedores, en «Hoy», pintaba debajo de la evolución del gasto una nota para quien escribió la
// consulta («Nota: si Cuentas_Gastos.Fecha es DATE (sin hora)…»). Se montan las pantallas en
// «Hoy» y se comprueba que no sale ningún nombre de tabla o columna (`Tabla.Columna`,
// `Algo_Con_Guiones`) ni un tipo de SQL.

import { cleanup, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import ProveedoresStats from "../../src/features/estadisticas/ProveedoresStats";
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

/** Lo que delata texto de programador: un identificador con guion bajo, un `Tabla.Columna`, un tipo SQL. */
const TECNICO = /\b[A-Za-z]+_[A-Za-z_]+\b|\b[A-Z]\w+\.[A-Z]\w+\b|\bDATE\b/;

it("Proveedores en «Hoy» no enseña la nota sobre Cuentas_Gastos.Fecha", async () => {
    invoke.mockResolvedValue({
        total_gasto: 10000,
        num_gastos: 2,
        gasto_medio: 5000,
        porcentaje_sobre_total_gastos: 50,
        proveedor_top: { nombre: "Bebidas", total: 7000 },
        gastos_evolucion: { labels: ["10"], values: [3000] },
        gasto_por_proveedor: { labels: ["Bebidas"], values: [7000] },
        ultimos_gastos: [],
    });
    const pantalla = montar(<ProveedoresStats range="hoy" />);
    await esperar("las gráficas", () => pantalla.querySelector("[data-grafica]") !== null);

    expect(pantalla.textContent).not.toMatch(TECNICO);
});
