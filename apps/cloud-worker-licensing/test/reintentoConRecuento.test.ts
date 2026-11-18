// test/reintentoConRecuento.test.ts
//
// Las rutas de la Handy que miran cuántas filas tocó su escritura (`turno-partido` contesta 409 si
// no pudo quitar el turno partido; `horarios/guardar`, 404 si la asignación ya no está) deciden con el
// recuento cuando se sabe, y con el ESTADO cuando no (`decidirPorEstado`, en `lib/rutas.ts`).
//
// No siempre se sabe. Un reintento con la misma `X-Idempotency-Key` de una operación ya aplicada no
// vuelve a ejecutarla: el DO devuelve el `Result_Json` que guardó al aplicarla, y para el recuento de
// un `tenantDb.exec` o el `saveAs` de una transacción ése es el `storageResult` de `buildApplyBatch`,
// `null`, que sólo se cambia por el número de filas si el resultado se llegó a refinar después de
// aplicarla (SYNC-10, que es best-effort). Y el lote se confirma también cuando la escritura
// condicional no toca ninguna fila, así que `null` puede ser «hecho» o «no se pudo». Salió en AUD-26,
// con la papelera de notificaciones (`notificacionesReintento.test.ts`).
//
// Se recorren las rutas de verdad (validador, `apply` y `applyViaHub` reales, lote de
// `buildApplyBatch` sobre el esquema real del negocio). Lo que se sustituye: la autenticación del
// dispositivo (una Handy ya verificada), la base del negocio (el SQLite del DO) y el DO, que aplica el
// lote y guarda por clave lo que guarda el gate del de verdad antes de refinarlo. Sin tiempos ni red.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

let dbActual: any = null;

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	// Una Handy emparejada y con licencia: el JWT y el device-proof ya están verificados.
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t-reintento");
		c.set("deviceId", "dev-handy");
		await next();
	},
}));

vi.mock("../src/server/db", () => ({
	getDb: () => ({ execute: async () => ({ rows: [{ role: "handy" }] }) }),
}));

// Como el de verdad (REV-03): con una `X-Client-Now` válida, las lecturas usan su «ahora».
vi.mock("../src/lib/tenantClient", async (original) => {
	const real = (await (original as any)()) as typeof import("../src/lib/tenantClient");
	const { parseClientNow } = await import("../src/durableObjects/tenantHub.tiempo");
	return {
		...real,
		tenantQuery: (c: any, fn: any) => {
			const ahora = parseClientNow(c.req.header("X-Client-Now"));
			return fn(ahora ? real.conLaHoraDeQuienPregunta(dbActual, ahora) : dbActual);
		},
	};
});

const { loginRoutes } = await import("../src/domains/login/login.routes");
const { trabajadoresRoutes } = await import("../src/domains/trabajadores/trabajadores.routes");
const { buildApplyBatch } = await import("../src/durableObjects/tenantHub.lote");
const { rewriteCmdNowLiterals } = await import("../src/durableObjects/tenantHub.tiempo");
const { HubError, cuerpoDeErrorConStatus } = await import("../src/lib/errorHttp");

afterEach(() => {
	vi.useRealTimers();
});

const app = new Hono();
app.route("/v1/login", loginRoutes);
app.route("/v1/trabajadores", trabajadoresRoutes);
// Como `app.onError` de `index.ts`: un error con status sale con el mismo sobre que un rechazo del DO.
app.onError((err: any, c) =>
	typeof err?.status === "number" ? c.json(cuerpoDeErrorConStatus(err), err.status) : c.text("Internal Server Error", 500),
);

const USUARIO = "reintento-usuario-ficticio";
const TRABAJADOR = "reintento-trabajador-ficticio";
const FECHA = "2026-11-11";

/**
 * Cómo contesta el DO de la prueba la primera vez que ve una clave. Siempre aplica el lote sobre el
 * SQLite del hub y guarda para esa clave lo que guarda el gate (`storageResult`), y luego:
 *  - `respuesta`: devuelve el resultado del lote (el recuento), como cuando todo va bien;
 *  - `sin-recuento`: devuelve lo guardado, como cuando el DO contesta sin el recuento (un resultado
 *    que no se dejó leer);
 *  - `respuesta-perdida`: falla, como cuando la respuesta no le llega a la Handy, que reintenta.
 * Un reintento con la misma clave nunca aplica nada: devuelve lo guardado. Como el DO de verdad, fija
 * «ahora» en el comando con la `X-Client-Now` de la petición. `antes` y `despues` son lo que hace
 * otro dispositivo justo antes de que se aplique y entre la respuesta perdida y el reintento.
 */
type Primera = "respuesta" | "sin-recuento" | "respuesta-perdida";
type Ganchos = { antes?: (sql: any) => void; despues?: (sql: any) => void };

function hubDePrueba(hub: any, sql: any, primera: Primera, ganchos: Ganchos = {}) {
	const guardado = new Map<string, unknown>();
	return {
		idFromName: (n: string) => n,
		get: () => ({
			aplicar: async (params: any) => {
				if (guardado.has(params.opId)) return { ok: true, data: guardado.get(params.opId) };
				ganchos.antes?.(sql);
				const comando = params.clientNow ? rewriteCmdNowLiterals(params.command, params.clientNow) : params.command;
				const lote = buildApplyBatch(comando);
				const resultados: any[] = [];
				hub.state.storage.transactionSync(() => {
					sql.exec("PRAGMA defer_foreign_keys = ON;");
					for (const st of lote.middle) {
						const cur = sql.exec(st.sql, ...(st.args ?? []));
						resultados.push({ rows: cur.toArray(), rowsAffected: cur.rowsWritten ?? 0 });
					}
				});
				guardado.set(params.opId, lote.storageResult);
				ganchos.despues?.(sql);
				if (primera === "sin-recuento") return { ok: true, data: lote.storageResult };
				if (primera === "respuesta-perdida") throw new Error("la respuesta no llegó a la Handy");
				return { ok: true, data: lote.resolveResult(resultados, 0) };
			},
		}),
	};
}

async function pedir(
	ruta: string,
	cuerpo: unknown,
	env: unknown,
	clave: string,
	ahora: string | null = `${FECHA} 13:00:00`,
) {
	const res = await app.request(
		ruta,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Idempotency-Key": clave,
				...(ahora === null ? {} : { "X-Client-Now": ahora }),
			},
			body: JSON.stringify(cuerpo),
		},
		env as any,
	);
	const texto = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(texto);
	} catch {
		json = texto;
	}
	return { status: res.status, json };
}

/** Un negocio con un camarero que tiene ficha de trabajador y un turno de mañana. */
async function conHub(
	nombre: string,
	primera: Primera,
	fn: (sql: any, env: unknown) => Promise<void>,
	ganchos: Ganchos = {},
) {
	await enElHub(nombre, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		sql.exec(
			`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
			 VALUES (?, (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Camarero'), 'eva@ficticio.invalid', 'x', 'Eva', 'Activo');`,
			USUARIO,
		);
		sql.exec(`INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES (?, ?);`, TRABAJADOR, USUARIO);
		sql.exec(`INSERT INTO Turnos (ID_Turno, Nombre_Turno) VALUES ('turno-manana', 'Mañana');`);
		dbActual = clienteSobre(sql, hub.state.storage);
		await fn(sql, { TenantHub: hubDePrueba(hub, sql, primera, ganchos) });
	});
}

const turnoPartido = (sql: any, fecha = FECHA): number | null =>
	(sql.exec("SELECT Turno_Partido FROM Fichaje_Dia WHERE ID_Usuario = ? AND Fecha = ?;", USUARIO, fecha).toArray()[0] as any)
		?.Turno_Partido ?? null;

/** El turno partido marcado y su segundo tramo ya fichado: quitarlo no puede. */
function conSegundoTramo(sql: any) {
	sql.exec(`INSERT INTO Fichaje_Dia (ID_Usuario, Fecha, Turno_Partido) VALUES (?, ?, 1);`, USUARIO, FECHA);
	sql.exec(
		`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada)
		 VALUES ('fichaje-parte-2', ?, ?, 2, '${FECHA} 17:00:00');`,
		USUARIO,
		FECHA,
	);
}

/** El reloj del sistema donde la prueba lo quiere, para que las `X-Client-Now` de abajo valgan. */
function relojA(iso: string) {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(iso));
}
const ANTES_DE_MEDIANOCHE = `${FECHA} 23:59:00`;
const PASADA_MEDIANOCHE = "2026-11-12 00:01:00";

const QUITAR = { id_usuario: USUARIO, turno_partido: false, fecha: FECHA };

describe("turno partido: con el recuento, si se sabe; si no, por el estado", () => {
	it("el reintento con la misma clave de una operación ya aplicada contesta ok", async () => {
		await conHub("reintento-turno-partido", "respuesta", async (sql, env) => {
			const clave = "op-reintento-turno-partido";

			const primero = await pedir("/v1/login/turno-partido", QUITAR, env, clave);
			expect(primero).toEqual({ status: 200, json: { ok: true } });
			expect(turnoPartido(sql)).toBe(0);

			// La primera respuesta no llegó y la Handy reenvía con la misma clave: el DO no vuelve a
			// aplicarla y devuelve lo que guardó (`null` en un `exec`). Quedó como se pidió: ok.
			const reenvio = await pedir("/v1/login/turno-partido", QUITAR, env, clave);
			expect(reenvio).toEqual({ status: 200, json: { ok: true } });
			expect(turnoPartido(sql)).toBe(0);
		});
	});

	it("con un segundo tramo ya fichado, quitarlo contesta 409 (el DO lo dice con un 0)", async () => {
		await conHub("reintento-turno-partido-409", "respuesta", async (sql, env) => {
			conSegundoTramo(sql);
			const r = await pedir("/v1/login/turno-partido", QUITAR, env, "op-reintento-turno-partido-409");
			expect(r.status).toBe(409);
			expect(turnoPartido(sql)).toBe(1);
		});
	});

	// Cero filas y la respuesta perdida: el `null` guardado no dice si se pudo. Sigue marcado: 409.
	it("con un segundo tramo, contestado por el DO sin recuento, da 409", async () => {
		await conHub("reintento-turno-partido-do", "sin-recuento", async (sql, env) => {
			conSegundoTramo(sql);
			const r = await pedir("/v1/login/turno-partido", QUITAR, env, "op-reintento-turno-partido-do");
			expect(r.status).toBe(409);
			expect(turnoPartido(sql)).toBe(1);
		});
	});

	it("con un segundo tramo, reintentado con la misma clave tras perder la respuesta, contesta 409", async () => {
		await conHub("reintento-turno-partido-http", "respuesta-perdida", async (sql, env) => {
			conSegundoTramo(sql);
			const clave = "op-reintento-turno-partido-http";
			expect((await pedir("/v1/login/turno-partido", QUITAR, env, clave)).status).toBe(500);

			const r = await pedir("/v1/login/turno-partido", QUITAR, env, clave);
			expect(r.status).toBe(409);
			expect(turnoPartido(sql)).toBe(1);
		});
	});

	// Sin fecha, el día es «hoy» de quien pide. El reintento llega pasada la medianoche, con otra
	// `X-Client-Now`: lo que se mira es el día que se escribió, el del primer intento, que el DO
	// guardó con el resultado. Mirando el de hoy, contestaba al revés en los dos casos.
	it("sin fecha, marcarlo y reintentar pasada la medianoche contesta ok (es el día de antes)", async () => {
		relojA("2026-11-12T00:00:00Z");
		await conHub("reintento-turno-partido-medianoche", "respuesta-perdida", async (sql, env) => {
			const MARCAR = { id_usuario: USUARIO, turno_partido: true };
			const clave = "op-reintento-turno-partido-medianoche";
			expect((await pedir("/v1/login/turno-partido", MARCAR, env, clave, ANTES_DE_MEDIANOCHE)).status).toBe(500);
			expect(turnoPartido(sql)).toBe(1);

			const r = await pedir("/v1/login/turno-partido", MARCAR, env, clave, PASADA_MEDIANOCHE);
			expect(r).toEqual({ status: 200, json: { ok: true } });
			expect(turnoPartido(sql, "2026-11-12")).toBe(null);
		});
	});

	it("sin fecha, con un segundo tramo, quitarlo y reintentar pasada la medianoche contesta 409", async () => {
		relojA("2026-11-12T00:00:00Z");
		await conHub("reintento-turno-partido-medianoche-409", "respuesta-perdida", async (sql, env) => {
			conSegundoTramo(sql);
			const QUITAR_HOY = { id_usuario: USUARIO, turno_partido: false };
			const clave = "op-reintento-turno-partido-medianoche-409";
			expect((await pedir("/v1/login/turno-partido", QUITAR_HOY, env, clave, ANTES_DE_MEDIANOCHE)).status).toBe(500);

			const r = await pedir("/v1/login/turno-partido", QUITAR_HOY, env, clave, PASADA_MEDIANOCHE);
			expect(r.status).toBe(409);
			expect(turnoPartido(sql)).toBe(1);
		});
	});

	// La pantalla ya no manda la fecha de lo que tenía a la vista: con un turno de noche en curso
	// que empezó ayer, sin fecha, el día es el de esa jornada y no el de «hoy» de quien pide.
	it("sin fecha y con una jornada de noche en curso, se marca en el día de esa jornada", async () => {
		relojA("2026-11-12T00:00:00Z");
		await conHub("turno-partido-jornada-en-curso", "respuesta", async (sql, env) => {
			sql.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Estado)
				 VALUES ('fichaje-noche', ?, ?, 1, '${FECHA} 22:00:00', 'ABIERTO');`,
				USUARIO,
				FECHA,
			);
			const MARCAR = { id_usuario: USUARIO, turno_partido: true };
			const r = await pedir("/v1/login/turno-partido", MARCAR, env, "op-turno-partido-en-curso", PASADA_MEDIANOCHE);
			expect(r).toEqual({ status: 200, json: { ok: true } });
			expect(turnoPartido(sql, FECHA)).toBe(1);
			expect(turnoPartido(sql, "2026-11-12")).toBe(null);
		});
	});
});

describe("horarios: con el recuento, si se sabe; si no, por el estado", () => {
	const NUEVA = {
		id_trabajador: TRABAJADOR,
		fecha: FECHA,
		id_turno: "turno-manana",
		area: "Sala",
		tramos: [{ hora_inicio: "09:00", hora_fin: "13:00" }],
	};
	const asignaciones = (sql: any) => Number(sql.exec("SELECT COUNT(*) AS n FROM Asignacion_Turnos;").one().n);

	it("el reintento con la misma clave de un guardado ya aplicado contesta ok", async () => {
		await conHub("reintento-horario", "respuesta", async (sql, env) => {
			const clave = "op-reintento-horario-guardar";

			expect(await pedir("/v1/trabajadores/horarios/guardar", NUEVA, env, clave)).toEqual({
				status: 200,
				json: { ok: true },
			});
			expect(asignaciones(sql)).toBe(1);

			// El `saveAs` del primer INSERT tampoco se guarda: el reintento devuelve `null`.
			expect(await pedir("/v1/trabajadores/horarios/guardar", NUEVA, env, clave)).toEqual({
				status: 200,
				json: { ok: true },
			});
			expect(asignaciones(sql)).toBe(1);
		});
	});

	/**
	 * Una asignación de ayer que se intenta guardar con otra fecha: la guarda del comando (que el
	 * miembro principal siga siendo de ese trabajador y ese día) no se cumple y no toca ninguna fila.
	 */
	function conAsignacionDeOtroDia(sql: any) {
		sql.exec(
			`INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin)
			 VALUES ('asignacion-de-ayer', ?, '2026-11-10', 'turno-manana', 'Sala', '09:00', '13:00');`,
			TRABAJADOR,
		);
	}
	const EDICION = { ...NUEVA, id_asignacion: "asignacion-de-ayer", tramos: [{ hora_inicio: "10:00", hora_fin: "14:00" }] };
	const deAyer = (sql: any) =>
		sql.exec("SELECT Fecha, Hora_Inicio FROM Asignacion_Turnos WHERE ID_Asignacion = 'asignacion-de-ayer';").one();

	it("lo que no cumple la guarda, contestado por el DO sin recuento, da 404", async () => {
		await conHub("reintento-horario-do", "sin-recuento", async (sql, env) => {
			conAsignacionDeOtroDia(sql);
			const r = await pedir("/v1/trabajadores/horarios/guardar", EDICION, env, "op-reintento-horario-guarda-do");
			expect(r.status).toBe(404);
			expect(r.json.error).toBe("asignacion_no_encontrada");
			expect(deAyer(sql)).toEqual({ Fecha: "2026-11-10", Hora_Inicio: "09:00" });
		});
	});

	/**
	 * El cruce de Codex: una edición con dos tramos de un grupo que otro dispositivo borra justo antes
	 * de aplicarla (0 filas), y que, entre la respuesta perdida y el reintento, otra escritura repone
	 * con los mismos identificadores, el mismo primer tramo y otro segundo. No quedó como se pidió.
	 */
	const DOS_TRAMOS = {
		...NUEVA,
		id_asignacion: "asignacion-principal",
		tramos: [
			{ hora_inicio: "09:00", hora_fin: "13:00" },
			{ hora_inicio: "18:00", hora_fin: "22:00" },
		],
	};
	const ponerGrupo = (sql: any, segundo: [string, string]) => {
		for (const [id, inicio, fin] of [
			["asignacion-principal", "09:00", "13:00"],
			["asignacion-segunda", segundo[0], segundo[1]],
		]) {
			sql.exec(
				`INSERT INTO Asignacion_Turnos (ID_Asignacion, ID_Grupo, ID_Trabajador, Fecha, ID_Turno, Area, Hora_Inicio, Hora_Fin)
				 VALUES (?, 'grupo-1', ?, ?, 'turno-manana', 'Sala', ?, ?);`,
				id,
				TRABAJADOR,
				FECHA,
				inicio,
				fin,
			);
		}
	};
	const cruce: Ganchos = {
		antes: (sql) => sql.exec("DELETE FROM Asignacion_Turnos WHERE ID_Grupo = 'grupo-1';"),
		despues: (sql) => ponerGrupo(sql, ["17:00", "21:00"]),
	};
	const segunda = (sql: any) =>
		sql.exec("SELECT Hora_Inicio, Hora_Fin FROM Asignacion_Turnos WHERE ID_Asignacion = 'asignacion-segunda';").one();

	for (const primera of ["sin-recuento", "respuesta-perdida"] as const) {
		it(`dos tramos, el grupo borrado y repuesto con otro segundo tramo (${primera}): contesta 404`, async () => {
			await conHub(
				`reintento-horario-cruce-${primera}`,
				primera,
				async (sql, env) => {
					ponerGrupo(sql, ["17:00", "21:00"]);
					const clave = `op-reintento-horario-cruce-${primera}`;
					let r = await pedir("/v1/trabajadores/horarios/guardar", DOS_TRAMOS, env, clave);
					if (primera === "respuesta-perdida") {
						expect(r.status).toBe(500);
						r = await pedir("/v1/trabajadores/horarios/guardar", DOS_TRAMOS, env, clave);
					}
					expect(r.status).toBe(404);
					expect(r.json.error).toBe("asignacion_no_encontrada");
					expect(segunda(sql)).toEqual({ Hora_Inicio: "17:00", Hora_Fin: "21:00" });
				},
				cruce,
			);
		});
	}

	it("lo que no cumple la guarda, reintentado con la misma clave tras perder la respuesta, contesta 404", async () => {
		await conHub("reintento-horario-http", "respuesta-perdida", async (sql, env) => {
			conAsignacionDeOtroDia(sql);
			const clave = "op-reintento-horario-guarda-http";
			expect((await pedir("/v1/trabajadores/horarios/guardar", EDICION, env, clave)).status).toBe(500);

			const r = await pedir("/v1/trabajadores/horarios/guardar", EDICION, env, clave);
			expect(r.status).toBe(404);
			expect(r.json.error).toBe("asignacion_no_encontrada");
			expect(deAyer(sql)).toEqual({ Fecha: "2026-11-10", Hora_Inicio: "09:00" });
		});
	});
});

describe("turno partido sin fecha: el día es el de la X-Client-Now", () => {
	const SIN_FECHA = { id_usuario: USUARIO, turno_partido: true };
	// El rechazo, con el mismo sobre que cuando lo daba el DO (`missing_client_now`, SYNC-04): la
	// ruta lanza el mismo `HubError` que `applyViaHub` reconstruye del suyo.
	const RECHAZO = cuerpoDeErrorConStatus(new HubError("missing_client_now", 400));
	const filas = (sql: any) => Number(sql.exec("SELECT COUNT(*) AS n FROM Fichaje_Dia;").one().n);

	for (const [caso, ahora] of [
		["sin la cabecera", null],
		["con una cabecera que no es una hora", "mañana a las tres"],
		["con una hora fuera de la deriva", "2027-03-13 10:00:00"],
	] as const) {
		it(`${caso}, contesta 400 missing_client_now y no escribe`, async () => {
			relojA("2027-03-15T10:00:00Z");
			await conHub(`turno-partido-sin-hora-${caso.length}`, "respuesta", async (sql, env) => {
				const r = await pedir("/v1/login/turno-partido", SIN_FECHA, env, `op-turno-partido-sin-hora-${caso.length}`, ahora);
				expect(r).toEqual({ status: 400, json: RECHAZO });
				expect(filas(sql)).toBe(0);
			});
		});
	}

	it("con una hora válida, escribe el día de la cabecera (no el de la base)", async () => {
		// Un día que no puede ser el del reloj de la base de la prueba.
		relojA("2027-03-15T10:00:00Z");
		await conHub("turno-partido-con-hora", "respuesta", async (sql, env) => {
			const r = await pedir("/v1/login/turno-partido", SIN_FECHA, env, "op-turno-partido-con-hora", "2027-03-15 10:00:00");
			expect(r).toEqual({ status: 200, json: { ok: true } });
			expect(turnoPartido(sql, "2027-03-15")).toBe(1);
			expect(filas(sql)).toBe(1);
		});
	});
});
