/** @vitest-environment jsdom */
// Ver tickets (barra): qué día es «hoy» (INC-01) y cuándo un ticket está cobrado (INC-05).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { ComandaBarraRow } from "@tpv/contracts";
import VerTicketsModal from "../../src/features/ventaRapida/ui/VerTicketsModal";
import { deCentimos } from "../../src/shared/lib/dinero";
import { hoyEnElNegocio } from "../../src/shared/lib/diaDelNegocio";
import { useBusinessSettings } from "../../src/shared/stores/useBusinessSettings";

vi.mock("../../src/features/ventaRapida/ventaRapidaAPI", () => ({
    vrGetIndexRows: vi.fn().mockResolvedValue([]),
    vrGetDetallesVerTicket: vi.fn().mockResolvedValue([]),
}));

afterEach(() => cleanup());

const ZONA = "Europe/Madrid";
const hoy = hoyEnElNegocio(ZONA);

function comanda(id: string, extra: Partial<ComandaBarraRow>): ComandaBarraRow {
    return {
        ID_Comanda: id,
        Fecha_Hora_Apertura: `${hoy} 12:00:00`,
        Estado: "Abierta",
        Total_Pendiente: deCentimos(0),
        Total_Comanda: deCentimos(0),
        Pendientes_Cocina: 0,
        Pendientes_Pago: 0,
        ...extra,
    };
}

function abrir(comandas: ComandaBarraRow[]) {
    useBusinessSettings.setState({ zona_horaria: ZONA });
    render(
        <VerTicketsModal
            open
            onClose={() => {}}
            comandas={comandas}
            onOpenTicket={() => {}}
            onDeleteTicket={() => {}}
            onCobrarTicket={() => {}}
        />,
    );
}

/** La tarjeta del ticket que enseña `hora` («12:00», «12:30»…). */
function tarjeta(hora: string): HTMLElement {
    return screen.getByText(new RegExp(`${hora}$`)).closest(".rounded-2xl") as HTMLElement;
}

it("un ticket con sólo una invitación sin cobrar no sale como cobrado, y se puede cobrar", () => {
    abrir([
        comanda("invitacion", { Pendientes_Pago: 1 }),
        comanda("cobrado", {
            Fecha_Hora_Apertura: `${hoy} 12:30:00`,
            Estado: "Pagada",
            Total_Comanda: deCentimos(242),
        }),
    ]);

    const invitacion = within(tarjeta("12:00"));
    expect(invitacion.getByText("SIN COBRAR")).toBeInTheDocument();
    expect(invitacion.getByRole("button", { name: "Cobrar" })).toBeEnabled();

    const cobrado = within(tarjeta("12:30"));
    expect(cobrado.getByText("COBRADO")).toBeInTheDocument();
    expect(cobrado.getByRole("button", { name: "Cobrar" })).toBeDisabled();
});

it("«Hoy» es el día del negocio: lo de ayer no sale aunque el dispositivo vaya con otra zona", () => {
    abrir([comanda("ayer", { Fecha_Hora_Apertura: "2000-01-01 12:00:00", Pendientes_Pago: 1 })]);
    expect(screen.getByText("Sin tickets")).toBeInTheDocument();
});
