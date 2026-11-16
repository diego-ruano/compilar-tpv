// INC-01: «Hoy» es el día del negocio, no el del dispositivo.
import { describe, expect, it } from "vitest";

import { diaDeFecha, diaYHoraCortos, hoyEnElNegocio } from "../src/shared/lib/diaDelNegocio";

// 2026-11-15 23:10 UTC: en Madrid ya es el 16, en GMT todavía el 15.
const MEDIANOCHE_EN_MADRID = Date.UTC(2026, 10, 15, 23, 10);

describe("el día del negocio", () => {
    it("se calcula en la zona del negocio, no en la del dispositivo", () => {
        expect(hoyEnElNegocio("Europe/Madrid", MEDIANOCHE_EN_MADRID)).toBe("2026-11-16");
        expect(hoyEnElNegocio("Atlantic/Canary", MEDIANOCHE_EN_MADRID)).toBe("2026-11-15");
    });

    it("con una zona que el motor no conoce, cae a la del equipo sin romper", () => {
        expect(hoyEnElNegocio("No/Existe", MEDIANOCHE_EN_MADRID)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("el día de una fecha guardada es su texto", () => {
        expect(diaDeFecha("2026-11-16 00:09:00")).toBe("2026-11-16");
        expect(diaDeFecha("  2026-11-16T00:09:00 ")).toBe("2026-11-16");
        expect(diaDeFecha("16/11/2026")).toBeNull();
        expect(diaDeFecha(null)).toBeNull();
    });

    it("se enseña sin pasar por la zona del dispositivo", () => {
        expect(diaYHoraCortos("2026-11-16 00:09:00")).toBe("16/11 00:09");
        expect(diaYHoraCortos("2026-11-16")).toBe("16/11");
        expect(diaYHoraCortos("raro")).toBe("raro");
    });
});
