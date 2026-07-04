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

/// Traduce errores de las escrituras de cliente. Una violación del índice único de email
/// (`ux_clientes_email`, sobre `lower(Email)`) se convierte en un error de validación con
/// mensaje claro (CLI-04); el resto se propaga como error de repositorio.
fn write_err(e: impl std::fmt::Display) -> AppError {
    let msg = e.to_string();
    if msg.contains("ux_clientes_email") {
        AppError::validation("Ya existe un cliente con ese email.")
    } else {
        AppError::repository(msg)
    }
}

// Base del overview. En vez de ~6 subconsultas correlacionadas por cliente (coste
// O(clientes x reservas), CLI-02), se precalcula la última reserva y los agregados en
// dos CTEs que recorren `Reservas` una sola vez (mismo patrón que DB-12 en inventario).
// La salida y el orden de columnas son IDÉNTICOS a la versión anterior. No se limita
// el número de filas: el ranking "Reciente" es la lista completa que el frontend usa
// para buscar/contar (añadir LIMIT rompería esa búsqueda).
fn sql_overview_base() -> &'static str {
    r#"
    WITH ult_reserva AS (
      SELECT
        r.ID_Cliente,
        r.Dia_YMD,
        r.Hora,
        r.Comensales,
        r.ID_Mesa,
        ROW_NUMBER() OVER (
          PARTITION BY r.ID_Cliente
          ORDER BY r.Dia_YMD DESC, r.Hora DESC
        ) AS rn
      FROM Reservas r
    ),
    agg_reservas AS (
      SELECT
        r.ID_Cliente,
        COUNT(*) AS Total_Reservas,
        SUM(
          CASE
            WHEN UPPER(COALESCE(r.Estado,'')) = 'ACTIVA'
             AND date(r.Dia_YMD) >= date('now','localtime')
            THEN 1 ELSE 0
          END
        ) AS Reservas_Pendientes
      FROM Reservas r
      GROUP BY r.ID_Cliente
    )
    SELECT
      c.ID_Cliente,
      c.Nombre,
      c.Email,
      c.Telefono,

      ur.Dia_YMD    AS Ultima_Reserva_Fecha,
      ur.Hora       AS Ultima_Reserva_Hora,
      ur.Comensales AS Ultima_Reserva_NumPersonas,
      m.Numero_Mesa AS Ultima_Reserva_Mesa,

      IFNULL(c.Total_Gastado, 0) AS Total_Gastado_Stored,

      COALESCE(ar.Total_Reservas, 0)      AS Total_Reservas,
      COALESCE(ar.Reservas_Pendientes, 0) AS Reservas_Pendientes

    FROM Clientes c
    LEFT JOIN ult_reserva ur ON ur.ID_Cliente = c.ID_Cliente AND ur.rn = 1
    LEFT JOIN Mesas m        ON m.ID_Mesa = ur.ID_Mesa
    LEFT JOIN agg_reservas ar ON ar.ID_Cliente = c.ID_Cliente
    "#
}

#[async_trait]
impl ClientesRepository for SqliteClientesRepository {
    async fn overview(&self, ranking: ClienteRanking) -> AppResult<Vec<ClienteOverview>> {
        let base = sql_overview_base();

        let sql = match ranking {
            ClienteRanking::PorReservas => format!(
                "{base}\nORDER BY Total_Reservas DESC, Total_Gastado_Stored DESC, c.ID_Cliente DESC\nLIMIT 10;"
            ),
            ClienteRanking::PorGasto => format!(
                "{base}\nORDER BY Total_Gastado_Stored DESC, Total_Reservas DESC, c.ID_Cliente DESC\nLIMIT 10;"
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
            let tg_st = row.get_value(8).map_err(db_err)?;
            let total_res = row.get_value(9).map_err(db_err)?;
            let pend = row.get_value(10).map_err(db_err)?;

            out.push(ClienteOverview {
                id_cliente: v_string(id_cliente).unwrap_or_default(),
                nombre: v_string(nombre).unwrap_or_default(),
                email: norm_opt_string(email),
                telefono: norm_opt_string(telefono),

                ultima_reserva_fecha: norm_opt_string(ur_fecha),
                ultima_reserva_hora: norm_opt_string(ur_hora),
                ultima_reserva_num_personas: v_i64(ur_num),
                ultima_reserva_mesa: norm_opt_string(ur_mesa),

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
        .map_err(write_err)?;

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
            .map_err(write_err)?;

        Ok(affected > 0)
    }
}
