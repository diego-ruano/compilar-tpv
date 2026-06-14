//! Adaptador SQLite del repositorio de inventario. Local-First (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::{Row, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::inventario::InventarioRepository;
use tpv_contracts::inventario::{
    AlergenoInvDto, AlergenoMiniDto, CategoriaInvDto, InventarioResumenResponse, LoteDto,
    ProductDetailResponse, ProductoBaseDto, ProductoDetalleDto, ProductoListDto, ProductoResumenDto,
    ProveedorMiniDto,
};
use tpv_domain::inventario::{AjusteLote, CategoriaUpsert, LoteNuevo, ProductoUpsert};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_real, opt_text, v_f64, v_i64, v_string};
use crate::util::new_id;

pub struct SqliteInventarioRepository {
    db: Arc<Db>,
}

impl SqliteInventarioRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn s(v: Value) -> String {
    v_string(v).unwrap_or_default()
}
fn fl(v: Value) -> f64 {
    v_f64(v).unwrap_or(0.0)
}

fn map_producto_base(row: &Row) -> AppResult<ProductoBaseDto> {
    let g = |idx: i32| row.get_value(idx).map_err(db_err);
    Ok(ProductoBaseDto {
        id_producto: s(g(0)?),
        id_categoria: s(g(1)?),
        id_proveedor: norm_opt_string(g(2)?),
        nombre: s(g(3)?),
        precio_venta: v_f64(g(4)?),
        stock_minimo: v_f64(g(5)?),
        unidad_medida: v_string(g(6)?),
        nombre_imagen: v_string(g(7)?),
        ruta_imagen: v_string(g(8)?),
        cantidad_pedido_esperada: v_f64(g(9)?),
    })
}

fn map_producto_list(row: &Row) -> AppResult<ProductoListDto> {
    let g = |idx: i32| row.get_value(idx).map_err(db_err);
    let base = ProductoBaseDto {
        id_producto: s(g(0)?),
        id_categoria: s(g(1)?),
        id_proveedor: norm_opt_string(g(2)?),
        nombre: s(g(3)?),
        precio_venta: v_f64(g(4)?),
        stock_minimo: v_f64(g(6)?),
        unidad_medida: v_string(g(7)?),
        nombre_imagen: v_string(g(8)?),
        ruta_imagen: v_string(g(9)?),
        cantidad_pedido_esperada: v_f64(g(12)?),
    };
    Ok(ProductoListDto {
        base,
        stock_actual: v_f64(g(5)?),
        caducidad_proxima: v_string(g(10)?),
        lote_proximo: v_string(g(11)?),
    })
}

fn map_resumen(row: &Row) -> AppResult<ProductoResumenDto> {
    let g = |idx: i32| row.get_value(idx).map_err(db_err);
    Ok(ProductoResumenDto {
        nombre: s(g(0)?),
        stock_actual: v_f64(g(1)?),
        unidad_medida: v_string(g(2)?),
        caducidad_proxima: v_string(g(3)?),
        lote: v_string(g(4)?),
        precio_venta: v_f64(g(5)?),
    })
}

fn map_lote(row: &Row) -> AppResult<LoteDto> {
    let g = |idx: i32| row.get_value(idx).map_err(db_err);
    Ok(LoteDto {
        id_lote: s(g(0)?),
        id_producto: s(g(1)?),
        codigo_lote: s(g(2)?),
        fecha_entrada: s(g(3)?),
        caducidad: v_string(g(4)?),
        cantidad_inicial: fl(g(5)?),
        stock_disponible: fl(g(6)?),
        coste_unitario: v_f64(g(7)?),
        id_proveedor: norm_opt_string(g(8)?),
        notas: v_string(g(9)?),
    })
}

const SQL_PRODUCTO_BASE_COLS: &str = "ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada";

async fn fetch_producto<C: Reader>(
    conn: &C,
    id_producto: &str,
) -> AppResult<Option<ProductoBaseDto>> {
    let sql = format!("SELECT {SQL_PRODUCTO_BASE_COLS} FROM Productos WHERE ID_Producto=?1 LIMIT 1;");
    let mut rows = conn
        .query(&sql, vec![Value::Text(id_producto.to_string())])
        .await
        .map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        Ok(Some(map_producto_base(&row)?))
    } else {
        Ok(None)
    }
}

#[async_trait]
impl InventarioRepository for SqliteInventarioRepository {
    async fn list_categorias(&self) -> AppResult<Vec<CategoriaInvDto>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                "SELECT ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible, Pasa_Cocina FROM Categorias_Producto ORDER BY Nombre ASC;",
                (),
            )
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(CategoriaInvDto {
                id_categoria: s(g(0)?),
                nombre: s(g(1)?),
                nombre_imagen: v_string(g(2)?),
                ruta_imagen: v_string(g(3)?),
                vendible: v_i64(g(4)?),
                pasa_cocina: v_i64(g(5)?),
            });
        }
        Ok(out)
    }

    async fn list_proveedores_mini(&self) -> AppResult<Vec<ProveedorMiniDto>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                "SELECT ID_Proveedor, Nombre_Empresa, Email FROM Proveedores ORDER BY Nombre_Empresa ASC;",
                (),
            )
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(ProveedorMiniDto {
                id_proveedor: s(g(0)?),
                nombre_empresa: s(g(1)?),
                email: v_string(g(2)?),
            });
        }
        Ok(out)
    }

    async fn list_productos_by_categoria(
        &self,
        id_categoria: &str,
    ) -> AppResult<Vec<ProductoListDto>> {
        let sql = r#"
          SELECT
            p.ID_Producto, p.ID_Categoria, p.ID_Proveedor, p.Nombre, p.Precio_Venta,
            (SELECT COALESCE(SUM(l.Stock_Disponible), 0) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) AS Stock_Actual,
            p.Stock_Minimo, p.Unidad_Medida, p.Nombre_Imagen, p.Ruta_Imagen,
            (SELECT l.Caducidad FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Caducidad_Proxima,
            (SELECT l.Codigo_Lote FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Lote_Proximo,
            p.Cantidad_Pedido_Esperada
          FROM Productos p
          WHERE p.ID_Categoria = ?1
          ORDER BY p.Nombre ASC;
        "#;
        let db = self.db.read().await;
        let mut rows = db
            .query(sql, vec![Value::Text(id_categoria.to_string())])
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(map_producto_list(&row)?);
        }
        Ok(out)
    }

    async fn resumen(&self, limit: i64) -> AppResult<InventarioResumenResponse> {
        let db = self.db.read().await;
        let mut cad = db
            .query(
                r#"
                SELECT p.Nombre, l.Stock_Disponible AS Stock_Actual, p.Unidad_Medida, l.Caducidad AS Caducidad_Proxima, l.Codigo_Lote AS Lote, p.Precio_Venta
                FROM Lotes_Producto l
                JOIN Productos p ON p.ID_Producto = l.ID_Producto
                WHERE l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL
                ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
                LIMIT ?1;
                "#,
                vec![Value::Integer(limit)],
            )
            .await
            .map_err(db_err)?;
        let mut proximos = Vec::new();
        while let Some(row) = cad.next().await.map_err(db_err)? {
            proximos.push(map_resumen(&row)?);
        }

        let mut low = db
            .query(
                r#"
                WITH base AS (
                  SELECT p.ID_Producto, p.Nombre, p.Unidad_Medida, p.Precio_Venta,
                    (SELECT COALESCE(SUM(l.Stock_Disponible), 0) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) AS Stock_Actual,
                    (SELECT l.Caducidad FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Caducidad_Proxima,
                    (SELECT l.Codigo_Lote FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Lote
                  FROM Productos p
                )
                SELECT Nombre, Stock_Actual, Unidad_Medida, Caducidad_Proxima, Lote, Precio_Venta
                FROM base
                ORDER BY Stock_Actual ASC, Nombre ASC
                LIMIT ?1;
                "#,
                vec![Value::Integer(limit)],
            )
            .await
            .map_err(db_err)?;
        let mut menos = Vec::new();
        while let Some(row) = low.next().await.map_err(db_err)? {
            menos.push(map_resumen(&row)?);
        }

        Ok(InventarioResumenResponse {
            proximos_caducar: proximos,
            menos_cantidad: menos,
        })
    }

    async fn list_alergenos(&self) -> AppResult<Vec<AlergenoInvDto>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                "SELECT ID_Alergeno, Nombre, Nombre_Imagen, Ruta_Imagen FROM Alergenos ORDER BY Nombre ASC;",
                (),
            )
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(AlergenoInvDto {
                id_alergeno: s(g(0)?),
                nombre: s(g(1)?),
                nombre_imagen: v_string(g(2)?),
                ruta_imagen: v_string(g(3)?),
            });
        }
        Ok(out)
    }

    async fn alergenos_producto(&self, id_producto: &str) -> AppResult<Vec<String>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                "SELECT ID_Alergeno FROM Producto_Alergenos WHERE ID_Producto=?1 ORDER BY ID_Alergeno ASC;",
                vec![Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id_a = s(row.get_value(0).map_err(db_err)?);
            if !id_a.is_empty() {
                out.push(id_a);
            }
        }
        Ok(out)
    }

    async fn get_producto(&self, id_producto: &str) -> AppResult<Option<ProductoBaseDto>> {
        let db = self.db.read().await;
        fetch_producto(&db, id_producto).await
    }

    async fn product_detail(&self, id_producto: &str) -> AppResult<ProductDetailResponse> {
        let db = self.db.read().await;
        let producto = fetch_producto(&db, id_producto).await?;
        let mut rows = db
            .query(
                r#"
                SELECT a.ID_Alergeno, a.Nombre, a.Nombre_Imagen, a.Ruta_Imagen
                FROM Producto_Alergenos pa
                JOIN Alergenos a ON a.ID_Alergeno = pa.ID_Alergeno
                WHERE pa.ID_Producto = ?1
                ORDER BY a.Nombre ASC;
                "#,
                vec![Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;
        let mut alergenos = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            alergenos.push(AlergenoInvDto {
                id_alergeno: s(g(0)?),
                nombre: s(g(1)?),
                nombre_imagen: v_string(g(2)?),
                ruta_imagen: v_string(g(3)?),
            });
        }
        Ok(ProductDetailResponse { producto, alergenos })
    }

    async fn producto_detalle(&self, id_producto: &str) -> AppResult<Option<ProductoDetalleDto>> {
        let db = self.db.read().await;
        let Some(producto) = fetch_producto(&db, id_producto).await? else {
            return Ok(None);
        };
        let mut rows = db
            .query(
                r#"
                SELECT a.ID_Alergeno, a.Nombre, a.Ruta_Imagen
                FROM Producto_Alergenos pa
                JOIN Alergenos a ON a.ID_Alergeno = pa.ID_Alergeno
                WHERE pa.ID_Producto=?1
                ORDER BY a.Nombre ASC;
                "#,
                vec![Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;
        let mut alergs = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            alergs.push(AlergenoMiniDto {
                id_alergeno: s(g(0)?),
                nombre: s(g(1)?),
                ruta_imagen: v_string(g(2)?),
            });
        }
        Ok(Some(ProductoDetalleDto { producto, alergs }))
    }

    async fn list_lotes_by_producto(&self, id_producto: &str) -> AppResult<Vec<LoteDto>> {
        let sql = r#"
          SELECT ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas
          FROM Lotes_Producto
          WHERE ID_Producto=?1
          ORDER BY (Caducidad IS NULL) ASC, date(Caducidad) ASC, datetime(Fecha_Entrada) DESC, ID_Lote DESC;
        "#;
        let db = self.db.read().await;
        let mut rows = db
            .query(sql, vec![Value::Text(id_producto.to_string())])
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(map_lote(&row)?);
        }
        Ok(out)
    }

    async fn create_categoria(&self, c: CategoriaUpsert) -> AppResult<()> {
        let id = c.id.unwrap_or_else(new_id);
        let db = self.db.write().await;
        db.execute(
                r#"
                INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible, Pasa_Cocina)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(ID_Categoria) DO UPDATE SET
                  Nombre = excluded.Nombre,
                  Nombre_Imagen = excluded.Nombre_Imagen,
                  Ruta_Imagen = excluded.Ruta_Imagen,
                  Vendible = excluded.Vendible,
                  Pasa_Cocina = excluded.Pasa_Cocina;
                "#,
                vec![
                    Value::Text(id),
                    Value::Text(c.nombre),
                    Value::Text(c.nombre_imagen),
                    Value::Text(c.ruta_imagen),
                    Value::Integer(if c.vendible { 1 } else { 0 }),
                    Value::Integer(if c.pasa_cocina { 1 } else { 0 }),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn set_alergenos_producto(&self, id_producto: &str, ids: Vec<String>) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            conn.execute(
                "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
                vec![Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;
            for id_a in ids {
                conn.execute(
                    "INSERT OR IGNORE INTO Producto_Alergenos (ID_Producto, ID_Alergeno) VALUES (?1, ?2);",
                    vec![Value::Text(id_producto.to_string()), Value::Text(id_a)],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(())
        }
        .await;
        finish_tx(conn, res).await
    }

    async fn delete_producto(&self, id_producto: &str) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            for sql in [
                "DELETE FROM Lotes_Producto WHERE ID_Producto=?1;",
                "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
                "DELETE FROM Productos WHERE ID_Producto=?1;",
            ] {
                conn.execute(sql, vec![Value::Text(id_producto.to_string())])
                    .await
                    .map_err(db_err)?;
            }
            Ok(())
        }
        .await;
        finish_tx(conn, res).await
    }

    async fn upsert_producto(&self, p: ProductoUpsert) -> AppResult<String> {
        let g = self.db.write().await;
        let conn = &g;
        let id_producto = p.id.unwrap_or_else(new_id);
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            conn.execute(
                r#"
                INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(ID_Producto) DO UPDATE SET
                  ID_Categoria = excluded.ID_Categoria,
                  ID_Proveedor = excluded.ID_Proveedor,
                  Nombre = excluded.Nombre,
                  Precio_Venta = excluded.Precio_Venta,
                  Stock_Minimo = excluded.Stock_Minimo,
                  Unidad_Medida = excluded.Unidad_Medida,
                  Nombre_Imagen = COALESCE(excluded.Nombre_Imagen, Productos.Nombre_Imagen),
                  Ruta_Imagen = COALESCE(excluded.Ruta_Imagen, Productos.Ruta_Imagen),
                  Cantidad_Pedido_Esperada = excluded.Cantidad_Pedido_Esperada;
                "#,
                vec![
                    Value::Text(id_producto.to_string()),
                    Value::Text(p.id_categoria),
                    match p.id_proveedor {
                        Some(v) => Value::Text(v),
                        None => Value::Null,
                    },
                    Value::Text(p.nombre),
                    opt_real(p.precio_venta),
                    opt_real(p.stock_minimo),
                    opt_text(p.unidad_medida),
                    opt_text(p.nombre_imagen),
                    opt_text(p.ruta_imagen),
                    opt_real(p.cantidad_pedido_esperada),
                ],
            )
            .await
            .map_err(db_err)?;

            conn.execute(
                "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
                vec![Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;
            for id_a in p.ids_alergenos {
                conn.execute(
                    "INSERT OR IGNORE INTO Producto_Alergenos (ID_Producto, ID_Alergeno) VALUES (?1, ?2);",
                    vec![Value::Text(id_producto.to_string()), Value::Text(id_a)],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(())
        }
        .await;
        finish_tx(conn, res).await?;
        Ok(id_producto)
    }

    async fn create_lote(&self, l: LoteNuevo) -> AppResult<()> {
        let id_lote = l.id.unwrap_or_else(new_id);
        let db = self.db.write().await;
        db.execute(
                r#"
                INSERT INTO Lotes_Producto
                  (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas)
                VALUES
                  (?1, ?2, ?3, COALESCE(NULLIF(?4, ''), datetime('now','localtime')), NULLIF(?5, ''), ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(ID_Lote) DO UPDATE SET
                  ID_Producto = excluded.ID_Producto,
                  Codigo_Lote = excluded.Codigo_Lote,
                  Fecha_Entrada = excluded.Fecha_Entrada,
                  Caducidad = excluded.Caducidad,
                  Cantidad_Inicial = excluded.Cantidad_Inicial,
                  Stock_Disponible = excluded.Stock_Disponible,
                  Coste_Unitario = excluded.Coste_Unitario,
                  ID_Proveedor = excluded.ID_Proveedor,
                  Notas = excluded.Notas;
                "#,
                vec![
                    Value::Text(id_lote),
                    Value::Text(l.id_producto),
                    Value::Text(l.codigo_lote),
                    opt_text(l.fecha_entrada),
                    opt_text(l.caducidad),
                    Value::Real(l.cantidad_inicial),
                    Value::Real(l.stock_disponible),
                    opt_real(l.coste_unitario),
                    match l.id_proveedor {
                        Some(v) => Value::Text(v),
                        None => Value::Null,
                    },
                    opt_text(l.notas),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn ajustar_lote(&self, a: AjusteLote) -> AppResult<()> {
        let db = self.db.write().await;
        db.execute(
                "UPDATE Lotes_Producto SET Stock_Disponible = ?1, Notas = COALESCE(NULLIF(?2, ''), Notas) WHERE ID_Lote = ?3;",
                vec![
                    Value::Real(a.stock_disponible),
                    opt_text(a.notas),
                    Value::Text(a.id_lote),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }
}

async fn finish_tx<C: Writer>(conn: &C, res: AppResult<()>) -> AppResult<()> {
    match res {
        Ok(()) => {
            conn.execute_batch("COMMIT;").await.map_err(db_err)?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;").await;
            Err(e)
        }
    }
}
