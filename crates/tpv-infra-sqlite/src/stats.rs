//! Adaptador SQLite del repositorio de **estadísticas** (analítica, solo lectura).
//!
//! Reubica verbatim toda la agregación SQL del antiguo `stats.rs`. Los cuerpos internos
//! (`*_impl`) devuelven `Result<T, String>` para poder portarse sin cambios; el `impl`
//! del puerto los envuelve mapeando el error a `AppError::Repository`.

use tpv_domain::dinero::Dinero;
use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use crate::db::{Db, Reader};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::stats::StatsRepository;
use tpv_contracts::stats::{
    ChartSerieDinero, ChartSeriesI64, ClientesStatsArgs, ClientesStatsResponse, MesaIngresoRow,
    MesasStatsResponse, MesasTopComandas, ProductosStatsArgs, ProductosStatsResponse,
    ProveedorTop, ProveedoresStatsArgs, ProveedoresStatsResponse, PuntualidadInfo,
    ReservasMesasTurno, ReservasStatsArgs, ReservasStatsResponse, StatsCategoriaRow, StatsRange,
    StatsTurno, TrabajadorCardStats, TrabajadoresStatsArgs, TrabajadoresStatsResponse,
    UltimoGastoProveedor,
};

use crate::mapping::{v_f64, v_i64, v_string, v_dinero};

/// STAT-03: horas que se imputan a una jornada **auto-cerrada** por olvido de fichar la salida
/// (TRAB-01 la marca `Cerrado_Automatico=1` con `Hora_Salida` NULL). Sin esto, esas jornadas
/// sumaban 0 h e infravaloraban las horas del trabajador. Se opta por una jornada estándar fija
/// (decisión de negocio, revisable en el futuro) en vez de estimarla desde el turno programado.
const HORAS_JORNADA_SIN_SALIDA: f64 = 8.0;

pub struct SqliteStatsRepository {
    db: Arc<Db>,
}

impl SqliteStatsRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

/* =========================================================
   Helpers de introspección y de rango/bucket
========================================================= */

fn bucket_sql_datetime(range: StatsRange, dt_expr: &str) -> String {
    match range {
        StatsRange::Hoy => format!("strftime('%H', {dt})", dt = dt_expr),
        StatsRange::Semana | StatsRange::Mes => format!("strftime('%d/%m', {dt})", dt = dt_expr),
        StatsRange::Anio => format!("strftime('%m/%Y', {dt})", dt = dt_expr),
    }
}

fn range_bounds_sql(range: StatsRange) -> (&'static str, &'static str) {
    match range {
        StatsRange::Hoy => (
            "datetime('now','localtime','start of day')",
            "datetime('now','localtime')",
        ),
        StatsRange::Semana => (
            "datetime('now','localtime','-6 days','start of day')",
            "datetime('now','localtime')",
        ),
        StatsRange::Mes => (
            "datetime('now','localtime','start of month')",
            "datetime('now','localtime')",
        ),
        StatsRange::Anio => (
            "datetime('now','localtime','start of year')",
            "datetime('now','localtime')",
        ),
    }
}

fn range_bounds_sql_reservas(range: StatsRange) -> (&'static str, &'static str) {
    match range {
        StatsRange::Hoy => (
            "datetime('now','localtime','start of day')",
            "datetime('now','localtime','start of day','+1 day')",
        ),
        StatsRange::Semana => (
            "datetime('now','localtime','-6 days','start of day')",
            "datetime('now','localtime','start of day','+1 day')",
        ),
        StatsRange::Mes => (
            "datetime('now','localtime','start of month')",
            "datetime('now','localtime','start of day','+1 day')",
        ),
        StatsRange::Anio => (
            "datetime('now','localtime','start of year')",
            "datetime('now','localtime','start of day','+1 day')",
        ),
    }
}

fn bucket_sql_reservas(range: StatsRange) -> &'static str {
    match range {
        StatsRange::Hoy => "strftime('%H', res_at)",
        StatsRange::Semana | StatsRange::Mes => "strftime('%d/%m', res_at)",
        StatsRange::Anio => "strftime('%m/%Y', res_at)",
    }
}

/// El inicio de hoy. Las estadísticas de productos y de mesas leen del resumen diario
/// (`estadisticas_diarias.rs`) los días del rango anteriores a éste, y de los cobros lo de hoy.
const HOY_SQL: &str = "datetime('now','localtime','start of day')";

/// La sentencia de la estadística de productos: lo vendido en el rango, sin recorrer sus cobros.
///
/// Devuelve dos clases de fila, ya ordenadas por el nombre del catálogo: lo vendido en el rango
/// (`de_venta = 1`, una por clave, con sus unidades) y el catálogo vendible (`de_venta = 0`). El
/// mejor, el peor y los dos top 10 los saca `productos_impl` de ahí sin hacer cuentas: todas las
/// sumas y los redondeos son de SQLite.
///
/// Los días ya cerrados del rango salen de `_Estad_Producto_Dia`, que los tiene sumados por
/// producto, y sólo lo de hoy se lee de los cobros: lo que tarda no crece con el rango ni con el
/// histórico. Antes de leer, `productos_impl` rehace los días sucios; el que se haya ensuciado
/// después (un cobro que ha entrado entre medias) no se lee del resumen sino de los cobros, con la
/// misma sentencia que lo rehace (`dias_sucios`), así que la lectura nunca mezcla un día viejo con
/// lo nuevo. Es una sola sentencia a propósito: con una por lista, cada una volvería a leer lo
/// mismo. La misma sentencia, en el worker: `sqlProductos` de `domains/stats/stats.queries.ts`,
/// donde corre en el SQLite del Durable Object, que atiende a todo el negocio en un solo hilo.
pub(crate) fn sql_productos(range: StatsRange) -> String {
    let (start_expr, end_expr) = range_bounds_sql(range);
    format!(
        r#"
        WITH
        rng AS (SELECT {start} AS start_dt, {hoy} AS hoy_dt, {end} AS end_dt),
        {dias_sucios},
        sucios AS (
{select_producto_dia}
        ),
        paid_det AS (
          -- Las líneas cuyo último cobro es de hoy o posterior, que el resumen no tiene en ningún
          -- día: entran si tienen un cobro dentro del rango, hoy hasta ahora o antes de hoy. Uno
          -- fechado después de ahora (un reloj adelantado) no cuenta, pero tampoco saca del rango a
          -- la línea que tiene otro dentro.
          -- STAT-07: cada línea entra UNA vez. Uniendo Pago_Detalles con Pagos a pelo, una línea
          -- cobrada en dos veces saldría dos veces y sus unidades se contarían dobles.
          -- Sólo pagos ACTIVOS (CUENTA-07): un ticket anulado no es una venta, así que sus
          -- líneas no pueden aparecer en «lo más vendido» ni sumar en el histórico.
          SELECT pd.ID_Detalle AS ID_Detalle
          FROM Pago_Detalles pd
          JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
          JOIN rng ON 1=1
          WHERE p.Estado = 'ACTIVO'
            AND p.Fecha_Hora >= rng.hoy_dt
          GROUP BY pd.ID_Detalle
          HAVING MIN(p.Fecha_Hora) < MIN(rng.end_dt)
            OR EXISTS (
              SELECT 1
              FROM Pago_Detalles pd2
              JOIN Pagos p2 ON p2.ID_Pago = pd2.ID_Pago
              JOIN rng r2 ON 1=1
              WHERE pd2.ID_Detalle = pd.ID_Detalle
                AND +p2.Estado = 'ACTIVO'
                AND p2.Fecha_Hora >= r2.start_dt
                AND p2.Fecha_Hora <  r2.hoy_dt
            )
        ),
        lineas AS (
          -- Los días del rango anteriores a hoy, del resumen: cada fila es lo que sumaron ese día
          -- las líneas de un producto con un mismo nombre, y cada línea está en el día de su último
          -- cobro, así que la que se cobró ayer y otra vez hoy no sale aquí sino abajo. Los sucios,
          -- de los cobros.
          SELECT e.ID_Producto AS ID_Producto, e.Nombre_Producto AS Nombre_Producto, e.Milesimas AS Milesimas
          FROM _Estad_Producto_Dia e
          JOIN rng ON 1=1
          WHERE e.Dia >= date(rng.start_dt)
            AND e.Dia <  date(rng.hoy_dt)
            AND e.Dia NOT IN (SELECT Dia FROM dias)
          UNION ALL
          SELECT ID_Producto, Nombre_Producto, Milesimas FROM sucios
          UNION ALL
          SELECT dc.ID_Producto, dc.Nombre_Producto, CAST(ROUND(COALESCE(dc.Cantidad,1) * 1000) AS INTEGER)
          FROM paid_det cobrada
          JOIN Detalle_Comanda dc ON dc.ID_Detalle = cobrada.ID_Detalle
        ),
        vendido AS (
          -- Se agrupa ANTES de mirar el catálogo: así el catálogo se consulta una vez por clave y
          -- no una por línea. La clave es el producto o, si la línea ya no lo tiene, su nombre.
          -- Una línea sin producto cuyo nombre es justo el ID de un producto comparte clave con las
          -- de ese producto sin ser suya: por eso van tres sumas, la de todas, la de las que tienen
          -- producto y la de las que no. Si hay líneas con producto, su ID es la clave.
          -- nombre_linea es el de la línea que elige SQLite al agrupar, sin MIN ni MAX que se lo
          -- cambien: el que se enseña cuando el producto ya no está en el catálogo. Las cantidades
          -- se suman en milésimas enteras, exactas, y vuelven a unidades al final.
          SELECT
            COALESCE(l.ID_Producto, l.Nombre_Producto) AS clave,
            l.Nombre_Producto AS nombre_linea,
            SUM(l.Milesimas) / 1000.0 AS suma,
            SUM(CASE WHEN l.ID_Producto IS NOT NULL THEN l.Milesimas END) / 1000.0 AS suma_con_producto,
            SUM(CASE WHEN l.ID_Producto IS NULL THEN l.Milesimas END) / 1000.0 AS suma_sin_producto
          FROM lineas l
          GROUP BY COALESCE(l.ID_Producto, l.Nombre_Producto)
        )
        SELECT
          1 AS de_venta,
          clave,
          label,
          nombre,
          id_producto,
          id_categoria,
          CAST(ROUND(general,0) AS INTEGER) AS unidades,
          general > 0 AS con_ventas,
          CAST(ROUND(del_producto,0) AS INTEGER) AS unidades_producto,
          del_producto > 0 AS con_ventas_producto
        FROM (
          -- LEFT JOIN y no JOIN: el catálogo puede borrar un producto que ya no se vende (INV-05),
          -- y su venta del año pasado sigue siendo una venta. Con un INNER, esas líneas
          -- desaparecerían del histórico SIN error, que es la peor forma de perderlas. El nombre
          -- sale del catálogo si el producto sigue ahí (así un renombrado se ve en el informe) y
          -- del snapshot de la línea si ya no está.
          --
          -- Las líneas de un producto de una categoría no vendible no cuentan. «general» es lo que
          -- cuenta la clave en las listas sin filtro de categoría; «del_producto», lo que cuentan
          -- las líneas del producto, que es lo suyo en «los peores» y dentro de su categoría.
          SELECT
            v.clave AS clave,
            CASE WHEN v.suma_con_producto IS NOT NULL AND COALESCE(cat.Vendible,1)=1
                 THEN COALESCE(pr.Nombre, v.nombre_linea, 'Producto')
                 ELSE COALESCE(v.clave, 'Producto')
            END AS label,
            CASE WHEN COALESCE(cat.Vendible,1)=1 THEN pr.Nombre END AS nombre,
            pr.ID_Producto AS id_producto,
            CASE WHEN COALESCE(cat.Vendible,1)=1 THEN pr.ID_Categoria END AS id_categoria,
            CASE WHEN COALESCE(cat.Vendible,1)=1 THEN v.suma ELSE v.suma_sin_producto END AS general,
            CASE WHEN COALESCE(cat.Vendible,1)=1 THEN v.suma_con_producto END AS del_producto
          FROM vendido v
          LEFT JOIN Productos pr ON v.suma_con_producto IS NOT NULL AND pr.ID_Producto = v.clave
          LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
          WHERE COALESCE(cat.Vendible,1)=1 OR v.suma_sin_producto IS NOT NULL
        )
        UNION ALL
        -- El catálogo vendible entero, a cero: el peor producto es justo el que no compra nadie, y
        -- ése no aparece en ninguna línea de comanda. Sus unidades se le ponen al leer el resultado.
        SELECT 0, pr.ID_Producto, pr.Nombre, pr.Nombre, pr.ID_Producto, pr.ID_Categoria, 0, 0, 0, 0
        FROM Productos pr
        JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
        WHERE COALESCE(cat.Vendible,1)=1
        -- El desempate de los cuatro resultados es el nombre del catálogo: se ordena aquí, con el
        -- criterio de SQLite, y al leer el resultado sólo se reordena por unidades, sin deshacerlo.
        -- La clave deja fijo el orden de dos productos con el mismo nombre (uno archivado y el que
        -- lo relevó).
        ORDER BY nombre ASC, clave ASC;
        "#,
        start = start_expr,
        hoy = HOY_SQL,
        end = end_expr,
        dias_sucios = DIAS_SUCIOS_DEL_RANGO,
        select_producto_dia = crate::estadisticas_diarias::SELECT_PRODUCTO_DIA,
    )
}

/// Los días cerrados del rango que el resumen diario tiene por rehacer, como `dias(Dia)` de las
/// sentencias compartidas (`packages/database/estadisticas/`): esos días se leen de los cobros y
/// no del resumen. Va detrás de `rng`. Materializada: si no, SQLite la deshace dentro de la
/// sentencia compartida y recorre los cobros de todos los días sucios, también los de fuera del
/// rango (un histórico recién descargado), antes de mirar el rango.
const DIAS_SUCIOS_DEL_RANGO: &str = "dias AS MATERIALIZED (
          SELECT s.Dia AS Dia
          FROM _Estad_Dias_Sucios s
          JOIN rng ON 1=1
          WHERE s.Dia >= date(rng.start_dt)
            AND s.Dia <  date(rng.hoy_dt)
        )";

/// Los cobros de mesa del rango, por día y mesa (`por_mesa_dia`): la cabecera que comparten las
/// sentencias de la estadística de mesas.
///
/// Los días del rango anteriores a hoy salen de `_Estad_Mesa_Dia` (antes de leer, `mesas_impl`
/// rehace los que estén sucios; el que se ensucie después se lee de los cobros, con la misma
/// sentencia que lo rehace) y lo de hoy, de los cobros hasta ahora. Cada fila trae lo cobrado
/// y tres recuentos de comandas, porque una comanda cobrada en dos días no puede contarse dos
/// veces: `comandas` son las de ese día, `comandas_mes` las que tienen ese día su último cobro del
/// mes y `comandas_rango` las que lo tienen de siempre (ver la tabla en `0001_inicial.sql`). Hoy
/// las tres son lo mismo: es el último día del rango y de su mes. Y va una fila más por mesa, sin
/// importe, con las comandas que el resumen ya no cuenta en su día porque tienen un cobro fechado
/// después de ahora: sólo suman a los dos recuentos de comandas distintas.
///
/// Una devolución de parte de un cobro (`ID_Pago_Origen`) resta de lo cobrado el día que se
/// devuelve, pero no cuenta como comanda: no es un cobro. La venta rápida no tiene mesa.
fn sql_cobros_por_mesa_y_dia(range: StatsRange) -> String {
    let (start_expr, end_expr) = range_bounds_sql(range);
    format!(
        r#"
        WITH
        rng AS (SELECT {start} AS start_dt, {hoy} AS hoy_dt, {end} AS end_dt),
        {dias_sucios},
        sucios AS (
{select_mesa_dia}
        ),
        por_mesa_dia AS (
          SELECT
            e.Dia AS dia,
            e.ID_Mesa AS id_mesa,
            e.Importe AS importe,
            e.Comandas AS comandas,
            e.Comandas_Ultimo_Mes AS comandas_mes,
            e.Comandas_Ultimo AS comandas_rango
          FROM _Estad_Mesa_Dia e
          JOIN rng ON 1=1
          WHERE e.Dia >= date(rng.start_dt)
            AND e.Dia <  date(rng.hoy_dt)
            AND e.Dia NOT IN (SELECT Dia FROM dias)
          UNION ALL
          SELECT Dia, ID_Mesa, Importe, Comandas, Comandas_Ultimo_Mes, Comandas_Ultimo FROM sucios
          UNION ALL
          SELECT
            date(rng.hoy_dt),
            c.ID_Mesa,
            SUM(p.Importe_Total),
            COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END),
            COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END),
            COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END)
          FROM Pagos p
          JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
          JOIN rng ON 1=1
          WHERE p.Fecha_Hora >= rng.hoy_dt
            AND p.Fecha_Hora <  rng.end_dt
            AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
            AND c.ID_Mesa IS NOT NULL
          GROUP BY c.ID_Mesa
          UNION ALL
          -- Las comandas con un cobro dentro del rango antes de hoy, ninguno hoy hasta ahora y otro
          -- fechado después de ahora (un reloj adelantado): el resumen no las cuenta en el que era
          -- su último día, porque ya no lo es, y lo de hoy tampoco. Sólo suman a los recuentos de
          -- comandas distintas: no son un cobro de hoy (sin importe ni comandas del día).
          SELECT
            date(rng.hoy_dt),
            c.ID_Mesa,
            NULL,
            0,
            COUNT(DISTINCT CASE
              WHEN p.Fecha_Hora < datetime(rng.hoy_dt, 'start of month', '+1 month') AND EXISTS (
                SELECT 1 FROM Pagos p2
                WHERE p2.ID_Comanda = p.ID_Comanda
                  AND +p2.Estado = 'ACTIVO'
                  AND p2.ID_Pago_Origen IS NULL
                  AND p2.Fecha_Hora >= MAX(rng.start_dt, datetime(rng.hoy_dt, 'start of month'))
                  AND p2.Fecha_Hora <  rng.hoy_dt
              ) THEN p.ID_Comanda END),
            COUNT(DISTINCT p.ID_Comanda)
          FROM Pagos p
          JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
          JOIN rng ON 1=1
          WHERE p.Fecha_Hora >= rng.end_dt
            AND p.Estado = 'ACTIVO'
            AND p.ID_Pago_Origen IS NULL
            AND c.ID_Mesa IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM Pagos p2
              WHERE p2.ID_Comanda = p.ID_Comanda
                AND +p2.Estado = 'ACTIVO'
                AND p2.ID_Pago_Origen IS NULL
                AND p2.Fecha_Hora >= rng.start_dt
                AND p2.Fecha_Hora <  rng.hoy_dt
            )
            AND NOT EXISTS (
              SELECT 1 FROM Pagos p2
              WHERE p2.ID_Comanda = p.ID_Comanda
                AND +p2.Estado = 'ACTIVO'
                AND p2.ID_Pago_Origen IS NULL
                AND p2.Fecha_Hora >= rng.hoy_dt
                AND p2.Fecha_Hora <  rng.end_dt
            )
          GROUP BY c.ID_Mesa
        )
        "#,
        start = start_expr,
        hoy = HOY_SQL,
        end = end_expr,
        dias_sucios = DIAS_SUCIOS_DEL_RANGO,
        select_mesa_dia = crate::estadisticas_diarias::SELECT_MESA_DIA,
    )
}

/// Las cuatro sentencias de la estadística de mesas: ingresos y mesas servidas (`ocupadas`,
/// `ingresos`), la mesa con más comandas (número, zona, comandas), las comandas de cada tramo de la
/// gráfica (tramo, comandas) y las diez mesas que más han ingresado (número, zona, total).
pub(crate) struct SentenciasMesas {
    pub ingresos: String,
    pub top_comandas: String,
    pub servicios: String,
    pub top_ingresos: String,
}

/// Ingresos y mesas servidas del rango. Una mesa cuenta si tiene algún cobro (no una devolución).
pub(crate) fn sql_mesas_ingresos(range: StatsRange) -> String {
    format!(
        r#"{cobros}
        SELECT
          COUNT(DISTINCT CASE WHEN d.comandas > 0 THEN d.id_mesa END) AS ocupadas,
          COALESCE(SUM(d.importe),0) AS ingresos
        FROM por_mesa_dia d
        JOIN Mesas m ON m.ID_Mesa = d.id_mesa;
        "#,
        cobros = sql_cobros_por_mesa_y_dia(range)
    )
}

/// La mesa con más comandas cobradas en el rango.
pub(crate) fn sql_mesa_top_comandas(range: StatsRange) -> String {
    format!(
        r#"{cobros}
        SELECT
          m.Numero_Mesa,
          z.Nombre_Zona,
          SUM(d.comandas_rango) AS comandas
        FROM por_mesa_dia d
        JOIN Mesas m ON m.ID_Mesa = d.id_mesa
        JOIN Zonas z ON z.ID_Zona = m.ID_Zona
        GROUP BY m.ID_Mesa
        ORDER BY comandas DESC, m.Numero_Mesa ASC, m.ID_Mesa ASC
        LIMIT 1;
        "#,
        cobros = sql_cobros_por_mesa_y_dia(range)
    )
}

/// Las comandas cobradas de cada tramo de la gráfica. Por horas (hoy) se leen de los cobros; por
/// días, del recuento de cada día; por meses, del que cuenta cada comanda una vez en su mes.
pub(crate) fn sql_mesas_servicios(range: StatsRange) -> String {
    let (tramo, recuento) = match range {
        StatsRange::Hoy => {
            let (start_expr, end_expr) = range_bounds_sql(range);
            return format!(
                r#"
                SELECT {bucket} AS b, COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END) AS n
                FROM Pagos p
                JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
                JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
                WHERE p.Fecha_Hora >= {start} AND p.Fecha_Hora < {end}
                  AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
                GROUP BY b
                ORDER BY b ASC;
                "#,
                start = start_expr,
                end = end_expr,
                bucket = bucket_sql_datetime(range, "p.Fecha_Hora")
            );
        }
        StatsRange::Semana | StatsRange::Mes => ("strftime('%d/%m', d.dia)", "d.comandas"),
        StatsRange::Anio => ("strftime('%m/%Y', d.dia)", "d.comandas_mes"),
    };
    // Sólo los tramos con algún cobro. Las filas sin importe son las de las comandas con un cobro
    // fechado después de ahora (`sql_cobros_por_mesa_y_dia`), que no son un cobro de hoy: por días
    // no cuentan, y por meses sólo si suman al mes de hoy, que entonces ya tiene un cobro antes de
    // hoy. Si su cobro de dentro del rango es de un mes anterior, no hacen aparecer el mes de hoy.
    let con_cobros = if matches!(range, StatsRange::Anio) {
        "WHERE d.importe IS NOT NULL OR d.comandas_mes > 0"
    } else {
        "WHERE d.importe IS NOT NULL"
    };
    format!(
        r#"{cobros}
        SELECT {tramo} AS b, SUM({recuento}) AS n
        FROM por_mesa_dia d
        JOIN Mesas m ON m.ID_Mesa = d.id_mesa
        {con_cobros}
        GROUP BY b
        ORDER BY b ASC;
        "#,
        cobros = sql_cobros_por_mesa_y_dia(range)
    )
}

/// Las diez mesas que más han ingresado en el rango. Entre dos con lo mismo, primero la de número
/// menor (y, con el mismo número en dos zonas, la de ID menor).
pub(crate) fn sql_mesas_top_ingresos(range: StatsRange) -> String {
    format!(
        r#"{cobros}
        SELECT
          m.Numero_Mesa,
          z.Nombre_Zona,
          COALESCE(SUM(d.importe),0) AS total
        FROM por_mesa_dia d
        JOIN Mesas m ON m.ID_Mesa = d.id_mesa
        JOIN Zonas z ON z.ID_Zona = m.ID_Zona
        GROUP BY m.ID_Mesa
        ORDER BY total DESC, m.Numero_Mesa ASC, m.ID_Mesa ASC
        LIMIT 10;
        "#,
        cobros = sql_cobros_por_mesa_y_dia(range)
    )
}

/// La sentencia de los clientes recurrentes: quién ha comprado en el rango y si ya había comprado
/// antes de que empezara, que es lo que hace falta mirar en toda la historia y no sólo en el rango.
///
/// El cliente de un cobro es el de su comanda y, si la comanda no tiene, el de su reserva, como en
/// la conciliación (`reconciliacion.rs`): el cobro lo deja en la comanda (RI-61) y cerrar la
/// reserva desengancha la comanda de ella, así que, buscándolo sólo por la reserva, el gasto del
/// cliente desaparecía en cuanto se iba de la mesa (EST-INC-01).
///
/// `allp` (los cobros de comandas de un cliente) va `MATERIALIZED`: la leen tres CTE, y sin esa
/// palabra SQLite la deshace dentro de cada una y recorre tres veces todos los cobros de la
/// historia. Así los recorre una. El resultado es el mismo; igual en el worker (`clientes` de
/// `domains/stats/stats.queries.ts`), donde corre en el SQLite del Durable Object.
pub(crate) fn sql_clientes_recurrentes(range: StatsRange) -> String {
    let (start_expr, end_expr) = range_bounds_sql(range);
    format!(
        r#"
        WITH
        rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
        allp AS MATERIALIZED (
          SELECT
            COALESCE(c.ID_Cliente, r.ID_Cliente) AS id_cliente,
            datetime(p.Fecha_Hora) AS paid_at,
            COALESCE(p.Importe_Total,0) AS imp
          FROM Pagos p
          JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
          LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
          WHERE COALESCE(c.ID_Cliente, r.ID_Cliente) IS NOT NULL
            AND p.Fecha_Hora IS NOT NULL
            AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
        ),
        cust_range AS (
          SELECT DISTINCT id_cliente
          FROM allp, rng
          WHERE paid_at >= rng.start_dt
            AND paid_at <  rng.end_dt
        ),
        firsts AS (
          SELECT id_cliente, MIN(paid_at) AS first_paid
          FROM allp
          GROUP BY id_cliente
        ),
        tot_range AS (
          SELECT id_cliente, SUM(imp) AS total
          FROM allp, rng
          WHERE paid_at >= rng.start_dt
            AND paid_at <  rng.end_dt
          GROUP BY id_cliente
        )
        SELECT
          (SELECT COUNT(*)
           FROM cust_range cr
           JOIN firsts f ON f.id_cliente = cr.id_cliente, rng
           WHERE f.first_paid < rng.start_dt
          ) AS recurrentes,
          (SELECT COUNT(*)
           FROM cust_range cr
           JOIN firsts f ON f.id_cliente = cr.id_cliente, rng
           WHERE f.first_paid >= rng.start_dt
             AND f.first_paid <  rng.end_dt
          ) AS no_recurrentes,
          COALESCE((SELECT SUM(total) FROM tot_range),0) AS ventas_total,
          (SELECT COUNT(*) FROM cust_range) AS clientes_rango
        ;
        "#,
        start = start_expr,
        end = end_expr
    )
}

/// Una fila de `sql_productos`: lo vendido de una clave en el rango, o un producto del catálogo
/// vendible.
struct FilaProducto {
    label: Option<String>,
    /// El producto del catálogo, si la clave es la de uno que sigue ahí.
    id_producto: Option<String>,
    id_categoria: Option<String>,
    /// Lo que cuenta la clave en las listas sin filtro de categoría.
    unidades: i64,
    con_ventas: bool,
    /// Lo que cuentan las líneas del producto: lo suyo en «los peores» y dentro de su categoría.
    unidades_producto: Option<i64>,
    con_ventas_producto: bool,
}

impl FilaProducto {
    /// ¿Entra con este filtro de categoría? Sin filtro entra todo. Un producto que ya no está en el
    /// catálogo no tiene categoría y no entra en ninguna.
    fn es_de(&self, categoria: Option<&str>) -> bool {
        match categoria {
            None => true,
            Some(id) => self.id_categoria.as_deref() == Some(id),
        }
    }
}

/// La categoría por la que se filtra una lista: ninguna si no llega o llega en blanco.
fn categoria_elegida(id: &Option<String>) -> Option<&str> {
    id.as_deref().filter(|id| !id.trim().is_empty())
}

/* =========================================================
   Implementación del puerto
========================================================= */

#[async_trait]
impl StatsRepository for SqliteStatsRepository {
    async fn mesas(&self, range: StatsRange) -> AppResult<MesasStatsResponse> {
        self.mesas_impl(range).await.map_err(AppError::repository)
    }

    async fn list_categorias(&self) -> AppResult<Vec<StatsCategoriaRow>> {
        self.list_categorias_impl()
            .await
            .map_err(AppError::repository)
    }

    async fn productos(&self, args: ProductosStatsArgs) -> AppResult<ProductosStatsResponse> {
        self.productos_impl(args).await.map_err(AppError::repository)
    }

    async fn reservas(&self, args: ReservasStatsArgs) -> AppResult<ReservasStatsResponse> {
        self.reservas_impl(args).await.map_err(AppError::repository)
    }

    async fn trabajadores(
        &self,
        args: TrabajadoresStatsArgs,
    ) -> AppResult<TrabajadoresStatsResponse> {
        self.trabajadores_impl(args)
            .await
            .map_err(AppError::repository)
    }

    async fn clientes(&self, args: ClientesStatsArgs) -> AppResult<ClientesStatsResponse> {
        self.clientes_impl(args).await.map_err(AppError::repository)
    }

    async fn proveedores(
        &self,
        args: ProveedoresStatsArgs,
    ) -> AppResult<ProveedoresStatsResponse> {
        self.proveedores_impl(args)
            .await
            .map_err(AppError::repository)
    }
}

/* =========================================================
   Cuerpos internos (SQL verbatim del antiguo stats.rs)
========================================================= */

impl SqliteStatsRepository {
    async fn mesas_impl(&self, range: StatsRange) -> Result<MesasStatsResponse, String> {
        // Los días cerrados del rango se leen del resumen diario: primero, que esté al día.
        self.resumen_al_dia(range).await?;
        self.mesas_con(SentenciasMesas {
            ingresos: sql_mesas_ingresos(range),
            top_comandas: sql_mesa_top_comandas(range),
            servicios: sql_mesas_servicios(range),
            top_ingresos: sql_mesas_top_ingresos(range),
        })
        .await
    }

    /// La estadística de mesas a partir de sus cuatro sentencias. Los tests de equivalencia le pasan
    /// las de antes del resumen diario, que recorren los cobros.
    async fn mesas_con(&self, sql: SentenciasMesas) -> Result<MesasStatsResponse, String> {
        let g = self.db.read().await;
        let db = &g;

        let mut rows_total = db
            .query(
                r#"
                SELECT COUNT(*)
                FROM Mesas
                WHERE Archivada_En IS NULL; -- RI-54: las mesas que hay hoy en el plano
                "#,
                (),
            )
            .await
            .map_err(|e| e.to_string())?;

        let total_mesas: i64 = match rows_total.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

        // Ingresos y ocupación al nivel de PAGO (fuente de verdad = Pagos, coherente con caja):
        // cada Pago cuenta en su propia Fecha_Hora. Sin exigir comanda 100% pagada ni imputar al
        // último pago (STAT-01/02). Mismo modelo que el worker/Handy (STAT-06). Una devolución de
        // parte de un cobro (`ID_Pago_Origen`) resta de los ingresos el día que se devuelve, pero no
        // cuenta como mesa servida ni como cobro: no lo es. La venta rápida
        // queda fuera del tablero de mesas sin filtro extra: sus comandas no tienen mesa
        // (Canal='BARRA', ID_Mesa NULL). Las cuatro sentencias leen lo mismo: `por_mesa_dia`
        // (`sql_cobros_por_mesa_y_dia`).
        let mut rows_occ = db
            .query(&sql.ingresos, ())
            .await
            .map_err(|e| e.to_string())?;
        let (ocupadas, total_ingresos): (i64, Dinero) =
            match rows_occ.next().await.map_err(|e| e.to_string())? {
                Some(r) => (
                    v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
                    v_dinero(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO),
                ),
                None => (0, Dinero::CERO),
            };

        // Un promedio se divide (`entre`), no se multiplica por el recíproco: 1,47 € entre 98 mesas
        // son 2 céntimos dividiendo y 1 por el otro camino, y el worker divide.
        let ticket_medio_por_mesa: Dinero = if ocupadas > 0 {
            total_ingresos.entre(ocupadas as f64)
        } else {
            Dinero::CERO
        };

        let mut rows_top = db
            .query(&sql.top_comandas, ())
            .await
            .map_err(|e| e.to_string())?;
        let mesa_top_comandas: Option<MesasTopComandas> =
            match rows_top.next().await.map_err(|e| e.to_string())? {
                Some(r) => Some(MesasTopComandas {
                    mesa: v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default(),
                    zona: v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
                    comandas: v_i64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0),
                }),
                None => None,
            };

        let mut rows_serv = db
            .query(&sql.servicios, ())
            .await
            .map_err(|e| e.to_string())?;

        let mut labels: Vec<String> = Vec::new();
        let mut values: Vec<i64> = Vec::new();

        while let Some(r) = rows_serv.next().await.map_err(|e| e.to_string())? {
            let b = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

            labels.push(b);
            values.push(n);
        }

        let servicios = ChartSeriesI64 { labels, values };

        let mut rows_tm = db
            .query(&sql.top_ingresos, ())
            .await
            .map_err(|e| e.to_string())?;
        let mut top_mesas_ingresos: Vec<MesaIngresoRow> = Vec::new();

        while let Some(r) = rows_tm.next().await.map_err(|e| e.to_string())? {
            top_mesas_ingresos.push(MesaIngresoRow {
                mesa: v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default(),
                zona: v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
                total: v_dinero(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO),
            });
        }

        Ok(MesasStatsResponse {
            total_mesas,
            ocupadas,
            ticket_medio_por_mesa,
            mesa_top_comandas,
            servicios,
            top_mesas_ingresos,
        })
    }

    /// Antes de leer del resumen diario los días cerrados de un rango, rehace los que estén sucios
    /// (`estadisticas_diarias::poner_al_dia`). El rango de hoy no lee del resumen.
    async fn resumen_al_dia(&self, range: StatsRange) -> Result<(), String> {
        if matches!(range, StatsRange::Hoy) {
            return Ok(());
        }
        let (inicio, _) = range_bounds_sql(range);
        crate::estadisticas_diarias::poner_al_dia(&self.db, inicio)
            .await
            .map_err(|e| e.to_string())
    }

    async fn list_categorias_impl(&self) -> Result<Vec<StatsCategoriaRow>, String> {
        let g = self.db.read().await;
        let db = &g;

        let mut rows = db
            .query(
                r#"
                SELECT ID_Categoria, Nombre
                FROM Categorias_Producto
                WHERE COALESCE(Vendible,1)=1
                ORDER BY Nombre ASC;
                "#,
                (),
            )
            .await
            .map_err(|e| e.to_string())?;

        let mut out: Vec<StatsCategoriaRow> = Vec::new();

        while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
            out.push(StatsCategoriaRow {
                ID_Categoria: v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default(),
                Nombre: v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            });
        }

        Ok(out)
    }

    async fn productos_impl(
        &self,
        args: ProductosStatsArgs,
    ) -> Result<ProductosStatsResponse, String> {
        // Los días cerrados del rango se leen del resumen diario: primero, que esté al día.
        self.resumen_al_dia(args.range).await?;
        self.productos_con(&sql_productos(args.range), args).await
    }

    /// La estadística de productos a partir de su sentencia (`sql_productos`). Los tests de
    /// equivalencia le pasan la de antes del resumen diario, que recorre los cobros.
    async fn productos_con(
        &self,
        sql: &str,
        args: ProductosStatsArgs,
    ) -> Result<ProductosStatsResponse, String> {
        let g = self.db.read().await;
        let db = &g;

        let mut rows = db
            .query(sql, ())
            .await
            .map_err(|e| e.to_string())?;

        // Lo vendido y el catálogo, cada uno en el orden por nombre que trae la sentencia.
        let mut vendidos: Vec<FilaProducto> = Vec::new();
        let mut catalogo: Vec<FilaProducto> = Vec::new();
        while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
            let de_venta = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0) == 1;
            let fila = FilaProducto {
                label: v_string(r.get_value(2).map_err(|e| e.to_string())?),
                id_producto: v_string(r.get_value(4).map_err(|e| e.to_string())?),
                id_categoria: v_string(r.get_value(5).map_err(|e| e.to_string())?),
                unidades: v_i64(r.get_value(6).map_err(|e| e.to_string())?).unwrap_or(0),
                con_ventas: v_i64(r.get_value(7).map_err(|e| e.to_string())?).unwrap_or(0) == 1,
                unidades_producto: v_i64(r.get_value(8).map_err(|e| e.to_string())?),
                con_ventas_producto: v_i64(r.get_value(9).map_err(|e| e.to_string())?).unwrap_or(0) == 1,
            };
            if de_venta {
                vendidos.push(fila);
            } else {
                catalogo.push(fila);
            }
        }

        // Las unidades de cada producto del catálogo: las de sus líneas. El que no se ha vendido no
        // está y vale 0.
        let unidades_de: HashMap<&str, i64> = vendidos
            .iter()
            .filter_map(|v| Some((v.id_producto.as_deref()?, v.unidades_producto?)))
            .collect();

        // `sort_by_key` es estable: entre dos con las mismas unidades queda el orden por nombre que
        // trae la sentencia. «Los mejores» sólo cuentan lo que se ha vendido (suma > 0, sin
        // redondear). Sin filtro de categoría entra todo lo vendido, por su clave. Con filtro entran
        // las líneas de los productos de esa categoría: un producto que ya no está en el catálogo
        // no tiene categoría y no entra en ninguna.
        let mejores = |categoria: Option<&str>, limite: usize| -> Vec<(Option<String>, i64)> {
            let mut out: Vec<(Option<String>, i64)> = match categoria {
                Some(_) => vendidos
                    .iter()
                    .filter(|f| f.es_de(categoria) && f.con_ventas_producto)
                    .map(|f| (f.label.clone(), f.unidades_producto.unwrap_or(0)))
                    .collect(),
                None => vendidos
                    .iter()
                    .filter(|f| f.con_ventas)
                    .map(|f| (f.label.clone(), f.unidades))
                    .collect(),
            };
            out.sort_by_key(|(_, unidades)| std::cmp::Reverse(*unidades));
            out.truncate(limite);
            out
        };
        // «Los peores» salen del catálogo, con 0 lo que no ha comprado nadie.
        let peores = |categoria: Option<&str>, limite: usize| -> Vec<(Option<String>, i64)> {
            let mut out: Vec<(Option<String>, i64)> = catalogo
                .iter()
                .filter(|f| f.es_de(categoria))
                .map(|f| {
                    let vendidas = f.id_producto.as_deref().and_then(|id| unidades_de.get(id));
                    (f.label.clone(), vendidas.copied().unwrap_or(0))
                })
                .collect();
            out.sort_by_key(|(_, unidades)| *unidades);
            out.truncate(limite);
            out
        };
        let serie = |filas: Vec<(Option<String>, i64)>| ChartSeriesI64 {
            labels: filas.iter().map(|(label, _)| label.clone().unwrap_or_default()).collect(),
            values: filas.iter().map(|(_, unidades)| *unidades).collect(),
        };

        // El mejor y el peor son de toda la carta; las categorías sólo filtran los dos top 10.
        Ok(ProductosStatsResponse {
            mejor_producto: mejores(None, 1).pop().and_then(|(label, _)| label),
            peor_producto_vendible: peores(None, 1).pop().and_then(|(label, _)| label),
            top10_mejores: serie(mejores(categoria_elegida(&args.categoria_top_id), 10)),
            top10_peores: serie(peores(categoria_elegida(&args.categoria_worst_id), 10)),
        })
    }

    async fn reservas_impl(
        &self,
        args: ReservasStatsArgs,
    ) -> Result<ReservasStatsResponse, String> {
        let (start_expr, end_expr) = range_bounds_sql_reservas(args.range);
        let bucket_expr = bucket_sql_reservas(args.range);

        let g = self.db.read().await;
        let db = &g;

        let mut rows_total_mesas = db
            .query(
                r#"
                SELECT COUNT(*)
                FROM Mesas
                WHERE Archivada_En IS NULL; -- RI-54: las mesas que hay hoy en el plano
                "#,
                (),
            )
            .await
            .map_err(|e| e.to_string())?;

        let total_mesas: i64 = match rows_total_mesas.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

        // Todas las reservas cuentan, tengan mesa o no (EST-INC-04): el criterio de la mesa es sólo
        // del reparto de mesas, más abajo.
        let ctes = format!(
            r#"
            WITH
            rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
            res AS (
              SELECT
                r.ID_Reserva,
                r.ID_Mesa,
                r.Turno,
                r.Estado,
                datetime(r.Dia_YMD || ' ' || r.Hora) AS res_at
              FROM Reservas r
            ),
            res_rng AS (
              SELECT res.*
              FROM res, rng
              WHERE res.res_at >= rng.start_dt
                AND res.res_at <  rng.end_dt
            )
            "#,
            start = start_expr,
            end = end_expr
        );

        let sql_total_res = format!(
            r#"
            {ctes}
            SELECT COUNT(*) FROM res_rng;
            "#,
            ctes = ctes
        );

        let mut rows_tr = db
            .query(&sql_total_res, ())
            .await
            .map_err(|e| e.to_string())?;
        let total_reservas: i64 = match rows_tr.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

        let sql_cancel = format!(
            r#"
            {ctes}
            SELECT COUNT(*)
            FROM res_rng
            WHERE COALESCE(Estado,'')='CANCELADA';
            "#,
            ctes = ctes
        );

        let mut rows_c = db.query(&sql_cancel, ()).await.map_err(|e| e.to_string())?;
        let cancelaciones: i64 = match rows_c.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

        // El filtro de turno se aplica SOLO al reparto de mesas. El total, las cancelaciones y las
        // gráficas son de todo el rango: elegir «cena» no cambia el total de reservas del día.
        let turno_filter = match args.turno {
            StatsTurno::Todos => "".to_string(),
            StatsTurno::Comida => "AND rr.Turno='COMIDA'".to_string(),
            StatsTurno::Cena => "AND rr.Turno='CENA'".to_string(),
        };

        // Las mesas reservadas son las del plano de hoy, como `total_mesas`: una reserva sin mesa,
        // o con una que ya se archivó, cuenta como reserva pero no ocupa ninguna de ellas.
        let sql_mesas_res = format!(
            r#"
            {ctes}
            SELECT COUNT(DISTINCT rr.ID_Mesa)
            FROM res_rng rr
            JOIN Mesas m ON m.ID_Mesa = rr.ID_Mesa AND m.Archivada_En IS NULL
            WHERE COALESCE(rr.Estado,'') <> 'CANCELADA'
            {turno_filter};
            "#,
            ctes = ctes,
            turno_filter = turno_filter
        );

        let mut rows_mr = db
            .query(&sql_mesas_res, ())
            .await
            .map_err(|e| e.to_string())?;
        let mesas_reservadas: i64 = match rows_mr.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

        let mut mesas_no_reservadas = total_mesas - mesas_reservadas;

        if mesas_no_reservadas < 0 {
            mesas_no_reservadas = 0;
        }

        let sql_bar = format!(
            r#"
            {ctes}
            SELECT {bucket} AS b, COUNT(*) AS n
            FROM res_rng
            GROUP BY b
            ORDER BY b ASC;
            "#,
            ctes = ctes,
            bucket = bucket_expr
        );

        let mut rows_bar = db.query(&sql_bar, ()).await.map_err(|e| e.to_string())?;

        let mut bar_labels: Vec<String> = Vec::new();
        let mut bar_values: Vec<i64> = Vec::new();

        while let Some(r) = rows_bar.next().await.map_err(|e| e.to_string())? {
            bar_labels
                .push(v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default());
            bar_values.push(v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0));
        }

        let reservas_por_bucket = ChartSeriesI64 {
            labels: bar_labels,
            values: bar_values,
        };

        // Estado y franjas son barras FIJAS, no un GROUP BY: la gráfica tiene siempre las mismas
        // columnas aunque alguna valga cero, y no cambia de forma un día sin cancelaciones.
        let sql_estado = format!(
            r#"
            {ctes}
            SELECT
              SUM(CASE WHEN COALESCE(Estado,'')='PROXIMA' THEN 1 ELSE 0 END) AS proximas,
              SUM(CASE WHEN COALESCE(Estado,'')='ACTIVA' THEN 1 ELSE 0 END) AS activas,
              SUM(CASE WHEN COALESCE(Estado,'')='FINALIZADA' THEN 1 ELSE 0 END) AS finalizadas,
              SUM(CASE WHEN COALESCE(Estado,'')='CANCELADA' THEN 1 ELSE 0 END) AS canceladas,
              SUM(CASE WHEN COALESCE(Estado,'')='NO_SHOW' THEN 1 ELSE 0 END) AS no_vinieron
            FROM res_rng;
            "#,
            ctes = ctes
        );

        let mut rows_es = db.query(&sql_estado, ()).await.map_err(|e| e.to_string())?;
        // Los cinco estados de una reserva: antes sólo tres, y las que estaban por llegar (todas las
        // del futuro) y las de clientes que no vinieron no salían en la gráfica.
        let estado_valores = match rows_es.next().await.map_err(|e| e.to_string())? {
            Some(r) => (0..5)
                .map(|i| Ok(v_i64(r.get_value(i).map_err(|e| e.to_string())?).unwrap_or(0)))
                .collect::<Result<Vec<_>, String>>()?,
            None => vec![0; 5],
        };

        let estado = ChartSeriesI64 {
            labels: ["Por llegar", "En la mesa", "Terminadas", "Canceladas", "No vinieron"]
                .map(String::from)
                .to_vec(),
            values: estado_valores,
        };

        let sql_franjas = format!(
            r#"
            {ctes}
            SELECT
              SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 0  AND 11 THEN 1 ELSE 0 END) AS f_00_11,
              SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 12 AND 15 THEN 1 ELSE 0 END) AS f_12_15,
              SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 16 AND 19 THEN 1 ELSE 0 END) AS f_16_19,
              SUM(CASE WHEN CAST(strftime('%H', res_at) AS INTEGER) BETWEEN 20 AND 23 THEN 1 ELSE 0 END) AS f_20_23
            FROM res_rng;
            "#,
            ctes = ctes
        );

        let mut rows_fr = db
            .query(&sql_franjas, ())
            .await
            .map_err(|e| e.to_string())?;
        let (f1, f2, f3, f4) = match rows_fr.next().await.map_err(|e| e.to_string())? {
            Some(r) => (
                v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
                v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
                v_i64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0),
                v_i64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0),
            ),
            None => (0, 0, 0, 0),
        };

        let franjas = ChartSeriesI64 {
            labels: vec![
                "00-11".into(),
                "12-15".into(),
                "16-19".into(),
                "20-23".into(),
            ],
            values: vec![f1, f2, f3, f4],
        };

        Ok(ReservasStatsResponse {
            total_reservas,
            cancelaciones,
            mesas_turno: ReservasMesasTurno {
                turno: args.turno,
                mesas_reservadas,
                mesas_no_reservadas,
            },
            reservas_por_bucket,
            estado,
            franjas,
        })
    }

    async fn trabajadores_impl(
        &self,
        args: TrabajadoresStatsArgs,
    ) -> Result<TrabajadoresStatsResponse, String> {
        let (start_expr, end_expr) = range_bounds_sql(args.range);
        let g = self.db.read().await;
        let db = &g;

        fn fichaje_dt_sql(col: &str) -> String {
            format!(
                "CASE WHEN f.{c} LIKE '%-%' THEN datetime(f.{c}) ELSE datetime(f.Fecha || ' ' || f.{c}) END",
                c = col
            )
        }

        #[derive(Clone)]
        struct BaseW {
            id_trabajador: String,
            id_usuario: String,
            nombre: String,
            rol: String,
        }

        let mut base: Vec<BaseW> = Vec::new();

        let mut rows_w = db
            .query(
                r#"
                SELECT
                  t.ID_Trabajador,
                  u.ID_Usuario,
                  u.Nombre,
                  u.Apellido,
                  r.Nombre_Rol
                FROM Trabajadores t
                JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
                JOIN Roles r ON r.ID_Rol = u.ID_Rol
                WHERE r.Nombre_Rol IN ('Cocinero','Camarero','Limpieza')
                  AND u.Archivado_En IS NULL -- la plantilla, sin los eliminados
                ORDER BY r.Nombre_Rol ASC, u.Nombre ASC;
                "#,
                (),
            )
            .await
            .map_err(|e| e.to_string())?;

        while let Some(r) = rows_w.next().await.map_err(|e| e.to_string())? {
            let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let id_user = v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();

            if id_trab.is_empty() || id_user.is_empty() {
                continue;
            }

            let nombre = v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();
            let apellido = v_string(r.get_value(3).map_err(|e| e.to_string())?);
            let rol = v_string(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or_default();

            let full = if let Some(ap) = apellido {
                let ap = ap.trim().to_string();

                if ap.is_empty() {
                    nombre.trim().to_string()
                } else {
                    format!("{} {}", nombre.trim(), ap)
                }
            } else {
                nombre.trim().to_string()
            };

            base.push(BaseW {
                id_trabajador: id_trab,
                id_usuario: id_user,
                nombre: full,
                rol,
            });
        }

        if base.is_empty() {
            return Ok(TrabajadoresStatsResponse {
                cocineros: vec![],
                camareros: vec![],
                limpieza: vec![],
                ranking_ventas: ChartSerieDinero {
                    labels: vec![],
                    values: vec![],
                },
            });
        }

        let mut tareas_asig: HashMap<String, i64> = HashMap::new();
        let mut tareas_fin: HashMap<String, i64> = HashMap::new();

        let mut coc_comandas_por_user: HashMap<String, i64> = HashMap::new();

        let mut cam_comandas_tomadas: HashMap<String, i64> = HashMap::new();
        let mut cam_cobros: HashMap<String, i64> = HashMap::new();
        let mut cam_ticket_medio: HashMap<String, Dinero> = HashMap::new();
        let mut cam_ventas_total: HashMap<String, Dinero> = HashMap::new();

        let mut puntualidad_map: HashMap<String, PuntualidadInfo> = HashMap::new();
        let mut horas_map: HashMap<String, f64> = HashMap::new();

        let sql_tareas = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              ID_Trabajador,
              SUM(CASE
                    WHEN datetime(Asignada_At) >= (SELECT start_dt FROM rng)
                     AND datetime(Asignada_At) <  (SELECT end_dt   FROM rng)
                    THEN 1 ELSE 0 END
              ) AS asignadas,
              SUM(CASE
                    WHEN COALESCE(Estado,'')='FINALIZADA'
                     AND Finalizada_At IS NOT NULL
                     AND datetime(Finalizada_At) >= (SELECT start_dt FROM rng)
                     AND datetime(Finalizada_At) <  (SELECT end_dt   FROM rng)
                    THEN 1 ELSE 0 END
              ) AS finalizadas
            FROM Tarea_Asignaciones
            GROUP BY ID_Trabajador;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_t = db.query(&sql_tareas, ()).await.map_err(|e| e.to_string())?;

        while let Some(r) = rows_t.next().await.map_err(|e| e.to_string())? {
            let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();

            if id_trab.is_empty() {
                continue;
            }

            let a = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);
            let f = v_i64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0);

            tareas_asig.insert(id_trab.clone(), a);
            tareas_fin.insert(id_trab, f);
        }

        let sql_coc = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              ID_Usuario_Cocinero,
              COUNT(DISTINCT ID_Comanda) AS n
            FROM Detalle_Comanda
            WHERE ID_Usuario_Cocinero IS NOT NULL
              AND Fecha_Hora_Cocina IS NOT NULL
              AND datetime(Fecha_Hora_Cocina) >= (SELECT start_dt FROM rng)
              AND datetime(Fecha_Hora_Cocina) <  (SELECT end_dt   FROM rng)
            GROUP BY ID_Usuario_Cocinero;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_c = db.query(&sql_coc, ()).await.map_err(|e| e.to_string())?;

        while let Some(r) = rows_c.next().await.map_err(|e| e.to_string())? {
            let id_user = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

            if !id_user.is_empty() {
                coc_comandas_por_user.insert(id_user, n);
            }
        }

        let sql_cam_com = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              ID_Trabajador,
              COUNT(*) AS n
            FROM Comandas
            WHERE ID_Trabajador IS NOT NULL
              AND Fecha_Hora_Apertura >= (SELECT start_dt FROM rng)
              AND Fecha_Hora_Apertura <  (SELECT end_dt   FROM rng)
            GROUP BY ID_Trabajador;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_cc = db
            .query(&sql_cam_com, ())
            .await
            .map_err(|e| e.to_string())?;

        while let Some(r) = rows_cc.next().await.map_err(|e| e.to_string())? {
            let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

            if !id_trab.is_empty() {
                cam_comandas_tomadas.insert(id_trab, n);
            }
        }

        let sql_cobros = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              p.ID_Trabajador_Cobrador AS ID_Trabajador,
              COUNT(*) AS n
            FROM Pagos p
            JOIN rng ON 1=1
            JOIN Trabajadores t ON t.ID_Trabajador = p.ID_Trabajador_Cobrador
            JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
            JOIN Roles r ON r.ID_Rol = u.ID_Rol
            WHERE p.Fecha_Hora >= rng.start_dt
              AND p.Fecha_Hora <  rng.end_dt
              AND p.Estado = 'ACTIVO'
              AND p.ID_Trabajador_Cobrador IS NOT NULL
              AND p.ID_Pago_Origen IS NULL
              AND r.Nombre_Rol = 'Camarero'
            GROUP BY p.ID_Trabajador_Cobrador;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_p = db.query(&sql_cobros, ()).await.map_err(|e| e.to_string())?;

        while let Some(r) = rows_p.next().await.map_err(|e| e.to_string())? {
            let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

            if !id_trab.is_empty() {
                cam_cobros.insert(id_trab, n);
            }
        }

        // Ventas y ticket medio: se agrupa PRIMERO por comanda y luego se promedia. Promediando los
        // pagos sueltos, una mesa cobrada en tres veces hundiría la media del camarero.
        let sql_sales = format!(
            r#"
            WITH
            rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
            pagos_rng AS (
              SELECT ID_Comanda, COALESCE(Importe_Total,0) AS imp
              FROM Pagos, rng
              WHERE Fecha_Hora >= rng.start_dt
                AND Fecha_Hora <  rng.end_dt
                AND Estado = 'ACTIVO'
            ),
            comanda_trab AS (
              SELECT ID_Comanda, ID_Trabajador
              FROM Comandas
              WHERE ID_Trabajador IS NOT NULL
            ),
            comanda_tot AS (
              SELECT
                c.ID_Trabajador AS id_trabajador,
                p.ID_Comanda    AS id_comanda,
                SUM(p.imp)      AS total
              FROM pagos_rng p
              JOIN comanda_trab c ON c.ID_Comanda = p.ID_Comanda
              GROUP BY c.ID_Trabajador, p.ID_Comanda
            )
            SELECT
              id_trabajador,
              COALESCE(SUM(total),0) AS ventas_total,
              CAST(ROUND(COALESCE(AVG(total),0)) AS INTEGER) AS ticket_medio
            FROM comanda_tot
            GROUP BY id_trabajador;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_s = db.query(&sql_sales, ()).await.map_err(|e| e.to_string())?;

        while let Some(r) = rows_s.next().await.map_err(|e| e.to_string())? {
            let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let ventas = v_dinero(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO);
            let ticket = v_dinero(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO);

            if !id_trab.is_empty() {
                cam_ventas_total.insert(id_trab.clone(), ventas);
                cam_ticket_medio.insert(id_trab, ticket);
            }
        }

        // Horas trabajadas: se suman todos los tramos (Fichajes) del rango. Los turnos partidos
        // se modelan como filas separadas (columna `Parte`), no con columnas Hora_Entrada_2, así
        // que basta con SUM sobre las filas por trabajador.
        {
            let ent1_dt = fichaje_dt_sql("Hora_Entrada");
            let sal1_dt = fichaje_dt_sql("Hora_Salida");

            let sql_horas = format!(
                r#"
                WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
                SELECT
                  t.ID_Trabajador,
                  ROUND(COALESCE(SUM(
                    CASE
                      WHEN f.Hora_Entrada IS NOT NULL AND f.Hora_Salida IS NOT NULL
                       AND {ent1_dt} >= rng.start_dt
                       AND {ent1_dt} <  rng.end_dt
                      THEN max(0, (julianday({sal1_dt}) - julianday({ent1_dt})) * 24.0)
                      -- STAT-03: jornada auto-cerrada por olvido de fichar la salida (TRAB-01):
                      -- se imputa una jornada estándar fija en vez de 0. La jornada EN CURSO del
                      -- día (Estado 'ABIERTO', Cerrado_Automatico=0) NO entra aquí: cuenta cuando
                      -- se ficha la salida real.
                      WHEN f.Hora_Entrada IS NOT NULL AND f.Hora_Salida IS NULL
                       AND f.Cerrado_Automatico = 1
                       AND {ent1_dt} >= rng.start_dt
                       AND {ent1_dt} <  rng.end_dt
                      THEN {horas_sin_salida}
                      ELSE 0
                    END
                  ),0),2) AS horas
                FROM Trabajadores t
                JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
                LEFT JOIN Fichajes f ON f.ID_Usuario = u.ID_Usuario
                JOIN rng ON 1=1
                GROUP BY t.ID_Trabajador;
                "#,
                start = start_expr,
                end = end_expr,
                ent1_dt = ent1_dt,
                sal1_dt = sal1_dt,
                horas_sin_salida = HORAS_JORNADA_SIN_SALIDA
            );

            let mut rows_h = db.query(&sql_horas, ()).await.map_err(|e| e.to_string())?;

            while let Some(r) = rows_h.next().await.map_err(|e| e.to_string())? {
                let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
                let horas = v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);

                if !id_trab.is_empty() {
                    horas_map.insert(id_trab, (horas * 100.0).round() / 100.0);
                }
            }
        }

        let sql_puntual = format!(
            r#"
            WITH
            rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
            asig AS (
              SELECT
                a.ID_Trabajador,
                t.ID_Usuario,
                a.Fecha,
                a.Hora_Inicio,
                datetime(a.Fecha || ' ' || a.Hora_Inicio) AS prog_dt
              FROM Asignacion_Turnos a
              JOIN Trabajadores t ON t.ID_Trabajador = a.ID_Trabajador
              WHERE a.Hora_Inicio IS NOT NULL
                AND datetime(a.Fecha || ' ' || a.Hora_Inicio) >= (SELECT start_dt FROM rng)
                AND datetime(a.Fecha || ' ' || a.Hora_Inicio) <  (SELECT end_dt   FROM rng)
            ),
            fich AS (
              SELECT
                ID_Usuario,
                Fecha,
                MIN(datetime(Fecha || ' ' || Hora_Entrada)) AS ent_dt
              FROM Fichajes
              WHERE Hora_Entrada IS NOT NULL
              GROUP BY ID_Usuario, Fecha
            ),
            joined AS (
              SELECT
                a.ID_Trabajador,
                a.Fecha,
                a.prog_dt,
                f.ent_dt
              FROM asig a
              JOIN fich f ON f.ID_Usuario = a.ID_Usuario AND f.Fecha = a.Fecha
            ),
            ranked AS (
              SELECT
                ID_Trabajador,
                prog_dt,
                ent_dt,
                ROW_NUMBER() OVER (
                  PARTITION BY ID_Trabajador
                  ORDER BY date(Fecha) DESC, prog_dt ASC
                ) AS rn
              FROM joined
            )
            SELECT
              ID_Trabajador,
              strftime('%H:%M', prog_dt) AS programado,
              strftime('%H:%M', ent_dt)  AS entrada,
              CASE WHEN ent_dt <= prog_dt THEN 1 ELSE 0 END AS puntual,
              CAST(
                MAX(
                  0,
                  ROUND((julianday(ent_dt) - julianday(prog_dt)) * 24 * 60, 0)
                ) AS INTEGER
              ) AS minutos_retraso
            FROM ranked
            WHERE rn = 1;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_pt = db
            .query(&sql_puntual, ())
            .await
            .map_err(|e| e.to_string())?;

        while let Some(r) = rows_pt.next().await.map_err(|e| e.to_string())? {
            let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();

            if id_trab.is_empty() {
                continue;
            }

            let programado =
                v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();
            let entrada = v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();
            let puntual_i = v_i64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0);
            let mins = v_i64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0);

            puntualidad_map.insert(
                id_trab,
                PuntualidadInfo {
                    puntual: puntual_i == 1,
                    programado,
                    entrada,
                    minutos_retraso: if mins < 0 { 0 } else { mins },
                },
            );
        }

        let mut cocineros: Vec<TrabajadorCardStats> = vec![];
        let mut camareros: Vec<TrabajadorCardStats> = vec![];
        let mut limpieza: Vec<TrabajadorCardStats> = vec![];

        for w in base.iter() {
            let asig = *tareas_asig.get(&w.id_trabajador).unwrap_or(&0);
            let fin = *tareas_fin.get(&w.id_trabajador).unwrap_or(&0);

            let puntualidad = puntualidad_map.get(&w.id_trabajador).cloned();
            let horas = *horas_map.get(&w.id_trabajador).unwrap_or(&0.0);

            if w.rol == "Cocinero" {
                let comandas = *coc_comandas_por_user.get(&w.id_usuario).unwrap_or(&0);

                cocineros.push(TrabajadorCardStats {
                    id_trabajador: w.id_trabajador.clone(),
                    nombre: w.nombre.clone(),
                    rol: "Cocinero".into(),
                    tareas_asignadas: asig,
                    tareas_finalizadas: fin,
                    puntualidad,
                    horas_trabajadas: horas,
                    comandas_preparadas: Some(comandas),
                    comandas_tomadas: None,
                    cobros_realizados: None,
                    ticket_medio: None,
                });
            } else if w.rol == "Camarero" {
                let comandas = *cam_comandas_tomadas.get(&w.id_trabajador).unwrap_or(&0);
                let cobros = *cam_cobros.get(&w.id_trabajador).unwrap_or(&0);
                let ticket = *cam_ticket_medio.get(&w.id_trabajador).unwrap_or(&Dinero::CERO);

                camareros.push(TrabajadorCardStats {
                    id_trabajador: w.id_trabajador.clone(),
                    nombre: w.nombre.clone(),
                    rol: "Camarero".into(),
                    tareas_asignadas: asig,
                    tareas_finalizadas: fin,
                    puntualidad,
                    horas_trabajadas: horas,
                    comandas_preparadas: None,
                    comandas_tomadas: Some(comandas),
                    cobros_realizados: Some(cobros),
                    ticket_medio: Some(ticket),
                });
            } else {
                limpieza.push(TrabajadorCardStats {
                    id_trabajador: w.id_trabajador.clone(),
                    nombre: w.nombre.clone(),
                    rol: "Limpieza".into(),
                    tareas_asignadas: asig,
                    tareas_finalizadas: fin,
                    puntualidad,
                    horas_trabajadas: horas,
                    comandas_preparadas: None,
                    comandas_tomadas: None,
                    cobros_realizados: None,
                    ticket_medio: None,
                });
            }
        }

        let mut ranking_pairs: Vec<(String, Dinero)> = Vec::new();

        for w in base.iter() {
            if w.rol != "Camarero" {
                continue;
            }

            let ventas = *cam_ventas_total.get(&w.id_trabajador).unwrap_or(&Dinero::CERO);
            ranking_pairs.push((w.nombre.clone(), ventas));
        }

        ranking_pairs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut rank_labels: Vec<String> = Vec::new();
        let mut rank_values: Vec<Dinero> = Vec::new();

        for (n, v) in ranking_pairs.into_iter() {
            rank_labels.push(n);
            rank_values.push(v);
        }

        Ok(TrabajadoresStatsResponse {
            cocineros,
            camareros,
            limpieza,
            ranking_ventas: ChartSerieDinero {
                labels: rank_labels,
                values: rank_values,
            },
        })
    }

    async fn clientes_impl(
        &self,
        args: ClientesStatsArgs,
    ) -> Result<ClientesStatsResponse, String> {
        let (start_expr, end_expr) = range_bounds_sql(args.range);
        let g = self.db.read().await;
        let db = &g;

        let nuevos: i64;
        let mut evo_labels: Vec<String> = vec![];
        let mut evo_values: Vec<i64> = vec![];

        {
            let alta_dt = "datetime(cl.Created_At)";
            let bucket_expr = bucket_sql_datetime(args.range, alta_dt);

            let sql_nuevos = format!(
                r#"
                WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
                SELECT COUNT(*)
                FROM Clientes cl, rng
                WHERE cl.Created_At IS NOT NULL
                  AND {alta_dt} >= rng.start_dt
                  AND {alta_dt} <  rng.end_dt;
                "#,
                start = start_expr,
                end = end_expr,
                alta_dt = alta_dt
            );

            let mut rows_n = db.query(&sql_nuevos, ()).await.map_err(|e| e.to_string())?;

            nuevos = match rows_n.next().await.map_err(|e| e.to_string())? {
                Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
                None => 0,
            };

            let sql_evo = format!(
                r#"
                WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
                SELECT {bucket} AS b, COUNT(*) AS n
                FROM Clientes cl, rng
                WHERE cl.Created_At IS NOT NULL
                  AND {alta_dt} >= rng.start_dt
                  AND {alta_dt} <  rng.end_dt
                GROUP BY b
                ORDER BY b ASC;
                "#,
                start = start_expr,
                end = end_expr,
                alta_dt = alta_dt,
                bucket = bucket_expr
            );

            let mut rows_e = db.query(&sql_evo, ()).await.map_err(|e| e.to_string())?;

            while let Some(r) = rows_e.next().await.map_err(|e| e.to_string())? {
                let b = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
                let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

                evo_labels.push(b);
                evo_values.push(n);
            }
        }

        let mut recurrentes: i64 = 0;
        let mut no_recurrentes: i64 = 0;
        let ticket_medio_cliente: Dinero;

        {
            let sql_rec = sql_clientes_recurrentes(args.range);

            let mut rows_r = db.query(&sql_rec, ()).await.map_err(|e| e.to_string())?;

            let mut ventas_total: Dinero = Dinero::CERO;
            let mut clientes_rango: i64 = 0;

            if let Some(r) = rows_r.next().await.map_err(|e| e.to_string())? {
                recurrentes = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
                no_recurrentes = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);
                ventas_total = v_dinero(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO);
                clientes_rango = v_i64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0);
            }

            // Un promedio de importes sigue siendo fraccionario: vuelve a céntimo entero de una
            // sola vez, dividiendo (`entre`) como el worker y no por el recíproco.
            ticket_medio_cliente = if clientes_rango > 0 {
                ventas_total.entre(clientes_rango as f64)
            } else {
                Dinero::CERO
            };
        }

        let mut top_labels: Vec<String> = vec![];
        let mut top_values: Vec<Dinero> = vec![];

        {
            let name_expr =
                "CASE WHEN COALESCE(trim(Nombre),'') <> '' THEN trim(Nombre) ELSE 'Cliente' END";

            let sql_top = format!(
                r#"
                SELECT
                  ({name_expr} || ' #' || CAST(ID_Cliente AS TEXT)) AS nombre,
                  COALESCE(Total_Gastado,0) AS total
                FROM Clientes
                ORDER BY COALESCE(Total_Gastado,0) DESC, nombre ASC
                LIMIT 10;
                "#,
                name_expr = name_expr
            );

            let mut rows_t = db.query(&sql_top, ()).await.map_err(|e| e.to_string())?;

            while let Some(r) = rows_t.next().await.map_err(|e| e.to_string())? {
                let name = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
                let total = v_dinero(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO);

                top_labels.push(name);
                top_values.push(total);
            }
        }

        Ok(ClientesStatsResponse {
            nuevos,
            recurrentes,
            no_recurrentes,
            ticket_medio_cliente,
            nuevos_por_bucket: ChartSeriesI64 {
                labels: evo_labels,
                values: evo_values,
            },
            top_clientes_gasto: ChartSerieDinero {
                labels: top_labels,
                values: top_values,
            },
        })
    }

    async fn proveedores_impl(
        &self,
        args: ProveedoresStatsArgs,
    ) -> Result<ProveedoresStatsResponse, String> {
        let (start_expr, end_expr) = range_bounds_sql(args.range);
        let g = self.db.read().await;
        let db = &g;

        // Esquema fijo por migraciones: Cuentas_Gastos siempre tiene Fecha, Importe, ID_Proveedor,
        // Tipo_Gasto y Concepto, y existe la tabla Proveedores. Un gasto es "de proveedor" si tiene
        // ID_Proveedor o su Tipo_Gasto lo indica.
        let dt_expr = "CASE WHEN cg.Fecha LIKE '%:%' THEN datetime(cg.Fecha) ELSE datetime(cg.Fecha || ' 00:00:00') END";
        let bucket_expr = bucket_sql_datetime(args.range, dt_expr);

        let supplier_filter =
            "AND (cg.ID_Proveedor IS NOT NULL OR lower(cg.Tipo_Gasto) LIKE '%proveedor%')";

        let sql_total_all = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT COALESCE(SUM(COALESCE(cg.Importe,0)),0) AS total
            FROM Cuentas_Gastos cg, rng
            WHERE cg.Fecha IS NOT NULL
              AND {dt} >= rng.start_dt
              AND {dt} <  rng.end_dt;
            "#,
            start = start_expr,
            end = end_expr,
            dt = dt_expr
        );

        let mut rows_all = db
            .query(&sql_total_all, ())
            .await
            .map_err(|e| e.to_string())?;
        let total_all: Dinero = match rows_all.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_dinero(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO),
            None => Dinero::CERO,
        };

        let sql_total = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              COALESCE(SUM(COALESCE(cg.Importe,0)),0) AS total,
              COUNT(*) AS n
            FROM Cuentas_Gastos cg, rng
            WHERE cg.Fecha IS NOT NULL
              AND {dt} >= rng.start_dt
              AND {dt} <  rng.end_dt
              {filter};
            "#,
            start = start_expr,
            end = end_expr,
            dt = dt_expr,
            filter = supplier_filter
        );

        let mut rows_t = db.query(&sql_total, ()).await.map_err(|e| e.to_string())?;
        let (total_gasto, num_gastos) = match rows_t.next().await.map_err(|e| e.to_string())? {
            Some(r) => (
                v_dinero(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO),
                v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            ),
            None => (Dinero::CERO, 0),
        };

        // Dividiendo (`entre`), como el worker: por el recíproco, 1,47 € entre 98 gastos dan 1
        // céntimo y no 2.
        let gasto_medio = if num_gastos > 0 {
            total_gasto.entre(num_gastos as f64)
        } else {
            Dinero::CERO
        };

        // Un PORCENTAJE no es dinero: es la razon entre dos importes, y se calcula sobre sus
        // centimos para no perder precision dividiendo euros.
        let porcentaje_sobre_total_gastos = if !total_all.es_cero() {
            ((total_gasto.centimos() as f64 / total_all.centimos() as f64) * 100.0 * 100.0).round()
                / 100.0
        } else {
            0.0
        };

        let name_expr = r#"
            CASE
              WHEN cg.ID_Proveedor IS NOT NULL THEN
                COALESCE(NULLIF(trim(p.Nombre_Empresa),''), ('Proveedor #' || CAST(cg.ID_Proveedor AS TEXT)))
              ELSE 'Sin proveedor'
            END
            "#;

        let join_prov = "LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor";

        let sql_top = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              {name_expr} AS proveedor,
              COALESCE(SUM(COALESCE(cg.Importe,0)),0) AS total
            FROM Cuentas_Gastos cg
            {join_prov}
            , rng
            WHERE cg.Fecha IS NOT NULL
              AND {dt} >= rng.start_dt
              AND {dt} <  rng.end_dt
              {filter}
            GROUP BY proveedor
            ORDER BY total DESC, proveedor ASC
            LIMIT 1;
            "#,
            start = start_expr,
            end = end_expr,
            name_expr = name_expr,
            join_prov = join_prov,
            dt = dt_expr,
            filter = supplier_filter
        );

        let mut rows_top = db.query(&sql_top, ()).await.map_err(|e| e.to_string())?;
        let proveedor_top: Option<ProveedorTop> =
            match rows_top.next().await.map_err(|e| e.to_string())? {
                Some(r) => Some(ProveedorTop {
                    nombre: v_string(r.get_value(0).map_err(|e| e.to_string())?)
                        .unwrap_or_default(),
                    total: v_dinero(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO),
                }),
                None => None,
            };

        let sql_evo = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              {bucket} AS b,
              COALESCE(SUM(COALESCE(cg.Importe,0)),0) AS total
            FROM Cuentas_Gastos cg, rng
            WHERE cg.Fecha IS NOT NULL
              AND {dt} >= rng.start_dt
              AND {dt} <  rng.end_dt
              {filter}
            GROUP BY b
            ORDER BY b ASC;
            "#,
            start = start_expr,
            end = end_expr,
            bucket = bucket_expr,
            dt = dt_expr,
            filter = supplier_filter
        );

        let mut rows_e = db.query(&sql_evo, ()).await.map_err(|e| e.to_string())?;

        let mut evo_labels: Vec<String> = vec![];
        let mut evo_values: Vec<Dinero> = vec![];

        while let Some(r) = rows_e.next().await.map_err(|e| e.to_string())? {
            evo_labels
                .push(v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default());
            evo_values
                .push(v_dinero(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO));
        }

        let sql_bar = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              {name_expr} AS proveedor,
              COALESCE(SUM(COALESCE(cg.Importe,0)),0) AS total
            FROM Cuentas_Gastos cg
            {join_prov}
            , rng
            WHERE cg.Fecha IS NOT NULL
              AND {dt} >= rng.start_dt
              AND {dt} <  rng.end_dt
              {filter}
            GROUP BY proveedor
            ORDER BY total DESC, proveedor ASC
            LIMIT 12;
            "#,
            start = start_expr,
            end = end_expr,
            name_expr = name_expr,
            join_prov = join_prov,
            dt = dt_expr,
            filter = supplier_filter
        );

        let mut rows_b = db.query(&sql_bar, ()).await.map_err(|e| e.to_string())?;

        let mut bar_labels: Vec<String> = vec![];
        let mut bar_values: Vec<Dinero> = vec![];

        while let Some(r) = rows_b.next().await.map_err(|e| e.to_string())? {
            bar_labels
                .push(v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default());
            bar_values
                .push(v_dinero(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO));
        }

        let concepto_expr = "COALESCE(cg.Concepto,'')";

        let sql_last = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              strftime('%Y-%m-%d', {dt}) AS fecha,
              {name_expr} AS proveedor,
              {concepto_expr} AS concepto,
              COALESCE(cg.Importe,0) AS importe
            FROM Cuentas_Gastos cg
            {join_prov}
            , rng
            WHERE cg.Fecha IS NOT NULL
              AND {dt} >= rng.start_dt
              AND {dt} <  rng.end_dt
              {filter}
            ORDER BY datetime({dt}) DESC
            LIMIT 10;
            "#,
            start = start_expr,
            end = end_expr,
            dt = dt_expr,
            name_expr = name_expr,
            concepto_expr = concepto_expr,
            join_prov = join_prov,
            filter = supplier_filter
        );

        let mut rows_last = db.query(&sql_last, ()).await.map_err(|e| e.to_string())?;
        let mut ultimos_gastos: Vec<UltimoGastoProveedor> = vec![];

        while let Some(r) = rows_last.next().await.map_err(|e| e.to_string())? {
            let fecha = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let proveedor =
                v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_else(|| "—".into());
            let concepto = v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();
            let importe = v_dinero(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO);

            ultimos_gastos.push(UltimoGastoProveedor {
                fecha,
                proveedor,
                concepto,
                importe,
            });
        }

        Ok(ProveedoresStatsResponse {
            total_gasto,
            num_gastos,
            gasto_medio,
            porcentaje_sobre_total_gastos,
            proveedor_top,
            gastos_evolucion: ChartSerieDinero {
                labels: evo_labels,
                values: evo_values,
            },
            gasto_por_proveedor: ChartSerieDinero {
                labels: bar_labels,
                values: bar_values,
            },
            ultimos_gastos,
        })
    }
}

#[cfg(test)]
mod tests_productos_en_una_pasada {
    //! La estadística de productos se calcula en una pasada (`sql_productos`) y tiene que dar
    //! EXACTAMENTE lo que daban las cuatro sentencias de antes, que se conservan aquí como
    //! referencia: mismo mejor, mismo peor y los mismos top 10, en el mismo orden.
    //!
    //! La siembra es la del caso de contrato `stats/productos_vendidos`, que lleva lo que puede
    //! torcer el resultado (empates, archivados, una categoría no vendible, cobros anulados y
    //! partidos, productos borrados del catálogo, decimales) y ventas de otros días, para que la
    //! semana, el mes y el año no sean lo mismo que hoy. Y la del caso
    //! `stats/productos_nombre_que_es_un_id`: una línea sin producto cuyo nombre es el ID de un
    //! producto, que comparte clave con las de ese producto sin ser suya. El worker hace la misma
    //! comparación con su propia copia (`test/statsProductosUnaPasada.test.ts`), y el arnés de
    //! lectura fija que los dos lados dan lo mismo.

    use super::*;
    use crate::contract_comun::{contract_dir, db_temporal, sembrar};
    use crate::ejecutor::Value;

    impl SqliteStatsRepository {
        /// Las cuatro sentencias de antes, tal cual estaban.
        async fn productos_antes(
            &self,
            args: ProductosStatsArgs,
        ) -> Result<ProductosStatsResponse, String> {
            let (start_expr, end_expr) = range_bounds_sql(args.range);
            let g = self.db.read().await;
            let db = &g;

            let ctes = format!(
                r#"
                WITH
                rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
                paid_det AS (
                  -- Sólo pagos ACTIVOS (CUENTA-07): un ticket anulado no es una venta, así que sus
                  -- líneas no pueden aparecer en «lo más vendido» ni sumar en el histórico.
                  -- El rango va AQUÍ y no fuera (RI-18): fuera, la CTE agrupaba todos los cobros de la
                  -- historia antes de filtrar. Lo de fuera de rango ya no contaba (las consultas de «el
                  -- peor» lo ponían a 0 con su CASE), así que el resultado es el mismo.
                  SELECT pd.ID_Detalle AS ID_Detalle, MIN(p.Fecha_Hora) AS paid_at
                  FROM Pago_Detalles pd
                  JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
                  JOIN rng ON 1=1
                  WHERE p.Estado = 'ACTIVO'
                    AND p.Fecha_Hora >= rng.start_dt
                    AND p.Fecha_Hora <  rng.end_dt
                  GROUP BY pd.ID_Detalle
                )
                "#,
                start = start_expr,
                end = end_expr
            );

            let sql_best = format!(
                r#"
                {ctes}
                -- LEFT JOIN y no JOIN: el catálogo puede borrar un producto que ya no se vende
                -- (INV-05), y su venta del año pasado sigue siendo una venta. Con un INNER, esas
                -- líneas desaparecerían del histórico SIN error, que es la peor forma de perderlas.
                -- El nombre sale del catálogo si el producto sigue ahí (así un renombrado se ve en el
                -- informe) y del snapshot de la línea si ya no está.
                SELECT
                  COALESCE(pr.Nombre, dc.Nombre_Producto, 'Producto') AS Nombre,
                  CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS unidades
                FROM Detalle_Comanda dc
                JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
                JOIN rng ON 1=1
                LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
                LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
                WHERE pd.paid_at >= rng.start_dt
                  AND pd.paid_at <  rng.end_dt
                  AND COALESCE(cat.Vendible,1)=1
                GROUP BY COALESCE(dc.ID_Producto, dc.Nombre_Producto)
                HAVING SUM(COALESCE(dc.Cantidad,1)) > 0
                ORDER BY unidades DESC, pr.Nombre ASC
                LIMIT 1;
                "#,
                ctes = ctes
            );

            let mut rows_best = db.query(&sql_best, ()).await.map_err(|e| e.to_string())?;
            let mejor_producto: Option<String> =
                match rows_best.next().await.map_err(|e| e.to_string())? {
                    Some(r) => v_string(r.get_value(0).map_err(|e| e.to_string())?),
                    None => None,
                };

            // El PEOR parte del CATÁLOGO, no de lo vendido: el producto que no compra nadie no aparece
            // en ninguna línea de comanda, así que se sale de `Productos` y las ventas entran por
            // LEFT JOIN, contando 0 cuando no las hay.
            let sql_worst_one = format!(
                r#"
                {ctes}
                SELECT
                  pr.Nombre,
                  CAST(ROUND(COALESCE(SUM(
                    CASE WHEN pd.paid_at >= rng.start_dt AND pd.paid_at < rng.end_dt
                         THEN COALESCE(dc.Cantidad,1)
                         ELSE 0
                    END
                  ),0),0) AS INTEGER) AS unidades
                FROM Productos pr
                JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
                LEFT JOIN Detalle_Comanda dc ON dc.ID_Producto = pr.ID_Producto
                LEFT JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
                JOIN rng ON 1=1
                WHERE COALESCE(cat.Vendible,1)=1
                GROUP BY pr.ID_Producto
                ORDER BY unidades ASC, pr.Nombre ASC
                LIMIT 1;
                "#,
                ctes = ctes
            );

            let mut rows_w1 = db
                .query(&sql_worst_one, ())
                .await
                .map_err(|e| e.to_string())?;
            let peor_producto_vendible: Option<String> =
                match rows_w1.next().await.map_err(|e| e.to_string())? {
                    Some(r) => v_string(r.get_value(0).map_err(|e| e.to_string())?),
                    None => None,
                };

            let top_filter_sql = if let Some(idc) = args.categoria_top_id.as_deref() {
                if !idc.trim().is_empty() {
                    "AND pr.ID_Categoria = ?1".to_string()
                } else {
                    "".to_string()
                }
            } else {
                "".to_string()
            };

            let sql_top10 = format!(
                r#"
                {ctes}
                SELECT
                  COALESCE(pr.Nombre, dc.Nombre_Producto, 'Producto') AS Nombre,
                  CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS unidades
                FROM Detalle_Comanda dc
                JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
                JOIN rng ON 1=1
                LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
                LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
                WHERE pd.paid_at >= rng.start_dt
                  AND pd.paid_at <  rng.end_dt
                  AND COALESCE(cat.Vendible,1)=1
                  {filter}
                GROUP BY COALESCE(dc.ID_Producto, dc.Nombre_Producto)
                HAVING SUM(COALESCE(dc.Cantidad,1)) > 0
                ORDER BY unidades DESC, pr.Nombre ASC
                LIMIT 10;
                "#,
                ctes = ctes,
                filter = top_filter_sql
            );

            let mut params_top: Vec<Value> = Vec::new();

            if let Some(idc) = args.categoria_top_id.as_deref() {
                if !idc.trim().is_empty() {
                    params_top.push(Value::Text(idc.to_string()));
                }
            }

            let mut rows_top = db
                .query(&sql_top10, params_top)
                .await
                .map_err(|e| e.to_string())?;

            let mut top_labels: Vec<String> = Vec::new();
            let mut top_values: Vec<i64> = Vec::new();

            while let Some(r) = rows_top.next().await.map_err(|e| e.to_string())? {
                top_labels
                    .push(v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default());
                top_values.push(v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0));
            }

            let worst_filter_sql = if let Some(idc) = args.categoria_worst_id.as_deref() {
                if !idc.trim().is_empty() {
                    "AND pr.ID_Categoria = ?1".to_string()
                } else {
                    "".to_string()
                }
            } else {
                "".to_string()
            };

            let sql_worst10 = format!(
                r#"
                {ctes}
                SELECT
                  pr.Nombre,
                  CAST(ROUND(COALESCE(SUM(
                    CASE WHEN pd.paid_at >= rng.start_dt AND pd.paid_at < rng.end_dt
                         THEN COALESCE(dc.Cantidad,1)
                         ELSE 0
                    END
                  ),0),0) AS INTEGER) AS unidades
                FROM Productos pr
                JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
                LEFT JOIN Detalle_Comanda dc ON dc.ID_Producto = pr.ID_Producto
                LEFT JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
                JOIN rng ON 1=1
                WHERE COALESCE(cat.Vendible,1)=1
                  {filter}
                GROUP BY pr.ID_Producto
                ORDER BY unidades ASC, pr.Nombre ASC
                LIMIT 10;
                "#,
                ctes = ctes,
                filter = worst_filter_sql
            );

            let mut params_worst: Vec<Value> = Vec::new();

            if let Some(idc) = args.categoria_worst_id.as_deref() {
                if !idc.trim().is_empty() {
                    params_worst.push(Value::Text(idc.to_string()));
                }
            }

            let mut rows_w = db
                .query(&sql_worst10, params_worst)
                .await
                .map_err(|e| e.to_string())?;

            let mut w_labels: Vec<String> = Vec::new();
            let mut w_values: Vec<i64> = Vec::new();

            while let Some(r) = rows_w.next().await.map_err(|e| e.to_string())? {
                w_labels.push(v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default());
                w_values.push(v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0));
            }

            Ok(ProductosStatsResponse {
                mejor_producto,
                peor_producto_vendible,
                top10_mejores: ChartSeriesI64 {
                    labels: top_labels,
                    values: top_values,
                },
                top10_peores: ChartSeriesI64 {
                    labels: w_labels,
                    values: w_values,
                },
            })
        }
    }

    const RANGOS: [StatsRange; 4] =
        [StatsRange::Hoy, StatsRange::Semana, StatsRange::Mes, StatsRange::Anio];

    /// Sin filtro, en blanco (que es sin filtro), cada categoría, la no vendible y una que no existe.
    const CATEGORIAS: [Option<&str>; 7] = [
        None,
        Some("  "),
        Some("cat-platos"),
        Some("cat-bebidas"),
        Some("cat-postres"),
        Some("cat-materia"),
        Some("cat-que-no-existe"),
    ];

    /// Las siembras: la de las ventas de verdad y la del nombre que es un ID.
    const SIEMBRAS: [&str; 2] = ["productos_vendidos", "productos_nombre_que_es_un_id"];

    async fn repositorio_sembrado(siembra: &str) -> SqliteStatsRepository {
        let ruta = contract_dir().join(format!("lecturas/casos/stats/{siembra}.json"));
        let caso: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&ruta).unwrap()).unwrap();
        let (db, _dir) = db_temporal().await;
        sembrar(&db, caso["seed"].as_array().unwrap()).await;
        SqliteStatsRepository::new(db)
    }

    #[tokio::test]
    async fn da_lo_mismo_que_las_cuatro_sentencias_de_antes() {
        for siembra in SIEMBRAS {
            let repo = repositorio_sembrado(siembra).await;
            for range in RANGOS {
                for top in CATEGORIAS {
                    for worst in CATEGORIAS {
                        let args = ProductosStatsArgs {
                            range,
                            categoria_top_id: top.map(str::to_string),
                            categoria_worst_id: worst.map(str::to_string),
                        };
                        let antes = repo.productos_antes(args.clone()).await.unwrap();
                        let ahora = repo.productos_impl(args).await.unwrap();
                        assert_eq!(
                            serde_json::to_value(&ahora).unwrap(),
                            serde_json::to_value(&antes).unwrap(),
                            "{siembra}: {range:?}, top {top:?}, peores {worst:?}"
                        );
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn una_linea_sin_producto_no_es_del_producto_cuyo_id_lleva_por_nombre() {
        let repo = repositorio_sembrado("productos_nombre_que_es_un_id").await;
        let hoy = |top: Option<&str>, worst: Option<&str>| ProductosStatsArgs {
            range: StatsRange::Hoy,
            categoria_top_id: top.map(str::to_string),
            categoria_worst_id: worst.map(str::to_string),
        };
        // Sin filtro, lo de la clave va junto: P-7 son 10,13 del producto y 0,37 de la línea
        // suelta, 10,5 que redondean a 11 (sumando por partes saldría 10,499… y 10). M-1 no es
        // vendible: sólo queda su línea suelta.
        let todo = repo.productos_impl(hoy(None, None)).await.unwrap();
        assert_eq!(todo.top10_mejores.labels, ["P-7", "M-1", "Agua"]);
        assert_eq!(todo.top10_mejores.values, [11, 6, 1]);
        // En «los peores» y en una categoría sólo cuentan las líneas del producto.
        assert_eq!(todo.top10_peores.labels, ["Agua", "P-7"]);
        assert_eq!(todo.top10_peores.values, [1, 10]);
        let bebidas = repo.productos_impl(hoy(Some("cat-bebidas"), Some("cat-bebidas"))).await.unwrap();
        assert_eq!(bebidas.top10_mejores.labels, ["P-7", "Agua"]);
        assert_eq!(bebidas.top10_mejores.values, [10, 1]);
    }

    #[tokio::test]
    async fn la_siembra_ejercita_los_empates_y_el_corte() {
        // Si la siembra dejara de vender nada hoy, la comparación de arriba pasaría en vacío.
        let repo = repositorio_sembrado("productos_vendidos").await;
        let hoy = |top: Option<&str>, worst: Option<&str>| ProductosStatsArgs {
            range: StatsRange::Hoy,
            categoria_top_id: top.map(str::to_string),
            categoria_worst_id: worst.map(str::to_string),
        };
        let todo = repo.productos_impl(hoy(None, None)).await.unwrap();
        assert_eq!(todo.mejor_producto.as_deref(), Some("Cerveza"));
        assert_eq!(todo.peor_producto_vendible.as_deref(), Some("Agua"));
        assert_eq!(todo.top10_mejores.labels.len(), 10);
        assert_eq!(todo.top10_peores.labels.len(), 10);
        // Los borrados del catálogo van delante en su empate, y entre ellos por su nombre.
        assert_eq!(
            todo.top10_mejores.labels[..7],
            ["Cerveza", "Croquetas", "Tortilla", "Bocadillo retirado", "Menú antiguo", "Ensalada", "Paella"]
        );
        assert_eq!(todo.top10_mejores.values[..7], [6, 5, 5, 4, 4, 4, 4]);

        let platos = repo.productos_impl(hoy(Some("cat-platos"), Some("cat-bebidas"))).await.unwrap();
        // Cuatro platos empatan a 2 y sólo caben tres: se queda fuera el último por nombre.
        assert_eq!(platos.top10_mejores.labels[7..], ["Alitas", "Jamón", "Pulpo"]);
        // El orden es el de SQLite: U+FF46 va antes que U+1F37A.
        let bebidas = repo.productos_impl(hoy(Some("cat-bebidas"), None)).await.unwrap();
        let pos = |nombre: &str| bebidas.top10_mejores.labels.iter().position(|l| l == nombre).unwrap();
        assert!(pos("ｆ Fanta") < pos("🍺 Jarra"), "{:?}", bebidas.top10_mejores.labels);
    }
}

#[cfg(test)]
mod tests_resumen_diario {
    //! Las estadísticas de productos y de mesas leen del resumen diario los días ya cerrados
    //! (`estadisticas_diarias.rs`) y tienen que dar EXACTAMENTE lo que daban las sentencias que
    //! recorrían los cobros, que se conservan aquí como referencia: la de productos en una pasada
    //! y las cuatro de mesas.
    //!
    //! Las siembras son las de los casos de contrato. Las de `stats/productos_semana` y
    //! `stats/mesas_semana` traen además `cambios`: tandas de escrituras que se aplican una detrás
    //! de otra (anular, cambiar la fecha de un cobro, cobrar otra parte de una línea, borrar un
    //! producto o una comanda, cambiar una comanda de mesa…). Tras cada tanda:
    //!
    //! 1. todo día del resumen que no esté apuntado como sucio tiene que coincidir con lo que sale
    //!    de los cobros: si no, a un cambio le falta su trigger;
    //! 2. las dos estadísticas, en los cuatro rangos, dan lo mismo que las de antes;
    //! 3. se rehace todo lo sucio, para que la tanda siguiente vuelva a mirar todos los días.
    //!
    //! El worker hace lo mismo con su propia copia (`test/statsResumenDiario.test.ts`).

    use super::*;
    use crate::contract_comun::{contract_dir, db_temporal, sembrar};
    use crate::estadisticas_diarias::{coincide, recalcular_pendientes};
    use std::time::Duration;

    /// La sentencia de la estadística de productos de antes del resumen diario, tal cual estaba:
    /// una pasada por las líneas cobradas del rango.
    fn productos_de_antes(range: StatsRange) -> String {
        let (start_expr, end_expr) = range_bounds_sql(range);
        format!(
            r#"
            WITH
            rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
            paid_det AS (
              SELECT pd.ID_Detalle AS ID_Detalle
              FROM Pago_Detalles pd
              JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
              JOIN rng ON 1=1
              WHERE p.Estado = 'ACTIVO'
                AND p.Fecha_Hora >= rng.start_dt
                AND p.Fecha_Hora <  rng.end_dt
              GROUP BY pd.ID_Detalle
            ),
            vendido AS (
              SELECT
                COALESCE(dc.ID_Producto, dc.Nombre_Producto) AS clave,
                dc.Nombre_Producto AS nombre_linea,
                SUM(COALESCE(dc.Cantidad,1)) AS suma,
                SUM(CASE WHEN dc.ID_Producto IS NOT NULL THEN COALESCE(dc.Cantidad,1) END) AS suma_con_producto,
                SUM(CASE WHEN dc.ID_Producto IS NULL THEN COALESCE(dc.Cantidad,1) END) AS suma_sin_producto
              FROM paid_det cobrada
              JOIN Detalle_Comanda dc ON dc.ID_Detalle = cobrada.ID_Detalle
              GROUP BY COALESCE(dc.ID_Producto, dc.Nombre_Producto)
            )
            SELECT
              1 AS de_venta,
              clave,
              label,
              nombre,
              id_producto,
              id_categoria,
              CAST(ROUND(general,0) AS INTEGER) AS unidades,
              general > 0 AS con_ventas,
              CAST(ROUND(del_producto,0) AS INTEGER) AS unidades_producto,
              del_producto > 0 AS con_ventas_producto
            FROM (
              SELECT
                v.clave AS clave,
                CASE WHEN v.suma_con_producto IS NOT NULL AND COALESCE(cat.Vendible,1)=1
                     THEN COALESCE(pr.Nombre, v.nombre_linea, 'Producto')
                     ELSE COALESCE(v.clave, 'Producto')
                END AS label,
                CASE WHEN COALESCE(cat.Vendible,1)=1 THEN pr.Nombre END AS nombre,
                pr.ID_Producto AS id_producto,
                CASE WHEN COALESCE(cat.Vendible,1)=1 THEN pr.ID_Categoria END AS id_categoria,
                CASE WHEN COALESCE(cat.Vendible,1)=1 THEN v.suma ELSE v.suma_sin_producto END AS general,
                CASE WHEN COALESCE(cat.Vendible,1)=1 THEN v.suma_con_producto END AS del_producto
              FROM vendido v
              LEFT JOIN Productos pr ON v.suma_con_producto IS NOT NULL AND pr.ID_Producto = v.clave
              LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
              WHERE COALESCE(cat.Vendible,1)=1 OR v.suma_sin_producto IS NOT NULL
            )
            UNION ALL
            SELECT 0, pr.ID_Producto, pr.Nombre, pr.Nombre, pr.ID_Producto, pr.ID_Categoria, 0, 0, 0, 0
            FROM Productos pr
            JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
            WHERE COALESCE(cat.Vendible,1)=1
            ORDER BY nombre ASC, clave ASC;
            "#,
            start = start_expr,
            end = end_expr
        )
    }

    /// Las cuatro sentencias de la estadística de mesas de antes del resumen diario, tal cual
    /// estaban salvo en el desempate de las dos listas de mesas, que no lo tenían entero: dos
    /// mesas con lo mismo salían en el orden en que las dejara SQLite (en la siembra de
    /// `mesas_semana`, la 3 antes que la 2). Ahora va primero la de número menor y, con el mismo
    /// número, la de ID menor (`sql_mesa_top_comandas`, `sql_mesas_top_ingresos`).
    fn mesas_de_antes(range: StatsRange) -> SentenciasMesas {
        let (start, end) = range_bounds_sql(range);
        let bucket = bucket_sql_datetime(range, "p.Fecha_Hora");
        SentenciasMesas {
            ingresos: format!(
                r#"
                SELECT
                  COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN c.ID_Mesa END) AS ocupadas,
                  COALESCE(SUM(p.Importe_Total),0) AS ingresos
                FROM Pagos p
                JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
                JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
                WHERE p.Fecha_Hora >= {start} AND p.Fecha_Hora < {end}
                  AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO';
                "#
            ),
            top_comandas: format!(
                r#"
                SELECT
                  m.Numero_Mesa,
                  z.Nombre_Zona,
                  COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END) AS comandas
                FROM Pagos p
                JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
                JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
                JOIN Zonas z ON z.ID_Zona = m.ID_Zona
                WHERE p.Fecha_Hora >= {start} AND p.Fecha_Hora < {end}
                  AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
                GROUP BY m.ID_Mesa
                ORDER BY comandas DESC, m.Numero_Mesa ASC, m.ID_Mesa ASC
                LIMIT 1;
                "#
            ),
            servicios: format!(
                r#"
                SELECT {bucket} AS b, COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN p.ID_Comanda END) AS n
                FROM Pagos p
                JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
                JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
                WHERE p.Fecha_Hora >= {start} AND p.Fecha_Hora < {end}
                  AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
                GROUP BY b
                ORDER BY b ASC;
                "#
            ),
            top_ingresos: format!(
                r#"
                SELECT
                  m.Numero_Mesa,
                  z.Nombre_Zona,
                  COALESCE(SUM(p.Importe_Total),0) AS total
                FROM Pagos p
                JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
                JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
                JOIN Zonas z ON z.ID_Zona = m.ID_Zona
                WHERE p.Fecha_Hora >= {start} AND p.Fecha_Hora < {end}
                  AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
                GROUP BY m.ID_Mesa
                ORDER BY total DESC, m.Numero_Mesa ASC, m.ID_Mesa ASC
                LIMIT 10;
                "#
            ),
        }
    }

    const RANGOS: [StatsRange; 4] =
        [StatsRange::Hoy, StatsRange::Semana, StatsRange::Mes, StatsRange::Anio];

    /// Sin filtro, y con filtros que dejan dentro y fuera productos vendidos.
    const FILTROS: [(Option<&str>, Option<&str>); 4] = [
        (None, None),
        (Some("cat-platos"), Some("cat-bebidas")),
        (Some("cat-bebidas"), Some("cat-platos")),
        (Some("cat-materia"), Some("cat-que-no-existe")),
    ];

    /// Las siembras: las dos con cambios y las demás de productos y mesas.
    const CASOS: [&str; 5] = [
        "productos_semana",
        "mesas_semana",
        "productos_vendidos",
        "productos_nombre_que_es_un_id",
        "mesas",
    ];

    fn leer_caso(nombre: &str) -> serde_json::Value {
        let ruta = contract_dir().join(format!("lecturas/casos/stats/{nombre}.json"));
        serde_json::from_str(&std::fs::read_to_string(&ruta).unwrap()).unwrap()
    }

    /// Las dos estadísticas, en los cuatro rangos, dan lo mismo que las de antes.
    async fn da_lo_mismo_que_antes(repo: &SqliteStatsRepository, etiqueta: &str) {
        for range in RANGOS {
            let antes = repo.mesas_con(mesas_de_antes(range)).await.unwrap();
            // Primero sin rehacer los días sucios: lo que lee alguien a quien se le ha colado un
            // cobro entre rehacerlos y leer. Esos días se leen de los cobros, no del resumen.
            let sin_rehacer = repo
                .mesas_con(SentenciasMesas {
                    ingresos: sql_mesas_ingresos(range),
                    top_comandas: sql_mesa_top_comandas(range),
                    servicios: sql_mesas_servicios(range),
                    top_ingresos: sql_mesas_top_ingresos(range),
                })
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(&sin_rehacer).unwrap(),
                serde_json::to_value(&antes).unwrap(),
                "{etiqueta}: mesas sin rehacer los días sucios, {range:?}"
            );
            for (top, worst) in FILTROS {
                let args = ProductosStatsArgs {
                    range,
                    categoria_top_id: top.map(str::to_string),
                    categoria_worst_id: worst.map(str::to_string),
                };
                let antes = repo.productos_con(&productos_de_antes(range), args.clone()).await.unwrap();
                let sin_rehacer = repo.productos_con(&sql_productos(range), args).await.unwrap();
                assert_eq!(
                    serde_json::to_value(&sin_rehacer).unwrap(),
                    serde_json::to_value(&antes).unwrap(),
                    "{etiqueta}: productos sin rehacer los días sucios, {range:?}, top {top:?}, peores {worst:?}"
                );
            }
            let ahora = repo.mesas_impl(range).await.unwrap();
            assert_eq!(
                serde_json::to_value(&ahora).unwrap(),
                serde_json::to_value(&antes).unwrap(),
                "{etiqueta}: mesas, {range:?}"
            );
            for (top, worst) in FILTROS {
                let args = ProductosStatsArgs {
                    range,
                    categoria_top_id: top.map(str::to_string),
                    categoria_worst_id: worst.map(str::to_string),
                };
                let antes = repo.productos_con(&productos_de_antes(range), args.clone()).await.unwrap();
                let ahora = repo.productos_impl(args).await.unwrap();
                assert_eq!(
                    serde_json::to_value(&ahora).unwrap(),
                    serde_json::to_value(&antes).unwrap(),
                    "{etiqueta}: productos, {range:?}, top {top:?}, peores {worst:?}"
                );
            }
        }
    }

    /// Todo día resumido que no esté apuntado como sucio coincide con lo que sale de los cobros.
    async fn lo_no_apuntado_sigue_valiendo(db: &Arc<Db>, etiqueta: &str) {
        let w = db.write().await;
        let conn = w.raw();
        let mut filas = conn
            .query(
                "SELECT dia FROM ( \
                   SELECT substr(Fecha_Hora, 1, 10) AS dia FROM Pagos \
                   UNION SELECT Dia FROM _Estad_Producto_Dia \
                   UNION SELECT Dia FROM _Estad_Mesa_Dia \
                 ) WHERE dia NOT IN (SELECT Dia FROM _Estad_Dias_Sucios) ORDER BY dia;",
                (),
            )
            .await
            .unwrap();
        let mut dias = Vec::new();
        while let Some(f) = filas.next().await.unwrap() {
            dias.extend(v_string(f.get_value(0).unwrap()));
        }
        for dia in dias {
            assert!(
                coincide(conn, &dia).await.unwrap(),
                "{etiqueta}: el resumen del {dia} ya no vale y nadie lo apuntó"
            );
        }
    }

    async fn rehacer_todo(db: &Arc<Db>) {
        let pasada = recalcular_pendientes(db, Duration::from_secs(60)).await.unwrap();
        assert_eq!(pasada.quedan, 0);
    }

    #[tokio::test]
    async fn da_lo_mismo_que_recorrer_los_cobros_tras_cada_cambio() {
        for nombre in CASOS {
            let caso = leer_caso(nombre);
            let (db, _dir) = db_temporal().await;
            sembrar(&db, caso["seed"].as_array().unwrap()).await;
            let repo = SqliteStatsRepository::new(db.clone());

            da_lo_mismo_que_antes(&repo, &format!("{nombre}, siembra")).await;
            rehacer_todo(&db).await;
            lo_no_apuntado_sigue_valiendo(&db, &format!("{nombre}, siembra")).await;

            let cambios = caso["cambios"].as_array().cloned().unwrap_or_default();
            for (i, tanda) in cambios.iter().enumerate() {
                let etiqueta = format!("{nombre}, tanda {}", i + 1);
                sembrar(&db, tanda.as_array().unwrap()).await;
                lo_no_apuntado_sigue_valiendo(&db, &etiqueta).await;
                da_lo_mismo_que_antes(&repo, &etiqueta).await;
                rehacer_todo(&db).await;
            }
        }
    }

    #[tokio::test]
    async fn un_cobro_futuro_no_hace_aparecer_el_mes_de_hoy_en_la_grafica_del_anio() {
        // Revisión de Codex (segunda pasada): una comanda cobrada el último día del mes pasado y
        // otra vez después de ahora, y nada más. Su fila sin importe de hoy suma a las comandas del
        // rango, pero no puede sacar en la gráfica del año el mes de hoy, que no tiene cobros. (En
        // enero el mes pasado es del año anterior y no hay nada que comparar.) La misma siembra, en
        // `statsResumenDiario.test.ts`.
        let (db, _dir) = db_temporal().await;
        let siembra: Vec<serde_json::Value> = [
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z', 'Sala');",
            "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m1', 'z', '1', 4, 0, 0, 'rect', 120, 70);",
            "INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, Fecha_Hora_Apertura, Estado) VALUES ('c1', 'MESA', 'm1', datetime('now','localtime','start of month','-1 day','+12 hours'), 'Pagada');",
            "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p1', 'c1', datetime('now','localtime','start of month','-1 day','+12 hours'), 'Efectivo', 500, 'parcial');",
            "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p2', 'c1', datetime('now','localtime','+1 day'), 'Efectivo', 500, 'parcial');",
        ]
        .map(serde_json::Value::from)
        .to_vec();
        sembrar(&db, &siembra).await;
        let repo = SqliteStatsRepository::new(db.clone());
        da_lo_mismo_que_antes(&repo, "cobro futuro de una comanda del mes pasado").await;
    }

    #[tokio::test]
    async fn las_siembras_con_cambios_ejercitan_el_resumen() {
        // Si las siembras dejaran de tener días cerrados dentro de la semana, la comparación de
        // arriba pasaría sin leer nada del resumen.
        for nombre in ["productos_semana", "mesas_semana"] {
            let caso = leer_caso(nombre);
            let (db, _dir) = db_temporal().await;
            sembrar(&db, caso["seed"].as_array().unwrap()).await;
            let repo = SqliteStatsRepository::new(db.clone());
            repo.mesas_impl(StatsRange::Semana).await.unwrap();
            let r = db.read().await;
            let mut filas = r
                .query(
                    "SELECT (SELECT COUNT(DISTINCT Dia) FROM _Estad_Producto_Dia WHERE Dia >= date('now','localtime','-6 days')), \
                            (SELECT COUNT(DISTINCT Dia) FROM _Estad_Mesa_Dia WHERE Dia >= date('now','localtime','-6 days'));",
                    (),
                )
                .await
                .unwrap();
            let f = filas.next().await.unwrap().unwrap();
            let dias = v_i64(f.get_value(0).unwrap()).unwrap() + v_i64(f.get_value(1).unwrap()).unwrap();
            assert!(dias >= 4, "{nombre}: sólo {dias} días resumidos en la semana");
            assert!(caso["cambios"].as_array().is_some_and(|c| c.len() >= 8), "{nombre}: sin cambios");
        }
    }
}
