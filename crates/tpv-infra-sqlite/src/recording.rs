//! # Capa de captura de escrituras (outbox Main → nube)
//!
//! `TrackedConnection` envuelve la `libsql::Connection` local con la **misma API** que usan los
//! repositorios (`query` / `execute` / `execute_batch`), de modo que se interpone con solo un
//! alias de import por archivo (`use crate::recording::TrackedConnection as Connection;`), sin
//! tocar firmas ni cuerpos.
//!
//! La captura está **SIEMPRE activa** (también en modo "offline"): el `_Sync_Outbox` es el *log de
//! cambios* local de la Main. Mientras se está offline, las operaciones se acumulan; al activar
//! "online", el WebSocket de la Main las drena en orden a la nube. Así, todo lo que pase en la Main
//! —creates, updates **y borrados**— sube tal cual cuando hay conexión, sin perder nada de lo hecho
//! sin red. Registra cada **escritura** (`INSERT/UPDATE/DELETE/REPLACE`) con sus argumentos **ya
//! resueltos** y agrupa por operación:
//!   - Entre `BEGIN;` y `COMMIT;` (vía `execute_batch`) acumula un buffer y, **dentro de la misma
//!     transacción**, vuelca la operación a `_Sync_Outbox` justo antes de confirmar. Así la
//!     operación se registra si y solo si la escritura se confirmó.
//!   - Una escritura suelta (sin transacción) se registra como operación de una sentencia.
//!
//! Además marca el `op_id` propio en `_Sync_Applied_Ops` (anti-eco): cuando la nube reaplique y
//! lo reenvíe por el catch-up, la Main lo saltará en vez de duplicarlo.
//!
//! El aplicador nube→Main (`SqliteSyncRepository`) usa la conexión **cruda** (`raw()`), así que
//! aplicar cambios remotos NO se vuelve a capturar.

use std::sync::Arc;

use libsql::{Connection, Error as LibsqlError, Rows, Value};
use serde_json::json;
use tokio::sync::{Mutex, OwnedMutexGuard};

use tpv_contracts::sync::SqlStatement;

/// Nombre de comando con el que viajan las operaciones de la Main a la nube. La idempotencia es
/// por `Op_Id` (uuid único), así que basta una constante estable.
const MAIN_COMMAND_NAME: &str = "main_op";

/// Parámetros aceptados por `query`/`execute` (las dos formas que usan los repos: `()` y
/// `Vec<Value>`). Devuelve los valores para (a) ejecutar contra libsql y (b) capturarlos.
pub trait Bindable {
    fn into_values(self) -> Vec<Value>;
}
impl Bindable for Vec<Value> {
    fn into_values(self) -> Vec<Value> {
        self
    }
}
impl Bindable for () {
    fn into_values(self) -> Vec<Value> {
        Vec::new()
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn value_to_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Integer(i) => json!(i),
        Value::Real(f) => json!(f),
        Value::Text(s) => json!(s),
        Value::Blob(_) => serde_json::Value::Null, // los blobs no se sincronizan (v1)
    }
}

fn is_write_sql(sql: &str) -> bool {
    let t = sql.trim_start();
    let head: String = t.chars().take(6).collect::<String>().to_ascii_uppercase();
    head.starts_with("INSERT")
        || head.starts_with("UPDATE")
        || head.starts_with("DELETE")
        || head.starts_with("REPLAC")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BatchKind {
    Begin,
    Commit,
    Rollback,
    Other,
}

fn batch_kind(sql: &str) -> BatchKind {
    let head: String = sql
        .trim_start()
        .chars()
        .take(8)
        .collect::<String>()
        .to_ascii_uppercase();
    if head.starts_with("BEGIN") {
        BatchKind::Begin
    } else if head.starts_with("COMMIT") {
        BatchKind::Commit
    } else if head.starts_with("ROLLBACK") {
        BatchKind::Rollback
    } else {
        BatchKind::Other
    }
}

/// Conexión local con captura de escrituras para el outbox de sincronización.
pub struct TrackedConnection {
    inner: Arc<Connection>,
    /// Buffer de la transacción en curso (Some entre BEGIN y COMMIT/ROLLBACK).
    tx_buf: Mutex<Option<Vec<SqlStatement>>>,
    /// **Puerta de transacción.** La conexión libsql es ÚNICA y compartida por todos los
    /// repositorios y por el aplicador nube→Main. SQLite no admite `BEGIN` dentro de `BEGIN`:
    /// si dos transacciones (p. ej. `save_layout` y el aplicador de sync) emiten `BEGIN` a la
    /// vez sobre la misma conexión, la segunda falla con
    /// "cannot start a transaction within a transaction". Esta puerta serializa cada
    /// transacción (BEGIN..COMMIT/ROLLBACK) en la conexión. El aplicador de sync adquiere la
    /// MISMA puerta (vía `tx_gate()`), así que tampoco colisiona con las transacciones de los
    /// repos.
    tx_gate: Arc<Mutex<()>>,
    /// Guard de la transacción en curso (lo retiene quien hizo BEGIN hasta COMMIT/ROLLBACK).
    tx_guard: Mutex<Option<OwnedMutexGuard<()>>>,
}

impl TrackedConnection {
    pub fn new(inner: Arc<Connection>) -> Self {
        Self {
            inner,
            tx_buf: Mutex::new(None),
            tx_gate: Arc::new(Mutex::new(())),
            tx_guard: Mutex::new(None),
        }
    }

    /// Conexión cruda (sin captura): la usa el aplicador nube→Main para no re-encolar ecos.
    pub fn raw(&self) -> Arc<Connection> {
        self.inner.clone()
    }

    /// Puerta de transacción compartida (ver `tx_gate`). El aplicador nube→Main la adquiere
    /// alrededor de su propio BEGIN..COMMIT para serializarse con las transacciones de los repos.
    pub fn tx_gate(&self) -> Arc<Mutex<()>> {
        self.tx_gate.clone()
    }

    /// Crea (idempotente) las tablas de control de la sincronización. Se llama una vez al
    /// inicializar la BD, en contexto async, para no hacer DDL dentro de las transacciones.
    pub async fn init_sync_tables(&self) -> Result<(), LibsqlError> {
        self.inner
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS _Sync_Outbox (
                    Seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    Op_Id TEXT NOT NULL UNIQUE,
                    Command_Name TEXT NOT NULL,
                    Statements_Json TEXT NOT NULL,
                    Created_At_Ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS _Sync_Applied_Ops (
                    Op_Id TEXT PRIMARY KEY,
                    Seq INTEGER NOT NULL,
                    Applied_At_Ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS _Sync_State (
                    Id INTEGER PRIMARY KEY CHECK (Id = 1),
                    Last_Seq INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO _Sync_State (Id, Last_Seq) VALUES (1, 0);
                "#,
            )
            .await
            .map(|_| ())
    }

    // ── API espejo de libsql::Connection (lo que usan los repos) ─────────────────────────────

    pub async fn query(&self, sql: &str, params: impl Bindable) -> Result<Rows, LibsqlError> {
        self.inner.query(sql, params.into_values()).await
    }

    pub async fn execute(&self, sql: &str, params: impl Bindable) -> Result<u64, LibsqlError> {
        let values = params.into_values();
        let affected = self.inner.execute(sql, values.clone()).await?;
        if is_write_sql(sql) {
            self.capture_write(sql, &values).await?;
        }
        Ok(affected)
    }

    pub async fn execute_batch(&self, sql: &str) -> Result<(), LibsqlError> {
        match batch_kind(sql) {
            BatchKind::Begin => {
                // Adquirir la puerta ANTES de emitir BEGIN: si otra transacción (o el aplicador
                // de sync) está en curso, esperamos a que termine en vez de chocar con un
                // "transaction within a transaction".
                let guard = self.tx_gate.clone().lock_owned().await;
                *self.tx_buf.lock().await = Some(Vec::new());
                match self.inner.execute_batch(sql).await {
                    Ok(_) => {
                        *self.tx_guard.lock().await = Some(guard);
                        Ok(())
                    }
                    Err(e) => {
                        // BEGIN falló: no hay transacción abierta, soltamos buffer y puerta.
                        *self.tx_buf.lock().await = None;
                        drop(guard);
                        Err(e)
                    }
                }
            }
            BatchKind::Commit => {
                let buffered = self.tx_buf.lock().await.take();
                // Registrar la operación en el outbox DENTRO de la misma transacción (BEGIN ya
                // enviado, COMMIT no aún). La captura es incondicional: el outbox acumula también
                // en offline y se drena al activar online.
                let mut pre: Result<(), LibsqlError> = Ok(());
                if let Some(stmts) = buffered {
                    if !stmts.is_empty() {
                        pre = self.write_op(&stmts).await;
                    }
                }
                let res = match pre {
                    Ok(()) => self.inner.execute_batch(sql).await.map(|_| ()),
                    Err(e) => {
                        // No se pudo registrar el outbox: abortar para no confirmar a medias.
                        let _ = self.inner.execute_batch("ROLLBACK;").await;
                        Err(e)
                    }
                };
                // Soltar la puerta pase lo que pase (la transacción ya quedó cerrada).
                *self.tx_guard.lock().await = None;
                res
            }
            BatchKind::Rollback => {
                *self.tx_buf.lock().await = None;
                let res = self.inner.execute_batch(sql).await.map(|_| ());
                *self.tx_guard.lock().await = None;
                res
            }
            BatchKind::Other => self.inner.execute_batch(sql).await.map(|_| ()),
        }
    }

    // ── Captura ──────────────────────────────────────────────────────────────────────────────

    async fn capture_write(&self, sql: &str, values: &[Value]) -> Result<(), LibsqlError> {
        let stmt = SqlStatement {
            sql: sql.to_string(),
            args: values.iter().map(value_to_json).collect(),
        };

        let mut buf = self.tx_buf.lock().await;
        match buf.as_mut() {
            Some(v) => {
                // Dentro de transacción: acumular; se vuelca en el COMMIT.
                v.push(stmt);
                Ok(())
            }
            None => {
                // Escritura suelta (autocommit): operación de una sola sentencia.
                drop(buf);
                self.write_op(std::slice::from_ref(&stmt)).await
            }
        }
    }

    /// Persiste una operación en `_Sync_Outbox` y la auto-marca en `_Sync_Applied_Ops` (anti-eco).
    /// Usa la conexión cruda (no recursivo). En el caso COMMIT corre dentro de la transacción
    /// abierta; en el caso suelto es un autocommit aparte (ventana de no-atomicidad mínima).
    async fn write_op(&self, stmts: &[SqlStatement]) -> Result<(), LibsqlError> {
        let op_id = uuid::Uuid::new_v4().to_string();
        let now = now_ms();
        let statements_json = serde_json::to_string(stmts).unwrap_or_else(|_| "[]".to_string());

        self.inner
            .execute(
                "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
                 VALUES (?1, ?2, ?3, ?4);",
                vec![
                    Value::Text(op_id.clone()),
                    Value::Text(MAIN_COMMAND_NAME.to_string()),
                    Value::Text(statements_json),
                    Value::Integer(now),
                ],
            )
            .await?;

        self.inner
            .execute(
                "INSERT OR IGNORE INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) \
                 VALUES (?1, 0, ?2);",
                vec![Value::Text(op_id), Value::Integer(now)],
            )
            .await?;

        Ok(())
    }
}
