//! Adaptador SQLite del repositorio de cuentas (caja). Local-First (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use crate::recording::TrackedConnection as Connection;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::cuentas::CuentasRepository;
use tpv_contracts::cuentas::{EntradaDto, SalidaDto};
use tpv_domain::cuentas::{GastoData, PagoData};

use crate::mapping::{v_f64, v_i64, v_string};
use crate::util::next_table_id;

pub struct SqliteCuentasRepository {
    conn: Arc<Connection>,
}

impl SqliteCuentasRepository {
    pub fn new(conn: Arc<Connection>) -> Self {
        Self { conn }
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

#[async_trait]
impl CuentasRepository for SqliteCuentasRepository {
    async fn entradas(
        &self,
        del: Option<String>,
        al: Option<String>,
    ) -> AppResult<Vec<EntradaDto>> {
        let (where_sql, params) = rango_where(del, al, "p.Fecha_Hora");
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
            {where_sql}
            ORDER BY p.Fecha_Hora DESC, p.ID_Pago DESC;
            "#
        );

        let mut rows = self.conn.query(sql.as_str(), params).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id = v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0);
            let fecha_hora = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
            let cliente = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
            let metodo =
                v_string(row.get_value(3).map_err(db_err)?).unwrap_or_else(|| "Efectivo".into());
            let importe = v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(0.0);
            out.push(EntradaDto {
                id: id.to_string(),
                fecha_hora: fecha_hora.chars().take(16).collect(),
                cliente,
                metodo,
                importe,
            });
        }
        Ok(out)
    }

    async fn salidas(
        &self,
        del: Option<String>,
        al: Option<String>,
    ) -> AppResult<Vec<SalidaDto>> {
        let (where_sql, params) = rango_where(del, al, "Fecha");
        let sql = format!(
            r#"
            SELECT
              ID_Gasto AS id,
              substr(Fecha, 1, 10) AS fechaHora,
              Tipo_Gasto AS tipoGasto,
              Concepto AS concepto,
              Importe AS importe,
              ID_Proveedor AS proveedorId
            FROM Cuentas_Gastos
            {where_sql}
            ORDER BY date(Fecha) DESC, ID_Gasto DESC;
            "#
        );

        let mut rows = self.conn.query(sql.as_str(), params).await.map_err(db_err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id = v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0);
            let fecha = v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default();
            let tipo = v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default();
            let concepto = v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default();
            let importe = v_f64(row.get_value(4).map_err(db_err)?).unwrap_or(0.0);
            let prov = v_i64(row.get_value(5).map_err(db_err)?);
            out.push(SalidaDto {
                id: id.to_string(),
                fecha_hora: fecha.chars().take(10).collect(),
                tipo_gasto: tipo,
                concepto,
                importe,
                proveedor_id: prov,
            });
        }
        Ok(out)
    }

    async fn crear_gasto(&self, id: Option<i64>, g: GastoData) -> AppResult<bool> {
        let id_gasto = match id {
            Some(id) => id,
            None => next_table_id(&self.conn, "Cuentas_Gastos", "ID_Gasto").await?,
        };
        self.conn
            .execute(
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
                    Value::Integer(id_gasto),
                    Value::Text(g.fecha),
                    Value::Text(g.concepto),
                    Value::Real(g.importe),
                    Value::Text(g.tipo_gasto),
                    match g.proveedor_id {
                        Some(id) => Value::Integer(id),
                        None => Value::Null,
                    },
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(true)
    }

    async fn actualizar_gasto(&self, id_gasto: i64, g: GastoData) -> AppResult<bool> {
        let affected = self
            .conn
            .execute(
                r#"
                UPDATE Cuentas_Gastos
                SET Fecha = date(?2), Tipo_Gasto = ?3, Concepto = ?4, Importe = ?5, ID_Proveedor = ?6
                WHERE ID_Gasto = ?1;
                "#,
                vec![
                    Value::Integer(id_gasto),
                    Value::Text(g.fecha),
                    Value::Text(g.tipo_gasto),
                    Value::Text(g.concepto),
                    Value::Real(g.importe),
                    match g.proveedor_id {
                        Some(id) => Value::Integer(id),
                        None => Value::Null,
                    },
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    async fn eliminar_gasto(&self, id_gasto: i64) -> AppResult<bool> {
        let affected = self
            .conn
            .execute(
                "DELETE FROM Cuentas_Gastos WHERE ID_Gasto = ?1;",
                vec![Value::Integer(id_gasto)],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    async fn actualizar_pago(&self, id_pago: i64, p: PagoData) -> AppResult<bool> {
        let affected = self
            .conn
            .execute(
                r#"
                UPDATE Pagos
                SET Fecha_Hora = ?2, Metodo_Pago = ?3, Importe_Total = ?4
                WHERE ID_Pago = ?1;
                "#,
                vec![
                    Value::Integer(id_pago),
                    Value::Text(p.fecha_hora),
                    Value::Text(p.metodo),
                    Value::Real(p.importe),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    async fn eliminar_pago(&self, id_pago: i64) -> AppResult<bool> {
        let conn = &self.conn;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            conn.execute(
                "DELETE FROM Pago_Detalles WHERE ID_Pago = ?1;",
                vec![Value::Integer(id_pago)],
            )
            .await
            .map_err(db_err)?;
            let affected = conn
                .execute(
                    "DELETE FROM Pagos WHERE ID_Pago = ?1;",
                    vec![Value::Integer(id_pago)],
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
}
