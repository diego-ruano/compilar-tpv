// test/correoTopeDiarioConcurrente.test.ts
//
// AUD-41 · El tope diario de pedidos por correo (REV-14) frente a peticiones a la vez del mismo
// negocio. Antes se contaba lo entregado y la fila se apuntaba después de enviar: todas las que
// contaban a la vez leían el mismo recuento y pasaban, aunque juntas superasen el tope. Ahora el
// sitio se reserva con la fila, en una sola sentencia, antes de enviar (`reservarCupo`).
//
// La ruta de verdad, con SQL de verdad: la base central y la del negocio en el SQLite de un Durable
// Object, la autenticación simulada y el envío de correo doblado. Ningún caso mide tiempo: el cruce
// de las peticiones a la vez lo fuerza una barrera, no una espera.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { clienteSobre } from "./helpers/clienteSql";
import { enLaAgenda } from "./helpers/agenda";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

// El router va suelto, con sus dobles: la ruta corre aquí, sin el viaje al TenantHub.
vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

/** La base del negocio de la prueba en curso (`tenantQuery`). */
let base: any = null;
/** La base central de la prueba en curso (`getDb`): el mismo SQLite, con su propio cliente. */
let central: any = null;

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "dev");
		await next();
	},
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (_c: any, fn: any) => fn(base),
}));

vi.mock("../src/server/db", async (original) => ({
	...(await (original as any)()),
	getDb: () => central,
}));

const { emailRoutes, TOPE_DIARIO, VENTANA_MS } = await import("../src/domains/email/email.routes");

const app = new Hono();
app.route("/v1/email", emailRoutes);
// Como `index.ts`: un error con su status (el 403 de un destinatario que no es proveedor) sale con él.
app.onError((err: any, c) => c.json({ error: err?.code ?? "internal_error" }, err?.status ?? 500));

const INSERT_ENVIO = `INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, sent_at_ms)
                      VALUES (?, 't1', 'dev', 'prov@prueba.test', 'Prov', 1, ?);`;

type Ctx = { sql: any; directo: any };

/** Un negocio con su proveedor y su contacto, y `previos` pedidos ya entregados hoy. */
async function conNegocio<T>(nombre: string, previos: number, prueba: (ctx: Ctx) => Promise<T>): Promise<T> {
	return enLaAgenda(`aud41-${nombre}`, async (_motor, state) => {
		const sql = state.storage.sql;
		crearEsquemaTenant(sql);
		prepararPlanoDeControl(sql);
		sql.exec(`UPDATE Contact_Settings SET Contact_Email = 'bar@prueba.test' WHERE ID = 1;`);
		sql.exec(
			`INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Email) VALUES ('p1', 'Prov', 'prov@prueba.test');`,
		);
		for (let i = 0; i < previos; i++) sql.exec(INSERT_ENVIO, crypto.randomUUID(), Date.now());
		const directo = clienteSobre(sql, state.storage);
		base = directo;
		central = directo;
		try {
			return await prueba({ sql, directo });
		} finally {
			base = null;
			central = null;
		}
	});
}

/** El entorno de la ruta con el envío de correo doblado. */
function entorno(send: (m: any) => Promise<void>) {
	return { EMAIL_FROM_ADDRESS: "pedidos@prueba.test", EMAIL: { send } };
}

/** Un envío de correo que apunta lo que sale. */
function correoQueSale() {
	const enviados: any[] = [];
	return { enviados, env: entorno(async (m) => void enviados.push(m)) };
}

function pedir(env: any, destino = "prov@prueba.test"): Promise<Response> {
	return Promise.resolve(
		app.request(
			"/v1/email/enviar-pedido",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email_destino: destino, nombre_proveedor: "Prov", notas: "prueba", id_envio: crypto.randomUUID() }),
			},
			env,
		),
	);
}

/**
 * `n` pedidos a la vez, en el peor cruce: ningún correo termina de salir hasta que los `n` han
 * decidido, o porque están enviando o porque ya han contestado sin enviar. Así todos han pasado por
 * el tope antes de que salga el primero, vaya la máquina lo rápida que vaya. `alAbrir` corre entre
 * las reservas y los envíos (para mover el reloj de la prueba).
 */
async function aLaVez(n: number, alAbrir?: () => void) {
	const enviados: any[] = [];
	let decididos = 0;
	let abierta = false;
	let abrir!: () => void;
	const barrera = new Promise<void>((r) => (abrir = r));
	const decidir = () => {
		// Los que envían están parados en la barrera: lo que contesta antes de abrirla no ha enviado.
		if (!abierta && ++decididos >= n) {
			abierta = true;
			alAbrir?.();
			abrir();
		}
	};
	const env = entorno(async (m) => {
		decidir();
		await barrera;
		enviados.push(m);
	});
	const respuestas = await Promise.all(
		Array.from({ length: n }, () =>
			pedir(env).then((r) => {
				decidir();
				return r;
			}),
		),
	);
	return { respuestas, enviados };
}

async function resumen(respuestas: Response[], enviados: any[], ctx: Ctx) {
	const cuerpos: any[] = await Promise.all(respuestas.map((r) => r.json()));
	const filas = (donde: string) =>
		Number(ctx.sql.exec(`SELECT COUNT(*) AS n FROM email_sends WHERE tenant_id = 't1' AND tipo = 'pedido' AND ${donde};`).one().n);
	return {
		respuestas200: respuestas.filter((r) => r.status === 200).length,
		respuestas429: cuerpos.filter((c, i) => respuestas[i].status === 429 && c.error === "email_limite_diario").length,
		enviados: enviados.length,
		filasOk: filas("ok = 1"),
		filasEnviando: filas("error_code = 'enviando'"),
	};
}

describe("AUD-41 · el tope diario de pedidos con peticiones a la vez", () => {
	it("en serie, con 99 entregados, sale 1 y las otras 11 se cortan", async () => {
		const r = await conNegocio("en-serie", TOPE_DIARIO - 1, async (ctx) => {
			const { enviados, env } = correoQueSale();
			const respuestas: Response[] = [];
			for (let i = 0; i < 12; i++) respuestas.push(await pedir(env));
			return resumen(respuestas, enviados, ctx);
		});
		expect(r).toEqual({ respuestas200: 1, respuestas429: 11, enviados: 1, filasOk: TOPE_DIARIO, filasEnviando: 0 });
	});

	it("a la vez, con 99 entregados, también sale 1 y las otras 11 se cortan", async () => {
		const r = await conNegocio("a-la-vez", TOPE_DIARIO - 1, async (ctx) => {
			const { respuestas, enviados } = await aLaVez(12);
			return resumen(respuestas, enviados, ctx);
		});
		expect(r).toEqual({ respuestas200: 1, respuestas429: 11, enviados: 1, filasOk: TOPE_DIARIO, filasEnviando: 0 });
	});

	// 250 pedidos enteros por la ruta: solo, el fichero entero tarda unos 2 s, pero en la suite
	// completa, con los demás ficheros a la vez, esta prueba pasaba de los 5 s de espera por defecto.
	// El resultado no depende del tiempo, así que la espera sólo tiene que dar margen.
	it("una ráfaga de 250 a la vez sobre un día vacío deja salir exactamente el tope", { timeout: 60_000 }, async () => {
		const r = await conNegocio("rafaga", 0, async (ctx) => {
			const { respuestas, enviados } = await aLaVez(250);
			return resumen(respuestas, enviados, ctx);
		});
		expect(r).toEqual({
			respuestas200: TOPE_DIARIO,
			respuestas429: 250 - TOPE_DIARIO,
			enviados: TOPE_DIARIO,
			filasOk: TOPE_DIARIO,
			filasEnviando: 0,
		});
	});

	it("un envío cuenta desde que salió: una ráfaga lenta no deja sitio a otra antes de sus 24 h", async () => {
		// El reloj lo pone la prueba (`Date.now`), sin esperas reales. Las 100 se reservan a las
		// 12:00:00 y salen a las 12:00:30. Contadas desde la reserva, a las 12:00:01 del día siguiente
		// ya cabrían otras 100: 200 envíos en menos de 24 h.
		const T0 = Date.UTC(2026, 10, 11, 11, 0, 0);
		let reloj = T0;
		const ahora = vi.spyOn(Date, "now").mockImplementation(() => reloj);
		try {
			const r = await conNegocio("desde-que-salio", 0, async (ctx) => {
				const primera = await aLaVez(TOPE_DIARIO, () => (reloj = T0 + 30_000));
				const horas = ctx.sql.exec(`SELECT DISTINCT sent_at_ms AS t FROM email_sends;`).toArray().map((f: any) => f.t);
				reloj = T0 + VENTANA_MS + 1000;
				const segunda = await aLaVez(TOPE_DIARIO);
				// A las 12:00:31 del día siguiente, las primeras ya tienen sus 24 h.
				reloj = T0 + 30_000 + VENTANA_MS + 1000;
				const { enviados, env } = correoQueSale();
				const tercera = await pedir(env);
				return {
					primera: primera.enviados.length,
					horas,
					segunda: segunda.enviados.length,
					tercera: [tercera.status, enviados.length],
				};
			});
			expect(r).toEqual({ primera: TOPE_DIARIO, horas: [T0 + 30_000], segunda: 0, tercera: [200, 1] });
		} finally {
			ahora.mockRestore();
		}
	});
});

describe("AUD-41 · la reserva del cupo en la ruta", () => {
	it("un envío que falla deja su fila con el código del binding y libera el sitio", async () => {
		const r = await conNegocio("falla", TOPE_DIARIO - 1, async (ctx) => {
			const falla = entorno(async () => {
				throw Object.assign(new Error("caído"), { code: "E_RATE_LIMIT_EXCEEDED" });
			});
			const primera = await pedir(falla);
			const fallo = ctx.sql.exec(`SELECT ok, error_code FROM email_sends WHERE ok = 0;`).toArray();
			const { enviados, env } = correoQueSale();
			const segunda = await pedir(env);
			return { primera: [primera.status, ((await primera.json()) as any).error], fallo, segunda: segunda.status, enviados: enviados.length };
		});
		expect(r).toEqual({
			primera: [500, "email_send_failed"],
			fallo: [{ ok: 0, error_code: "E_RATE_LIMIT_EXCEEDED" }],
			segunda: 200,
			enviados: 1,
		});
	});

	it("un pedido que se rechaza antes de enviar no gasta cupo", async () => {
		const r = await conNegocio("rechazado", TOPE_DIARIO - 1, async (ctx) => {
			const { enviados, env } = correoQueSale();
			const rechazado = await pedir(env, "otro@prueba.test");
			const filas = ctx.sql.exec(`SELECT COUNT(*) AS n FROM email_sends;`).one().n;
			const bueno = await pedir(env);
			return { rechazado: [rechazado.status, ((await rechazado.json()) as any).error], filas, bueno: bueno.status, enviados: enviados.length };
		});
		expect(r).toEqual({ rechazado: [403, "email_destino_no_autorizado"], filas: TOPE_DIARIO - 1, bueno: 200, enviados: 1 });
	});

	it("sale cerrado: la fila del pedido acaba entregada, con quién, a quién y a qué proveedor", async () => {
		const r = await conNegocio("cerrado", 0, async (ctx) => {
			const { env } = correoQueSale();
			const res = await pedir(env);
			return { status: res.status, filas: ctx.sql.exec(`SELECT * FROM email_sends;`).toArray() };
		});
		expect(r.status).toBe(200);
		expect(r.filas).toHaveLength(1);
		expect(r.filas[0]).toMatchObject({
			tenant_id: "t1",
			device_id: "dev",
			to_email: "prov@prueba.test",
			proveedor: "Prov",
			ok: 1,
			error_code: null,
			tipo: "pedido",
		});
	});

	it("si la base central no deja reservar, se envía igual y se apunta después si se puede", async () => {
		const r = await conNegocio("sin-reserva", TOPE_DIARIO - 1, async (ctx) => {
			central = {
				execute: async (q: any) => {
					if (/^\s*INSERT INTO email_sends[\s\S]*SELECT\s+\?1/.test(String(q.sql))) throw new Error("turso caído");
					return ctx.directo.execute(q);
				},
			};
			const { enviados, env } = correoQueSale();
			const res = await pedir(env);
			return { status: res.status, enviados: enviados.length, filasOk: ctx.sql.exec(`SELECT COUNT(*) AS n FROM email_sends WHERE ok = 1;`).one().n };
		});
		expect(r).toEqual({ status: 200, enviados: 1, filasOk: TOPE_DIARIO });
	});

	it("sin la base central, el pedido sale aunque no quede apuntado", async () => {
		const r = await conNegocio("sin-base", 0, async (ctx) => {
			central = { execute: async () => { throw new Error("turso caído"); } };
			const { enviados, env } = correoQueSale();
			const res = await pedir(env);
			return { status: res.status, enviados: enviados.length, filas: ctx.sql.exec(`SELECT COUNT(*) AS n FROM email_sends;`).one().n };
		});
		expect(r).toEqual({ status: 200, enviados: 1, filas: 0 });
	});
});
