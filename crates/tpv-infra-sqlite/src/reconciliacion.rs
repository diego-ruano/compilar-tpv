//! Adaptador SQLite de la **reconciliación** (`ReconciliacionRepository`, INV-06 / DB-14).
//!
//! Dos consultas que recalculan desde el origen lo que otras columnas guardan ya sumado. Solo
//! leen: la decisión de qué hacer con un descuadre es de quien lleva el negocio, no del job.

use tpv_domain::dinero::Dinero;
use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reconciliacion::{
    ClienteDescuadrado, LoteDescuadrado, ReconciliacionRepository,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{v_f64, v_string, v_dinero, dinero_val};

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
/// comanda cobrada resta lo suyo.
///
/// ⚠️ **Un consumo deja de contar cuando su stock volvió al lote: cuando SU cobro se dio de baja**,
/// por error o por devolución (las dos reponen). Antes esto no hacía falta porque anular borraba la fila de `Lote_Consumos` y la resta
/// desaparecía sola. Desde CUENTA-07 el pago se conserva y la traza también —es lo que da
/// trazabilidad por lote al ticket anulado—, así que sin este filtro el stock habría vuelto al
/// lote pero la resta seguiría contando: «faltan N unidades», cada día, para siempre.
///
/// Se mira el cobro **del consumo** y no los de su línea (STOCK-01): una línea anulada y vuelta a
/// cobrar tiene un consumo por cobro, y mirando la línea el del cobro anulado seguía restando.
///
/// Y de un cobro activo resta lo que no se ha devuelto: lo que repusieron sus devoluciones
/// parciales (`cuentas::sql_ya_repuesto`) volvió al lote.
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
                SELECT SUM(c.Cantidad - {ya_lote})
                FROM Lote_Consumos c
                JOIN Pagos p ON p.ID_Pago = c.ID_Pago
                WHERE c.ID_Lote = l.ID_Lote
                  AND p.Estado <> 'ANULADO'
            ), 0)                         AS calculado
        FROM Lotes_Producto l
        LEFT JOIN Productos p ON p.ID_Producto = l.ID_Producto

        UNION ALL

        -- RI-55: el stock SUELTO, con la misma cuenta. Sus movimientos son los de ID_Producto y sus
        -- consumos los de Suelto_Consumos, con el mismo filtro de anulaciones. Sale como una fila más,
        -- con «stock suelto» en lugar del código de lote.
        SELECT
            pr.ID_Producto                AS id_lote,
            'stock suelto'                AS codigo_lote,
            COALESCE(pr.Nombre, '')       AS producto,
            pr.Stock_Suelto               AS guardado,
            COALESCE((
                SELECT SUM(m.Delta) FROM Movimientos_Stock m WHERE m.ID_Producto = pr.ID_Producto
            ), 0)
            - COALESCE((
                SELECT SUM(c.Cantidad - {ya_suelto})
                FROM Suelto_Consumos c
                JOIN Pagos pg ON pg.ID_Pago = c.ID_Pago
                WHERE c.ID_Producto = pr.ID_Producto
                  AND pg.Estado <> 'ANULADO'
            ), 0)                         AS calculado
        FROM Productos pr
        WHERE pr.Stock_Suelto IS NOT NULL
    )
    WHERE ABS(guardado - calculado) > ?1
    ORDER BY ABS(guardado - calculado) DESC
    LIMIT ?2;
"#;

/// El gasto que DEBERÍA tener cada cliente: la suma de los pagos **activos** de sus comandas, que es
/// exactamente el camino por el que se acredita al cobrar (`sumar_gasto_cliente_por_comanda`): el
/// cliente de la comanda, fijado al cobrar, y si no lo tiene el de su reserva (RI-61; antes sólo la
/// reserva, y borrarla dejaba al cliente descuadrado para siempre). Sin `ROUND`: una suma de
/// céntimos ya es entera (RI-66).
///
/// El filtro por estado es obligatorio: al anular se decrementa `Total_Gastado`, así que una suma
/// que siguiera incluyendo el pago anulado sacaría al cliente como descuadrado para siempre.
const SQL_CLIENTES: &str = r#"
    SELECT id_cliente, nombre, guardado, calculado
    FROM (
        SELECT
            c.ID_Cliente               AS id_cliente,
            COALESCE(c.Nombre, '')     AS nombre,
            COALESCE(c.Total_Gastado, 0) AS guardado,
            COALESCE((
                SELECT SUM(pg.Importe_Total)
                FROM Pagos pg
                JOIN Comandas co     ON co.ID_Comanda = pg.ID_Comanda
                LEFT JOIN Reservas r ON r.ID_Reserva  = co.ID_Reserva
                WHERE COALESCE(co.ID_Cliente, r.ID_Cliente) = c.ID_Cliente
                  AND COALESCE(pg.Estado,'ACTIVO') = 'ACTIVO'
            ), 0)                      AS calculado
        FROM Clientes c
    )
    WHERE ABS(guardado - calculado) > ?1
    ORDER BY ABS(guardado - calculado) DESC
    LIMIT ?2;
"#;

/// El gasto de UN cliente, por el mismo camino que `SQL_CLIENTES`: los pagos ACTIVOS de sus
/// comandas (el cliente de la comanda o, si no lo tiene, el de su reserva).
///
/// ⚠️ Ésta es la única de las tres que **escribe** (`recalcular_gasto` hace `UPDATE Clientes` por
/// `execute`, así que además sale por el outbox a la nube). Sin el filtro por estado, un usuario
/// que viera el aviso de descuadre y pulsara «recalcular» grabaría un total que incluye el pago
/// anulado: el aviso falso induciría a la acción que corrompe el dato, en local y en la nube.
const SQL_GASTO_DE_UNO: &str = r#"
    SELECT COALESCE((
        SELECT SUM(pg.Importe_Total)
        FROM Pagos pg
        JOIN Comandas co     ON co.ID_Comanda = pg.ID_Comanda
        LEFT JOIN Reservas r ON r.ID_Reserva  = co.ID_Reserva
        WHERE COALESCE(co.ID_Cliente, r.ID_Cliente) = c.ID_Cliente
          AND COALESCE(pg.Estado,'ACTIVO') = 'ACTIVO'
    ), 0)
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
                &SQL_LOTES
                    .replace("{ya_lote}", &crate::cuentas::sql_ya_repuesto("c"))
                    .replace("{ya_suelto}", &crate::cuentas::sql_ya_repuesto("c")),
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

    async fn clientes_descuadrados(&self, tolerancia: Dinero) -> AppResult<Vec<ClienteDescuadrado>> {
        let r = self.db.read().await;
        let mut rows = r
            .query(
                SQL_CLIENTES,
                vec![dinero_val(tolerancia), Value::Integer(MAX_FILAS)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(ClienteDescuadrado {
                id_cliente: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                guardado: v_dinero(row.get_value(2).map_err(db_err)?).unwrap_or(Dinero::CERO),
                calculado: v_dinero(row.get_value(3).map_err(db_err)?).unwrap_or(Dinero::CERO),
            });
        }
        Ok(out)
    }

    async fn recalcular_gasto(&self, id_cliente: &str) -> AppResult<Option<Dinero>> {
        // Cálculo y escritura bajo el MISMO guard: entre leer los pagos y escribir el total no
        // puede colarse un cobro que dejaría el valor obsoleto nada más nacer.
        let w = self.db.write().await;

        let calculado = {
            let mut rows = w
                .query(SQL_GASTO_DE_UNO, vec![Value::Text(id_cliente.to_string())])
                .await
                .map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => v_dinero(row.get_value(0).map_err(db_err)?).unwrap_or(Dinero::CERO),
                // Sin fila no hay cliente: no se inventa una.
                None => return Ok(None),
            }
        };

        // Por `execute` (no por `raw`): es un dato de negocio y se replica a la nube como
        // cualquier otra escritura de la Main.
        w.execute(
            "UPDATE Clientes SET Total_Gastado = ?2 WHERE ID_Cliente = ?1;",
            vec![Value::Text(id_cliente.to_string()), dinero_val(calculado)],
        )
        .await
        .map_err(db_err)?;

        Ok(Some(calculado))
    }
}

#[cfg(test)]
mod tests {
    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que
    /// se compara son centimos.
    #[allow(dead_code)]
    fn e(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    use super::*;
    use crate::ejecutor::Connection;

    /// Euros -> `Dinero`. Los supuestos se escriben en euros; lo que
    /// se compara son centimos.
    #[allow(dead_code)]
    fn eur(euros: f64) -> Dinero {
        Dinero::de_euros(euros)
    }

    // Unicidad entre tests en paralelo (mismo patrón que migrations.rs: contador + PID, no reloj).
    /// BD real en un temporal, con el esquema que producen las migraciones.
    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("reconciliacion");
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
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod', 'cat', 'Cerveza', 250);",
        "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Stock_Disponible)
           VALUES ('lote', 'prod', 'L-1', '2026-01-01 10:00:00', 10);",
        "INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Fecha)
           VALUES ('mov', 'lote', 'ALTA', 10, 10, '2026-01-01 10:00:00');",
    ];

    /// Un ticket de barra con una línea, para poder colgar de él consumos y pagos.
    const SEMILLA_TICKET: &[&str] = &[
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado) VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('det', 'com', 'prod', 3, 250);",
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
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago', 'com', '2026-01-02 12:30:00', 'Efectivo', 750, 'TOTAL');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'det');",
                "INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad) VALUES ('det', 'lote', 'pago', 3);",
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
                   VALUES ('pago', 'com', '2026-01-02 14:00:00', 'EFECTIVO', 2550, 'TOTAL');",
            ],
        )
        .await;

        let repo = SqliteReconciliacionRepository::new(db.clone());
        let descuadrados = repo.clientes_descuadrados(eur(0.005)).await.unwrap();

        assert_eq!(descuadrados.len(), 1);
        assert_eq!(descuadrados[0].nombre, "Ana");
        assert_eq!(descuadrados[0].guardado, Dinero::CERO);
        assert_eq!(descuadrados[0].calculado, eur(25.50));

        // Y NO lo arregla: la ficha sigue como estaba hasta que el dueño decida.
        assert_eq!(
            escalar(&db, "SELECT Total_Gastado FROM Clientes WHERE ID_Cliente='cli';").await,
            0.0,
            "el job informa, no escribe"
        );

        // La corrección es la acción manual, y esa sí escribe.
        let nuevo = repo.recalcular_gasto("cli").await.unwrap();

        assert_eq!(nuevo, Some(eur(25.50)));
        assert_eq!(
            escalar(&db, "SELECT Total_Gastado FROM Clientes WHERE ID_Cliente='cli';").await,
            2550.0
        );
        assert!(
            repo.clientes_descuadrados(eur(0.005)).await.unwrap().is_empty(),
            "y con eso deja de estar descuadrado"
        );
    }

    /// RI-61: el cliente se queda en la comanda al cobrar. Borrar la reserva después ya no le quita
    /// el gasto en el cálculo: antes la cadena era sólo comanda → reserva → cliente, y el cliente
    /// quedaba descuadrado para siempre (y «recalcular» le bajaba el gasto).
    #[tokio::test]
    async fn borrar_la_reserva_despues_de_cobrar_no_descuadra_al_cliente() {
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &[
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona', 'Salon');",
                "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                   VALUES ('mesa', 'zona', '1', 4, 0, 0, 'rect', 10, 10);",
                "INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('cli', 'Ana', 2550);",
                // Lo que queda tras cobrar y borrar la reserva: la comanda con su cliente y sin
                // reserva (`eliminar` deja `ID_Reserva` a NULL).
                "INSERT INTO Comandas (ID_Comanda, ID_Mesa, ID_Cliente, Canal, Fecha_Hora_Apertura, Estado)
                   VALUES ('com', 'mesa', 'cli', 'MESA', '2026-01-02 13:00:00', 'Pagada');",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago', 'com', '2026-01-02 14:00:00', 'EFECTIVO', 2550, 'TOTAL');",
            ],
        )
        .await;

        let repo = SqliteReconciliacionRepository::new(db);
        assert!(repo.clientes_descuadrados(eur(0.005)).await.unwrap().is_empty());
        assert_eq!(repo.recalcular_gasto("cli").await.unwrap(), Some(eur(25.50)));
    }

    #[tokio::test]
    async fn recalcular_un_cliente_que_no_existe_no_inventa_nada() {
        let (db, _dir) = db_temporal().await;

        let repo = SqliteReconciliacionRepository::new(db);
        assert_eq!(repo.recalcular_gasto("fantasma").await.unwrap(), None);
    }

    /* ── Anulaciones (CUENTA-07) ───────────────────────────────────────────────────────── */

    /// Estado tras anular un cobro: el stock ha vuelto al lote, el gasto del cliente se ha
    /// decrementado, y **la traza del consumo y el pago siguen ahí** (ya no se borran). Es
    /// exactamente el estado en el que la reconciliación empezaría a mentir si no filtrara.
    const VENTA_ANULADA: &[&str] = &[
        "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona', 'Salon');",
        "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
           VALUES ('mesa', 'zona', '1', 4, 0, 0, 'rect', 10, 10);",
        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)
           VALUES ('u1', '00000000-0000-7000-8000-000000000001', 'jefe@bar.example', 'x', 'Marta');",
        "INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('cli', 'Ana', 0);",
        "INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales)
           VALUES ('res', 'cli', 'mesa', '2026-01-02', '13:00', 'COMIDA', 2);",
        "INSERT INTO Comandas (ID_Comanda, ID_Mesa, ID_Reserva, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'mesa', 'res', 'MESA', '2026-01-02 13:00:00', 'Abierta');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det', 'com', 'prod', 3, 250);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Estado, Anulado_En, Anulado_Por, Motivo_Anulacion)
           VALUES ('pago', 'com', '2026-01-02 14:00:00', 'Efectivo', 750, 'TOTAL', 'ANULADO', '2026-01-02 15:00:00', 'u1', 'error de cobro');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'det');",
        // El stock volvió al lote al anular, pero la traza del consumo se conserva.
        "INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad) VALUES ('det', 'lote', 'pago', 3);",
    ];

    #[tokio::test]
    async fn tras_anular_el_lote_no_sale_como_descuadrado() {
        // Sin el filtro: el stock ya volvió (10) pero la resta del consumo seguiría contando (7),
        // así que el lote saldría descuadrado en cada pasada del job. Cada día. Para siempre.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        sembrar(&db, VENTA_ANULADA).await;

        let repo = SqliteReconciliacionRepository::new(db);
        let out = repo.lotes_descuadrados(0.001).await.unwrap();

        assert!(out.is_empty(), "un consumo de un cobro anulado no resta: {out:?}");
    }

    /// STOCK-01. La línea se cobró (3 del lote), se anuló por error (vuelven: 10) y se cobró otra vez
    /// de un lote nuevo. El consumo del primer cobro ya no resta; el del segundo, sí.
    #[tokio::test]
    async fn una_linea_vuelta_a_cobrar_de_otro_lote_cuadra_en_los_dos() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        sembrar(&db, VENTA_ANULADA).await;
        sembrar(
            &db,
            &[
                "INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Stock_Disponible)
                   VALUES ('lote-2', 'prod', 'L-2', '2026-01-02 16:00:00', 7);",
                "INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Fecha)
                   VALUES ('mov-2', 'lote-2', 'ALTA', 10, 10, '2026-01-02 16:00:00');",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago-2', 'com', '2026-01-02 17:00:00', 'Efectivo', 750, 'TOTAL');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago-2', 'det');",
                "INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad)
                   VALUES ('det', 'lote-2', 'pago-2', 3);",
            ],
        )
        .await;

        let repo = SqliteReconciliacionRepository::new(db);
        let out = repo.lotes_descuadrados(0.001).await.unwrap();

        assert!(out.is_empty(), "cada consumo cuenta según su propio cobro: {out:?}");
    }

    /// Una devolución repone el stock igual que una anulación por error, así que su consumo deja
    /// de restar: si siguiera, el lote saldría con «faltan 3» para siempre.
    #[tokio::test]
    async fn el_consumo_de_una_devolucion_deja_de_contar() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        sembrar(&db, VENTA_ANULADA).await;
        sembrar(&db, &["UPDATE Pagos SET Motivo_Baja = 'DEVOLUCION' WHERE ID_Pago = 'pago';"]).await;

        let repo = SqliteReconciliacionRepository::new(db);
        let out = repo.lotes_descuadrados(0.001).await.unwrap();

        assert!(out.is_empty(), "10 de alta, y lo devuelto volvió: 10: {out:?}");
    }

    #[tokio::test]
    async fn tras_anular_el_cliente_no_sale_como_descuadrado() {
        // Al anular se decrementa `Total_Gastado`; si la suma siguiera incluyendo el pago anulado,
        // el cliente aparecería descuadrado para siempre.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        sembrar(&db, VENTA_ANULADA).await;

        let repo = SqliteReconciliacionRepository::new(db);
        let out = repo.clientes_descuadrados(eur(0.005)).await.unwrap();

        assert!(out.is_empty(), "el pago anulado no cuenta como gasto: {out:?}");
    }

    #[tokio::test]
    async fn recalcular_el_gasto_escribe_el_total_sin_el_pago_anulado() {
        // ⚠️ El test que impide corromper el dato Y replicarlo. `recalcular_gasto` es la única de
        // las tres consultas que ESCRIBE, y por `execute`, así que sale por el outbox a la nube.
        // Sin el filtro, un usuario que viera el aviso de descuadre y pulsara «recalcular»
        // grabaría un total que incluye el cobro anulado: el aviso falso induce a la acción que
        // rompe el dato, en local y arriba.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        sembrar(&db, VENTA_ANULADA).await;
        // Y un cobro que SÍ vale, para que el test distinga "filtra bien" de "devuelve 0".
        sembrar(
            &db,
            &["INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                 VALUES ('pago-ok', 'com', '2026-01-03 14:00:00', 'Efectivo', 1200, 'TOTAL');"],
        )
        .await;

        let repo = SqliteReconciliacionRepository::new(db.clone());
        assert_eq!(repo.recalcular_gasto("cli").await.unwrap(), Some(eur(12.0)));
        assert_eq!(
            escalar(&db, "SELECT Total_Gastado FROM Clientes WHERE ID_Cliente='cli';").await,
            1200.0,
            "los 7,50 del cobro anulado no pueden acabar en la ficha del cliente"
        );
    }

    #[tokio::test]
    async fn una_linea_anulada_y_vuelta_a_cobrar_si_resta_del_lote() {
        // El otro extremo del filtro: el segundo cobro vuelve a descontar del mismo lote y deja SU
        // propio consumo (STOCK-01). El del cobro anulado no resta; el del nuevo, sí. Si contara
        // ninguno, el lote saldría descuadrado al revés: «sobran 3».
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        sembrar(&db, VENTA_ANULADA).await;
        sembrar(
            &db,
            &[
                "UPDATE Lotes_Producto SET Stock_Disponible = 7 WHERE ID_Lote = 'lote';",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago2', 'com', '2026-01-02 16:00:00', 'Efectivo', 750, 'TOTAL');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago2', 'det');",
                "INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, ID_Pago, Cantidad) VALUES ('det', 'lote', 'pago2', 3);",
            ],
        )
        .await;

        let repo = SqliteReconciliacionRepository::new(db);
        let out = repo.lotes_descuadrados(0.001).await.unwrap();

        assert!(out.is_empty(), "10 de alta - 3 consumidos = 7: {out:?}");
    }

    // ── RI-55: el stock suelto también se cuadra ──

    /// Un producto sin lotes con 5 de stock suelto y su movimiento de alta.
    const SEMILLA_SUELTO: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Stock_Suelto)
           VALUES ('prod', 'cat', 'Cerveza', 250, 5);",
        "INSERT INTO Movimientos_Stock (ID_Movimiento, ID_Producto, Tipo, Delta, Stock_Resultante, Fecha)
           VALUES ('mov', 'prod', 'ALTA', 5, 5, '2026-01-01 10:00:00');",
    ];

    #[tokio::test]
    async fn el_stock_suelto_con_su_alta_y_sus_ventas_cuadra() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_SUELTO).await;
        sembrar(&db, SEMILLA_TICKET).await;
        sembrar(
            &db,
            &[
                "UPDATE Productos SET Stock_Suelto = 2 WHERE ID_Producto = 'prod';",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago', 'com', '2026-01-02 12:30:00', 'Efectivo', 750, 'TOTAL');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'det');",
                "INSERT INTO Suelto_Consumos (ID_Detalle, ID_Producto, ID_Pago, Cantidad) VALUES ('det', 'prod', 'pago', 3);",
            ],
        )
        .await;

        let out = SqliteReconciliacionRepository::new(db).lotes_descuadrados(0.001).await.unwrap();
        assert!(out.is_empty(), "5 de alta - 3 vendidos = 2: {out:?}");
    }

    #[tokio::test]
    async fn un_stock_suelto_cambiado_sin_rastro_se_detecta() {
        // Lo que hacía guardar la ficha del producto antes de RI-55.
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_SUELTO).await;
        sembrar(&db, &["UPDATE Productos SET Stock_Suelto = 9 WHERE ID_Producto = 'prod';"]).await;

        let out = SqliteReconciliacionRepository::new(db).lotes_descuadrados(0.001).await.unwrap();
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].codigo_lote, "stock suelto");
        assert_eq!(out[0].producto, "Cerveza");
        assert_eq!((out[0].guardado, out[0].calculado), (9.0, 5.0));
    }

    #[tokio::test]
    async fn un_producto_sin_stock_suelto_no_se_cuadra() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, SEMILLA_LOTE).await;
        let out = SqliteReconciliacionRepository::new(db).lotes_descuadrados(0.001).await.unwrap();
        assert!(out.is_empty(), "{out:?}");
    }
}
