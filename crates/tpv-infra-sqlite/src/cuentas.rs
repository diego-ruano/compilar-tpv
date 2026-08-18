//! Adaptador SQLite del repositorio de cuentas (caja). Local-First (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cuentas::{CuentasFiltro, CuentasRepository};
use tpv_contracts::cuentas::{EntradaDto, ResumenCajaDto, SalidaDto};
use tpv_domain::cuentas::{GastoData, PagoData};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, v_f64, v_i64, v_string};
use crate::util::new_id;

pub struct SqliteCuentasRepository {
    db: Arc<Db>,
}

impl SqliteCuentasRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Construye la cláusula WHERE de rango y los parámetros, dada la columna de fecha.
fn rango_where(
    del: Option<String>,
    al: Option<String>,
    fecha_expr: &str,
) -> (String, Vec<Value>) {
    let del = del.filter(|s| !s.trim().is_empty());
    let al = al.filter(|s| !s.trim().is_empty());

    let mut parts: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if del.is_some() {
        parts.push(format!("date({fecha_expr}) >= date(?1)"));
    }
    let al_idx = if del.is_some() { 2 } else { 1 };
    if al.is_some() {
        parts.push(format!("date({fecha_expr}) <= date(?{al_idx})"));
    }

    if let Some(d) = del {
        params.push(Value::Text(d));
    }
    if let Some(a) = al {
        params.push(Value::Text(a));
    }

    let where_sql = if parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", parts.join(" AND "))
    };
    (where_sql, params)
}

/// Construye la cláusula de búsqueda de texto (`WHERE <expr> LIKE …`) sobre las columnas ya
/// calculadas del subquery interno. Añade el parámetro a `params` y numera el placeholder de forma
/// consecutiva a los ya presentes. `expr` debe ser una expresión `lower(...)` con las columnas.
fn q_filter(params: &mut Vec<Value>, q: Option<String>, expr: &str) -> String {
    match q.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(qs) => {
            let idx = params.len() + 1;
            params.push(Value::Text(qs.to_string()));
            format!("WHERE {expr} LIKE '%' || lower(?{idx}) || '%'")
        }
        None => String::new(),
    }
}

/// Cláusula de paginación (`LIMIT ? OFFSET ?`) a partir de page (1-based) y page_size. Si no hay
/// paginación válida (falta page_size o es 0), devuelve cadena vacía → se listan todas las filas.
fn paginacion(params: &mut Vec<Value>, page: Option<u32>, page_size: Option<u32>) -> String {
    match page_size {
        Some(ps) if ps > 0 => {
            let page = page.unwrap_or(1).max(1);
            let offset = (page as i64 - 1) * ps as i64;
            let li = params.len() + 1;
            let oi = params.len() + 2;
            params.push(Value::Integer(ps as i64));
            params.push(Value::Integer(offset));
            format!("LIMIT ?{li} OFFSET ?{oi}")
        }
        _ => String::new(),
    }
}

/// Subquery interno de **entradas** (cobros) con las columnas calculadas (fechaHora, cliente,
/// metodo, importe). Devuelve el SQL y los parámetros del rango de fechas.
fn entradas_inner(del: Option<String>, al: Option<String>) -> (String, Vec<Value>) {
    let (where_rango, params) = rango_where(del, al, "p.Fecha_Hora");
    let sql = format!(
        r#"
        SELECT
          p.ID_Pago AS id,
          substr(p.Fecha_Hora, 1, 16) AS fechaHora,
          (
            CASE
              WHEN m.Numero_Mesa = 'BARRA' THEN 'Take away'
              WHEN m.Numero_Mesa IS NOT NULL AND m.Numero_Mesa <> '' THEN 'Mesa ' || m.Numero_Mesa
              ELSE 'Venta'
            END
            ||
            CASE
              WHEN cl.Nombre IS NOT NULL AND cl.Nombre <> '' THEN ' / ' || cl.Nombre
              ELSE ''
            END
          ) AS cliente,
          CASE WHEN p.Metodo_Pago = 'Tarjeta' THEN 'Tarjeta' ELSE 'Efectivo' END AS metodo,
          IFNULL(p.Importe_Total, 0) AS importe
        FROM Pagos p
        JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
        LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
        LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
        LEFT JOIN Clientes cl ON cl.ID_Cliente = r.ID_Cliente
        {where_rango}
        "#
    );
    (sql, params)
}

/// Expresión de texto buscable de una fila de entradas (para el `LIKE`).
const ENTRADAS_Q_EXPR: &str =
    "lower(fechaHora || ' ' || cliente || ' ' || metodo || ' ' || CAST(importe AS TEXT))";

/// Subquery interno de **salidas** (gastos) con el nombre del proveedor incluido para poder
/// buscarlo. Devuelve el SQL y los parámetros del rango de fechas.
fn salidas_inner(del: Option<String>, al: Option<String>) -> (String, Vec<Value>) {
    let (where_rango, params) = rango_where(del, al, "g.Fecha");
    let sql = format!(
        r#"
        SELECT
          g.ID_Gasto AS id,
          substr(g.Fecha, 1, 10) AS fechaHora,
          g.Tipo_Gasto AS tipoGasto,
          g.Concepto AS concepto,
          g.Importe AS importe,
          g.ID_Proveedor AS proveedorId,
          IFNULL(pr.Nombre_Empresa, '') AS proveedorNombre
        FROM Cuentas_Gastos g
        LEFT JOIN Proveedores pr ON pr.ID_Proveedor = g.ID_Proveedor
        {where_rango}
        "#
    );
    (sql, params)
}

/// Expresión de texto buscable de una fila de salidas (incluye proveedor id y nombre).
const SALIDAS_Q_EXPR: &str = "lower(fechaHora || ' ' || tipoGasto || ' ' || concepto || ' ' || CAST(importe AS TEXT) || ' ' || IFNULL(proveedorId,'') || ' ' || proveedorNombre)";

#[async_trait]
impl CuentasRepository for SqliteCuentasRepository {
    async fn entradas(&self, filtro: CuentasFiltro) -> AppResult<Vec<EntradaDto>> {
        let (inner, mut params) = entradas_inner(filtro.del, filtro.al);
        let q_clause = q_filter(&mut params, filtro.q, ENTRADAS_Q_EXPR);
        let limit_clause = paginacion(&mut params, filtro.page, filtro.page_size);
        let sql = format!(
            "SELECT id, fechaHora, cliente, metodo, importe FROM ({inner}) AS e {q_clause} \
             ORDER BY fechaHora DESC, id DESC {limit_clause};"
        );

        let db = self.db.read().await;
        let mut rows = db.query(sql.as_str(), params).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
            let fecha_hora = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
            let cliente = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
            let metodo =
                v_string(row.get_value(3).map_err(db_err)?).unwrap_or_else(|| "Efectivo".into());
            let importe = v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(0.0);
            out.push(EntradaDto {
                id,
                fecha_hora: fecha_hora.chars().take(16).collect(),
                cliente,
                metodo,
                importe,
            });
        }
        Ok(out)
    }

    async fn salidas(&self, filtro: CuentasFiltro) -> AppResult<Vec<SalidaDto>> {
        let (inner, mut params) = salidas_inner(filtro.del, filtro.al);
        let q_clause = q_filter(&mut params, filtro.q, SALIDAS_Q_EXPR);
        let limit_clause = paginacion(&mut params, filtro.page, filtro.page_size);
        let sql = format!(
            "SELECT id, fechaHora, tipoGasto, concepto, importe, proveedorId FROM ({inner}) AS g \
             {q_clause} ORDER BY fechaHora DESC, id DESC {limit_clause};"
        );

        let db = self.db.read().await;
        let mut rows = db.query(sql.as_str(), params).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
            let fecha = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
            let tipo = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
            let concepto = v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default();
            let importe = v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(0.0);
            let prov = norm_opt_string(row.get_value(5).map_err(db_err)?);
            out.push(SalidaDto {
                id,
                fecha_hora: fecha.chars().take(10).collect(),
                tipo_gasto: tipo,
                concepto,
                importe,
                proveedor_id: prov,
            });
        }
        Ok(out)
    }

    async fn resumen(
        &self,
        del: Option<String>,
        al: Option<String>,
        q: Option<String>,
    ) -> AppResult<ResumenCajaDto> {
        let db = self.db.read().await;

        // ── Entradas: total + total por método + conteo, sobre todo el rango + búsqueda. ──
        let (entradas_inner_sql, mut e_params) = entradas_inner(del.clone(), al.clone());
        let e_q = q_filter(&mut e_params, q.clone(), ENTRADAS_Q_EXPR);
        let e_sql = format!(
            r#"
            SELECT
              IFNULL(SUM(importe), 0),
              IFNULL(SUM(CASE WHEN metodo = 'Efectivo' THEN importe ELSE 0 END), 0),
              IFNULL(SUM(CASE WHEN metodo = 'Tarjeta' THEN importe ELSE 0 END), 0),
              COUNT(*)
            FROM ({entradas_inner_sql}) AS e {e_q};
            "#
        );
        let (total_entradas, total_efectivo, total_tarjeta, count_entradas) = {
            let mut rows = db.query(e_sql.as_str(), e_params).await.map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => (
                    v_f64(row.get_value(0).map_err(db_err)?).unwrap_or(0.0),
                    v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(0.0),
                    v_f64(row.get_value(2).map_err(db_err)?).unwrap_or(0.0),
                    v_i64(row.get_value(3).map_err(db_err)?).unwrap_or(0),
                ),
                None => (0.0, 0.0, 0.0, 0),
            }
        };

        // ── Salidas: total + conteo. ──
        let (salidas_inner_sql, mut s_params) = salidas_inner(del, al);
        let s_q = q_filter(&mut s_params, q, SALIDAS_Q_EXPR);
        let s_sql = format!(
            "SELECT IFNULL(SUM(importe), 0), COUNT(*) FROM ({salidas_inner_sql}) AS g {s_q};"
        );
        let (total_salidas, count_salidas) = {
            let mut rows = db.query(s_sql.as_str(), s_params).await.map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => (
                    v_f64(row.get_value(0).map_err(db_err)?).unwrap_or(0.0),
                    v_i64(row.get_value(1).map_err(db_err)?).unwrap_or(0),
                ),
                None => (0.0, 0),
            }
        };

        Ok(ResumenCajaDto {
            total_entradas,
            total_salidas,
            total_efectivo,
            total_tarjeta,
            count_entradas,
            count_salidas,
        })
    }

    async fn crear_gasto(&self, id: Option<String>, g: GastoData) -> AppResult<bool> {
        let id_gasto = id.unwrap_or_else(new_id);
        let db = self.db.write().await;
        db.execute(
                r#"
                INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto, ID_Proveedor)
                VALUES (?1, date(?2), ?3, ?4, ?5, ?6)
                ON CONFLICT(ID_Gasto) DO UPDATE SET
                  Fecha = excluded.Fecha,
                  Concepto = excluded.Concepto,
                  Importe = excluded.Importe,
                  Tipo_Gasto = excluded.Tipo_Gasto,
                  ID_Proveedor = excluded.ID_Proveedor;
                "#,
                vec![
                    Value::Text(id_gasto),
                    Value::Text(g.fecha),
                    Value::Text(g.concepto),
                    Value::Real(g.importe),
                    Value::Text(g.tipo_gasto),
                    match g.proveedor_id {
                        Some(id) => Value::Text(id),
                        None => Value::Null,
                    },
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(true)
    }

    async fn actualizar_gasto(&self, id_gasto: &str, g: GastoData) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                r#"
                UPDATE Cuentas_Gastos
                SET Fecha = date(?2), Tipo_Gasto = ?3, Concepto = ?4, Importe = ?5, ID_Proveedor = ?6
                WHERE ID_Gasto = ?1;
                "#,
                vec![
                    Value::Text(id_gasto.to_string()),
                    Value::Text(g.fecha),
                    Value::Text(g.tipo_gasto),
                    Value::Text(g.concepto),
                    Value::Real(g.importe),
                    match g.proveedor_id {
                        Some(id) => Value::Text(id),
                        None => Value::Null,
                    },
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    async fn eliminar_gasto(&self, id_gasto: &str) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                "DELETE FROM Cuentas_Gastos WHERE ID_Gasto = ?1;",
                vec![Value::Text(id_gasto.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    /// Actualiza un pago permitiendo cambiar sólo **método y fecha**. El `Importe_Total` **no**
    /// se toma del input: se **recalcula** desde la suma de los `Pago_Detalles` realmente cobrados
    /// (CUENTA-02), manteniendo la conciliación caja↔ventas. Así no se puede descuadrar la caja
    /// fijando un importe arbitrario.
    async fn actualizar_pago(&self, id_pago: &str, p: PagoData) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                r#"
                UPDATE Pagos
                SET Fecha_Hora = ?2,
                    Metodo_Pago = ?3,
                    Importe_Total = (
                        SELECT IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0)
                        FROM Pago_Detalles pd
                        JOIN Detalle_Comanda dc ON dc.ID_Detalle = pd.ID_Detalle
                        WHERE pd.ID_Pago = ?1
                    )
                WHERE ID_Pago = ?1;
                "#,
                vec![
                    Value::Text(id_pago.to_string()),
                    Value::Text(p.fecha_hora),
                    Value::Text(p.metodo),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    /// Borra un pago **revirtiendo por completo y de forma atómica** los efectos del cobro
    /// (CUENTA-01): devuelve el stock consumido (`Lote_Consumos`), resta el gasto del cliente
    /// (`Clientes.Total_Gastado`) y reabre la comanda (`Estado='Abierta'`, recalcula
    /// `Total_Comanda`) si al liberar sus detalles quedan líneas pendientes. Nunca deja una
    /// comanda "Pagada" con saldo pendiente ni gasto/stock sin revertir.
    async fn eliminar_pago(&self, id_pago: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;
        // Las lineas se eliminan antes que Pago_Detalles para poder identificarlas con la
        // relacion del pago. Diferimos las FK hasta COMMIT; al final de la transaccion ya no
        // queda ninguna referencia colgante.
        conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;")
            .await
            .map_err(db_err)?;
        let res: AppResult<bool> = async {
            // 1) Leer comanda + importe del pago ANTES de borrar nada (para la reversión).
            let (id_comanda, importe) = {
                let mut rows = conn
                    .query(
                        "SELECT ID_Comanda, IFNULL(Importe_Total,0) FROM Pagos WHERE ID_Pago = ?1 LIMIT 1;",
                        vec![Value::Text(id_pago.to_string())],
                    )
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(row) => {
                        let c = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
                        let imp = v_f64(row.get_value(1).map_err(db_err)?).unwrap_or(0.0);
                        (c, imp)
                    }
                    // El pago no existe: nada que revertir.
                    None => return Ok(false),
                }
            };

            // 2) Devolver el stock: sumar de vuelta a cada lote lo consumido por los detalles del
            //    pago y borrar esos Lote_Consumos (la consumición se hace en el cobro, ligada a
            //    ID_Detalle; si el pago no consumió stock —p. ej. cobro de mesa— es un no-op).
            conn.execute(
                r#"
                UPDATE Lotes_Producto
                SET Stock_Disponible = COALESCE(Stock_Disponible,0) + (
                    SELECT IFNULL(SUM(lc.Cantidad),0)
                    FROM Lote_Consumos lc
                    JOIN Pago_Detalles pd ON pd.ID_Detalle = lc.ID_Detalle
                    WHERE pd.ID_Pago = ?1 AND lc.ID_Lote = Lotes_Producto.ID_Lote
                )
                WHERE ID_Lote IN (
                    SELECT lc.ID_Lote
                    FROM Lote_Consumos lc
                    JOIN Pago_Detalles pd ON pd.ID_Detalle = lc.ID_Detalle
                    WHERE pd.ID_Pago = ?1
                );
                "#,
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;

            conn.execute(
                r#"
                DELETE FROM Lote_Consumos
                WHERE ID_Detalle IN (SELECT ID_Detalle FROM Pago_Detalles WHERE ID_Pago = ?1);
                "#,
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;

            // 2-bis) Y devolver el stock SUELTO que consumió el pago (lo que los lotes no
            //    cubrieron, VR-04). Mismo trato que los lotes: se suma de vuelta y se borra la
            //    traza. Sin esto, la parte suelta de una venta rápida anulada desaparecía del
            //    inventario sin que nadie la hubiera vendido.
            conn.execute(
                r#"
                UPDATE Productos
                SET Stock_Suelto = COALESCE(Stock_Suelto,0) + (
                    SELECT IFNULL(SUM(sc.Cantidad),0)
                    FROM Suelto_Consumos sc
                    JOIN Pago_Detalles pd ON pd.ID_Detalle = sc.ID_Detalle
                    WHERE pd.ID_Pago = ?1 AND sc.ID_Producto = Productos.ID_Producto
                )
                WHERE ID_Producto IN (
                    SELECT sc.ID_Producto
                    FROM Suelto_Consumos sc
                    JOIN Pago_Detalles pd ON pd.ID_Detalle = sc.ID_Detalle
                    WHERE pd.ID_Pago = ?1
                );
                "#,
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;

            conn.execute(
                r#"
                DELETE FROM Suelto_Consumos
                WHERE ID_Detalle IN (SELECT ID_Detalle FROM Pago_Detalles WHERE ID_Pago = ?1);
                "#,
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;

            // 3) Restar el gasto del cliente ligado a la comanda (vía Reservas), sin bajar de 0.
            let importe = (importe * 100.0).round() / 100.0;
            if importe > 0.0 && !id_comanda.is_empty() {
                conn.execute(
                    r#"
                    UPDATE Clientes
                    SET Total_Gastado = MAX(0, COALESCE(Total_Gastado,0) - ?2)
                    WHERE ID_Cliente = (
                        SELECT r.ID_Cliente
                        FROM Comandas c
                        JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
                        WHERE c.ID_Comanda = ?1
                    );
                    "#,
                    vec![Value::Text(id_comanda.clone()), Value::Real(importe)],
                )
                .await
                .map_err(db_err)?;
            }

            // 4) Eliminar las lineas cobradas por este pago. El stock ya se ha restaurado arriba,
            //    por lo que conservarlas o moverlas a otra comanda crearia un ticket fantasma y
            //    permitiria cobrarlas de nuevo.
            conn.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle IN (
                    SELECT ID_Detalle FROM Pago_Detalles WHERE ID_Pago = ?1
                );
                "#,
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;

            // 5) Borrar las relaciones y el pago.
            conn.execute(
                "DELETE FROM Pago_Detalles WHERE ID_Pago = ?1;",
                vec![Value::Text(id_pago.to_string())],
            )
            .await
            .map_err(db_err)?;
            let affected = conn
                .execute(
                    "DELETE FROM Pagos WHERE ID_Pago = ?1;",
                    vec![Value::Text(id_pago.to_string())],
                )
                .await
                .map_err(db_err)?;

            // 6) Recalcular la comanda original. Solo se reabre si ya contenia otras lineas
            //    pendientes y no existe otra comanda abierta para la mesa. Las lineas anuladas
            //    nunca se trasladan a otro ticket.
            if !id_comanda.is_empty() {
                conn.execute(
                    r#"
                    UPDATE Comandas
                    SET Estado = CASE
                          WHEN ID_Comanda = ?1
                           AND EXISTS (
                            SELECT 1 FROM Detalle_Comanda dc
                            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                            WHERE dc.ID_Comanda = Comandas.ID_Comanda
                              AND pd.ID_Detalle IS NULL
                          )
                           AND NOT EXISTS (
                            SELECT 1 FROM Comandas abierta
                            WHERE abierta.ID_Mesa = Comandas.ID_Mesa
                              AND abierta.Estado = 'Abierta'
                              AND abierta.ID_Comanda <> Comandas.ID_Comanda
                          )
                          THEN 'Abierta' ELSE Estado END,
                        Fecha_Hora_Cierre = CASE
                          WHEN ID_Comanda = ?1
                           AND EXISTS (
                            SELECT 1 FROM Detalle_Comanda dc
                            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                            WHERE dc.ID_Comanda = Comandas.ID_Comanda
                              AND pd.ID_Detalle IS NULL
                          )
                           AND NOT EXISTS (
                            SELECT 1 FROM Comandas abierta
                            WHERE abierta.ID_Mesa = Comandas.ID_Mesa
                              AND abierta.Estado = 'Abierta'
                              AND abierta.ID_Comanda <> Comandas.ID_Comanda
                          )
                          THEN NULL ELSE Fecha_Hora_Cierre END,
                        Total_Comanda = (
                            SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
                            FROM Detalle_Comanda
                            WHERE ID_Comanda = Comandas.ID_Comanda
                        )
                    WHERE ID_Comanda = ?1;
                    "#,
                    vec![Value::Text(id_comanda.clone())],
                )
                .await
                .map_err(db_err)?;
            }

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
}

#[cfg(test)]
mod tests_devolucion_de_stock {
    use super::*;
    use crate::db::Db;
    use libsql::Connection;
    use tpv_application::ports::cuentas::CuentasRepository;

    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        format!(
            "{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("tpv_cuentas_test_{}", uniq()));
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

    async fn escalar(db: &Arc<Db>, sql: &str) -> f64 {
        let r = db.read().await;
        let mut rows = r.query(sql, Vec::<Value>::new()).await.unwrap();
        let row = rows.next().await.unwrap().expect("sin filas");
        crate::mapping::v_f64(row.get_value(0).unwrap()).unwrap_or(0.0)
    }

    /// Una venta de barra de 5 unidades de un producto con stock SUELTO (sin lotes): quedan 5 de
    /// los 10 que había, y el consumo queda anotado. Es el estado desde el que se anula.
    const VENTA_DE_SUELTO: &[&str] = &[
        "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
        "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, Stock_Suelto)
           VALUES ('prod', 'cat', 'Cafe', 1.2, 5);",
        "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
           VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
        "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
           VALUES ('det', 'com', 'prod', 5, 1.2);",
        "INSERT INTO Suelto_Consumos (ID_Detalle, ID_Producto, Cantidad) VALUES ('det', 'prod', 5);",
        "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
           VALUES ('pago', 'com', '2026-01-02 12:30:00', 'EFECTIVO', 6.0, 'TOTAL');",
        "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'det');",
    ];

    /// El agujero que esto cierra: al anular, el stock que salió del contador suelto volvía a
    /// nadie. Como no había traza de ese consumo, la cantidad se perdía para siempre y encima el
    /// síntoma se confundía con una sobreventa (el contador admite negativos a propósito).
    #[tokio::test]
    async fn anular_un_pago_devuelve_el_stock_suelto() {
        let (db, _dir) = db_temporal().await;
        sembrar(&db, VENTA_DE_SUELTO).await;

        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            5.0,
            "punto de partida: se vendieron 5 de 10"
        );

        let repo = SqliteCuentasRepository::new(db.clone());
        let borrado = repo.eliminar_pago("pago").await.unwrap();

        assert!(borrado, "el pago existía");
        assert_eq!(
            escalar(&db, "SELECT Stock_Suelto FROM Productos WHERE ID_Producto='prod';").await,
            10.0,
            "las 5 unidades vuelven al contador"
        );
        assert_eq!(
            escalar(&db, "SELECT COUNT(*) FROM Suelto_Consumos;").await,
            0.0,
            "y su traza se retira, para que una segunda anulación no las sume otra vez"
        );
    }

    /// Un producto que NO usa stock suelto (Stock_Suelto NULL) no debe recibir nada al anular:
    /// no se le descontó nada al vender.
    #[tokio::test]
    async fn un_producto_sin_stock_suelto_no_recibe_nada() {
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &[
                "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat', 'Bebidas');",
                "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta)
                   VALUES ('prod', 'cat', 'Cafe', 1.2);",
                "INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Estado)
                   VALUES ('com', 'BARRA', '2026-01-02 12:00:00', 'Pagada');",
                "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario)
                   VALUES ('det', 'com', 'prod', 5, 1.2);",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo)
                   VALUES ('pago', 'com', '2026-01-02 12:30:00', 'EFECTIVO', 6.0, 'TOTAL');",
                "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES ('pago', 'det');",
            ],
        )
        .await;

        let repo = SqliteCuentasRepository::new(db.clone());
        repo.eliminar_pago("pago").await.unwrap();

        assert_eq!(
            escalar(
                &db,
                "SELECT COUNT(*) FROM Productos WHERE ID_Producto='prod' AND Stock_Suelto IS NULL;"
            )
            .await,
            1.0,
            "sigue sin usar stock suelto"
        );
    }
}
