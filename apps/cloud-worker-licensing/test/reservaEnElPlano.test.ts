// test/reservaEnElPlano.test.ts
//
// MESAS-02: el plano de la Handy enseña las reservas como el de la Main. La regla, contra la tabla
// que comparte con Rust (`crates/tpv-domain/src/plano_reservas_casos.json`), y la lectura entera
// (`mesasMetaAll`) contra el esquema de verdad, con la hora de la Handy (su `X-Client-Now`) y el reloj
// del worker fijados. El arnés de lectura sólo compara lo que no depende de la hora.

import { describe, expect, it } from "vitest";

import casos from "../../../crates/tpv-domain/src/plano_reservas_casos.json";
import { mesasMetaAll } from "../src/domains/mesas/mesas.queries";
import {
	ahoraEnZona,
	horaLocalDeTexto,
	instanteEnZona,
	reservaDeCadaMesa,
	segundosHastaElProximoCambio,
	type Instante,
	type ReservaDeMesa,
} from "../src/domains/mesas/reservaEnElPlano";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

type Cambio = { local: string; antes_min: number; despues_min: number };

/**
 * La zona de un caso, como en el test de Rust: sin cambio de hora, la hora local es la UTC. Con uno,
 * el desfase es `antes_min` hasta la hora local `local` y `despues_min` desde ahí.
 */
function zonaDelCaso(cambio: Cambio | undefined): Instante {
	if (!cambio) return (local) => local;
	const antes = cambio.antes_min * 60_000;
	const despues = cambio.despues_min * 60_000;
	const en = horaLocalDeTexto(cambio.local)! - antes;
	return (local) => {
		const vale = [local - antes].filter((t) => t < en).concat([local - despues].filter((t) => t >= en));
		return vale.length ? Math.min(...vale) : null;
	};
}

describe("la reserva de cada mesa cuadra con la tabla compartida", () => {
	it.each(casos.casos)("$nombre", (caso) => {
		const reservas: ReservaDeMesa[] = caso.reservas.map((r) => ({ ...r, cliente: "" }));
		const { cambio_de_hora, ahora_utc } = caso as { cambio_de_hora?: Cambio; ahora_utc?: string };
		const instante = zonaDelCaso(cambio_de_hora);
		const ahora = ahora_utc ? horaLocalDeTexto(ahora_utc)! : instante(horaLocalDeTexto(caso.ahora!)!)!;
		expect(caso).toHaveProperty("proximo_cambio_s");
		expect(segundosHastaElProximoCambio(reservas, ahora, instante)).toBe(caso.proximo_cambio_s);
		const ensena = Object.fromEntries(
			[...reservaDeCadaMesa(reservas, ahora, instante)].map(([mesa, r]) => [
				mesa,
				{ id_reserva: r.reserva.id_reserva, estado: r.estado, minutos_para: r.minutos_para },
			]),
		);
		expect(ensena).toEqual(caso.ensena);
	});
});

describe("las horas locales de una zona, con su cambio de hora", () => {
	const madrid = instanteEnZona("Europe/Madrid");
	const utc = (s: string) => Date.parse(s.replace(" ", "T") + "Z");
	const local = (s: string) => horaLocalDeTexto(s)!;

	it("en invierno y en verano, con su desfase", () => {
		expect(madrid(local("2026-01-15 20:00:00"))).toBe(utc("2026-01-15 19:00:00"));
		expect(madrid(local("2026-07-15 20:00:00"))).toBe(utc("2026-07-15 18:00:00"));
	});

	it("la hora que se salta al adelantar el reloj no existe", () => {
		// 28 de marzo de 2027: de las 02:00 se pasa a las 03:00.
		expect(madrid(local("2027-03-28 01:59:00"))).toBe(utc("2027-03-28 00:59:00"));
		expect(madrid(local("2027-03-28 02:30:00"))).toBeNull();
		expect(madrid(local("2027-03-28 03:00:00"))).toBe(utc("2027-03-28 01:00:00"));
	});

	it("la que se repite al retrasarlo es la primera", () => {
		// 25 de octubre de 2026: de las 03:00 se vuelve a las 02:00.
		expect(madrid(local("2026-10-25 02:30:00"))).toBe(utc("2026-10-25 00:30:00"));
		expect(madrid(local("2026-10-25 03:00:00"))).toBe(utc("2026-10-25 02:00:00"));
	});

	it("«ahora», en la hora que se repite, es la vez más cercana al reloj del worker", () => {
		const dosYMedia = local("2026-10-25 02:30:00");
		// La Handy manda las 02:30 sin desfase: la primera vez son las 00:30 UTC; la segunda, las 01:30.
		expect(ahoraEnZona("Europe/Madrid", dosYMedia, utc("2026-10-25 00:31:00"))).toBe(utc("2026-10-25 00:30:00"));
		expect(ahoraEnZona("Europe/Madrid", dosYMedia, utc("2026-10-25 01:29:00"))).toBe(utc("2026-10-25 01:30:00"));
		// Fuera de esa hora sólo hay una, aunque el reloj del worker vaya con minutos de diferencia.
		expect(ahoraEnZona("Europe/Madrid", local("2026-10-21 20:00:00"), utc("2026-10-21 18:03:00"))).toBe(utc("2026-10-21 18:00:00"));
		// Un reloj en la hora que se salta no es ninguna: manda el del worker.
		expect(ahoraEnZona("Europe/Madrid", local("2027-03-28 02:30:00"), utc("2027-03-28 00:31:00"))).toBe(utc("2027-03-28 00:31:00"));
	});

	it("una zona que no existe cuenta como la de por defecto", () => {
		expect(instanteEnZona("Marte/Olympus")(local("2026-07-15 20:00:00"))).toBe(utc("2026-07-15 18:00:00"));
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
				UPDATE Business_Settings SET Reserva_Duracion_Min = 60, Zona_Horaria = 'Europe/Madrid' WHERE ID = 1;
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
			const db = clienteSobre(sql, hub.state.storage) as any;
			// Las 20:00 en Madrid, que son las 18:00 UTC.
			const reloj = Date.UTC(2026, 9, 21, 18, 0, 0);

			const plano = await mesasMetaAll(db, "2026-10-21 20:00:00", reloj);
			const meta = plano.mesas;
			// Sin la hora de la Handy, la del worker: lo mismo, y no la de Turso leída como de Madrid.
			expect(await mesasMetaAll(db, null, reloj)).toEqual(plano);
			// La que llega a las 20:30 enseña «en 30 min», que pasa a 29 en un segundo.
			expect(plano.proximo_cambio_s).toBe(1);

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
