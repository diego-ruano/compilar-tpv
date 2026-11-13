// test/syncVentanaQueCabe.test.ts
//
// La ventana de la fase 1 se encoge hasta caber (`bootstrap.ventana.ts`, `sync.routes.ts`).
//
// La fase 1 es una sola respuesta con dos topes, filas y bytes. El mes de un bar con mucho
// movimiento no cabe, y antes eso era un 413: ese bar no podía recuperarse desde la nube. Ahora
// viaja la ventana más ancha que cabe —30 días, 7, 1 o sólo lo imprescindible— y lo demás lo trae la
// fase 2, que ya recorría cada tabla entera.
//
// Lo que se fija aquí:
//   · con menos sitio, la ventana es más estrecha, y es la más ancha que cabe;
//   · lo imprescindible viaja SIEMPRE: los maestros, lo que sigue vivo, lo que hay desde el último
//     cierre de caja y el último registro de facturación. Si ni eso cabe, entonces sí es un 413;
//   · `parcial` y `backfill` no dependen del ancho: la Main rellena lo mismo;
//   · la medida previa es una estimación, y quien manda es lo que se escribe;
//   · el contraste diario (`/verificar`) usa la misma ventana.

import { describe, expect, it } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import {
	ANCHOS_DE_VENTANA,
	TRANSACCIONALES,
	VENTANA_DIAS,
	esTransaccional,
	ventanasCandidatas,
} from "../src/domains/sync/bootstrap.ventana";
import { fotoDeVerificacion, volcarFase1, type Topes } from "../src/domains/sync/sync.routes";
import { lectorDelCliente, lectorDelHub, type Lector } from "../src/domains/sync/volcado";

// El instante de referencia se congela al cargar el fichero: con el reloj leído en cada llamada, la
// misma expresión da dos valores al caer entre dos segundos.
const INSTANTE = Date.now();
function haceDias(n: number): string {
	return new Date(INSTANTE - n * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}
const AHORA = haceDias(0);
const CIERRE = haceDias(3);
const SIN_TOPE: Topes = { filas: 1_000_000, bytes: 1024 * 1024 * 1024 };

type Volcado = {
	ok: boolean;
	seq: number;
	total_filas: number;
	ventana_desde: string;
	backfill: string[];
	tablas: Array<{ nombre: string; columnas: string[]; filas: any[][]; parcial: boolean }>;
};

function tabla(v: { tablas: Volcado["tablas"] }, nombre: string) {
	return v.tablas.find((t) => t.nombre === nombre)!;
}
function valores(v: { tablas: Volcado["tablas"] }, nombre: string, columna: string): string[] {
	const t = tabla(v, nombre);
	const i = t.columnas.indexOf(columna);
	return t.filas.map((f) => String(f[i])).sort();
}

/** Una comanda de barra cobrada: con su línea, su pago y el detalle del pago. */
function venta(sql: any, id: string, fecha: string): void {
	sql.exec(
		`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Estado)
		 VALUES (?, 'BARRA', ?, ?, 'Pagada');`,
		`c-${id}`,
		fecha,
		fecha,
	);
	sql.exec(
		`INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario)
		 VALUES (?, ?, 'Caña', 1, 250);`,
		`d-${id}`,
		`c-${id}`,
	);
	sql.exec(
		`INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
		 VALUES (?, ?, ?, 'Efectivo', 250, 'TOTAL');`,
		`p-${id}`,
		`c-${id}`,
		fecha,
	);
	sql.exec("INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES (?, ?);", `p-${id}`, `d-${id}`);
}

const VIEJAS = 150; // hace 20 días: sólo caben en la ventana de 30
const DE_LA_SEMANA = 150; // hace 5 días: caben en la de 30 y en la de 7
const DESDE_EL_CIERRE = 10; // hace 2 días, después del último cierre: entran siempre
const DE_HOY = 5;

/**
 * Un bar con su catálogo, un cierre de caja de hace tres días, ventas a un lado y a otro de cada
 * ancho de ventana, y de todo lo que sigue vivo, una cosa de hace dos meses.
 */
function sembrarBar(sql: any): void {
	const ANTIGUO = haceDias(60);

	// Maestros.
	sql.exec("INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat1', 'Bebidas');");
	sql.exec(
		"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('pr1', 'cat1', 'Caña', 250);",
	);
	for (let i = 0; i < 5; i++) {
		sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES (?, ?);", `cl-${i}`, `Cliente ${i}`);
	}
	sql.exec(
		`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
		 VALUES ('u1', (SELECT ID_Rol FROM Roles LIMIT 1), 'ana@bar.test', 'x', 'Ana');`,
	);

	// El último cierre no reabierto, con su recuento, y uno anterior.
	sql.exec("INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Dejado) VALUES ('ci-anterior', ?, 100);", haceDias(4));
	sql.exec(
		"INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Dejado, Periodo_Desde) VALUES ('ci-ultimo', ?, 150, ?);",
		CIERRE,
		haceDias(4),
	);
	sql.exec(
		"INSERT INTO Cierre_Denominaciones (ID_Cierre, Momento, Valor, Unidades) VALUES ('ci-ultimo', 'DEJADO', 50, 3);",
	);

	// Ventas.
	for (let i = 0; i < VIEJAS; i++) venta(sql, `vieja-${i}`, haceDias(20));
	for (let i = 0; i < DE_LA_SEMANA; i++) venta(sql, `semana-${i}`, haceDias(5));
	for (let i = 0; i < DESDE_EL_CIERRE; i++) venta(sql, `periodo-${i}`, haceDias(2));
	for (let i = 0; i < DE_HOY; i++) venta(sql, `hoy-${i}`, haceDias(0.5));
	// Una de hace veinte días devuelta ayer, después del último cierre: el dinero salió del cajón en
	// el periodo abierto.
	venta(sql, "devuelta", haceDias(20));
	sql.exec(
		`UPDATE Pagos SET Estado = 'ANULADO', Motivo_Baja = 'DEVOLUCION', Anulado_En = ?, Anulado_Por = 'u1'
		  WHERE ID_Pago = 'p-devuelta';`,
		haceDias(1),
	);

	// Lo que sigue vivo, todo de hace dos meses.
	sql.exec(
		`INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('c-abierta', 'BARRA', ?, 'Abierta');`,
		ANTIGUO,
	);
	sql.exec(
		`INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Nombre_Producto, Cantidad, Precio_Unitario)
		 VALUES ('d-abierta', 'c-abierta', 'Caña', 1, 250);`,
	);
	sql.exec(
		`INSERT INTO Notificaciones (ID_Notificacion, Tipo, Titulo, Destino_Tipo, Clave_Dedupe, Estado, Creada_En)
		 VALUES ('n-activa', 'stock_bajo', 'Queda poco', 'todos', 'stock_bajo:pr1', 'activa', ?);`,
		ANTIGUO,
	);
	sql.exec(
		"INSERT INTO Notificacion_Lecturas (ID_Notificacion, ID_Usuario, Leida_En) VALUES ('n-activa', 'u1', ?);",
		ANTIGUO,
	);
	sql.exec(
		"INSERT INTO Pedidos_Proveedor (ID_Pedido, Estado, Fecha_Creacion) VALUES ('pe-borrador', 'borrador', ?);",
		ANTIGUO,
	);
	sql.exec(
		"INSERT INTO Lineas_Pedido_Proveedor (ID_Linea, ID_Pedido, Nombre_Producto) VALUES ('l-borrador', 'pe-borrador', 'Cerveza');",
	);
	sql.exec(
		"INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Estado) VALUES ('f-abierto', 'u1', date(?), 1, 'ABIERTO');",
		ANTIGUO,
	);

	// El último registro de facturación: el eslabón del que sigue la cadena.
	for (const [orden, id] of [[1, "rf-primero"], [2, "rf-ultimo"]] as const) {
		sql.exec(
			`INSERT INTO Registros_Facturacion
			   (ID_Registro, Orden, Tipo, NIF_Emisor, Num_Serie_Factura, Fecha_Expedicion, Serie, Numero,
			    Nombre_Razon_Emisor, Cadena_Huella, Huella, Fecha_Hora_Huso, Sistema_Json, QR_Url)
			 VALUES (?, ?, 'ALTA', 'B00000000', ?, '01-01-2026', 'A', ?, 'Bar de pruebas', 'cadena', 'huella',
			         ?, '{}', 'https://ejemplo.invalid/qr');`,
			id,
			orden,
			`A-${orden}`,
			orden,
			ANTIGUO.replace(" ", "T") + "+01:00",
		);
	}

	sql.exec("INSERT INTO Sync_Changes (Op_Id, Statements_Json, Created_At_Ms) VALUES ('op-1', '[]', 1);");
}

/** Los dos lectores de la misma base: el del TenantHub y el del Worker. */
function lectores(sql: any): Array<[string, Lector]> {
	return [
		["dentro del TenantHub", lectorDelHub(sql)],
		["en el Worker", lectorDelCliente(clienteSobre(sql))],
	];
}

async function fase1(lector: Lector, topes: Topes): Promise<{ volcado: Volcado; bytes: number } | { volcado: null; totalFilas: number }> {
	const r = await volcarFase1(lector, AHORA, topes);
	if (!r.cuerpo) return { volcado: null, totalFilas: r.totalFilas };
	return { volcado: JSON.parse(new TextDecoder().decode(r.cuerpo)), bytes: r.cuerpo.byteLength };
}

function filasDe(v: Volcado): number {
	return v.tablas.reduce((n, t) => n + t.filas.length, 0);
}

/** Lo que viaja con cualquier ancho de ventana. */
function comprobarLoImprescindible(v: Volcado, donde: string): void {
	// Maestros enteros.
	expect(tabla(v, "Clientes").filas, donde).toHaveLength(5);
	expect(valores(v, "Productos", "ID_Producto"), donde).toEqual(["pr1"]);
	expect(valores(v, "Usuarios", "ID_Usuario"), donde).toContain("u1");

	// Lo que sigue vivo, por viejo que sea, y con lo suyo.
	expect(valores(v, "Comandas", "ID_Comanda"), donde).toContain("c-abierta");
	expect(valores(v, "Detalle_Comanda", "ID_Detalle"), donde).toContain("d-abierta");
	expect(valores(v, "Notificaciones", "ID_Notificacion"), donde).toEqual(["n-activa"]);
	expect(valores(v, "Notificacion_Lecturas", "ID_Notificacion"), donde).toEqual(["n-activa"]);
	expect(valores(v, "Pedidos_Proveedor", "ID_Pedido"), donde).toEqual(["pe-borrador"]);
	expect(valores(v, "Lineas_Pedido_Proveedor", "ID_Linea"), donde).toEqual(["l-borrador"]);
	expect(valores(v, "Fichajes", "ID_Fichaje"), donde).toEqual(["f-abierto"]);

	// El último cierre no reabierto con su recuento, y todo lo cobrado desde él: de ahí sale el
	// arqueo siguiente.
	expect(valores(v, "Cierres_Caja", "ID_Cierre"), donde).toContain("ci-ultimo");
	expect(valores(v, "Cierre_Denominaciones", "ID_Cierre"), donde).toEqual(["ci-ultimo"]);
	const pagos = valores(v, "Pagos", "ID_Pago");
	for (let i = 0; i < DESDE_EL_CIERRE; i++) expect(pagos, donde).toContain(`p-periodo-${i}`);
	for (let i = 0; i < DE_HOY; i++) expect(pagos, donde).toContain(`p-hoy-${i}`);
	// Y lo devuelto desde el cierre, aunque la venta sea anterior: el arqueo lo resta (REV-08).
	expect(pagos, donde).toContain("p-devuelta");

	// El último registro de facturación.
	expect(valores(v, "Registros_Facturacion", "ID_Registro"), donde).toContain("rf-ultimo");

	// Y lo que la Main necesita para rellenar el resto, igual con cualquier ancho.
	const parciales = v.tablas.filter((t) => t.parcial).map((t) => t.nombre).sort();
	expect(parciales, donde).toEqual(TRANSACCIONALES.map((t) => t.nombre).sort());
	expect(v.tablas.filter((t) => !t.parcial).some((t) => esTransaccional(t.nombre)), donde).toBe(false);
	expect(v.backfill, donde).toEqual(TRANSACCIONALES.map((t) => t.nombre));
	expect(v.total_filas, donde).toBe(filasDe(v));
	expect(v.seq, donde).toBe(1);

	// Ninguna hija sin su padre: una FK colgante aborta la restauración entera.
	const comandas = new Set(valores(v, "Comandas", "ID_Comanda"));
	const detalles = new Set(valores(v, "Detalle_Comanda", "ID_Detalle"));
	const delVolcado = new Set(pagos);
	for (const c of valores(v, "Detalle_Comanda", "ID_Comanda")) expect(comandas, donde).toContain(c);
	for (const c of valores(v, "Pagos", "ID_Comanda")) expect(comandas, donde).toContain(c);
	for (const p of valores(v, "Pago_Detalles", "ID_Pago")) expect(delVolcado, donde).toContain(p);
	for (const d of valores(v, "Pago_Detalles", "ID_Detalle")) expect(detalles, donde).toContain(d);
}

const ventasCon = (v: Volcado, prefijo: string) =>
	valores(v, "Comandas", "ID_Comanda").filter((id) => id.startsWith(`c-${prefijo}-`)).length;

describe("las ventanas que se prueban", () => {
	const dias = (n: number) => haceDias(n);

	it("del mes a lo imprescindible, y la primera es la de siempre", () => {
		expect(ANCHOS_DE_VENTANA[0]).toBe(VENTANA_DIAS);
		expect(ANCHOS_DE_VENTANA[ANCHOS_DE_VENTANA.length - 1]).toBe(0);
		expect([...ANCHOS_DE_VENTANA]).toEqual([...ANCHOS_DE_VENTANA].sort((a, b) => b - a));
	});

	it("sin ningún cierre de caja: 30 días, 7, 1 y ahora", () => {
		expect(ventanasCandidatas(AHORA, null)).toEqual([dias(30), dias(7), dias(1), AHORA]);
	});

	it("la más estrecha llega hasta el último cierre no reabierto", () => {
		// Un cierre de hace tres días: la de un día y la de ninguno se estiran hasta él y son la misma.
		expect(ventanasCandidatas(AHORA, dias(3))).toEqual([dias(30), dias(7), dias(3)]);
		// Uno de hace doce horas: sólo la de ninguno se estira.
		expect(ventanasCandidatas(AHORA, dias(0.5))).toEqual([dias(30), dias(7), dias(1), dias(0.5)]);
	});

	it("con un cierre de hace más de 30 días sólo hay una: todo lo que hay desde él entra siempre", () => {
		expect(ventanasCandidatas(AHORA, dias(40))).toEqual([dias(40)]);
	});
});

describe("la fase 1 se encoge hasta caber", () => {
	it("viaja la ventana más ancha que cabe, y lo imprescindible viaja con todas", async () => {
		await enElHub("ventana-que-cabe-escalera", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrarBar(sql);

			for (const [camino, lector] of lectores(sql)) {
				// Sin topes que estorben: el mes entero.
				const mes = await fase1(lector, SIN_TOPE);
				if (!mes.volcado) throw new Error("el mes no cabe sin topes");
				expect(mes.volcado.ventana_desde, camino).toBe(haceDias(30));
				expect(ventasCon(mes.volcado, "vieja"), camino).toBe(VIEJAS);
				expect(ventasCon(mes.volcado, "semana"), camino).toBe(DE_LA_SEMANA);
				comprobarLoImprescindible(mes.volcado, `${camino}, 30 días`);

				// Con una fila menos de sitio que el mes: la semana. El tope de filas es exacto (se
				// cuenta antes de leer), así que sirve para medir cada escalón.
				const semana = await fase1(lector, { ...SIN_TOPE, filas: filasDe(mes.volcado) - 1 });
				if (!semana.volcado) throw new Error("la semana no cabe");
				expect(semana.volcado.ventana_desde, camino).toBe(haceDias(7));
				expect(ventasCon(semana.volcado, "vieja"), camino).toBe(0);
				expect(ventasCon(semana.volcado, "semana"), camino).toBe(DE_LA_SEMANA);
				comprobarLoImprescindible(semana.volcado, `${camino}, 7 días`);

				// Y con una menos que la semana: sólo lo imprescindible, desde el último cierre.
				const minimo = await fase1(lector, { ...SIN_TOPE, filas: filasDe(semana.volcado) - 1 });
				if (!minimo.volcado) throw new Error("lo imprescindible no cabe");
				expect(minimo.volcado.ventana_desde, camino).toBe(CIERRE);
				expect(ventasCon(minimo.volcado, "vieja"), camino).toBe(0);
				expect(ventasCon(minimo.volcado, "semana"), camino).toBe(0);
				expect(ventasCon(minimo.volcado, "periodo"), camino).toBe(DESDE_EL_CIERRE);
				// El cierre anterior al último ya no entra: es histórico.
				expect(valores(minimo.volcado, "Cierres_Caja", "ID_Cierre"), camino).toEqual(["ci-ultimo"]);
				comprobarLoImprescindible(minimo.volcado, `${camino}, lo imprescindible`);

				// Si ni eso cabe, no hay ventana que valga: es el «no cabe» de siempre, con sus filas.
				const nada = await fase1(lector, { ...SIN_TOPE, filas: filasDe(minimo.volcado) - 1 });
				expect(nada, camino).toEqual({ volcado: null, totalFilas: filasDe(minimo.volcado) });

				// Lo mismo con el tope en BYTES, que es el que alcanza un bar de verdad. A medio
				// camino entre lo que ocupa un escalón y el siguiente sale el estrecho de los dos.
				const entre = (a: number, b: number) => Math.round((a + b) / 2);
				const porBytes = async (bytes: number) => fase1(lector, { ...SIN_TOPE, bytes });

				const comoElMes = await porBytes(mes.bytes * 2);
				expect(comoElMes.volcado?.ventana_desde, camino).toBe(haceDias(30));

				const comoLaSemana = await porBytes(entre(mes.bytes, semana.bytes));
				expect(comoLaSemana.volcado?.ventana_desde, camino).toBe(haceDias(7));
				expect(comoLaSemana.volcado, camino).toEqual(semana.volcado);

				const comoElMinimo = await porBytes(entre(semana.bytes, minimo.bytes));
				expect(comoElMinimo.volcado?.ventana_desde, camino).toBe(CIERRE);
				expect(comoElMinimo.volcado, camino).toEqual(minimo.volcado);

				const sinSitio = await porBytes(Math.round(minimo.bytes / 2));
				expect(sinSitio, camino).toEqual({ volcado: null, totalFilas: filasDe(minimo.volcado) });
			}
		});
	});

	it("los dos lectores eligen la misma ventana y escriben lo mismo", async () => {
		await enElHub("ventana-que-cabe-caminos", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrarBar(sql);

			const [[, delHub], [, delWorker]] = lectores(sql);
			const mes = await volcarFase1(delHub, AHORA, SIN_TOPE);
			if (!mes.cuerpo) throw new Error("el mes no cabe sin topes");
			for (const bytes of [mes.cuerpo.byteLength * 2, Math.round(mes.cuerpo.byteLength * 0.7), 20_000]) {
				const a = await volcarFase1(delHub, AHORA, { ...SIN_TOPE, bytes });
				const b = await volcarFase1(delWorker, AHORA, { ...SIN_TOPE, bytes });
				expect(a, `${bytes} bytes`).toEqual(b);
			}
		});
	});

	it("la medida previa es una estimación: si al escribir no cabe, se prueba la ventana siguiente", async () => {
		// El peso de una tabla sale de sus últimas filas. Aquí engañan: los gastos recientes son
		// cortos y los de hace veinte días, enormes. La medida dice que el mes cabe; al escribirlo
		// no cabe, y lo que viaja es la semana.
		await enElHub("ventana-que-cabe-estimacion", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			const gasto = (id: string, fecha: string, concepto: string) =>
				sql.exec(
					"INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto) VALUES (?, date(?), ?, 1000, 'VARIOS');",
					id,
					fecha,
					concepto,
				);
			for (let i = 0; i < 200; i++) gasto(`g-largo-${i}`, haceDias(20), "Reparación de la cafetera. ".repeat(40));
			for (let i = 0; i < 100; i++) gasto(`g-corto-${i}`, haceDias(2), "Pan");

			for (const [camino, lector] of lectores(sql)) {
				const mes = await fase1(lector, SIN_TOPE);
				const semana = await fase1(lector, { ...SIN_TOPE, filas: 250 });
				if (!mes.volcado || !semana.volcado) throw new Error("no caben sin topes");
				expect(semana.volcado.ventana_desde, camino).toBe(haceDias(7));
				// El mes real ocupa mucho más que la semana…
				expect(mes.bytes, camino).toBeGreaterThan(semana.bytes + 150_000);

				// …y con sitio para la semana y 50 KB más, la medida (300 gastos «cortos») da el mes
				// por bueno. Lo que llega es la semana, entera.
				const r = await fase1(lector, { ...SIN_TOPE, bytes: semana.bytes + 50_000 });
				expect(r.volcado?.ventana_desde, camino).toBe(haceDias(7));
				expect(r.volcado, camino).toEqual(semana.volcado);
				expect(tabla(r.volcado!, "Cuentas_Gastos").filas, camino).toHaveLength(100);
			}
		});
	});

	it("si la medida se queda larga, lo imprescindible se intenta igual: decide lo que se escribe", async () => {
		// Engañan al revés: 2.000 clientes sin nota y, detrás, 64 con una nota enorme. La medida, que
		// pesa la tabla por sus últimas filas, da varios megas; lo que hay son unos 300 KB. Detrás
		// de la ventana más estrecha no hay otra, así que no se le puede contestar «no cabe» por una
		// estimación.
		await enElHub("ventana-que-cabe-medida-larga", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			for (let i = 0; i < 2_000; i++) {
				sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES (?, 'Ana');", `cl-${i}`);
			}
			for (let i = 0; i < 64; i++) {
				sql.exec(
					"INSERT INTO Clientes (ID_Cliente, Nombre, Notas) VALUES (?, 'Ana', ?);",
					`cl-nota-${i}`,
					"No le pongas hielo. ".repeat(100),
				);
			}

			const [[, delHub], [, delWorker]] = lectores(sql);
			const real = await fase1(delHub, SIN_TOPE);
			if (!real.volcado) throw new Error("no cabe sin topes");
			const topes = { ...SIN_TOPE, bytes: real.bytes * 2 };

			// Con sitio para el doble de lo que ocupa de verdad, viaja: lo imprescindible, entero.
			const r = await fase1(delHub, topes);
			if (!r.volcado) throw new Error("lo imprescindible cabía y se ha contestado que no");
			expect(r.volcado.ventana_desde).toBe(AHORA);
			expect(tabla(r.volcado, "Clientes").filas).toHaveLength(2_064);
			expect(r.bytes).toBeLessThanOrEqual(topes.bytes);

			// Con la ruta en el Worker no se intenta: allí intentarlo es traer todas las filas por
			// la llamada al DO, que es lo que el techo viene a evitar.
			expect((await fase1(delWorker, topes)).volcado).toBeNull();

			// Y si de verdad no cabe, sigue siendo que no.
			expect((await fase1(delHub, { ...SIN_TOPE, bytes: Math.round(real.bytes / 2) })).volcado).toBeNull();
		});
	});
});

describe("el contraste diario usa la ventana que cabe", () => {
	/** La foto del contraste; sus tablas, también como `tablas`, para mirarlas como las del volcado. */
	const leer = async (lector: Lector, topes: Topes) => {
		const foto = JSON.parse(new TextDecoder().decode(await fotoDeVerificacion(lector, AHORA, topes)));
		return { ...foto, tablas: foto.ventana };
	};

	it("con menos sitio contrasta una ventana más estrecha, y sólo la omite si no cabe ni lo imprescindible", async () => {
		await enElHub("ventana-que-cabe-verificar", async (hub: any) => {
			const sql = hub.state.storage.sql;
			crearEsquemaTenant(sql);
			sembrarBar(sql);

			for (const [camino, lector] of lectores(sql)) {
				const mes = await leer(lector, SIN_TOPE);
				expect(mes.ventana_omitida, camino).toBe(false);
				expect(mes.desde, camino).toBe(haceDias(30));
				expect(ventasCon(mes, "vieja"), camino).toBe(VIEJAS);
				const filasDelMes = filasDe(mes);

				const semana = await leer(lector, { ...SIN_TOPE, filas: filasDelMes - 1 });
				expect(semana.ventana_omitida, camino).toBe(false);
				expect(semana.desde, camino).toBe(haceDias(7));
				expect(ventasCon(semana, "vieja"), camino).toBe(0);
				expect(ventasCon(semana, "semana"), camino).toBe(DE_LA_SEMANA);
				// Los conteos siguen siendo de la tabla entera, quepa lo que quepa.
				const comandas = VIEJAS + DE_LA_SEMANA + DESDE_EL_CIERRE + DE_HOY + 2;
				for (const foto of [mes, semana]) {
					expect(foto.conteos.find((c: any) => c.nombre === "Comandas").filas, camino).toBe(comandas);
					expect(foto.hasta_seq, camino).toBe(1);
				}

				const nada = await leer(lector, { ...SIN_TOPE, bytes: 2_000 });
				expect(nada.ventana_omitida, camino).toBe(true);
				expect(nada.ventana, camino).toEqual([]);
				expect(nada.desde, camino).toBe(haceDias(30));
				expect(nada.conteos.find((c: any) => c.nombre === "Comandas").filas, camino).toBe(comandas);
				expect(nada.hasta_seq, camino).toBe(1);
			}
		});
	});
});
