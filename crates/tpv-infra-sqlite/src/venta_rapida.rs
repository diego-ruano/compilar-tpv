//! Adaptador SQLite del repositorio de **venta rápida** (barra). Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id ni ramas remote_id.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use libsql::{Connection, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::venta_rapida::VentaRapidaRepository;
use tpv_contracts::venta_rapida::{
    CategoriaRow, ComandaBarraRow, IndexRow, LineaComandaRow, ProductoRow, StockLinea,
    VerTicketsDetalleRow,
};
use tpv_domain::venta_rapida::CobroFraccionado;

use crate::mapping::{v_f64, v_i64, v_string};
use crate::util::next_table_id;

pub struct SqliteVentaRapidaRepository {
    conn: Arc<Connection>,
}

impl SqliteVentaRapidaRepository {
    pub fn new(conn: Arc<Connection>) -> Self {
        Self { conn }
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

async fn exists_by_id(
    conn: &Connection,
    table: &str,
    column: &str,
    id: i64,
) -> AppResult<bool> {
    if id <= 0 {
        return Ok(false);
    }
    let sql = format!("SELECT 1 FROM {table} WHERE {column} = ?1 LIMIT 1;");
    let mut rows = conn.query(&sql, vec![Value::Integer(id)]).await.map_err(db_err)?;
    Ok(rows.next().await.map_err(db_err)?.is_some())
}

async fn trabajador_id_from_usuario(
    db: &Connection,
    id_usuario: Option<i64>,
) -> AppResult<Option<i64>> {
    let Some(idu) = id_usuario.filter(|n| *n > 0) else {
        return Ok(None);
    };
    let mut rows = db
        .query(
            "SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario=?1 LIMIT 1;",
            vec![Value::Integer(idu)],
        )
        .await
        .map_err(db_err)?;
    if let Some(r) = rows.next().await.map_err(db_err)? {
        return Ok(v_i64(r.get_value(0).map_err(db_err)?).filter(|n| *n > 0));
    }
    Ok(None)
}

async fn resolve_trabajador_id_input(
    db: &Connection,
    id_maybe: Option<i64>,
) -> AppResult<Option<i64>> {
    let Some(x) = id_maybe.filter(|n| *n > 0) else {
        return Ok(None);
    };
    let mut rows = db
        .query(
            "SELECT 1 FROM Trabajadores WHERE ID_Trabajador=?1 LIMIT 1;",
            vec![Value::Integer(x)],
        )
        .await
        .map_err(db_err)?;
    if rows.next().await.map_err(db_err)?.is_some() {
        return Ok(Some(x));
    }
    trabajador_id_from_usuario(db, Some(x)).await
}

async fn trabajador_id_from_comanda(db: &Connection, id_comanda: i64) -> AppResult<Option<i64>> {
    if id_comanda <= 0 {
        return Ok(None);
    }
    let mut rows = db
        .query(
            "SELECT ID_Trabajador FROM Comandas WHERE ID_Comanda=?1 LIMIT 1;",
            vec![Value::Integer(id_comanda)],
        )
        .await
        .map_err(db_err)?;
    if let Some(r) = rows.next().await.map_err(db_err)? {
        return Ok(v_i64(r.get_value(0).map_err(db_err)?).filter(|n| *n > 0));
    }
    Ok(None)
}

async fn first_zone_id(db: &Connection) -> AppResult<i64> {
    let mut rows = db
        .query(
            "SELECT ID_Zona FROM Zonas ORDER BY ID_Zona ASC LIMIT 1;",
            (),
        )
        .await
        .map_err(db_err)?;
    let Some(r) = rows.next().await.map_err(db_err)? else {
        return Ok(0);
    };
    Ok(v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0))
}

async fn ensure_default_zone_id(db: &Connection) -> AppResult<i64> {
    let existing = first_zone_id(db).await?;
    if existing > 0 {
        return Ok(existing);
    }

    let insert_full = db
        .execute(
            r#"
            INSERT INTO Zonas (Nombre_Zona, Room_Points, Updated_At)
            VALUES ('Salon', '[]', datetime('now','localtime'));
            "#,
            (),
        )
        .await;

    if insert_full.is_err() {
        db.execute(
            "INSERT INTO Zonas (Nombre_Zona) VALUES ('Salon');",
            (),
        )
        .await
        .map_err(db_err)?;
    }

    let final_id = first_zone_id(db).await?;
    if final_id <= 0 {
        return Err(AppError::repository("No se pudo crear/encontrar zona por defecto."));
    }
    Ok(final_id)
}

async fn find_barra_mesa_id_raw(db: &Connection) -> AppResult<i64> {
    let mut rows = db
        .query(
            "SELECT ID_Mesa FROM Mesas WHERE Numero_Mesa = 'BARRA' LIMIT 1;",
            (),
        )
        .await
        .map_err(db_err)?;
    let id = match rows.next().await.map_err(db_err)? {
        Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
        None => 0,
    };
    Ok(id)
}

async fn ensure_barra_mesa_id(db: &Connection) -> AppResult<i64> {
    let existing = find_barra_mesa_id_raw(db).await?;
    if existing > 0 {
        return Ok(existing);
    }

    let id_zona = ensure_default_zone_id(db).await?;

    let insert_with_es_sistema = db
        .execute(
            r#"
            INSERT INTO Mesas (
              ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y,
              Shape, Width, Height, Radius, Updated_At, Es_Sistema
            )
            VALUES (?1, 'BARRA', 0, 0, 0, 'rect', 80, 50, NULL, datetime('now','localtime'), 1);
            "#,
            vec![Value::Integer(id_zona)],
        )
        .await;

    if insert_with_es_sistema.is_err() {
        db.execute(
            r#"
            INSERT INTO Mesas (
              ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y,
              Shape, Width, Height, Radius, Updated_At
            )
            VALUES (?1, 'BARRA', 0, 0, 0, 'rect', 80, 50, NULL, datetime('now','localtime'));
            "#,
            vec![Value::Integer(id_zona)],
        )
        .await
        .map_err(db_err)?;
    }

    let final_id = find_barra_mesa_id_raw(db).await?;
    if final_id <= 0 {
        return Err(AppError::repository("No se pudo crear/encontrar la mesa BARRA."));
    }
    Ok(final_id)
}

async fn find_open_barra_comanda_id(db: &Connection, id_mesa_barra: i64) -> AppResult<i64> {
    if id_mesa_barra <= 0 {
        return Ok(0);
    }
    let mut rows = db
        .query(
            r#"
            SELECT ID_Comanda
            FROM Comandas
            WHERE ID_Mesa = ?1
              AND Estado = 'Abierta'
            ORDER BY ID_Comanda DESC
            LIMIT 1;
            "#,
            vec![Value::Integer(id_mesa_barra)],
        )
        .await
        .map_err(db_err)?;
    let Some(r) = rows.next().await.map_err(db_err)? else {
        return Ok(0);
    };
    Ok(v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0))
}

#[async_trait]
impl VentaRapidaRepository for SqliteVentaRapidaRepository {
    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaRow>> {
        let db = &self.conn;
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
                ID_Categoria: v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                Nombre: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                Nombre_Imagen: v_string(r.get_value(2).map_err(db_err)?),
                Ruta_Imagen: v_string(r.get_value(3).map_err(db_err)?),
                Vendible: v_i64(r.get_value(4).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn list_productos_by_categoria(&self, id_categoria: i64) -> AppResult<Vec<ProductoRow>> {
        let db = &self.conn;
        let mut rows = db
            .query(
                r#"
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.Nombre,
                  COALESCE(p.Precio_Venta,0) AS Precio_Venta,
                  COALESCE(v.Stock_Actual,0) AS Stock_Actual,
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
                vec![Value::Integer(id_categoria)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ProductoRow {
                ID_Producto: v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                ID_Categoria: v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0),
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
        let db = &self.conn;
        let like = format!("%{}%", query);
        let mut rows = db
            .query(
                r#"
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.Nombre,
                  COALESCE(p.Precio_Venta,0) AS Precio_Venta,
                  COALESCE(v.Stock_Actual,0) AS Stock_Actual,
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
                ID_Producto: v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                ID_Categoria: v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0),
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
        let db = &self.conn;
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
            WHERE c.ID_Mesa = ?2
              AND ({where_clause})
            ORDER BY c.ID_Comanda DESC
            LIMIT ?1;
            "#,
            pending_expr = pending_expr,
            where_clause = where_clause
        );

        let id_mesa_barra = ensure_barra_mesa_id(db).await?;

        let mut rows = db
            .query(&sql, vec![Value::Integer(lim), Value::Integer(id_mesa_barra)])
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ComandaBarraRow {
                ID_Comanda: v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
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

    async fn get_lineas_comanda(&self, id_comanda: i64) -> AppResult<Vec<LineaComandaRow>> {
        let db = &self.conn;
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
                  COALESCE(p.Nombre, 'Producto') AS Nombre
                FROM Detalle_Comanda dc
                LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                WHERE dc.ID_Comanda = ?1
                ORDER BY dc.ID_Detalle ASC;
                "#,
                vec![Value::Integer(id_comanda)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(LineaComandaRow {
                ID_Detalle: v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                ID_Comanda: v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0),
                ID_Producto: v_i64(r.get_value(2).map_err(db_err)?).unwrap_or(0),
                Cantidad: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(1.0),
                Precio_Unitario: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Notas: v_string(r.get_value(5).map_err(db_err)?),
                Estado_Cocina: v_string(r.get_value(6).map_err(db_err)?),
                Pagado: v_i64(r.get_value(7).map_err(db_err)?).unwrap_or(0),
                Nombre: v_string(r.get_value(8).map_err(db_err)?).unwrap_or_else(|| "Producto".into()),
            });
        }
        Ok(out)
    }

    async fn get_index_rows(&self, ids: Vec<i64>) -> AppResult<Vec<IndexRow>> {
        let db = &self.conn;
        if ids.is_empty() {
            return Ok(vec![]);
        }

        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let params: Vec<Value> = ids.into_iter().map(Value::Integer).collect();

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
                ID_Comanda: v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                Productos: productos,
                NumLineas: v_i64(r.get_value(2).map_err(db_err)?).unwrap_or(0),
                Unidades: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(0.0),
            });
        }
        Ok(out)
    }

    async fn get_detalles_ver_ticket(
        &self,
        id_comanda: i64,
    ) -> AppResult<Vec<VerTicketsDetalleRow>> {
        let db = &self.conn;
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
                  dc.Notas
                FROM Detalle_Comanda dc
                LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                WHERE dc.ID_Comanda = ?1
                ORDER BY dc.ID_Detalle ASC;
                "#,
                vec![Value::Integer(id_comanda)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(VerTicketsDetalleRow {
                ID_Detalle: v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                ID_Producto: v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0),
                Nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_else(|| "Producto".into()),
                Cantidad: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(1.0),
                Precio_Unitario: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                Estado_Cocina: v_string(r.get_value(5).map_err(db_err)?)
                    .unwrap_or_else(|| "PENDIENTE".into()),
                Pagado: v_i64(r.get_value(6).map_err(db_err)?).unwrap_or(0),
                Notas: v_string(r.get_value(7).map_err(db_err)?),
            });
        }
        Ok(out)
    }

    async fn create_comanda_barra(
        &self,
        id_trabajador: Option<i64>,
        get_or_create: bool,
    ) -> AppResult<i64> {
        let db = &self.conn;
        let id_mesa_barra = ensure_barra_mesa_id(db).await?;

        if get_or_create {
            let existing_open = find_open_barra_comanda_id(db, id_mesa_barra).await?;
            if existing_open > 0 {
                return Ok(existing_open);
            }
        }

        let id_trabajador_real = resolve_trabajador_id_input(db, id_trabajador).await?;
        let id_comanda_final = next_table_id(db, "Comandas", "ID_Comanda").await?;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<i64> = async {
            db.execute(
                r#"
                INSERT INTO Comandas (
                  ID_Comanda, Fecha_Hora_Apertura, Estado, Total_Comanda, ID_Trabajador, ID_Mesa
                )
                VALUES (?1, datetime('now','localtime'), 'Abierta', 0, ?2, ?3)
                ON CONFLICT(ID_Comanda) DO UPDATE SET
                  Estado = excluded.Estado,
                  Total_Comanda = COALESCE(Comandas.Total_Comanda, excluded.Total_Comanda),
                  ID_Trabajador = excluded.ID_Trabajador,
                  ID_Mesa = excluded.ID_Mesa;
                "#,
                vec![
                    Value::Integer(id_comanda_final),
                    id_trabajador_real.map(Value::Integer).unwrap_or(Value::Null),
                    Value::Integer(id_mesa_barra),
                ],
            )
            .await
            .map_err(db_err)?;

            db.execute(
                r#"
                DELETE FROM Comandas
                WHERE ID_Mesa = ?1
                  AND ID_Comanda <> ?2
                  AND COALESCE(Total_Comanda,0) <= 0
                  AND NOT EXISTS (
                    SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = Comandas.ID_Comanda
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM Pagos p WHERE p.ID_Comanda = Comandas.ID_Comanda
                  );
                "#,
                vec![Value::Integer(id_mesa_barra), Value::Integer(id_comanda_final)],
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
        id_comanda: i64,
        id_producto: i64,
        cantidad: f64,
        precio_unitario: f64,
    ) -> AppResult<i64> {
        let db = &self.conn;
        let id_detalle_final = next_table_id(db, "Detalle_Comanda", "ID_Detalle").await?;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<i64> = async {
            db.execute(
                r#"
                INSERT INTO Detalle_Comanda
                  (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, Notas, Estado_Cocina)
                VALUES
                  (?1, ?2, ?3, ?4, ?5, NULL, 'PENDIENTE')
                ON CONFLICT(ID_Detalle) DO UPDATE SET
                  ID_Comanda = excluded.ID_Comanda,
                  ID_Producto = excluded.ID_Producto,
                  Cantidad = excluded.Cantidad,
                  Precio_Unitario = excluded.Precio_Unitario,
                  Estado_Cocina = COALESCE(Detalle_Comanda.Estado_Cocina, excluded.Estado_Cocina);
                "#,
                vec![
                    Value::Integer(id_detalle_final),
                    Value::Integer(id_comanda),
                    Value::Integer(id_producto),
                    Value::Real(cantidad),
                    Value::Real(precio_unitario),
                ],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Integer(id_comanda)])
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
        id_comanda: i64,
        id_producto: i64,
    ) -> AppResult<bool> {
        let db = &self.conn;

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
                vec![Value::Integer(id_comanda), Value::Integer(id_producto)],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Integer(id_comanda)])
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

    async fn delete_linea_if_unpaid(&self, id_comanda: i64, id_detalle: i64) -> AppResult<bool> {
        let db = &self.conn;

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
                vec![Value::Integer(id_detalle), Value::Integer(id_comanda)],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Integer(id_comanda)])
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

    async fn update_nota_detalle(&self, id_detalle: i64, nota: Option<String>) -> AppResult<bool> {
        let db = &self.conn;

        let affected = db
            .execute(
                "UPDATE Detalle_Comanda SET Notas = ?2 WHERE ID_Detalle = ?1;",
                vec![
                    Value::Integer(id_detalle),
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
        let db = &self.conn;

        let id_pago_final = next_table_id(db, "Pagos", "ID_Pago").await?;

        let id_usuario = data.id_usuario_cobrador.filter(|n| *n > 0);
        let id_trabajador_from_user = trabajador_id_from_usuario(db, id_usuario).await?;
        let id_trabajador_comanda = trabajador_id_from_comanda(db, data.id_comanda).await?;
        let id_trabajador_cobrador = data
            .id_trabajador_cobrador
            .filter(|n| *n > 0)
            .or(id_trabajador_from_user)
            .or(id_trabajador_comanda);

        let detalles = data.detalles.clone();

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            if let Some(idt) = id_trabajador_cobrador {
                db.execute(
                    r#"
                    UPDATE Comandas
                    SET ID_Trabajador = ?2
                    WHERE ID_Comanda = ?1
                      AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0);
                    "#,
                    vec![Value::Integer(data.id_comanda), Value::Integer(idt)],
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
            params.push(Value::Integer(data.id_comanda));
            for d in &detalles {
                params.push(Value::Integer(*d));
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
            let mut charged: Vec<(i64, i64, f64)> = Vec::new();
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
                            p.push(Value::Integer(data.id_comanda));
                            for d in &detalles {
                                p.push(Value::Integer(*d));
                            }
                            p
                        },
                    )
                    .await
                    .map_err(db_err)?;

                while let Some(r) = crows.next().await.map_err(db_err)? {
                    let id_det = v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0);
                    let id_prod = v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0);
                    let qty = v_f64(r.get_value(2).map_err(db_err)?).unwrap_or(0.0);
                    if id_det > 0 && id_prod > 0 && qty > 0.0 {
                        charged.push((id_det, id_prod, qty));
                    }
                }
            }

            // Validación de suficiencia (todo-o-nada): un producto controla stock si tiene
            // lotes; si lo solicitado supera el disponible total, abortamos el cobro.
            {
                let mut requested_by_product: BTreeMap<i64, f64> = BTreeMap::new();
                for (_d, p, q) in &charged {
                    *requested_by_product.entry(*p).or_insert(0.0) += *q;
                }

                for (producto_id, requested) in &requested_by_product {
                    let mut rows = db
                        .query(
                            r#"
                            SELECT
                              COUNT(*),
                              COALESCE(SUM(CAST(COALESCE(Stock_Disponible,0) AS REAL)), 0)
                            FROM Lotes_Producto
                            WHERE ID_Producto = ?1;
                            "#,
                            vec![Value::Integer(*producto_id)],
                        )
                        .await
                        .map_err(db_err)?;

                    let (n_lots, available) = match rows.next().await.map_err(db_err)? {
                        Some(r) => {
                            let n = v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0);
                            let a = v_f64(r.get_value(1).map_err(db_err)?).unwrap_or(0.0);
                            (n, a)
                        }
                        None => (0, 0.0),
                    };

                    if n_lots > 0 && *requested > available {
                        return Err(AppError::conflict(format!(
                            "insufficient_stock:{}:{}:{}",
                            producto_id, requested, available
                        )));
                    }
                }
            }

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
                    Value::Integer(id_pago_final),
                    Value::Integer(data.id_comanda),
                    Value::Text(data.metodo.clone()),
                    Value::Real(importe_total_db),
                    id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                    id_trabajador_cobrador.map(Value::Integer).unwrap_or(Value::Null),
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
                        Value::Integer(id_pago_final),
                        Value::Integer(data.id_comanda),
                        Value::Integer(*det),
                    ],
                )
                .await
                .map_err(db_err)?;
            }

            // Consumo FEFO + trazabilidad por detalle (la suficiencia ya está validada).
            for (id_detalle, producto_id, cantidad) in &charged {
                let lot_rows: Vec<(i64, f64)> = {
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
                            vec![Value::Integer(*producto_id)],
                        )
                        .await
                        .map_err(db_err)?;

                    let mut o: Vec<(i64, f64)> = Vec::new();
                    while let Some(r) = lots.next().await.map_err(db_err)? {
                        let id_lote = v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0);
                        let stock = v_f64(r.get_value(1).map_err(db_err)?).unwrap_or(0.0);
                        if id_lote > 0 && stock > 0.0 {
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
                        vec![Value::Integer(id_lote), Value::Real(take)],
                    )
                    .await
                    .map_err(db_err)?;

                    db.execute(
                        r#"
                        INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, Cantidad)
                        VALUES (?1, ?2, ?3)
                        ON CONFLICT(ID_Detalle, ID_Lote) DO NOTHING;
                        "#,
                        vec![Value::Integer(*id_detalle), Value::Integer(id_lote), Value::Real(take)],
                    )
                    .await
                    .map_err(db_err)?;

                    remaining -= take;
                }
            }

            db.execute(update_total_comanda_sql(), vec![Value::Integer(data.id_comanda)])
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
                    vec![Value::Integer(data.id_comanda)],
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
                    vec![Value::Integer(data.id_comanda)],
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
        let db = &self.conn;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            // Validación de suficiencia (todo-o-nada) antes de descontar.
            for it in lineas.iter() {
                let mut rows = db
                    .query(
                        r#"
                        SELECT
                          COUNT(*),
                          COALESCE(SUM(CAST(COALESCE(Stock_Disponible,0) AS REAL)), 0)
                        FROM Lotes_Producto
                        WHERE ID_Producto = ?1;
                        "#,
                        vec![Value::Integer(it.producto_id)],
                    )
                    .await
                    .map_err(db_err)?;

                let (n_lots, available) = match rows.next().await.map_err(db_err)? {
                    Some(r) => {
                        let n = v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0);
                        let a = v_f64(r.get_value(1).map_err(db_err)?).unwrap_or(0.0);
                        (n, a)
                    }
                    None => (0, 0.0),
                };

                if n_lots > 0 && it.cantidad > available {
                    return Err(AppError::conflict(format!(
                        "insufficient_stock:{}:{}:{}",
                        it.producto_id, it.cantidad, available
                    )));
                }
            }

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
                        vec![Value::Integer(it.producto_id)],
                    )
                    .await
                    .map_err(db_err)?;

                while remaining > 0.0 {
                    let row = lots.next().await.map_err(db_err)?;
                    let Some(r) = row else { break };

                    let id_lote = v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0);
                    let stock = v_f64(r.get_value(1).map_err(db_err)?).unwrap_or(0.0);

                    if id_lote <= 0 || stock <= 0.0 {
                        continue;
                    }

                    let take = if remaining < stock { remaining } else { stock };

                    db.execute(
                        r#"
                        UPDATE Lotes_Producto
                        SET Stock_Disponible = CASE
                          WHEN COALESCE(Stock_Disponible,0) - ?2 < 0 THEN 0
                          ELSE COALESCE(Stock_Disponible,0) - ?2
                        END
                        WHERE ID_Lote = ?1;
                        "#,
                        vec![Value::Integer(id_lote), Value::Real(take)],
                    )
                    .await
                    .map_err(db_err)?;

                    remaining -= take;
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

    async fn delete_comanda_if_safe(&self, id_comanda: i64) -> AppResult<bool> {
        let db = &self.conn;

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
                    vec![Value::Integer(id_comanda)],
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
                vec![Value::Integer(id_comanda)],
            )
            .await
            .map_err(db_err)?;

            let changed = db
                .execute(
                    "DELETE FROM Comandas WHERE ID_Comanda = ?1;",
                    vec![Value::Integer(id_comanda)],
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
