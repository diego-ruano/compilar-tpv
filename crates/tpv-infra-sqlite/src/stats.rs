//! Adaptador SQLite del repositorio de **estadísticas** (analítica, solo lectura).
//!
//! Reubica verbatim toda la agregación SQL del antiguo `stats.rs`. Los cuerpos internos
//! (`*_impl`) devuelven `Result<T, String>` para poder portarse sin cambios; el `impl`
//! del puerto los envuelve mapeando el error a `AppError::Repository`.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use crate::db::{Db, Reader};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::stats::StatsRepository;
use tpv_contracts::stats::{
    ChartSeriesF64Out, ChartSeriesI64, ClientesStatsArgs, ClientesStatsResponse, MesaIngresoRow,
    MesasStatsResponse, MesasTopComandas, ProductosStatsArgs, ProductosStatsResponse,
    ProveedorTop, ProveedoresStatsArgs, ProveedoresStatsResponse, PuntualidadInfo,
    ReservasMesasTurno, ReservasStatsArgs, ReservasStatsResponse, StatsCategoriaRow, StatsRange,
    StatsTurno, TrabajadorCardStats, TrabajadoresStatsArgs, TrabajadoresStatsResponse,
    UltimoGastoProveedor,
};

use crate::mapping::{v_f64, v_i64, v_string};

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

async fn table_has_column<C: Reader>(db: &C, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({});", table);
    let mut rows = db.query(&sql, ()).await.map_err(|e| e.to_string())?;

    while let Ok(Some(r)) = rows.next().await {
        let name = v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();

        if name == column {
            return Ok(true);
        }
    }

    Ok(false)
}

async fn table_exists<C: Reader>(db: &C, table: &str) -> Result<bool, String> {
    let mut rows = db
        .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?1 LIMIT 1;",
            vec![Value::Text(table.to_string())],
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(rows.next().await.map_err(|e| e.to_string())?.is_some())
}

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

fn bucket_sql(range: StatsRange) -> &'static str {
    match range {
        StatsRange::Hoy => "strftime('%H', paid_at)",
        StatsRange::Semana | StatsRange::Mes => "strftime('%d/%m', paid_at)",
        StatsRange::Anio => "strftime('%m/%Y', paid_at)",
    }
}

fn bucket_sql_reservas(range: StatsRange) -> &'static str {
    match range {
        StatsRange::Hoy => "strftime('%H', res_at)",
        StatsRange::Semana | StatsRange::Mes => "strftime('%d/%m', res_at)",
        StatsRange::Anio => "strftime('%m/%Y', res_at)",
    }
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
        let bucket_expr = bucket_sql(range);

        let g = self.db.read().await;
        let db = &g;

        let mut rows_total = db
            .query(
                r#"
                SELECT COUNT(*)
                FROM Mesas
                WHERE COALESCE(Es_Sistema,0)=0;
                "#,
                (),
            )
            .await
            .map_err(|e| e.to_string())?;

        let total_mesas: i64 = match rows_total.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

        let ctes = format!(
            r#"
            WITH
            rng AS (
              SELECT {start} AS start_dt, {end} AS end_dt
            ),
            paid_det AS (
              SELECT pd.ID_Detalle AS ID_Detalle, MIN(p.Fecha_Hora) AS paid_at
              FROM Pago_Detalles pd
              JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
              GROUP BY pd.ID_Detalle
            ),
            comanda_paid_at AS (
              SELECT
                c.ID_Comanda AS ID_Comanda,
                c.ID_Mesa    AS ID_Mesa,
                MAX(pd.paid_at) AS paid_at,
                ROUND(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 2) AS total
              FROM Comandas c
              JOIN Detalle_Comanda dc ON dc.ID_Comanda = c.ID_Comanda
              JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
              GROUP BY c.ID_Comanda
            ),
            pagadas AS (
              SELECT cp.*
              FROM comanda_paid_at cp, rng
              WHERE cp.paid_at >= rng.start_dt
                AND cp.paid_at <  rng.end_dt
                AND NOT EXISTS (
                  SELECT 1
                  FROM Detalle_Comanda dc2
                  WHERE dc2.ID_Comanda = cp.ID_Comanda
                    AND NOT EXISTS (
                      SELECT 1 FROM paid_det pd2 WHERE pd2.ID_Detalle = dc2.ID_Detalle
                    )
                )
            )
            "#,
            start = start_expr,
            end = end_expr
        );

        let sql_ocupadas = format!(
            r#"
            {ctes}
            SELECT COUNT(DISTINCT m.ID_Mesa)
            FROM pagadas p
            JOIN Mesas m ON m.ID_Mesa = p.ID_Mesa
            WHERE COALESCE(m.Es_Sistema,0)=0;
            "#,
            ctes = ctes
        );

        let mut rows_occ = db
            .query(&sql_ocupadas, ())
            .await
            .map_err(|e| e.to_string())?;
        let ocupadas: i64 = match rows_occ.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

        let sql_ingresos = format!(
            r#"
            {ctes}
            SELECT ROUND(COALESCE(SUM(p.total),0),2)
            FROM pagadas p
            JOIN Mesas m ON m.ID_Mesa = p.ID_Mesa
            WHERE COALESCE(m.Es_Sistema,0)=0;
            "#,
            ctes = ctes
        );

        let mut rows_ing = db
            .query(&sql_ingresos, ())
            .await
            .map_err(|e| e.to_string())?;
        let total_ingresos: f64 = match rows_ing.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_f64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0.0),
            None => 0.0,
        };

        let ticket_medio_por_mesa: f64 = if ocupadas > 0 {
            (total_ingresos / (ocupadas as f64) * 100.0).round() / 100.0
        } else {
            0.0
        };

        let sql_top = format!(
            r#"
            {ctes}
            SELECT
              m.Numero_Mesa,
              z.Nombre_Zona,
              COUNT(*) AS comandas
            FROM pagadas p
            JOIN Mesas m ON m.ID_Mesa = p.ID_Mesa
            JOIN Zonas z ON z.ID_Zona = m.ID_Zona
            WHERE COALESCE(m.Es_Sistema,0)=0
            GROUP BY p.ID_Mesa
            ORDER BY comandas DESC, m.Numero_Mesa ASC
            LIMIT 1;
            "#,
            ctes = ctes
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
            {ctes}
            SELECT {bucket} AS b, COUNT(*) AS n
            FROM pagadas
            GROUP BY b
            ORDER BY b ASC;
            "#,
            ctes = ctes,
            bucket = bucket_expr
        );

        let mut rows_serv = db.query(&sql_serv, ()).await.map_err(|e| e.to_string())?;

        let mut labels: Vec<String> = Vec::new();
        let mut values: Vec<i64> = Vec::new();

        while let Ok(Some(r)) = rows_serv.next().await {
            let b = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

            labels.push(b);
            values.push(n);
        }

        let servicios = ChartSeriesI64 { labels, values };

        let sql_top_mesas = format!(
            r#"
            {ctes}
            SELECT
              m.Numero_Mesa,
              z.Nombre_Zona,
              ROUND(SUM(p.total),2) AS total
            FROM pagadas p
            JOIN Mesas m ON m.ID_Mesa = p.ID_Mesa
            JOIN Zonas z ON z.ID_Zona = m.ID_Zona
            WHERE COALESCE(m.Es_Sistema,0)=0
            GROUP BY p.ID_Mesa
            ORDER BY total DESC
            LIMIT 10;
            "#,
            ctes = ctes
        );

        let mut rows_tm = db
            .query(&sql_top_mesas, ())
            .await
            .map_err(|e| e.to_string())?;
        let mut top_mesas_ingresos: Vec<MesaIngresoRow> = Vec::new();

        while let Ok(Some(r)) = rows_tm.next().await {
            top_mesas_ingresos.push(MesaIngresoRow {
                mesa: v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default(),
                zona: v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
                total: v_f64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0.0),
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

        while let Ok(Some(r)) = rows.next().await {
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
        let (start_expr, end_expr) = range_bounds_sql(args.range);
        let g = self.db.read().await;
        let db = &g;

        let ctes = format!(
            r#"
            WITH
            rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
            paid_det AS (
              SELECT pd.ID_Detalle AS ID_Detalle, MIN(p.Fecha_Hora) AS paid_at
              FROM Pago_Detalles pd
              JOIN Pagos p ON p.ID_Pago = pd.ID_Pago
              GROUP BY pd.ID_Detalle
            )
            "#,
            start = start_expr,
            end = end_expr
        );

        let sql_best = format!(
            r#"
            {ctes}
            SELECT
              pr.Nombre,
              CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS unidades
            FROM Detalle_Comanda dc
            JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
            JOIN rng ON 1=1
            JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
            JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
            WHERE pd.paid_at >= rng.start_dt
              AND pd.paid_at <  rng.end_dt
              AND COALESCE(cat.Vendible,1)=1
            GROUP BY pr.ID_Producto
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
              pr.Nombre,
              CAST(ROUND(SUM(COALESCE(dc.Cantidad,1)),0) AS INTEGER) AS unidades
            FROM Detalle_Comanda dc
            JOIN paid_det pd ON pd.ID_Detalle = dc.ID_Detalle
            JOIN rng ON 1=1
            JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
            JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
            WHERE pd.paid_at >= rng.start_dt
              AND pd.paid_at <  rng.end_dt
              AND COALESCE(cat.Vendible,1)=1
              {filter}
            GROUP BY pr.ID_Producto
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

        while let Ok(Some(r)) = rows_top.next().await {
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

        while let Ok(Some(r)) = rows_w.next().await {
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
                WHERE COALESCE(Es_Sistema,0)=0;
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
              WHERE COALESCE(m.Es_Sistema,0)=0
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

        while let Ok(Some(r)) = rows_bar.next().await {
            bar_labels
                .push(v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default());
            bar_values.push(v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0));
        }

        let reservas_por_bucket = ChartSeriesI64 {
            labels: bar_labels,
            values: bar_values,
        };

        let sql_estado = format!(
            r#"
            {ctes}
            SELECT
              SUM(CASE WHEN COALESCE(Estado,'')='ACTIVA' THEN 1 ELSE 0 END) AS activas,
              SUM(CASE WHEN COALESCE(Estado,'')='FINALIZADA' THEN 1 ELSE 0 END) AS finalizadas,
              SUM(CASE WHEN COALESCE(Estado,'')='CANCELADA' THEN 1 ELSE 0 END) AS canceladas
            FROM res_rng;
            "#,
            ctes = ctes
        );

        let mut rows_es = db.query(&sql_estado, ()).await.map_err(|e| e.to_string())?;
        let (activas, finalizadas, canceladas) =
            match rows_es.next().await.map_err(|e| e.to_string())? {
                Some(r) => (
                    v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
                    v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
                    v_i64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0),
                ),
                None => (0, 0, 0),
            };

        let estado = ChartSeriesI64 {
            labels: vec!["Activas".into(), "Finalizadas".into(), "Canceladas".into()],
            values: vec![activas, finalizadas, canceladas],
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

        while let Ok(Some(r)) = rows_w.next().await {
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
                ranking_ventas: ChartSeriesF64Out {
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
        let mut cam_ticket_medio: HashMap<String, f64> = HashMap::new();
        let mut cam_ventas_total: HashMap<String, f64> = HashMap::new();

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

        while let Ok(Some(r)) = rows_t.next().await {
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

        while let Ok(Some(r)) = rows_c.next().await {
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
              AND datetime(Fecha_Hora_Apertura) >= (SELECT start_dt FROM rng)
              AND datetime(Fecha_Hora_Apertura) <  (SELECT end_dt   FROM rng)
            GROUP BY ID_Trabajador;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_cc = db
            .query(&sql_cam_com, ())
            .await
            .map_err(|e| e.to_string())?;

        while let Ok(Some(r)) = rows_cc.next().await {
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
            WHERE datetime(p.Fecha_Hora) >= rng.start_dt
              AND datetime(p.Fecha_Hora) <  rng.end_dt
              AND p.ID_Trabajador_Cobrador IS NOT NULL
              AND r.Nombre_Rol = 'Camarero'
            GROUP BY p.ID_Trabajador_Cobrador;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_p = db.query(&sql_cobros, ()).await.map_err(|e| e.to_string())?;

        while let Ok(Some(r)) = rows_p.next().await {
            let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

            if !id_trab.is_empty() {
                cam_cobros.insert(id_trab, n);
            }
        }

        let sql_sales = format!(
            r#"
            WITH
            rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
            pagos_rng AS (
              SELECT ID_Comanda, COALESCE(Importe_Total,0) AS imp
              FROM Pagos, rng
              WHERE datetime(Fecha_Hora) >= rng.start_dt
                AND datetime(Fecha_Hora) <  rng.end_dt
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
              ROUND(COALESCE(SUM(total),0),2) AS ventas_total,
              ROUND(COALESCE(AVG(total),0),2) AS ticket_medio
            FROM comanda_tot
            GROUP BY id_trabajador;
            "#,
            start = start_expr,
            end = end_expr
        );

        let mut rows_s = db.query(&sql_sales, ()).await.map_err(|e| e.to_string())?;

        while let Ok(Some(r)) = rows_s.next().await {
            let id_trab = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let ventas = v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);
            let ticket = v_f64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0.0);

            if !id_trab.is_empty() {
                cam_ventas_total.insert(id_trab.clone(), ventas);
                cam_ticket_medio.insert(id_trab, ticket);
            }
        }

        let has_salida = table_has_column(db, "Fichajes", "Hora_Salida").await?;

        let ent2_col: Option<&'static str> =
            if table_has_column(db, "Fichajes", "Hora_Entrada_2").await? {
                Some("Hora_Entrada_2")
            } else if table_has_column(db, "Fichajes", "Hora_Entrada2").await? {
                Some("Hora_Entrada2")
            } else {
                None
            };

        let sal2_col: Option<&'static str> =
            if table_has_column(db, "Fichajes", "Hora_Salida_2").await? {
                Some("Hora_Salida_2")
            } else if table_has_column(db, "Fichajes", "Hora_Salida2").await? {
                Some("Hora_Salida2")
            } else {
                None
            };

        if has_salida {
            let ent1_dt = fichaje_dt_sql("Hora_Entrada");
            let sal1_dt = fichaje_dt_sql("Hora_Salida");

            let mut second_term = String::new();

            if let (Some(e2), Some(s2)) = (ent2_col, sal2_col) {
                let e2_dt = fichaje_dt_sql(e2);
                let s2_dt = fichaje_dt_sql(s2);

                second_term = format!(
                    r#"
                    + CASE
                        WHEN f.{e2} IS NOT NULL AND f.{s2} IS NOT NULL
                         AND {e2_dt} >= rng.start_dt
                         AND {e2_dt} <  rng.end_dt
                        THEN max(0, (julianday({s2_dt}) - julianday({e2_dt})) * 24.0)
                        ELSE 0
                      END
                    "#,
                    e2 = e2,
                    s2 = s2,
                    e2_dt = e2_dt,
                    s2_dt = s2_dt
                );
            }

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
                      ELSE 0
                    END
                    {second_term}
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
                second_term = second_term
            );

            let mut rows_h = db.query(&sql_horas, ()).await.map_err(|e| e.to_string())?;

            while let Ok(Some(r)) = rows_h.next().await {
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

        while let Ok(Some(r)) = rows_pt.next().await {
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
                    ticket_medio_eur: None,
                });
            } else if w.rol == "Camarero" {
                let comandas = *cam_comandas_tomadas.get(&w.id_trabajador).unwrap_or(&0);
                let cobros = *cam_cobros.get(&w.id_trabajador).unwrap_or(&0);
                let ticket = *cam_ticket_medio.get(&w.id_trabajador).unwrap_or(&0.0);

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
                    ticket_medio_eur: Some(ticket),
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
                    ticket_medio_eur: None,
                });
            }
        }

        let mut ranking_pairs: Vec<(String, f64)> = Vec::new();

        for w in base.iter() {
            if w.rol != "Camarero" {
                continue;
            }

            let ventas = *cam_ventas_total.get(&w.id_trabajador).unwrap_or(&0.0);
            ranking_pairs.push((w.nombre.clone(), ventas));
        }

        ranking_pairs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut rank_labels: Vec<String> = Vec::new();
        let mut rank_values: Vec<f64> = Vec::new();

        for (n, v) in ranking_pairs.into_iter() {
            rank_labels.push(n);
            rank_values.push(v);
        }

        Ok(TrabajadoresStatsResponse {
            cocineros,
            camareros,
            limpieza,
            ranking_ventas: ChartSeriesF64Out {
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

        if !table_exists(db, "Clientes").await? {
            return Ok(ClientesStatsResponse {
                nuevos: 0,
                recurrentes: 0,
                no_recurrentes: 0,
                ticket_medio_cliente: 0.0,
                nuevos_por_bucket: ChartSeriesI64 {
                    labels: vec![],
                    values: vec![],
                },
                top_clientes_gasto: ChartSeriesF64Out {
                    labels: vec![],
                    values: vec![],
                },
            });
        }

        let has_created = table_has_column(db, "Clientes", "Created_At")
            .await
            .unwrap_or(false);
        let has_total_gastado = table_has_column(db, "Clientes", "Total_Gastado")
            .await
            .unwrap_or(false);
        let has_nombre = table_has_column(db, "Clientes", "Nombre")
            .await
            .unwrap_or(false);
        let has_id_cliente = table_has_column(db, "Clientes", "ID_Cliente")
            .await
            .unwrap_or(false);

        let mut nuevos: i64 = 0;
        let mut evo_labels: Vec<String> = vec![];
        let mut evo_values: Vec<i64> = vec![];

        if has_created {
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

            while let Ok(Some(r)) = rows_e.next().await {
                let b = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
                let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

                evo_labels.push(b);
                evo_values.push(n);
            }
        }

        let mut recurrentes: i64 = 0;
        let mut no_recurrentes: i64 = 0;
        let mut ticket_medio_cliente: f64 = 0.0;

        let can_sales = table_exists(db, "Pagos").await.unwrap_or(false)
            && table_exists(db, "Comandas").await.unwrap_or(false)
            && table_exists(db, "Reservas").await.unwrap_or(false)
            && table_has_column(db, "Pagos", "ID_Comanda")
                .await
                .unwrap_or(false)
            && table_has_column(db, "Pagos", "Fecha_Hora")
                .await
                .unwrap_or(false)
            && table_has_column(db, "Pagos", "Importe_Total")
                .await
                .unwrap_or(false)
            && table_has_column(db, "Comandas", "ID_Reserva")
                .await
                .unwrap_or(false)
            && table_has_column(db, "Reservas", "ID_Reserva")
                .await
                .unwrap_or(false)
            && table_has_column(db, "Reservas", "ID_Cliente")
                .await
                .unwrap_or(false);

        if can_sales {
            let sql_rec = format!(
                r#"
                WITH
                rng AS (SELECT {start} AS start_dt, {end} AS end_dt),
                allp AS (
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
                  ROUND(COALESCE((SELECT SUM(total) FROM tot_range),0),2) AS ventas_total,
                  (SELECT COUNT(*) FROM cust_range) AS clientes_rango
                ;
                "#,
                start = start_expr,
                end = end_expr
            );

            let mut rows_r = db.query(&sql_rec, ()).await.map_err(|e| e.to_string())?;

            let mut ventas_total: f64 = 0.0;
            let mut clientes_rango: i64 = 0;

            if let Some(r) = rows_r.next().await.map_err(|e| e.to_string())? {
                recurrentes = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
                no_recurrentes = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);
                ventas_total = v_f64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0.0);
                clientes_rango = v_i64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0);
            }

            ticket_medio_cliente = if clientes_rango > 0 {
                (ventas_total / (clientes_rango as f64) * 100.0).round() / 100.0
            } else {
                0.0
            };
        }

        let mut top_labels: Vec<String> = vec![];
        let mut top_values: Vec<f64> = vec![];

        if has_total_gastado && has_id_cliente {
            let name_expr = if has_nombre {
                "CASE WHEN COALESCE(trim(Nombre),'') <> '' THEN trim(Nombre) ELSE 'Cliente' END"
            } else {
                "'Cliente'"
            };

            let sql_top = format!(
                r#"
                SELECT
                  ({name_expr} || ' #' || CAST(ID_Cliente AS TEXT)) AS nombre,
                  ROUND(COALESCE(Total_Gastado,0),2) AS total
                FROM Clientes
                ORDER BY COALESCE(Total_Gastado,0) DESC, nombre ASC
                LIMIT 10;
                "#,
                name_expr = name_expr
            );

            let mut rows_t = db.query(&sql_top, ()).await.map_err(|e| e.to_string())?;

            while let Ok(Some(r)) = rows_t.next().await {
                let name = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
                let total = v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);

                top_labels.push(name);
                top_values.push((total * 100.0).round() / 100.0);
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
            top_clientes_gasto: ChartSeriesF64Out {
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

        if !table_exists(db, "Cuentas_Gastos").await? {
            return Ok(ProveedoresStatsResponse {
                total_gasto: 0.0,
                num_gastos: 0,
                gasto_medio: 0.0,
                porcentaje_sobre_total_gastos: 0.0,
                proveedor_top: None,
                gastos_evolucion: ChartSeriesF64Out {
                    labels: vec![],
                    values: vec![],
                },
                gasto_por_proveedor: ChartSeriesF64Out {
                    labels: vec![],
                    values: vec![],
                },
                ultimos_gastos: vec![],
            });
        }

        let has_fecha = table_has_column(db, "Cuentas_Gastos", "Fecha")
            .await
            .unwrap_or(false);
        let has_importe = table_has_column(db, "Cuentas_Gastos", "Importe")
            .await
            .unwrap_or(false);

        if !has_fecha || !has_importe {
            return Ok(ProveedoresStatsResponse {
                total_gasto: 0.0,
                num_gastos: 0,
                gasto_medio: 0.0,
                porcentaje_sobre_total_gastos: 0.0,
                proveedor_top: None,
                gastos_evolucion: ChartSeriesF64Out {
                    labels: vec![],
                    values: vec![],
                },
                gasto_por_proveedor: ChartSeriesF64Out {
                    labels: vec![],
                    values: vec![],
                },
                ultimos_gastos: vec![],
            });
        }

        let has_id_prov = table_has_column(db, "Cuentas_Gastos", "ID_Proveedor")
            .await
            .unwrap_or(false);
        let has_tipo = table_has_column(db, "Cuentas_Gastos", "Tipo_Gasto")
            .await
            .unwrap_or(false);
        let has_concepto = table_has_column(db, "Cuentas_Gastos", "Concepto")
            .await
            .unwrap_or(false);
        let has_proveedores_table = table_exists(db, "Proveedores").await.unwrap_or(false);

        let dt_expr = "CASE WHEN cg.Fecha LIKE '%:%' THEN datetime(cg.Fecha) ELSE datetime(cg.Fecha || ' 00:00:00') END";
        let bucket_expr = bucket_sql_datetime(args.range, dt_expr);

        let supplier_filter = if has_id_prov && has_tipo {
            "AND (cg.ID_Proveedor IS NOT NULL OR lower(cg.Tipo_Gasto) LIKE '%proveedor%')"
        } else if has_id_prov {
            "AND (cg.ID_Proveedor IS NOT NULL)"
        } else if has_tipo {
            "AND (lower(cg.Tipo_Gasto) LIKE '%proveedor%')"
        } else {
            return Ok(ProveedoresStatsResponse {
                total_gasto: 0.0,
                num_gastos: 0,
                gasto_medio: 0.0,
                porcentaje_sobre_total_gastos: 0.0,
                proveedor_top: None,
                gastos_evolucion: ChartSeriesF64Out {
                    labels: vec![],
                    values: vec![],
                },
                gasto_por_proveedor: ChartSeriesF64Out {
                    labels: vec![],
                    values: vec![],
                },
                ultimos_gastos: vec![],
            });
        };

        let sql_total_all = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total
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
        let total_all: f64 = match rows_all.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_f64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0.0),
            None => 0.0,
        };

        let sql_total = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total,
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
                v_f64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0.0),
                v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            ),
            None => (0.0, 0),
        };

        let gasto_medio = if num_gastos > 0 {
            ((total_gasto / (num_gastos as f64)) * 100.0).round() / 100.0
        } else {
            0.0
        };

        let porcentaje_sobre_total_gastos = if total_all.abs() > 0.000001 {
            ((total_gasto / total_all) * 100.0 * 100.0).round() / 100.0
        } else {
            0.0
        };

        let name_expr = if has_id_prov && has_proveedores_table {
            r#"
            CASE
              WHEN cg.ID_Proveedor IS NOT NULL THEN
                COALESCE(NULLIF(trim(p.Nombre_Empresa),''), ('Proveedor #' || CAST(cg.ID_Proveedor AS TEXT)))
              ELSE 'Sin proveedor'
            END
            "#
        } else if has_id_prov {
            r#"
            CASE
              WHEN cg.ID_Proveedor IS NOT NULL THEN ('Proveedor #' || CAST(cg.ID_Proveedor AS TEXT))
              ELSE 'Sin proveedor'
            END
            "#
        } else {
            "'Proveedor'"
        };

        let join_prov = if has_id_prov && has_proveedores_table {
            "LEFT JOIN Proveedores p ON p.ID_Proveedor = cg.ID_Proveedor"
        } else {
            ""
        };

        let sql_top = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              {name_expr} AS proveedor,
              ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total
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
                    total: v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0),
                }),
                None => None,
            };

        let sql_evo = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              {bucket} AS b,
              ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total
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
        let mut evo_values: Vec<f64> = vec![];

        while let Ok(Some(r)) = rows_e.next().await {
            evo_labels
                .push(v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default());
            evo_values.push(
                (v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0) * 100.0).round()
                    / 100.0,
            );
        }

        let sql_bar = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              {name_expr} AS proveedor,
              ROUND(COALESCE(SUM(COALESCE(cg.Importe,0)),0),2) AS total
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
        let mut bar_values: Vec<f64> = vec![];

        while let Ok(Some(r)) = rows_b.next().await {
            bar_labels
                .push(v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default());
            bar_values.push(
                (v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0) * 100.0).round()
                    / 100.0,
            );
        }

        let concepto_expr = if has_concepto {
            "COALESCE(cg.Concepto,'')"
        } else {
            "''"
        };

        let sql_last = format!(
            r#"
            WITH rng AS (SELECT {start} AS start_dt, {end} AS end_dt)
            SELECT
              strftime('%Y-%m-%d', {dt}) AS fecha,
              {name_expr} AS proveedor,
              {concepto_expr} AS concepto,
              ROUND(COALESCE(cg.Importe,0),2) AS importe
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

        while let Ok(Some(r)) = rows_last.next().await {
            let fecha = v_string(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();
            let proveedor =
                v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_else(|| "—".into());
            let concepto = v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();
            let importe = v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0.0);

            ultimos_gastos.push(UltimoGastoProveedor {
                fecha,
                proveedor,
                concepto,
                importe: (importe * 100.0).round() / 100.0,
            });
        }

        Ok(ProveedoresStatsResponse {
            total_gasto: (total_gasto * 100.0).round() / 100.0,
            num_gastos,
            gasto_medio,
            porcentaje_sobre_total_gastos,
            proveedor_top,
            gastos_evolucion: ChartSeriesF64Out {
                labels: evo_labels,
                values: evo_values,
            },
            gasto_por_proveedor: ChartSeriesF64Out {
                labels: bar_labels,
                values: bar_values,
            },
            ultimos_gastos,
        })
    }
}
