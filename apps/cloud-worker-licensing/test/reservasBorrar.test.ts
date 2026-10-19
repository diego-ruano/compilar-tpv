// test/reservasBorrar.test.ts
//
// Borrar una reserva desde la Handy (docs/estudios/reservas-web.md §5.6): una reserva web que está
// por venir se cancela; las demás se borran. Lo decide la ruta al leerla, y el comando lleva sólo la
// sentencia elegida, sin condición: lo que se replica a la Main se vuelve a evaluar allí, donde la
// reserva puede estar en otro estado, y una sentencia condicionada haría allí otra cosa. El efecto
// lo fijan los casos de contrato `reservas/eliminar*`; aquí, qué se replica.

import { describe, expect, it } from "vitest";

import { deleteReserva } from "../src/domains/reservas/reservas.commands";

const sentencias = (cancelarWeb: boolean) =>
	(deleteReserva("r1", cancelarWeb).command as any).payload.steps.map((s: any) => s.sql);

describe("borrar una reserva", () => {
	it("una web por venir: sólo la cancelación, sin condición", () => {
		expect(sentencias(true)).toEqual(["UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?1;"]);
	});

	it("las demás: desvincular sus comandas y borrarla, sin condición", () => {
		expect(sentencias(false)).toEqual([
			"UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
			"DELETE FROM Reservas WHERE ID_Reserva = ?1;",
		]);
	});
});
