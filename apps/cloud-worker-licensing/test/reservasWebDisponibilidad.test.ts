// test/reservasWebDisponibilidad.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.3): qué días, horas y mesas se pueden
// reservar. La lógica es pura (`disponibilidad.ts`); lo único que sale de Turso son los intervalos
// ocupados, y aquí se fija que dan lo mismo que el SQL de choque de la Main (`choqueEnLaMesa`).

import { describe, expect, it } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { conLaHoraDeQuienPregunta } from "../src/lib/tenantClient";
import { choqueEnLaMesa } from "../src/domains/reservas/reservas.queries";
import {
	alternativas,
	bitDelDia,
	diasAbiertos,
	franjaValeElDia,
	horaEnTramos,
	intervalo,
	libres,
	llegadasDeLaFranja,
	maxPersonas,
	mesasAdecuadas,
	motivoDelDia,
	seCruzan,
	sumarDias,
	tramosDelDia,
	type AjustesWeb,
	type FranjaWeb,
	type MesaWeb,
} from "../src/domains/reservas_web/disponibilidad";
import { ocupacionAlrededorDe } from "../src/domains/reservas_web/lecturas";
import { horaLocalEn } from "../src/domains/reservas_web/horaDelNegocio";

const AJUSTES: AjustesWeb = {
	activa: true,
	diasMin: 1,
	diasMax: 30,
	margenMin: 20,
	margenPlazas: 2,
	duracion: 120,
	zona: "Europe/Madrid",
};

function franja(id_mesa: string, desde: string, hasta: string, extra: Partial<FranjaWeb> = {}): FranjaWeb {
	return { id_mesa, dias_semana: 127, fecha_desde: null, fecha_hasta: null, hora_desde: desde, hora_hasta: hasta, ...extra };
}

const LUNES = "2026-11-16";
const DOMINGO = "2026-11-22";

describe("los días", () => {
	it("el bit de la máscara: 1 el lunes, 64 el domingo", () => {
		expect(bitDelDia(LUNES)).toBe(1);
		expect(bitDelDia("2026-11-17")).toBe(2);
		expect(bitDelDia(DOMINGO)).toBe(64);
	});

	it("desde mañana y hasta 30 días, sin los cerrados; con la web apagada, ninguno", () => {
		const hoy = "2026-11-10";
		const sinCierres = new Set<string>();
		expect(motivoDelDia(hoy, hoy, AJUSTES, sinCierres)).toBe("dia_no_reservable");
		expect(motivoDelDia("2026-11-11", hoy, AJUSTES, sinCierres)).toBeNull();
		expect(motivoDelDia(sumarDias(hoy, 30), hoy, AJUSTES, sinCierres)).toBeNull();
		expect(motivoDelDia(sumarDias(hoy, 31), hoy, AJUSTES, sinCierres)).toBe("dia_no_reservable");
		expect(motivoDelDia("2026-11-12", hoy, AJUSTES, new Set(["2026-11-12"]))).toBe("dia_no_reservable");
		expect(motivoDelDia("2026-11-12", hoy, { ...AJUSTES, activa: false }, sinCierres)).toBe("reserva_web_cerrada");
	});

	it("una franja vale los días de su máscara y entre sus fechas", () => {
		const soloLunes = franja("m1", "13:00", "16:00", { dias_semana: 1 });
		expect(franjaValeElDia(soloLunes, LUNES)).toBe(true);
		expect(franjaValeElDia(soloLunes, DOMINGO)).toBe(false);

		const noviembre = franja("m1", "13:00", "16:00", { fecha_desde: "2026-11-01", fecha_hasta: "2026-11-20" });
		expect(franjaValeElDia(noviembre, "2026-11-01")).toBe(true);
		expect(franjaValeElDia(noviembre, "2026-11-20")).toBe(true);
		expect(franjaValeElDia(noviembre, "2026-11-21")).toBe(false);
		expect(franjaValeElDia(noviembre, "2026-10-31")).toBe(false);
	});

	it("los días abiertos del horizonte son los que tienen algún tramo y no están cerrados", () => {
		const mesas = [{ id_mesa: "m1", capacidad: 4 }];
		const franjas = [franja("m1", "13:00", "16:00", { dias_semana: 1 })];
		const hoy = "2026-11-10";
		const dias = diasAbiertos(hoy, AJUSTES, new Set(["2026-11-23"]), mesas, franjas);
		// Los lunes del 11-11 al 10-12, menos el 23, que está cerrado.
		expect(dias).toEqual(["2026-11-16", "2026-11-30", "2026-12-07"]);
		expect(diasAbiertos(hoy, { ...AJUSTES, activa: false }, new Set(), mesas, franjas)).toEqual([]);
	});
});

describe("las horas de llegada", () => {
	it("la reserva entera dentro de la franja, con 20 minutos de tolerancia por cada lado", () => {
		// De 12 a 16 con dos horas de duración: se llega de 11:40 a 14:20.
		expect(llegadasDeLaFranja(franja("m1", "12:00", "16:00"), AJUSTES)).toEqual([11 * 60 + 40, 14 * 60 + 20]);
		// Una franja más corta que la duración y la tolerancia no deja llegar a ninguna hora.
		expect(llegadasDeLaFranja(franja("m1", "12:00", "13:00"), AJUSTES)).toBeNull();
	});

	it("los tramos del día son la unión de los de cada mesa", () => {
		const mesas: MesaWeb[] = [
			{ id_mesa: "m1", capacidad: 2 },
			{ id_mesa: "m2", capacidad: 4 },
		];
		const franjas = [
			franja("m1", "12:00", "16:00"),
			franja("m2", "13:00", "17:00"),
			franja("m1", "20:00", "23:30"),
			// De una mesa que no se puede reservar: no cuenta.
			franja("m9", "08:00", "11:00"),
		];
		const tramos = tramosDelDia(mesas, franjas, LUNES, AJUSTES);
		expect(tramos).toEqual([
			{ desde: "11:40", hasta: "15:20" },
			{ desde: "19:40", hasta: "21:50" },
		]);
		expect(horaEnTramos(tramos, "11:40")).toBe(true);
		expect(horaEnTramos(tramos, "15:21")).toBe(false);
		expect(horaEnTramos(tramos, "21:50")).toBe(true);
	});

	it("una franja que acaba a medianoche no deja llegar más tarde de lo que cabe", () => {
		const tramos = tramosDelDia([{ id_mesa: "m1", capacidad: 2 }], [franja("m1", "20:00", "23:59")], LUNES, AJUSTES);
		expect(tramos).toEqual([{ desde: "19:40", hasta: "22:19" }]);
	});
});

describe("las mesas", () => {
	const mesas: MesaWeb[] = [
		{ id_mesa: "m2", capacidad: 2 },
		{ id_mesa: "m4", capacidad: 4 },
		{ id_mesa: "m6", capacidad: 6 },
		{ id_mesa: "m7", capacidad: 7 },
	];
	const franjas = mesas.map((m) => franja(m.id_mesa, "20:00", "23:30"));

	it("para N personas, de N a N + 2 plazas", () => {
		const ids = (n: number) => mesasAdecuadas(mesas, franjas, LUNES, "21:00", n, AJUSTES).map((m) => m.id_mesa);
		expect(ids(2)).toEqual(["m2", "m4"]);
		expect(ids(4)).toEqual(["m4", "m6"]);
		expect(ids(5)).toEqual(["m6", "m7"]);
		expect(ids(8)).toEqual([]);
		expect(maxPersonas(mesas, franjas)).toBe(7);
	});

	it("la franja es de cada mesa: una que no cubre la hora no vale", () => {
		const otras = [...franjas.filter((f) => f.id_mesa !== "m4"), franja("m4", "13:00", "16:00")];
		expect(mesasAdecuadas(mesas, otras, LUNES, "21:00", 2, AJUSTES).map((m) => m.id_mesa)).toEqual(["m2"]);
	});

	it("una mesa ocupada no está libre; el fin de una reserva no ocupa", () => {
		const candidatas = mesasAdecuadas(mesas, franjas, LUNES, "21:00", 2, AJUSTES);
		const ocupada = { id_mesa: "m2", ...intervalo(LUNES, "19:00", 120) };
		expect(libres(candidatas, [ocupada], LUNES, "21:00", 120).map((m) => m.id_mesa)).toEqual(["m2", "m4"]);
		const pisa = { id_mesa: "m2", ...intervalo(LUNES, "19:15", 120) };
		expect(libres(candidatas, [pisa], LUNES, "21:00", 120).map((m) => m.id_mesa)).toEqual(["m4"]);
	});

	it("una reserva de la noche anterior pisa la madrugada", () => {
		const noche = intervalo("2026-11-15", "23:30", 120);
		expect(noche).toEqual({ inicio: "2026-11-15 23:30:00", fin: "2026-11-16 01:30:00" });
		expect(seCruzan(noche, intervalo(LUNES, "00:30", 120))).toBe(true);
		expect(seCruzan(noche, intervalo(LUNES, "01:30", 120))).toBe(false);
	});

	it("las alternativas: hasta cuatro horas cercanas que tienen mesa, ordenadas", () => {
		const conMesa = new Set(["20:00", "20:15", "21:45", "22:00", "19:45"]);
		expect(alternativas("21:00", (h) => conMesa.has(h))).toEqual(["20:00", "20:15", "21:45", "22:00"]);
		expect(alternativas("21:00", () => false)).toEqual([]);
		// No se sale del día.
		expect(alternativas("00:10", () => true)).toEqual(["00:25", "00:40", "00:55", "01:10"]);
	});
});

describe("la hora del negocio", () => {
	it("es la de pared de su zona, con el cambio de hora", () => {
		// 2026-07-01 10:00 UTC: en Madrid son las 12 (verano) y en Canarias las 11.
		const julio = Date.UTC(2026, 6, 1, 10, 0, 0);
		expect(horaLocalEn("Europe/Madrid", julio)).toBe("2026-07-01 12:00:00");
		expect(horaLocalEn("Atlantic/Canary", julio)).toBe("2026-07-01 11:00:00");
		// En enero, una hora menos.
		expect(horaLocalEn("Europe/Madrid", Date.UTC(2026, 0, 15, 23, 30, 0))).toBe("2026-01-16 00:30:00");
		// Una zona que no existe cae en la de por defecto.
		expect(horaLocalEn("Marte/Olympus", julio)).toBe("2026-07-01 12:00:00");
	});
});

describe("los intervalos de Turso dan lo mismo que el SQL de choque de la Main", () => {
	// Para cada hora pedida, ¿choca? Por `choqueEnLaMesa` (el SQL de la Main) y por
	// `ocupacionAlrededorDe` + `seCruzan` (lo que usa la agenda). Tienen que coincidir siempre.
	const SEMILLA = [
		`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado)
		 VALUES ('r1', 'm1', '2026-05-10', '21:00', 'CENA', 2, 'PROXIMA');`,
		`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Duracion_Min, Estado)
		 VALUES ('r2', 'm1', '2026-05-10', '14:00', 'COMIDA', 2, 45, 'ACTIVA');`,
		`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado)
		 VALUES ('r3', 'm1', '2026-05-09', '23:30', 'CENA', 2, 'PROXIMA');`,
		`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado)
		 VALUES ('r4', 'm1', '2026-05-10', '17:00', 'CENA', 2, 'CANCELADA');`,
		`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado)
		 VALUES ('r5', 'm1', '2026-05-11', '00:15', 'CENA', 2, 'PROXIMA');`,
		`INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado)
		 VALUES ('c1', 'm1', 'MESA', '2026-05-10 09:10:00', 'Abierta');`,
	];
	const HORAS = ["00:00", "00:45", "01:00", "01:30", "09:00", "10:30", "13:00", "13:15", "14:30", "14:45", "16:00", "17:00", "18:59", "19:00", "19:01", "21:30", "22:59", "23:00", "23:30"];

	it("en cada hora del día", async () => {
		await enElHub("rw-equivalencia-choque", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sql.exec(`INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon');`);
			sql.exec(
				`INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
				 VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80);`,
			);
			for (const s of SEMILLA) sql.exec(s);
			// A las 10:00 de quien pregunta, la comanda abierta desde las 09:10 ocupa hasta las 11:10.
			const db = conLaHoraDeQuienPregunta(clienteSobre(sql), "2026-05-10 10:00:00");

			const { ocupaciones, ids } = await ocupacionAlrededorDe(db, "2026-05-10", 120);
			expect([...ids].sort()).toEqual(["r1", "r2", "r3", "r4", "r5"]);

			const distintas: string[] = [];
			let chocan = 0;
			for (const hora of HORAS) {
				const main = (await choqueEnLaMesa(db, { id_mesa: "m1", dia_ymd: "2026-05-10", hora, duracion_min: null, id_reserva: null }, 120)) !== null;
				const agenda = ocupaciones.some((o) => o.id_mesa === "m1" && seCruzan(o, intervalo("2026-05-10", hora, 120)));
				if (main !== agenda) distintas.push(`${hora}: Main ${main}, agenda ${agenda}`);
				if (main) chocan++;
			}
			expect(distintas).toEqual([]);
			// Que la tabla mire las dos cosas: horas que chocan y horas que no.
			expect(chocan).toBeGreaterThan(3);
			expect(chocan).toBeLessThan(HORAS.length - 3);
		});
	});
});
