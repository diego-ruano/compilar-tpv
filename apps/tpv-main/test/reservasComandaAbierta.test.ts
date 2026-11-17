// RES-04: el plano para elegir mesa enseñaba libre una mesa con una comanda abierta, y al guardar
// la reserva para hoy se rechazaba. Ahora, con el día de hoy, se ve ocupada y se avisa antes.
import { describe, expect, it } from "vitest";
import type { MesaMetaOut } from "@tpv/contracts";

import { comandaImpideReservar, mesasConComandaHoy } from "../src/features/reservas/comandaAbierta";

const meta = (ocupada: boolean, conReserva = false): MesaMetaOut =>
    ({
        ocupada, id_comanda: ocupada ? "c1" : "", idComanda: ocupada ? "c1" : "", totalPendiente: 0,
        pendientesPago: 0, pendientesCocina: 0, estado: "LIBRE",
        ...(conReserva ? { reserva: { estado: "PROXIMA" } } : {}),
    }) as unknown as MesaMetaOut;

describe("RES-04 · una mesa con comanda abierta, al elegir mesa para una reserva", () => {
    const plano = { m1: meta(true, true), m2: meta(false, true) };

    it("hoy se pinta ocupada (sin su reserva) y otro día no", () => {
        const hoy = mesasConComandaHoy(plano, true);
        expect(Object.keys(hoy)).toEqual(["m1"]);
        expect(hoy.m1).toMatchObject({ ocupada: true, estado: "PENDIENTE" });
        expect(hoy.m1).not.toHaveProperty("reserva");
        expect(mesasConComandaHoy(plano, false)).toEqual({});
    });

    it("impide reservarla, salvo la reserva que ya era de esa mesa ese día", () => {
        const hoy = mesasConComandaHoy(plano, true);
        expect(comandaImpideReservar(hoy, "m1", "2026-11-17", undefined)).toBe(true);
        expect(comandaImpideReservar(hoy, "m2", "2026-11-17", undefined)).toBe(false);
        expect(comandaImpideReservar(hoy, "", "2026-11-17", undefined)).toBe(false);
        expect(comandaImpideReservar(hoy, "m1", "2026-11-17", { id_mesa: "m1", dia_ymd: "2026-11-17" })).toBe(false);
        expect(comandaImpideReservar(hoy, "m1", "2026-11-17", { id_mesa: "m2", dia_ymd: "2026-11-17" })).toBe(true);
    });
});
