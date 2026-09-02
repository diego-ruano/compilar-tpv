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
use tpv_contracts::sync::{
    AplicacionSync, BootstrapResultado, BootstrapSnapshot, OutboxEntry, SqlStatement, SyncChange,
    SyncHealth,
};

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

/// Tope de parámetros (`?`) por sentencia al restaurar. El límite real de SQLite es mayor, pero el
/// margen no compra nada aquí: lo que importa es no volver a una sentencia por fila.
const MAX_PARAMS_POR_SENTENCIA: usize = 900;

/// Nombres de tabla realmente presentes en la BD local. El volcado de la nube se filtra contra
/// esto: una Main con una versión por detrás recibirá tablas que su esquema aún no tiene, y eso
/// tiene que informarse, no reventar la recuperación.
async fn tablas_locales(conn: &Connection) -> AppResult<std::collections::HashSet<String>> {
    let mut rows = conn
        .query("SELECT name FROM sqlite_master WHERE type = 'table';", ())
        .await
        .map_err(db_err)?;
    let mut out = std::collections::HashSet::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        if let Ok(Value::Text(n)) = row.get_value(0) {
            out.insert(n);
        }
    }
    Ok(out)
}

/// ¿Es un identificador SQL simple? El volcado llega de la red, y sus nombres de tabla y de columna
/// se interpolan en el SQL (no se pueden enlazar con `?`). Un nombre que no sea `[A-Za-z0-9_]` se
/// descarta: no hay ningún caso legítimo en este esquema y sí una inyección si se deja pasar.
fn identificador_simple(nombre: &str) -> bool {
    !nombre.is_empty()
        && nombre
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
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
    async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<AplicacionSync> {
        // Se anota lo que se aplica DE VERDAD. Lo que el gate de idempotencia salta (un
        // re-broadcast, el eco de nuestras propias escrituras al volver por el catch-up, una op en
        // cuarentena) no cambió nada en esta BD, así que el frontend no tiene por qué reaccionar.
        let mut aplicadas: Vec<String> = Vec::new();
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
                    aplicadas.push(ch.op_id.clone());
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
        Ok(AplicacionSync {
            aplicadas,
            last_seq,
        })
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
        let quarantined = count(
            conn,
            "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 1;",
        )
        .await?;
        let failing = count(
            conn,
            "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 0;",
        )
        .await?;

        Ok(SyncHealth {
            outbox_pending,
            last_seq,
            quarantined,
            failing,
        })
    }

    async fn bootstrap_restaurar(
        &self,
        snapshot: BootstrapSnapshot,
    ) -> AppResult<BootstrapResultado> {
        let w = self.db.write().await;
        let conn = w.raw();

        let locales = tablas_locales(conn).await?;

        // Se decide TODO antes de tocar nada: qué tablas se restauran y cuáles no existen aquí.
        let mut restaurables: Vec<&tpv_contracts::sync::BootstrapTabla> = Vec::new();
        let mut desconocidas: Vec<String> = Vec::new();
        for t in &snapshot.tablas {
            if !identificador_simple(&t.nombre) || !locales.contains(&t.nombre) {
                desconocidas.push(t.nombre.clone());
                continue;
            }
            if t.columnas.iter().any(|c| !identificador_simple(c)) {
                desconocidas.push(t.nombre.clone());
                continue;
            }
            restaurables.push(t);
        }

        if restaurables.is_empty() {
            return Err(AppError::validation(
                "El volcado de la nube no trae ninguna tabla que esta versión reconozca",
            ));
        }

        // `defer_foreign_keys` deja que el orden entre tablas dé igual: se comprueban las FK al
        // COMMIT, cuando ya está todo dentro. Sin esto habría que ordenar 41 tablas por sus
        // dependencias y mantener ese orden a mano en cada cambio de esquema.
        conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;")
            .await
            .map_err(db_err)?;

        let res: AppResult<i64> = async {
            // Restaurar VACÍA las tablas: una operación local aún sin subir se perdería sin dejar
            // rastro y sin que nadie lo supiera. Va DENTRO de la transacción a propósito —
            // comprobarlo antes dejaría una ventana por la que puede colarse una venta entre el
            // permiso y el borrado. En el camino real (una BD recién perdida, todavía sin
            // escrituras) el outbox está vacío y esto no se nota.
            //
            // La excepción: una BD que YA está bloqueada en reconciliación (viene de una
            // restauración anterior que no consiguió converger) no está vendiendo, y su outbox es
            // el de la copia, no el de un servicio en curso. Negarle también este camino la dejaría
            // sin ninguna salida, que es justo el callejón que esta pantalla existe para evitar.
            let reconciliando = {
                let mut rows = conn
                    .query(
                        "SELECT Reconciliation_Pending FROM _Recovery_State WHERE Id = 1;",
                        (),
                    )
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0) != 0,
                    None => false,
                }
            };
            // Una base SIN USUARIOS tampoco está vendiendo —no se puede iniciar sesión—, así que
            // lo que tenga en el outbox no es una venta: lo escribió algo que no debería haber
            // escrito. Ver la misma excepción, con su porqué, en `recovery::asegurar_reemplazo_seguro`.
            let sin_usuarios = {
                let mut rows = conn
                    .query("SELECT COUNT(*) FROM Usuarios;", ())
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0) == 0,
                    None => true,
                }
            };
            let pendientes = {
                let mut rows = conn
                    .query("SELECT COUNT(*) FROM _Sync_Outbox;", ())
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                    None => 0,
                }
            };
            if pendientes > 0 && !reconciliando && !sin_usuarios {
                return Err(AppError::conflict(format!(
                    "Hay {pendientes} operaciones de este equipo sin subir a la nube. Restaurar las borraría: espera a que se sincronicen antes de recuperar."
                )));
            }

            for t in &restaurables {
                conn.execute(&format!("DELETE FROM \"{}\";", t.nombre), ())
                    .await
                    .map_err(|e| {
                        AppError::repository(format!("vaciando {}: {e}", t.nombre))
                    })?;
            }

            let mut filas = 0i64;
            for t in &restaurables {
                if t.filas.is_empty() {
                    continue;
                }
                let n_cols = t.columnas.len();
                let cols = t
                    .columnas
                    .iter()
                    .map(|c| format!("\"{c}\""))
                    .collect::<Vec<_>>()
                    .join(", ");

                // Una fila por `execute()` significaba reparsear el mismo INSERT decenas de miles
                // de veces. Se agrupan en sentencias multi-fila, acotadas por el número de
                // parámetros que SQLite acepta en una sentencia.
                let por_lote = (MAX_PARAMS_POR_SENTENCIA / n_cols.max(1)).max(1);
                let marcas_fila = format!("({})", vec!["?"; n_cols].join(", "));

                for lote in t.filas.chunks(por_lote) {
                    let mut args: Vec<Value> = Vec::with_capacity(lote.len() * n_cols);
                    for fila in lote {
                        if fila.len() != n_cols {
                            return Err(AppError::validation(format!(
                                "{}: fila con {} valores para {n_cols} columnas",
                                t.nombre,
                                fila.len(),
                            )));
                        }
                        args.extend(fila.iter().map(json_to_value));
                    }

                    let valores = vec![marcas_fila.as_str(); lote.len()].join(", ");
                    let sql = format!(
                        "INSERT INTO \"{}\" ({cols}) VALUES {valores};",
                        t.nombre
                    );
                    conn.execute(&sql, args).await.map_err(|e| {
                        AppError::repository(format!("restaurando {}: {e}", t.nombre))
                    })?;
                    filas += lote.len() as i64;
                }
            }

            // El andamiaje de sync se rehace desde cero: el checkpoint pasa a ser el `seq` de la
            // foto y todo lo anterior (anti-ecos, fallos, cuarentenas) hablaba de una BD que ya no
            // existe. Conservarlo haría que el catch-up saltase operaciones que esta BD nueva sí
            // necesita.
            conn.execute("DELETE FROM _Sync_Applied_Ops;", ())
                .await
                .map_err(db_err)?;
            conn.execute("DELETE FROM _Sync_Failed;", ())
                .await
                .map_err(db_err)?;
            conn.execute("DELETE FROM _Sync_Encoladas;", ())
                .await
                .map_err(db_err)?;
            conn.execute(
                "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1;",
                vec![Value::Integer(snapshot.seq)],
            )
            .await
            .map_err(db_err)?;

            // El snapshot es coherente en su `seq`, pero puede entrar una escritura nueva justo
            // después de tomarlo. El login permanece bloqueado hasta que el WebSocket haga el
            // ciclo catch-up → outbox → catch-up y confirme el high-water de la nube.
            conn.execute(
                "UPDATE _Recovery_State SET Reconciliation_Pending = 1 WHERE Id = 1;",
                (),
            )
            .await
            .map_err(db_err)?;

            Ok(filas)
        }
        .await;

        match res {
            Ok(filas) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
                // La base queda restaurada pero pendiente de reconciliar: hasta que converja no
                // admite escrituras de negocio (aquí no se reabre el `Db`, así que el cerrojo no
                // lo recalcula nadie más).
                self.db.bloquear_escrituras_de_negocio(true);
                tracing::info!(
                    target: "tpv::sync",
                    seq = snapshot.seq,
                    filas,
                    tablas = restaurables.len(),
                    "BD local reconstruida desde la nube"
                );
                Ok(BootstrapResultado {
                    seq: snapshot.seq,
                    filas_restauradas: filas,
                    tablas_restauradas: restaurables.iter().map(|t| t.nombre.clone()).collect(),
                    tablas_desconocidas: desconocidas,
                })
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
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
        format!(
            "{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("tpv_sync_test_{}", uniq()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap())
            .await
            .unwrap();
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

        repo.outbox_mark_encolada(&["op-1".to_string()])
            .await
            .unwrap();

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
        repo.outbox_mark_encolada(&["op-1".to_string()])
            .await
            .unwrap();

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
        repo.outbox_mark_encolada(&["op-1".to_string()])
            .await
            .unwrap();
        assert!(ids_pendientes(&repo).await.is_empty());

        // Todavía es reciente: no se toca.
        assert_eq!(repo.liberar_encoladas_caducadas(60_000).await.unwrap(), 0);

        assert!(ids_pendientes(&repo).await.is_empty());

        // Con el plazo vencido, vuelve a estar disponible.
        assert_eq!(repo.liberar_encoladas_caducadas(0).await.unwrap(), 1);
        assert_eq!(ids_pendientes(&repo).await, vec!["op-1".to_string()]);
    }
}

#[cfg(test)]
mod tests_aplicadas {
    //! Qué se aplica DE VERDAD en un lote.
    //!
    //! El frontend reacciona a esta lista: invalidar la caché, recargar el POS y releer los ajustes.
    //! Si aquí se colaran las operaciones que el gate de idempotencia salta —las propias de esta
    //! Main volviendo por el catch-up, o un re-broadcast—, media aplicación se recargaría sin que
    //! nada hubiera cambiado. En el caso de los ajustes eso realimentaba un bucle que llegó a
    //! generar decenas de miles de operaciones.

    use super::*;
    use crate::db::Db;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{SqlStatement, SyncChange};

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);

        let dir = std::env::temp_dir().join(format!(
            "tpv_aplicadas_test_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap())
            .await
            .unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    fn cambio(op_id: &str, seq: i64) -> SyncChange {
        SyncChange {
            op_id: op_id.to_string(),
            seq,
            statements: vec![SqlStatement {
                sql: "UPDATE Business_Settings SET Business_Name = ?1 WHERE ID = 1;".into(),
                args: vec![serde_json::json!("Bar de Prueba")],
            }],
        }
    }

    #[tokio::test]
    async fn el_mismo_lote_solo_se_aplica_la_primera_vez() {
        let (repo, _db, dir) = repo_temporal().await;
        let lote = vec![cambio("op-1", 1), cambio("op-2", 2)];

        let primera = repo.apply_changes(lote.clone()).await.unwrap();
        assert_eq!(
            primera.aplicadas,
            vec!["op-1".to_string(), "op-2".to_string()]
        );
        assert_eq!(primera.last_seq, 2);

        // Segunda vuelta con el MISMO lote: el checkpoint sigue avanzando, pero no se aplica nada.
        // Es exactamente lo que pasa cuando el catch-up devuelve las operaciones de esta Main.
        let segunda = repo.apply_changes(lote).await.unwrap();
        assert!(
            segunda.aplicadas.is_empty(),
            "un lote repetido no aplica nada: {:?}",
            segunda.aplicadas
        );
        assert_eq!(segunda.last_seq, 2);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn en_un_lote_mixto_solo_salen_las_nuevas() {
        let (repo, _db, dir) = repo_temporal().await;

        repo.apply_changes(vec![cambio("op-1", 1)]).await.unwrap();

        let r = repo
            .apply_changes(vec![cambio("op-1", 1), cambio("op-2", 2)])
            .await
            .unwrap();

        assert_eq!(r.aplicadas, vec!["op-2".to_string()]);

        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests_bootstrap {
    //! Reconstrucción de la BD local desde un volcado de la nube.
    //!
    //! Lo que se comprueba aquí no es "los INSERT funcionan", es lo que hace que esto sea seguro:
    //! que reemplaza en vez de acumular, que el checkpoint queda donde dice la foto, que un
    //! volcado a medias no deja la BD a medias, y que una tabla que esta versión no conoce se
    //! informa en vez de tumbar la recuperación.

    use super::*;
    use crate::db::Db;
    use libsql::Connection;
    use serde_json::json;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{BootstrapSnapshot, BootstrapTabla};

    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        format!(
            "{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("tpv_boot_test_{}", uniq()));
        std::fs::create_dir_all(&dir).unwrap();
        // `Db::open` aplica las migraciones reales, así que se prueba contra el esquema de verdad
        // (`Zonas`) y no contra una tabla de juguete que podría no parecerse en nada.
        let db = Db::open(dir.join("data.db").to_str().unwrap())
            .await
            .unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    fn tabla(nombre: &str, filas: Vec<Vec<serde_json::Value>>) -> BootstrapTabla {
        BootstrapTabla {
            nombre: nombre.to_string(),
            columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
            filas,
        }
    }

    async fn zonas(db: &Arc<Db>) -> Vec<String> {
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query("SELECT Nombre_Zona FROM Zonas ORDER BY Nombre_Zona;", ())
            .await
            .unwrap();
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            if let Ok(Value::Text(n)) = row.get_value(0) {
                out.push(n);
            }
        }
        out
    }

    /// Restaurar REEMPLAZA. Una fila que ya estaba y no viene en la foto tiene que desaparecer: si
    /// se acumulara, la BD "recuperada" sería la mezcla de dos momentos distintos.
    #[tokio::test]
    async fn restaurar_reemplaza_lo_que_habia() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('vieja', 'Terraza vieja');",
                    (),
                )
                .await
                .unwrap();
        }

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 42,
                total_filas: 1,
                tablas: vec![tabla("Zonas", vec![vec![json!("z1"), json!("Salon")]])],
            })
            .await
            .unwrap();

        assert_eq!(zonas(&db).await, vec!["Salon".to_string()]);
        assert_eq!(r.filas_restauradas, 1);
        assert_eq!(r.seq, 42);
    }

    /// El checkpoint queda EXACTAMENTE en el `seq` de la foto: es lo que hace que el catch-up
    /// siga desde justo después, sin repetir lo que ya está ni saltarse lo que falta.
    #[tokio::test]
    async fn restaurar_deja_el_checkpoint_en_el_seq_de_la_foto() {
        let (repo, _db, _dir) = repo_temporal().await;
        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 777,
            total_filas: 0,
            tablas: vec![tabla("Zonas", vec![])],
        })
        .await
        .unwrap();

        assert_eq!(repo.get_checkpoint().await.unwrap(), 777);
    }

    /// Un volcado que falla a mitad no puede dejar la BD a medias: o entra entera o no entra nada.
    /// Aquí la segunda fila repite la clave primaria, así que el INSERT revienta después de que el
    /// DELETE previo ya se haya ejecutado.
    #[tokio::test]
    async fn un_volcado_invalido_no_deja_la_bd_a_medias() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('previa', 'Barra');",
                    (),
                )
                .await
                .unwrap();
        }

        let err = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 9,
                total_filas: 2,
                tablas: vec![tabla(
                    "Zonas",
                    vec![
                        vec![json!("dup"), json!("Uno")],
                        vec![json!("dup"), json!("Dos")],
                    ],
                )],
            })
            .await;

        assert!(err.is_err());
        // Ni el DELETE ni los INSERT deben haber quedado: la fila de antes sigue ahí.
        assert_eq!(zonas(&db).await, vec!["Barra".to_string()]);
        assert_eq!(repo.get_checkpoint().await.unwrap(), 0);
    }

    /// Una nube más nueva manda tablas que esta versión aún no tiene. Recuperar debe seguir
    /// funcionando con lo que sí conoce, y DECIR lo que se ha quedado fuera.
    #[tokio::test]
    async fn una_tabla_desconocida_se_informa_sin_romper_la_recuperacion() {
        let (repo, db, _dir) = repo_temporal().await;

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 5,
                total_filas: 1,
                tablas: vec![
                    tabla("Zonas", vec![vec![json!("z1"), json!("Salon")]]),
                    tabla("Tabla_Del_Futuro", vec![vec![json!("x"), json!("y")]]),
                ],
            })
            .await
            .unwrap();

        assert_eq!(zonas(&db).await, vec!["Salon".to_string()]);
        assert_eq!(r.tablas_restauradas, vec!["Zonas".to_string()]);
        assert_eq!(r.tablas_desconocidas, vec!["Tabla_Del_Futuro".to_string()]);
    }

    /// Los nombres del volcado se interpolan en el SQL (no se pueden enlazar con `?`), así que uno
    /// que no sea un identificador simple se descarta en vez de acabar en una sentencia.
    #[tokio::test]
    async fn un_nombre_de_tabla_con_sintaxis_se_descarta() {
        let (repo, db, _dir) = repo_temporal().await;

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 1,
                total_filas: 0,
                tablas: vec![
                    tabla("Zonas", vec![]),
                    tabla("Zonas\"; DROP TABLE Zonas; --", vec![]),
                ],
            })
            .await
            .unwrap();

        assert_eq!(r.tablas_restauradas, vec!["Zonas".to_string()]);
        assert_eq!(r.tablas_desconocidas.len(), 1);
        // La tabla sigue viva: la sentencia nunca llegó a construirse.
        assert!(zonas(&db).await.is_empty());
    }

    /// El agrupado en sentencias multi-fila tiene que dar el mismo resultado que fila a fila,
    /// incluido el caso que cruza el tope de parámetros por sentencia.
    #[tokio::test]
    async fn restaura_bien_por_encima_del_tope_de_parametros() {
        let (repo, db, _dir) = repo_temporal().await;

        let n = (MAX_PARAMS_POR_SENTENCIA / 2) + 7;
        let filas: Vec<Vec<serde_json::Value>> = (0..n)
            .map(|i| vec![json!(format!("z{i}")), json!(format!("Zona {i}"))])
            .collect();

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 3,
                total_filas: n as i64,
                tablas: vec![tabla("Zonas", filas)],
            })
            .await
            .unwrap();

        assert_eq!(r.filas_restauradas, n as i64);
        assert_eq!(zonas(&db).await.len(), n);
    }

    /// La guardia que hace que esto no pueda comerse una venta: restaurar VACÍA las tablas, así que
    /// una escritura local que todavía no ha llegado a la nube desaparecería sin dejar rastro.
    #[tokio::test]
    async fn no_restaura_si_quedan_escrituras_locales_sin_subir() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            // Un usuario: es lo que distingue una BD que ESTÁ operando —y cuyo outbox puede
            // contener una venta— de una que perdió sus datos, donde ni se puede iniciar sesión.
            // La guardia sólo protege a la primera (ver el test siguiente).
            conn.execute(
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)                  SELECT 'u1', ID_Rol, 'ana@bar.example', 'x', 'Ana' FROM Roles LIMIT 1;",
                (),
            )
            .await
            .unwrap();
            conn.execute(
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('local', 'Sin subir');",
                (),
            )
            .await
            .unwrap();
            conn.execute(
                "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
                 VALUES ('op-1', 'test', '[]', 1);",
                (),
            )
            .await
            .unwrap();
        }

        let err = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 100,
                total_filas: 0,
                tablas: vec![tabla("Zonas", vec![])],
            })
            .await;

        assert!(err.is_err(), "no puede restaurar con el outbox pendiente");
        // Y no ha tocado nada: ni la fila local ni el checkpoint.
        assert_eq!(zonas(&db).await, vec!["Sin subir".to_string()]);
        assert_eq!(repo.get_checkpoint().await.unwrap(), 0);
    }

    /// La otra cara: sin usuarios, ese mismo outbox NO puede cerrar la única salida.
    ///
    /// En una BD sin usuarios no se puede iniciar sesión, así que lo que tenga pendiente no es una
    /// venta: lo escribió algo que no debería haber escrito (el aviso de actualización lo hacía).
    /// Negarle la restauración por eso deja el equipo inservible para siempre, porque el socket no
    /// se abre mientras faltan los datos y esa operación no se puede subir jamás.
    #[tokio::test]
    async fn una_bd_sin_usuarios_restaura_aunque_le_quede_outbox() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-huerfana', 'test', '[]', 1);",
                    (),
                )
                .await
                .unwrap();
        }

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 100,
                total_filas: 1,
                tablas: vec![tabla(
                    "Zonas",
                    vec![vec![json!("z1"), json!("Terraza")]],
                )],
            })
            .await
            .unwrap();

        assert_eq!(r.filas_restauradas, 1);
        assert_eq!(zonas(&db).await, vec!["Terraza".to_string()]);
        assert_eq!(repo.get_checkpoint().await.unwrap(), 100);
    }
}
