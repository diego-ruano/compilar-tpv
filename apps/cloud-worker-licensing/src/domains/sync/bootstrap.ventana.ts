// src/domains/sync/bootstrap.ventana.ts
//
// SYNC-19 · Qué se lleva la fase 1 de una recuperación.
//
// El volcado se construía ENTERO en memoria y por eso tenía un tope de filas: pasado ese número
// el equipo simplemente no podía recuperarse desde la nube, que es la única forma que tiene de
// volver a operar. El arreglo no es subir el tope, es dejar de traerlo todo de golpe:
//
//   FASE 1 (este fichero)  lo imprescindible para volver a vender  → una petición, foto coherente
//   FASE 2 (`/historico`)  el resto del histórico                  → job de fondo, paginado
//
// La clasificación vive AQUÍ y en ningún otro sitio: el worker le dice a la Main, tabla por tabla,
// si lo que le manda está completo o recortado, y la Main siembra su cola de backfill con eso.
// Duplicar la lista en Rust sería tener dos fuentes para la misma decisión, y divergirían.
//
// ──────────────────────────────────────────────────────────────────────────────
// Las tres reglas
// ──────────────────────────────────────────────────────────────────────────────
//
// 1. **Los maestros van enteros.** Crecen con el catálogo y con la plantilla, no con las ventas,
//    y son justo lo que deja al bar operativo: sin `Productos` no se puede cobrar, sin `Usuarios`
//    no se puede ni entrar. Recortarlos ahorraría poco y rompería mucho.
//
// 2. **Los transaccionales van por ventana** (30 días, ver `VENTANA_DIAS`), estirada hasta cubrir
//    el periodo de caja abierto. Lo segundo no es un detalle: el arqueo calcula
//    `esperado = fondo + cobros en efectivo desde el último cierre`, así que un bar que lleve 40
//    días sin cerrar caja —pasa, el aviso es una notificación, no una acción— vería su primer
//    arqueo tras recuperar descuadrado por un dinero que sí está en el cajón.
//
// 3. **Lo que sigue VIVO entra entero, caiga donde caiga.** Es la generalización de la regla
//    anterior, y sin ella la ventana se lleva por delante cosas que están en uso: una mesa abierta
//    hace diez días, una notificación activa (cuyo índice `UNIQUE` de dedupe, al no verla, dejaría
//    re-emitirla, y el duplicado acabaría en cuarentena al replicar), un pedido a proveedor en
//    borrador o un fichaje sin cerrar.
//
// ──────────────────────────────────────────────────────────────────────────────
// Si el mes no cabe, la ventana se encoge
// ──────────────────────────────────────────────────────────────────────────────
//
// La fase 1 es una sola respuesta y tiene un techo (`VOLCADO_MAX_BYTES`, `volcado.ts`). El mes de
// un bar con mucho movimiento no cabe en él, y contestarle «no cabe» es dejarlo sin recuperación.
// Así que los 30 días son lo que se intenta, no lo que se exige: si no caben se prueba con una
// semana, con un día y con ninguno (`ANCHOS_DE_VENTANA`), y viaja la más ancha que cabe.
//
// Lo que no se encoge nunca es lo que las tres reglas hacen entrar sin mirar la ventana: los
// maestros, lo que sigue vivo, todo lo que hay desde el último cierre de caja no reabierto y el
// último registro de facturación. Es lo imprescindible para volver a vender, y si ni eso cabe la
// respuesta sí es «no cabe».
//
// A la Main le da igual el ancho: restaura lo que llega y rellena lo demás por la fase 2, que
// recorre cada tabla transaccional entera, desde el principio (`parcial`, `backfill`). Con una
// ventana más estrecha baja lo mismo; sólo cambia cuánto llega en la primera respuesta.
//
// ──────────────────────────────────────────────────────────────────────────────
// La unidad es la comanda, no la fila
// ──────────────────────────────────────────────────────────────────────────────
//
// Filtrar cada tabla por su propia fecha parece lo natural y es un error: un pago de hace cinco
// días de una comanda abierta hace cuarenta entraría sin su comanda, y `Pagos.ID_Comanda` es una
// FK. La restauración corre con `defer_foreign_keys`, así que eso no da un aviso: aborta la
// transacción entera y la recuperación falla. Por eso una comanda entra o no entra CON TODO lo
// suyo —líneas, pagos, detalles del pago, consumos de lote y de suelto—, y lo que decide es la
// comanda: abierta, abierta o cerrada dentro de la ventana, o con algún cobro —o la baja de alguno—
// dentro de ella.
//
// De paso arregla algo que no es de integridad: partir una comanda por la mitad dejaría su
// "pendiente" mintiendo.

import { parseClientNow, serverNowFixed } from "../../durableObjects/tenantHub.tiempo";

/**
 * Cuánto histórico baja DE GOLPE. Todo lo anterior llega después, en segundo plano, sin que nadie
 * espere (fase 2): esto no es "lo que se puede recuperar", es "lo que hace falta para abrir".
 *
 * 30 días = el mes en curso entero, para que el día después de la avería las estadísticas del mes
 * y los cobros recientes estén ahí. Con ~3-4k filas/día son ~120k filas, holgadamente por debajo
 * del tope de la fase 1.
 *
 * **Es un parámetro, no una decisión de arquitectura**: cambiarlo es cambiar este número.
 */
export const VENTANA_DIAS = 30;

/**
 * Los anchos de ventana que se prueban, en días y del más ancho al más estrecho: viaja el primero
 * que cabe en los topes de la fase 1. El último, cero, deja sólo lo imprescindible (ver arriba).
 *
 * Son cuatro escalones y no una búsqueda del día exacto porque medir uno cuesta un `COUNT` por
 * tabla transaccional sobre esa ventana, y lo que se gana afinando es poco: lo que no entra ahora
 * lo trae la fase 2.
 */
export const ANCHOS_DE_VENTANA: readonly number[] = [VENTANA_DIAS, 7, 1, 0];

/**
 * Tablas de control que NO forman parte del negocio y que la Main mantiene por su cuenta.
 * `Sync_Changes`/`Applied_Operations`/`Sync_Main_Checkpoints` son el andamiaje de la replicación
 * en la nube; el prefijo `_` cubre `_migrations`.
 */
export const TABLAS_DE_ANDAMIAJE = new Set([
	"Sync_Changes",
	"Applied_Operations",
	"Sync_Main_Checkpoints",
]);

/**
 * Estado anti-fuerza-bruta, no dato de negocio: empezar con la tabla vacía es lo correcto, y
 * restaurarla sólo serviría para heredar los bloqueos de un equipo que ya no existe.
 */
export const TABLAS_NO_RESTAURADAS = new Set(["Intentos_Login"]);

export function esTablaDeNegocio(nombre: string): boolean {
	if (!nombre) return false;
	if (nombre.startsWith("_") || nombre.startsWith("sqlite_") || nombre.startsWith("libsql_")) {
		return false;
	}
	return !TABLAS_DE_ANDAMIAJE.has(nombre) && !TABLAS_NO_RESTAURADAS.has(nombre);
}

// ──────────────────────────────────────────────────────────────────────────────
// Los conjuntos seleccionados, como CTEs reutilizables
// ──────────────────────────────────────────────────────────────────────────────
//
// Cada tabla es una sentencia suelta dentro del `batch`, así que lleva delante los CTE que
// necesita. Están escritos una vez para que padre e hijas no puedan discrepar: si la definición
// de "qué comandas entran" viviera copiada en seis sitios, el día que cambie entrarían hijas
// huérfanas y la restauración fallaría entera.

/**
 * `?1` = límite inferior de la ventana, `YYYY-MM-DD HH:MM:SS` en hora local del equipo.
 *
 * La baja de un cobro cuenta como el cobro (`Anulado_En`). El dinero de una devolución sale del
 * cajón el día que se devuelve, y el arqueo lo resta en el periodo en que salió aunque la venta sea
 * de un periodo anterior (REV-08, `cierre_caja.rs::totales_entre`): un ticket de hace veinte días
 * devuelto hoy forma parte del periodo de caja abierto. Sin él, el primer arqueo tras recuperar
 * esperaría en el cajón un dinero que ya se devolvió.
 *
 * Y entra siempre la comanda del cobro del último registro de facturación. Ese registro viaja con
 * cualquier ventana (ver `Registros_Facturacion`, abajo) y su `ID_Pago` es una FK: si el cobro se
 * quedara fuera, la restauración entera abortaría. Con la ventana encogida hasta el último cierre
 * pasa en cuanto se recupera sin haber vendido nada después de cerrar.
 */
const CTE_COMANDAS = `sel_comandas AS (
	SELECT ID_Comanda FROM Comandas
	 WHERE Estado = 'Abierta'
	    OR Fecha_Hora_Apertura >= ?1
	    OR COALESCE(Fecha_Hora_Cierre, '') >= ?1
	    OR EXISTS (SELECT 1 FROM Pagos p
	                WHERE p.ID_Comanda = Comandas.ID_Comanda
	                  AND (p.Fecha_Hora >= ?1 OR COALESCE(p.Anulado_En, '') >= ?1))
	    OR ID_Comanda = (SELECT p.ID_Comanda FROM Pagos p
	                      WHERE p.ID_Pago = (SELECT r.ID_Pago FROM Registros_Facturacion r
	                                          ORDER BY r.Orden DESC LIMIT 1))
)`;

const CTE_DETALLES = `sel_detalles AS (
	SELECT ID_Detalle FROM Detalle_Comanda
	 WHERE ID_Comanda IN (SELECT ID_Comanda FROM sel_comandas)
)`;

const CTE_PAGOS = `sel_pagos AS (
	SELECT ID_Pago FROM Pagos
	 WHERE ID_Comanda IN (SELECT ID_Comanda FROM sel_comandas)
)`;

/**
 * El último cierre NO reabierto entra aunque quede fuera de la ventana: su hora es donde empieza
 * el periodo de caja abierto, y su `Dejado` el fondo del arqueo siguiente.
 */
const CTE_CIERRES = `sel_cierres AS (
	SELECT ID_Cierre FROM Cierres_Caja
	 WHERE Fecha_Hora >= ?1
	    OR ID_Cierre = (SELECT ID_Cierre FROM Cierres_Caja
	                     WHERE Reabierto_En IS NULL ORDER BY Fecha_Hora DESC LIMIT 1)
)`;

const CTE_PEDIDOS = `sel_pedidos AS (
	SELECT ID_Pedido FROM Pedidos_Proveedor
	 WHERE Fecha_Creacion >= ?1 OR Estado = 'borrador'
)`;

const CTE_NOTIFS = `sel_notifs AS (
	SELECT ID_Notificacion FROM Notificaciones
	 WHERE Creada_En >= ?1 OR Estado = 'activa'
)`;

const CTE_FICHAJES = `sel_fichajes AS (
	SELECT ID_Usuario, Fecha FROM Fichajes
	 WHERE Fecha >= date(?1) OR Estado = 'ABIERTO'
)`;

/** Una tabla transaccional: qué trozo entra en la fase 1 y en qué orden se rellena en la fase 2. */
type Transaccional = {
	nombre: string;
	/** CTEs que necesita `donde`, en orden de dependencia. */
	ctes: string[];
	/** Predicado del `WHERE`. `?1` es el límite inferior de la ventana. */
	donde: string;
};

/**
 * El predicado de las dos tablas cuya clave es `(ID_Pago, ID_Detalle)`: el pago y la línea, los dos
 * de la ventana.
 *
 * ⚠️ El `+` de `+ID_Detalle` no es decorativo. Sin él, SQLite resuelve los dos `IN` contra el índice
 * de la clave primaria a la vez (`ID_Pago=? AND ID_Detalle=?`) y prueba **cada pago con cada línea**
 * de la ventana. Medido con tres días de un bar de mil comandas diarias: trece segundos por
 * sentencia, y el volcado y la verificación la ejecutan cuatro veces (el conteo y el volcado de
 * cada tabla). El `+` deja esa columna fuera del índice sin cambiar la comparación: se entra por el
 * pago y la línea se comprueba contra su lista, una vez por fila. Lo vigila
 * `test/syncVentanaPlan.test.ts`, que lee el plan de todas las sentencias de la ventana.
 */
const DE_UN_PAGO_Y_UNA_LINEA_DE_LA_VENTANA =
	"ID_Pago IN (SELECT ID_Pago FROM sel_pagos) AND +ID_Detalle IN (SELECT ID_Detalle FROM sel_detalles)";

/**
 * El mismo predicado para los consumos, cuya clave empieza por la línea: se entra por ella y el
 * cobro se comprueba contra su lista. El `+` está por lo mismo.
 */
const DE_UNA_LINEA_Y_UN_PAGO_DE_LA_VENTANA =
	"ID_Detalle IN (SELECT ID_Detalle FROM sel_detalles) AND +ID_Pago IN (SELECT ID_Pago FROM sel_pagos)";

/**
 * Tablas transaccionales, **en orden de backfill: padres primero**.
 *
 * El orden importa porque cada página de la fase 2 es su propia transacción y
 * `defer_foreign_keys` sólo ayuda dentro de una: una línea insertada antes que su comanda no
 * tiene dónde apoyarse.
 */
export const TRANSACCIONALES: Transaccional[] = [
	{
		nombre: "Comandas",
		ctes: [CTE_COMANDAS],
		donde: "ID_Comanda IN (SELECT ID_Comanda FROM sel_comandas)",
	},
	{
		nombre: "Detalle_Comanda",
		ctes: [CTE_COMANDAS],
		donde: "ID_Comanda IN (SELECT ID_Comanda FROM sel_comandas)",
	},
	{
		nombre: "Pagos",
		ctes: [CTE_COMANDAS],
		donde: "ID_Comanda IN (SELECT ID_Comanda FROM sel_comandas)",
	},
	{
		// Las dos FK a la vez y no sólo una: son siempre de la misma comanda, así que pedirlo por
		// duplicado no quita ninguna fila legítima y cierra la puerta a una huérfana por cualquier
		// lado el día que dejen de serlo.
		nombre: "Pago_Detalles",
		ctes: [CTE_COMANDAS, CTE_DETALLES, CTE_PAGOS],
		donde: DE_UN_PAGO_Y_UNA_LINEA_DE_LA_VENTANA,
	},
	{
		// Lo devuelto de una devolución de parte de un cobro. Como `Pago_Detalles`: su pago (la
		// devolución, un pago negativo) y su línea son de la misma comanda. Va después de `Pagos`, y
		// la devolución después de su cobro: el `rowid` de la nube sigue el orden en que se
		// escribieron, así que `Pagos.ID_Pago_Origen` siempre encuentra a su padre.
		nombre: "Devolucion_Lineas",
		ctes: [CTE_COMANDAS, CTE_DETALLES, CTE_PAGOS],
		donde: DE_UN_PAGO_Y_UNA_LINEA_DE_LA_VENTANA,
	},
	{
		// Un consumo es de una línea y del cobro que la cobró, y los dos son FK. Como en
		// `Pago_Detalles`, son de la misma comanda y se piden las dos: si un día no lo fueran, el
		// consumo se queda para la fase 2 en vez de abortar la restauración.
		nombre: "Lote_Consumos",
		ctes: [CTE_COMANDAS, CTE_DETALLES, CTE_PAGOS],
		donde: DE_UNA_LINEA_Y_UN_PAGO_DE_LA_VENTANA,
	},
	{
		nombre: "Suelto_Consumos",
		ctes: [CTE_COMANDAS, CTE_DETALLES, CTE_PAGOS],
		donde: DE_UNA_LINEA_Y_UN_PAGO_DE_LA_VENTANA,
	},
	{
		// CUENTA-07. Un movimiento de caja nace a la vez que su cobro, así que la fecha basta; la
		// comprobación sobre `sel_pagos` es la red por si un día no fuera así: `ID_Pago` es una FK
		// y una huérfana aquí no se pierde a sí misma, aborta la restauración ENTERA.
		nombre: "Movimientos_Caja",
		ctes: [CTE_COMANDAS, CTE_PAGOS],
		donde:
			"Fecha_Hora >= ?1 AND (ID_Pago IS NULL OR ID_Pago IN (SELECT ID_Pago FROM sel_pagos))",
	},
	{
		// FISCAL-01. Va DESPUÉS de `Pagos` porque `ID_Pago` es una FK suya, y la fase 2 inserta
		// página a página sin `defer_foreign_keys` entre transacciones.
		//
		// La ventana se mide sobre `Fecha_Hora_Huso` (ISO 8601 local, ordenable) y **no** sobre
		// `Fecha_Expedicion`, que es `DD-MM-AAAA` porque así viaja al XML y al QR: comparar eso
		// contra una fecha `AAAA-MM-DD` da un orden lexicográfico sin ningún sentido.
		//
		// El último eslabón es el que importa de verdad: la cadena de huellas se continúa desde el
		// ÚLTIMO, así que ese tiene que volver siempre — aunque el bar lleve dos meses cerrado y no
		// haya emitido nada dentro de la ventana. Sin él, una Main restaurada arrancaría una cadena
		// nueva marcándose `PrimerRegistro = "S"` con registros ya existentes para ese SIF y NIF,
		// que es exactamente el error admisible 2007. Su cobro viaja con él: `sel_comandas` trae
		// siempre esa comanda.
		//
		// Los demás, los de la ventana, sólo viajan si viaja su cobro (o si no tienen): `ID_Pago`
		// es una FK y una huérfana aborta la restauración ENTERA. No es un caso de laboratorio: la
		// comparación con `Fecha_Hora_Huso` es de textos, y su `T` es mayor que el espacio del
		// límite, así que del día en que cae el límite entran los registros de todo el día, también
		// los de antes de esa hora, cuyos cobros no entran. Esos registros llegan por la fase 2,
		// detrás de sus cobros.
		nombre: "Registros_Facturacion",
		ctes: [CTE_COMANDAS, CTE_PAGOS],
		donde:
			"Orden = (SELECT MAX(Orden) FROM Registros_Facturacion) " +
			"OR (Fecha_Hora_Huso >= ?1 AND (ID_Pago IS NULL OR ID_Pago IN (SELECT ID_Pago FROM sel_pagos)))",
	},
	{
		nombre: "Cierres_Caja",
		ctes: [CTE_CIERRES],
		donde: "ID_Cierre IN (SELECT ID_Cierre FROM sel_cierres)",
	},
	{
		nombre: "Cierre_Denominaciones",
		ctes: [CTE_CIERRES],
		donde: "ID_Cierre IN (SELECT ID_Cierre FROM sel_cierres)",
	},
	{
		// CAJA-01. Van con su cierre: `ID_Cierre` es una FK suya.
		nombre: "Cierre_Rectificaciones",
		ctes: [CTE_CIERRES],
		donde: "ID_Cierre IN (SELECT ID_Cierre FROM sel_cierres)",
	},
	{
		nombre: "Cuentas_Gastos",
		ctes: [],
		donde: "Fecha >= date(?1)",
	},
	{
		nombre: "Movimientos_Stock",
		ctes: [],
		donde: "Fecha >= ?1",
	},
	{
		nombre: "Fichajes",
		ctes: [],
		donde: "Fecha >= date(?1) OR Estado = 'ABIERTO'",
	},
	{
		nombre: "Fichaje_Dia",
		ctes: [CTE_FICHAJES],
		donde:
			"Fecha >= date(?1) OR EXISTS (SELECT 1 FROM sel_fichajes f WHERE f.ID_Usuario = Fichaje_Dia.ID_Usuario AND f.Fecha = Fichaje_Dia.Fecha)",
	},
	{
		nombre: "Aperturas_Cajon",
		ctes: [],
		donde: "Fecha >= ?1",
	},
	{
		nombre: "Pedidos_Proveedor",
		ctes: [CTE_PEDIDOS],
		donde: "ID_Pedido IN (SELECT ID_Pedido FROM sel_pedidos)",
	},
	{
		nombre: "Lineas_Pedido_Proveedor",
		ctes: [CTE_PEDIDOS],
		donde: "ID_Pedido IN (SELECT ID_Pedido FROM sel_pedidos)",
	},
	{
		nombre: "Notificaciones",
		ctes: [CTE_NOTIFS],
		donde: "ID_Notificacion IN (SELECT ID_Notificacion FROM sel_notifs)",
	},
	{
		nombre: "Notificacion_Lecturas",
		ctes: [CTE_NOTIFS],
		donde: "ID_Notificacion IN (SELECT ID_Notificacion FROM sel_notifs)",
	},
];

const POR_NOMBRE = new Map(TRANSACCIONALES.map((t) => [t.nombre, t]));

/**
 * ¿Esta tabla de negocio se recorta por ventana?
 *
 * Lo que NO está aquí se trata como maestro y viaja entero, **y eso es a propósito**: el día que
 * alguien añada una tabla y no toque este fichero, el fallo será traer de más (un volcado un poco
 * más gordo), no perder datos en silencio el día de una avería. Hay un test que avisa igualmente.
 */
export function esTransaccional(nombre: string): boolean {
	return POR_NOMBRE.has(nombre);
}

/**
 * La sentencia de la fase 1 para una tabla: recortada si es transaccional, entera si es maestra.
 *
 * Devuelve también sus `args` porque no todas llevan los mismos: una maestra no tiene ningún `?`,
 * y pasarle el límite de la ventana igualmente es un error de binding, no un argumento que sobra.
 */
export function sentenciaVolcado(nombre: string, desde: string): { sql: string; args: string[] } {
	const t = POR_NOMBRE.get(nombre);
	if (!t) return { sql: `SELECT * FROM "${nombre}";`, args: [] };
	return { sql: `${prelude(t)}SELECT * FROM "${nombre}" WHERE ${t.donde};`, args: [desde] };
}

/**
 * El `COUNT(*)` del MISMO trozo que devolvería `sentenciaVolcado`. Es la guardia de tamaño, y
 * tiene que contar exactamente lo que se va a construir: contar la tabla entera diría que no cabe
 * algo que sí cabe, y esa respuesta es un 413 el día de una avería.
 *
 * El `WITH` va al principio de la sentencia y no envuelto en una subconsulta a propósito: un
 * `SELECT COUNT(*) FROM (WITH …)` no es SQL que todos los motores acepten.
 */
export function sentenciaConteo(nombre: string, desde: string): { sql: string; args: string[] } {
	const t = POR_NOMBRE.get(nombre);
	if (!t) return { sql: `SELECT COUNT(*) AS n FROM "${nombre}";`, args: [] };
	return {
		sql: `${prelude(t)}SELECT COUNT(*) AS n FROM "${nombre}" WHERE ${t.donde};`,
		args: [desde],
	};
}

function prelude(t: Transaccional): string {
	return t.ctes.length ? `WITH ${t.ctes.join(",\n")}\n` : "";
}

/**
 * Los límites inferiores de ventana que se prueban, del más ancho al imprescindible y sin
 * repetir: `MIN(ahora - días, último cierre no reabierto)` por cada ancho de `ANCHOS_DE_VENTANA`.
 *
 * El primero es la ventana de siempre, los 30 días estirados hasta el último cierre. El último es
 * el propio cierre (o «ahora», si el negocio nunca ha cerrado caja): con él sólo entra lo que no
 * depende de la ventana. Un cierre de hace más de 30 días deja una sola candidata, porque todas
 * se estiran hasta él.
 *
 * El reloj es el del EQUIPO (cabecera `X-Client-Now`), no el del servidor, por lo mismo que en el
 * resto del sistema: las fechas de esta base son hora local en texto, y compararlas contra un UTC
 * del edge correría la ventana lo que valga el huso. Si no llega una hora válida se cae a la del
 * servidor: unas horas de desfase mueven el borde de la ventana, no lo que entra siempre. «Ahora»
 * se lee una vez para todas las candidatas.
 */
export function ventanasCandidatas(clientNow: unknown, ultimoCierre: string | null): string[] {
	const ahora = parseClientNow(clientNow) ?? serverNowFixed();
	const ahoraMs = new Date(ahora.replace(" ", "T") + "Z").getTime();

	const candidatas: string[] = [];
	for (const dias of ANCHOS_DE_VENTANA) {
		const porFecha = new Date(ahoraMs - dias * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
		const desde = ultimoCierre && ultimoCierre < porFecha ? ultimoCierre : porFecha;
		if (candidatas[candidatas.length - 1] !== desde) candidatas.push(desde);
	}
	return candidatas;
}
