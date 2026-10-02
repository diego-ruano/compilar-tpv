//! Adaptador SQLite de las **alertas de stock** (`StockAlertasRepository`).
//!
//! Dos lecturas: los productos con stock total negativo (sobreventa) y, para poder cerrar los avisos
//! de los que se recuperaron, los IDs de producto que hoy tienen una notificación de stock negativo
//! activa. Solo lee: emitir/resolver es cosa del `Notifier`.

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::stock_alertas::{ProductoNegativo, StockAlertasRepository};

use crate::db::{Db, Reader};
use crate::mapping::{v_f64, v_string};

/// Tope de filas por pasada: una sobreventa masiva (BD a medias) no debe volcar miles de líneas; con
/// las peores ya hay señal para ir a recontar.
const MAX_FILAS: i64 = 200;

/// Tolerancia negativa: por debajo de -0,001 es sobreventa real, no ruido de sumar muchos `REAL`.
/// (Espejo de `TOLERANCIA_STOCK` de la reconciliación.)
const UMBRAL_NEGATIVO: f64 = -0.001;

/// Stock total por producto = suma del disponible de sus lotes + su stock suelto. Es lo que ve el
/// usuario en Inventario, así que la alerta cuadra con esa cifra: un producto está "en negativo"
/// cuando ese total baja de cero.
const SQL_NEGATIVOS: &str = r#"
    SELECT id_producto, nombre, stock_total
    FROM (
        SELECT
            p.ID_Producto AS id_producto,
            COALESCE(p.Nombre, '') AS nombre,
            COALESCE(
                (SELECT SUM(l.Stock_Disponible) FROM Lotes_Producto l WHERE l.ID_Producto = p.ID_Producto),
                0
            ) + COALESCE(p.Stock_Suelto, 0) AS stock_total
        FROM Productos p
        WHERE p.Archivado_En IS NULL
    )
    WHERE stock_total < ?1
    ORDER BY stock_total ASC
    LIMIT ?2;
"#;

/// IDs de producto con una notificación de stock negativo activa. La clave es `<prefijo><ID_Producto>`,
/// así que se filtra por el prefijo y se recorta en Rust (el prefijo lo fija el caso de uso).
const SQL_ALERTAS_ACTIVAS: &str = r#"
    SELECT Clave_Dedupe
    FROM Notificaciones
    WHERE Estado = 'activa' AND Clave_Dedupe LIKE ?1 || '%';
"#;

pub struct SqliteStockAlertasRepository {
    db: Arc<Db>,
}

impl SqliteStockAlertasRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

#[async_trait]
impl StockAlertasRepository for SqliteStockAlertasRepository {
    async fn productos_en_negativo(&self) -> AppResult<Vec<ProductoNegativo>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                SQL_NEGATIVOS,
                vec![Value::Real(UMBRAL_NEGATIVO), Value::Integer(MAX_FILAS)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(ProductoNegativo {
                id_producto: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                stock_total: v_f64(row.get_value(2).map_err(db_err)?).unwrap_or(0.0),
            });
        }
        Ok(out)
    }

    async fn productos_con_alerta_activa(&self, prefijo: &str) -> AppResult<Vec<String>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(SQL_ALERTAS_ACTIVAS, vec![Value::Text(prefijo.to_string())])
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            if let Some(clave) = v_string(row.get_value(0).map_err(db_err)?) {
                if let Some(id) = clave.strip_prefix(prefijo) {
                    if !id.is_empty() {
                        out.push(id.to_string());
                    }
                }
            }
        }
        Ok(out)
    }
}
