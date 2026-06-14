//! # Manejo de conexiones a la BD local (libsql): escritor único + pool de lectura
//!
//! Sustituye al antiguo `TrackedConnection` + "puerta de transacción". La realidad física de
//! SQLite es **un solo escritor**: varias lecturas pueden ir en paralelo (modo WAL), pero las
//! escrituras se serializan a nivel de fichero. Abrazamos eso:
//!
//!   - **Escrituras / transacciones** → una ÚNICA conexión de escritura, serializada por un lock
//!     async que se mantiene durante toda la operación (incluida la transacción BEGIN..COMMIT y
//!     las lecturas intermedias que necesiten ver datos no confirmados). Como solo hay un
//!     `WriteGuard` vivo a la vez, NO hay carrera posible: desaparecen el "BEGIN dentro de BEGIN"
//!     y el problema de atribución de escrituras sueltas. Aquí vive la **captura del outbox**
//!     (antes en `recording.rs`): cada escritura confirmada se registra en `_Sync_Outbox`.
//!   - **Lecturas puras** → un **pool** de N conexiones de solo-lectura. En WAL no se bloquean
//!     entre sí ni con el escritor, así que escalan en concurrencia.
//!
//! Los repositorios piden `db.read()` (→ `ReadGuard`) en sus métodos de solo-lectura y
//! `db.write()` (→ `WriteGuard`) en los de escritura/transacción. Ambos guards implementan los
//! traits `Reader` / `Writer`, de modo que los helpers (`select_one_*`, `try_exec`, …) son
//! genéricos y los cuerpos de los métodos apenas cambian.

use std::future::Future;
use std::sync::{Arc, Mutex as StdMutex};

use libsql::{Builder, Connection, Database, Error as LibsqlError, Rows, Value};
use serde_json::json;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

use tpv_contracts::sync::SqlStatement;

/// Nombre de comando con el que viajan las operaciones de la Main a la nube. La idempotencia es
/// por `Op_Id` (uuid único), así que basta una constante estable.
const MAIN_COMMAND_NAME: &str = "main_op";

/// Nº de conexiones del pool de lectura. 4 da concurrencia de sobra para un TPV.
const READ_POOL_SIZE: usize = 4;

// ──────────────────────────────────────────────────────────────────────────────
// Parámetros aceptados por query/execute (igual que el antiguo TrackedConnection)
// ──────────────────────────────────────────────────────────────────────────────

/// Las dos formas que usan los repos: `()` (sin args) y `Vec<Value>`.
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

// ──────────────────────────────────────────────────────────────────────────────
// Traits que usan los repos y sus helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Capacidad de LECTURA. La implementan `ReadGuard` y `WriteGuard` (un método de escritura puede
/// leer sobre su propia conexión y ver lo aún no confirmado). Los helpers de solo-lectura son
/// genéricos sobre este trait.
pub trait Reader: Sync {
    fn query(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<Rows, LibsqlError>> + Send;
}

/// Capacidad de ESCRITURA (solo `WriteGuard`). `execute` captura la escritura en el outbox;
/// `execute_batch` maneja BEGIN/COMMIT/ROLLBACK agrupando la operación.
pub trait Writer: Reader {
    fn execute(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<u64, LibsqlError>> + Send;

    fn execute_batch(&self, sql: &str) -> impl Future<Output = Result<(), LibsqlError>> + Send;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers de captura (antes en recording.rs)
// ──────────────────────────────────────────────────────────────────────────────

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
    let head: String = sql
        .trim_start()
        .chars()
        .take(6)
        .collect::<String>()
        .to_ascii_uppercase();
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

/// Persiste una operación (lista de sentencias resueltas) en `_Sync_Outbox` y la auto-marca en
/// `_Sync_Applied_Ops` (anti-eco). Usa la conexión cruda (no recursivo).
async fn write_op(conn: &Connection, stmts: &[SqlStatement]) -> Result<(), LibsqlError> {
    let op_id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let statements_json = serde_json::to_string(stmts).unwrap_or_else(|_| "[]".to_string());

    conn.execute(
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

    conn.execute(
        "INSERT OR IGNORE INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, 0, ?2);",
        vec![Value::Text(op_id), Value::Integer(now)],
    )
    .await?;

    Ok(())
}

/// Ajusta una conexión recién abierta: WAL + espera ante locks + FK + durabilidad equilibrada.
/// `busy_timeout`, `foreign_keys` y `synchronous` son por conexión; `journal_mode=WAL` es de
/// fichero (persistente) pero repetirlo es inocuo.
///
/// Se ejecutan vía `query` (no `execute_batch`): algunas PRAGMA (`journal_mode`, `busy_timeout`)
/// DEVUELVEN una fila con el valor resultante incluso al fijarlas, y enrutarlas por la vía de
/// `execute` dispara `Execute returned rows` en libsql. `query` acepta sentencias que devuelven
/// filas (las descartamos) y también las que no.
async fn tune(conn: &Connection) -> Result<(), LibsqlError> {
    for pragma in [
        "PRAGMA journal_mode = WAL;",
        "PRAGMA busy_timeout = 5000;",
        "PRAGMA foreign_keys = ON;",
        "PRAGMA synchronous = NORMAL;",
    ] {
        let _ = conn.query(pragma, ()).await?;
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// Pool de lectura
// ──────────────────────────────────────────────────────────────────────────────

struct ReadPool {
    /// Conexiones disponibles (pila). Mutex SÍNCRONO: solo push/pop instantáneos, sin await.
    free: StdMutex<Vec<Arc<Connection>>>,
    /// Limita el nº de conexiones prestadas a la vez (= capacidad del pool).
    sem: Arc<Semaphore>,
}

impl ReadPool {
    fn new(conns: Vec<Arc<Connection>>) -> Self {
        let n = conns.len();
        Self {
            free: StdMutex::new(conns),
            sem: Arc::new(Semaphore::new(n)),
        }
    }

    async fn acquire(self: &Arc<Self>) -> ReadGuard {
        let permit = self
            .sem
            .clone()
            .acquire_owned()
            .await
            .expect("el semáforo del pool de lectura no se cierra");
        let conn = self
            .free
            .lock()
            .expect("mutex del pool de lectura envenenado")
            .pop()
            .expect("invariante del pool: hay tantas conexiones libres como permisos");
        ReadGuard {
            conn: Some(conn),
            pool: self.clone(),
            _permit: permit,
        }
    }
}

/// Conexión de solo-lectura prestada del pool. Al soltarse, vuelve al pool.
pub struct ReadGuard {
    conn: Option<Arc<Connection>>,
    pool: Arc<ReadPool>,
    _permit: OwnedSemaphorePermit,
}

impl ReadGuard {
    /// Conexión cruda (para helpers que ya toman `&Connection`, si hiciera falta).
    pub fn conn(&self) -> &Connection {
        self.conn.as_ref().expect("read guard con conexión")
    }
}

impl Drop for ReadGuard {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            if let Ok(mut free) = self.pool.free.lock() {
                free.push(conn);
            }
        }
        // El permiso se libera al soltar `_permit`.
    }
}

impl Reader for ReadGuard {
    fn query(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<Rows, LibsqlError>> + Send {
        let conn = self.conn.as_ref().expect("read guard con conexión").clone();
        let values = params.into_values();
        async move { conn.query(sql, values).await }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Escritor único (conexión de escritura serializada + captura del outbox)
// ──────────────────────────────────────────────────────────────────────────────

struct WriteConn {
    conn: Arc<Connection>,
    /// Serializa a TODO escritor: solo un `WriteGuard` vivo a la vez.
    lock: Mutex<()>,
}

/// Acceso EXCLUSIVO a la conexión de escritura, retenido durante toda una operación/transacción.
/// Implementa `Writer` (y `Reader`): los repos lo usan igual que la antigua `Connection`.
pub struct WriteGuard<'a> {
    conn: &'a Arc<Connection>,
    /// Buffer de la transacción en curso (Some entre BEGIN y COMMIT/ROLLBACK). Es LOCAL a este
    /// guard (solo hay uno vivo), así que no hay estado global compartido ni carreras.
    tx_buf: Mutex<Option<Vec<SqlStatement>>>,
    _lock: tokio::sync::MutexGuard<'a, ()>,
}

impl<'a> WriteGuard<'a> {
    /// Conexión cruda de escritura (sin captura): la usa el aplicador nube→Main para aplicar
    /// cambios remotos sin re-encolarlos en el outbox, manteniendo igualmente la exclusión.
    pub fn raw(&self) -> &Arc<Connection> {
        self.conn
    }

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
                write_op(self.conn, std::slice::from_ref(&stmt)).await
            }
        }
    }
}

impl<'a> Reader for WriteGuard<'a> {
    fn query(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<Rows, LibsqlError>> + Send {
        let conn = self.conn.clone();
        let values = params.into_values();
        async move { conn.query(sql, values).await }
    }
}

impl<'a> Writer for WriteGuard<'a> {
    fn execute(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<u64, LibsqlError>> + Send {
        let values = params.into_values();
        async move {
            let affected = self.conn.execute(sql, values.clone()).await?;
            if is_write_sql(sql) {
                self.capture_write(sql, &values).await?;
            }
            Ok(affected)
        }
    }

    fn execute_batch(&self, sql: &str) -> impl Future<Output = Result<(), LibsqlError>> + Send {
        let sql = sql.to_string();
        async move {
            match batch_kind(&sql) {
                BatchKind::Begin => {
                    *self.tx_buf.lock().await = Some(Vec::new());
                    self.conn.execute_batch(&sql).await
                }
                BatchKind::Commit => {
                    let buffered = self.tx_buf.lock().await.take();
                    // Registrar la operación en el outbox DENTRO de la misma transacción (BEGIN
                    // ya enviado, COMMIT no aún). La captura es incondicional: el outbox acumula
                    // también en offline y se drena al activar online.
                    let mut pre: Result<(), LibsqlError> = Ok(());
                    if let Some(stmts) = buffered {
                        if !stmts.is_empty() {
                            pre = write_op(self.conn, &stmts).await;
                        }
                    }
                    match pre {
                        Ok(()) => self.conn.execute_batch(&sql).await,
                        Err(e) => {
                            // No se pudo registrar el outbox: abortar para no confirmar a medias.
                            let _ = self.conn.execute_batch("ROLLBACK;").await;
                            Err(e)
                        }
                    }
                }
                BatchKind::Rollback => {
                    *self.tx_buf.lock().await = None;
                    self.conn.execute_batch(&sql).await
                }
                BatchKind::Other => self.conn.execute_batch(&sql).await,
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Facade Db
// ──────────────────────────────────────────────────────────────────────────────

/// Punto de entrada a la BD local: presta `read()` (pool) o `write()` (escritor único).
pub struct Db {
    write: WriteConn,
    reads: Arc<ReadPool>,
    /// Mantiene viva la `Database` mientras existan conexiones derivadas.
    _database: Database,
}

impl Db {
    /// Abre la BD local en `path`, aplica `schema` y crea las tablas de control, y monta el
    /// escritor único + el pool de lectura (todas las conexiones afinadas: WAL, etc.). El seed
    /// (admin inicial) lo hace el llamador con un `write()` guard tras abrir.
    pub async fn open(path: &str, schema: &str) -> Result<Arc<Db>, LibsqlError> {
        let database = Builder::new_local(path).build().await?;

        // Conexión de escritura: afinar, aplicar schema y crear tablas de control.
        let write_conn = Arc::new(database.connect()?);
        tune(&write_conn).await?;
        write_conn.execute_batch(schema).await?;
        init_sync_tables(&write_conn).await?;

        // Pool de lectura.
        let mut read_conns = Vec::with_capacity(READ_POOL_SIZE);
        for _ in 0..READ_POOL_SIZE {
            let c = Arc::new(database.connect()?);
            tune(&c).await?;
            read_conns.push(c);
        }

        Ok(Arc::new(Db {
            write: WriteConn {
                conn: write_conn,
                lock: Mutex::new(()),
            },
            reads: Arc::new(ReadPool::new(read_conns)),
            _database: database,
        }))
    }

    /// Presta una conexión de solo-lectura del pool (espera si están todas en uso).
    pub async fn read(&self) -> ReadGuard {
        self.reads.acquire().await
    }

    /// Toma acceso EXCLUSIVO a la conexión de escritura (espera a que termine la operación en
    /// curso). Mantén el guard vivo durante toda la transacción.
    pub async fn write(&self) -> WriteGuard<'_> {
        let lock = self.write.lock.lock().await;
        WriteGuard {
            conn: &self.write.conn,
            tx_buf: Mutex::new(None),
            _lock: lock,
        }
    }
}

/// Crea (idempotente) las tablas de control de la sincronización.
async fn init_sync_tables(conn: &Connection) -> Result<(), LibsqlError> {
    conn.execute_batch(
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
