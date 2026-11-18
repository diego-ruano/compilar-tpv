// El aviso de una reserva lleva a ella: su `payload` (`{id_reserva, dia_ymd}`, que pone el emisor en
// Rust) pasa como estado de la navegación y Reservas abre ese día. Sin `payload`, o con uno que no
// vale, Reservas abre en hoy, como antes.
import { describe, expect, it } from "vitest";

import { destinoDeAccion } from "../src/features/notificaciones/acciones";
import { diaDeYmd, reservaAvisada } from "../src/features/reservas/calendario";

describe("el destino del aviso de una reserva", () => {
	it("lleva la reserva y su día en el estado de la navegación", () => {
		expect(destinoDeAccion("ver_reservas", '{"id_reserva":"r1","dia_ymd":"2027-03-14"}')).toEqual({
			to: "/Reservas",
			state: { reserva: { id_reserva: "r1", dia_ymd: "2027-03-14" } },
		});
	});

	it("sin un payload que valga, va a Reservas sin más (hoy)", () => {
		for (const malo of [null, undefined, "", "no es json", "{}", '{"id_reserva":"r1"}',
			'{"id_reserva":"","dia_ymd":"2027-03-14"}', '{"id_reserva":"r1","dia_ymd":"2027-02-30"}',
			'{"id_reserva":"r1","dia_ymd":"14/03/2027"}', "[1]", "null"]) {
			expect(destinoDeAccion("ver_reservas", malo), String(malo)).toEqual({ to: "/Reservas" });
		}
	});

	it("las demás acciones no miran el payload", () => {
		expect(destinoDeAccion("ver_tareas", '{"id_reserva":"r1","dia_ymd":"2027-03-14"}')).toEqual({ to: "/Tareas" });
		expect(destinoDeAccion("desconocida", null)).toBeNull();
	});
});

describe("el día de la reserva del aviso", () => {
	it("sólo un día que existe", () => {
		expect(diaDeYmd("2028-02-29")?.getDate()).toBe(29);
		expect(diaDeYmd("2027-02-29")).toBeNull();
		expect(diaDeYmd("2027-13-01")).toBeNull();
		expect(diaDeYmd(20270314)).toBeNull();
		const r = reservaAvisada({ reserva: { id_reserva: "r1", dia_ymd: "2027-03-14" } });
		expect(r && [r.dia.getFullYear(), r.dia.getMonth(), r.dia.getDate()]).toEqual([2027, 2, 14]);
		expect(reservaAvisada(null)).toBeNull();
		expect(reservaAvisada({ seccion: "LICENCIA" })).toBeNull();
	});
});
