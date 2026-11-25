//! Adaptador SQLite del repositorio de inventario. Local-First (sin outbox/applied).

use crate::util::new_id;
use crate::consultas::{db_err, select_one_i64};

/// INV-INC-03: el mismo texto que el worker (`categoria_repetida`).
pub const MSG_CATEGORIA_REPETIDA: &str = "Ya hay una categoría con ese nombre.";
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;
use crate::ejecutor::Row;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::inventario::InventarioRepository;
use tpv_domain::ingredientes::{CategoriaIngredienteGuardar, IngredienteGuardar};
use tpv_contracts::inventario::{
    AlergenoInvDto, AlergenoMiniDto, CatalogoIngredientesDto, CategoriaInvDto, InventarioResumenResponse, LoteDto,
    ProductDetailResponse, ProductoBaseDto, ProductoDetalleDto, ProductoListDto, ProductoResumenDto,
    ProveedorMiniDto,
};
use tpv_domain::cantidad::redondear_cantidad;
use tpv_domain::inventario::{
    stock_sin_cambios, AjusteLote, AjusteSuelto, CategoriaUpsert, LoteNuevo, LoteUpdate,
    ProductoUpsert,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_real, opt_text, v_f64, v_i64, v_string, v_dinero, opt_dinero};

pub struct SqliteInventarioRepository {
    db: Arc<Db>,
}

impl SqliteInventarioRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
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
        precio_venta: v_dinero(g(4)?),
        stock_minimo: v_f64(g(5)?),
        unidad_medida: v_string(g(6)?),
        nombre_imagen: v_string(g(7)?),
        ruta_imagen: v_string(g(8)?),
        cantidad_pedido_esperada: v_f64(g(9)?),
        stock_suelto: v_f64(g(10)?),
        iva_percent: v_f64(g(11)?),
    })
}

fn map_producto_list(row: &Row) -> AppResult<ProductoListDto> {
    let g = |idx: i32| row.get_value(idx).map_err(db_err);
    let base = ProductoBaseDto {
        id_producto: s(g(0)?),
        id_categoria: s(g(1)?),
        id_proveedor: norm_opt_string(g(2)?),
        nombre: s(g(3)?),
        precio_venta: v_dinero(g(4)?),
        stock_minimo: v_f64(g(6)?),
        unidad_medida: v_string(g(7)?),
        nombre_imagen: v_string(g(8)?),
        ruta_imagen: v_string(g(9)?),
        cantidad_pedido_esperada: v_f64(g(12)?),
        stock_suelto: v_f64(g(13)?),
        iva_percent: v_f64(g(14)?),
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
        precio_venta: v_dinero(g(5)?),
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
        stock_disponible: fl(g(5)?),
        coste_unitario: v_dinero(g(6)?),
        id_proveedor: norm_opt_string(g(7)?),
        notas: v_string(g(8)?),
    })
}

const SQL_PRODUCTO_BASE_COLS: &str = "ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada, Stock_Suelto, IVA_Percent";

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

/// Quitar un producto del catálogo (INV-05, RI-54): **se archiva si tiene historia y se borra si
/// no**, en una sola tanda de sentencias que deciden cada una por su cuenta.
///
/// «Historia» es que alguna línea de comanda lo nombre o que haya consumos suyos, de lote o de
/// stock suelto. Antes se borraba siempre: el `DELETE` de sus lotes chocaba con la FK de
/// `Lote_Consumos` en cuanto se había vendido algo de un lote, y la pantalla enseñaba el error del
/// motor. Archivado (`Archivado_En`), sale de la carta, del inventario, de los pedidos y de las
/// alertas; sus ventas, sus lotes y su trazabilidad siguen para las estadísticas.
///
/// Cada sentencia lleva su condición en el propio SQL, sin leer antes: la primera archiva si hay
/// historia, y las demás sólo borran si el producto no ha quedado archivado. Así la decisión se toma
/// una vez, dentro de la transacción, y es la misma en la nube al replicar las sentencias.
/// El worker manda exactamente estas (`inventario.commands.ts::deleteProducto`).
///
/// DB-03: lo que haría una FK se hace a mano (los movimientos antes que los lotes), porque lo que
/// viaja a la nube son estas sentencias y allí no se garantiza que las acciones referenciales se
/// apliquen igual.
pub(crate) const SQL_QUITAR_PRODUCTO: &[&str] = &[
    "UPDATE Productos SET Archivado_En = datetime('now','localtime') \
     WHERE ID_Producto = ?1 AND Archivado_En IS NULL AND (\
       EXISTS (SELECT 1 FROM Detalle_Comanda WHERE ID_Producto = ?1) \
       OR EXISTS (SELECT 1 FROM Suelto_Consumos WHERE ID_Producto = ?1) \
       OR EXISTS (SELECT 1 FROM Lote_Consumos lc JOIN Lotes_Producto l ON l.ID_Lote = lc.ID_Lote \
                  WHERE l.ID_Producto = ?1)) AND NOT EXISTS (SELECT 1 FROM Detalle_Comanda dc JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda WHERE dc.ID_Producto = ?1 AND c.Estado = 'Abierta');",
    "DELETE FROM Movimientos_Stock \
     WHERE ID_Lote IN (SELECT ID_Lote FROM Lotes_Producto WHERE ID_Producto = ?1) \
       AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM Detalle_Comanda dc JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda WHERE dc.ID_Producto = ?1 AND c.Estado = 'Abierta');",
    // Y los de su stock suelto (RI-55).
    "DELETE FROM Movimientos_Stock WHERE ID_Producto = ?1 \
       AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM Detalle_Comanda dc JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda WHERE dc.ID_Producto = ?1 AND c.Estado = 'Abierta');",
    "DELETE FROM Lotes_Producto WHERE ID_Producto = ?1 \
       AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM Detalle_Comanda dc JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda WHERE dc.ID_Producto = ?1 AND c.Estado = 'Abierta');",
    "DELETE FROM Producto_Ingredientes WHERE ID_Producto = ?1 \
       AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM Detalle_Comanda dc JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda WHERE dc.ID_Producto = ?1 AND c.Estado = 'Abierta');",
    "DELETE FROM Producto_Alergenos WHERE ID_Producto = ?1 \
       AND NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM Detalle_Comanda dc JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda WHERE dc.ID_Producto = ?1 AND c.Estado = 'Abierta');",
    "DELETE FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NULL AND NOT EXISTS (SELECT 1 FROM Detalle_Comanda dc JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda WHERE dc.ID_Producto = ?1 AND c.Estado = 'Abierta');",
];

/// Algún producto de la categoría `?1` está en una comanda abierta.
macro_rules! categoria_en_comanda_abierta {
    () => {
        "EXISTS (SELECT 1 FROM Detalle_Comanda dc JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda \
         JOIN Productos pc ON pc.ID_Producto = dc.ID_Producto WHERE pc.ID_Categoria = ?1 AND c.Estado = 'Abierta')"
    };
}

/// La sentencia, sólo si ningún producto de la categoría `?1` está en una comanda abierta.
macro_rules! si_ninguno_en_comanda_abierta {
    ($sql:literal) => {
        concat!($sql, " AND NOT ", categoria_en_comanda_abierta!(), ";")
    };
}

/// El mismo texto que el worker (`categoria_en_comanda_abierta`).
pub const MSG_CATEGORIA_EN_COMANDA_ABIERTA: &str =
    "No se puede borrar: algún producto de esta categoría está en una comanda abierta. Cóbrala o quita la línea y vuelve a intentarlo.";

/// Borrar una categoría de productos con sus productos: a cada uno le pasa lo mismo que con
/// [`SQL_QUITAR_PRODUCTO`] (se archiva si tiene historia y se borra si no), los archivados se quedan
/// sin categoría (`0004_producto_sin_categoria.sql`) y la categoría se borra.
///
/// Todas llevan la misma condición, que ningún producto de la categoría esté en una comanda abierta:
/// o se aplican todas o ninguna, también al volver a evaluarlas el otro lado al replicar. El worker
/// manda exactamente éstas (`inventario.commands.ts::borrarCategoria`).
pub(crate) const SQL_QUITAR_CATEGORIA: &[&str] = &[
    si_ninguno_en_comanda_abierta!(
        "UPDATE Productos SET Archivado_En = datetime('now','localtime') \
         WHERE ID_Categoria = ?1 AND Archivado_En IS NULL AND (\
           EXISTS (SELECT 1 FROM Detalle_Comanda d WHERE d.ID_Producto = Productos.ID_Producto) \
           OR EXISTS (SELECT 1 FROM Suelto_Consumos s WHERE s.ID_Producto = Productos.ID_Producto) \
           OR EXISTS (SELECT 1 FROM Lote_Consumos lc JOIN Lotes_Producto l ON l.ID_Lote = lc.ID_Lote \
                      WHERE l.ID_Producto = Productos.ID_Producto))"
    ),
    si_ninguno_en_comanda_abierta!(
        "DELETE FROM Movimientos_Stock WHERE ID_Lote IN (SELECT l.ID_Lote FROM Lotes_Producto l \
         JOIN Productos p ON p.ID_Producto = l.ID_Producto WHERE p.ID_Categoria = ?1 AND p.Archivado_En IS NULL)"
    ),
    si_ninguno_en_comanda_abierta!(
        "DELETE FROM Movimientos_Stock WHERE ID_Producto IN \
         (SELECT ID_Producto FROM Productos WHERE ID_Categoria = ?1 AND Archivado_En IS NULL)"
    ),
    si_ninguno_en_comanda_abierta!(
        "DELETE FROM Lotes_Producto WHERE ID_Producto IN \
         (SELECT ID_Producto FROM Productos WHERE ID_Categoria = ?1 AND Archivado_En IS NULL)"
    ),
    si_ninguno_en_comanda_abierta!(
        "DELETE FROM Producto_Ingredientes WHERE ID_Producto IN \
         (SELECT ID_Producto FROM Productos WHERE ID_Categoria = ?1 AND Archivado_En IS NULL)"
    ),
    si_ninguno_en_comanda_abierta!(
        "DELETE FROM Producto_Alergenos WHERE ID_Producto IN \
         (SELECT ID_Producto FROM Productos WHERE ID_Categoria = ?1 AND Archivado_En IS NULL)"
    ),
    si_ninguno_en_comanda_abierta!("DELETE FROM Productos WHERE ID_Categoria = ?1 AND Archivado_En IS NULL"),
    si_ninguno_en_comanda_abierta!("UPDATE Productos SET ID_Categoria = NULL WHERE ID_Categoria = ?1"),
    si_ninguno_en_comanda_abierta!("DELETE FROM Categorias_Producto WHERE ID_Categoria = ?1"),
];

#[async_trait]
impl InventarioRepository for SqliteInventarioRepository {
    async fn catalogo_ingredientes(&self) -> AppResult<CatalogoIngredientesDto> {
        self.catalogo_ingredientes_impl().await
    }

    async fn ingredientes_de_producto(&self, id_producto: &str) -> AppResult<Vec<String>> {
        self.ingredientes_de_producto_impl(id_producto).await
    }

    async fn guardar_categoria_ingrediente(&self, categoria: CategoriaIngredienteGuardar) -> AppResult<String> {
        // La comprobación del nombre y la escritura, bajo el mismo escritor (RI-39).
        let g = self.db.write().await;
        let conn = &g;
        conn.transaccion(crate::ingredientes::guardar_categoria(conn, categoria)).await
    }

    async fn borrar_categoria_ingrediente(&self, id_categoria_ingrediente: &str) -> AppResult<()> {
        self.borrar_en_orden(crate::ingredientes::SQL_BORRAR_CATEGORIA, id_categoria_ingrediente).await
    }

    async fn guardar_ingrediente(&self, ingrediente: IngredienteGuardar) -> AppResult<String> {
        let g = self.db.write().await;
        let conn = &g;
        conn.transaccion(crate::ingredientes::guardar_ingrediente(conn, ingrediente)).await
    }

    async fn borrar_ingrediente(&self, id_ingrediente: &str) -> AppResult<()> {
        self.borrar_en_orden(crate::ingredientes::SQL_BORRAR_INGREDIENTE, id_ingrediente).await
    }

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
            ((SELECT COALESCE(SUM(l.Stock_Disponible), 0) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto) + COALESCE(p.Stock_Suelto, 0)) AS Stock_Actual,
            p.Stock_Minimo, p.Unidad_Medida, p.Nombre_Imagen, p.Ruta_Imagen,
            (SELECT l.Caducidad FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Caducidad_Proxima,
            (SELECT l.Codigo_Lote FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto AND l.Stock_Disponible > 0 AND l.Caducidad IS NOT NULL ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC LIMIT 1) AS Lote_Proximo,
            p.Cantidad_Pedido_Esperada,
            p.Stock_Suelto,
            p.IVA_Percent
          FROM Productos p
          WHERE p.ID_Categoria = ?1
            AND p.Archivado_En IS NULL -- RI-54: un archivado ya no es del inventario
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
                  AND p.Archivado_En IS NULL
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
                -- INV-04: sin subconsultas correlacionadas por fila. Stock por producto con un
                -- GROUP BY, y el lote FEFO (próximo a caducar) con una ventana ROW_NUMBER.
                WITH stock_por_prod AS (
                  SELECT ID_Producto, COALESCE(SUM(Stock_Disponible), 0) AS Stock_Actual
                  FROM Lotes_Producto
                  GROUP BY ID_Producto
                ),
                fefo AS (
                  SELECT ID_Producto, Caducidad, Codigo_Lote
                  FROM (
                    SELECT ID_Producto, Caducidad, Codigo_Lote,
                      ROW_NUMBER() OVER (
                        PARTITION BY ID_Producto
                        ORDER BY date(Caducidad) ASC, datetime(Fecha_Entrada) ASC, ID_Lote ASC
                      ) AS rn
                    FROM Lotes_Producto
                    WHERE Stock_Disponible > 0 AND Caducidad IS NOT NULL
                  )
                  WHERE rn = 1
                )
                SELECT
                  p.Nombre,
                  COALESCE(sp.Stock_Actual, 0) + COALESCE(p.Stock_Suelto, 0) AS Stock_Actual,
                  p.Unidad_Medida,
                  f.Caducidad AS Caducidad_Proxima,
                  f.Codigo_Lote AS Lote,
                  p.Precio_Venta
                FROM Productos p
                LEFT JOIN stock_por_prod sp ON sp.ID_Producto = p.ID_Producto
                LEFT JOIN fefo f ON f.ID_Producto = p.ID_Producto
                WHERE p.Archivado_En IS NULL
                ORDER BY Stock_Actual ASC, p.Nombre ASC
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
          SELECT ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas
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
        // INV-INC-03: un nombre que ya tiene otra se rechaza con su frase, antes de que el `UNIQUE`
        // lo haga con la del motor. Bajo el mismo escritor que escribe.
        let repetida = select_one_i64(
            &db,
            "SELECT 1 FROM Categorias_Producto WHERE Nombre = ?2 AND ID_Categoria <> ?1 LIMIT 1;",
            vec![Value::Text(id.clone()), Value::Text(c.nombre.clone())],
        )
        .await?
        .is_some();
        if repetida {
            return Err(AppError::conflict(MSG_CATEGORIA_REPETIDA));
        }
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

    async fn delete_producto(&self, id_producto: &str) -> AppResult<()> {
        // RI-39: comprobar bajo el mismo escritor que retiene el borrado.
        let g = self.db.write().await;
        // INV-05: lo único que impide quitar un producto es que esté EN USO ahora mismo, o sea en
        // una comanda todavía abierta. Quitarlo de la carta con una mesa a medias dejaría a la
        // línea sin precio ni cocina y al camarero sin saber por qué.
        {
            let rg = &g;
            let mut rows = rg
                .query(
                    r#"
                    SELECT 1
                    FROM Detalle_Comanda dc
                    JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda
                    WHERE dc.ID_Producto = ?1 AND c.Estado = 'Abierta'
                    LIMIT 1;
                    "#,
                    vec![Value::Text(id_producto.to_string())],
                )
                .await
                .map_err(db_err)?;
            if rows.next().await.map_err(db_err)?.is_some() {
                return Err(AppError::validation(
                    "No se puede borrar: el producto está en una comanda abierta. Cóbrala o quita la línea y vuelve a intentarlo.",
                ));
            }
        }
        let conn = &g;
        conn.transaccion(async {
            for sql in SQL_QUITAR_PRODUCTO {
                conn.execute(sql, vec![Value::Text(id_producto.to_string())])
                    .await
                    .map_err(db_err)?;
            }
            Ok(())
        }).await
    }

    async fn borrar_categoria(&self, id_categoria: &str) -> AppResult<()> {
        // Comprobar y borrar bajo el mismo escritor (RI-39), como `delete_producto`.
        let g = self.db.write().await;
        let conn = &g;
        let en_uso = select_one_i64(
            conn,
            concat!("SELECT ", categoria_en_comanda_abierta!(), ";"),
            vec![Value::Text(id_categoria.to_string())],
        )
        .await?
        .unwrap_or(0)
            != 0;
        if en_uso {
            return Err(AppError::validation(MSG_CATEGORIA_EN_COMANDA_ABIERTA));
        }
        conn.transaccion(async {
            for sql in SQL_QUITAR_CATEGORIA {
                conn.execute(sql, vec![Value::Text(id_categoria.to_string())]).await.map_err(db_err)?;
            }
            Ok(())
        })
        .await
    }

    async fn upsert_producto_autorizado(&self, actor: &str, p: ProductoUpsert, precios: bool, recibir: bool) -> AppResult<String> {
        self.guardar_producto(actor, p, precios, recibir).await
    }

    async fn create_lote(&self, id_usuario: &str, l: LoteNuevo) -> AppResult<()> {
        let id_lote = l.id.unwrap_or_else(new_id);
        let id_mov = new_id();
        // RI-26: toda cantidad de stock se guarda redondeada a milésimas.
        let stock = redondear_cantidad(l.stock_disponible);
        let motivo = l.notas.clone();
        let g = self.db.write().await;
        let conn = &g;
        conn.transaccion(async {
            // Auditoría (INV-01b): el alta entra como movimiento 'ALTA' con delta = stock inicial.
            // RI-28: el usuario viene del contexto autenticado de la capa de aplicación.
            //
            // AUD-20: el movimiento va DELANTE del alta del lote y sólo entra si el lote no existe.
            // Con el id de un lote que ya existe, el alta pura de abajo no lo toca, y sin la
            // condición quedaba otro 'ALTA' que la reconciliación daba por descuadre sin que ningún
            // ajuste lo cerrara. La condición viaja en la sentencia y la vuelve a evaluar la nube al
            // aplicarla; la FK al lote la comprueba el COMMIT (`transaccion` abre con
            // `defer_foreign_keys`). Espejo de `createLote` del worker.
            conn.execute(
                r#"
                INSERT INTO Movimientos_Stock
                  (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
                SELECT ?1, ?2, 'ALTA', ?3, ?4, ?5, ?6, datetime('now','localtime')
                WHERE NOT EXISTS (SELECT 1 FROM Lotes_Producto WHERE ID_Lote = ?2);
                "#,
                vec![
                    Value::Text(id_mov),
                    Value::Text(id_lote.clone()),
                    Value::Real(stock),
                    Value::Real(stock),
                    opt_text(motivo),
                    Value::Text(id_usuario.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;

            conn.execute(
                r#"
                -- Alta PURA (INV-02): un create con un ID_Lote existente es un no-op idempotente,
                -- nunca pisa Stock_Disponible (que descuadraría con Lote_Consumos). La edición usa
                -- update_lote / ajustar_lote.
                INSERT INTO Lotes_Producto
                  (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas)
                VALUES
                  (?1, ?2, ?3, COALESCE(NULLIF(?4, ''), datetime('now','localtime')), NULLIF(?5, ''), ?6, ?7, ?8, ?9)
                ON CONFLICT(ID_Lote) DO NOTHING;
                "#,
                vec![
                    Value::Text(id_lote),
                    Value::Text(l.id_producto),
                    Value::Text(l.codigo_lote),
                    opt_text(l.fecha_entrada),
                    opt_text(l.caducidad),
                    Value::Real(stock),
                    opt_dinero(l.coste_unitario),
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
        }).await
    }

    /// Edición de los **datos** de un lote: código, caducidad, coste, proveedor, notas. Las
    /// existencias no se tocan (RI-55).
    ///
    /// Antes se escribía el `Stock_Disponible` que había cargado el formulario: si mientras estaba
    /// abierto se vendían 3 de 10, cambiar sólo la caducidad devolvía el lote a 10 y anotaba un
    /// ajuste de +3 «Edición del lote», y la reconciliación lo daba por bueno porque había un
    /// movimiento que lo explicaba. Las existencias se cambian con `ajustar_lote`.
    async fn update_lote(&self, l: LoteUpdate) -> AppResult<()> {
        let db = self.db.write().await;
        let n = db
            .execute(
                r#"
                UPDATE Lotes_Producto SET
                  ID_Producto = ?2,
                  Codigo_Lote = ?3,
                  Fecha_Entrada = COALESCE(NULLIF(?4, ''), Fecha_Entrada),
                  Caducidad = NULLIF(?5, ''),
                  Coste_Unitario = ?6,
                  ID_Proveedor = ?7,
                  Notas = ?8
                WHERE ID_Lote = ?1;
                "#,
                vec![
                    Value::Text(l.id_lote),
                    Value::Text(l.id_producto),
                    Value::Text(l.codigo_lote),
                    opt_text(l.fecha_entrada),
                    opt_text(l.caducidad),
                    opt_dinero(l.coste_unitario),
                    match l.id_proveedor {
                        Some(v) => Value::Text(v),
                        None => Value::Null,
                    },
                    opt_text(l.notas),
                ],
            )
            .await
            .map_err(db_err)?;
        if n == 0 {
            return Err(AppError::validation("Lote no encontrado"));
        }
        Ok(())
    }

    /// Ajuste de las existencias de un lote (un recuento, una merma) con su movimiento 'AJUSTE'.
    ///
    /// RI-55: se compara lo que vio quien ajusta con lo que hay, dentro de la transacción. Si alguien
    /// vendió o ajustó entre medias, no se toca nada y se avisa: aplicar el valor absoluto pisaría ese
    /// movimiento y dejaría un descuadre con justificante.
    async fn ajustar_lote(&self, id_usuario: &str, a: AjusteLote) -> AppResult<()> {
        let id_mov = new_id();
        let g = self.db.write().await;
        let conn = &g;
        conn.transaccion(async {
            let actual = {
                let mut rows = conn
                    .query(
                        "SELECT Stock_Disponible FROM Lotes_Producto WHERE ID_Lote = ?1 LIMIT 1;",
                        vec![Value::Text(a.id_lote.clone())],
                    )
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(r) => redondear_cantidad(fl(r.get_value(0).map_err(db_err)?)),
                    None => return Err(AppError::validation("Lote no encontrado")),
                }
            };
            // Ya está como se pide: no hay nada que ajustar, aunque lo visto ya no sea lo que hay.
            // Igual en el worker, donde es además el reintento de un ajuste que ya entró.
            let delta = redondear_cantidad(a.stock_nuevo - actual);
            if delta == 0.0 {
                return Ok(());
            }
            if !stock_sin_cambios(Some(a.stock_visto), Some(actual)) {
                return Err(stock_cambiado(Some(actual)));
            }

            conn.execute(
                "UPDATE Lotes_Producto SET Stock_Disponible = ?1 WHERE ID_Lote = ?2;",
                vec![Value::Real(a.stock_nuevo), Value::Text(a.id_lote.clone())],
            )
            .await
            .map_err(db_err)?;

            // Auditoría (INV-01b): el ajuste queda como movimiento 'AJUSTE' con su delta.
            conn.execute(
                r#"
                INSERT INTO Movimientos_Stock
                  (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
                VALUES
                  (?1, ?2, 'AJUSTE', ?3, ?4, ?5, ?6, datetime('now','localtime'));
                "#,
                vec![
                    Value::Text(id_mov),
                    Value::Text(a.id_lote),
                    Value::Real(delta),
                    Value::Real(a.stock_nuevo),
                    Value::Text(a.motivo.unwrap_or_else(|| "Ajuste manual".into())),
                    Value::Text(id_usuario.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;
            Ok(())
        }).await
    }

    /// Ajuste del stock suelto de un producto, con su movimiento (RI-55). Mismo trato que un lote:
    /// se compara con lo visto y queda el rastro, que es lo que permite que la reconciliación cuadre
    /// también el suelto.
    async fn ajustar_stock_suelto(&self, id_usuario: &str, a: AjusteSuelto) -> AppResult<()> {
        let id_mov = new_id();
        let g = self.db.write().await;
        let conn = &g;
        conn.transaccion(async {
            let actual = {
                let mut rows = conn
                    .query(
                        "SELECT Stock_Suelto FROM Productos WHERE ID_Producto = ?1 LIMIT 1;",
                        vec![Value::Text(a.id_producto.clone())],
                    )
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(r) => v_f64(r.get_value(0).map_err(db_err)?).map(redondear_cantidad),
                    None => return Err(AppError::validation("Producto no encontrado")),
                }
            };
            // Como en un lote: ya como se pide es ok.
            if stock_sin_cambios(a.stock_nuevo, actual) {
                return Ok(());
            }
            if !stock_sin_cambios(a.stock_visto, actual) {
                return Err(stock_cambiado(actual));
            }

            conn.execute(
                "UPDATE Productos SET Stock_Suelto = ?1 WHERE ID_Producto = ?2;",
                vec![opt_real(a.stock_nuevo), Value::Text(a.id_producto.clone())],
            )
            .await
            .map_err(db_err)?;

            // Dejar de llevar stock suelto es un movimiento que lo devuelve a cero: así la suma de
            // movimientos menos los consumos sigue cuadrando si algún día se vuelve a activar.
            let motivo = a.motivo.unwrap_or_else(|| {
                if a.stock_nuevo.is_none() {
                    "Deja de llevar stock suelto".into()
                } else {
                    "Ajuste manual".into()
                }
            });
            conn.execute(
                r#"
                INSERT INTO Movimientos_Stock
                  (ID_Movimiento, ID_Producto, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
                VALUES
                  (?1, ?2, 'AJUSTE', ?3, ?4, ?5, ?6, datetime('now','localtime'));
                "#,
                vec![
                    Value::Text(id_mov),
                    Value::Text(a.id_producto),
                    Value::Real(redondear_cantidad(
                        a.stock_nuevo.unwrap_or(0.0) - actual.unwrap_or(0.0),
                    )),
                    Value::Real(a.stock_nuevo.unwrap_or(0.0)),
                    Value::Text(motivo),
                    Value::Text(id_usuario.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;
            Ok(())
        }).await
    }
}

/// Una cantidad para un mensaje: sin ceros de más y con coma decimal («7», «0,5»).
/// Ingredientes: el SQL vive en `crate::ingredientes`; aquí sólo se toma la base.
impl SqliteInventarioRepository {
    async fn catalogo_ingredientes_impl(&self) -> AppResult<CatalogoIngredientesDto> {
        let db = self.db.read().await;
        crate::ingredientes::catalogo(&db).await
    }

    async fn ingredientes_de_producto_impl(&self, id_producto: &str) -> AppResult<Vec<String>> {
        let db = self.db.read().await;
        crate::ingredientes::de_producto(&db, id_producto).await
    }

    async fn borrar_en_orden(&self, sentencias: &[&str], id: &str) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;
        conn.transaccion(async {
            for sql in sentencias {
                conn.execute(sql, vec![Value::Text(id.to_string())]).await.map_err(db_err)?;
            }
            Ok(())
        })
        .await
    }
}

fn cantidad_texto(x: f64) -> String {
    let s = format!("{:.3}", redondear_cantidad(x));
    let s = s.trim_end_matches('0').trim_end_matches('.');
    s.replace('.', ",")
}

/// El ajuste llega tarde: lo que se vio ya no es lo que hay (RI-55).
fn stock_cambiado(actual: Option<f64>) -> AppError {
    let ahora = match actual {
        Some(x) => format!("ahora hay {}", cantidad_texto(x)),
        None => "ahora no lleva stock suelto".to_string(),
    };
    AppError::conflict(format!(
        "Las existencias han cambiado mientras las ajustabas ({ahora}). Revísalas y vuelve a ajustar."
    ))
}


impl SqliteInventarioRepository {
    async fn guardar_producto(&self, id_usuario: &str, p: ProductoUpsert, precios: bool, recibir: bool) -> AppResult<String> {
        let g = self.db.write().await;
        let conn = &g;
        let id_producto = p.id.unwrap_or_else(new_id);
        conn.transaccion(async {
            // RI-55: el stock suelto sólo se escribe al CREAR el producto, y con su movimiento de
            // alta. Editando la ficha se ignora: el formulario llevaba el valor que había cargado y
            // lo reescribía sin rastro, pisando lo vendido mientras estaba abierto. Se cambia con
            // `ajustar_stock_suelto`.
            let es_nuevo = conn
                .query(
                    "SELECT 1 FROM Productos WHERE ID_Producto = ?1 LIMIT 1;",
                    vec![Value::Text(id_producto.to_string())],
                )
                .await
                .map_err(db_err)?
                .next()
                .await
                .map_err(db_err)?
                .is_none();
            if !precios {
                let mut filas = conn.query("SELECT Precio_Venta, IVA_Percent FROM Productos WHERE ID_Producto=?1", vec![Value::Text(id_producto.clone())]).await.map_err(db_err)?;
                let fila = filas.next().await.map_err(db_err)?;
                let coincide = match fila {
                    Some(f) => f.get_value(0).map_err(db_err)? == opt_dinero(p.precio_venta) && f.get_value(1).map_err(db_err)? == opt_real(p.iva_percent),
                    None => false,
                };
                if !coincide { return Err(AppError::coded(tpv_contracts::errors::ErrorCode::PermisoDenegado, "No puedes cambiar precios")); }
            }
            if es_nuevo && !recibir && p.stock_suelto.is_some_and(|v| v != 0.0) {
                return Err(AppError::coded(tpv_contracts::errors::ErrorCode::PermisoDenegado, "No puedes dar de alta existencias"));
            }
            let stock_suelto = if es_nuevo { p.stock_suelto.map(redondear_cantidad) } else { None };

            // AUD-20: el 'ALTA' del suelto va DELANTE del alta del producto y sólo entra si el
            // producto no existe. Aquí `es_nuevo` ya lo asegura, pero la condición viaja en la
            // sentencia y la vuelve a evaluar la nube, que puede tener ya este id: dos equipos que
            // vuelven a crear a la vez un producto que otro borró. Si el de la Handy entra antes,
            // el upsert de abajo conserva su stock, y sin la condición quedaba otro ALTA encima.
            // La FK la comprueba el COMMIT (`defer_foreign_keys`). Espejo de `upsertProducto`.
            if let Some(stock) = stock_suelto {
                conn.execute(
                    r#"
                    INSERT INTO Movimientos_Stock
                      (ID_Movimiento, ID_Producto, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
                    SELECT ?1, ?2, 'ALTA', ?3, ?3, 'Alta del producto', ?4, datetime('now','localtime')
                    WHERE NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?2);
                    "#,
                    vec![
                        Value::Text(new_id()),
                        Value::Text(id_producto.to_string()),
                        Value::Real(stock),
                        Value::Text(id_usuario.to_string()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }

            conn.execute(
                r#"
                INSERT INTO Productos (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta, Stock_Minimo, Unidad_Medida, Nombre_Imagen, Ruta_Imagen, Cantidad_Pedido_Esperada, Stock_Suelto, IVA_Percent)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                ON CONFLICT(ID_Producto) DO UPDATE SET
                  ID_Categoria = excluded.ID_Categoria,
                  ID_Proveedor = excluded.ID_Proveedor,
                  Nombre = excluded.Nombre,
                  Precio_Venta = excluded.Precio_Venta,
                  Stock_Minimo = excluded.Stock_Minimo,
                  Unidad_Medida = excluded.Unidad_Medida,
                  Nombre_Imagen = COALESCE(excluded.Nombre_Imagen, Productos.Nombre_Imagen),
                  Ruta_Imagen = COALESCE(excluded.Ruta_Imagen, Productos.Ruta_Imagen),
                  Cantidad_Pedido_Esperada = excluded.Cantidad_Pedido_Esperada,
                  IVA_Percent = excluded.IVA_Percent;
                "#,
                vec![
                    Value::Text(id_producto.to_string()),
                    Value::Text(p.id_categoria),
                    match p.id_proveedor {
                        Some(v) => Value::Text(v),
                        None => Value::Null,
                    },
                    Value::Text(p.nombre),
                    opt_dinero(p.precio_venta),
                    opt_real(p.stock_minimo),
                    opt_text(p.unidad_medida),
                    opt_text(p.nombre_imagen),
                    opt_text(p.ruta_imagen),
                    opt_real(p.cantidad_pedido_esperada),
                    opt_real(stock_suelto),
                    opt_real(p.iva_percent),
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
            // Sin la lista (una pantalla que no los enseña), los ingredientes se quedan como estaban.
            if let Some(ids) = p.ids_ingredientes {
                for (sql, args) in crate::ingredientes::sql_ingredientes_del_producto(&id_producto, &ids) {
                    conn.execute(sql, args).await.map_err(db_err)?;
                }
            }
            Ok(())
        }).await?;
        Ok(id_producto)
    }

}

#[cfg(test)]
mod tests_borrado_de_producto {
    //! INV-05: qué se puede borrar del catálogo y qué se lleva por delante.
    //!
    //! Un bar deja de servir cosas: el catálogo tiene que poder quitarlas. Lo único que lo impide
    //! es que el producto esté EN USO ahora mismo —en una comanda abierta—, porque quitarlo con
    //! una mesa a medias deja la línea sin precio ni cocina.
    //!
    //! Las ventas ya cobradas no lo impiden, pero sí deciden **cómo** se quita (RI-54): un producto
    //! con historia se archiva —sale de la carta y del inventario, y sus ventas, sus lotes y su
    //! trazabilidad se quedan— y uno sin historia se borra con sus lotes.

    use super::*;
    use crate::db::Db;
    use crate::ejecutor::Connection;
    use tpv_application::ports::inventario::InventarioRepository;

    use tpv_domain::dinero::Dinero;
    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("borrado_producto");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sentencias: &[&str]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in sentencias {
            conn.execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
        }
    }

    const CATALOGO: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('vendido', 'cat', 'Cafe', 130);",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('nuevo', 'cat', 'Te', 150);",
    ];

    /// Una venta ya cobrada: la comanda está cerrada y la línea guarda su snapshot.
    const UNA_VENTA_COBRADA: &[&str] = &[
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario)
           VALUES ('det', 'com', 'vendido', 'Cafe', 1, 130);",
    ];

    /// Una mesa a medias: la comanda sigue abierta.
    const UNA_COMANDA_ABIERTA: &[&str] = &[
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('viva', 'BARRA', '2026-01-02 12:00:00', 'Abierta');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario)
           VALUES ('det-vivo', 'viva', 'vendido', 'Cafe', 1, 130);",
    ];

    async fn existe(db: &Arc<Db>, id: &str) -> bool {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT 1 FROM Productos WHERE ID_Producto = ?1;",
                vec![Value::Text(id.to_string())],
            )
            .await
            .unwrap();
        rows.next().await.unwrap().is_some()
    }

    #[tokio::test]
    async fn un_producto_sin_ventas_se_borra() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        repo.delete_producto("nuevo").await.unwrap();

        assert!(!existe(&db, "nuevo").await);
    }

    #[tokio::test]
    async fn el_sql_replicado_tampoco_quita_un_producto_en_uso() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_COMANDA_ABIERTA).await;
        {
            let w = db.write().await;
            w.execute_batch("BEGIN;").await.unwrap();
            for sql in SQL_QUITAR_PRODUCTO {
                assert_eq!(w.execute(sql, vec![Value::Text("vendido".into())]).await.unwrap(), 0);
            }
            w.execute_batch("COMMIT;").await.unwrap();
        }
        let carta = SqliteInventarioRepository::new(db.clone()).list_productos_by_categoria("cat").await.unwrap();
        assert!(carta.iter().any(|p| p.base.id_producto == "vendido"));
    }

    #[tokio::test]
    async fn un_producto_ya_vendido_se_archiva_y_sale_de_la_carta() {
        // RI-54: un bar que deja de servir algo tiene que poder quitarlo de la carta, y lo vendido
        // tiene que seguir en las estadísticas. Se archiva: deja de salir en el catálogo y el nombre
        // queda libre para otro producto.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_VENTA_COBRADA).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        repo.delete_producto("vendido").await.unwrap();

        assert!(existe(&db, "vendido").await, "con historia no se borra");
        let carta = repo.list_productos_by_categoria("cat").await.unwrap();
        assert!(carta.iter().all(|p| p.base.id_producto != "vendido"), "pero ya no sale en la carta");
        sembrar(
            &db,
            &["INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre) VALUES ('otro', 'cat', 'Cafe');"],
        )
        .await;
        assert!(existe(&db, "otro").await, "y su nombre se puede volver a usar");
    }

    #[tokio::test]
    async fn un_producto_archivado_no_se_puede_volver_a_pedir() {
        // Una pantalla con la carta de antes en caché todavía puede ofrecerlo.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_VENTA_COBRADA).await;
        SqliteInventarioRepository::new(db.clone()).delete_producto("vendido").await.unwrap();

        let r = db.read().await;
        let err = crate::mesas::snapshot_del_producto(&r, "vendido").await.unwrap_err();
        assert!(err.to_string().contains("ya no está en la carta"), "{err}");
    }

    #[tokio::test]
    async fn la_venta_sobrevive_al_borrado_con_su_nombre_y_su_precio() {
        // Lo que no puede pasar es que borrar del catalogo borre historia: la linea sigue ahi, con
        // lo que se cobro, y como el producto se archiva conserva incluso el enlace (RI-54).
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_VENTA_COBRADA).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        repo.delete_producto("vendido").await.unwrap();

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT ID_Producto, Nombre_Producto, Precio_Unitario FROM Detalle_Comanda WHERE ID_Detalle='det';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().expect("la linea de la venta sigue existiendo");

        assert_eq!(
            crate::mapping::v_string(fila.get_value(0).unwrap()).as_deref(),
            Some("vendido"),
            "el enlace se queda"
        );
        assert_eq!(
            crate::mapping::v_string(fila.get_value(1).unwrap()).as_deref(),
            Some("Cafe"),
            "y el nombre se queda"
        );
        // El precio congelado en la linea: centimos, como en la columna (ARQ-01).
        assert_eq!(
            crate::mapping::v_dinero(fila.get_value(2).unwrap()),
            Some(Dinero::de_centimos(130))
        );
    }

    #[tokio::test]
    async fn un_producto_en_una_comanda_abierta_no_se_borra() {
        // Esta es la unica razon que queda para decir que no: quitarlo con una mesa a medias
        // dejaria la linea sin precio ni cocina y al camarero sin saber por que.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_COMANDA_ABIERTA).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        let err = repo.delete_producto("vendido").await.unwrap_err();
        let motivo = err.to_string();

        assert!(matches!(err, AppError::Validation(_)), "es una regla, no un fallo del motor: {err:?}");
        assert!(
            motivo.to_lowercase().contains("comanda abierta"),
            "el motivo tiene que decir donde esta el producto, y dice: {motivo}"
        );
        assert!(existe(&db, "vendido").await, "y el producto sigue en el catalogo");
    }

    #[tokio::test]
    async fn cerrar_la_comanda_desbloquea_el_borrado() {
        // El mensaje dice "cobrala o quita la linea": esto comprueba que hacerlo sirve de algo.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_COMANDA_ABIERTA).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        assert!(repo.delete_producto("vendido").await.is_err());

        sembrar(&db, &["UPDATE Comandas SET Estado = 'Pagada' WHERE ID_Comanda = 'viva';"]).await;

        repo.delete_producto("vendido").await.unwrap();
    }

    #[tokio::test]
    async fn el_producto_rechazado_sigue_entero() {
        // El borrado va en varios pasos (movimientos, lotes, alergenos, producto). Si la
        // comprobacion llegara tarde, el producto se quedaria a medio borrar: sin sus lotes, pero
        // todavia en el catalogo.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_COMANDA_ABIERTA).await;
        sembrar(
            &db,
            &["INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
                 VALUES ('lote', 'vendido', 'L-1', 10, '2026-01-01 10:00:00');"],
        )
        .await;
        let repo = SqliteInventarioRepository::new(db.clone());

        let _ = repo.delete_producto("vendido").await;

        assert!(existe(&db, "vendido").await, "el producto ha desaparecido");
        let r = db.read().await;
        let mut rows = r
            .query("SELECT 1 FROM Lotes_Producto WHERE ID_Producto='vendido';", Vec::<Value>::new())
            .await
            .unwrap();
        assert!(rows.next().await.unwrap().is_some(), "se ha llevado los lotes por delante");
    }

    #[tokio::test]
    async fn borrar_un_producto_se_lleva_sus_lotes() {
        // Decision explicita: si el bar ya no quiere el producto, su inventario se va con el. Los
        // lotes son stock de ESE producto y no significan nada sin su ficha.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(
            &db,
            &["INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
                 VALUES ('lote', 'nuevo', 'L-1', 10, '2026-01-01 10:00:00');"],
        )
        .await;
        let repo = SqliteInventarioRepository::new(db.clone());

        repo.delete_producto("nuevo").await.unwrap();

        let r = db.read().await;
        let mut rows = r
            .query("SELECT 1 FROM Lotes_Producto WHERE ID_Producto='nuevo';", Vec::<Value>::new())
            .await
            .unwrap();
        assert!(rows.next().await.unwrap().is_none(), "los lotes se van con el producto");
    }

    #[tokio::test]
    async fn el_rastro_del_consumo_suelto_sobrevive() {
        // Suelto_Consumos guarda el ID_Producto sin FK: es el rastro de un consumo que ocurrio y
        // con el se cuadra el stock (INV-06). Si se fuera con el producto, la reconciliacion de un
        // arqueo antiguo dejaria de cuadrar.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_VENTA_COBRADA).await;
        sembrar(
            &db,
            &[
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago', 'com', '2026-01-02 12:30:00', 'Efectivo', 260, 'TOTAL');",
                "INSERT INTO Suelto_Consumos (ID_Detalle, ID_Producto, ID_Pago, Cantidad)
                   VALUES ('det', 'vendido', 'pago', 2);",
            ],
        )
        .await;
        let repo = SqliteInventarioRepository::new(db.clone());

        repo.delete_producto("vendido").await.unwrap();

        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT Cantidad FROM Suelto_Consumos WHERE ID_Producto='vendido';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().expect("el rastro del consumo sigue ahi");
        assert_eq!(crate::mapping::v_f64(fila.get_value(0).unwrap()), Some(2.0));
    }

    #[tokio::test]
    async fn borrar_uno_no_toca_al_de_al_lado() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        repo.delete_producto("nuevo").await.unwrap();

        assert!(existe(&db, "vendido").await);
    }
}

#[cfg(test)]
mod tests_borrado_de_categoria {
    //! Borrar una categoría se lleva sus productos: los vendidos se archivan y se quedan sin
    //! categoría, los demás se borran, y la categoría desaparece. Nada, si alguno está en una
    //! comanda abierta.

    use super::*;
    use crate::db::Db;
    use crate::ejecutor::Connection;
    use tpv_application::ports::inventario::InventarioRepository;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("borrado_categoria");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sentencias: &[&str]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in sentencias {
            conn.execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
        }
    }

    async fn texto(db: &Arc<Db>, sql: &str) -> Vec<String> {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let mut out = Vec::new();
        while let Some(f) = rows.next().await.unwrap() {
            out.push(crate::mapping::v_string(f.get_value(0).unwrap()).unwrap_or_else(|| "NULL".into()));
        }
        out
    }

    /// `Bar` con un producto vendido, uno sin vender con su lote y uno archivado de antes; y
    /// `Cocina`, que no se toca.
    const CATALOGO: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('bar', 'Bar');",
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cocina', 'Cocina');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('vendido', 'bar', 'Cafe', 130);",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('nuevo', 'bar', 'Te', 150);",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Archivado_En)
           VALUES ('viejo', 'bar', 'Mosto', 120, '2026-01-01 09:00:00');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('tortilla', 'cocina', 'Tortilla', 900);",
        "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Stock_Disponible, Fecha_Entrada)
           VALUES ('lote', 'nuevo', 'L-1', 10, '2026-01-01 10:00:00');",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario)
           VALUES ('det', 'com', 'vendido', 'Cafe', 1, 130);",
    ];

    const UNA_COMANDA_ABIERTA: &[&str] = &[
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('viva', 'BARRA', '2026-01-02 13:00:00', 'Abierta');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario)
           VALUES ('det-vivo', 'viva', 'nuevo', 'Te', 1, 150);",
    ];

    const PRODUCTOS: &str =
        "SELECT ID_Producto || ':' || COALESCE(ID_Categoria, 'sin') || ':' || (Archivado_En IS NOT NULL) FROM Productos ORDER BY ID_Producto;";

    #[tokio::test]
    async fn se_lleva_sus_productos_y_conserva_las_ventas() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        repo.borrar_categoria("bar").await.unwrap();

        assert_eq!(texto(&db, "SELECT ID_Categoria FROM Categorias_Producto;").await, vec!["cocina"]);
        assert_eq!(
            texto(&db, PRODUCTOS).await,
            vec!["tortilla:cocina:0", "vendido:sin:1", "viejo:sin:1"],
            "el vendido se archiva, el archivado de antes se suelta y el nuevo se borra"
        );
        assert!(texto(&db, "SELECT ID_Lote FROM Lotes_Producto;").await.is_empty(), "con su lote");
        assert_eq!(texto(&db, "SELECT ID_Producto FROM Detalle_Comanda;").await, vec!["vendido"]);
        // La ficha de un archivado sin categoría se sigue leyendo.
        assert_eq!(repo.get_producto("vendido").await.unwrap().unwrap().id_categoria, "");
    }

    #[tokio::test]
    async fn el_nombre_queda_libre() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        repo.borrar_categoria("bar").await.unwrap();

        repo.create_categoria(
            CategoriaUpsert::validar(None, "Bar".into(), String::new(), String::new(), true, false).unwrap(),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn con_un_producto_en_una_comanda_abierta_no_se_toca_nada() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_COMANDA_ABIERTA).await;
        let repo = SqliteInventarioRepository::new(db.clone());

        let err = repo.borrar_categoria("bar").await.unwrap_err();

        assert!(matches!(err, AppError::Validation(_)), "{err:?}");
        assert_eq!(err.to_string(), MSG_CATEGORIA_EN_COMANDA_ABIERTA);
        assert_eq!(texto(&db, "SELECT ID_Categoria FROM Categorias_Producto ORDER BY 1;").await, vec!["bar", "cocina"]);
        assert_eq!(
            texto(&db, PRODUCTOS).await,
            vec!["nuevo:bar:0", "tortilla:cocina:0", "vendido:bar:0", "viejo:bar:1"]
        );
        assert_eq!(texto(&db, "SELECT ID_Lote FROM Lotes_Producto;").await, vec!["lote"]);
    }

    #[tokio::test]
    async fn el_sql_replicado_tampoco_toca_nada_con_una_comanda_abierta() {
        // La otra punta vuelve a evaluar cada sentencia al aplicar la réplica.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, CATALOGO).await;
        sembrar(&db, UNA_COMANDA_ABIERTA).await;
        {
            let w = db.write().await;
            w.execute_batch("BEGIN;").await.unwrap();
            for sql in SQL_QUITAR_CATEGORIA {
                assert_eq!(w.execute(sql, vec![Value::Text("bar".into())]).await.unwrap(), 0, "{sql}");
            }
            w.execute_batch("COMMIT;").await.unwrap();
        }
        assert_eq!(texto(&db, "SELECT COUNT(*) FROM Productos WHERE ID_Categoria = 'bar';").await, vec!["3"]);
    }
}

#[cfg(test)]
mod tests_alta_de_lote {
    //! AUD-20: dar de alta un lote con el id de uno que ya existe. El alta del lote es pura (INV-02)
    //! y su movimiento 'ALTA' tampoco entra: va delante y sólo si el lote no existe. Sin esa
    //! condición el lote se quedaba igual con otro ALTA, y la reconciliación avisaba al
    //! administrador de un descuadre que ningún ajuste cerraba (un ajuste mueve a la vez lo guardado
    //! y lo calculado). La condición viaja en la sentencia: la vuelve a evaluar quien aplica la
    //! réplica, aquí la de una Handy y en la nube la de esta Main.

    use super::*;
    use crate::ejecutor::Connection;
    use crate::reconciliacion::SqliteReconciliacionRepository;
    use crate::sync::SqliteSyncRepository;
    use serde_json::json;
    use tpv_application::ports::reconciliacion::ReconciliacionRepository;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{SqlStatement, SyncChange};

    const CATALOGO: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
           VALUES ('cerveza', 'cat', 'Cerveza', 200);",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('autor', '00000000-0000-7000-8000-000000000001', 'autor@ejemplo.test', 'x', 'Autor');",
    ];

    async fn preparar(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(nombre);
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in CATALOGO {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        db
    }

    fn lote(id: &str, codigo: &str, stock: f64) -> LoteNuevo {
        LoteNuevo {
            id: Some(id.into()),
            id_producto: "cerveza".into(),
            codigo_lote: codigo.into(),
            caducidad: None,
            stock_disponible: stock,
            fecha_entrada: Some("2026-01-01 10:00:00".into()),
            coste_unitario: None,
            id_proveedor: None,
            notas: None,
        }
    }

    /// Código, lo guardado, cuántos movimientos tiene y lo que suman: lo que cuadra la reconciliación.
    async fn cuadre(db: &Arc<Db>, id_lote: &str) -> Option<(String, f64, i64, f64)> {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT l.Codigo_Lote, l.Stock_Disponible,
                        (SELECT COUNT(*) FROM Movimientos_Stock m WHERE m.ID_Lote = l.ID_Lote),
                        (SELECT COALESCE(SUM(m.Delta), 0) FROM Movimientos_Stock m WHERE m.ID_Lote = l.ID_Lote)
                 FROM Lotes_Producto l WHERE l.ID_Lote = ?1;",
                vec![Value::Text(id_lote.into())],
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap()?;
        Some((
            s(fila.get_value(0).unwrap()),
            fl(fila.get_value(1).unwrap()),
            v_i64(fila.get_value(2).unwrap()).unwrap(),
            fl(fila.get_value(3).unwrap()),
        ))
    }

    #[tokio::test]
    async fn el_mismo_lote_otra_vez_no_anota_otro_alta() {
        let db = preparar("alta_lote_repetida").await;
        let repo = SqliteInventarioRepository::new(db.clone());
        repo.create_lote("autor", lote("lote-1", "L1", 10.0)).await.unwrap();
        // El mismo id con otro código y 50, o con el mismo código y 7: no es un error y no hace nada.
        repo.create_lote("autor", lote("lote-1", "L2", 50.0)).await.unwrap();
        repo.create_lote("autor", lote("lote-1", "L1", 7.0)).await.unwrap();

        assert_eq!(cuadre(&db, "lote-1").await, Some(("L1".into(), 10.0, 1, 10.0)));
        let descuadrados = SqliteReconciliacionRepository::new(db.clone())
            .lotes_descuadrados(0.001)
            .await
            .unwrap();
        assert!(descuadrados.is_empty(), "{descuadrados:?}");
    }

    #[tokio::test]
    async fn lo_que_sube_lleva_el_movimiento_delante_del_lote_y_con_la_condicion() {
        let db = preparar("alta_lote_outbox").await;
        SqliteInventarioRepository::new(db.clone())
            .create_lote("autor", lote("lote-1", "L1", 10.0))
            .await
            .unwrap();
        let r = db.read().await;
        let mut rows = r
            .query("SELECT Statements_Json FROM _Sync_Outbox;", Vec::<Value>::new())
            .await
            .unwrap();
        let json = s(rows.next().await.unwrap().expect("el alta está en el outbox").get_value(0).unwrap());
        assert!(rows.next().await.unwrap().is_none(), "una sola operación");
        let sentencias: Vec<SqlStatement> = serde_json::from_str(&json).unwrap();
        assert_eq!(sentencias.len(), 2, "{json}");
        assert!(sentencias[0].sql.contains("INSERT INTO Movimientos_Stock"), "{json}");
        assert!(
            sentencias[0]
                .sql
                .contains("WHERE NOT EXISTS (SELECT 1 FROM Lotes_Producto WHERE ID_Lote = ?2)"),
            "{json}"
        );
        assert!(sentencias[1].sql.contains("INSERT INTO Lotes_Producto"), "{json}");
    }

    /// Lo que difunde el `TenantHub` tras el alta de un lote desde una Handy, con la hora ya fijada
    /// por el DO. `contract.test.ts` del worker («un alta con un id que ya existe no anota otro
    /// movimiento ALTA») comprueba que es este texto, con `datetime('now','localtime')` en vez de la
    /// hora.
    fn alta_de_la_handy(id_lote: &str, codigo: &str, stock: f64, id_mov: &str) -> Vec<SqlStatement> {
        let ahora = "'2026-11-11 10:00:00'";
        let nulo = serde_json::Value::Null;
        vec![
            SqlStatement {
                sql: format!(
                    "INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha) \
                     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, {ahora} \
                     WHERE NOT EXISTS (SELECT 1 FROM Lotes_Producto WHERE ID_Lote = ?2);"
                ),
                args: vec![
                    json!(id_mov),
                    json!(id_lote),
                    json!("ALTA"),
                    json!(stock),
                    json!(stock),
                    nulo.clone(),
                    json!("autor"),
                ],
            },
            SqlStatement {
                sql: format!(
                    "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas) \
                     VALUES (?1, ?2, ?3, COALESCE(NULLIF(?4, ''), {ahora}), NULLIF(?5, ''), ?6, ?7, ?8, ?9) \
                     ON CONFLICT(ID_Lote) DO NOTHING;"
                ),
                args: vec![
                    json!(id_lote),
                    json!("cerveza"),
                    json!(codigo),
                    json!("2026-01-01 00:00:00"),
                    nulo.clone(),
                    json!(stock),
                    nulo.clone(),
                    nulo.clone(),
                    nulo,
                ],
            },
        ]
    }

    #[tokio::test]
    async fn la_replica_de_un_alta_repetida_no_anota_nada_y_la_de_un_lote_nuevo_si() {
        let db = preparar("alta_lote_replica").await;
        SqliteInventarioRepository::new(db.clone())
            .create_lote("autor", lote("lote-1", "L1", 10.0))
            .await
            .unwrap();

        let r = SqliteSyncRepository::new(db.clone())
            .apply_changes(vec![
                SyncChange {
                    op_id: "op-repetida".into(),
                    seq: 1,
                    statements: alta_de_la_handy("lote-1", "L2", 50.0, "019a0000-0000-7000-8000-0000000000f0"),
                },
                SyncChange {
                    op_id: "op-nueva".into(),
                    seq: 2,
                    statements: alta_de_la_handy("lote-9", "L9", 4.0, "019a0000-0000-7000-8000-0000000000f1"),
                },
            ])
            .await
            .unwrap();

        assert_eq!(r.aplicadas, vec!["op-repetida".to_string(), "op-nueva".to_string()]);
        assert_eq!(cuadre(&db, "lote-1").await, Some(("L1".into(), 10.0, 1, 10.0)));
        assert_eq!(cuadre(&db, "lote-9").await, Some(("L9".into(), 4.0, 1, 4.0)));
    }
}

#[cfg(test)]
mod tests_alta_del_suelto {
    //! AUD-20: el 'ALTA' del stock suelto de un producto nuevo. La Main decide que es nuevo dentro
    //! de su transacción, pero lo que replica lo aplica otra base que puede tener ya ese producto:
    //! un producto sin ventas que otro equipo borra, con su ficha abierta en la Main y en una Handy;
    //! las dos lo guardan y lo vuelven a crear con el mismo id antes de recibir lo del otro. Si el de
    //! la Handy entra antes en la nube, el upsert de la Main conserva ese stock, y sin la condición su
    //! ALTA quedaba encima. El movimiento va delante del alta y sólo si el producto no existe, como
    //! en `upsertProducto` del worker.

    use super::*;
    use crate::ejecutor::Connection;
    use crate::sync::SqliteSyncRepository;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{SqlStatement, SyncChange};

    /// El producto ya no está: lo borró otro equipo y las dos bases lo saben.
    const SIN_EL_PRODUCTO: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bar');",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('autor', '00000000-0000-7000-8000-000000000001', 'autor@ejemplo.test', 'x', 'Autor');",
    ];

    async fn base(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(nombre);
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            for sql in SIN_EL_PRODUCTO {
                conn.execute(sql, Vec::<Value>::new())
                    .await
                    .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
            }
        }
        db
    }

    /// Guarda la ficha de `hielo` con su stock suelto y devuelve lo que replica esa escritura.
    async fn guardar_hielo(db: &Arc<Db>, stock: f64, op_id: &str, seq: i64) -> SyncChange {
        SqliteInventarioRepository::new(db.clone())
            .upsert_producto_autorizado(
                "autor",
                ProductoUpsert {
                    id: Some("hielo".into()),
                    id_categoria: "cat".into(),
                    id_proveedor: None,
                    nombre: "Hielo".into(),
                    precio_venta: None,
                    stock_minimo: None,
                    unidad_medida: None,
                    nombre_imagen: None,
                    ruta_imagen: None,
                    cantidad_pedido_esperada: None,
                    stock_suelto: Some(stock),
                    iva_percent: None,
                    ids_alergenos: vec![],
                    ids_ingredientes: None,
                },
                true,
                true,
            )
            .await
            .unwrap();
        let r = db.read().await;
        let mut rows = r
            .query("SELECT Statements_Json FROM _Sync_Outbox;", Vec::<Value>::new())
            .await
            .unwrap();
        let json = s(rows.next().await.unwrap().expect("el alta está en el outbox").get_value(0).unwrap());
        let statements: Vec<SqlStatement> = serde_json::from_str(&json).unwrap();
        SyncChange { op_id: op_id.into(), seq, statements }
    }

    /// Lo guardado, cuántos movimientos tiene y lo que suman.
    async fn cuadre(db: &Arc<Db>) -> (f64, i64, f64) {
        let r = db.read().await;
        let mut rows = r
            .query(
                "SELECT p.Stock_Suelto,
                        (SELECT COUNT(*) FROM Movimientos_Stock m WHERE m.ID_Producto = p.ID_Producto),
                        (SELECT COALESCE(SUM(m.Delta), 0) FROM Movimientos_Stock m WHERE m.ID_Producto = p.ID_Producto)
                 FROM Productos p WHERE p.ID_Producto = 'hielo';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().expect("el producto existe");
        (
            fl(fila.get_value(0).unwrap()),
            v_i64(fila.get_value(1).unwrap()).unwrap(),
            fl(fila.get_value(2).unwrap()),
        )
    }

    #[tokio::test]
    async fn dos_equipos_que_recrean_el_mismo_producto_no_dejan_dos_altas() {
        // Cada equipo lo da de alta en su base antes de recibir lo del otro.
        let main = base("suelto_main").await;
        let nube = base("suelto_nube").await;
        let de_la_main = guardar_hielo(&main, 7.0, "op-main", 2).await;
        let de_la_handy = guardar_hielo(&nube, 5.0, "op-handy", 1).await;

        // Lo de la Handy entró antes en la nube; lo de la Main llega después.
        SqliteSyncRepository::new(nube.clone()).apply_changes(vec![de_la_main]).await.unwrap();
        // Y la Main recibe lo de la Handy.
        SqliteSyncRepository::new(main.clone()).apply_changes(vec![de_la_handy]).await.unwrap();

        // Cada base se queda con su stock y un solo ALTA que lo explica.
        assert_eq!(cuadre(&nube).await, (5.0, 1, 5.0));
        assert_eq!(cuadre(&main).await, (7.0, 1, 7.0));
    }

    #[tokio::test]
    async fn lo_que_sube_lleva_el_movimiento_delante_del_producto_y_con_la_condicion() {
        let main = base("suelto_outbox").await;
        let cambio = guardar_hielo(&main, 7.0, "op-main", 1).await;
        let sql: Vec<&str> = cambio.statements.iter().map(|s| s.sql.as_str()).collect();
        assert!(sql[0].contains("INSERT INTO Movimientos_Stock"), "{sql:?}");
        assert!(
            sql[0].contains("WHERE NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?2)"),
            "{sql:?}"
        );
        assert!(sql[1].contains("INSERT INTO Productos"), "{sql:?}");
    }
}


#[cfg(test)]
mod tests_categoria_repetida {
    //! INV-INC-03: repetir el nombre de una categoría enseñaba «UNIQUE constraint failed:
    //! Categorias_Producto.Nombre».

    use super::*;
    use crate::db::Db;

    async fn repo() -> (SqliteInventarioRepository, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("categoria_repetida");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteInventarioRepository::new(db), dir)
    }

    fn categoria(id: Option<&str>, nombre: &str) -> CategoriaUpsert {
        CategoriaUpsert::validar(id.map(Into::into), nombre.into(), String::new(), String::new(), true, false).unwrap()
    }

    #[tokio::test]
    async fn otra_con_el_mismo_nombre_se_rechaza_con_su_frase() {
        let (repo, dir) = repo().await;
        repo.create_categoria(categoria(Some("a"), "Bebidas")).await.unwrap();

        let e = repo.create_categoria(categoria(None, "Bebidas")).await.unwrap_err();
        assert_eq!(e.code(), tpv_contracts::errors::ErrorCode::Conflict);
        assert_eq!(e.to_string(), MSG_CATEGORIA_REPETIDA);

        // La misma, guardada otra vez con su nombre, sí.
        repo.create_categoria(categoria(Some("a"), "Bebidas")).await.unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
