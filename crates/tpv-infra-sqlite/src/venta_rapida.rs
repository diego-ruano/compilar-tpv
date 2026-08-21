//! Adaptador SQLite del repositorio de **venta rápida** (barra). Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id ni ramas remote_id.

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow, StockLinea,
    VerTicketsDetalleRow,
};
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, v_f64, v_i64, v_string};
use crate::util::{new_id, CANAL_BARRA};

pub struct SqliteVentaRapidaRepository {
    db: Arc<Db>,
}

impl SqliteVentaRapidaRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn clamp_pending_sql(expr: &str) -> String {
    format!("CASE WHEN ({e}) < 0 THEN 0 ELSE ({e}) END", e = expr)
}

fn update_total_comanda_sql() -> &'static str {
    r#"
    UPDATE Comandas
    SET Total_Comanda = (
      SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
      FROM Detalle_Comanda
      WHERE ID_Comanda = ?1
    )
    WHERE ID_Comanda = ?1;
    "#
}

#[allow(dead_code)]
async fn exists_by_id<C: Reader>(
    conn: &C,
    table: &str,
    column: &str,
    id: &str,
) -> AppResult<bool> {
    if id.trim().is_empty() {
        return Ok(false);
    }
    let sql = format!("SELECT 1 FROM {table} WHERE {column} = ?1 LIMIT 1;");
    let mut rows = conn
        .query(&sql, vec![Value::Text(id.to_string())])
        .await
        .map_err(db_err)?;
    Ok(rows.next().await.map_err(db_err)?.is_some())
}

async fn trabajador_id_from_usuario<C: Reader>(
    db: &C,
    id_usuario: Option<String>,
) -> AppResult<Option<String>> {
    let Some(idu) = id_usuario.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    let mut rows = db
        .query(
            "SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario=?1 LIMIT 1;",
            vec![Value::Text(idu)],
        )
        .await
        .map_err(db_err)?;
    if let Some(r) = rows.next().await.map_err(db_err)? {
        return Ok(norm_opt_string(r.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

async fn resolve_trabajador_id_input<C: Reader>(
    db: &C,
    id_maybe: Option<String>,
) -> AppResult<Option<String>> {
    let Some(x) = id_maybe.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    let mut rows = db
        .query(
            "SELECT 1 FROM Trabajadores WHERE ID_Trabajador=?1 LIMIT 1;",
            vec![Value::Text(x.clone())],
        )
        .await
        .map_err(db_err)?;
    if rows.next().await.map_err(db_err)?.is_some() {
        return Ok(Some(x));
    }
    trabajador_id_from_usuario(db, Some(x)).await
}

async fn trabajador_id_from_comanda<C: Reader>(db: &C, id_comanda: &str) -> AppResult<Option<String>> {
    if id_comanda.trim().is_empty() {
        return Ok(None);
    }
    let mut rows = db
        .query(
            "SELECT ID_Trabajador FROM Comandas WHERE ID_Comanda=?1 LIMIT 1;",
            vec![Value::Text(id_comanda.to_string())],
        )
        .await
        .map_err(db_err)?;
    if let Some(r) = rows.next().await.map_err(db_err)? {
        return Ok(norm_opt_string(r.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

/// Último ticket de barra abierto (el más reciente). La venta rápida admite VARIOS tickets
/// abiertos a la vez; esto solo resuelve el "get_or_create", que reengancha con el último.
async fn find_open_barra_comanda_id<C: Reader>(db: &C) -> AppResult<Option<String>> {
    let mut rows = db
        .query(
            r#"
            SELECT ID_Comanda
            FROM Comandas
            WHERE Canal = ?1
              AND Estado = 'Abierta'
            ORDER BY datetime(Fecha_Hora_Apertura) DESC
            LIMIT 1;
            "#,
            vec![Value::Text(CANAL_BARRA.to_string())],
        )
        .await
        .map_err(db_err)?;
    let Some(r) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    Ok(norm_opt_string(r.get_value(0).map_err(db_err)?))
}

#[async_trait]
impl VentaRapidaRepository for SqliteVentaRapidaRepository {
    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible
                FROM Categorias_Producto
                WHERE COALESCE(Vendible,1)=1
                ORDER BY Nombre ASC;
                "#,
                (),
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(CategoriaRow {
                ID_Categoria: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                Nombre: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre_Imagen: v_string(r.get_value(2).map_err(db_err)?),
                Ruta_Imagen: v_string(r.get_value(3).map_err(db_err)?),
                Vendible: v_i64(r.get_value(4).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn list_productos_by_categoria(&self, id_categoria: &str) -> AppResult<Vec<ProductoRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.Nombre,
                  COALESCE(p.Precio_Venta,0) AS Precio_Venta,
                  COALESCE(v.Stock_Actual,0) + COALESCE(p.Stock_Suelto,0) AS Stock_Actual,
                  COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
                  p.Unidad_Medida,
                  p.Nombre_Imagen,
                  p.Ruta_Imagen
                FROM Productos p
                JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
                LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
                WHERE p.ID_Categoria = ?1
                  AND COALESCE(c.Vendible,1)=1
                ORDER BY p.Nombre ASC;
                "#,
                vec![Value::Text(id_categoria.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ProductoRow {
                ID_Producto: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                ID_Categoria: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                Precio_Venta: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(0.0),
                Stock_Actual: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Stock_Minimo: v_f64(r.get_value(5).map_err(db_err)?).unwrap_or(0.0),
                Unidad_Medida: v_string(r.get_value(6).map_err(db_err)?),
                Nombre_Imagen: v_string(r.get_value(7).map_err(db_err)?),
                Ruta_Imagen: v_string(r.get_value(8).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn search_productos(&self, query: String, limit: i64) -> AppResult<Vec<ProductoRow>> {
        let g = self.db.read().await;
        let db = &g;
        let like = format!("%{}%", query);
        let mut rows = db
            .query(
                r#"
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.Nombre,
                  COALESCE(p.Precio_Venta,0) AS Precio_Venta,
                  COALESCE(v.Stock_Actual,0) + COALESCE(p.Stock_Suelto,0) AS Stock_Actual,
                  COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
                  p.Unidad_Medida,
                  p.Nombre_Imagen,
                  p.Ruta_Imagen
                FROM Productos p
                JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
                LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
                WHERE p.Nombre LIKE ?1
                  AND COALESCE(c.Vendible,1)=1
                ORDER BY p.Nombre ASC
                LIMIT ?2;
                "#,
                vec![Value::Text(like), Value::Integer(limit)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ProductoRow {
                ID_Producto: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                ID_Categoria: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                Precio_Venta: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(0.0),
                Stock_Actual: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Stock_Minimo: v_f64(r.get_value(5).map_err(db_err)?).unwrap_or(0.0),
                Unidad_Medida: v_string(r.get_value(6).map_err(db_err)?),
                Nombre_Imagen: v_string(r.get_value(7).map_err(db_err)?),
                Ruta_Imagen: v_string(r.get_value(8).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn list_comandas_barra(
        &self,
        include_pagadas: bool,
        limit: Option<i64>,
    ) -> AppResult<Vec<ComandaBarraRow>> {
        let g = self.db.read().await;
        let db = &g;
        let lim = limit.unwrap_or(60).clamp(1, 200);

        let pending_expr = clamp_pending_sql(
            "COALESCE(c.Total_Comanda,0) - COALESCE((SELECT SUM(p.Importe_Total) FROM Pagos p WHERE p.ID_Comanda = c.ID_Comanda), 0)",
        );

        let where_clause = if include_pagadas {
            "EXISTS (SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda)".to_string()
        } else {
            format!(
                "({}) > 0 AND EXISTS (SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda)",
                pending_expr
            )
        };

        let sql = format!(
            r#"
            SELECT
              c.ID_Comanda,
              c.Fecha_Hora_Apertura,
              c.Estado,
              ROUND({pending_expr}, 2) AS Total_Pendiente,
              ROUND(COALESCE(c.Total_Comanda,0), 2) AS Total_Comanda,
              COALESCE((
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
                LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND COALESCE(cat.Pasa_Cocina,0)=1
                  AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
              ),0) AS Pendientes_Cocina,
              COALESCE((
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
              ),0) AS Pendientes_Pago
            FROM Comandas c
            WHERE c.Canal = ?2
              AND ({where_clause})
            ORDER BY c.ID_Comanda DESC
            LIMIT ?1;
            "#,
            pending_expr = pending_expr,
            where_clause = where_clause
        );

        let mut rows = db
            .query(
                &sql,
                vec![Value::Integer(lim), Value::Text(CANAL_BARRA.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ComandaBarraRow {
                ID_Comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                Fecha_Hora_Apertura: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Estado: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_else(|| "Abierta".into()),
                Total_Pendiente: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(0.0),
                Total_Comanda: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Pendientes_Cocina: v_i64(r.get_value(5).map_err(db_err)?).unwrap_or(0),
                Pendientes_Pago: v_i64(r.get_value(6).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<LineaComandaRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT
                  dc.ID_Detalle,
                  dc.ID_Comanda,
                  dc.ID_Producto,
                  COALESCE(dc.Cantidad,1) AS Cantidad,
                  COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
                  dc.Notas,
                  dc.Estado_Cocina,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
                  ) THEN 1 ELSE 0 END AS Pagado,
                  COALESCE(p.Nombre, 'Producto') AS Nombre,
                  dc.IVA_Percent
                FROM Detalle_Comanda dc
                LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                WHERE dc.ID_Comanda = ?1
                ORDER BY dc.ID_Detalle ASC;
                "#,
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(LineaComandaRow {
                ID_Detalle: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                ID_Comanda: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                ID_Producto: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                Cantidad: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(1.0),
                Precio_Unitario: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Notas: v_string(r.get_value(5).map_err(db_err)?),
                Estado_Cocina: v_string(r.get_value(6).map_err(db_err)?),
                Pagado: v_i64(r.get_value(7).map_err(db_err)?).unwrap_or(0),
                Nombre: v_string(r.get_value(8).map_err(db_err)?).unwrap_or_else(|| "Producto".into()),
                IVA_Percent: v_f64(r.get_value(9).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn get_index_rows(&self, ids: Vec<String>) -> AppResult<Vec<IndexRow>> {
        let g = self.db.read().await;
        let db = &g;
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let params: Vec<Value> = ids.into_iter().map(Value::Text).collect();

        let sql = format!(
            r#"
            SELECT
              x.ID_Comanda AS ID_Comanda,
              (
                SELECT GROUP_CONCAT(nn.Nombre, ' · ')
                FROM (
                  SELECT DISTINCT COALESCE(p2.Nombre,'') AS Nombre
                  FROM Detalle_Comanda dc2
                  LEFT JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
                  WHERE dc2.ID_Comanda = x.ID_Comanda
                  ORDER BY COALESCE(p2.Nombre,'')
                ) nn
                WHERE nn.Nombre <> ''
              ) AS Productos,
              x.NumLineas AS NumLineas,
              x.Unidades AS Unidades
            FROM (
              SELECT
                dc.ID_Comanda AS ID_Comanda,
                COUNT(*) AS NumLineas,
                COALESCE(SUM(COALESCE(dc.Cantidad,1)),0) AS Unidades
              FROM Detalle_Comanda dc
              WHERE dc.ID_Comanda IN ({})
              GROUP BY dc.ID_Comanda
            ) x;
            "#,
            placeholders
        );

        let mut rows = db.query(&sql, params).await.map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let productos = match r.get_value(1).map_err(db_err)? {
                Value::Null => None,
                Value::Text(s) => {
                    let t = s.trim().to_string();
                    if t.is_empty() {
                        None
                    } else {
                        Some(t)
                    }
                }
                _ => None,
            };

            out.push(IndexRow {
                ID_Comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                Productos: productos,
                NumLineas: v_i64(r.get_value(2).map_err(db_err)?).unwrap_or(0),
                Unidades: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(0.0),
            });
        }
        Ok(out)
    }

    async fn get_detalles_ver_ticket(
        &self,
        id_comanda: &str,
    ) -> AppResult<Vec<VerTicketsDetalleRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT
                  dc.ID_Detalle,
                  dc.ID_Producto,
                  COALESCE(p.Nombre,'Producto') AS Nombre,
                  COALESCE(dc.Cantidad,1) AS Cantidad,
                  COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
                  COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
                  CASE WHEN EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                       THEN 1 ELSE 0 END AS Pagado,
                  dc.Notas,
                  dc.IVA_Percent
                FROM Detalle_Comanda dc
                LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                WHERE dc.ID_Comanda = ?1
                ORDER BY dc.ID_Detalle ASC;
                "#,
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(VerTicketsDetalleRow {
                ID_Detalle: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                ID_Producto: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_else(|| "Producto".into()),
                Cantidad: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(1.0),
                Precio_Unitario: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Estado_Cocina: v_string(r.get_value(5).map_err(db_err)?)
                    .unwrap_or_else(|| "PENDIENTE".into()),
                Pagado: v_i64(r.get_value(6).map_err(db_err)?).unwrap_or(0),
                Notas: v_string(r.get_value(7).map_err(db_err)?),
                IVA_Percent: v_f64(r.get_value(8).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn create_comanda_barra(
        &self,
        id_trabajador: Option<String>,
        get_or_create: bool,
    ) -> AppResult<String> {
        let g = self.db.write().await;
        let db = &g;

        if get_or_create {
            if let Some(existing_open) = find_open_barra_comanda_id(db).await? {
                return Ok(existing_open);
            }
        }

        let id_trabajador_real = resolve_trabajador_id_input(db, id_trabajador).await?;
        let id_comanda_final = new_id();

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<String> = async {
            // Ticket de venta rápida: SIN mesa (Canal='BARRA'). Ya no compite con otros tickets
            // abiertos, así que tampoco hace falta la antigua purga de comandas de barra vacías
            // (existía solo para esquivar el índice único que compartían todas por la mesa BARRA).
            db.execute(
                r#"
                INSERT INTO Comandas (
                  ID_Comanda, Fecha_Hora_Apertura, Estado, Total_Comanda, ID_Trabajador, ID_Mesa, Canal
                )
                VALUES (?1, datetime('now','localtime'), 'Abierta', 0, ?2, NULL, ?3)
                ON CONFLICT(ID_Comanda) DO UPDATE SET
                  Estado = excluded.Estado,
                  Total_Comanda = COALESCE(Comandas.Total_Comanda, excluded.Total_Comanda),
                  ID_Trabajador = excluded.ID_Trabajador,
                  ID_Mesa = excluded.ID_Mesa,
                  Canal = excluded.Canal;
                "#,
                vec![
                    Value::Text(id_comanda_final.clone()),
                    id_trabajador_real.map(Value::Text).unwrap_or(Value::Null),
                    Value::Text(CANAL_BARRA.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;

            Ok(id_comanda_final)
        }
        .await;

        match res {
            Ok(id) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(id)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
        precio_unitario: f64,
    ) -> AppResult<String> {
        let g = self.db.write().await;
        let db = &g;
        let id_detalle_final = new_id();

        // El tipo de IVA se lee ANTES y se inserta como literal (igual que `Estado_Cocina`): una
        // subconsulta dentro del INSERT la reevaluaría la nube en otro estado. Y se guarda en la
        // línea porque una reimpresión tiene que enseñar el tipo del día de la venta, no el de hoy.
        let iva = {
            let r = self.db.read().await;
            let mut rows = r
                .conn()
                .query(
                    "SELECT IVA_Percent FROM Productos WHERE ID_Producto = ?1 LIMIT 1;",
                    vec![Value::Text(id_producto.to_string())],
                )
                .await
                .map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => v_f64(row.get_value(0).map_err(db_err)?)
                    .map(Value::Real)
                    .unwrap_or(Value::Null),
                None => Value::Null,
            }
        };

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<String> = async {
            db.execute(
                r#"
                INSERT INTO Detalle_Comanda
                  (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, Notas, Estado_Cocina,
                   IVA_Percent)
                VALUES
                  (?1, ?2, ?3, ?4, ?5, NULL, 'PENDIENTE', ?6)
                ON CONFLICT(ID_Detalle) DO UPDATE SET
                  ID_Comanda = excluded.ID_Comanda,
                  ID_Producto = excluded.ID_Producto,
                  Cantidad = excluded.Cantidad,
                  Precio_Unitario = excluded.Precio_Unitario,
                  IVA_Percent = excluded.IVA_Percent,
                  Estado_Cocina = COALESCE(Detalle_Comanda.Estado_Cocina, excluded.Estado_Cocina);
                "#,
                vec![
                    Value::Text(id_detalle_final.clone()),
                    Value::Text(id_comanda.to_string()),
                    Value::Text(id_producto.to_string()),
                    Value::Real(cantidad),
                    Value::Real(precio_unitario),
                    iva,
                ],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;

            Ok(id_detalle_final)
        }
        .await;

        match res {
            Ok(id) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(id)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn remove_last_unpaid_linea(
        &self,
        id_comanda: &str,
        id_producto: &str,
    ) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            db.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle = (
                  SELECT dc.ID_Detalle
                  FROM Detalle_Comanda dc
                  LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                  WHERE dc.ID_Comanda = ?1
                    AND dc.ID_Producto = ?2
                    AND pd.ID_Detalle IS NULL
                  ORDER BY dc.ID_Detalle DESC
                  LIMIT 1
                );
                "#,
                vec![Value::Text(id_comanda.to_string()), Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;

            Ok(true)
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn delete_linea_if_unpaid(&self, id_comanda: &str, id_detalle: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            db.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle = ?1
                  AND ID_Comanda = ?2
                  AND NOT EXISTS (
                    SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = ?1
                  );
                "#,
                vec![Value::Text(id_detalle.to_string()), Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;

            Ok(true)
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn update_nota_detalle(&self, id_detalle: &str, nota: Option<String>) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        let affected = db
            .execute(
                "UPDATE Detalle_Comanda SET Notas = ?2 WHERE ID_Detalle = ?1;",
                vec![
                    Value::Text(id_detalle.to_string()),
                    nota.map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("Detalle no encontrado"));
        }
        Ok(true)
    }

    async fn cobrar_fraccionado(&self, data: CobroFraccionado) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        let id_pago_final = new_id();

        let id_usuario = data
            .id_usuario_cobrador
            .filter(|s| !s.trim().is_empty());
        let id_trabajador_from_user = trabajador_id_from_usuario(db, id_usuario.clone()).await?;
        let id_trabajador_comanda = trabajador_id_from_comanda(db, &data.id_comanda).await?;
        let id_trabajador_cobrador = data
            .id_trabajador_cobrador
            .filter(|s| !s.trim().is_empty())
            .or(id_trabajador_from_user)
            .or(id_trabajador_comanda);

        let detalles = data.detalles.clone();

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            if let Some(idt) = id_trabajador_cobrador.clone() {
                db.execute(
                    r#"
                    UPDATE Comandas
                    SET ID_Trabajador = ?2
                    WHERE ID_Comanda = ?1
                      AND ID_Trabajador IS NULL;
                    "#,
                    vec![Value::Text(data.id_comanda.clone()), Value::Text(idt)],
                )
                .await
                .map_err(db_err)?;
            }

            let placeholders = detalles.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                r#"
                SELECT
                  IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0) AS Importe,
                  COUNT(*) AS NumValid
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?1
                  AND dc.ID_Detalle IN ({})
                  AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                "#,
                placeholders
            );

            let mut params: Vec<Value> = Vec::with_capacity(1 + detalles.len());
            params.push(Value::Text(data.id_comanda.clone()));
            for d in &detalles {
                params.push(Value::Text(d.clone()));
            }

            let mut rows = db.query(&sql, params).await.map_err(db_err)?;
            let (importe_total_db, num_valid) = match rows.next().await.map_err(db_err)? {
                Some(r) => {
                    let imp = v_f64(r.get_value(0).map_err(db_err)?).unwrap_or(0.0);
                    let n = v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0);
                    (imp, n)
                }
                None => (0.0, 0),
            };

            if num_valid <= 0 {
                return Err(AppError::conflict("No hay detalles válidos pendientes de pago"));
            }

            // Capturamos los detalles a cobrar (detalle, producto, cantidad) para validar
            // stock y escribir Lote_Consumos por ID_Detalle (trazabilidad FEFO).
            let mut charged: Vec<(String, String, f64)> = Vec::new();
            {
                let mut crows = db
                    .query(
                        &format!(
                            r#"
                            SELECT dc.ID_Detalle, dc.ID_Producto, CAST(COALESCE(dc.Cantidad,1) AS REAL)
                            FROM Detalle_Comanda dc
                            WHERE dc.ID_Comanda = ?1
                              AND dc.ID_Detalle IN ({})
                              AND NOT EXISTS (
                                SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
                              )
                            ORDER BY dc.ID_Detalle;
                            "#,
                            placeholders
                        ),
                        {
                            let mut p: Vec<Value> = Vec::with_capacity(1 + detalles.len());
                            p.push(Value::Text(data.id_comanda.clone()));
                            for d in &detalles {
                                p.push(Value::Text(d.clone()));
                            }
                            p
                        },
                    )
                    .await
                    .map_err(db_err)?;

                while let Some(r) = crows.next().await.map_err(db_err)? {
                    let id_det = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
                    let id_prod = v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default();
                    let qty = v_f64(r.get_value(2).map_err(db_err)?).unwrap_or(0.0);
                    if !id_det.is_empty() && !id_prod.is_empty() && qty > 0.0 {
                        charged.push((id_det, id_prod, qty));
                    }
                }
            }

            // VR-04: NO se valida suficiencia ni se bloquea el cobro por falta de stock. Los lotes
            // se consumen FEFO (nunca quedan negativos); lo que no cubran se descuenta del stock
            // suelto del producto (que SÍ puede quedar negativo, como señal de sobreventa). Un
            // producto sin lotes y sin stock suelto configurado se vende sin descontar (no
            // inventariado). El exceso ya no aborta el cobro.

            db.execute(
                r#"
                INSERT INTO Pagos (
                  ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
                  ID_Usuario_Cobrador, ID_Trabajador_Cobrador
                )
                VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, 'FRACCIONADO', ?5, ?6)
                ON CONFLICT(ID_Pago) DO UPDATE SET
                  ID_Comanda = excluded.ID_Comanda,
                  Metodo_Pago = excluded.Metodo_Pago,
                  Importe_Total = excluded.Importe_Total,
                  Tipo = excluded.Tipo,
                  ID_Usuario_Cobrador = excluded.ID_Usuario_Cobrador,
                  ID_Trabajador_Cobrador = excluded.ID_Trabajador_Cobrador;
                "#,
                vec![
                    Value::Text(id_pago_final.clone()),
                    Value::Text(data.id_comanda.clone()),
                    Value::Text(data.metodo.clone()),
                    Value::Real(importe_total_db),
                    id_usuario.map(Value::Text).unwrap_or(Value::Null),
                    id_trabajador_cobrador.map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(db_err)?;

            for det in &detalles {
                db.execute(
                    r#"
                    INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
                    SELECT ?1, dc.ID_Detalle
                    FROM Detalle_Comanda dc
                    WHERE dc.ID_Comanda = ?2
                      AND dc.ID_Detalle = ?3
                      AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                    "#,
                    vec![
                        Value::Text(id_pago_final.clone()),
                        Value::Text(data.id_comanda.clone()),
                        Value::Text(det.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }

            // Consumo FEFO + trazabilidad por detalle (la suficiencia ya está validada).
            for (id_detalle, producto_id, cantidad) in &charged {
                let lot_rows: Vec<(String, f64)> = {
                    let mut lots = db
                        .query(
                            r#"
                            SELECT ID_Lote, COALESCE(Stock_Disponible,0)
                            FROM Lotes_Producto
                            WHERE ID_Producto = ?1
                              AND COALESCE(Stock_Disponible,0) > 0
                            ORDER BY
                              CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
                              date(Caducidad) ASC,
                              datetime(Fecha_Entrada) ASC,
                              ID_Lote ASC;
                            "#,
                            vec![Value::Text(producto_id.clone())],
                        )
                        .await
                        .map_err(db_err)?;

                    let mut o: Vec<(String, f64)> = Vec::new();
                    while let Some(r) = lots.next().await.map_err(db_err)? {
                        let id_lote = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
                        let stock = v_f64(r.get_value(1).map_err(db_err)?).unwrap_or(0.0);
                        if !id_lote.is_empty() && stock > 0.0 {
                            o.push((id_lote, stock));
                        }
                    }
                    o
                };

                let mut remaining = *cantidad;
                for (id_lote, stock) in lot_rows {
                    if remaining <= 0.0 {
                        break;
                    }
                    let take = if remaining < stock { remaining } else { stock };
                    if take <= 0.0 {
                        continue;
                    }

                    db.execute(
                        r#"
                        UPDATE Lotes_Producto
                        SET Stock_Disponible = COALESCE(Stock_Disponible,0) - ?2
                        WHERE ID_Lote = ?1;
                        "#,
                        vec![Value::Text(id_lote.clone()), Value::Real(take)],
                    )
                    .await
                    .map_err(db_err)?;

                    db.execute(
                        r#"
                        INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, Cantidad)
                        VALUES (?1, ?2, ?3)
                        ON CONFLICT(ID_Detalle, ID_Lote) DO NOTHING;
                        "#,
                        vec![Value::Text(id_detalle.clone()), Value::Text(id_lote), Value::Real(take)],
                    )
                    .await
                    .map_err(db_err)?;

                    remaining -= take;
                }

                // VR-04: lo que los lotes no cubrieron se descuenta del stock suelto del producto,
                // que puede quedar negativo (señal de sobreventa). Solo si el producto usa stock
                // suelto (Stock_Suelto IS NOT NULL); si no, la venta no descuenta más (no inventariado).
                if remaining > 0.0 {
                    db.execute(
                        "UPDATE Productos SET Stock_Suelto = Stock_Suelto - ?2 WHERE ID_Producto = ?1 AND Stock_Suelto IS NOT NULL;",
                        vec![Value::Text(producto_id.clone()), Value::Real(remaining)],
                    )
                    .await
                    .map_err(db_err)?;

                    // Y se anota, igual que se anota el consumo de lotes: sin esta traza, anular
                    // el pago devolvía los lotes y perdía esta parte para siempre (no había de
                    // dónde reconstruirla). El EXISTS repite la condición del UPDATE de arriba
                    // para no apuntar un consumo que no llegó a producirse — devolverlo luego
                    // sería inventar stock.
                    db.execute(
                        r#"
                        INSERT INTO Suelto_Consumos (ID_Detalle, ID_Producto, Cantidad)
                        SELECT ?1, ?2, ?3
                        WHERE EXISTS (
                            SELECT 1 FROM Productos
                            WHERE ID_Producto = ?2 AND Stock_Suelto IS NOT NULL
                        )
                        ON CONFLICT(ID_Detalle, ID_Producto) DO NOTHING;
                        "#,
                        vec![
                            Value::Text(id_detalle.clone()),
                            Value::Text(producto_id.clone()),
                            Value::Real(remaining),
                        ],
                    )
                    .await
                    .map_err(db_err)?;
                }
            }

            db.execute(update_total_comanda_sql(), vec![Value::Text(data.id_comanda.clone())])
                .await
                .map_err(db_err)?;

            let mut left = db
                .query(
                    r#"
                    SELECT COUNT(*)
                    FROM Detalle_Comanda dc
                    LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                    WHERE dc.ID_Comanda = ?1
                      AND pd.ID_Detalle IS NULL;
                    "#,
                    vec![Value::Text(data.id_comanda.clone())],
                )
                .await
                .map_err(db_err)?;

            let pending_left = match left.next().await.map_err(db_err)? {
                Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                None => 0,
            };

            if pending_left == 0 {
                db.execute(
                    r#"
                    UPDATE Comandas
                    SET
                      Estado = 'Pagada',
                      Total_Comanda = (
                        SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
                        FROM Detalle_Comanda
                        WHERE ID_Comanda = ?1
                      ),
                      Fecha_Hora_Cierre = datetime('now','localtime')
                    WHERE ID_Comanda = ?1;
                    "#,
                    vec![Value::Text(data.id_comanda.clone())],
                )
                .await
                .map_err(db_err)?;
            }

            Ok(true)
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn restar_stock(&self, lineas: Vec<StockLinea>) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            // VR-04: sin validación de suficiencia ni bloqueo (coherente con cobrar_fraccionado).
            // Se consume FEFO de los lotes (nunca negativos) y el resto va al stock suelto.
            for it in lineas.iter() {
                let mut remaining = it.cantidad;

                let mut lots = db
                    .query(
                        r#"
                        SELECT ID_Lote, COALESCE(Stock_Disponible,0) AS Stock
                        FROM Lotes_Producto
                        WHERE ID_Producto = ?1
                          AND COALESCE(Stock_Disponible,0) > 0
                        ORDER BY
                          CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
                          date(Caducidad) ASC,
                          datetime(Fecha_Entrada) ASC,
                          ID_Lote ASC;
                        "#,
                        vec![Value::Text(it.producto_id.clone())],
                    )
                    .await
                    .map_err(db_err)?;

                while remaining > 0.0 {
                    let row = lots.next().await.map_err(db_err)?;
                    let Some(r) = row else { break };

                    let id_lote = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
                    let stock = v_f64(r.get_value(1).map_err(db_err)?).unwrap_or(0.0);

                    if id_lote.is_empty() || stock <= 0.0 {
                        continue;
                    }

                    let take = if remaining < stock { remaining } else { stock };

                    // VR-06: descuento relativo sin clamp (igual que cobrar_fraccionado y que el
                    // worker), para que Main y nube converjan al aplicar el mismo delta. Aquí el
                    // `take` va acotado por el stock del lote, así que este camino propio no baja de
                    // cero; el clamp solo enmascaraba el delta replicado y rompía la convergencia.
                    db.execute(
                        r#"
                        UPDATE Lotes_Producto
                        SET Stock_Disponible = COALESCE(Stock_Disponible,0) - ?2
                        WHERE ID_Lote = ?1;
                        "#,
                        vec![Value::Text(id_lote), Value::Real(take)],
                    )
                    .await
                    .map_err(db_err)?;

                    remaining -= take;
                }

                // VR-04: sobrante tras los lotes → stock suelto (puede quedar negativo; solo si el
                // producto lo usa).
                if remaining > 0.0 {
                    db.execute(
                        "UPDATE Productos SET Stock_Suelto = Stock_Suelto - ?2 WHERE ID_Producto = ?1 AND Stock_Suelto IS NOT NULL;",
                        vec![Value::Text(it.producto_id.clone()), Value::Real(remaining)],
                    )
                    .await
                    .map_err(db_err)?;
                }
            }

            Ok(true)
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn delete_comanda_if_safe(&self, id_comanda: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            let mut rows = db
                .query(
                    r#"
                    SELECT EXISTS(
                      SELECT 1
                      FROM Detalle_Comanda dc
                      JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                      WHERE dc.ID_Comanda = ?1
                    ) AS HasPaid;
                    "#,
                    vec![Value::Text(id_comanda.to_string())],
                )
                .await
                .map_err(db_err)?;

            let has_paid: i64 = match rows.next().await.map_err(db_err)? {
                Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                None => 0,
            };

            if has_paid == 1 {
                return Err(AppError::conflict(
                    "La comanda tiene líneas pagadas y no se puede borrar",
                ));
            }

            db.execute(
                "DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1;",
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

            let changed = db
                .execute(
                    "DELETE FROM Comandas WHERE ID_Comanda = ?1;",
                    vec![Value::Text(id_comanda.to_string())],
                )
                .await
                .map_err(db_err)?;

            if changed == 0 {
                return Err(AppError::not_found("Comanda no encontrada"));
            }

            Ok(true)
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }
}
