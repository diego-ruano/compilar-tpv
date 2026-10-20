// Reservas desde la web: cuándo hay que preguntar antes de cambiar o borrar una reserva, porque al
// cliente le llega un correo (docs/estudios/reservas-web.md §5.6). La misma regla que el caso de uso.
import { describe, expect, it } from "vitest";
import type { ReservaDto } from "@tpv/contracts";

import {
    cambiaParaElCliente,
    cancelarLeEscribe,
    correoTrasGuardar,
    esWebPorVenir,
} from "../src/features/reservas/reservaWeb";

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

/** El 20/10/2026 a las 17:30: la reserva de `web` (24/10 a las 21:00) aún está por venir. */
const ahora = new Date(2026, 9, 20, 17, 30);

describe("una reserva web que está por venir", () => {
    it("sólo la web y por venir avisa al cliente", () => {
        expect(esWebPorVenir(web, ahora)).toBe(true);
        expect(esWebPorVenir({ ...web, origen: "TPV" }, ahora)).toBe(false);
        for (const estado of ["ACTIVA", "FINALIZADA", "NO_SHOW", "CANCELADA"]) {
            expect(esWebPorVenir({ ...web, estado }, ahora), estado).toBe(false);
        }
    });

    it("una que ya pasó su hora no está por venir: su correo no saldría", () => {
        // La cola descarta el aviso de una reserva cuya hora ya ha pasado (`dia hora <= ahora`).
        expect(esWebPorVenir(web, new Date(2026, 9, 24, 20, 59))).toBe(true);
        expect(esWebPorVenir(web, new Date(2026, 9, 24, 21, 0))).toBe(false);
        expect(esWebPorVenir(web, new Date(2026, 9, 25, 9, 0))).toBe(false);
    });

    it("cancelarla sólo promete el correo si el cliente tiene a dónde", () => {
        expect(cancelarLeEscribe(web, ahora)).toBe(true);
        expect(cancelarLeEscribe({ ...web, email_cliente: null }, ahora)).toBe(false);
        expect(cancelarLeEscribe({ ...web, email_cliente: "  " }, ahora)).toBe(false);
        expect(cancelarLeEscribe({ ...web, origen: "TPV" }, ahora)).toBe(false);
    });

    it("el aviso de un cambio va al correo del cliente que lleve la reserva al guardar", () => {
        const escrito = { idCliente: null, nombreCliente: null, email: null };
        // Sin cliente (se le quitaron los datos), a nadie.
        expect(correoTrasGuardar(escrito, null)).toBeNull();
        // Uno que ya existe conserva el suyo; si no tiene, se queda con el escrito.
        expect(correoTrasGuardar({ ...escrito, idCliente: "c1" }, "ana@correo.es")).toBe("ana@correo.es");
        expect(correoTrasGuardar({ ...escrito, idCliente: "c1", email: "otro@correo.es" }, "ana@correo.es")).toBe("ana@correo.es");
        expect(correoTrasGuardar({ ...escrito, idCliente: "c1", email: "nuevo@correo.es" }, null)).toBe("nuevo@correo.es");
        expect(correoTrasGuardar({ ...escrito, idCliente: "c1" }, null)).toBeNull();
        // Uno nuevo, el escrito.
        expect(correoTrasGuardar({ ...escrito, nombreCliente: "Bea", email: "bea@correo.es" }, null)).toBe("bea@correo.es");
        expect(correoTrasGuardar({ ...escrito, nombreCliente: "Bea" }, null)).toBeNull();
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
