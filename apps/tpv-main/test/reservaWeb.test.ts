// Reservas desde la web: cuándo hay que preguntar antes de cambiar o borrar una reserva, porque al
// cliente le llega un correo (docs/estudios/reservas-web.md §5.6). La misma regla que el caso de uso.
import { describe, expect, it } from "vitest";
import type { ReservaDto } from "@tpv/contracts";

import { cambiaParaElCliente, esWebPorVenir } from "../src/features/reservas/reservaWeb";

const web = {
    id_reserva: "r1",
    id_mesa: "m1",
    dia_ymd: "2026-10-24",
    hora: "21:00",
    turno: "CENA",
    comensales: 2,
    duracion_min: null,
    nota: null,
    estado: "PROXIMA",
    origen: "WEB",
    id_cliente: "c1",
    nombre_cliente: "Ana",
    telefono_cliente: null,
    email_cliente: "ana@correo.es",
    id_zona: "z1",
    numero_mesa: "Mesa 1",
    capacidad: 4,
    nombre_zona: "Salón",
} as ReservaDto;

const igual = { dia_ymd: "2026-10-24", hora: "21:00", comensales: 2, id_mesa: "m1" };

describe("una reserva web que está por venir", () => {
    it("sólo la web y por venir avisa al cliente", () => {
        expect(esWebPorVenir(web)).toBe(true);
        expect(esWebPorVenir({ ...web, origen: "TPV" })).toBe(false);
        for (const estado of ["ACTIVA", "FINALIZADA", "NO_SHOW", "CANCELADA"]) {
            expect(esWebPorVenir({ ...web, estado }), estado).toBe(false);
        }
    });

    it("le cambia el día, la hora, las personas o la mesa; lo demás, no", () => {
        expect(cambiaParaElCliente(web, igual)).toBe(false);
        expect(cambiaParaElCliente(web, { ...igual, hora: "22:00" })).toBe(true);
        expect(cambiaParaElCliente(web, { ...igual, dia_ymd: "2026-10-25" })).toBe(true);
        expect(cambiaParaElCliente(web, { ...igual, comensales: 3 })).toBe(true);
        expect(cambiaParaElCliente(web, { ...igual, id_mesa: "m2" })).toBe(true);
        expect(cambiaParaElCliente(web, { ...igual, id_mesa: null })).toBe(true);
        // Sin mesa antes y sin mesa ahora no es un cambio.
        expect(cambiaParaElCliente({ ...web, id_mesa: "" }, { ...igual, id_mesa: null })).toBe(false);
    });
});
