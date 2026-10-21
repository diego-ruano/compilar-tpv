// test/reservaEnElPlano.test.ts
//
// MESAS-02: el plano de la Handy enseña las reservas como el de la Main. La regla, contra la tabla
// que comparte con Rust (`crates/tpv-domain/src/plano_reservas_casos.json`), y la lectura entera
// (`mesasMetaAll`) contra el esquema de verdad, con «ahora» fijado como lo fija `tenantQuery` con el
// `X-Client-Now` de la Handy. El arnés de lectura no lo ve: siembra fechas fijas y aquí todo depende
// de la hora.

import { describe, expect, it } from "vitest";

import casos from "../../../crates/tpv-domain/src/plano_reservas_casos.json";
import { mesasMetaAll } from "../src/domains/mesas/mesas.queries";
import { reservaDeCadaMesa, type ReservaDeMesa } from "../src/domains/mesas/reservaEnElPlano";
import { conLaHoraDeQuienPregunta } from "../src/lib/tenantClient";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

describe("la reserva de cada mesa cuadra con la tabla compartida", () => {
	it.each(casos.casos)("$nombre", (caso) => {
		const reservas: ReservaDeMesa[] = caso.reservas.map((r) => ({ ...r, cliente: "" }));
		const ensena = Object.fromEntries(
			[...reservaDeCadaMesa(reservas, caso.ahora)].map(([mesa, r]) => [
				mesa,
				{ id_reserva: r.reserva.id_reserva, estado: r.estado, minutos_para: r.minutos_para },
			]),
		);
		expect(ensena).toEqual(caso.ensena);
	});

	it("sin una hora válida no enseña ninguna", () => {
		const reserva: ReservaDeMesa = {
			id_mesa: "m1", id_reserva: "r1", cliente: "", dia_ymd: "2026-10-21", hora: "20:00", estado: "ACTIVA", duracion_min: null,
		};
		expect(reservaDeCadaMesa([reserva], "").size).toBe(0);
		expect(reservaDeCadaMesa([reserva], "2026-10-21T20:00:00").size).toBe(0);
	});
});

describe("el plano de la Handy trae las reservas", () => {
	it("con la hora de la Handy, la duración del negocio y el cliente si lo tiene", async () => {
		await enElHub("plano-reservas", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec(`
				INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon');
				INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
				VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80), ('m2', 'z1', '2', 4, 0, 0, 'rect', 80, 80),
				       ('m3', 'z1', '3', 4, 0, 0, 'rect', 80, 80), ('m4', 'z1', '4', 4, 0, 0, 'rect', 80, 80),
				       ('m5', 'z1', '5', 4, 0, 0, 'rect', 80, 80), ('m6', 'z1', '6', 4, 0, 0, 'rect', 80, 80);
				UPDATE Business_Settings SET Reserva_Duracion_Min = 60 WHERE ID = 1;
				INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('c1', 'Ana');
				INSERT INTO Reservas (ID_Reserva, ID_Mesa, ID_Cliente, Dia_YMD, Hora, Turno, Comensales, Estado, Duracion_Min) VALUES
				  ('tarde', 'm1', NULL, '2026-10-21', '19:30', 'CENA', 2, 'PROXIMA', NULL),
				  ('pronto', 'm2', 'c1', '2026-10-21', '20:30', 'CENA', 2, 'PROXIMA', NULL),
				  ('sentada', 'm3', NULL, '2026-10-21', '15:00', 'CENA', 2, 'ACTIVA', NULL),
				  ('del-negocio', 'm4', NULL, '2026-10-21', '18:30', 'CENA', 2, 'PROXIMA', NULL),
				  ('con-la-suya', 'm5', NULL, '2026-10-21', '18:30', 'CENA', 2, 'PROXIMA', 120),
				  ('cancelada', 'm6', NULL, '2026-10-21', '20:10', 'CENA', 2, 'CANCELADA', NULL);
				INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado)
				VALUES ('com-1', 'MESA', 'm3', '2026-10-21 15:05:00', 'Abierta');
			`);
			const db = conLaHoraDeQuienPregunta(clienteSobre(sql, hub.state.storage) as any, "2026-10-21 20:00:00");

			const meta = await mesasMetaAll(db);

			expect(meta.m1?.reserva).toEqual({
				idReserva: "tarde", clienteNombre: "", diaYMD: "2026-10-21", hora: "19:30", estado: "PROXIMA", minutosPara: -30,
			});
			expect(meta.m1).toMatchObject({ ocupada: false, estado: "LIBRE", id_comanda: "", totalPendiente: 0 });
			expect(meta.m2?.reserva).toMatchObject({ idReserva: "pronto", clienteNombre: "Ana", minutosPara: 30 });
			// La mesa con la comanda abierta conserva lo suyo y suma la reserva sentada.
			expect(meta.m3).toMatchObject({ ocupada: true, id_comanda: "com-1", reserva: { idReserva: "sentada", estado: "ACTIVA" } });
			// Hace hora y media: el negocio da 60 minutos y esta reserva no trae los suyos.
			expect(meta.m4).toBeUndefined();
			expect(meta.m5?.reserva).toMatchObject({ idReserva: "con-la-suya", minutosPara: -90 });
			expect(meta.m6).toBeUndefined();
		});
	});
});
