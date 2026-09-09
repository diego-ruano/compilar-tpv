// test/syncVentana.test.ts
//
// SYNC-19 · La FASE 1 acotada: qué se lleva el volcado con el que un equipo vuelve a vender.
//
// El contrato que se fija aquí no es de formato (eso lo cubre `syncBootstrap.test.ts`), es de
// ALCANCE, y sus fallos no se ven: una tabla que se queda fuera no da error, da un bar que abre
// sin sus reservas; una hija sin su padre no da un aviso, aborta la restauración entera con un
// error de FK que nadie va a saber leer a las nueve de la mañana.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { DDL_TABLAS_DE_NUBE } from "../src/durableObjects/tenantHub.sentencias";
import {
	TRANSACCIONALES,
	esTablaDeNegocio,
	esTransaccional,
	VENTANA_DIAS,
} from "../src/domains/sync/bootstrap.ventana";

let clienteActual: any = null;
let esTpv = true;

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: async (_env: any, _tenantId: string, fn: any) => fn(clienteActual),
}));

vi.mock("../src/lib/deviceAuth", async (original) => ({
	...(await (original as any)()),
	isTpvDevice: async () => esTpv,
}));

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "d1");
		await next();
	},
}));

const { syncRoutes } = await import("../src/domains/sync/sync.routes");

/** Literal `YYYY-MM-DD HH:MM:SS` de hace `n` días, en el mismo huso que usa `parseClientNow`. */
// El instante de referencia se congela al cargar el fichero, y no se lee el reloj en cada llamada.
// Con `Date.now()` dentro, la misma expresión daba dos valores distintos al caer entre dos segundos:
// el test que compara `ventana_desde` con `haceDias(...)` fallaba por un segundo, al azar, una vez
// cada muchas ejecuciones. Un test que falla por el reloj enseña a reejecutar la tanda.
const INSTANTE = Date.now();

function haceDias(n: number): string {
	return new Date(INSTANTE - n * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}
const AHORA = haceDias(0);
/** Bien dentro de la ventana. */
const RECIENTE = haceDias(2);
/** Bien fuera: sólo entra si algo lo rescata (vivo, o el periodo de caja abierto). */
const ANTIGUO = haceDias(VENTANA_DIAS + 40);

type Volcado = {
	ok: boolean;
	seq: number;
	totalFilas: number;
	ventana_desde: string;
	backfill: string[];
	tablas: Array<{ nombre: string; columnas: string[]; filas: any[][]; parcial: boolean }>;
};

async function pedir(
	ruta: string,
	nombre: string,
	sembrar: (sql: any) => void,
	init: RequestInit = { method: "POST" },
): Promise<{ status: number; body: any }> {
	return enElHub(`ventana-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const ddl of DDL_TABLAS_DE_NUBE) sql.exec(ddl);
		sembrar(sql);

		clienteActual = clienteSobre(sql);
		const app = new Hono();
		app.route("/", syncRoutes);
		const res = await app.request(
			ruta,
			{ ...init, headers: { "x-client-now": AHORA, ...(init.headers ?? {}) } },
			{} as any,
		);
		return { status: res.status, body: await res.json() };
	});
}

function tabla(body: Volcado, nombre: string) {
	return body.tablas.find((t) => t.nombre === nombre);
}
function ids(body: Volcado, nombre: string, columna: string): string[] {
	const t = tabla(body, nombre)!;
	const i = t.columnas.indexOf(columna);
	return t.filas.map((f) => String(f[i]));
}

/** Una comanda de barra ya pagada, con su línea y su cobro. Devuelve los ids usados. */
function sembrarVenta(
	sql: any,
	sufijo: string,
	fechaComanda: string,
	fechaPago = fechaComanda,
	estado = "Pagada",
) {
	sql.exec(
		`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
		 VALUES ('c-${sufijo}', 'BARRA', ?, ?, ?);`,
		fechaComanda,
		estado === "Pagada" ? fechaPago : null,
		estado,
	);
	sql.exec(
		`INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario)
		 VALUES ('d-${sufijo}', 'c-${sufijo}', 'Caña', 1, 2.5);`,
	);
	if (estado === "Pagada") {
		sql.exec(
			`INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
			 VALUES ('p-${sufijo}', 'c-${sufijo}', ?, 'efectivo', 2.5, 'TOTAL');`,
			fechaPago,
		);
		sql.exec(
			`INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('p-${sufijo}', 'd-${sufijo}');`,
		);
	}
}

beforeEach(() => {
	esTpv = true;
	clienteActual = null;
});

describe("bootstrap acotado · los maestros", () => {
	it("van enteros, por viejos que sean", async () => {
		// Son los que dejan al bar operativo y crecen con el catálogo, no con las ventas: sin
		// `Productos` no se cobra y sin `Usuarios` no se entra. Recortarlos ahorra poco y rompe todo.
		const { body } = await pedir("/bootstrap", "maestros", (sql) => {
			sql.exec(
				"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat1','Bebidas');",
			);
			sql.exec(
				"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('pr1','cat1','Caña',2.5);",
			);
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','Terraza');");
			sql.exec(
				"INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('cl1','Cliente de hace años');",
			);
		});

		for (const t of ["Productos", "Zonas", "Clientes", "Categorias_Producto"]) {
			expect(tabla(body, t)!.filas.length, t).toBe(1);
			expect(tabla(body, t)!.parcial, t).toBe(false);
		}
	});

	it("`Serie_Facturacion` viaja SIEMPRE", async () => {
		// FISCAL-01: es el contador de la serie de facturación, y si volviera recortado el
		// siguiente número podría repetir uno YA EMITIDO. La clave única de una factura ante la
		// AEAT es (emisor, número, fecha), así que un duplicado no es un ticket confuso: es un
		// registro que no entra (error 3000). Un hueco es explicable; un número repetido no.
		const { body } = await pedir("/bootstrap", "contador", (sql) => {
			sql.exec("INSERT INTO Serie_Facturacion (Serie, Ultimo) VALUES ('2027', 4321);");
		});

		const t = tabla(body, "Serie_Facturacion")!;
		expect(t.filas).toHaveLength(1);
		expect(t.filas[0][t.columnas.indexOf("Ultimo")]).toBe(4321);
	});

	it("`Reservas` entra entera, incluidas las futuras", async () => {
		// Una reserva de la semana que viene importa más que un ticket del año pasado.
		const { body } = await pedir("/bootstrap", "reservas", (sql) => {
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Comensales)
				 VALUES ('r-vieja', date(?), '21:00', 'CENA', 4);`,
				ANTIGUO,
			);
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Comensales)
				 VALUES ('r-futura', date(?), '21:00', 'CENA', 2);`,
				haceDias(-7),
			);
		});

		expect(ids(body, "Reservas", "ID_Reserva").sort()).toEqual(["r-futura", "r-vieja"]);
	});

	it("`Intentos_Login` no se restaura", async () => {
		// Es estado anti-fuerza-bruta, no dato de negocio: restaurarlo sólo heredaría los bloqueos
		// de un equipo que ya no existe.
		const { body } = await pedir("/bootstrap", "intentos", () => {});
		expect(body.tablas.map((t: any) => t.nombre)).not.toContain("Intentos_Login");
	});
});

describe("bootstrap acotado · la ventana de los transaccionales", () => {
	it("deja fuera lo viejo y trae lo reciente", async () => {
		const { body } = await pedir("/bootstrap", "ventana", (sql) => {
			sembrarVenta(sql, "vieja", ANTIGUO);
			sembrarVenta(sql, "nueva", RECIENTE);
		});

		expect(ids(body, "Comandas", "ID_Comanda")).toEqual(["c-nueva"]);
		expect(ids(body, "Pagos", "ID_Pago")).toEqual(["p-nueva"]);
		expect(tabla(body, "Comandas")!.parcial).toBe(true);
	});

	it("una comanda entra CON TODO lo suyo, o no entra", async () => {
		// Filtrar cada tabla por su propia fecha era lo intuitivo y rompe la restauración entera:
		// el pago quedaría dentro de la ventana y su comanda fuera, y `Pagos.ID_Comanda` es una FK
		// que se comprueba al COMMIT. Aborta la transacción, no la fila.
		const { body } = await pedir("/bootstrap", "unidad", (sql) => {
			// Comanda de hace dos meses cobrada anteayer: la mesa olvidada.
			sembrarVenta(sql, "tardia", ANTIGUO, RECIENTE);
		});

		expect(ids(body, "Comandas", "ID_Comanda")).toEqual(["c-tardia"]);
		expect(ids(body, "Detalle_Comanda", "ID_Detalle")).toEqual(["d-tardia"]);
		expect(ids(body, "Pagos", "ID_Pago")).toEqual(["p-tardia"]);
		expect(ids(body, "Pago_Detalles", "ID_Pago")).toEqual(["p-tardia"]);
	});

	it("ninguna hija sale huérfana de su padre", async () => {
		// La comprobación general: para cada hija del volcado, su padre tiene que venir también.
		const { body } = await pedir("/bootstrap", "huerfanas", (sql) => {
			sembrarVenta(sql, "a", RECIENTE);
			sembrarVenta(sql, "b", ANTIGUO);
			sembrarVenta(sql, "c", ANTIGUO, RECIENTE);
		});

		const comandas = new Set(ids(body, "Comandas", "ID_Comanda"));
		const detalles = new Set(ids(body, "Detalle_Comanda", "ID_Detalle"));
		const pagos = new Set(ids(body, "Pagos", "ID_Pago"));

		for (const c of ids(body, "Detalle_Comanda", "ID_Comanda")) expect(comandas).toContain(c);
		for (const c of ids(body, "Pagos", "ID_Comanda")) expect(comandas).toContain(c);
		for (const p of ids(body, "Pago_Detalles", "ID_Pago")) expect(pagos).toContain(p);
		for (const d of ids(body, "Pago_Detalles", "ID_Detalle")) expect(detalles).toContain(d);
	});

	it("un movimiento de caja no viaja sin el pago al que apunta", async () => {
		// CUENTA-07. `Movimientos_Caja.ID_Pago` es una FK: una fila cuya fecha cae dentro de la
		// ventana pero cuyo pago se quedó fuera abortaría la restauración.
		const { body } = await pedir("/bootstrap", "movcaja", (sql) => {
			sembrarVenta(sql, "vieja", ANTIGUO);
			sql.exec(
				`INSERT INTO Movimientos_Caja (ID_Movimiento, Fecha_Hora, Tipo, ID_Pago, Importe, Metodo_Pago)
				 VALUES ('m1', ?, 'COBRO', 'p-vieja', 2.5, 'efectivo');`,
				RECIENTE,
			);
			sql.exec(
				`INSERT INTO Movimientos_Caja (ID_Movimiento, Fecha_Hora, Tipo, Importe)
				 VALUES ('m2', ?, 'GASTO', 10);`,
				RECIENTE,
			);
		});

		// El gasto sí (no apunta a ningún pago); el cobro huérfano no.
		expect(ids(body, "Movimientos_Caja", "ID_Movimiento")).toEqual(["m2"]);
	});
});

describe("bootstrap acotado · lo que sigue vivo entra entero", () => {
	it("una comanda abierta hace meses viaja igual", async () => {
		// Una mesa que nadie cerró es trabajo pendiente, no histórico: si no viene, el camarero
		// abre otra encima y la primera se queda flotando en la nube para siempre.
		const { body } = await pedir("/bootstrap", "abierta", (sql) => {
			sembrarVenta(sql, "olvidada", ANTIGUO, ANTIGUO, "Abierta");
		});

		expect(ids(body, "Comandas", "ID_Comanda")).toEqual(["c-olvidada"]);
		expect(ids(body, "Detalle_Comanda", "ID_Detalle")).toEqual(["d-olvidada"]);
	});

	it("una notificación activa antigua viaja, y con ella sus recibos de lectura", async () => {
		// El índice `UNIQUE` de dedupe sólo cuenta las activas: si la Main no la ve, vuelve a
		// emitirla, y el duplicado choca contra ese índice al replicar → cuarentena.
		const { body } = await pedir("/bootstrap", "notifs", (sql) => {
			sql.exec(
				`INSERT INTO Notificaciones (ID_Notificacion, Tipo, Titulo, Destino_Tipo, Clave_Dedupe, Estado, Creada_En)
				 VALUES ('n-activa', 'stock_bajo', 'Queda poco', 'todos', 'stock_bajo:pr1', 'activa', ?);`,
				ANTIGUO,
			);
			sql.exec(
				`INSERT INTO Notificaciones (ID_Notificacion, Tipo, Titulo, Destino_Tipo, Estado, Creada_En)
				 VALUES ('n-resuelta', 'stock_bajo', 'Ya repuesto', 'todos', 'resuelta', ?);`,
				ANTIGUO,
			);
			sql.exec(
				`INSERT INTO Notificacion_Lecturas (ID_Notificacion, ID_Usuario, Leida_En)
				 VALUES ('n-activa', 'u1', ?);`,
				ANTIGUO,
			);
		});

		expect(ids(body, "Notificaciones", "ID_Notificacion")).toEqual(["n-activa"]);
		expect(ids(body, "Notificacion_Lecturas", "ID_Notificacion")).toEqual(["n-activa"]);
	});

	it("un pedido a proveedor en borrador viaja con sus líneas", async () => {
		const { body } = await pedir("/bootstrap", "pedidos", (sql) => {
			sql.exec(
				`INSERT INTO Pedidos_Proveedor (ID_Pedido, Estado, Fecha_Creacion) VALUES ('pe-b','borrador',?);`,
				ANTIGUO,
			);
			sql.exec(
				`INSERT INTO Pedidos_Proveedor (ID_Pedido, Estado, Fecha_Creacion) VALUES ('pe-e','enviado',?);`,
				ANTIGUO,
			);
			sql.exec(
				`INSERT INTO Lineas_Pedido_Proveedor (ID_Linea, ID_Pedido, Nombre_Producto) VALUES ('l1','pe-b','Cerveza');`,
			);
			sql.exec(
				`INSERT INTO Lineas_Pedido_Proveedor (ID_Linea, ID_Pedido, Nombre_Producto) VALUES ('l2','pe-e','Vino');`,
			);
		});

		expect(ids(body, "Pedidos_Proveedor", "ID_Pedido")).toEqual(["pe-b"]);
		expect(ids(body, "Lineas_Pedido_Proveedor", "ID_Linea")).toEqual(["l1"]);
	});

	it("un fichaje sin cerrar viaja aunque lleve meses abierto", async () => {
		const { body } = await pedir("/bootstrap", "fichajes", (sql) => {
			sql.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
				 VALUES ('u1', (SELECT ID_Rol FROM Roles LIMIT 1), 'a@b.c', 'x', 'Ana');`,
			);
			sql.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Estado) VALUES ('f-ab','u1',date(?),1,'ABIERTO');`,
				ANTIGUO,
			);
			sql.exec(
				`INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Estado) VALUES ('f-ce','u1',date(?),2,'CERRADO');`,
				ANTIGUO,
			);
		});

		expect(ids(body, "Fichajes", "ID_Fichaje")).toEqual(["f-ab"]);
	});
});

describe("bootstrap acotado · el periodo de caja", () => {
	it("el último cierre no reabierto viaja aunque quede fuera de la ventana", async () => {
		// Es lo que define el periodo abierto y el gate que impide escribir sobre uno cerrado.
		const { body } = await pedir("/bootstrap", "cierre-viejo", (sql) => {
			sql.exec(
				`INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Dejado) VALUES ('ci-1', ?, 150);`,
				ANTIGUO,
			);
			sql.exec(
				`INSERT INTO Cierre_Denominaciones (ID_Cierre, Momento, Valor, Unidades)
				 VALUES ('ci-1','DEJADO',50,3);`,
			);
		});

		expect(ids(body, "Cierres_Caja", "ID_Cierre")).toEqual(["ci-1"]);
		expect(ids(body, "Cierre_Denominaciones", "ID_Cierre")).toEqual(["ci-1"]);
	});

	it("con un periodo abierto de más de 30 días, la ventana se estira hasta cubrirlo", async () => {
		// El agujero que esto tapa: el arqueo suma los cobros en efectivo DESDE el último cierre.
		// Con la ventana fija, un bar que lleva 40 días sin cerrar caja perdería diez días de
		// cobros y su primer arqueo tras recuperar saldría descuadrado por un dinero que sí está
		// en el cajón.
		const { body } = await pedir("/bootstrap", "periodo-largo", (sql) => {
			sql.exec(
				`INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Dejado) VALUES ('ci-1', ?, 150);`,
				haceDias(VENTANA_DIAS + 10),
			);
			// Cobro anterior a la ventana fija, pero DENTRO del periodo de caja abierto.
			sembrarVenta(sql, "en-periodo", haceDias(VENTANA_DIAS + 5));
			// Y uno anterior al propio cierre: ese sí es histórico.
			sembrarVenta(sql, "antes-cierre", haceDias(VENTANA_DIAS + 20));
		});

		expect(body.ventana_desde).toBe(haceDias(VENTANA_DIAS + 10));
		expect(ids(body, "Pagos", "ID_Pago")).toEqual(["p-en-periodo"]);
	});

	it("un cierre reciente NO encoge la ventana", async () => {
		// `desde` es el MÍNIMO de las dos fechas: el periodo de caja sólo puede estirar la ventana,
		// nunca recortarla. Un bar que cierra caja cada noche seguiría teniendo sus 30 días.
		const { body } = await pedir("/bootstrap", "cierre-de-anoche", (sql) => {
			sql.exec(
				`INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Dejado) VALUES ('ci-1', ?, 150);`,
				haceDias(1),
			);
			sembrarVenta(sql, "hace-diez", haceDias(10));
		});

		expect(ids(body, "Pagos", "ID_Pago")).toEqual(["p-hace-diez"]);
	});
});

describe("bootstrap acotado · lo que la Main necesita para seguir", () => {
	it("marca `parcial` sólo en lo recortado y da el orden de backfill, padres primero", async () => {
		const { body } = await pedir("/bootstrap", "parcial", () => {});

		const parciales = body.tablas.filter((t: any) => t.parcial).map((t: any) => t.nombre);
		expect(parciales.sort()).toEqual(TRANSACCIONALES.map((t) => t.nombre).sort());
		expect(body.backfill).toEqual(TRANSACCIONALES.map((t) => t.nombre));

		// El orden es lo único que hace viable la fase 2: cada página es su propia transacción, así
		// que `defer_foreign_keys` no cubre a una hija insertada antes que su padre.
		const pos = (n: string) => body.backfill.indexOf(n);
		expect(pos("Comandas")).toBeLessThan(pos("Detalle_Comanda"));
		expect(pos("Detalle_Comanda")).toBeLessThan(pos("Pago_Detalles"));
		expect(pos("Pagos")).toBeLessThan(pos("Pago_Detalles"));
		expect(pos("Pagos")).toBeLessThan(pos("Movimientos_Caja"));
		expect(pos("Cierres_Caja")).toBeLessThan(pos("Cierre_Denominaciones"));
		expect(pos("Pedidos_Proveedor")).toBeLessThan(pos("Lineas_Pedido_Proveedor"));
		expect(pos("Notificaciones")).toBeLessThan(pos("Notificacion_Lecturas"));
	});

	it("toda tabla del esquema está clasificada", async () => {
		// El guardián. Una tabla nueva que nadie clasifique se trata como maestra y viaja entera —
		// fallar trayendo de más es recuperable, fallar perdiéndola en silencio se descubre el día
		// de la avería—, pero eso es la red, no el plan. Esto obliga a decidirlo a conciencia.
		//
		// Si este test falla: añade la tabla a `TRANSACCIONALES` (con su predicado de ventana y en
		// su sitio del orden padres-primero) o a la lista de abajo si de verdad es maestra.
		const MAESTRAS = [
			"Alergenos",
			"Asignacion_Turnos",
			"Business_Settings",
			"Categorias_Producto",
			"Clientes",
			"Contact_Settings",
			"Horario_Predeterminado",
			"Lotes_Producto",
			"Mesas",
			"Producto_Alergenos",
			"Productos",
			"Proveedores",
			"Reservas",
			"Roles",
			// FISCAL-01: el contador de la serie de facturación. Maestra a propósito, y son cuatro
			// filas: si volviera recortado, el número siguiente podría repetir uno ya emitido y la
			// AEAT lo rechazaría por duplicado (error 3000). Se falla hacia el hueco, nunca hacia
			// el número repetido.
			"Serie_Facturacion",
			"Tarea_Asignaciones",
			"Tareas",
			"Ticket_Settings",
			"Trabajadores",
			"Turnos",
			"Usuarios",
			"Zonas",
		];

		const { body } = await pedir("/bootstrap", "clasificadas", () => {});
		const delVolcado = body.tablas.map((t: any) => t.nombre).sort();
		const clasificadas = [...MAESTRAS, ...TRANSACCIONALES.map((t) => t.nombre)].sort();

		expect(delVolcado).toEqual(clasificadas);
		expect(MAESTRAS.some(esTransaccional)).toBe(false);
		expect(esTablaDeNegocio("Intentos_Login")).toBe(false);
	});
});
