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
// La unidad es la comanda, no la fila
// ──────────────────────────────────────────────────────────────────────────────
//
// Filtrar cada tabla por su propia fecha parece lo natural y es un error: un pago de hace cinco
// días de una comanda abierta hace cuarenta entraría sin su comanda, y `Pagos.ID_Comanda` es una
// FK. La restauración corre con `defer_foreign_keys`, así que eso no da un aviso: aborta la
// transacción entera y la recuperación falla. Por eso una comanda entra o no entra CON TODO lo
// suyo —líneas, pagos, detalles del pago, consumos de lote y de suelto—, y lo que decide es la
// comanda: abierta, abierta o cerrada dentro de la ventana, o con algún cobro dentro de ella.
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

/** `?1` = límite inferior de la ventana, `YYYY-MM-DD HH:MM:SS` en hora local del equipo. */
const CTE_COMANDAS = `sel_comandas AS (
	SELECT ID_Comanda FROM Comandas
	 WHERE Estado = 'Abierta'
	    OR Fecha_Hora_Apertura >= ?1
	    OR COALESCE(Fecha_Hora_Cierre, '') >= ?1
	    OR EXISTS (SELECT 1 FROM Pagos p
	                WHERE p.ID_Comanda = Comandas.ID_Comanda AND p.Fecha_Hora >= ?1)
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
		donde:
			"ID_Pago IN (SELECT ID_Pago FROM sel_pagos) AND ID_Detalle IN (SELECT ID_Detalle FROM sel_detalles)",
	},
	{
		// Lo devuelto de una devolución de parte de un cobro. Como `Pago_Detalles`: su pago (la
		// devolución, un pago negativo) y su línea son de la misma comanda. Va después de `Pagos`, y
		// la devolución después de su cobro: el `rowid` de la nube sigue el orden en que se
		// escribieron, así que `Pagos.ID_Pago_Origen` siempre encuentra a su padre.
		nombre: "Devolucion_Lineas",
		ctes: [CTE_COMANDAS, CTE_DETALLES, CTE_PAGOS],
		donde:
			"ID_Pago IN (SELECT ID_Pago FROM sel_pagos) AND ID_Detalle IN (SELECT ID_Detalle FROM sel_detalles)",
	},
	{
		nombre: "Lote_Consumos",
		ctes: [CTE_COMANDAS, CTE_DETALLES],
		donde: "ID_Detalle IN (SELECT ID_Detalle FROM sel_detalles)",
	},
	{
		nombre: "Suelto_Consumos",
		ctes: [CTE_COMANDAS, CTE_DETALLES],
		donde: "ID_Detalle IN (SELECT ID_Detalle FROM sel_detalles)",
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
		// El `OR` del final es el que importa de verdad: la cadena de huellas se continúa desde el
		// ÚLTIMO eslabón, así que ese tiene que volver siempre — aunque el bar lleve dos meses
		// cerrado y no haya emitido nada dentro de la ventana. Sin él, una Main restaurada
		// arrancaría una cadena nueva marcándose `PrimerRegistro = "S"` con registros ya existentes
		// para ese SIF y NIF, que es exactamente el error admisible 2007.
		nombre: "Registros_Facturacion",
		ctes: [],
		donde:
			"Fecha_Hora_Huso >= ?1 OR Orden = (SELECT MAX(Orden) FROM Registros_Facturacion)",
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
 * Límite inferior de la ventana: `MIN(ahora - VENTANA_DIAS, último cierre no reabierto)`.
 *
 * El reloj es el del EQUIPO (cabecera `X-Client-Now`), no el del servidor, por lo mismo que en el
 * resto del sistema: las fechas de esta base son hora local en texto, y compararlas contra un UTC
 * del edge correría la ventana lo que valga el huso. Si no llega una hora válida se cae a la del
 * servidor: para 30 días, unas horas de desfase no cambian nada.
 */
export function limiteVentana(clientNow: unknown, ultimoCierre: string | null): string {
	const ahora = parseClientNow(clientNow) ?? serverNowFixed();
	const ms = new Date(ahora.replace(" ", "T") + "Z").getTime() - VENTANA_DIAS * 86_400_000;
	const porFecha = new Date(ms).toISOString().slice(0, 19).replace("T", " ");
	if (!ultimoCierre) return porFecha;
	return ultimoCierre < porFecha ? ultimoCierre : porFecha;
}
