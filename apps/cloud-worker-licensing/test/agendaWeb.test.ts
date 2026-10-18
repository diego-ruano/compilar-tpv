// test/agendaWeb.test.ts
//
// La agenda de reservas web (`AgendaWeb`, docs/estudios/reservas-web.md §4.3) contra SQL de verdad:
// la base del negocio con el esquema real (`0001_inicial.sql`) y el SQLite de la propia agenda.
// Lo que se fija aquí:
//   · dos altas a la vez para la misma mesa: gana una;
//   · lo que espera en la agenda ocupa su mesa hasta que aparece en Turso, y entonces se olvidan sus
//     datos personales;
//   · los topes (10 vivas por correo, el máximo de altas por negocio);
//   · cancelar antes y después de que la Main la tenga, y hasta la hora de la reserva;
//   · ninguna respuesta lleva datos personales;
//   · la alarma purga lo cerrado y lo caducado.

import { describe, expect, it } from "vitest";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enLaAgenda, lectorSobre, stubDeLaAgenda } from "./helpers/agenda";
import { sumarDias } from "../src/domains/reservas_web/disponibilidad";
import { horaLocalEn } from "../src/domains/reservas_web/horaDelNegocio";
import { AgendaWeb } from "../src/durableObjects/agendaWeb";
import { MAX_ALTAS_DIA_NEGOCIO, MAX_RESERVAS_POR_CORREO, codigoDeReserva } from "../src/durableObjects/agendaWeb.motor";

// Fechas relativas al reloj de verdad: la agenda mira `Date.now()` para caducar los enlaces.
const AHORA = horaLocalEn("Europe/Madrid", Date.now());
const HOY = AHORA.slice(0, 10);
const DIA = sumarDias(HOY, 3);
const T = "t1";

function sembrarNegocio(sql: SqlStorage): void {
	crearEsquemaTenant(sql);
	sql.exec(`UPDATE Business_Settings SET Reserva_Web_Activa = 1 WHERE ID = 1;`);
	sql.exec(`INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon');`);
	for (const [id, cap] of [["m2", 2], ["m4", 4], ["m6", 6]] as const) {
		sql.exec(
			`INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
			 VALUES (?, 'z1', ?, ?, 0, 0, 'rect', 80, 80);`,
			id,
			id.slice(1),
			cap,
		);
		sql.exec(`INSERT INTO Reserva_Web_Mesas (ID_Mesa, Activa) VALUES (?, 1);`, id);
		sql.exec(
			`INSERT INTO Reserva_Web_Franjas (ID_Franja, ID_Mesa, Dias_Semana, Hora_Desde, Hora_Hasta)
			 VALUES (?, ?, 127, '20:00', '23:30');`,
			`f-${id}`,
			id,
		);
	}
}

/** Una agenda con su negocio sembrado y el lector de Turso sobre él. */
async function conAgenda(
	nombre: string,
	prueba: (motor: any, sql: SqlStorage, state: DurableObjectState) => Promise<void>,
	opciones: { ahora?: () => string; espera?: number } = {},
) {
	await enLaAgenda(nombre, async (motor, state) => {
		const sql = state.storage.sql;
		sembrarNegocio(sql);
		motor.leer = lectorSobre(state, opciones.ahora ?? (() => AHORA), opciones.espera ?? 0);
		await prueba(motor, sql, state);
	});
}

function alta(extra: Record<string, unknown> = {}) {
	return {
		dia_ymd: DIA,
		hora: "21:00",
		personas: 2,
		id_mesa: "m2",
		nombre: "Ana Pérez",
		email: "ana@correo.es",
		telefono: "600112233",
		nota: "Silla para bebé",
		...extra,
	};
}

const PERSONALES = ["Ana", "ana@correo.es", "600112233", "bebé"];

function sinDatosPersonales(respuesta: unknown) {
	const texto = JSON.stringify(respuesta);
	for (const p of PERSONALES) expect(texto, p).not.toContain(p);
}

describe("la agenda de reservas web", () => {
	it("sólo expone por RPC lo que llaman las rutas, y la alarma (RI-45)", () => {
		expect(Object.getOwnPropertyNames(AgendaWeb.prototype).sort()).toEqual(
			["constructor", "disponibles", "reservar", "consultarEnlace", "cancelar", "alarm"].sort(),
		);
	});

	it("ofrece las mesas adecuadas y libres, y lo pendiente ocupa su mesa", async () => {
		await conAgenda("agenda-basico", async (motor) => {
			const antes = await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:00", personas: 2 });
			expect(antes).toEqual({ ok: true, mesas: ["m2", "m4"], alternativas: [] });

			const r = await motor.reservar({ tenantId: T, alta: alta() });
			expect(r).toMatchObject({ ok: true, dia: DIA, hora: "21:00", personas: 2, mesa: "2" });
			expect(r.codigo).toBe(codigoDeReserva(r.id_reserva));

			const despues = await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:30", personas: 2 });
			expect(despues.mesas).toEqual(["m4"]);
			sinDatosPersonales(despues);
			expect(motor.negocio()).toBe(T);
		});
	});

	it("dos altas a la vez para la misma mesa: gana una y la otra sabe que se ha ocupado", async () => {
		const nombre = "agenda-simultaneas";
		await conAgenda(nombre, async () => {}, { espera: 5 });
		// Por RPC, como en producción: las dos entran en el objeto a la vez y cada lectura de Turso
		// cede el turno, así que las dos leen la mesa libre antes de que ninguna la apunte.
		const stub = stubDeLaAgenda(nombre);
		const resultados = await Promise.all([
			stub.reservar({ tenantId: T, alta: alta({ email: "uno@correo.es" }) }),
			stub.reservar({ tenantId: T, alta: alta({ email: "dos@correo.es" }) }),
			stub.reservar({ tenantId: T, alta: alta({ email: "tres@correo.es", id_mesa: "m4" }) }),
		]);
		expect(resultados.map((r: any) => r.ok).sort()).toEqual([false, true, true]);
		expect(resultados.filter((r: any) => !r.ok)).toEqual([{ ok: false, error: "mesa_no_disponible", status: 409 }]);
		await enLaAgenda(nombre, (_motor, state) => {
			const n = state.storage.sql.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE id_mesa = 'm2';`).toArray()[0] as any;
			expect(n.n).toBe(1);
		});
	});

	it("una lectura vieja de Turso no pierde el alta que otra petición acaba de dar por vista", async () => {
		// El cruce: A lee Turso cuando la Main todavía no ha subido el alta X; mientras A espera la
		// respuesta, X llega a Turso y otra petición (B) la ve y la da por vista. Para la lectura de A
		// X no está en Turso, y ya no está pendiente: si nadie la contara, A se llevaría su mesa.
		await conAgenda("agenda-lectura-vieja", async (motor, sql, state) => {
			const x = await motor.reservar({ tenantId: T, alta: alta({ email: "x@correo.es" }) });

			let avisarLeido!: () => void;
			const leido = new Promise<void>((r) => (avisarLeido = r));
			let soltar!: () => void;
			const suelta = new Promise<void>((r) => (soltar = r));
			const normal = lectorSobre(state, () => AHORA);
			motor.leer = async (tenantId: string, fn: any) => {
				const resultado = await normal(tenantId, fn);
				avisarLeido();
				await suelta;
				return resultado;
			};
			const a = motor.reservar({ tenantId: T, alta: alta({ email: "a@correo.es" }) });
			await leido;

			motor.leer = normal;
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
				 VALUES (?, 'm2', ?, '21:00', 'CENA', 2, 'PROXIMA', 'WEB');`,
				x.id_reserva,
				DIA,
			);
			expect((await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:00", personas: 2 })).mesas).toEqual(["m4"]);
			expect((sql.exec(`SELECT estado FROM peticiones WHERE id_reserva = ?;`, x.id_reserva).toArray()[0] as any).estado).toBe("vista");

			soltar();
			expect(await a).toEqual({ ok: false, error: "mesa_no_disponible", status: 409 });
		});
	});

	it("una reserva de Turso ocupa la mesa; si no queda ninguna, propone horas cercanas", async () => {
		await conAgenda("agenda-alternativas", async (motor, sql) => {
			for (const m of ["m2", "m4"]) {
				sql.exec(
					`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Duracion_Min, Estado)
					 VALUES (?, ?, ?, '21:00', 'CENA', 2, 30, 'PROXIMA');`,
					`r-${m}`,
					m,
					DIA,
				);
			}
			const r = await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:00", personas: 2 });
			// Ocupadas de 21:00 a 21:30; dos horas desde las 21:30 o las 21:45 caben (hasta las 23:50),
			// y las de antes pisan la de las 21:00.
			expect(r).toEqual({ ok: true, mesas: [], alternativas: ["21:30", "21:45"] });
			expect((await motor.reservar({ tenantId: T, alta: alta() })).error).toBe("mesa_no_disponible");
		});
	});

	it("rechaza un día fuera del horizonte, un día cerrado, una hora fuera de franja y la web apagada", async () => {
		await conAgenda("agenda-rechazos", async (motor, sql) => {
			const pedir = (dia: string, hora = "21:00") => motor.disponibles({ tenantId: T, dia, hora, personas: 2 });
			expect((await pedir(HOY)).error).toBe("dia_no_reservable");
			expect((await pedir(sumarDias(HOY, 31))).error).toBe("dia_no_reservable");
			expect((await pedir(DIA, "17:00")).error).toBe("hora_fuera_de_franja");

			sql.exec(`INSERT INTO Reserva_Web_Cierres (ID_Cierre, Dia_YMD) VALUES ('c1', ?);`, DIA);
			expect((await pedir(DIA)).error).toBe("dia_no_reservable");
			expect((await motor.reservar({ tenantId: T, alta: alta() })).error).toBe("dia_no_reservable");

			sql.exec(`UPDATE Business_Settings SET Reserva_Web_Activa = 0;`);
			expect(await pedir(sumarDias(HOY, 4))).toEqual({ ok: false, error: "reserva_web_cerrada", status: 409 });
		});
	});

	it("una mesa archivada, con la casilla quitada o de otra capacidad no se puede reservar", async () => {
		await conAgenda("agenda-mesa-no-vale", async (motor, sql) => {
			expect((await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "m6" }) })).error).toBe("mesa_no_disponible");
			sql.exec(`UPDATE Reserva_Web_Mesas SET Activa = 0 WHERE ID_Mesa = 'm2';`);
			expect((await motor.reservar({ tenantId: T, alta: alta() })).error).toBe("mesa_no_disponible");
			sql.exec(`UPDATE Mesas SET Archivada_En = '2026-01-01 00:00:00' WHERE ID_Mesa = 'm4';`);
			expect((await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "m4" }) })).error).toBe("mesa_no_disponible");
			expect((await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "no-existe" }) })).error).toBe("mesa_no_disponible");
		});
	});

	it("cuando la reserva aparece en Turso se da por vista: deja de contarse aquí y se olvidan sus datos", async () => {
		await conAgenda("agenda-vista", async (motor, sql) => {
			const r = await motor.reservar({ tenantId: T, alta: alta() });
			const fila = () => sql.exec(`SELECT estado, datos_json FROM peticiones WHERE id_reserva = ?;`, r.id_reserva).toArray()[0] as any;
			expect(fila().estado).toBe("pendiente");
			expect(JSON.parse(fila().datos_json)).toEqual({ nombre: "Ana Pérez", email: "ana@correo.es", telefono: "600112233", nota: "Silla para bebé" });

			// La Main la registra (con el id que puso la agenda) y llega a Turso.
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
				 VALUES (?, 'm2', ?, '21:00', 'CENA', 2, 'PROXIMA', 'WEB');`,
				r.id_reserva,
				DIA,
			);
			await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:00", personas: 2 });
			expect(fila()).toEqual({ estado: "vista", datos_json: null });

			// El restaurante la cancela en el TPV: la mesa queda libre aunque la agenda la tuviera.
			sql.exec(`UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?;`, r.id_reserva);
			expect((await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:00", personas: 2 })).mesas).toEqual(["m2", "m4"]);
		});
	});

	it("no más de 10 reservas vivas por correo, contando Turso y lo que espera aquí", async () => {
		await conAgenda("agenda-tope-correo", async (motor, sql) => {
			// Dos en Turso, de un cliente con ese correo (en mayúsculas: cuenta igual).
			sql.exec(`INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('c1', 'Ana', 'ANA@correo.es');`);
			for (const n of [5, 6]) {
				sql.exec(
					`INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado)
					 VALUES (?, 'c1', 'm6', ?, '13:00', 'COMIDA', 2, 'PROXIMA');`,
					`t-${n}`,
					sumarDias(HOY, n),
				);
			}
			for (let i = 0; i < MAX_RESERVAS_POR_CORREO - 2; i++) {
				const r = await motor.reservar({ tenantId: T, alta: alta({ dia_ymd: sumarDias(HOY, 2 + i) }) });
				expect(r.ok, `alta ${i}`).toBe(true);
			}
			const otra = await motor.reservar({ tenantId: T, alta: alta({ dia_ymd: sumarDias(HOY, 20) }) });
			expect(otra).toEqual({ ok: false, error: "limite_reservas_correo", status: 409 });
			// Otro correo sí puede.
			expect((await motor.reservar({ tenantId: T, alta: alta({ dia_ymd: sumarDias(HOY, 20), email: "otro@correo.es" }) })).ok).toBe(true);
		});
	});

	it("un tope de altas por negocio en 24 horas, detrás del limitador por IP", async () => {
		await conAgenda("agenda-tope-negocio", async (motor, sql) => {
			const ahora = Date.now();
			for (let i = 0; i < MAX_ALTAS_DIA_NEGOCIO; i++) {
				sql.exec(
					`INSERT INTO peticiones (id_peticion, tipo, id_reserva, dia_ymd, hora, comensales, creada_local, creada_ms, estado)
					 VALUES (?, 'alta', ?, '2000-01-01', '13:00', 2, '2000-01-01 00:00:00', ?, 'vista');`,
					`p${i}`,
					`r${i}`,
					ahora - 1000,
				);
			}
			expect(await motor.reservar({ tenantId: T, alta: alta() })).toEqual({ ok: false, error: "tope_reservas_negocio", status: 429 });
		});
	});

	it("cancelar antes de que la Main la tenga la anula aquí y deja libre la mesa", async () => {
		await conAgenda("agenda-cancelar-pendiente", async (motor, sql) => {
			const r = await motor.reservar({ tenantId: T, alta: alta() });
			const consulta = await motor.consultarEnlace({ tenantId: T, token: r.token });
			expect(consulta).toEqual({ ok: true, dia: DIA, hora: "21:00", personas: 2, mesa: "2", estado: "confirmada", cancelable: true });
			sinDatosPersonales(consulta);

			expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({ ok: true });
			// Dos veces es lo mismo.
			expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({ ok: true });
			const fila = sql.exec(`SELECT estado, datos_json FROM peticiones WHERE id_reserva = ?;`, r.id_reserva).toArray()[0] as any;
			expect(fila).toEqual({ estado: "anulada", datos_json: null });
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE tipo = 'cancelacion';`).toArray()[0]).toEqual({ n: 0 });
			expect((await motor.consultarEnlace({ tenantId: T, token: r.token })).estado).toBe("cancelada");
			expect((await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:00", personas: 2 })).mesas).toEqual(["m2", "m4"]);
		});
	});

	it("cancelar cuando la Main ya la tiene deja una cancelación para entregarle", async () => {
		await conAgenda("agenda-cancelar-entregada", async (motor, sql) => {
			const r = await motor.reservar({ tenantId: T, alta: alta() });
			sql.exec(`UPDATE peticiones SET estado = 'entregada' WHERE id_reserva = ?;`, r.id_reserva);
			expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({ ok: true });

			const cancelacion = sql
				.exec(`SELECT tipo, estado, id_mesa, dia_ymd, hora, comensales, datos_json FROM peticiones WHERE tipo = 'cancelacion';`)
				.toArray();
			expect(cancelacion).toEqual([
				{ tipo: "cancelacion", estado: "pendiente", id_mesa: "m2", dia_ymd: DIA, hora: "21:00", comensales: 2, datos_json: null },
			]);
			expect((await motor.consultarEnlace({ tenantId: T, token: r.token })).estado).toBe("cancelada");

			// Y si ya estaba en Turso, igual: se da por vista y queda una sola cancelación.
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
				 VALUES (?, 'm2', ?, '21:00', 'CENA', 2, 'PROXIMA', 'WEB');`,
				r.id_reserva,
				DIA,
			);
			expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({ ok: true });
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE tipo = 'cancelacion';`).toArray()[0]).toEqual({ n: 1 });
			expect(sql.exec(`SELECT estado FROM peticiones WHERE tipo = 'alta';`).toArray()[0]).toEqual({ estado: "vista" });
		});
	});

	it("se cancela hasta la hora de la reserva, y no una que ya ha empezado", async () => {
		let ahora = AHORA;
		await conAgenda(
			"agenda-cancelar-tarde",
			async (motor, sql) => {
				const r = await motor.reservar({ tenantId: T, alta: alta() });
				// Llega la hora de la reserva.
				ahora = `${DIA} 21:00:00`;
				expect(await motor.consultarEnlace({ tenantId: T, token: r.token })).toMatchObject({ estado: "pasada", cancelable: false });
				expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({ ok: false, error: "reserva_no_cancelable", status: 409 });

				// Ya en Turso y sentados (ACTIVA), tampoco, aunque sea antes de la hora.
				ahora = AHORA;
				sql.exec(
					`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
					 VALUES (?, 'm2', ?, '21:00', 'CENA', 2, 'ACTIVA', 'WEB');`,
					r.id_reserva,
					DIA,
				);
				expect((await motor.cancelar({ tenantId: T, token: r.token })).error).toBe("reserva_no_cancelable");
			},
			{ ahora: () => ahora },
		);
	});

	it("un enlace inventado, mal formado o caducado no lleva a ninguna reserva", async () => {
		await conAgenda("agenda-enlaces", async (motor, sql) => {
			const r = await motor.reservar({ tenantId: T, alta: alta() });
			for (const token of ["", "corto", "A".repeat(22), `${r.token}x`]) {
				expect(await motor.cancelar({ tenantId: T, token }), token).toEqual({ ok: false, error: "enlace_no_valido", status: 404 });
			}
			sql.exec(`UPDATE enlaces SET caduca_ms = ?;`, Date.now() - 1);
			expect((await motor.consultarEnlace({ tenantId: T, token: r.token })).error).toBe("enlace_no_valido");
			// Sólo se guarda el hash del token.
			const guardado = sql.exec(`SELECT token_hash FROM enlaces;`).toArray()[0] as any;
			expect(guardado.token_hash).not.toBe(r.token);
			expect(guardado.token_hash).toMatch(/^[0-9a-f]{64}$/);
		});
	});

	it("la alarma purga lo cerrado hace más de una semana y los enlaces caducados", async () => {
		await conAgenda("agenda-alarma", async (motor, sql, state) => {
			const r = await motor.reservar({ tenantId: T, alta: alta() });
			expect(await state.storage.getAlarm()).not.toBeNull();

			const viejo = Date.now() - 8 * 86_400_000;
			sql.exec(
				`INSERT INTO peticiones (id_peticion, tipo, id_reserva, dia_ymd, hora, comensales, creada_local, creada_ms, estado, cerrada_ms)
				 VALUES ('vieja', 'alta', 'r-vieja', '2000-01-01', '13:00', 2, '2000-01-01 00:00:00', ?, 'vista', ?);`,
				viejo,
				viejo,
			);
			sql.exec(`INSERT INTO enlaces (token_hash, id_reserva, caduca_ms) VALUES ('h-viejo', 'r-vieja', ?);`, viejo);

			await motor.alarm();
			const ids = sql.exec(`SELECT id_reserva FROM peticiones;`).toArray().map((f: any) => f.id_reserva);
			expect(ids).toEqual([r.id_reserva]);
			expect(sql.exec(`SELECT COUNT(*) AS n FROM enlaces;`).toArray()[0]).toEqual({ n: 1 });
			// Queda la reserva viva: la alarma sigue programada.
			expect(await state.storage.getAlarm()).not.toBeNull();

			sql.exec(`DELETE FROM peticiones; DELETE FROM enlaces;`);
			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});
});
