//! Adaptador SQLite del repositorio de proveedores. Local-First (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::{Connection, Row, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::proveedores::ProveedoresRepository;
use tpv_contracts::proveedores::{CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto};
use tpv_domain::proveedores::{ProductoNuevo, ProveedorValidado};

use crate::mapping::{norm_opt_string, opt_real, opt_text, v_f64, v_i64, v_string};
use crate::util::next_table_id;

pub struct SqliteProveedoresRepository {
    conn: Arc<Connection>,
}

impl SqliteProveedoresRepository {
    pub fn new(conn: Arc<Connection>) -> Self {
        Self { conn }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn s(v: Value) -> String {
    v_string(v).unwrap_or_default()
}
fn i(v: Value) -> i64 {
    v_i64(v).unwrap_or(0)
}
fn f(v: Value) -> f64 {
    v_f64(v).unwrap_or(0.0)
}
fn pos_or_none(v: i64) -> Option<i64> {
    if v == 0 {
        None
    } else {
        Some(v)
    }
}
fn fpos_or_none(v: f64) -> Option<f64> {
    if v == 0.0 {
        None
    } else {
        Some(v)
    }
}

const SQL_PRODUCTO_COLS: &str = r#"
        p.ID_Producto,
        p.ID_Categoria,
        p.ID_Proveedor,
        p.Nombre,
        p.Precio_Venta,
        (SELECT COALESCE(SUM(l.Stock_Disponible), 0) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) AS Stock_Actual,
        p.Stock_Minimo,
        p.Unidad_Medida,
        p.Nombre_Imagen,
        p.Ruta_Imagen,
        p.Cantidad_Pedido_Esperada,
        (SELECT MAX(datetime(l.Fecha_Entrada)) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) AS Ultima_Entrada,
        (SELECT l.Caducidad FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Caducidad_Proxima
"#;

fn map_producto(row: &Row) -> AppResult<ProductoProveedorDto> {
    let g = |idx: i32| row.get_value(idx).map_err(db_err);
    Ok(ProductoProveedorDto {
        id_producto: i(g(0)?),
        id_categoria: pos_or_none(i(g(1)?)),
        id_proveedor: pos_or_none(i(g(2)?)),
        nombre: s(g(3)?),
        precio_venta: fpos_or_none(f(g(4)?)),
        stock_actual: Some(f(g(5)?)),
        stock_minimo: fpos_or_none(f(g(6)?)),
        unidad_medida: norm_opt_string(g(7)?),
        nombre_imagen: norm_opt_string(g(8)?),
        ruta_imagen: norm_opt_string(g(9)?),
        cantidad_pedido_esperada: fpos_or_none(f(g(10)?)),
        ultima_entrada: norm_opt_string(g(11)?),
        caducidad_proxima: norm_opt_string(g(12)?),
    })
}

#[async_trait]
impl ProveedoresRepository for SqliteProveedoresRepository {
    async fn get_all(&self) -> AppResult<Vec<ProveedorDto>> {
        let sql = r#"
          SELECT ID_Proveedor, Nombre_Empresa, Contacto, Telefono, Email, CIF,
                 Informacion_adicional, Nombre_Imagen, Ruta_Imagen
          FROM Proveedores
          ORDER BY Nombre_Empresa ASC;
        "#;
        let mut rows = self.conn.query(sql, ()).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(ProveedorDto {
                id_proveedor: i(g(0)?),
                nombre_empresa: s(g(1)?),
                contacto: norm_opt_string(g(2)?),
                telefono: norm_opt_string(g(3)?),
                email: norm_opt_string(g(4)?),
                cif: norm_opt_string(g(5)?),
                informacion_adicional: norm_opt_string(g(6)?),
                nombre_imagen: norm_opt_string(g(7)?),
                ruta_imagen: norm_opt_string(g(8)?),
            });
        }
        Ok(out)
    }

    async fn get_productos(&self, id_proveedor: i64) -> AppResult<Vec<ProductoProveedorDto>> {
        let sql = format!(
            "SELECT {SQL_PRODUCTO_COLS} FROM Productos p WHERE p.ID_Proveedor = ?1 ORDER BY p.Nombre ASC;"
        );
        let mut rows = self
            .conn
            .query(&sql, vec![Value::Integer(id_proveedor)])
            .await
            .map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(map_producto(&row)?);
        }
        Ok(out)
    }

    async fn get_categorias(&self) -> AppResult<Vec<CategoriaProveedorDto>> {
        let sql = "SELECT ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen FROM Categorias_Producto ORDER BY Nombre ASC;";
        let mut rows = self.conn.query(sql, ()).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(CategoriaProveedorDto {
                id_categoria: i(g(0)?),
                nombre: s(g(1)?),
                nombre_imagen: norm_opt_string(g(2)?),
                ruta_imagen: norm_opt_string(g(3)?),
            });
        }
        Ok(out)
    }

    async fn get_productos_all(&self) -> AppResult<Vec<ProductoProveedorDto>> {
        let sql = format!("SELECT {SQL_PRODUCTO_COLS} FROM Productos p ORDER BY p.Nombre ASC;");
        let mut rows = self.conn.query(&sql, ()).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(map_producto(&row)?);
        }
        Ok(out)
    }

    async fn guardar(&self, p: ProveedorValidado) -> AppResult<bool> {
        let id = match p.id {
            Some(id) => id,
            None => next_table_id(&self.conn, "Proveedores", "ID_Proveedor").await?,
        };

        self.conn
            .execute(
                r#"
                INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Contacto, Telefono, Email, CIF, Informacion_adicional, Nombre_Imagen, Ruta_Imagen)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT(ID_Proveedor) DO UPDATE SET
                  Nombre_Empresa = excluded.Nombre_Empresa,
                  Contacto = excluded.Contacto,
                  Telefono = excluded.Telefono,
                  Email = excluded.Email,
                  CIF = excluded.CIF,
                  Informacion_adicional = excluded.Informacion_adicional,
                  Nombre_Imagen = excluded.Nombre_Imagen,
                  Ruta_Imagen = excluded.Ruta_Imagen;
                "#,
                vec![
                    Value::Integer(id),
                    Value::Text(p.nombre_empresa),
                    opt_text(p.contacto),
                    opt_text(p.telefono),
                    opt_text(p.email),
                    opt_text(p.cif),
                    opt_text(p.informacion_adicional),
                    opt_text(p.nombre_imagen),
                    opt_text(p.ruta_imagen),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(true)
    }

    async fn eliminar(&self, id_proveedor: i64) -> AppResult<bool> {
        let conn = &self.conn;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            conn.execute(
                "UPDATE Lotes_Producto SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
                vec![Value::Integer(id_proveedor)],
            )
            .await
            .map_err(db_err)?;
            conn.execute(
                "UPDATE Productos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
                vec![Value::Integer(id_proveedor)],
            )
            .await
            .map_err(db_err)?;
            let affected = conn
                .execute(
                    "DELETE FROM Proveedores WHERE ID_Proveedor = ?1;",
                    vec![Value::Integer(id_proveedor)],
                )
                .await
                .map_err(db_err)?;
            Ok(affected > 0)
        }
        .await;
        match res {
            Ok(v) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn set_vinculos(&self, id_proveedor: i64, producto_ids: Vec<i64>) -> AppResult<bool> {
        let conn = &self.conn;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            conn.execute(
                "UPDATE Productos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
                vec![Value::Integer(id_proveedor)],
            )
            .await
            .map_err(db_err)?;
            for pid in producto_ids.iter() {
                conn.execute(
                    "UPDATE Productos SET ID_Proveedor = ?1 WHERE ID_Producto = ?2;",
                    vec![Value::Integer(id_proveedor), Value::Integer(*pid)],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(true)
        }
        .await;
        match res {
            Ok(v) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn crear_producto(&self, p: ProductoNuevo) -> AppResult<i64> {
        let conn = &self.conn;
        let id_producto = match p.id {
            Some(id) => id,
            None => next_table_id(conn, "Productos", "ID_Producto").await?,
        };

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<i64> = async {
            conn.execute(
                r#"
                INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL)
                ON CONFLICT(ID_Producto) DO UPDATE SET
                  ID_Categoria = excluded.ID_Categoria,
                  ID_Proveedor = excluded.ID_Proveedor,
                  Nombre = excluded.Nombre,
                  Precio_Venta = excluded.Precio_Venta,
                  Stock_Minimo = excluded.Stock_Minimo,
                  Unidad_Medida = excluded.Unidad_Medida;
                "#,
                vec![
                    Value::Integer(id_producto),
                    Value::Integer(p.id_categoria),
                    Value::Integer(p.id_proveedor),
                    Value::Text(p.nombre.clone()),
                    opt_real(p.precio_venta),
                    opt_real(p.stock_minimo),
                    opt_text(p.unidad_medida.clone()),
                ],
            )
            .await
            .map_err(db_err)?;

            if let Some(stock) = p.stock_actual {
                if stock > 0.0 {
                    let codigo_lote = format!("INI-{}", id_producto);
                    conn.execute(
                        r#"
                        INSERT OR IGNORE INTO Lotes_Producto
                          (ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas)
                        VALUES
                          (?1, ?2, datetime('now','localtime'), NULL, ?3, ?4, NULL, ?5, ?6);
                        "#,
                        vec![
                            Value::Integer(id_producto),
                            Value::Text(codigo_lote),
                            Value::Real(stock),
                            Value::Real(stock),
                            Value::Integer(p.id_proveedor),
                            Value::Text("Lote inicial creado desde Proveedores".into()),
                        ],
                    )
                    .await
                    .map_err(db_err)?;
                }
            }

            Ok(id_producto)
        }
        .await;

        match res {
            Ok(id) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(id)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }
}
