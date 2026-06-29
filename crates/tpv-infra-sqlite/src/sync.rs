//! Adaptador SQLite del puerto `SyncRepository`: aplica en la BD local de la Main las
//! operaciones que llegan de la nube (Opción 3: sentencias ya resueltas), de forma idempotente
//! (por `op_id`) y llevando un checkpoint (`seq`).
//!
//! Tras el refactor de conexiones (`db.rs`): el aplicador corre sobre la **conexión de escritura
//! exclusiva** (vía `Db::write()`), usando su conexión CRUDA (`raw()`) para NO re-capturar los
//! cambios remotos en el outbox. Como el escritor es único, queda serializado con las
//! transacciones de los repos sin necesidad de la antigua "puerta de transacción". Las lecturas
//! del outbox / checkpoint usan el pool de lectura (`Db::read()`).
//!
//! Las tablas de control (`_Sync_*`) las crea `Db::open` al arrancar, así que aquí no hace falta
//! asegurarlas en cada llamada.

use std::sync::Arc;

use async_trait::async_trait;
use libsql::{Connection, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::sync::SyncRepository;
use tpv_contracts::sync::{OutboxEntry, SqlStatement, SyncChange};

use crate::db::Db;
use crate::mapping::v_i64;

pub struct SqliteSyncRepository {
    db: Arc<Db>,
}

impl SqliteSyncRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(i64::MAX)
}

/// Margen (en nº de operaciones) que la purga por cursor deja SIN borrar por debajo del checkpoint.
/// Cubre el solape catch-up/live al reconectar: una op con `Seq` ya superado por `Last_Seq` solo
/// puede re-llegar dentro de esa ventana de reconexión, mucho más estrecha que este margen.
const PURGE_CURSOR_MARGIN: i64 = 500;

/// Antigüedad mínima (ms) para que la purga TTL retire un registro ya confirmado en la nube.
const PURGE_TTL_MS: i64 = 72 * 60 * 60 * 1000;

/// Convierte un escalar JSON al `Value` de libsql para enlazarlo como argumento.
fn json_to_value(v: &serde_json::Value) -> Value {
    use serde_json::Value as J;
    match v {
        J::Null => Value::Null,
        J::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        J::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                Value::Null
            }
        }
        J::String(s) => Value::Text(s.clone()),
        // arrays/objetos no deberían llegar como args; los guardamos como texto JSON.
        other => Value::Text(other.to_string()),
    }
}

async fn checkpoint(conn: &Connection) -> AppResult<i64> {
    let mut rows = conn
        .query("SELECT Last_Seq FROM _Sync_State WHERE Id = 1 LIMIT 1;", ())
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(r) => Ok(v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0)),
        None => Ok(0),
    }
}

async fn op_already_applied(conn: &Connection, op_id: &str) -> AppResult<bool> {
    let mut rows = conn
        .query(
            "SELECT 1 FROM _Sync_Applied_Ops WHERE Op_Id = ?1 LIMIT 1;",
            vec![Value::Text(op_id.to_string())],
        )
        .await
        .map_err(db_err)?;
    Ok(rows.next().await.map_err(db_err)?.is_some())
}

/// Avanza el checkpoint hasta `seq` (solo hacia delante). Se usa al SALTAR una op ya aplicada
/// (p. ej. un eco de las propias escrituras de la Main que vuelve por el catch-up): aunque no se
/// reaplique, hay que mover el cursor para no volver a pedirla indefinidamente.
async fn advance_checkpoint(conn: &Connection, seq: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1 AND Last_Seq < ?1;",
        vec![Value::Integer(seq)],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Purga por cursor de `_Sync_Applied_Ops`: retira los registros cuyo `Seq` ya quedó superado por
/// el checkpoint con holgura (`PURGE_CURSOR_MARGIN`). Solo afecta a `Seq > 0` (remotos aplicados o
/// anti-ecos ya ascendidos a su Seq real tras el `apply_ack`); los anti-ecos sin ascender (`Seq=0`)
/// quedan intactos —los retira la purga TTL una vez subidos—. Es seguro: un `Seq` por debajo del
/// margen ya no puede volver a llegar (el catch-up pide solo `Seq > Last_Seq`).
async fn purge_by_cursor(conn: &Connection, last_seq: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM _Sync_Applied_Ops WHERE Seq > 0 AND Seq <= ?1;",
        vec![Value::Integer(last_seq - PURGE_CURSOR_MARGIN)],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Aplica una operación de forma atómica: sus sentencias + el registro de idempotencia + el
/// avance del checkpoint, todo dentro de una transacción. `defer_foreign_keys` evita fallos por
/// orden dentro de la propia operación. Corre sobre la conexión CRUDA de escritura (sin captura).
async fn apply_one(conn: &Connection, ch: &SyncChange) -> AppResult<()> {
    conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;")
        .await
        .map_err(db_err)?;

    let res: AppResult<()> = async {
        for (i, st) in ch.statements.iter().enumerate() {
            let args: Vec<Value> = st.args.iter().map(json_to_value).collect();
            conn.execute(&st.sql, args).await.map_err(|e| {
                AppError::repository(format!(
                    "op {} (seq {}) sentencia #{i}: {e} :: SQL={}",
                    ch.op_id,
                    ch.seq,
                    st.sql.split_whitespace().collect::<Vec<_>>().join(" ")
                ))
            })?;
        }

        conn.execute(
            "INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, ?2, ?3);",
            vec![
                Value::Text(ch.op_id.clone()),
                Value::Integer(ch.seq),
                Value::Integer(now_ms()),
            ],
        )
        .await
        .map_err(db_err)?;

        conn.execute(
            "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1 AND Last_Seq < ?1;",
            vec![Value::Integer(ch.seq)],
        )
        .await
        .map_err(db_err)?;

        Ok(())
    }
    .await;

    match res {
        Ok(()) => match conn.execute_batch("COMMIT;").await {
            Ok(()) => Ok(()),
            Err(e) => {
                // Con `defer_foreign_keys`, las violaciones de FK saltan AQUÍ (en el COMMIT), no
                // en la sentencia. Volcamos el op_id + sus sentencias para identificar qué fila
                // hija quedó sin padre en la BD local.
                let _ = conn.execute_batch("ROLLBACK;").await;
                let sqls: Vec<String> = ch
                    .statements
                    .iter()
                    .map(|s| s.sql.split_whitespace().collect::<Vec<_>>().join(" "))
                    .collect();
                Err(AppError::repository(format!(
                    "COMMIT op {} (seq {}) falló: {e} :: sentencias={sqls:?}",
                    ch.op_id, ch.seq
                )))
            }
        },
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;").await;
            Err(e)
        }
    }
}

#[async_trait]
impl SyncRepository for SqliteSyncRepository {
    async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<i64> {
        // Acceso EXCLUSIVO de escritura durante todo el lote: serializa con las transacciones de
        // los repos (un único escritor). Conexión CRUDA → no se re-captura en el outbox.
        let w = self.db.write().await;
        let conn: &Connection = w.raw();

        for ch in &changes {
            // Idempotencia: una op ya aplicada (re-broadcast, solape con el catch-up o eco de
            // las propias escrituras de la Main) se ignora, pero igualmente avanza el checkpoint.
            if op_already_applied(conn, &ch.op_id).await? {
                advance_checkpoint(conn, ch.seq).await?;
                continue;
            }
            apply_one(conn, ch).await?;
        }

        // Cada vez que el checkpoint avanza (por catch-up o por cambios en vivo) intentamos retirar
        // los registros de idempotencia ya superados. Coste despreciable (DELETE indexado) y solo
        // borra filas seguras.
        let last_seq = checkpoint(conn).await?;
        purge_by_cursor(conn, last_seq).await?;
        Ok(last_seq)
    }

    async fn get_checkpoint(&self) -> AppResult<i64> {
        let r = self.db.read().await;
        checkpoint(r.conn()).await
    }

    async fn outbox_pending(&self, limit: i64) -> AppResult<Vec<OutboxEntry>> {
        let r = self.db.read().await;
        let conn = r.conn();

        let mut rows = conn
            .query(
                "SELECT Seq, Op_Id, Command_Name, Statements_Json \
                 FROM _Sync_Outbox ORDER BY Seq ASC LIMIT ?1;",
                vec![Value::Integer(limit)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let seq = v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0);
            let op_id = match r.get_value(1).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let command_name = match r.get_value(2).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "main_op".to_string(),
            };
            let statements_json = match r.get_value(3).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "[]".to_string(),
            };
            let statements: Vec<SqlStatement> =
                serde_json::from_str(&statements_json).unwrap_or_default();

            out.push(OutboxEntry {
                seq,
                op_id,
                command_name,
                statements,
            });
        }

        Ok(out)
    }

    async fn outbox_mark_sent(&self, op_id: &str, seq: i64) -> AppResult<()> {
        // Tras el `apply_ack`: (1) ascendemos el anti-eco de `_Sync_Applied_Ops` a su `Seq` real
        // (la nube ya ordenó la op) para que la purga por cursor pueda retirarlo más tarde; y
        // (2) borramos la fila del outbox (ya subida). Ambas tablas de control van por la conexión
        // CRUDA de escritura (no deben capturarse como cambio de negocio) y quedan serializadas por
        // el escritor único; las hacemos en una transacción para que el upgrade y el borrado sean
        // atómicos (un anti-eco con Seq>0 implica invariablemente "ya no está en el outbox").
        let w = self.db.write().await;
        let conn = w.raw();

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            if seq > 0 {
                conn.execute(
                    "UPDATE _Sync_Applied_Ops SET Seq = ?1 WHERE Op_Id = ?2 AND Seq = 0;",
                    vec![Value::Integer(seq), Value::Text(op_id.to_string())],
                )
                .await
                .map_err(db_err)?;
            }
            conn.execute(
                "DELETE FROM _Sync_Outbox WHERE Op_Id = ?1;",
                vec![Value::Text(op_id.to_string())],
            )
            .await
            .map_err(db_err)?;
            Ok(())
        }
        .await;

        match res {
            Ok(()) => conn.execute_batch("COMMIT;").await.map_err(db_err),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn purge_applied_ops(&self) -> AppResult<()> {
        // Red de seguridad para los anti-ecos que no se ascendieron por cursor (p. ej. `apply_ack`
        // sin `seq` por cache-hit de idempotencia): retira los registros ANTIGUOS (TTL) cuyo
        // `Op_Id` YA NO está pendiente en el outbox (es decir, ya confirmados en la nube). El
        // filtro `NOT IN (_Sync_Outbox)` es la garantía de "solo borrar lo subido": jamás retira
        // un anti-eco cuya op siga sin enviarse (lo que provocaría su re-aplicación tras catch-up).
        let cutoff = now_ms() - PURGE_TTL_MS;
        let w = self.db.write().await;
        w.raw()
            .execute(
                "DELETE FROM _Sync_Applied_Ops \
                 WHERE Applied_At_Ms < ?1 \
                   AND Op_Id NOT IN (SELECT Op_Id FROM _Sync_Outbox);",
                vec![Value::Integer(cutoff)],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }
}
