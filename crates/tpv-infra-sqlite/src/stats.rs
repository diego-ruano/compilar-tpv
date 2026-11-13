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

/// La sentencia de la estadística de productos: UNA pasada por las líneas cobradas del rango.
///
/// Devuelve dos clases de fila, ya ordenadas por el nombre del catálogo: lo vendido en el rango
/// (`de_venta = 1`, una por producto, con sus unidades) y el catálogo vendible (`de_venta = 0`). El
/// mejor, el peor y los dos top 10 los saca `productos_impl` de ahí.
///
/// Eran cuatro sentencias y cada una volvía a calcular `paid_det`; las dos de «el peor», además,
/// partían del catálogo y recorrían todas las líneas de la historia de cada producto. La misma
/// sentencia, en el worker: `sqlProductos` de `domains/stats/stats.queries.ts`, donde corre en el
/// SQLite del Durable Object, que atiende a todo el negocio en un solo hilo.
pub(crate) fn sql_productos(range: StatsRange) -> String {
    let (start_expr, end_expr) = range_bounds_sql(range);
    format!(
        r#"
        WITH
        rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
        paid_det AS (
          -- STAT-07: cada línea entra UNA vez. Uniendo Pago_Detalles con Pagos a pelo, una línea
          -- cobrada en dos veces saldría dos veces y sus unidades se contarían dobles.
          -- Sólo pagos ACTIVOS (CUENTA-07): un ticket anulado no es una venta, así que sus
          -- líneas no pueden aparecer en «lo más vendido» ni sumar en el histórico.
          -- El rango va AQUÍ (RI-18): se agrupan los cobros del rango, no los de toda la historia.
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
          -- Se agrupa ANTES de mirar el catálogo: así el catálogo se consulta una vez por producto
          -- y no una por línea. La clave es el producto o, si la línea ya no lo tiene, su nombre.
          SELECT
            COALESCE(dc.ID_Producto, dc.Nombre_Producto) AS clave,
            dc.ID_Producto AS id_producto,
            dc.Nombre_Producto AS nombre_linea,
            SUM(COALESCE(dc.Cantidad,1)) AS suma
          FROM paid_det cobrada
          JOIN Detalle_Comanda dc ON dc.ID_Detalle = cobrada.ID_Detalle
          GROUP BY COALESCE(dc.ID_Producto, dc.Nombre_Producto)
        )
        -- LEFT JOIN y no JOIN: el catálogo puede borrar un producto que ya no se vende (INV-05), y
        -- su venta del año pasado sigue siendo una venta. Con un INNER, esas líneas desaparecerían
        -- del histórico SIN error, que es la peor forma de perderlas. El nombre sale del catálogo
        -- si el producto sigue ahí (así un renombrado se ve en el informe) y del snapshot de la
        -- línea si ya no está.
        SELECT
          1 AS de_venta,
          v.clave AS clave,
          COALESCE(pr.Nombre, v.nombre_linea, 'Producto') AS label,
          pr.Nombre AS nombre,
          pr.ID_Producto AS id_producto,
          pr.ID_Categoria AS id_categoria,
          CAST(ROUND(v.suma,0) AS INTEGER) AS unidades,
          v.suma > 0 AS con_ventas
        FROM vendido v
        LEFT JOIN Productos pr ON pr.ID_Producto = v.id_producto
        LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
        WHERE COALESCE(cat.Vendible,1)=1
        UNION ALL
        -- El catálogo vendible entero, a cero: el peor producto es justo el que no compra nadie, y
        -- ése no aparece en ninguna línea de comanda. Sus unidades se le ponen al leer el resultado.
        SELECT 0, pr.ID_Producto, pr.Nombre, pr.Nombre, pr.ID_Producto, pr.ID_Categoria, 0, 0
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
        end = end_expr
    )
}

/// La sentencia de los clientes recurrentes: quién ha comprado en el rango y si ya había comprado
/// antes de que empezara, que es lo que hace falta mirar en toda la historia y no sólo en el rango.
///
/// `allp` (los cobros de comandas con reserva de un cliente) va `MATERIALIZED`: la leen tres CTE, y
/// sin esa palabra SQLite la deshace dentro de cada una y recorre tres veces todos los cobros de la
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
            r.ID_Cliente AS id_cliente,
            datetime(p.Fecha_Hora) AS paid_at,
            COALESCE(p.Importe_Total,0) AS imp
          FROM Pagos p
          JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
          JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
          WHERE c.ID_Reserva IS NOT NULL
            AND r.ID_Cliente IS NOT NULL
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

/// Una fila de `sql_productos`: un producto vendido en el rango o uno del catálogo vendible.
struct FilaProducto {
    label: Option<String>,
    id_producto: Option<String>,
    id_categoria: Option<String>,
    unidades: i64,
    con_ventas: bool,
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
        let (start_expr, end_expr) = range_bounds_sql(range);
        let bucket_expr = bucket_sql_datetime(range, "p.Fecha_Hora");

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
        // (Canal='BARRA', ID_Mesa NULL), así que el JOIN con Mesas ya no las incluye.
        let sql_occ_ing = format!(
            r#"
            SELECT
              COUNT(DISTINCT CASE WHEN p.ID_Pago_Origen IS NULL THEN c.ID_Mesa END) AS ocupadas,
              COALESCE(SUM(p.Importe_Total),0) AS ingresos
            FROM Pagos p
            JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
            JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
            WHERE p.Fecha_Hora >= {start} AND p.Fecha_Hora < {end}
              AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO';
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_occ = db.query(&sql_occ_ing, ()).await.map_err(|e| e.to_string())?;
        let (ocupadas, total_ingresos): (i64, Dinero) =
            match rows_occ.next().await.map_err(|e| e.to_string())? {
                Some(r) => (
                    v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
                    v_dinero(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(Dinero::CERO),
                ),
                None => (0, Dinero::CERO),
            };

        let ticket_medio_por_mesa: Dinero = if ocupadas > 0 {
            total_ingresos.escala(1.0 / ocupadas as f64)
        } else {
            Dinero::CERO
        };

        let sql_top = format!(
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
            ORDER BY comandas DESC, m.Numero_Mesa ASC
            LIMIT 1;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_top = db.query(&sql_top, ()).await.map_err(|e| e.to_string())?;
        let mesa_top_comandas: Option<MesasTopComandas> =
            match rows_top.next().await.map_err(|e| e.to_string())? {
                Some(r) => Some(MesasTopComandas {
                    mesa: v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default(),
                    zona: v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
                    comandas: v_i64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0),
                }),
                None => None,
            };

        let sql_serv = format!(
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
            bucket = bucket_expr
        );

        let mut rows_serv = db.query(&sql_serv, ()).await.map_err(|e| e.to_string())?;

        let mut labels: Vec<String> = Vec::new();
        let mut values: Vec<i64> = Vec::new();

        while let Some(r) = rows_serv.next().await.map_err(|e| e.to_string())? {
            let b = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

            labels.push(b);
            values.push(n);
        }

        let servicios = ChartSeriesI64 { labels, values };

        let sql_top_mesas = format!(
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
            ORDER BY total DESC
            LIMIT 10;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_tm = db
            .query(&sql_top_mesas, ())
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
        let g = self.db.read().await;
        let db = &g;

        let mut rows = db
            .query(&sql_productos(args.range), ())
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
            };
            if de_venta {
                vendidos.push(fila);
            } else {
                catalogo.push(fila);
            }
        }

        // Las unidades de cada producto del catálogo; el que no se ha vendido no está y vale 0.
        let unidades_de: HashMap<&str, i64> = vendidos
            .iter()
            .filter_map(|v| v.id_producto.as_deref().map(|id| (id, v.unidades)))
            .collect();

        // «Los mejores» sólo cuentan lo que se ha vendido (suma > 0, sin redondear); «los peores»
        // salen del catálogo, con 0 lo que no ha comprado nadie. `sort_by_key` es estable: entre dos
        // con las mismas unidades queda el orden por nombre que trae la sentencia.
        let mejores = |categoria: Option<&str>, limite: usize| -> Vec<(Option<String>, i64)> {
            let mut out: Vec<(Option<String>, i64)> = vendidos
                .iter()
                .filter(|f| f.con_ventas && f.es_de(categoria))
                .map(|f| (f.label.clone(), f.unidades))
                .collect();
            out.sort_by_key(|(_, unidades)| std::cmp::Reverse(*unidades));
            out.truncate(limite);
            out
        };
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
              JOIN Mesas m ON m.ID_Mesa = r.ID_Mesa
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
            StatsTurno::Comida => "AND Turno='COMIDA'".to_string(),
            StatsTurno::Cena => "AND Turno='CENA'".to_string(),
        };

        let sql_mesas_res = format!(
            r#"
            {ctes}
            SELECT COUNT(DISTINCT ID_Mesa)
            FROM res_rng
            WHERE COALESCE(Estado,'') <> 'CANCELADA'
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

            // Un promedio de importes sigue siendo fraccionario, asi que se reparte con
            // `escala` y vuelve a centimo entero de una sola vez.
            ticket_medio_cliente = if clientes_rango > 0 {
                ventas_total.escala(1.0 / clientes_rango as f64)
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

        let gasto_medio = if num_gastos > 0 {
            total_gasto.escala(1.0 / num_gastos as f64)
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
    //! semana, el mes y el año no sean lo mismo que hoy. El worker hace la misma comparación con
    //! su propia copia (`test/statsProductosUnaPasada.test.ts`), y el arnés de lectura fija que los
    //! dos lados dan lo mismo.

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

    async fn repositorio_sembrado() -> SqliteStatsRepository {
        let ruta = contract_dir().join("lecturas/casos/stats/productos_vendidos.json");
        let caso: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&ruta).unwrap()).unwrap();
        let (db, _dir) = db_temporal().await;
        sembrar(&db, caso["seed"].as_array().unwrap()).await;
        SqliteStatsRepository::new(db)
    }

    #[tokio::test]
    async fn da_lo_mismo_que_las_cuatro_sentencias_de_antes() {
        let repo = repositorio_sembrado().await;
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
                        "{range:?}, top {top:?}, peores {worst:?}"
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn la_siembra_ejercita_los_empates_y_el_corte() {
        // Si la siembra dejara de vender nada hoy, la comparación de arriba pasaría en vacío.
        let repo = repositorio_sembrado().await;
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
