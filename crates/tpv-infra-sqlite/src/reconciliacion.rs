//! Adaptador SQLite de la **reconciliación** (`ReconciliacionRepository`, INV-06 / DB-14).
//!
//! Dos consultas que recalculan desde el origen lo que otras columnas guardan ya sumado. Solo
//! leen: la decisión de qué hacer con un descuadre es de quien lleva el negocio, no del job.

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reconciliacion::{
    ClienteDescuadrado, LoteDescuadrado, ReconciliacionRepository,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{v_f64, v_string};

/// Tope de filas por pasada. Un descuadre masivo (BD corrupta, migración a medias) no debe
/// convertirse en una notificación de miles de líneas: con las peores ya hay señal suficiente para
/// ir a mirar.
const MAX_FILAS: i64 = 200;

pub struct SqliteReconciliacionRepository {
    db: Arc<Db>,
}

impl SqliteReconciliacionRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// El disponible que DEBERÍA tener cada lote según su historial.
///
/// `SUM(movimientos) - SUM(consumos)`: el alta y los ajustes suman (o restan) y cada línea de
/// comanda cobrada resta lo suyo. Al anular un pago, la fila de `Lote_Consumos` se borra, así que
/// la resta desaparece sola y no hace falta modelar devoluciones aparte.
const SQL_LOTES: &str = r#"
    SELECT id_lote, codigo_lote, producto, guardado, calculado
    FROM (
        SELECT
            l.ID_Lote                     AS id_lote,
            COALESCE(l.Codigo_Lote, '')   AS codigo_lote,
            COALESCE(p.Nombre, '')        AS producto,
            COALESCE(l.Stock_Disponible, 0) AS guardado,
            COALESCE((
                SELECT SUM(m.Delta) FROM Movimientos_Stock m WHERE m.ID_Lote = l.ID_Lote
            ), 0)
            - COALESCE((
                SELECT SUM(c.Cantidad) FROM Lote_Consumos c WHERE c.ID_Lote = l.ID_Lote
            ), 0)                         AS calculado
        FROM Lotes_Producto l
        LEFT JOIN Productos p ON p.ID_Producto = l.ID_Producto
    )
    WHERE ABS(guardado - calculado) > ?1
    ORDER BY ABS(guardado - calculado) DESC
    LIMIT ?2;
"#;

/// El gasto que DEBERÍA tener cada cliente: la suma de los pagos de las comandas que cuelgan de
/// sus reservas, que es exactamente el camino por el que se acredita al cobrar
/// (`sumar_gasto_cliente_por_comanda`). Redondeado a 2 decimales, como los incrementos.
const SQL_CLIENTES: &str = r#"
    SELECT id_cliente, nombre, guardado, calculado
    FROM (
        SELECT
            c.ID_Cliente               AS id_cliente,
            COALESCE(c.Nombre, '')     AS nombre,
            ROUND(COALESCE(c.Total_Gastado, 0), 2) AS guardado,
            ROUND(COALESCE((
                SELECT SUM(pg.Importe_Total)
                FROM Pagos pg
                JOIN Comandas co ON co.ID_Comanda = pg.ID_Comanda
                JOIN Reservas r  ON r.ID_Reserva  = co.ID_Reserva
                WHERE r.ID_Cliente = c.ID_Cliente
            ), 0), 2)                  AS calculado
        FROM Clientes c
    )
    WHERE ABS(guardado - calculado) > ?1
    ORDER BY ABS(guardado - calculado) DESC
    LIMIT ?2;
"#;

/// El gasto de UN cliente, por el mismo camino que `SQL_CLIENTES`: los pagos de las comandas
/// que cuelgan de sus reservas.
const SQL_GASTO_DE_UNO: &str = r#"
    SELECT ROUND(COALESCE((
        SELECT SUM(pg.Importe_Total)
        FROM Pagos pg
        JOIN Comandas co ON co.ID_Comanda = pg.ID_Comanda
        JOIN Reservas r  ON r.ID_Reserva  = co.ID_Reserva
        WHERE r.ID_Cliente = c.ID_Cliente
    ), 0), 2)
    FROM Clientes c
    WHERE c.ID_Cliente = ?1
    LIMIT 1;
"#;

#[async_trait]
impl ReconciliacionRepository for SqliteReconciliacionRepository {
    async fn lotes_descuadrados(&self, tolerancia: f64) -> AppResult<Vec<LoteDescuadrado>> {
        let r = self.db.read().await;
        let mut rows = r
            .query(
                SQL_LOTES,
                vec![Value::Real(tolerancia), Value::Integer(MAX_FILAS)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(LoteDescuadrado {
                id_lote: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                codigo_lote: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                producto: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
                guardado: v_f64(row.get_value(3).map_err(db_err)?).unwrap_or(0.0),
                calculado: v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(0.0),
            });
        }
        Ok(out)
    }

    async fn clientes_descuadrados(&self, tolerancia: f64) -> AppResult<Vec<ClienteDescuadrado>> {
        let r = self.db.read().await;
        let mut rows = r
            .query(
                SQL_CLIENTES,
                vec![Value::Real(tolerancia), Value::Integer(MAX_FILAS)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(ClienteDescuadrado {
                id_cliente: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                guardado: v_f64(row.get_value(2).map_err(db_err)?).unwrap_or(0.0),
                calculado: v_f64(row.get_value(3).map_err(db_err)?).unwrap_or(0.0),
            });
        }
        Ok(out)
    }

    async fn recalcular_gasto(&self, id_cliente: &str) -> AppResult<Option<f64>> {
        // Cálculo y escritura bajo el MISMO guard: entre leer los pagos y escribir el total no
        // puede colarse un cobro que dejaría el valor obsoleto nada más nacer.
        let w = self.db.write().await;

        let calculado = {
            let mut rows = w
                .query(SQL_GASTO_DE_UNO, vec![Value::Text(id_cliente.to_string())])
                .await
                .map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => v_f64(row.get_value(0).map_err(db_err)?).unwrap_or(0.0),
                // Sin fila no hay cliente: no se inventa una.
                None => return Ok(None),
            }
        };

        // Por `execute` (no por `raw`): es un dato de negocio y se replica a la nube como
        // cualquier otra escritura de la Main.
        w.execute(
            "UPDATE Clientes SET Total_Gastado = ?2 WHERE ID_Cliente = ?1;",
            vec![Value::Text(id_cliente.to_string()), Value::Real(calculado)],
        )
        .await
        .map_err(db_err)?;

        Ok(Some(calculado))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libsql::Connection;

    // Unicidad entre tests en paralelo (mismo patrón que migrations.rs: contador + PID, no reloj).
    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        format!(
            "{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// BD real en un temporal, con el esquema que producen las migraciones.
    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("tpv_recon_test_{}", uniq()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    /// Siembra por conexión CRUDA: los datos de partida no son escrituras de negocio y no deben
    /// acabar en el outbox.
    async fn sembrar(db: &Arc<Db>, sentencias: &[&str]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in sentencias {
            conn.execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
        }
    }

    async fn escalar(db: &Arc<Db>, sql: &str) -> f64 {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().expect("sin filas");
        crate::mapping::v_f64(row.get_value(0).unwrap()).unwrap_or(0.0)
    }

    /// Producto con un lote de 10 y su movimiento de alta: el estado cuadrado del que parten los
    /// casos.
    const SEMILLA_LOTE: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod', 'cat', 'Cerveza', 2.5);",
        "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Stock_Disponible)
           VALUES ('lote', 'prod', 'L-1', '2026-01-01 10:00:00', 10);",
        "INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Fecha)
           VALUES ('mov', 'lote', 'ALTA', 10, 10, '2026-01-01 10:00:00');",
    ];

    /// Un ticket de barra con una línea, para poder colgar de él consumos y pagos.
    const SEMILLA_TICKET: &[&str] = &[
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('det', 'com', 'prod', 3, 2.5);",
    ];

    #[tokio::test]
    async fn un_lote_intacto_no_sale_como_descuadrado() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;

        let repo = SqliteReconciliacionRepository::new(db);
        let out = repo.lotes_descuadrados(0.001).await.unwrap();

        assert!(out.is_empty(), "un lote recién dado de alta cuadra: {out:?}");
    }

    #[tokio::test]
    async fn el_consumo_de_una_venta_sigue_cuadrando() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        sembrar(&db, SEMILLA_TICKET).await;
        // Venta de 3: baja el disponible y queda su traza.
        sembrar(
            &db,
            &[
                "UPDATE Lotes_Producto SET Stock_Disponible = 7 WHERE ID_Lote = 'lote';",
                "INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, Cantidad) VALUES ('det', 'lote', 3);",
            ],
        )
        .await;

        let repo = SqliteReconciliacionRepository::new(db);
        let out = repo.lotes_descuadrados(0.001).await.unwrap();

        assert!(out.is_empty(), "10 de alta - 3 consumidos = 7: {out:?}");
    }

    #[tokio::test]
    async fn un_stock_cambiado_sin_dejar_rastro_se_detecta() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        // Alguien toca el disponible sin movimiento ni consumo: exactamente lo que el chequeo
        // busca (una venta que no llegó a aplicarse, un ajuste que se perdió).
        sembrar(
            &db,
            &["UPDATE Lotes_Producto SET Stock_Disponible = 4 WHERE ID_Lote = 'lote';"],
        )
        .await;

        let repo = SqliteReconciliacionRepository::new(db);
        let out = repo.lotes_descuadrados(0.001).await.unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id_lote, "lote");
        assert_eq!(out[0].guardado, 4.0);
        assert_eq!(out[0].calculado, 10.0);
        assert_eq!(out[0].desviacion(), -6.0, "faltan 6 respecto al historial");
        assert_eq!(out[0].producto, "Cerveza");
    }

    #[tokio::test]
    async fn el_gasto_del_cliente_se_contrasta_con_sus_pagos_sin_tocarlo() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        sembrar(
            &db,
            &[
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona', 'Salon');",
                "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                   VALUES ('mesa', 'zona', '1', 4, 0, 0, 'rect', 10, 10);",
                "INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('cli', 'Ana', 0);",
                "INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales)
                   VALUES ('res', 'cli', 'mesa', '2026-01-02', '13:00', 'COMIDA', 2);",
                "INSERT INTO Comandas (ID_Comanda, ID_Mesa, ID_Reserva, Canal, Fecha_Hora_Apertura, Estado)
                   VALUES ('com', 'mesa', 'res', 'MESA', '2026-01-02 13:00:00', 'Pagada');",
                // El cobro ocurrió: el pago está, pero el gasto del cliente se quedó a 0 (el
                // incremento es best-effort y el pago commitea igual si falla).
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago', 'com', '2026-01-02 14:00:00', 'EFECTIVO', 25.50, 'TOTAL');",
            ],
        )
        .await;

        let repo = SqliteReconciliacionRepository::new(db.clone());
        let descuadrados = repo.clientes_descuadrados(0.005).await.unwrap();

        assert_eq!(descuadrados.len(), 1);
        assert_eq!(descuadrados[0].nombre, "Ana");
        assert_eq!(descuadrados[0].guardado, 0.0);
        assert_eq!(descuadrados[0].calculado, 25.50);

        // Y NO lo arregla: la ficha sigue como estaba hasta que el dueño decida.
        assert_eq!(
            escalar(&db, "SELECT Total_Gastado FROM Clientes WHERE ID_Cliente='cli';").await,
            0.0,
            "el job informa, no escribe"
        );

        // La corrección es la acción manual, y esa sí escribe.
        let nuevo = repo.recalcular_gasto("cli").await.unwrap();

        assert_eq!(nuevo, Some(25.50));
        assert_eq!(
            escalar(&db, "SELECT Total_Gastado FROM Clientes WHERE ID_Cliente='cli';").await,
            25.50
        );
        assert!(
            repo.clientes_descuadrados(0.005).await.unwrap().is_empty(),
            "y con eso deja de estar descuadrado"
        );
    }

    #[tokio::test]
    async fn recalcular_un_cliente_que_no_existe_no_inventa_nada() {
        let (db, _dir) = db_temporal().await;

        let repo = SqliteReconciliacionRepository::new(db);
        assert_eq!(repo.recalcular_gasto("fantasma").await.unwrap(), None);
    }
}
