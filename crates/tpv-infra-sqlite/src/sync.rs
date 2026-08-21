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
use tpv_contracts::sync::{OutboxEntry, SqlStatement, SyncChange, SyncHealth};

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

/// Reintentos de una op nube→Main antes de ponerla en CUARENTENA (SYNC-01). Cada intento ocurre
/// en un ciclo de catch-up distinto (el pipeline para y reintenta), así que cubre fallos
/// transitorios sin descartar datos a la primera. Agotados, la op se salta para no bloquear el
/// resto de la sincronización indefinidamente.
const MAX_APPLY_ATTEMPTS: i64 = 5;

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
/// SYNC-18: la nube confirma (devolviéndonosla) que una operación NUESTRA está aplicada allí.
/// Se retira del outbox y de las encoladas. Si no era nuestra, no hay nada que borrar.
async fn confirmar_subida(conn: &Connection, op_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM _Sync_Outbox WHERE Op_Id = ?1;",
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    conn.execute(
        "DELETE FROM _Sync_Encoladas WHERE Op_Id = ?1;",
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

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

/// Registra (o incrementa) el fallo de una op en `_Sync_Failed` y devuelve el nº de intentos
/// acumulados. Sirve de contador persistente entre ciclos de catch-up para decidir la cuarentena.
async fn bump_failure(conn: &Connection, ch: &SyncChange, err: &str) -> AppResult<i64> {
    let now = now_ms();
    let stmts_json = serde_json::to_string(&ch.statements).unwrap_or_else(|_| "[]".to_string());
    let err_trunc: String = err.chars().take(500).collect();
    conn.execute(
        "INSERT INTO _Sync_Failed \
           (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms) \
         VALUES (?1, ?2, ?3, 1, 0, ?4, ?5, ?5) \
         ON CONFLICT(Op_Id) DO UPDATE SET \
           Attempts = Attempts + 1, Last_Error = ?4, Last_Failed_At_Ms = ?5;",
        vec![
            Value::Text(ch.op_id.clone()),
            Value::Integer(ch.seq),
            Value::Text(stmts_json),
            Value::Text(err_trunc),
            Value::Integer(now),
        ],
    )
    .await
    .map_err(db_err)?;

    let mut rows = conn
        .query(
            "SELECT Attempts FROM _Sync_Failed WHERE Op_Id = ?1 LIMIT 1;",
            vec![Value::Text(ch.op_id.clone())],
        )
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(r) => Ok(v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(1)),
        None => Ok(1),
    }
}

/// Pone una op en CUARENTENA: la marca como aplicada (para que el gate de idempotencia la salte),
/// deja constancia en `_Sync_Failed` (Quarantined=1, visible en el panel de salud) y AVANZA el
/// checkpoint para no volver a pedirla. El resto del pipeline puede así seguir convergiendo.
async fn quarantine(conn: &Connection, ch: &SyncChange) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, ?2, ?3);",
        vec![
            Value::Text(ch.op_id.clone()),
            Value::Integer(ch.seq),
            Value::Integer(now_ms()),
        ],
    )
    .await
    .map_err(db_err)?;
    conn.execute(
        "UPDATE _Sync_Failed SET Quarantined = 1 WHERE Op_Id = ?1;",
        vec![Value::Text(ch.op_id.clone())],
    )
    .await
    .map_err(db_err)?;
    advance_checkpoint(conn, ch.seq).await?;
    Ok(())
}

/// Limpia el registro de fallo de una op que acabó aplicándose (fallo transitorio recuperado).
/// No toca las ya en cuarentena (que igualmente no vuelven a `apply_one`, al estar marcadas).
async fn clear_failure(conn: &Connection, op_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM _Sync_Failed WHERE Op_Id = ?1 AND Quarantined = 0;",
        vec![Value::Text(op_id.to_string())],
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
                // El SQL queda SÓLO en el log local a nivel `debug` (no se reenvía a la nube: la
                // capa de telemetría descarta DEBUG/TRACE). El error que se PROPAGA no incluye la
                // sentencia, para no filtrar esquema/valores a la telemetría (OBS-02).
                tracing::debug!(
                    target: "tpv::sync",
                    op_id = %ch.op_id,
                    seq = ch.seq,
                    stmt_index = i,
                    sql = %st.sql.split_whitespace().collect::<Vec<_>>().join(" "),
                    "fallo aplicando sentencia de sync"
                );
                AppError::repository(format!(
                    "op {} (seq {}) sentencia #{i}: {e}",
                    ch.op_id, ch.seq,
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
            // SYNC-18: que un cambio VUELVA de la nube es la prueba de que allí se aplicó. Si era
            // una de las nuestras (encolada o simplemente sin ack), esta es su confirmación: se
            // retira del outbox y deja de estar pendiente. Cubre de una vez el camino de la cola y
            // cualquier `apply_ack` que se perdiera por el camino.
            confirmar_subida(conn, &ch.op_id).await?;

            // Idempotencia: una op ya aplicada (re-broadcast, solape con el catch-up, eco de las
            // propias escrituras de la Main o una op en cuarentena) se ignora, pero igualmente
            // avanza el checkpoint.
            if op_already_applied(conn, &ch.op_id).await? {
                advance_checkpoint(conn, ch.seq).await?;
                continue;
            }
            match apply_one(conn, ch).await {
                Ok(()) => {
                    // Éxito (posible recuperación de un fallo transitorio previo): limpia su marca.
                    clear_failure(conn, &ch.op_id).await?;
                }
                Err(e) => {
                    // SYNC-01: política de poison-message. Contamos el intento; agotados los
                    // reintentos, ponemos la op en cuarentena (se salta + avanza checkpoint +
                    // alerta) para NO bloquear el resto de la cola indefinidamente.
                    let attempts = bump_failure(conn, ch, &e.to_string()).await?;
                    if attempts >= MAX_APPLY_ATTEMPTS {
                        quarantine(conn, ch).await?;
                        tracing::error!(
                            target: "tpv::sync",
                            op_id = %ch.op_id,
                            seq = ch.seq,
                            attempts,
                            error = %e,
                            "op de sync en CUARENTENA tras agotar reintentos: se salta para no bloquear el pipeline"
                        );
                        // Cuarentenada: seguimos con el resto del lote.
                    } else {
                        // Aún dentro del margen: paramos el lote SIN avanzar el checkpoint, para
                        // reintentar esta op (y las siguientes) en el próximo ciclo de catch-up.
                        tracing::warn!(
                            target: "tpv::sync",
                            op_id = %ch.op_id,
                            seq = ch.seq,
                            attempts,
                            error = %e,
                            "fallo aplicando op de sync; se reintentará en el próximo ciclo"
                        );
                        break;
                    }
                }
            }
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

        // SYNC-18: se excluyen las que la nube ya aceptó en su cola. Siguen en el outbox (su prueba
        // de aplicación es volver por el catch-up), pero reenviarlas mientras tanto sería repetir
        // trabajo en cada ciclo de drenado.
        let mut rows = conn
            .query(
                "SELECT Seq, Op_Id, Command_Name, Statements_Json \
                 FROM _Sync_Outbox \
                 WHERE Op_Id NOT IN (SELECT Op_Id FROM _Sync_Encoladas) \
                 ORDER BY Seq ASC LIMIT ?1;",
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

    async fn outbox_mark_encolada(&self, op_ids: &[String]) -> AppResult<()> {
        if op_ids.is_empty() {
            return Ok(());
        }
        // Tabla de control: conexión CRUDA (no debe capturarse como cambio de negocio).
        let w = self.db.write().await;
        let conn = w.raw();
        let ahora = now_ms();

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            for op_id in op_ids {
                conn.execute(
                    "INSERT OR REPLACE INTO _Sync_Encoladas (Op_Id, Encolada_En_Ms) VALUES (?1, ?2);",
                    vec![Value::Text(op_id.clone()), Value::Integer(ahora)],
                )
                .await
                .map_err(db_err)?;
            }
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

    async fn liberar_encoladas_caducadas(&self, antiguedad_ms: i64) -> AppResult<i64> {
        let w = self.db.write().await;
        let conn = w.raw();
        let corte = now_ms() - antiguedad_ms.max(0);

        // `<=` y no `<`: con `antiguedad_ms = 0` la lectura natural es "libera todas", y con un
        // plazo real (una hora) la diferencia en el borde es irrelevante. Con `<`, una encolada en
        // el mismo milisegundo que la consulta se salvaba por un pelo.
        let n = conn
            .execute(
                "DELETE FROM _Sync_Encoladas WHERE Encolada_En_Ms <= ?1;",
                vec![Value::Integer(corte)],
            )
            .await
            .map_err(db_err)?;

        Ok(n as i64)
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

    async fn health(&self) -> AppResult<SyncHealth> {
        let r = self.db.read().await;
        let conn = r.conn();

        async fn count(conn: &Connection, sql: &str) -> AppResult<i64> {
            let mut rows = conn.query(sql, ()).await.map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => Ok(v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0)),
                None => Ok(0),
            }
        }

        let outbox_pending = count(conn, "SELECT COUNT(*) FROM _Sync_Outbox;").await?;
        let last_seq = checkpoint(conn).await?;
        let quarantined =
            count(conn, "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 1;").await?;
        let failing =
            count(conn, "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 0;").await?;

        Ok(SyncHealth {
            outbox_pending,
            last_seq,
            quarantined,
            failing,
        })
    }
}

#[cfg(test)]
mod tests_encoladas {
    //! SYNC-18 · lado Main: el estado intermedio "la nube la tiene en su cola, pero aún no me
    //! consta aplicada".
    //!
    //! Es el estado que permite a este TPV soltar su atraso y desconectarse. Lo delicado es que no
    //! se dé una operación por buena antes de tiempo: mientras no vuelva por el catch-up, su copia
    //! local se conserva.

    use super::*;
    use crate::db::Db;
    use libsql::Connection;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{SqlStatement, SyncChange};

    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        format!("{}_{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
    }

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("tpv_sync_test_{}", uniq()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    /// Mete una operación en el outbox como si la hubiera capturado una escritura local.
    async fn encolar_en_outbox(db: &Arc<Db>, op_id: &str) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        conn.execute(
            "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
             VALUES (?1, 'test', '[]', ?2);",
            vec![Value::Text(op_id.to_string()), Value::Integer(now_ms())],
        )
        .await
        .unwrap();
    }

    async fn ids_pendientes(repo: &SqliteSyncRepository) -> Vec<String> {
        repo.outbox_pending(100)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.op_id)
            .collect()
    }

    #[tokio::test]
    async fn una_encolada_deja_de_ofrecerse_pero_no_se_borra() {
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        encolar_en_outbox(&db, "op-2").await;

        repo.outbox_mark_encolada(&["op-1".to_string()]).await.unwrap();

        // Ya no se ofrece para reenviar...
        assert_eq!(ids_pendientes(&repo).await, vec!["op-2".to_string()]);
        // ...pero su copia sigue aquí: que la nube la tenga en la cola no prueba que la aplicara.
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT COUNT(*) FROM _Sync_Outbox WHERE Op_Id = 'op-1';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().unwrap();
        assert_eq!(v_i64(fila.get_value(0).unwrap()).unwrap_or(0), 1);
    }

    #[tokio::test]
    async fn verla_volver_de_la_nube_es_lo_que_la_da_por_subida() {
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        repo.outbox_mark_encolada(&["op-1".to_string()]).await.unwrap();

        // El catch-up la devuelve: prueba de que allí está aplicada.
        repo.apply_changes(vec![SyncChange {
            op_id: "op-1".to_string(),
            seq: 7,
            statements: Vec::<SqlStatement>::new(),
        }])
        .await
        .unwrap();

        assert!(ids_pendientes(&repo).await.is_empty());
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT (SELECT COUNT(*) FROM _Sync_Outbox) + (SELECT COUNT(*) FROM _Sync_Encoladas);",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().unwrap();
        assert_eq!(v_i64(fila.get_value(0).unwrap()).unwrap_or(-1), 0);
    }

    #[tokio::test]
    async fn una_encolada_que_nunca_se_confirma_vuelve_a_ofrecerse() {
        // La red que impide el limbo: si la nube nunca la devuelve (se perdió el ack, o acabó
        // apartada allí), se reenvía. Reenviar es inocuo: la nube es idempotente por `Op_Id`.
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        repo.outbox_mark_encolada(&["op-1".to_string()]).await.unwrap();
        assert!(ids_pendientes(&repo).await.is_empty());

        // Todavía es reciente: no se toca.
        assert_eq!(repo.liberar_encoladas_caducadas(60_000).await.unwrap(), 0);

        assert!(ids_pendientes(&repo).await.is_empty());

        // Con el plazo vencido, vuelve a estar disponible.
        assert_eq!(repo.liberar_encoladas_caducadas(0).await.unwrap(), 1);
        assert_eq!(ids_pendientes(&repo).await, vec!["op-1".to_string()]);
    }
}
