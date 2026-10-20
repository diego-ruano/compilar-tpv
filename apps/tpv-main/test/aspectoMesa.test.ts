// Cómo se ve en el plano una mesa con reserva. Una reserva por llegar pasada su hora sigue por
// llegar, con retraso: antes se pintaba como sentada y se quedaba en la mesa para siempre.
import { describe, expect, it } from "vitest";
import type { MesaMetaOut } from "@tpv/contracts";

import { aspectoDeMesa } from "../src/features/mesas/aspectoMesa";
import { fmtReserva } from "../src/features/mesas/comanda";
import type { Table } from "../src/features/mesas/types";

const mesa = { id: "db-mesa-m1", name: "Mesa 1", seats: 4 } as Table;

function conReserva(estado: string, minutosPara: number, clienteNombre = "Ana") {
    const meta = {
        ocupada: false,
        id_comanda: "",
        idComanda: "",
        totalPendiente: 0,
        pendientesPago: 0,
        pendientesCocina: 0,
        estado: "LIBRE",
        reserva: { idReserva: "r1", clienteNombre, diaYMD: "2026-10-20", hora: "21:00", estado, minutosPara },
    } as unknown as MesaMetaOut;
    return aspectoDeMesa(mesa, { m1: meta } as never, false);
}

describe("una mesa con reserva en el plano", () => {
    it("la que llega pronto dice cuánto falta", () => {
        expect(conReserva("PROXIMA", 25).subetiqueta).toBe("Reserva Ana en 25 min");
    });

    it("la que llega tarde sigue por llegar y dice cuánto lleva de retraso", () => {
        const a = conReserva("PROXIMA", -10);
        expect(a.subetiqueta).toBe("Reserva Ana · 10 min tarde");
        expect(a.etiqueta).toBe("Mesa 1");
    });

    it("la sentada lleva el nombre en la etiqueta, y sin cliente dice «Reserva»", () => {
        expect(conReserva("ACTIVA", -40).etiqueta).toBe("Mesa 1 · Reserva Ana");
        expect(conReserva("PROXIMA", 5, "").subetiqueta).toBe("Reserva en 5 min");
    });
});

describe("la reserva en la mesa abierta", () => {
    const reserva = (estado: string, minutosPara: number) =>
        ({ idReserva: "r1", clienteNombre: "Ana", diaYMD: "2026-10-20", hora: "21:00", estado, minutosPara }) as never;

    it("la que llega tarde lo dice, y no «en 0 min»", () => {
        expect(fmtReserva(reserva("PROXIMA", -30))).toBe("llega tarde: 30 min");
        expect(fmtReserva(reserva("PROXIMA", 0))).toBe("Reserva en 0 min");
        expect(fmtReserva(reserva("PROXIMA", 25))).toBe("Reserva en 25 min");
    });
});
