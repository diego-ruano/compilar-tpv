// apps/tpv-main/test/diasNaturales.test.ts
//
// Los días que faltan para que caduque la licencia, como los lee quien está delante: por fecha.
// El fallo que había era redondear horas hacia arriba, así que a las 08:00 una caducidad de las
// 23:00 salía como «mañana», y el día del cambio de hora de octubre (25 horas) contaba como dos.
//
// Se fija la zona de Madrid para que los casos del cambio de hora signifiquen algo en cualquier
// máquina donde corra el test.

process.env.TZ = "Europe/Madrid";

import { describe, expect, it } from "vitest";

import { diasNaturalesHasta } from "../src/shared/lib/diasNaturales";

/** Milisegundos de una fecha y hora LOCALES (mes de 1 a 12). */
const local = (anio: number, mes: number, dia: number, hora = 0, minuto = 0) =>
    new Date(anio, mes - 1, dia, hora, minuto).getTime();

describe("diasNaturalesHasta", () => {
    it.each([
        ["08:00 → 23:00 del mismo día", local(2026, 9, 15, 8), local(2026, 9, 15, 23), 0],
        ["00:05 → 23:59 del mismo día", local(2026, 9, 15, 0, 5), local(2026, 9, 15, 23, 59), 0],
        ["23:45 → 00:30 del día siguiente", local(2026, 9, 15, 23, 45), local(2026, 9, 16, 0, 30), 1],
        ["08:00 → 23:59 del día siguiente", local(2026, 9, 15, 8), local(2026, 9, 16, 23, 59), 1],
        ["23:00 → 01:00 de dentro de tres días", local(2026, 9, 15, 23), local(2026, 9, 18, 1), 3],
        ["fin de año", local(2026, 12, 31, 22), local(2027, 1, 1, 9), 1],
        ["ayer por la noche", local(2026, 9, 15, 8), local(2026, 9, 14, 23), -1],
        ["hace una hora", local(2026, 9, 15, 8), local(2026, 9, 15, 7), 0],
    ])("%s", (_caso, ahora, fecha, esperado) => {
        expect(diasNaturalesHasta(fecha, ahora)).toBe(esperado);
    });

    it("el día del cambio de hora cuenta como un día, tenga 23 o 25 horas", () => {
        // Marzo: el domingo 28 tiene 23 horas. Octubre: el domingo 25 tiene 25.
        expect(diasNaturalesHasta(local(2027, 3, 28, 10), local(2027, 3, 27, 10))).toBe(1);
        expect(diasNaturalesHasta(local(2026, 10, 25, 10), local(2026, 10, 24, 10))).toBe(1);
        // Con las horas redondeadas hacia arriba, las 25 horas de octubre eran «en 2 días».
        expect(Math.ceil((local(2026, 10, 25, 10) - local(2026, 10, 24, 10)) / 86_400_000)).toBe(2);
    });

    it("barrido: a cualquier hora de cualquier día de 2026, una fecha k días después está a k días", () => {
        for (let dia = 1; dia <= 365; dia++) {
            for (const hora of [0, 7, 13, 23]) {
                const ahora = local(2026, 1, dia, hora, 30);
                for (const k of [0, 1, 2, 30]) {
                    for (const horaFecha of [0, 12, 23]) {
                        const fecha = local(2026, 1, dia + k, horaFecha, 59);
                        const dias = diasNaturalesHasta(fecha, ahora);
                        if (dias !== k) {
                            throw new Error(`${new Date(ahora)} → ${new Date(fecha)}: ${dias}, no ${k}`);
                        }
                    }
                }
            }
        }
    });
});
