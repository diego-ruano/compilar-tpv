//! Adaptador SQLite del repositorio de clientes (implementa `ClientesRepository`).
//!
//! Local-First puro: las escrituras son INSERT/UPDATE directos contra la BD local.
//! NO hay outbox ni Applied_Operations (eso era de la antigua sincronización dual).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::clientes::ClientesRepository;
use tpv_contracts::clientes::{ClienteForm, ClienteOverview};
use tpv_domain::clientes::{Cliente, ClienteRanking, NuevoCliente};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_text, v_f64, v_i64, v_string};
use crate::util::new_id;

pub struct SqliteClientesRepository {
    db: Arc<Db>,
}

impl SqliteClientesRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn sql_overview_base() -> &'static str {
    r#"
    SELECT
      c.ID_Cliente,
      c.Nombre,
      c.Email,
      c.Telefono,

      (
        SELECT r.Dia_YMD
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
        ORDER BY r.Dia_YMD DESC, r.Hora DESC
        LIMIT 1
      ) AS Ultima_Reserva_Fecha,

      (
        SELECT r.Hora
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
        ORDER BY r.Dia_YMD DESC, r.Hora DESC
        LIMIT 1
      ) AS Ultima_Reserva_Hora,

      (
        SELECT r.Comensales
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
        ORDER BY r.Dia_YMD DESC, r.Hora DESC
        LIMIT 1
      ) AS Ultima_Reserva_NumPersonas,

      (
        SELECT m.Numero_Mesa
        FROM Reservas r
        JOIN Mesas m ON m.ID_Mesa = r.ID_Mesa
        WHERE r.ID_Cliente = c.ID_Cliente
        ORDER BY r.Dia_YMD DESC, r.Hora DESC
        LIMIT 1
      ) AS Ultima_Reserva_Mesa,

      (
        SELECT IFNULL(SUM(f.Total_Pagado), 0)
        FROM Facturas f
        WHERE f.ID_Cliente = c.ID_Cliente
      ) AS Total_Gastado_Calculado,

      IFNULL(c.Total_Gastado, 0) AS Total_Gastado_Stored,

      (
        SELECT COUNT(*)
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
      ) AS Total_Reservas,

      (
        SELECT COUNT(*)
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
          AND UPPER(COALESCE(r.Estado,'')) = 'ACTIVA'
          AND date(r.Dia_YMD) >= date('now','localtime')
      ) AS Reservas_Pendientes

    FROM Clientes c
    "#
}

#[async_trait]
impl ClientesRepository for SqliteClientesRepository {
    async fn overview(&self, ranking: ClienteRanking) -> AppResult<Vec<ClienteOverview>> {
        let base = sql_overview_base();

        let sql = match ranking {
            ClienteRanking::PorReservas => format!(
                "{base}\nORDER BY Total_Reservas DESC, (Total_Gastado_Calculado + Total_Gastado_Stored) DESC, c.ID_Cliente DESC\nLIMIT 10;"
            ),
            ClienteRanking::PorGasto => format!(
                "{base}\nORDER BY (Total_Gastado_Calculado + Total_Gastado_Stored) DESC, Total_Reservas DESC, c.ID_Cliente DESC\nLIMIT 10;"
            ),
            ClienteRanking::Reciente => format!("{base}\nORDER BY c.ID_Cliente DESC;"),
        };

        let db = self.db.read().await;
        let mut rows = db.query(&sql, ()).await.map_err(db_err)?;
        let mut out: Vec<ClienteOverview> = Vec::new();

        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id_cliente = row.get_value(0).map_err(db_err)?;
            let nombre = row.get_value(1).map_err(db_err)?;
            let email = row.get_value(2).map_err(db_err)?;
            let telefono = row.get_value(3).map_err(db_err)?;
            let ur_fecha = row.get_value(4).map_err(db_err)?;
            let ur_hora = row.get_value(5).map_err(db_err)?;
            let ur_num = row.get_value(6).map_err(db_err)?;
            let ur_mesa = row.get_value(7).map_err(db_err)?;
            let tg_calc = row.get_value(8).map_err(db_err)?;
            let tg_st = row.get_value(9).map_err(db_err)?;
            let total_res = row.get_value(10).map_err(db_err)?;
            let pend = row.get_value(11).map_err(db_err)?;

            out.push(ClienteOverview {
                id_cliente: v_string(id_cliente).unwrap_or_default(),
                nombre: v_string(nombre).unwrap_or_default(),
                email: norm_opt_string(email),
                telefono: norm_opt_string(telefono),

                ultima_reserva_fecha: norm_opt_string(ur_fecha),
                ultima_reserva_hora: norm_opt_string(ur_hora),
                ultima_reserva_num_personas: v_i64(ur_num),
                ultima_reserva_mesa: norm_opt_string(ur_mesa),

                total_gastado_calculado: v_f64(tg_calc).unwrap_or(0.0),
                total_gastado_stored: v_f64(tg_st).unwrap_or(0.0),

                total_reservas: v_i64(total_res).unwrap_or(0),
                reservas_pendientes: v_i64(pend).unwrap_or(0),
            });
        }

        Ok(out)
    }

    async fn form(&self, id_cliente: &str) -> AppResult<Option<ClienteForm>> {
        let sql = r#"
          SELECT Nombre, Email, Telefono, Notas
          FROM Clientes
          WHERE ID_Cliente = ?
          LIMIT 1;
        "#;

        let db = self.db.read().await;
        let mut rows = db
            .query(sql, vec![Value::Text(id_cliente.to_string())])
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };

        let nombre = row.get_value(0).map_err(db_err)?;
        let email = row.get_value(1).map_err(db_err)?;
        let telefono = row.get_value(2).map_err(db_err)?;
        let notas = row.get_value(3).map_err(db_err)?;

        Ok(Some(ClienteForm {
            nombre: v_string(nombre).unwrap_or_default(),
            email: norm_opt_string(email),
            telefono: norm_opt_string(telefono),
            notas: norm_opt_string(notas),
        }))
    }

    async fn create(&self, nuevo: NuevoCliente) -> AppResult<bool> {
        let id_cliente = nuevo.id.unwrap_or_else(new_id);

        let db = self.db.write().await;
        db.execute(
            r#"
                INSERT INTO Clientes (
                    ID_Cliente,
                    Nombre,
                    Telefono,
                    Email,
                    Notas,
                    Created_At
                )
                VALUES (
                    ?1,
                    ?2,
                    ?3,
                    ?4,
                    ?5,
                    datetime('now','localtime')
                )
                ON CONFLICT(ID_Cliente) DO UPDATE SET
                    Nombre = excluded.Nombre,
                    Telefono = excluded.Telefono,
                    Email = excluded.Email,
                    Notas = excluded.Notas;
                "#,
            vec![
                Value::Text(id_cliente),
                Value::Text(nuevo.nombre),
                opt_text(nuevo.telefono),
                opt_text(nuevo.email),
                opt_text(nuevo.notas),
            ],
        )
        .await
        .map_err(db_err)?;

        Ok(true)
    }

    async fn update(&self, cliente: Cliente) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                r#"
                UPDATE Clientes
                SET
                  Nombre = ?1,
                  Telefono = ?2,
                  Email = ?3,
                  Notas = ?4
                WHERE ID_Cliente = ?5;
                "#,
                vec![
                    Value::Text(cliente.nombre),
                    opt_text(cliente.telefono),
                    opt_text(cliente.email),
                    opt_text(cliente.notas),
                    Value::Text(cliente.id),
                ],
            )
            .await
            .map_err(db_err)?;

        Ok(affected > 0)
    }
}
