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
import { enLaAgenda, lectorConBarrera, lectorSobre, stubDeLaAgenda } from "./helpers/agenda";
import { sumarDias } from "../src/domains/reservas_web/disponibilidad";
import { horaLocalEn } from "../src/domains/reservas_web/horaDelNegocio";
import { AgendaWeb } from "../src/durableObjects/agendaWeb";
import { prepararAlmacen } from "../src/durableObjects/agendaWeb.almacen";
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
	opciones: { ahora?: () => string; lector?: (state: DurableObjectState) => any } = {},
) {
	await enLaAgenda(nombre, async (motor, state) => {
		const sql = state.storage.sql;
		sembrarNegocio(sql);
		motor.leer = opciones.lector ? opciones.lector(state) : lectorSobre(state, opciones.ahora ?? (() => AHORA));
		// Los correos al cliente no salen: se apuntan en `motor.correos`.
		motor.correos = [];
		motor.enviarCorreo = async (c: any) => {
			motor.correos.push(c);
			return "enviado";
		};
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
			["constructor", "disponibles", "reservar", "consultarEnlace", "cancelar", "pendientes", "recogidas", "alarm"].sort(),
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
		await conAgenda(nombre, async () => {}, { lector: (state) => lectorConBarrera(state, () => AHORA, 3) });
		// Por RPC, como en producción. La barrera hace que las tres terminen de leer Turso, con las
		// mesas libres, antes de que ninguna decida: lo que reparte es el bloque síncrono de la agenda.
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

	it("el widget repite un alta cuya respuesta no le llegó: con su clave, la misma reserva y no otra", async () => {
		await conAgenda("agenda-intento", async (motor, sql) => {
			const primera = await motor.reservar({ tenantId: T, alta: alta(), intento: "intento-0123456789" });
			expect(primera).toMatchObject({ ok: true, mesa: "2", repetida: false });

			// La repite, quizá ya con otra mesa: la suya está ocupada por ella misma.
			const repetida = await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "m4" }), intento: "intento-0123456789" });
			expect(repetida).toEqual({
				ok: true,
				id_reserva: primera.id_reserva,
				codigo: primera.codigo,
				dia: DIA,
				hora: "21:00",
				personas: 2,
				mesa: "2",
				token: null,
				repetida: true,
			});
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).toArray()[0]).toEqual({ n: 1 });
			sinDatosPersonales(sql.exec(`SELECT * FROM intentos;`).toArray());

			// Otra clave es otra reserva: la mesa ya no está libre.
			const otra = await motor.reservar({ tenantId: T, alta: alta({ email: "otro@correo.es" }), intento: "intento-otro-00000" });
			expect(otra).toMatchObject({ ok: false, error: "mesa_no_disponible" });
		});
	});

	it("una clave de más de un día ya no cuenta, aunque la purga no la haya borrado: es un alta nueva", async () => {
		await conAgenda("agenda-intento-caducado", async (motor, sql) => {
			const viejo = Date.now() - 2 * 86_400_000;
			sql.exec(
				`INSERT INTO intentos (clave, respuesta_json, creado_ms) VALUES ('intento-0123456789', '{"id_reserva":"r-vieja"}', ?);`,
				viejo,
			);
			const r = await motor.reservar({ tenantId: T, alta: alta(), intento: "intento-0123456789" });
			expect(r).toMatchObject({ ok: true, repetida: false });
			const fila = sql.exec(`SELECT respuesta_json, creado_ms FROM intentos;`).toArray() as any[];
			expect(fila).toHaveLength(1);
			expect(JSON.parse(fila[0].respuesta_json).id_reserva).toBe(r.id_reserva);
			expect(Number(fila[0].creado_ms)).toBeGreaterThan(viejo);
		});
	});

	it("el mismo intento dos veces a la vez da una sola reserva", async () => {
		const nombre = "agenda-intento-simultaneo";
		await conAgenda(nombre, async () => {}, { lector: (state) => lectorConBarrera(state, () => AHORA, 2) });
		// Las dos leen Turso antes de que ninguna decida: lo que las separa es la segunda mirada, ya en el
		// bloque síncrono.
		const stub = stubDeLaAgenda(nombre);
		const [a, b] = (await Promise.all([
			stub.reservar({ tenantId: T, alta: alta(), intento: "intento-0123456789" }),
			stub.reservar({ tenantId: T, alta: alta({ id_mesa: "m4" }), intento: "intento-0123456789" }),
		])) as any[];
		expect(a.ok && b.ok).toBe(true);
		expect(a.id_reserva).toBe(b.id_reserva);
		expect([a.repetida, b.repetida].sort()).toEqual([false, true]);
		await enLaAgenda(nombre, (_motor, state) => {
			expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).toArray()[0]).toEqual({ n: 1 });
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

	it("cancelar con una lectura vieja de Turso no confunde un alta recién vista con una borrada", async () => {
		// El mismo cruce, en el enlace: la Main ya tiene el alta; /cancelar lee Turso antes de que
		// llegue y, mientras espera, otra petición la ve y la da por vista. Para esa lectura no está en
		// Turso y está vista: parece borrada (cancelada) y se respondería `ok` sin cancelar nada.
		await conAgenda("agenda-cancelar-lectura-vieja", async (motor, sql, state) => {
			const x = await motor.reservar({ tenantId: T, alta: alta() });
			sql.exec(`UPDATE peticiones SET estado = 'entregada' WHERE id_reserva = ?;`, x.id_reserva);

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
			const cancelando = motor.cancelar({ tenantId: T, token: x.token });
			await leido;

			motor.leer = normal;
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
				 VALUES (?, 'm2', ?, '21:00', 'CENA', 2, 'PROXIMA', 'WEB');`,
				x.id_reserva,
				DIA,
			);
			await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:00", personas: 2 });

			soltar();
			// Cancelada. Sin correo: la lectura no trae al cliente de Turso y el alta, ya vista, olvidó el
			// suyo. Es este cruce y nada más; la página de cancelar ya le dice que está cancelada.
			expect(await cancelando).toEqual({ ok: true, aviso: null });
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE tipo = 'cancelacion';`).toArray()[0]).toEqual({ n: 1 });
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

			// Con lo que necesita el correo de «has cancelado»: la dirección del alta y su reserva.
			expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({
				ok: true,
				aviso: { id_reserva: r.id_reserva, email: "ana@correo.es", dia: DIA, hora: "21:00", personas: 2, mesa: "2" },
			});
			// Dos veces es lo mismo, pero el correo ya salió.
			expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({ ok: true, aviso: null });
			const fila = sql.exec(`SELECT estado, datos_json FROM peticiones WHERE id_reserva = ?;`, r.id_reserva).toArray()[0] as any;
			expect(fila).toEqual({ estado: "anulada", datos_json: null });
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE tipo = 'cancelacion';`).toArray()[0]).toEqual({ n: 0 });
			expect((await motor.consultarEnlace({ tenantId: T, token: r.token })).estado).toBe("cancelada");
			expect((await motor.disponibles({ tenantId: T, dia: DIA, hora: "21:00", personas: 2 })).mesas).toEqual(["m2", "m4"]);
		});
	});

	it("cancelar una que ya está en Turso avisa al correo de su cliente allí, aunque la agenda ya no guarde el del alta", async () => {
		await conAgenda("agenda-cancelar-correo-turso", async (motor, sql) => {
			const r = await motor.reservar({ tenantId: T, alta: alta() });
			sql.exec(`INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('c1', 'Ana', 'ana.nueva@correo.es');`);
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
				 VALUES (?, 'c1', 'm4', ?, '21:30', 'CENA', 3, 'PROXIMA', 'WEB');`,
				r.id_reserva,
				DIA,
			);
			// Vista en Turso: la agenda olvida los datos del alta.
			sql.exec(`UPDATE peticiones SET estado = 'vista', datos_json = NULL WHERE id_reserva = ?;`, r.id_reserva);
			// Lo que dice Turso, que es lo que el restaurante haya cambiado.
			expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({
				ok: true,
				aviso: { id_reserva: r.id_reserva, email: "ana.nueva@correo.es", dia: DIA, hora: "21:30", personas: 3, mesa: "4" },
			});
		});
	});

	it("cancelar cuando la Main ya la tiene deja una cancelación para entregarle", async () => {
		await conAgenda("agenda-cancelar-entregada", async (motor, sql) => {
			const r = await motor.reservar({ tenantId: T, alta: alta() });
			sql.exec(`UPDATE peticiones SET estado = 'entregada' WHERE id_reserva = ?;`, r.id_reserva);
			expect((await motor.cancelar({ tenantId: T, token: r.token })).aviso.email).toBe("ana@correo.es");

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
			expect(await motor.cancelar({ tenantId: T, token: r.token })).toEqual({ ok: true, aviso: null });
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

	it("la alarma da por vistas las que ya están en Turso aunque nadie pregunte por su día", async () => {
		await conAgenda("agenda-alarma-turso", async (motor, sql, state) => {
			const llega = await motor.reservar({ tenantId: T, alta: alta() });
			const espera = await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "m4" }) });
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
				 VALUES (?, 'm2', ?, '21:00', 'CENA', 2, 'PROXIMA', 'WEB');`,
				llega.id_reserva,
				DIA,
			);
			await state.storage.deleteAlarm();
			await motor.alarm();
			const estados = sql
				.exec(`SELECT id_reserva, estado, datos_json IS NULL AS sin_datos FROM peticiones ORDER BY creada_ms, id_reserva;`)
				.toArray();
			expect(estados).toEqual([
				{ id_reserva: llega.id_reserva, estado: "vista", sin_datos: 1 },
				{ id_reserva: espera.id_reserva, estado: "pendiente", sin_datos: 0 },
			]);

			// Si Turso no contesta, purga igual y vuelve a programarse.
			motor.leer = async () => {
				throw new Error("sin red");
			};
			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(await state.storage.getAlarm()).not.toBeNull();
		});
	});

	it("la alarma recorre lo que espera por lotes: las más viejas no tapan a las de detrás", async () => {
		await conAgenda("agenda-alarma-lotes", async (motor, sql, state) => {
			// 2600 altas que esperan; en Turso, la 600 (segundo lote) y la 2550 (más allá de lo que mira
			// una alarma: 5 lotes de 500). Apuntadas a mano, sin pasar por el motor: el negocio también.
			sql.exec(`INSERT INTO estado (clave, valor) VALUES ('tenant_id', ?);`, T);
			for (let i = 0; i < 2600; i++) {
				sql.exec(
					`INSERT INTO peticiones (id_peticion, tipo, id_reserva, id_mesa, dia_ymd, hora, comensales, datos_json,
					                         creada_local, creada_ms, estado)
					 VALUES (?, 'alta', ?, 'm2', ?, '21:00', 2, '{"nombre":"x"}', ?, ?, 'pendiente');`,
					`p${i}`,
					`r${String(i).padStart(4, "0")}`,
					DIA,
					AHORA,
					1000 + i,
				);
			}
			for (const id of ["r0600", "r2550"]) {
				sql.exec(
					`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
					 VALUES (?, 'm2', ?, '21:00', 'CENA', 2, 'PROXIMA', 'WEB');`,
					id,
					DIA,
				);
			}
			const estado = (id: string) =>
				(sql.exec(`SELECT estado FROM peticiones WHERE id_reserva = ?;`, id).toArray()[0] as any).estado;

			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(estado("r0600")).toBe("vista");
			expect(estado("r2550")).toBe("pendiente");

			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(estado("r2550")).toBe("vista");
			// Terminada la vuelta, la siguiente empieza otra vez por la más vieja.
			expect(sql.exec(`SELECT COUNT(*) AS n FROM estado WHERE clave = 'cursor_alta';`).toArray()[0]).toEqual({ n: 0 });
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
			sql.exec(`INSERT INTO intentos (clave, respuesta_json, creado_ms) VALUES ('intento-viejo', '{}', ?);`, viejo);

			// Como al dispararse: la alarma que la ha despertado ya no está programada.
			await state.storage.deleteAlarm();
			await motor.alarm();
			const ids = sql.exec(`SELECT id_reserva FROM peticiones;`).toArray().map((f: any) => f.id_reserva);
			expect(ids).toEqual([r.id_reserva]);
			expect(sql.exec(`SELECT COUNT(*) AS n FROM enlaces;`).toArray()[0]).toEqual({ n: 1 });
			expect(sql.exec(`SELECT COUNT(*) AS n FROM intentos;`).toArray()[0]).toEqual({ n: 0 });
			// Queda la reserva viva: la alarma se ha vuelto a programar.
			expect(await state.storage.getAlarm()).not.toBeNull();

			sql.exec(`DELETE FROM peticiones; DELETE FROM enlaces;`);
			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});
});

describe("la entrega a la Main", () => {
	/** El aviso al TenantHub y los eventos de Axiom, apuntados en vez de mandados. */
	function espiar(motor: any) {
		const avisos: string[] = [];
		const eventos: any[] = [];
		motor.avisarALaMain = (t: string) => avisos.push(t);
		motor.anotar = (e: any) => eventos.push(e);
		return { avisos, eventos };
	}

	const filas = (sql: SqlStorage) =>
		sql
			.exec(`SELECT tipo, id_reserva, estado, resultado, codigo, datos_json FROM peticiones ORDER BY creada_ms, id_peticion;`)
			.toArray() as any[];

	function enTurso(sql: SqlStorage, idReserva: string, mesa: string) {
		sql.exec(
			`INSERT INTO Reservas (ID_Reserva, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
			 VALUES (?, ?, ?, '21:00', 'CENA', 2, 'PROXIMA', 'WEB');`,
			idReserva,
			mesa,
			DIA,
		);
	}

	it("lo nuevo avisa a la Main, y se le entrega por orden de llegada con los datos del alta", async () => {
		await conAgenda("entrega-orden", async (motor, sql) => {
			const { avisos } = espiar(motor);
			const a = await motor.reservar({ tenantId: T, alta: alta() });
			const b = await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "m4", email: "otro@correo.es", nota: null }) });
			expect(avisos).toEqual([T, T]);

			const primera = await motor.pendientes({ tenantId: T });
			expect(primera.hay_mas).toBe(false);
			expect(primera.peticiones.map((p: any) => p.id_reserva)).toEqual([a.id_reserva, b.id_reserva]);
			expect(primera.peticiones[0]).toEqual({
				id_peticion: expect.any(String),
				tipo: "alta",
				id_reserva: a.id_reserva,
				id_mesa: "m2",
				dia_ymd: DIA,
				hora: "21:00",
				personas: 2,
				creada_local: AHORA,
				datos: { nombre: "Ana Pérez", email: "ana@correo.es", telefono: "600112233", nota: "Silla para bebé" },
			});
			expect(primera.peticiones[1].datos.nota).toBeNull();
			expect(filas(sql).map((f) => f.estado)).toEqual(["entregada", "entregada"]);
			// Lo entregado no se vuelve a entregar.
			expect((await motor.pendientes({ tenantId: T })).peticiones).toEqual([]);

			// Cancelar una entregada deja una cancelación para la Main, que también la avisa.
			expect(await motor.cancelar({ tenantId: T, token: a.token })).toMatchObject({ ok: true });
			expect(avisos).toEqual([T, T, T]);
			const cancelacion = await motor.pendientes({ tenantId: T });
			// Con su alta delante, que aún no se ha visto en Turso.
			expect(cancelacion.peticiones).toEqual([
				expect.objectContaining({ tipo: "alta", id_reserva: a.id_reserva }),
				expect.objectContaining({ tipo: "cancelacion", id_reserva: a.id_reserva, id_mesa: "m2", datos: null }),
			]);
		});
	});

	it("no entrega lo que ya está en Turso", async () => {
		await conAgenda("entrega-ya-en-turso", async (motor, sql) => {
			espiar(motor);
			const a = await motor.reservar({ tenantId: T, alta: alta() });
			enTurso(sql, a.id_reserva, "m2");
			expect((await motor.pendientes({ tenantId: T })).peticiones).toEqual([]);
			expect(filas(sql)[0]).toMatchObject({ estado: "vista", datos_json: null });
		});
	});

	it("de 50 en 50, con `hay_mas` mientras quede", async () => {
		await conAgenda("entrega-lotes", async (motor, sql) => {
			for (let i = 0; i < 51; i++) {
				sql.exec(
					`INSERT INTO peticiones (id_peticion, tipo, id_reserva, id_mesa, dia_ymd, hora, comensales, datos_json,
					                         creada_local, creada_ms, estado)
					 VALUES (?, 'alta', ?, 'm2', ?, '21:00', 2, ?, ?, ?, 'pendiente');`,
					`p${i}`,
					`r${i}`,
					DIA,
					JSON.stringify({ nombre: "x", email: "x@y.es", telefono: "600000000", nota: null }),
					AHORA,
					1000 + i,
				);
			}
			const una = await motor.pendientes({ tenantId: T });
			expect([una.peticiones.length, una.hay_mas]).toEqual([50, true]);
			const otra = await motor.pendientes({ tenantId: T });
			expect([otra.peticiones.length, otra.hay_mas]).toEqual([1, false]);
		});
	});

	it("apunta lo que contesta la Main; de una fallida sólo queda el correo, hasta que se le dice al cliente", async () => {
		await conAgenda("entrega-resultados", async (motor, sql) => {
			const { eventos } = espiar(motor);
			// El correo no sale a la primera: el de la fallida sigue guardado para la alarma.
			motor.enviarCorreo = async () => "fallido";
			const a = await motor.reservar({ tenantId: T, alta: alta() });
			const b = await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "m4", email: "b@correo.es" }) });
			const entregadas = (await motor.pendientes({ tenantId: T })).peticiones;
			const id = (r: any) => entregadas.find((p: any) => p.id_reserva === r.id_reserva).id_peticion;

			const r = await motor.recogidas({
				tenantId: T,
				resultados: [
					{ id_peticion: id(a), resultado: "solapada", codigo: null },
					{ id_peticion: id(b), resultado: "fallida", codigo: "validation" },
					{ id_peticion: "no-existe", resultado: "registrada", codigo: null },
				],
			});
			expect(r).toEqual({ ok: true, apuntadas: 2 });
			const [fa, fb] = filas(sql);
			// La solapada espera a verse en Turso, con sus datos.
			expect(fa).toMatchObject({ estado: "entregada", resultado: "solapada" });
			expect(JSON.parse(fa.datos_json).nombre).toBe("Ana Pérez");
			expect(fb).toMatchObject({ estado: "fallida", resultado: "fallida", codigo: "validation" });
			expect(JSON.parse(fb.datos_json)).toEqual({ email: "b@correo.es" });
			expect(eventos).toContainEqual({
				event: "reserva_web_fallida",
				tenant_id: T,
				id_reserva: b.id_reserva,
				motivo: "validation",
			});
			// Una respuesta repetida no cambia nada: la fallida ya no está entregada.
			const otra = await motor.recogidas({
				tenantId: T,
				resultados: [{ id_peticion: id(b), resultado: "registrada", codigo: null }],
			});
			expect(otra.apuntadas).toBe(0);
			// Y quien la consulta la ve cancelada.
			expect((await motor.consultarEnlace({ tenantId: T, token: b.token })).estado).toBe("cancelada");

			// La alarma lo vuelve a intentar: sale «no hemos podido registrar tu reserva», a su correo y
			// sin nada de lo que escribió, y la agenda lo olvida.
			motor.correos = [];
			motor.enviarCorreo = async (c: any) => {
				motor.correos.push(c);
				return "enviado";
			};
			await motor.alarm();
			expect(motor.correos).toHaveLength(1);
			expect(motor.correos[0]).toMatchObject({
				tenantId: T,
				id: `rw:no_registrada:${b.id_reserva}`,
				tipo: "no_registrada",
				para: "b@correo.es",
				reserva: { dia: DIA, hora: "21:00", personas: 2, mesa: "4", codigo: codigoDeReserva(b.id_reserva) },
				dispositivo: "agenda",
			});
			expect(motor.correos[0].negocio.nombre).toBeTypeOf("string");
			expect(filas(sql)[1].datos_json).toBeNull();
			// Dicho una vez: la siguiente alarma no lo repite.
			await motor.alarm();
			expect(motor.correos).toHaveLength(1);
		});
	});

	it("las fallidas cuyo correo no sale no tapan a las de detrás", async () => {
		await conAgenda("entrega-fallidas-atascadas", async (motor, sql) => {
			for (let i = 0; i < 25; i++) {
				sql.exec(
					`INSERT INTO peticiones (id_peticion, tipo, id_reserva, id_mesa, dia_ymd, hora, comensales, datos_json,
					                         creada_local, creada_ms, estado, cerrada_ms, resultado, codigo)
					 VALUES (?, 'alta', ?, 'm2', ?, '21:00', 2, ?, ?, ?, 'fallida', ?, 'fallida', 'validation');`,
					`p${String(i).padStart(2, "0")}`,
					`r${i}`,
					DIA,
					JSON.stringify({ email: `c${i}@correo.es` }),
					AHORA,
					1000 + i,
					Date.now(),
				);
			}
			// Las 22 más viejas no salen (su buzón está en el tope, o el binding las rechaza).
			motor.enviarCorreo = async (c: any) => {
				const n = Number(c.para.slice(1, c.para.indexOf("@")));
				if (n < 22) return "tope";
				motor.correos.push(c);
				return "enviado";
			};
			expect(await motor.avisarFallidas(T)).toBe(3);
			expect(motor.correos.map((c: any) => c.para)).toEqual(["c22@correo.es", "c23@correo.es", "c24@correo.es"]);
			// Las que no salieron siguen guardadas para la alarma.
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones WHERE datos_json IS NOT NULL;`).toArray()[0]).toEqual({ n: 22 });
		});
	});

	it("las que no salen van detrás: aunque haya cien atascadas, a la siguiente le llega su turno", async () => {
		await conAgenda("entrega-fallidas-rotan", async (motor, sql) => {
			for (let i = 0; i < 101; i++) {
				sql.exec(
					`INSERT INTO peticiones (id_peticion, tipo, id_reserva, id_mesa, dia_ymd, hora, comensales, datos_json,
					                         creada_local, creada_ms, estado, cerrada_ms, resultado, codigo)
					 VALUES (?, 'alta', ?, 'm2', ?, '21:00', 2, ?, ?, ?, 'fallida', ?, 'fallida', 'validation');`,
					`p${String(i).padStart(3, "0")}`,
					`r${i}`,
					DIA,
					JSON.stringify({ email: `c${i}@correo.es` }),
					AHORA,
					1000 + i,
					Date.now(),
				);
			}
			// Las cien más viejas no salen nunca; la 101, sí.
			motor.enviarCorreo = async (c: any) => {
				if (c.para !== "c100@correo.es") return "tope";
				motor.correos.push(c);
				return "enviado";
			};
			expect(await motor.avisarFallidas(T)).toBe(0);
			expect(await motor.avisarFallidas(T)).toBe(1);
			expect(motor.correos.map((c: any) => c.para)).toEqual(["c100@correo.es"]);
		});
	});

	it("una fallida cuya hora ya ha pasado no se le dice al cliente: se olvida su correo", async () => {
		let ahora = AHORA;
		await conAgenda(
			"entrega-fallida-pasada",
			async (motor, sql) => {
				await motor.reservar({ tenantId: T, alta: alta() });
				const [p] = (await motor.pendientes({ tenantId: T })).peticiones;
				// La hora de la reserva pasa antes de que la Main conteste.
				ahora = `${DIA} 22:00:00`;
				await motor.recogidas({ tenantId: T, resultados: [{ id_peticion: p.id_peticion, resultado: "fallida", codigo: "validation" }] });
				expect(motor.correos).toEqual([]);
				expect(filas(sql)[0]).toMatchObject({ estado: "fallida", datos_json: null });
			},
			{ ahora: () => ahora },
		);
	});

	it("una cancelación no está hecha porque la Main lo diga, sino cuando Turso la tiene cancelada", async () => {
		await conAgenda("entrega-cancelacion", async (motor, sql, state) => {
			espiar(motor);
			const a = await motor.reservar({ tenantId: T, alta: alta() });
			await motor.pendientes({ tenantId: T });
			enTurso(sql, a.id_reserva, "m2");
			await motor.cancelar({ tenantId: T, token: a.token });
			const [c] = (await motor.pendientes({ tenantId: T })).peticiones;
			await motor.recogidas({
				tenantId: T,
				resultados: [{ id_peticion: c.id_peticion, resultado: "registrada", codigo: null }],
			});
			const cancelacion = () => filas(sql).find((f) => f.tipo === "cancelacion");
			// La Main la ha cancelado en su base, pero su outbox aún no lo ha subido.
			expect(cancelacion()).toMatchObject({ estado: "entregada", resultado: "registrada" });

			// Si no llega en una hora, se le vuelve a ofrecer.
			sql.exec(`UPDATE peticiones SET entregada_ms = ? WHERE tipo = 'cancelacion';`, Date.now() - 61 * 60_000);
			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(cancelacion().estado).toBe("pendiente");

			// Llega a Turso: hecha.
			sql.exec(`UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?;`, a.id_reserva);
			await motor.pendientes({ tenantId: T });
			expect(cancelacion().estado).toBe("vista");
		});
	});

	it("lo entregado que no llega a Turso en una hora se vuelve a ofrecer, y se avisa a la Main", async () => {
		await conAgenda("entrega-reoferta", async (motor, sql, state) => {
			const { avisos, eventos } = espiar(motor);
			const a = await motor.reservar({ tenantId: T, alta: alta() });
			const b = await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "m4", email: "b@correo.es" }) });
			await motor.pendientes({ tenantId: T });
			avisos.length = 0;
			// Entregadas hace más de una hora; b ya llegó a Turso.
			sql.exec(`UPDATE peticiones SET entregada_ms = ?;`, Date.now() - 61 * 60_000);
			enTurso(sql, b.id_reserva, "m4");

			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(filas(sql).map((f) => [f.id_reserva, f.estado])).toEqual([
				[a.id_reserva, "pendiente"],
				[b.id_reserva, "vista"],
			]);
			expect(avisos).toEqual([T]);
			expect(eventos, JSON.stringify(eventos)).toContainEqual({ event: "reserva_web_reofrecida", tenant_id: T, cuantas: 1 });
			const otra = await motor.pendientes({ tenantId: T });
			expect(otra.peticiones.map((p: any) => p.id_reserva)).toEqual([a.id_reserva]);
		});
	});

	it("sin Turso la alarma no vuelve a ofrecer nada: no sabría qué ha llegado", async () => {
		await conAgenda("entrega-reoferta-sin-turso", async (motor, sql, state) => {
			const { avisos } = espiar(motor);
			await motor.reservar({ tenantId: T, alta: alta() });
			await motor.pendientes({ tenantId: T });
			avisos.length = 0;
			sql.exec(`UPDATE peticiones SET entregada_ms = ?;`, Date.now() - 61 * 60_000);
			motor.leer = async () => {
				throw new Error("sin red");
			};
			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(filas(sql)[0].estado).toBe("entregada");
			expect(avisos).toEqual([]);
		});
	});

	it("lo que lleva tres días sin recoger sale en Axiom", async () => {
		await conAgenda("entrega-atascada", async (motor, sql, state) => {
			const { eventos } = espiar(motor);
			await motor.reservar({ tenantId: T, alta: alta() });
			sql.exec(`UPDATE peticiones SET creada_ms = ?;`, Date.now() - 73 * 60 * 60_000);
			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(eventos).toContainEqual({ event: "reserva_web_atascada", tenant_id: T, cuantas: 1 });
		});
	});
	it("cancelar un alta que se vuelve a ofrecer no la anula aquí: la Main puede tenerla ya", async () => {
		await conAgenda("entrega-cancelar-reofrecida", async (motor, sql) => {
			espiar(motor);
			const a = await motor.reservar({ tenantId: T, alta: alta() });
			await motor.pendientes({ tenantId: T });
			// Vuelta a ofrecer: otra vez pendiente, pero ya se entregó una vez.
			sql.exec(`UPDATE peticiones SET estado = 'pendiente';`);
			expect(await motor.cancelar({ tenantId: T, token: a.token })).toMatchObject({ ok: true });
			expect(filas(sql).map((f) => [f.tipo, f.estado])).toEqual([
				["alta", "pendiente"],
				["cancelacion", "pendiente"],
			]);
			// Y se le entregan las dos, el alta primero.
			const entregadas = (await motor.pendientes({ tenantId: T })).peticiones.map((p: any) => p.tipo);
			expect(entregadas).toEqual(["alta", "cancelacion"]);
		});
	});
	it("una agenda de antes de la entrega se pone al día sin perder lo que guardaba", async () => {
		await conAgenda("entrega-migracion", async (motor, sql) => {
			espiar(motor);
			// La tabla tal como la creaba la versión 1, con una petición ya entregada, y sin `intentos`.
			sql.exec(`DROP TABLE peticiones;`);
			sql.exec(`DROP TABLE intentos;`);
			sql.exec(
				`CREATE TABLE peticiones (
					id_peticion TEXT NOT NULL PRIMARY KEY, tipo TEXT NOT NULL, id_reserva TEXT NOT NULL, id_mesa TEXT,
					dia_ymd TEXT NOT NULL, hora TEXT NOT NULL, comensales INTEGER NOT NULL, email_hash TEXT, datos_json TEXT,
					creada_local TEXT NOT NULL, creada_ms INTEGER NOT NULL, estado TEXT NOT NULL, entregada_ms INTEGER,
					intentos INTEGER NOT NULL DEFAULT 0, cerrada_ms INTEGER
				);`,
			);
			sql.exec(
				`INSERT INTO peticiones (id_peticion, tipo, id_reserva, id_mesa, dia_ymd, hora, comensales, datos_json,
				                         creada_local, creada_ms, estado, entregada_ms, intentos)
				 VALUES ('p1', 'alta', 'r1', 'm2', ?, '21:00', 2, '{"email":"a@b.es"}', ?, 1, 'entregada', 1, 1);`,
				DIA,
				AHORA,
			);
			sql.exec(`UPDATE estado SET valor = '1' WHERE clave = 'version';`);

			prepararAlmacen(sql);
			const columnas = sql.exec(`PRAGMA table_info(peticiones);`).toArray().map((c: any) => c.name);
			expect(columnas).toEqual(expect.arrayContaining(["resultado", "codigo", "aviso_ms"]));
			expect(sql.exec(`SELECT valor FROM estado WHERE clave = 'version';`).toArray()[0]).toEqual({ valor: "4" });
			expect(sql.exec(`SELECT COUNT(*) AS n FROM intentos;`).toArray()[0]).toEqual({ n: 0 });
			// Lo que guardaba sigue ahí, y la Main ya puede contestar de ello.
			const r = await motor.recogidas({
				tenantId: T,
				resultados: [{ id_peticion: "p1", resultado: "fallida", codigo: "validation" }],
			});
			expect(r.apuntadas).toBe(1);
			expect(filas(sql)[0]).toMatchObject({ estado: "fallida", codigo: "validation" });
			// Y volver a prepararla no cambia nada.
			prepararAlmacen(sql);
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).toArray()[0]).toEqual({ n: 1 });
		});
	});
	it("mientras quede algo sin recoger, la alarma vuelve a avisar a la Main", async () => {
		await conAgenda("entrega-reaviso", async (motor, sql, state) => {
			const { avisos } = espiar(motor);
			await motor.reservar({ tenantId: T, alta: alta() });
			// Como si el aviso del alta se hubiera perdido.
			avisos.length = 0;
			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(avisos).toEqual([T]);
			// Recogida, ya no hay nada que avisar.
			await motor.pendientes({ tenantId: T });
			avisos.length = 0;
			await state.storage.deleteAlarm();
			await motor.alarm();
			expect(avisos).toEqual([]);
		});
	});
	it("una cancelación va con su alta si ésta no se ha visto en Turso: la Main pudo no recibirla", async () => {
		await conAgenda("entrega-cancelacion-con-su-alta", async (motor, sql) => {
			espiar(motor);
			const a = await motor.reservar({ tenantId: T, alta: alta() });
			// Se entrega, pero la respuesta no llega a la Main.
			await motor.pendientes({ tenantId: T });
			await motor.cancelar({ tenantId: T, token: a.token });

			const tanda = (await motor.pendientes({ tenantId: T })).peticiones;
			expect(tanda.map((p: any) => [p.tipo, p.id_reserva])).toEqual([
				["alta", a.id_reserva],
				["cancelacion", a.id_reserva],
			]);
			expect(tanda[0].datos.nombre).toBe("Ana Pérez");

			// Ya en Turso, la cancelación va sola.
			const b = await motor.reservar({ tenantId: T, alta: alta({ id_mesa: "m4", email: "b@correo.es" }) });
			await motor.pendientes({ tenantId: T });
			enTurso(sql, b.id_reserva, "m4");
			await motor.cancelar({ tenantId: T, token: b.token });
			const sola = (await motor.pendientes({ tenantId: T })).peticiones;
			expect(sola.map((p: any) => p.tipo)).toEqual(["cancelacion"]);
		});
	});
});
