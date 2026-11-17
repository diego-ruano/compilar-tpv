// RES-INC-03 / SYN-INC-04: con la reserva abierta en la Handy (sólo para la nota), la Main subió los
// comensales de 2 a 3; al guardar, la Handy volvía a escribir sus 2. Y un formulario abierto mientras
// la cancelaban la cambiaba igual. Ahora lo que llega entra en lo que no se ha tocado, lo visto
// viaja al guardar, y si la reserva se cierra o se va, no se deja guardar.
import { describe, expect, it } from "vitest";
import type { ReservaDto } from "@tpv/contracts";

import { clienteSinTocar, formDeReserva, motivoParaNoGuardar, rebasar, vistoDe } from "../src/features/reservas/edicion";

const reserva = (cambios: Partial<ReservaDto> = {}): ReservaDto => ({
    id_reserva: "r1", id_mesa: "m1", dia_ymd: "2026-11-18", hora: "14:00", turno: "COMIDA", comensales: 2,
    duracion_min: null, nota: null, estado: "PROXIMA", origen: "TPV", id_cliente: "c1", nombre_cliente: "Ana",
    telefono_cliente: "600100200", email_cliente: null, id_zona: "z1", numero_mesa: "1", capacidad: 4,
    nombre_zona: "Sala", ...cambios,
});

describe("lo que llega de otro equipo con el formulario abierto", () => {
    it("entra en lo que no se ha tocado y respeta lo tocado", () => {
        const base = reserva();
        const handy = { ...formDeReserva(base), nota: "Cumpleaños" };
        const deLaMain = reserva({ comensales: 3, nota: "Terraza" });

        const queda = rebasar(handy, base, deLaMain);
        expect(queda.comensales).toBe(3); // no lo tocó: el de la Main
        expect(queda.nota).toBe("Cumpleaños"); // lo tocó: el suyo
        expect(queda.hora).toBe("14:00");
    });

    it("lo visto que viaja es lo de la última versión que entró", () => {
        expect(vistoDe(reserva({ comensales: 3 }))).toEqual({
            id_mesa: "m1", dia_ymd: "2026-11-18", hora: "14:00", comensales: 3, duracion_min: null, nota: null, id_cliente: "c1",
        });
    });

    it("el cliente asignado sigue a la reserva sólo si no se han tocado sus datos", () => {
        const base = reserva();
        expect(clienteSinTocar(formDeReserva(base), base)).toBe(true);
        expect(clienteSinTocar({ ...formDeReserva(base), telefono: "699" }, base)).toBe(false);
    });
});

describe("cuándo ya no se deja guardar", () => {
    it("si se cierra, se borra o se mueve de día", () => {
        expect(motivoParaNoGuardar(reserva(), "2026-11-18")).toBeNull();
        expect(motivoParaNoGuardar(reserva({ estado: "ACTIVA" }), "2026-11-18")).toBeNull();
        for (const estado of ["CANCELADA", "FINALIZADA", "NO_SHOW"]) {
            expect(motivoParaNoGuardar(reserva({ estado }), "2026-11-18"), estado).toMatch(/se ha cerrado/);
        }
        expect(motivoParaNoGuardar(undefined, "2026-11-18")).toMatch(/ya no está en este día/);
        expect(motivoParaNoGuardar(reserva({ dia_ymd: "2026-11-19" }), "2026-11-18")).toMatch(/otro día/);
    });
});
