// test/lecturasPorPost.test.ts
//
// AUD-27: lo que es de una persona, y lo que alguien escribe en un buscador, llega en el cuerpo.
//
// La Handy mandaba en la query el teléfono y el correo del cliente de una reserva y lo que se
// buscaba en Cuentas y en la carta, y la URL de cada petición se queda en los registros de
// Cloudflare. Esas seis lecturas van ahora por POST, como ya iba el resumen de tickets
// (`/index-rows`). Aquí se recorren las siete rutas de verdad, con su tope, su validador y sus
// consultas sobre el esquema real del negocio, y se comprueba que:
//
//   · contestan lo mismo leyendo del cuerpo, y el GET de antes ya no busca nada;
//   · siguen siendo lecturas: sin `X-Idempotency-Key`, sin pasar por el motor de escrituras del
//     `TenantHub`, con la hora de quien pregunta y abiertas a una Handy;
//   · un cuerpo que no es una búsqueda se rechaza antes de autenticar, que es cuando se lee.
//
// Lo único que se sustituye es lo que no se puede levantar aquí: la autenticación del dispositivo
// (`tenantAuth`, que deja pasar a una Handy emparejada) y la base del negocio (se sirve con el
// SQLite del DO y el esquema de producción). La regla, leída del fuente, está en
// `sinDatosPersonalesEnLaQuery.node.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

/** La base del negocio de la prueba: el SQLite del DO con el esquema real. */
let dbActual: any = null;
/** Las rutas que han llegado a autenticarse. */
const autenticadas: string[] = [];
/** La `X-Client-Now` con la que cada lectura ha llegado a `tenantQuery`, que es quien la fija. */
const horas: (string | undefined)[] = [];
/** Las veces que algo ha pedido el Durable Object del negocio. */
let vecesEnElHub = 0;

const AHORA = "2026-11-08 20:00:00";

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	// Una Handy emparejada y con licencia: el JWT y el device-proof ya están verificados.
	tenantAuth: async (c: any, next: any) => {
		autenticadas.push(`${c.req.method} ${c.req.path}`);
		c.set("tenantId", "t-aud27");
		c.set("deviceId", "dev-handy");
		await next();
	},
}));

// El rol que dice la base central: una Handy. Si alguna de estas lecturas llevara un veto «sólo la
// Main», contestaría 403.
vi.mock("../src/server/db", () => ({
	getDb: () => ({ execute: async () => ({ rows: [{ role: "handy" }] }) }),
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (c: any, fn: any) => {
		horas.push(c.req.header("X-Client-Now"));
		return fn(dbActual);
	},
}));

const { cuentasRoutes } = await import("../src/domains/cuentas/cuentas.routes");
const { mesasRoutes } = await import("../src/domains/mesas/mesas.routes");
const { reservasRoutes } = await import("../src/domains/reservas/reservas.routes");
const { ventaRapidaRoutes } = await import("../src/domains/venta_rapida/venta_rapida.routes");
const { seleccionarCuerpo } = await import("../src/observability/requestContext");

const app = new Hono();
app.route("/v1/cuentas", cuentasRoutes);
app.route("/v1/mesas", mesasRoutes);
app.route("/v1/reservas", reservasRoutes);
app.route("/v1/venta-rapida", ventaRapidaRoutes);

/**
 * El binding del DO. La base se sirve aquí con `tenantQuery` sustituido, así que lo único que podría
 * pedirlo es una escritura (`apply`), y una lectura no aplica nada. Por la app entera y con la base
 * dentro del DO, estas rutas están en `unViajePorPeticion.test.ts`.
 */
const env = {
	TenantHub: {
		idFromName: () => {
			vecesEnElHub += 1;
			throw new Error("una lectura no aplica nada por el TenantHub");
		},
		get: () => {
			vecesEnElHub += 1;
			throw new Error("una lectura no aplica nada por el TenantHub");
		},
	},
};

/** Como sale de la Handy: con su hora, y **sin** `X-Idempotency-Key`. */
async function pedir(metodo: "GET" | "POST", ruta: string, cuerpo?: unknown) {
	const res = await app.request(
		ruta,
		{
			method: metodo,
			headers: {
				"X-Client-Now": AHORA,
				...(cuerpo === undefined ? {} : { "content-type": "application/json" }),
			},
			body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
		},
		env as any,
	);
	const texto = await res.text();
	let json: any;
	try {
		json = JSON.parse(texto);
	} catch {
		json = undefined;
	}
	return { status: res.status, json, texto };
}

const SEMILLA = [
	"INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Created_At) VALUES ('cli-1', 'Cliente Ficticio', '600000000', 'prueba@ejemplo.invalid', '2026-01-01 10:00:00');",
	"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');",
	"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '7', 4, 0, 0, 'rect', 80, 80);",
	// La comanda del cliente, y otra sin él.
	"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, ID_Cliente, Fecha_Hora_Apertura, Estado) VALUES ('com-1', 'MESA', 'mesa-1', 'cli-1', '2026-05-10 09:00:00', 'Pagada');",
	"INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('com-2', 'MESA', 'mesa-1', '2026-05-10 10:30:00', 'Pagada');",
	"INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('pago-1', 'com-1', '2026-05-10 10:00:00', 'Efectivo', 1000, 'total');",
	"INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('pago-2', 'com-2', '2026-05-10 11:00:00', 'Tarjeta', 2000, 'total');",
	"INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Tipo_Gasto, Concepto, Importe) VALUES ('gasto-1', '2026-05-02', 'Compras', 'Cajas de cerveza', 15000);",
	"INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Tipo_Gasto, Concepto, Importe) VALUES ('gasto-2', '2026-05-20', 'Suministros', 'Luz', 9055);",
	"INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Pasa_Cocina) VALUES ('cat-cocina', 'Platos', 1);",
	"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-croquetas', 'cat-cocina', 'Croquetas', 750);",
	"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-cerveza', 'cat-cocina', 'Cerveza', 300);",
	// Lo que se pidió en la comanda del cliente.
	"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('det-1', 'com-1', 'prod-croquetas', 1, 750);",
	"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('det-2', 'com-1', 'prod-cerveza', 2, 300);",
];

const MAYO = { del: "2026-05-01", al: "2026-05-31" };

/** Un negocio con un cliente, dos cobros (uno suyo, con dos líneas), dos gastos y dos productos. */
async function conNegocio(nombre: string, fn: () => Promise<void>) {
	await enElHub(nombre, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const sentencia of SEMILLA) sql.exec(sentencia);
		dbActual = clienteSobre(sql, hub.state.storage);
		await fn();
	});
}

const KB = 1024;

/** Las lecturas por POST, con un cuerpo que encuentra algo y el tope del suyo. */
const LECTURAS: { ruta: string; cuerpo: Record<string, unknown>; tope: number }[] = [
	{ ruta: "/v1/reservas/buscar-cliente", cuerpo: { telefono: "600000000" }, tope: 8 * KB },
	{ ruta: "/v1/cuentas/entradas", cuerpo: { ...MAYO, q: "cliente ficticio" }, tope: 8 * KB },
	{ ruta: "/v1/cuentas/salidas", cuerpo: { ...MAYO, q: "luz" }, tope: 8 * KB },
	{ ruta: "/v1/cuentas/resumen", cuerpo: { ...MAYO, q: "cliente ficticio" }, tope: 8 * KB },
	{ ruta: "/v1/mesas/productos/search", cuerpo: { query: "cro" }, tope: 8 * KB },
	{ ruta: "/v1/venta-rapida/productos/search", cuerpo: { query: "cro", limit: 5 }, tope: 8 * KB },
	// La lista de ids de los tickets en pantalla ocupa más que una búsqueda.
	{ ruta: "/v1/venta-rapida/index-rows", cuerpo: { ids: ["com-1", "com-2"] }, tope: 64 * KB },
];

beforeEach(() => {
	dbActual = null;
	autenticadas.length = 0;
	horas.length = 0;
	vecesEnElHub = 0;
});

describe("AUD-27 · el cliente de una reserva se busca con el cuerpo", () => {
	it("por teléfono y por correo, con lo mismo que normalizaba la query", async () => {
		await conNegocio("aud27-buscar-cliente", async () => {
			const porTelefono = await pedir("POST", "/v1/reservas/buscar-cliente", { telefono: " 600000000 " });
			expect(porTelefono.status).toBe(200);
			expect(porTelefono.json).toMatchObject({ id_cliente: "cli-1", coincide_por: "telefono" });

			const porCorreo = await pedir("POST", "/v1/reservas/buscar-cliente", {
				telefono: null,
				email: "Prueba@EJEMPLO.invalid",
			});
			expect(porCorreo.status).toBe(200);
			expect(porCorreo.json).toMatchObject({ id_cliente: "cli-1", coincide_por: "email" });

			const deNadie = await pedir("POST", "/v1/reservas/buscar-cliente", { telefono: "699999999" });
			expect(deNadie).toMatchObject({ status: 200, json: null });
		});
	});

	it("sin teléfono ni correo no hay nada que buscar, y no se consulta", async () => {
		await conNegocio("aud27-buscar-sin-nada", async () => {
			const r = await pedir("POST", "/v1/reservas/buscar-cliente", {});
			expect(r).toMatchObject({ status: 200, json: null });
			expect(horas).toEqual([]);
		});
	});

	it("el GET de antes ya no busca: el teléfono de la query no encuentra al cliente", async () => {
		await conNegocio("aud27-buscar-get", async () => {
			const r = await pedir("GET", "/v1/reservas/buscar-cliente?telefono=600000000&email=prueba%40ejemplo.invalid");
			// Lo atiende `GET /:id`, que busca una reserva con ese id y no hay ninguna.
			expect(r.json).toBeNull();
		});
	});
});

describe("AUD-27 · lo que se busca en Cuentas va en el cuerpo", () => {
	it("las entradas se filtran por el nombre del cliente", async () => {
		await conNegocio("aud27-entradas", async () => {
			const r = await pedir("POST", "/v1/cuentas/entradas", { ...MAYO, q: "Cliente Ficticio", page_size: 50 });
			expect(r.status).toBe(200);
			expect(r.json.filas.map((f: any) => f.id)).toEqual(["pago-1"]);
			expect(r.json.filas[0].cliente).toBe("Mesa 7 / Cliente Ficticio");
			expect(r.json.siguiente).toBeNull();
		});
	});

	it("la paginación sigue con el cursor en sus dos campos", async () => {
		await conNegocio("aud27-entradas-pagina", async () => {
			const primera = await pedir("POST", "/v1/cuentas/entradas", { ...MAYO, page_size: 1 });
			expect(primera.json.filas.map((f: any) => f.id)).toEqual(["pago-2"]);
			expect(primera.json.siguiente).toEqual({ fecha: "2026-05-10 11:00:00", id: "pago-2" });

			const segunda = await pedir("POST", "/v1/cuentas/entradas", {
				...MAYO,
				page_size: 1,
				cursor_fecha: primera.json.siguiente.fecha,
				cursor_id: primera.json.siguiente.id,
			});
			expect(segunda.json.filas.map((f: any) => f.id)).toEqual(["pago-1"]);
			expect(segunda.json.siguiente).toBeNull();
		});
	});

	it("las salidas y el resumen, igual", async () => {
		await conNegocio("aud27-salidas-resumen", async () => {
			const salidas = await pedir("POST", "/v1/cuentas/salidas", { ...MAYO, q: "luz" });
			expect(salidas.status).toBe(200);
			expect(salidas.json.filas.map((f: any) => f.id)).toEqual(["gasto-2"]);

			const todo = await pedir("POST", "/v1/cuentas/resumen", MAYO);
			expect(todo.json).toMatchObject({ total_entradas: 3000, count_entradas: 2, total_salidas: 24055 });

			const delCliente = await pedir("POST", "/v1/cuentas/resumen", { ...MAYO, q: "cliente ficticio" });
			expect(delCliente.json).toMatchObject({ total_entradas: 1000, count_entradas: 1, total_efectivo: 1000 });
		});
	});

	it("los tres GET de antes ya no existen", async () => {
		await conNegocio("aud27-cuentas-get", async () => {
			for (const ruta of ["entradas", "salidas", "resumen"]) {
				const r = await pedir("GET", `/v1/cuentas/${ruta}?del=2026-05-01&al=2026-05-31&q=Cliente+Ficticio`);
				expect(r.status, ruta).toBe(404);
			}
			expect(horas).toEqual([]);
		});
	});

	it("un cuerpo que no vale es un 400, no un 500", async () => {
		await conNegocio("aud27-cuentas-400", async () => {
			const r = await pedir("POST", "/v1/cuentas/entradas", { ...MAYO, q: 7 });
			expect(r.status).toBe(400);
			expect(r.json.error).toBe("validation_error");
		});
	});
});

describe("AUD-27 · lo que se escribe en el buscador de la carta va en el cuerpo", () => {
	it("en las mesas y en la barra", async () => {
		await conNegocio("aud27-productos", async () => {
			const mesas = await pedir("POST", "/v1/mesas/productos/search", { query: "CRO" });
			expect(mesas.status).toBe(200);
			expect(mesas.json.map((p: any) => p.ID_Producto)).toEqual(["prod-croquetas"]);

			const barra = await pedir("POST", "/v1/venta-rapida/productos/search", { query: "c", limit: 1 });
			expect(barra.status).toBe(200);
			expect(barra.json).toHaveLength(1);

			const todos = await pedir("POST", "/v1/venta-rapida/productos/search", { query: "c" });
			expect(todos.json.map((p: any) => p.ID_Producto).sort()).toEqual(["prod-cerveza", "prod-croquetas"]);
		});
	});

	it("el GET de antes ya no busca: lo atiende la lista de una categoría, que no existe", async () => {
		await conNegocio("aud27-productos-get", async () => {
			for (const ruta of ["/v1/mesas/productos/search?query=cro", "/v1/venta-rapida/productos/search?query=cro"]) {
				expect((await pedir("GET", ruta)).json, ruta).toEqual([]);
			}
		});
	});
});

describe("AUD-27 · el resumen de tickets ya iba por POST, y es una lectura como las demás", () => {
	it("resume las líneas de cada ticket pedido, con los nombres unidos como en la Main", async () => {
		await conNegocio("aud27-index-rows", async () => {
			const r = await pedir("POST", "/v1/venta-rapida/index-rows", { ids: ["com-2", "com-1", "no-existe"] });
			expect(r.status).toBe(200);
			expect(r.json).toEqual([
				{ ID_Comanda: "com-1", Productos: "Cerveza · Croquetas", NumLineas: 2, Unidades: 3 },
			]);
		});
	});

	it("su tope es el suyo: le cabe un cuerpo que una búsqueda no admite", async () => {
		await conNegocio("aud27-index-rows-holgura", async () => {
			// Los 200 tickets que la app pide como mucho rozan los 8 KB. (El SQLite del DO de la
			// prueba no admite más de 100 parámetros, así que el tamaño se pone con relleno.)
			const cuerpo = { ids: ["com-1"], relleno: "x".repeat(20 * KB) };
			const r = await pedir("POST", "/v1/venta-rapida/index-rows", cuerpo);
			expect(r.status).toBe(200);
			expect(r.json.map((f: any) => f.ID_Comanda)).toEqual(["com-1"]);

			const busqueda = await pedir("POST", "/v1/venta-rapida/productos/search", { query: "cro", relleno: cuerpo.relleno });
			expect(busqueda.status).toBe(413);
		});
	});
});

describe("AUD-27 · por POST, pero lecturas", () => {
	it("una Handy las hace sin clave de idempotencia, sin aplicar nada por el TenantHub y con su hora", async () => {
		await conNegocio("aud27-son-lecturas", async () => {
			for (const { ruta, cuerpo } of LECTURAS) {
				const r = await pedir("POST", ruta, cuerpo);
				expect(r.status, ruta).toBe(200);
			}
			expect(autenticadas).toEqual(LECTURAS.map((l) => `POST ${l.ruta}`));
			// Ninguna ha pedido el DO: no se aplica ni se replica nada.
			expect(vecesEnElHub).toBe(0);
			// Y todas han llegado a `tenantQuery` con la cabecera de la que sale «hoy» (REV-03).
			expect(horas).toEqual(LECTURAS.map(() => AHORA));
		});
	});

	it("un cuerpo que pasa de su tope se rechaza antes de autenticar, que es cuando se lee", async () => {
		await conNegocio("aud27-tope", async () => {
			for (const { ruta, cuerpo, tope } of LECTURAS) {
				const r = await pedir("POST", ruta, { ...cuerpo, relleno: "x".repeat(tope + KB) });
				expect(r.status, ruta).toBe(413);
				expect(r.json, ruta).toMatchObject({ ok: false, error: "payload_too_large" });
			}
			expect(autenticadas).toEqual([]);
			expect(horas).toEqual([]);
		});
	});

	it("un cuerpo largo, pero de los que caben en una búsqueda, pasa", async () => {
		await conNegocio("aud27-tope-holgado", async () => {
			const r = await pedir("POST", "/v1/reservas/buscar-cliente", {
				email: `${"ñ".repeat(2000)}@ejemplo.invalid`,
			});
			expect(r).toMatchObject({ status: 200, json: null });
			expect(autenticadas).toEqual(["POST /v1/reservas/buscar-cliente"]);
		});
	});

	it("sin `Content-Type` de JSON no se lee el cuerpo: 400, como en cualquier ruta", async () => {
		await conNegocio("aud27-sin-json", async () => {
			const res = await app.request(
				"/v1/reservas/buscar-cliente",
				{ method: "POST", headers: { "X-Client-Now": AHORA }, body: JSON.stringify({ telefono: "600000000" }) },
				env as any,
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).error).toBe("validation_error");
		});
	});

	it("lo que ahora va en el cuerpo no sale hacia Sentry", () => {
		// `cuerpo()` registra el cuerpo validado para Sentry, pero sólo los campos de la lista
		// positiva de cada operación (`requestContext.ts`): de estas lecturas, ninguno.
		for (const { ruta, cuerpo } of LECTURAS) {
			expect(seleccionarCuerpo(`POST ${ruta}`, { ...cuerpo, email: "prueba@ejemplo.invalid" }), ruta).toEqual({});
		}
	});
});
