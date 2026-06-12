//! Adaptador SQLite del repositorio de reservas. Local-First puro (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use crate::recording::TrackedConnection as Connection;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reservas::ReservasRepository;
use tpv_contracts::reservas::{MesaDto, ReservaDto, ReservasMetaDto, ZonaDto};
use tpv_domain::reservas::{ClienteReserva, ReservaValidada};

use crate::mapping::{norm_opt_string, opt_text, v_i64, v_string};
use crate::util::new_id;

pub struct SqliteReservasRepository {
    conn: Arc<Connection>,
}

impl SqliteReservasRepository {
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

async fn select_one_i64(
    conn: &Connection,
    sql: &str,
    args: Vec<Value>,
) -> AppResult<Option<i64>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    Ok(v_i64(row.get_value(0).map_err(db_err)?))
}

/// Busca o crea el cliente asociado a la reserva (por email, luego por teléfono).
async fn upsert_cliente(conn: &Connection, c: &ClienteReserva) -> AppResult<String> {
    let nombre = c.nombre.clone();
    let email = c.email.clone();
    let telefono = c.telefono.clone();
    let notas = c.notas.clone();

    let mut existing_id: Option<String> = None;
    let mut existing_email: Option<String> = None;

    if let Some(ref e) = email {
        let mut rows = conn
            .query(
                "SELECT ID_Cliente, Email FROM Clientes WHERE Email = ?1 ORDER BY ID_Cliente DESC LIMIT 1;",
                vec![Value::Text(e.clone())],
            )
            .await
            .map_err(db_err)?;
        if let Some(row) = rows.next().await.map_err(db_err)? {
            existing_id = Some(s(row.get_value(0).map_err(db_err)?));
            existing_email = norm_opt_string(row.get_value(1).map_err(db_err)?);
        }
    }

    if existing_id.is_none() {
        if let Some(ref t) = telefono {
            let mut rows = conn
                .query(
                    "SELECT ID_Cliente, Email FROM Clientes WHERE Telefono = ?1 ORDER BY ID_Cliente DESC LIMIT 1;",
                    vec![Value::Text(t.clone())],
                )
                .await
                .map_err(db_err)?;
            if let Some(row) = rows.next().await.map_err(db_err)? {
                existing_id = Some(s(row.get_value(0).map_err(db_err)?));
                existing_email = norm_opt_string(row.get_value(1).map_err(db_err)?);
            }
        }
    }

    if let Some(id_cliente) = existing_id {
        let should_set_email = email.is_some()
            && existing_email
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true);

        if should_set_email {
            conn.execute(
                "UPDATE Clientes SET Nombre = ?1, Email = ?2, Telefono = ?3, Notas = ?4 WHERE ID_Cliente = ?5;",
                vec![
                    Value::Text(nombre),
                    opt_text(email),
                    opt_text(telefono),
                    opt_text(notas),
                    Value::Text(id_cliente.clone()),
                ],
            )
            .await
            .map_err(db_err)?;
        } else {
            conn.execute(
                "UPDATE Clientes SET Nombre = ?1, Telefono = ?2, Notas = ?3 WHERE ID_Cliente = ?4;",
                vec![
                    Value::Text(nombre),
                    opt_text(telefono),
                    opt_text(notas),
                    Value::Text(id_cliente.clone()),
                ],
            )
            .await
            .map_err(db_err)?;
        }
        return Ok(id_cliente);
    }

    let id_cliente = new_id();
    conn.execute(
        "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Notas, Created_At) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now','localtime'));",
        vec![
            Value::Text(id_cliente.clone()),
            Value::Text(nombre),
            opt_text(telefono),
            opt_text(email),
            opt_text(notas),
        ],
    )
    .await
    .map_err(db_err)?;

    Ok(id_cliente)
}

#[async_trait]
impl ReservasRepository for SqliteReservasRepository {
    async fn meta(&self) -> AppResult<ReservasMetaDto> {
        let conn = &self.conn;

        // Zonas
        let mut zrows = conn
            .query("SELECT ID_Zona, Nombre_Zona FROM Zonas ORDER BY ID_Zona ASC;", ())
            .await
            .map_err(db_err)?;
        let mut zonas: Vec<ZonaDto> = Vec::new();
        while let Some(row) = zrows.next().await.map_err(db_err)? {
            zonas.push(ZonaDto {
                id_zona: s(row.get_value(0).map_err(db_err)?),
                nombre_zona: s(row.get_value(1).map_err(db_err)?),
            });
        }

        // Mesas (excluyendo mesas de sistema si la columna existe; si no, todas)
        let msql_filtered = "SELECT ID_Mesa, ID_Zona, Numero_Mesa, Capacidad FROM Mesas WHERE COALESCE(Es_Sistema, 0) = 0 ORDER BY ID_Zona ASC, ID_Mesa ASC;";
        let msql_all = "SELECT ID_Mesa, ID_Zona, Numero_Mesa, Capacidad FROM Mesas ORDER BY ID_Zona ASC, ID_Mesa ASC;";

        let mut mrows = match conn.query(msql_filtered, ()).await {
            Ok(rows) => rows,
            Err(_) => conn.query(msql_all, ()).await.map_err(db_err)?,
        };
        let mut mesas: Vec<MesaDto> = Vec::new();
        while let Some(row) = mrows.next().await.map_err(db_err)? {
            mesas.push(MesaDto {
                id_mesa: s(row.get_value(0).map_err(db_err)?),
                id_zona: s(row.get_value(1).map_err(db_err)?),
                numero_mesa: s(row.get_value(2).map_err(db_err)?),
                capacidad: i(row.get_value(3).map_err(db_err)?),
            });
        }

        Ok(ReservasMetaDto { zonas, mesas })
    }

    async fn mes(&self, desde: &str, hasta: &str) -> AppResult<Vec<ReservaDto>> {
        let sql = r#"
          SELECT
            R.ID_Reserva, R.ID_Mesa, R.Dia_YMD, R.Hora, R.Turno, R.Comensales, R.Nota, R.Estado,
            C.Nombre AS Nombre_Cliente, C.Telefono AS Telefono_Cliente, C.Email AS Email_Cliente,
            M.ID_Zona, M.Numero_Mesa, M.Capacidad,
            Z.Nombre_Zona
          FROM Reservas R
          JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
          JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa
          JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona
          WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2
          ORDER BY R.Dia_YMD ASC, R.Hora ASC, R.ID_Reserva ASC;
        "#;

        let mut rows = self
            .conn
            .query(sql, vec![Value::Text(desde.to_string()), Value::Text(hasta.to_string())])
            .await
            .map_err(db_err)?;

        let mut out: Vec<ReservaDto> = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(ReservaDto {
                id_reserva: s(g(0)?),
                id_mesa: s(g(1)?),
                dia_ymd: s(g(2)?),
                hora: s(g(3)?),
                turno: norm_opt_string(g(4)?),
                comensales: i(g(5)?),
                nota: norm_opt_string(g(6)?),
                estado: s(g(7)?),
                nombre_cliente: s(g(8)?),
                telefono_cliente: norm_opt_string(g(9)?),
                email_cliente: norm_opt_string(g(10)?),
                id_zona: s(g(11)?),
                numero_mesa: s(g(12)?),
                capacidad: i(g(13)?),
                nombre_zona: s(g(14)?),
            });
        }
        Ok(out)
    }

    async fn guardar(&self, r: ReservaValidada) -> AppResult<bool> {
        let conn = &self.conn;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;

        let res: AppResult<bool> = async {
            let id_cliente = upsert_cliente(conn, &r.cliente).await?;

            // UUIDv7 explícito: si no viene id (alta), lo generamos. Upsert por id.
            let id_reserva = r.id.clone().unwrap_or_else(new_id);
            let exists = select_one_i64(
                conn,
                "SELECT 1 FROM Reservas WHERE ID_Reserva = ?1 LIMIT 1;",
                vec![Value::Text(id_reserva.clone())],
            )
            .await?
            .is_some();

            if exists {
                conn.execute(
                    r#"UPDATE Reservas SET ID_Cliente = ?1, ID_Mesa = ?2, Dia_YMD = ?3, Hora = ?4, Turno = ?5, Comensales = ?6, Nota = ?7, Estado = ?8 WHERE ID_Reserva = ?9;"#,
                    vec![
                        Value::Text(id_cliente),
                        Value::Text(r.id_mesa.clone()),
                        Value::Text(r.dia_ymd.clone()),
                        Value::Text(r.hora.clone()),
                        Value::Text(r.turno.clone()),
                        Value::Integer(r.comensales),
                        opt_text(r.nota.clone()),
                        Value::Text(r.estado.clone()),
                        Value::Text(id_reserva.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            } else {
                conn.execute(
                    r#"INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Nota, Estado) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);"#,
                    vec![
                        Value::Text(id_reserva.clone()),
                        Value::Text(id_cliente),
                        Value::Text(r.id_mesa.clone()),
                        Value::Text(r.dia_ymd.clone()),
                        Value::Text(r.hora.clone()),
                        Value::Text(r.turno.clone()),
                        Value::Integer(r.comensales),
                        opt_text(r.nota.clone()),
                        Value::Text(r.estado.clone()),
                    ],
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

    async fn eliminar(&self, id_reserva: &str) -> AppResult<bool> {
        let conn = &self.conn;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;

        let res: AppResult<bool> = async {
            conn.execute(
                "UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
                vec![Value::Text(id_reserva.to_string())],
            )
            .await
            .map_err(db_err)?;

            let affected = conn
                .execute(
                    "DELETE FROM Reservas WHERE ID_Reserva = ?1;",
                    vec![Value::Text(id_reserva.to_string())],
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
