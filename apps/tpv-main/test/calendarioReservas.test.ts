// El calendario de Reservas: el día elegido va con el mes que se ve. Antes, con el 30 de octubre
// elegido, pasar a noviembre buscaba el 30 de octubre en las reservas de noviembre y la lista salía
// vacía aunque ese día tuviera reservas.
import { describe, expect, it } from "vitest";

import { diaAlCambiarDeMes, mismoMes } from "../src/features/reservas/calendario";

const hoy = new Date(2026, 9, 20, 17, 30);

describe("el día elegido al cambiar de mes", () => {
    it("en el mes de hoy, hoy", () => {
        expect(diaAlCambiarDeMes(new Date(2026, 9, 1), hoy)).toBe(hoy);
    });

    it("en otro mes, su día 1", () => {
        expect(diaAlCambiarDeMes(new Date(2026, 10, 1), hoy)).toEqual(new Date(2026, 10, 1));
        expect(diaAlCambiarDeMes(new Date(2025, 9, 1), hoy)).toEqual(new Date(2025, 9, 1));
    });

    it("un día del mes de al lado no es del mes que se ve", () => {
        expect(mismoMes(new Date(2026, 10, 1), new Date(2026, 9, 1))).toBe(false);
        expect(mismoMes(new Date(2026, 9, 31), new Date(2026, 9, 1))).toBe(true);
    });
});
