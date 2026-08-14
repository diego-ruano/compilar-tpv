//! Adaptador SQLite del puerto `JobsStateRepository`: el estado de los jobs periódicos.
//!
//! `_Jobs_State` es una tabla de control **local del dispositivo** (como las `_Sync_*`): la crea
//! `Db::open` y NO forma parte del esquema compartido con la nube. Cada equipo lleva su propio
//! ritmo de ejecución, así que replicarla no significaría nada.
//!
//! Por eso todas las escrituras van por la conexión CRUDA (`WriteGuard::raw()`): un `execute()`
//! normal se capturaría en `_Sync_Outbox` y cada tick de cada job generaría tráfico de
//! sincronización hacia la nube.

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::jobs::{EstadoJob, JobsStateRepository};

use crate::db::Db;
use crate::mapping::{v_i64, v_string};

pub struct SqliteJobsStateRepository {
    db: Arc<Db>,
}

impl SqliteJobsStateRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

/// Columnas en el mismo orden en todas las consultas, para leer por índice sin sorpresas.
const COLS: &str = "Nombre, Last_Run_Ms, Last_Ok_Ms, Last_Error, Fallos";

fn fila_a_estado(row: &libsql::Row) -> AppResult<(String, EstadoJob)> {
    let nombre = v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default();
    Ok((
        nombre,
        EstadoJob {
            last_run_ms: v_i64(row.get_value(1).map_err(db_err)?),
            last_ok_ms: v_i64(row.get_value(2).map_err(db_err)?),
            last_error: v_string(row.get_value(3).map_err(db_err)?),
            fallos: v_i64(row.get_value(4).map_err(db_err)?).unwrap_or(0),
        },
    ))
}

fn opt_int(v: Option<i64>) -> Value {
    v.map(Value::Integer).unwrap_or(Value::Null)
}

fn opt_text(v: Option<&str>) -> Value {
    v.map(|s| Value::Text(s.to_string())).unwrap_or(Value::Null)
}

#[async_trait]
impl JobsStateRepository for SqliteJobsStateRepository {
    async fn cargar(&self, nombre: &str) -> AppResult<Option<EstadoJob>> {
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                &format!("SELECT {COLS} FROM _Jobs_State WHERE Nombre = ?1 LIMIT 1;"),
                vec![Value::Text(nombre.to_string())],
            )
            .await
            .map_err(db_err)?;

        match rows.next().await.map_err(db_err)? {
            Some(row) => Ok(Some(fila_a_estado(&row)?.1)),
            None => Ok(None),
        }
    }

    async fn guardar(&self, nombre: &str, estado: &EstadoJob) -> AppResult<()> {
        let w = self.db.write().await;
        w.raw()
            .execute(
                "INSERT INTO _Jobs_State (Nombre, Last_Run_Ms, Last_Ok_Ms, Last_Error, Fallos) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(Nombre) DO UPDATE SET \
                   Last_Run_Ms = excluded.Last_Run_Ms, \
                   Last_Ok_Ms  = excluded.Last_Ok_Ms, \
                   Last_Error  = excluded.Last_Error, \
                   Fallos      = excluded.Fallos;",
                vec![
                    Value::Text(nombre.to_string()),
                    opt_int(estado.last_run_ms),
                    opt_int(estado.last_ok_ms),
                    opt_text(estado.last_error.as_deref()),
                    Value::Integer(estado.fallos),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn listar(&self) -> AppResult<Vec<(String, EstadoJob)>> {
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                &format!("SELECT {COLS} FROM _Jobs_State ORDER BY Nombre;"),
                (),
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(fila_a_estado(&row)?);
        }
        Ok(out)
    }
}
