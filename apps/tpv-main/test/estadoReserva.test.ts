// El estado de una reserva en la pantalla de Reservas: qué cuenta como viva (el calendario y el
// total), cómo se lee y en qué orden sale la lista del día.
import { describe, expect, it } from "vitest";

import { etiquetaEstado, ocupaMesa, ordenarDelDia, resumenDelDia } from "../src/features/reservas/estadoReserva";

const r = (estado: string, hora = "21:00") => ({ estado, hora });

describe("el estado de una reserva", () => {
    it("viva es la que aún ocupa la mesa: próxima o con el cliente sentado", () => {
        expect(ocupaMesa("PROXIMA")).toBe(true);
        expect(ocupaMesa("ACTIVA")).toBe(true);
        for (const estado of ["FINALIZADA", "CANCELADA", "NO_SHOW"]) expect(ocupaMesa(estado), estado).toBe(false);
    });

    it("se lee como una palabra, no como el valor de la base", () => {
        expect(etiquetaEstado("CANCELADA")).toBe("Cancelada");
        expect(etiquetaEstado("NO_SHOW")).toBe("No vino");
        expect(etiquetaEstado("ACTIVA")).toBe("En la mesa");
    });

    it("las cerradas van al final, y cada grupo por hora", () => {
        const dia = [r("CANCELADA", "13:00"), r("PROXIMA", "21:00"), r("NO_SHOW", "12:00"), r("ACTIVA", "14:00")];
        expect(ordenarDelDia(dia)).toEqual([r("ACTIVA", "14:00"), r("PROXIMA", "21:00"), r("NO_SHOW", "12:00"), r("CANCELADA", "13:00")]);
    });

    it("el total cuenta sólo las vivas y las cerradas van detrás", () => {
        // Lo de la captura del 20/10: una sola reserva, cancelada, y el total decía 1.
        expect(resumenDelDia([r("CANCELADA")])).toBe("Total: 0 · 1 cancelada");
        expect(resumenDelDia([r("PROXIMA"), r("ACTIVA")])).toBe("Total: 2");
        expect(resumenDelDia([r("PROXIMA"), r("CANCELADA"), r("CANCELADA"), r("NO_SHOW"), r("FINALIZADA")])).toBe(
            "Total: 1 · 2 canceladas · 1 terminada · 1 no vino",
        );
    });
});
