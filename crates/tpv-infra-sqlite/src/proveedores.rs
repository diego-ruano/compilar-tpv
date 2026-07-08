//! Adaptador SQLite del repositorio de proveedores. Local-First (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::{Row, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::proveedores::ProveedoresRepository;
use tpv_contracts::proveedores::{CategoriaProveedorDto, ProductoProveedorDto, ProveedorDto};
use tpv_domain::proveedores::{ProductoNuevo, ProveedorValidado};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_real, opt_text, v_f64, v_string};
use crate::util::new_id;

pub struct SqliteProveedoresRepository {
    db: Arc<Db>,
}

impl SqliteProveedoresRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Traduce errores de escritura de proveedor. Las columnas `Email` y `CIF` son `UNIQUE`
/// (PROV-05): una violación produce un mensaje de motor críptico ("UNIQUE constraint
/// failed: Proveedores.Email"). Aquí se convierte en un error de validación con mensaje
/// claro para la UI; el resto se propaga como error de repositorio.
fn write_err(e: impl std::fmt::Display) -> AppError {
    let msg = e.to_string();
    if msg.contains("Proveedores.Email") {
        AppError::validation("Ya existe un proveedor con ese email.")
    } else if msg.contains("Proveedores.CIF") {
        AppError::validation("Ya existe un proveedor con ese CIF.")
    } else {
        AppError::repository(msg)
    }
}

fn s(v: Value) -> String {
    v_string(v).unwrap_or_default()
}
fn f(v: Value) -> f64 {
    v_f64(v).unwrap_or(0.0)
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
        id_producto: s(g(0)?),
        id_categoria: norm_opt_string(g(1)?),
        id_proveedor: norm_opt_string(g(2)?),
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
        let db = self.db.read().await;
        let mut rows = db.query(sql, ()).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(ProveedorDto {
                id_proveedor: s(g(0)?),
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

    async fn get_productos(&self, id_proveedor: &str) -> AppResult<Vec<ProductoProveedorDto>> {
        let sql = format!(
            "SELECT {SQL_PRODUCTO_COLS} FROM Productos p WHERE p.ID_Proveedor = ?1 ORDER BY p.Nombre ASC;"
        );
        let db = self.db.read().await;
        let mut rows = db
            .query(&sql, vec![Value::Text(id_proveedor.to_string())])
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
        let db = self.db.read().await;
        let mut rows = db.query(sql, ()).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(CategoriaProveedorDto {
                id_categoria: s(g(0)?),
                nombre: s(g(1)?),
                nombre_imagen: norm_opt_string(g(2)?),
                ruta_imagen: norm_opt_string(g(3)?),
            });
        }
        Ok(out)
    }

    async fn get_productos_all(&self) -> AppResult<Vec<ProductoProveedorDto>> {
        let sql = format!("SELECT {SQL_PRODUCTO_COLS} FROM Productos p ORDER BY p.Nombre ASC;");
        let db = self.db.read().await;
        let mut rows = db.query(&sql, ()).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(map_producto(&row)?);
        }
        Ok(out)
    }

    async fn guardar(&self, p: ProveedorValidado) -> AppResult<bool> {
        let id = p.id.unwrap_or_else(new_id);

        let db = self.db.write().await;
        db.execute(
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
                    Value::Text(id),
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
            .map_err(write_err)?;
        Ok(true)
    }

    async fn eliminar(&self, id_proveedor: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            conn.execute(
                "UPDATE Lotes_Producto SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
                vec![Value::Text(id_proveedor.to_string())],
            )
            .await
            .map_err(db_err)?;
            conn.execute(
                "UPDATE Productos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
                vec![Value::Text(id_proveedor.to_string())],
            )
            .await
            .map_err(db_err)?;
            // DB-03: replicar EXPLICITAMENTE el ON DELETE SET NULL de Pedidos_Proveedor y
            // Cuentas_Gastos. En la nube (Turso/HTTP) no se garantiza que foreign_keys=ON persista
            // en el batch, asi que no dependemos de la cascada/SET NULL del motor: se hace a mano
            // (queda capturado en el outbox y converge Main<->nube). Lotes/Productos ya iban arriba
            // porque su FK es RESTRICT (habria bloqueado el DELETE si no se anulaba antes).
            conn.execute(
                "UPDATE Pedidos_Proveedor SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
                vec![Value::Text(id_proveedor.to_string())],
            )
            .await
            .map_err(db_err)?;
            conn.execute(
                "UPDATE Cuentas_Gastos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
                vec![Value::Text(id_proveedor.to_string())],
            )
            .await
            .map_err(db_err)?;
            let affected = conn
                .execute(
                    "DELETE FROM Proveedores WHERE ID_Proveedor = ?1;",
                    vec![Value::Text(id_proveedor.to_string())],
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

    async fn set_vinculos(&self, id_proveedor: &str, producto_ids: Vec<String>) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            conn.execute(
                "UPDATE Productos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;",
                vec![Value::Text(id_proveedor.to_string())],
            )
            .await
            .map_err(db_err)?;
            for pid in producto_ids.iter() {
                conn.execute(
                    "UPDATE Productos SET ID_Proveedor = ?1 WHERE ID_Producto = ?2;",
                    vec![Value::Text(id_proveedor.to_string()), Value::Text(pid.clone())],
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

    async fn crear_producto(&self, p: ProductoNuevo) -> AppResult<String> {
        let g = self.db.write().await;
        let conn = &g;
        let id_producto = p.id.unwrap_or_else(new_id);

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<String> = async {
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
                    Value::Text(id_producto.clone()),
                    Value::Text(p.id_categoria.clone()),
                    Value::Text(p.id_proveedor.clone()),
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
                            Value::Text(id_producto.clone()),
                            Value::Text(codigo_lote),
                            Value::Real(stock),
                            Value::Real(stock),
                            Value::Text(p.id_proveedor.clone()),
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
