// test/loginFrenoConcurrente.test.ts
//
// AUD-05 · El freno de LOGIN-01 aguanta los intentos simultáneos.
//
// `/v1/login/login` y `/v1/login/punch` RESERVAN el intento antes de verificar el PIN
// (`reservarIntento`): una sola sentencia que lo cuenta y, si con él se pasa de los libres, fija el
// bloqueo, y que no concede nada mientras haya un bloqueo en vigor. Mirando el bloqueo, verificando
// y contando después, veinte PIN malos a la vez se verificaban los veinte, contaban como un fallo y
// no dejaban bloqueo; con el token de una Handy emparejada salía así el PIN de cualquiera.
//
// Aquí corre la ruta de verdad (Hono, handler y consultas) contra el esquema real del negocio,
// servido por el SQLite del Durable Object. Sólo se sustituyen `tenantAuth` (la identidad del
// dispositivo no es lo que se prueba) y la parte de `tenantQuery` que busca la base del negocio en
// Turso: cada sentencia espera 2 ms antes de ejecutarse, como la ida y vuelta de cada consulta.
//
// Datos ficticios. Cada caso usa su propia instancia del DO y borra lo que crea.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

/** El cliente que verá `tenantQuery` en el caso que esté corriendo. */
let dbActual: any = null;

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t-aud05");
		c.set("deviceId", "dev-handy-aud05");
		await next();
	},
}));

vi.mock("../src/lib/tenantClient", async (original) => {
	const real = await (original as any)();
	const { parseClientNow } = await import("../src/durableObjects/tenantHub.tiempo");
	return {
		...real,
		// Lo mismo que hace la de verdad con la hora de quien pregunta (`X-Client-Now`), sobre la
		// base del caso en vez de la de Turso.
		tenantQuery: (c: any, fn: any) => {
			const ahoraLocal = parseClientNow(c.req.header("X-Client-Now"));
			return fn(ahoraLocal ? real.conLaHoraDeQuienPregunta(dbActual, ahoraLocal) : dbActual);
		},
	};
});

const { loginRoutes } = await import("../src/domains/login/login.routes");
const q = await import("../src/domains/login/login.queries");
const { hashPin } = await import("../src/domains/login/login.crypto");

const app = new Hono();
app.route("/v1/login", loginRoutes);

const PIN_BUENO = "4321";
/** Veinte PIN distintos y todos malos. */
const PINES_MALOS = Array.from({ length: 20 }, (_, i) => String(1000 + i));

/** LOGIN-01: cinco intentos libres y, a partir del sexto, 30 s, 1 min, 5 min y 15 min. */
const LIBRES = 5;
const ESCALONES_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000];

/** Cada sentencia espera `ms` antes de ejecutarse: la ida a la base de cada `tenantQuery`. */
function conLatencia(db: any, ms: number) {
	return {
		...db,
		async execute(entrada: any) {
			await new Promise((r) => setTimeout(r, ms));
			return db.execute(entrada);
		},
	};
}

/** Las sentencias que casen con `patron` esperan a que se abra la puerta. */
function conPuerta(db: any, patron: RegExp) {
	let abrir!: () => void;
	const puerta = new Promise<void>((r) => (abrir = r));
	let paradas = 0;
	return {
		abrir,
		/** Espera a que haya `n` sentencias paradas en la puerta. */
		async llegan(n: number) {
			while (paradas < n) await new Promise((r) => setTimeout(r, 1));
		},
		db: {
			...db,
			async execute(entrada: any) {
				const texto = typeof entrada === "string" ? entrada : entrada.sql;
				if (patron.test(String(texto))) {
					paradas++;
					await puerta;
				}
				return db.execute(entrada);
			},
		},
	};
}

function crearUsuario(sql: any, id: string, hash: string, sinPin = 0) {
	sql.exec(
		"INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Sin_PIN) VALUES (?, (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = ?), ?, ?, ?, ?);",
		id,
		"Administrador",
		`${id}@test.local`,
		hash,
		"Ada",
		sinPin,
	);
}

function limpiar(sql: any, ids: string[]) {
	for (const id of ids) {
		sql.exec("DELETE FROM Intentos_Login WHERE ID_Usuario = ?;", id);
		sql.exec("DELETE FROM Usuarios WHERE ID_Usuario = ?;", id);
	}
}

function fila(sql: any, id: string): { n: number; h: number } | null {
	const filas = sql
		.exec("SELECT Intentos_Fallidos AS n, Bloqueado_Hasta_Ms AS h FROM Intentos_Login WHERE ID_Usuario = ?;", id)
		.toArray();
	return filas[0] ? { n: Number(filas[0].n), h: Number(filas[0].h) } : null;
}

type Respuesta = { status: number; body: any };

async function intentar(
	ruta: "login" | "punch",
	id: string,
	pin: string,
	cabeceras: Record<string, string> = {},
): Promise<Respuesta> {
	// El fichaje va de salida: con el PIN bueno la ruta pasa el freno y contesta que no hay jornada
	// que cerrar, sin llegar al TenantHub, que este arnés no tiene.
	const cuerpo = ruta === "login" ? { id_usuario: id, pin } : { id_usuario: id, pin, tipo: "salida" };
	const res = await app.request(`/v1/login/${ruta}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...cabeceras },
		body: JSON.stringify(cuerpo),
	});
	// Un 500 del arnés no trae JSON: que se vea el estado, no un fallo al leer el cuerpo.
	const texto = await res.text();
	let body: any = null;
	try {
		body = JSON.parse(texto);
	} catch {
		body = { error: texto };
	}
	return { status: res.status, body };
}

function contar(respuestas: Respuesta[]) {
	const estados = respuestas.map((r) => r.status);
	return {
		verificados: estados.filter((s) => s === 401 || s === 200).length,
		frenados: estados.filter((s) => s === 429).length,
		otros: estados.filter((s) => s !== 401 && s !== 200 && s !== 429),
	};
}

/** Lo que contesta cada ruta cuando el PIN es el bueno (ver `intentar`). */
const ACIERTO = { login: 200, punch: 409 } as const;

/** `YYYY-MM-DD HH:MM:SS` de un instante, como lo manda la Handy en `X-Client-Now`. */
function horaDeCliente(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

describe("AUD-05 · el freno de LOGIN-01 con intentos simultáneos", () => {
	for (const ruta of ["login", "punch"] as const) {
		it(`POST /${ruta}: de 20 PIN malos a la vez se verifican 6, como en serie, y queda el bloqueo`, async () => {
			await enElHub(`aud05-ruta-${ruta}`, async (hub: any) => {
				const sql = hub.state.storage.sql;
				crearEsquemaTenant(sql);
				const hash = await hashPin(PIN_BUENO);
				crearUsuario(sql, "user-1", hash);
				crearUsuario(sql, "user-2", hash);
				dbActual = conLatencia(clienteSobre(sql), 2);
				try {
					// A la vez, contra user-1.
					const respuestas = await Promise.all(PINES_MALOS.map((pin) => intentar(ruta, "user-1", pin)));
					const ahora = Date.now();
					const trasParalelo = fila(sql, "user-1");
					expect(contar(respuestas)).toEqual({ verificados: LIBRES + 1, frenados: 14, otros: [] });
					// Seis fallos contados y el primer escalón puesto.
					expect(trasParalelo?.n).toBe(LIBRES + 1);
					expect(trasParalelo!.h - ahora).toBeGreaterThan(20_000);
					expect(trasParalelo!.h - ahora).toBeLessThanOrEqual(ESCALONES_MS[0]);
					// Con el bloqueo puesto, ni el PIN bueno pasa.
					expect((await intentar(ruta, "user-1", PIN_BUENO)).status).toBe(429);

					// Uno detrás de otro, contra user-2: lo mismo.
					const respuestasEnSerie: Respuesta[] = [];
					for (const pin of PINES_MALOS) respuestasEnSerie.push(await intentar(ruta, "user-2", pin));
					expect(contar(respuestasEnSerie)).toEqual({ verificados: LIBRES + 1, frenados: 14, otros: [] });
					expect(fila(sql, "user-2")?.n).toBe(LIBRES + 1);

					// Con los textos de siempre.
					for (const r of [...respuestas, ...respuestasEnSerie]) {
						if (r.status === 401) expect(r.body.error).toBe("PIN incorrecto");
						else expect(r.body.error).toMatch(/^Demasiados intentos fallidos\. Prueba de nuevo en \d+ s\.$/);
					}
				} finally {
					limpiar(sql, ["user-1", "user-2"]);
				}
			});
		}, 120_000);
	}

	it("de diez reservas a la vez se conceden seis, y la fila queda con 6 fallos y 30 s", async () => {
		await enElHub("aud05-reservas", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			crearUsuario(sql, "user-3", "h");
			const db = conLatencia(clienteSobre(sql), 2) as any;
			try {
				const reservas = await Promise.all(Array.from({ length: 10 }, () => q.reservarIntento(db, "user-3")));
				const ahora = Date.now();

				const concedidas = reservas.flatMap((r) => (r.concedido ? [r.intento] : []));
				expect(concedidas.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
				for (const r of reservas) {
					if (r.concedido) continue;
					expect(r.segundos).toBeGreaterThanOrEqual(1);
					expect(r.segundos).toBeLessThanOrEqual(30);
				}
				expect(fila(sql, "user-3")?.n).toBe(6);
				expect(fila(sql, "user-3")!.h - ahora).toBeGreaterThan(20_000);
				expect(fila(sql, "user-3")!.h - ahora).toBeLessThanOrEqual(ESCALONES_MS[0]);
			} finally {
				limpiar(sql, ["user-3"]);
			}
		});
	}, 60_000);

	it("una reserva que llega tarde no quita el bloqueo que ya había", async () => {
		await enElHub("aud05-atrasada", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			crearUsuario(sql, "user-4", "h");
			const db = clienteSobre(sql) as any;
			try {
				// Cuatro fallos previos, sin bloqueo todavía.
				for (let i = 0; i < 4; i++) expect((await q.reservarIntento(db, "user-4")).concedido).toBe(true);
				expect(fila(sql, "user-4")).toEqual({ n: 4, h: 0 });

				// A sale ahora, pero su sentencia se queda por el camino.
				const a = conPuerta(db, /INSERT INTO Intentos_Login/);
				const reservaA = q.reservarIntento(a.db, "user-4");
				// Mientras, otros dos intentos: el quinto y el sexto, que fija 30 s.
				await q.reservarIntento(db, "user-4");
				await q.reservarIntento(db, "user-4");
				const bloqueada = fila(sql, "user-4");
				expect(bloqueada?.n).toBe(6);
				expect(bloqueada!.h).toBeGreaterThan(Date.now());

				// Llega la de A: no se concede y la fila queda como estaba.
				a.abrir();
				expect((await reservaA).concedido).toBe(false);
				expect(fila(sql, "user-4")).toEqual(bloqueada);

				// Tampoco una calculada con un reloj atrasado.
				expect((await q.reservarIntento(db, "user-4", Date.now() - 60_000)).concedido).toBe(false);
				expect(fila(sql, "user-4")).toEqual(bloqueada);
			} finally {
				limpiar(sql, ["user-4"]);
			}
		});
	}, 60_000);

	for (const ruta of ["login", "punch"] as const) {
		it(`POST /${ruta}: un acierto cuyo borrado llega tarde no quita el bloqueo que se puso después`, async () => {
			await enElHub(`aud05-borrado-tarde-${ruta}`, async (hub: any) => {
				const sql = hub.state.storage.sql;
				crearEsquemaTenant(sql);
				crearUsuario(sql, "user-9", await hashPin(PIN_BUENO));
				// Lo que se queda por el camino es el borrado del recuento, no la reserva.
				const puerta = conPuerta(clienteSobre(sql), /DELETE FROM Intentos_Login/);
				dbActual = puerta.db;
				try {
					// A y B aciertan a la vez: reservan, verifican, y sus borrados no llegan todavía.
					const a = intentar(ruta, "user-9", PIN_BUENO);
					const b = intentar(ruta, "user-9", PIN_BUENO);
					await puerta.llegan(2);
					expect(fila(sql, "user-9")).toEqual({ n: 2, h: 0 });

					// Mientras, cuatro PIN malos: con el sexto intento queda puesto el bloqueo.
					for (const pin of PINES_MALOS.slice(0, 4)) {
						expect((await intentar(ruta, "user-9", pin)).status).toBe(401);
					}
					const bloqueada = fila(sql, "user-9");
					expect(bloqueada?.n).toBe(LIBRES + 1);
					expect(bloqueada!.h).toBeGreaterThan(Date.now());

					// Llegan los dos borrados: A y B entraron, pero el bloqueo no es suyo y se queda.
					puerta.abrir();
					expect((await a).status).toBe(ACIERTO[ruta]);
					expect((await b).status).toBe(ACIERTO[ruta]);
					expect(fila(sql, "user-9")).toEqual(bloqueada);
					expect((await intentar(ruta, "user-9", PIN_BUENO)).status).toBe(429);
				} finally {
					limpiar(sql, ["user-9"]);
				}
			});
		}, 60_000);
	}

	it("el bloqueo sólo lo quita el acierto del intento que lo puso, o cualquiera cuando ya ha vencido", async () => {
		await enElHub("aud05-bloqueo-propio", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			crearUsuario(sql, "user-10", "h");
			const db = clienteSobre(sql) as any;
			try {
				const ahora = Date.now();
				const reservar = async () => {
					const r = await q.reservarIntento(db, "user-10", ahora);
					if (!r.concedido) throw new Error("no se concedió la reserva");
					return r;
				};
				for (let i = 0; i < LIBRES - 1; i++) await reservar();
				const quinto = await reservar();
				const sexto = await reservar();
				expect(quinto.bloqueadoHastaMs).toBe(0);
				expect(sexto.bloqueadoHastaMs).toBe(ahora + ESCALONES_MS[0]);
				const bloqueada = { n: LIBRES + 1, h: ahora + ESCALONES_MS[0] };

				// El acierto del quinto llega con el bloqueo del sexto en vigor: no lo quita.
				await q.throttleReset(db, "user-10", quinto.bloqueadoHastaMs, ahora + 1);
				expect(fila(sql, "user-10")).toEqual(bloqueada);
				// El del sexto sí: el bloqueo lo puso su propia reserva.
				await q.throttleReset(db, "user-10", sexto.bloqueadoHastaMs, ahora + 1);
				expect(fila(sql, "user-10")).toBeNull();

				// Y con el bloqueo ya vencido lo borra cualquier acierto, como siempre.
				for (let i = 0; i < LIBRES + 1; i++) await reservar();
				expect(fila(sql, "user-10")).toEqual(bloqueada);
				await q.throttleReset(db, "user-10", 0, ahora + ESCALONES_MS[0]);
				expect(fila(sql, "user-10")).toBeNull();
			} finally {
				limpiar(sql, ["user-10"]);
			}
		});
	}, 60_000);

	it("la hora que dice el cliente no acorta el bloqueo", async () => {
		await enElHub("aud05-hora-del-cliente", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			crearUsuario(sql, "user-5", await hashPin(PIN_BUENO));
			dbActual = clienteSobre(sql);
			try {
				for (let i = 0; i < LIBRES + 1; i++) expect((await intentar("login", "user-5", "1000")).status).toBe(401);
				const bloqueada = fila(sql, "user-5");

				// Trece horas por delante: dentro de lo que `X-Client-Now` admite como zona horaria.
				const adelantada = { "X-Client-Now": horaDeCliente(Date.now() + 13 * 60 * 60_000) };
				expect((await intentar("login", "user-5", PIN_BUENO, adelantada)).status).toBe(429);
				expect((await intentar("punch", "user-5", PIN_BUENO, adelantada)).status).toBe(429);
				expect(fila(sql, "user-5")).toEqual(bloqueada);
			} finally {
				limpiar(sql, ["user-5"]);
			}
		});
	}, 60_000);
});

describe("AUD-05 · uno detrás de otro, lo de siempre", () => {
	it("el PIN bueno tras un fallo entra y limpia el recuento", async () => {
		await enElHub("aud05-acierto", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			crearUsuario(sql, "user-6", await hashPin(PIN_BUENO));
			dbActual = clienteSobre(sql);
			try {
				expect((await intentar("login", "user-6", "1000")).status).toBe(401);
				// Un fallo contado y ningún bloqueo en vigor.
				expect(fila(sql, "user-6")?.n).toBe(1);
				expect(fila(sql, "user-6")!.h).toBeLessThanOrEqual(Date.now());

				const entra = await intentar("login", "user-6", PIN_BUENO);
				expect(entra.status).toBe(200);
				expect(entra.body.id_usuario).toBe("user-6");
				expect(fila(sql, "user-6")).toBeNull();

				// Y vuelve a tener sus cinco intentos libres. El sexto fija el bloqueo al reservarse; si
				// es el bueno, entra y se lo lleva con el recuento: no se queda bloqueado por acertar.
				for (let i = 0; i < LIBRES; i++) expect((await intentar("login", "user-6", "1000")).status).toBe(401);
				expect((await intentar("login", "user-6", PIN_BUENO)).status).toBe(200);
				expect(fila(sql, "user-6")).toBeNull();
				expect((await intentar("login", "user-6", PIN_BUENO)).status).toBe(200);
			} finally {
				limpiar(sql, ["user-6"]);
			}
		});
	}, 60_000);

	it("los escalones son los de LOGIN-01: cinco libres y después 30 s, 1 min, 5 min y 15 min", async () => {
		await enElHub("aud05-escalones", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			crearUsuario(sql, "user-7", "h");
			const db = clienteSobre(sql) as any;
			try {
				// El reloj lo lleva el test: cada intento llega justo cuando vence el bloqueo anterior.
				let ahora = Date.now();
				for (let n = 1; n <= LIBRES; n++) {
					expect(await q.reservarIntento(db, "user-7", ahora)).toEqual({
						concedido: true,
						intento: n,
						bloqueadoHastaMs: 0,
					});
					expect(fila(sql, "user-7")).toEqual({ n, h: 0 });
				}
				const esperados = [...ESCALONES_MS, ESCALONES_MS[3], ESCALONES_MS[3]];
				for (const [i, escalon] of esperados.entries()) {
					const n = LIBRES + 1 + i;
					expect(await q.reservarIntento(db, "user-7", ahora)).toEqual({
						concedido: true,
						intento: n,
						bloqueadoHastaMs: ahora + escalon,
					});
					expect(fila(sql, "user-7")).toEqual({ n, h: ahora + escalon });
					// Un milisegundo antes de que venza sigue bloqueado, y no cuenta como intento.
					expect((await q.reservarIntento(db, "user-7", ahora + escalon - 1)).concedido).toBe(false);
					expect(fila(sql, "user-7")).toEqual({ n, h: ahora + escalon });
					ahora += escalon;
				}
			} finally {
				limpiar(sql, ["user-7"]);
			}
		});
	}, 60_000);

	it("quien entra sin PIN ni reserva intento ni se queda fuera por un bloqueo anterior", async () => {
		await enElHub("aud05-sin-pin", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			crearUsuario(sql, "user-8", await hashPin(PIN_BUENO), 1);
			dbActual = clienteSobre(sql);
			try {
				const hasta = Date.now() + 15 * 60_000;
				sql.exec(
					"INSERT INTO Intentos_Login (ID_Usuario, Intentos_Fallidos, Bloqueado_Hasta_Ms, Ultimo_Intento_Ms) VALUES ('user-8', 9, ?, 0);",
					hasta,
				);
				expect((await intentar("login", "user-8", "")).status).toBe(200);
				expect(fila(sql, "user-8")).toEqual({ n: 9, h: hasta });
			} finally {
				limpiar(sql, ["user-8"]);
			}
		});
	}, 60_000);
});
