// test/reservasSolape.test.ts
//
// RI-61: una reserva ocupa su mesa durante su duración (la suya o la del negocio), y una comanda
// abierta la ocupa desde que se abrió. Es la comprobación previa de `POST /v1/reservas`; la Main
// hace la misma, con el mismo SQL, dentro de su transacción (`tests_solape` en `reservas.rs`).

import { describe, expect, it } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { conLaHoraDeQuienPregunta } from "../src/lib/tenantClient";
import { ajustesDeReserva, choqueEnLaMesa } from "../src/domains/reservas/reservas.queries";

/** Un tenant con una mesa y las sentencias dadas, y la hora de quien pregunta fijada. */
async function conMesa(nombre: string, seed: string[], prueba: (db: any) => Promise<void>) {
	await enElHub(nombre, async (hub: any) => {
		const sqlStorage = hub.state.storage.sql;
		crearEsquemaTenant(sqlStorage);
		sqlStorage.exec(`INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon');`);
		sqlStorage.exec(
			`INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
			 VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80);`,
		);
		for (const s of seed) sqlStorage.exec(s);
		await prueba(conLaHoraDeQuienPregunta(clienteLocal(hub.state.storage), "2026-05-10 20:30:00"));
	});
}

function reserva(dia: string, hora: string, duracion: number | null = null) {
	return { id_mesa: "m1", dia_ymd: dia, hora, duracion_min: duracion, id_reserva: null };
}

const R2100 = `INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado)
	VALUES ('r1', 'm1', '2026-05-10', '21:00', 'CENA', 2, 'PROXIMA');`;

describe("RI-61 · lo que se pisa en una mesa", () => {
	it("las 21:00 y las 21:15 se pisan; las 23:00 ya no (el fin no cuenta)", async () => {
		await conMesa("solape-basico", [R2100], async (db) => {
			expect(await choqueEnLaMesa(db, reserva("2026-05-10", "21:15"), 120)).toEqual({
				con: "reserva",
				texto: "Esa mesa ya tiene una reserva de 21:00 a 23:00.",
			});
			expect(await choqueEnLaMesa(db, reserva("2026-05-10", "23:00"), 120)).toBeNull();
			// Su propia duración manda: una de 30 min a las 20:30 acaba justo a las 21:00.
			expect(await choqueEnLaMesa(db, reserva("2026-05-10", "20:30", 30), 120)).toBeNull();
		});
	});

	it("una reserva de noche ocupa también el día siguiente", async () => {
		const noche = `INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado)
			VALUES ('r1', 'm1', '2026-05-10', '23:30', 'CENA', 2, 'PROXIMA');`;
		await conMesa("solape-noche", [noche], async (db) => {
			expect(await choqueEnLaMesa(db, reserva("2026-05-11", "00:30"), 120)).not.toBeNull();
		});
	});

	it("una cancelada no ocupa la mesa, y la propia reserva no choca consigo", async () => {
		await conMesa("solape-estados", [R2100], async (db) => {
			expect(
				await choqueEnLaMesa(db, { ...reserva("2026-05-10", "21:00"), id_reserva: "r1" }, 120),
			).toBeNull();
		});
		await conMesa(
			"solape-cancelada",
			[R2100, "UPDATE Reservas SET Estado = 'CANCELADA';"],
			async (db) => {
				expect(await choqueEnLaMesa(db, reserva("2026-05-10", "21:15"), 120)).toBeNull();
			},
		);
	});

	// RES-04: una comanda abierta ocupa la mesa todo el día de quien reserva (no el del servidor):
	// no se sabe cuándo se irá quien está sentado. Mañana sí se puede.
	it("una comanda abierta no deja reservar hoy a ninguna hora, y mañana sí", async () => {
		const comanda = `INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado)
			VALUES ('c1', 'm1', 'MESA', '2026-05-10 20:10:00', 'Abierta');`;
		await conMesa("solape-comanda", [comanda], async (db) => {
			const texto =
				"Esa mesa tiene una comanda abierta desde las 20:10: hoy no se puede reservar. Elige otra mesa u otro día.";
			for (const hora of ["20:45", "23:59", "09:00"]) {
				expect(await choqueEnLaMesa(db, reserva("2026-05-10", hora), 120), hora).toEqual({ con: "comanda", texto });
			}
			expect(await choqueEnLaMesa(db, reserva("2026-05-11", "00:30"), 120)).toBeNull();
		});
	});

	it("no cuenta la comanda de la propia reserva ni la de una que ya era de esa mesa ese día", async () => {
		const sentados = [
			R2100,
			`INSERT INTO Comandas (ID_Comanda, ID_Mesa, ID_Reserva, Canal, Fecha_Hora_Apertura, Estado)
			 VALUES ('c1', 'm1', 'r1', 'MESA', '2026-05-10 20:10:00', 'Abierta');`,
		];
		await conMesa("solape-comanda-propia", sentados, async (db) => {
			expect(await choqueEnLaMesa(db, { ...reserva("2026-05-10", "21:00"), id_reserva: "r1" }, 120)).toBeNull();
		});
		const ajena = [R2100, `INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado)
			 VALUES ('c1', 'm1', 'MESA', '2026-05-10 20:10:00', 'Abierta');`];
		await conMesa("solape-comanda-ya-era", ajena, async (db) => {
			// Cambiarle algo a la r1, que ya era de esa mesa ese día, no crea el choque.
			expect(await choqueEnLaMesa(db, { ...reserva("2026-05-10", "21:00"), id_reserva: "r1" }, 120)).toBeNull();
		});
	});

	it("los ajustes por defecto son 2 horas y avisar", async () => {
		await conMesa("solape-ajustes", [], async (db) => {
			expect(await ajustesDeReserva(db)).toEqual({ duracion: 120, modo: "avisar" });
		});
	});
});
