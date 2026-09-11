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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

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
        // Reloj corrupto (antes de epoch): i64::MAX evita que las entradas del outbox aparezcan
        // "muy antiguas" y sean eliminadas prematuramente por lógica de purga.
        .unwrap_or(i64::MAX)
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

/// Sustituye en una sentencia **a replicar** las funciones de tiempo NO deterministas por el
/// instante local del dispositivo ya resuelto a literal. Imprescindible para la replicación a
/// nivel de sentencia: si la SQL viajara con `datetime('now')`, la nube (y un re-apply) la
/// reevaluarían en otro instante/zona y la fila divergiría entre Main, nube y Handy.
///
/// Solo toca las formas exactas `datetime('now','localtime')` y `date('now','localtime')`. No son
/// subcadena de las variantes con modificador (`…,'localtime','-2 days')`), que acaban en `,'…')`,
/// así que el reemplazo literal es seguro y no las corrompe. La ejecución local ya ocurrió con la
/// hora real del motor; aquí solo se ajusta la copia que se captura para el outbox.
fn rewrite_now_literals(sql: &str) -> String {
    if !sql.contains("('now'") {
        return sql.to_string();
    }
    let dt = crate::util::now_local_datetime();
    let d = crate::util::now_local_date();
    sql.replace("datetime('now','localtime')", &format!("'{dt}'"))
        .replace("date('now','localtime')", &format!("'{d}'"))
}

/// Las ÚNICAS formas de "hora actual" admitidas en SQL replicable: las que
/// `rewrite_now_literals` (Main) y `resolveNowLiterals` (worker) saben resolver a literal.
const ALLOWED_NOW_FORMS: [&str; 2] = ["datetime('now','localtime')", "date('now','localtime')"];

/// Detecta una fuente de tiempo NO determinista en `sql` que NO esté cubierta por
/// `rewrite_now_literals`. Devuelve el token infractor, o `None` si el SQL replicable es seguro.
///
/// Motivación (DB-15): `rewrite_now_literals` solo resuelve las dos formas canónicas. Cualquier otra
/// (`datetime('now')` sin `localtime`, con modificadores `…,'-2 days'`, `strftime(…,'now')`,
/// `julianday('now')`, `CURRENT_TIMESTAMP/DATE/TIME`) viajaría SIN resolver y la nube (o un re-apply)
/// la reevaluaría en otro instante/zona → la fila divergiría. Restringimos a UNA forma canónica.
///
/// Se descuentan primero las formas permitidas; lo que quede con `'now'` o `CURRENT_*` es un fallo.
/// Nota: los modificadores (`datetime('now','localtime','-2 days')`) NO contienen la forma canónica
/// como subcadena (acaban en `,'…')`, no en `)`), así que se detectan igual.
fn uncovered_time_source(sql: &str) -> Option<&'static str> {
    let mut stripped = sql.to_string();
    for form in ALLOWED_NOW_FORMS {
        stripped = stripped.replace(form, "");
    }
    ["'now'", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"]
        .into_iter()
        .find(|pat| stripped.contains(pat))
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
pub(crate) async fn tune(conn: &Connection) -> Result<(), LibsqlError> {
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

/// Callback que el shell Tauri inyecta para avisar de que hay una operación nueva en el outbox
/// (escritura local confirmada). Permite drenar la nube AL INSTANTE en vez de esperar al poll.
/// Se mantiene fuera del crate (no hay dependencia de Tauri aquí): el shell pasa el cierre.
type OutboxNotify = Arc<OnceLock<Box<dyn Fn() + Send + Sync>>>;

/// Acceso EXCLUSIVO a la conexión de escritura, retenido durante toda una operación/transacción.
/// Implementa `Writer` (y `Reader`): los repos lo usan igual que la antigua `Connection`.
pub struct WriteGuard<'a> {
    conn: &'a Arc<Connection>,
    /// Cerrojo de las escrituras de NEGOCIO mientras la base no está operativa (ver
    /// [`Db::bloquear_escrituras_de_negocio`]). No afecta a `raw()`.
    bloqueadas: &'a AtomicBool,
    /// Buffer de la transacción en curso (Some entre BEGIN y COMMIT/ROLLBACK). Es LOCAL a este
    /// guard (solo hay uno vivo), así que no hay estado global compartido ni carreras.
    tx_buf: Mutex<Option<Vec<SqlStatement>>>,
    /// Notificador del outbox (ver `OutboxNotify`). Se dispara tras confirmar la operación.
    outbox_notify: OutboxNotify,
    _lock: tokio::sync::MutexGuard<'a, ()>,
}

impl<'a> WriteGuard<'a> {
    /// Conexión cruda de escritura (sin captura): la usa el aplicador nube→Main para aplicar
    /// cambios remotos sin re-encolarlos en el outbox, manteniendo igualmente la exclusión.
    pub fn raw(&self) -> &Arc<Connection> {
        self.conn
    }

    /// Avisa (si hay notificador inyectado) de que el outbox tiene una operación nueva confirmada.
    fn fire_outbox_notify(&self) {
        if let Some(cb) = self.outbox_notify.get() {
            cb();
        }
    }

    /// Construye la copia REPLICABLE de una escritura: el tiempo resuelto a literal (determinismo)
    /// y los args serializados a JSON. La ejecución local conserva su `datetime('now')` real; aquí
    /// solo se prepara lo que viajará al outbox.
    fn build_stmt(&self, sql: &str, values: &[Value]) -> SqlStatement {
        // Guard (DB-15): una escritura replicable NUNCA debe llevar una fuente de tiempo no
        // determinista fuera de las dos formas canónicas (ver `uncovered_time_source`). En debug
        // revienta para cazar el error en desarrollo/tests; en release no penaliza.
        debug_assert!(
            uncovered_time_source(sql).is_none(),
            "SQL replicable con hora no determinista sin cubrir por rewrite_now_literals \
             (usa datetime('now','localtime') o date('now','localtime')): {sql}"
        );
        SqlStatement {
            sql: rewrite_now_literals(sql),
            args: values.iter().map(value_to_json).collect(),
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
            // Sentencias que no capturamos (no son escritura replicable): directas.
            if !is_write_sql(sql) {
                return self.conn.execute(sql, values).await;
            }

            // Base a medio recuperar: ninguna escritura de negocio puede entrar. Toda escritura
            // que pase por aquí acaba en `_Sync_Outbox`, y con la BD en recuperación el outbox no
            // se puede drenar (el socket está parado) NI se puede ignorar (bloquea la
            // restauración). Una sola operación aquí deja el equipo sin ninguna salida.
            //
            // Se rechaza en vez de dejarla pasar en silencio: quien escriba tiene que enterarse.
            // La maquinaria de la recuperación no se ve afectada porque va toda por `raw()`.
            if self.bloqueadas.load(Ordering::Relaxed) {
                return Err(LibsqlError::Misuse(
                    "Este equipo está recuperando sus datos: no admite escrituras todavía."
                        .to_string(),
                ));
            }

            let mut buf = self.tx_buf.lock().await;
            match buf.as_mut() {
                Some(v) => {
                    // Dentro de una transacción (BEGIN..COMMIT): ejecutamos el negocio y
                    // ACUMULAMOS la captura en el buffer; se vuelca en el COMMIT dentro de la
                    // misma transacción → ya es atómico (negocio + outbox commitean juntos).
                    let affected = self.conn.execute(sql, values.clone()).await?;
                    v.push(self.build_stmt(sql, &values));
                    Ok(affected)
                }
                None => {
                    // Escritura suelta (autocommit). SYNC-02: envolvemos la escritura de negocio
                    // Y su registro en el outbox (`write_op`) en UNA sola transacción, para que un
                    // crash entre ambas no deje la fila escrita sin su entrada en el outbox (que
                    // nunca se replicaría). Todo o nada.
                    drop(buf);
                    let stmt = self.build_stmt(sql, &values);
                    self.conn.execute_batch("BEGIN;").await?;
                    let res: Result<u64, LibsqlError> = async {
                        let affected = self.conn.execute(sql, values.clone()).await?;
                        write_op(self.conn, std::slice::from_ref(&stmt)).await?;
                        Ok(affected)
                    }
                    .await;
                    match res {
                        Ok(affected) => {
                            self.conn.execute_batch("COMMIT;").await?;
                            // Outbox confirmado (autocommit): drenar la nube ya.
                            self.fire_outbox_notify();
                            Ok(affected)
                        }
                        Err(e) => {
                            let _ = self.conn.execute_batch("ROLLBACK;").await;
                            Err(e)
                        }
                    }
                }
            }
        }
    }

    fn execute_batch(&self, sql: &str) -> impl Future<Output = Result<(), LibsqlError>> + Send {
        let sql = sql.to_string();
        async move {
            match batch_kind(&sql) {
                BatchKind::Begin => {
                    *self.tx_buf.lock().await = Some(Vec::new());
                    // libsql 0.9 devuelve `BatchRows` (las filas de cada sentencia del lote). Aquí
                    // no interesan: `execute_batch` se usa para DDL y control de transacción.
                    self.conn.execute_batch(&sql).await.map(|_| ())
                }
                BatchKind::Commit => {
                    let buffered = self.tx_buf.lock().await.take();
                    let had_writes = buffered.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
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
                        Ok(()) => {
                            let r = self.conn.execute_batch(&sql).await.map(|_| ());
                            // Solo tras confirmar el COMMIT y si hubo escrituras: drenar la nube ya.
                            if r.is_ok() && had_writes {
                                self.fire_outbox_notify();
                            }
                            r
                        }
                        Err(e) => {
                            // No se pudo registrar el outbox: abortar para no confirmar a medias.
                            let _ = self.conn.execute_batch("ROLLBACK;").await;
                            Err(e)
                        }
                    }
                }
                BatchKind::Rollback => {
                    *self.tx_buf.lock().await = None;
                    self.conn.execute_batch(&sql).await.map(|_| ())
                }
                BatchKind::Other => self.conn.execute_batch(&sql).await.map(|_| ()),
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
    /// Notificador del outbox (lo inyecta el shell con `set_outbox_notifier`). Compartido (Arc)
    /// con cada `WriteGuard` para dispararlo tras confirmar una operación.
    outbox_notify: OutboxNotify,
    /// Escrituras de negocio bloqueadas: la base no está en condiciones de generar operaciones
    /// nuevas (le faltan los datos, o está restaurada y aún sin reconciliar).
    escrituras_bloqueadas: AtomicBool,
    /// Mantiene viva la `Database` mientras existan conexiones derivadas.
    _database: Database,
}

impl Db {
    /// Abre la BD local en `path`, construye/actualiza el esquema aplicando las migraciones
    /// embebidas, crea las tablas de control y monta el escritor único + el pool de lectura (todas
    /// las conexiones afinadas: WAL, etc.). El seed (admin inicial) lo hace el llamador con un
    /// `write()` guard tras abrir.
    pub async fn open(path: &str) -> Result<Arc<Db>, Box<dyn std::error::Error + Send + Sync>> {
        let database = Builder::new_local(path).build().await?;

        // Conexión de escritura: afinar, construir el esquema y crear tablas de control.
        let write_conn = Arc::new(database.connect()?);
        tune(&write_conn).await?;

        // Esquema = migraciones embebidas (ya no hay schema.sql). Construye desde cero en BDs
        // nuevas y pone al día las existentes. Ver `migrations.rs`.
        //
        // Aquí ya NO se crea nada más a mano. El andamiaje local del dispositivo (`_Sync_*`,
        // `_Jobs_State`, `_Verifactu_*`, `_Recovery_State`, `_Backfill_Historico`) vive en §16 del
        // `0001`, con el resto del esquema: dos funciones que creaban tablas por su cuenta eran un
        // segundo esquema, sin versión, sin hash y fuera del snapshot anti-drift.
        crate::migrations::run(&write_conn).await?;

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
            outbox_notify: Arc::new(OnceLock::new()),
            // Por defecto abierta: lo decide quien conoce el estado de recuperación
            // (`connection::init_main_db`), no el constructor genérico.
            escrituras_bloqueadas: AtomicBool::new(false),
            _database: database,
        }))
    }

    /// Inyecta (una vez) el callback que se dispara cuando una escritura local confirma una
    /// operación en el outbox. El shell Tauri lo usa para emitir un evento y drenar la nube al
    /// instante. Idempotente: una segunda llamada se ignora.
    pub fn set_outbox_notifier(&self, cb: impl Fn() + Send + Sync + 'static) {
        let _ = self.outbox_notify.set(Box::new(cb));
    }

    /// Cierra (o reabre) el paso a las escrituras de NEGOCIO —las que se capturan en el outbox—
    /// mientras la base no está operativa: sin usuarios (datos perdidos) o restaurada y todavía sin
    /// reconciliar.
    ///
    /// Existe porque la regla "durante una recuperación no se escribe" vivía sólo en el gating de
    /// los jobs (`Requiere::MainOperativa`), y cualquier comando se la saltaba: bastó una
    /// notificación de "actualización disponible" para dejar un equipo sin poder restaurar. Aquí
    /// pasa **toda** escritura replicable, así que la regla deja de depender de que alguien se
    /// acuerde de aplicarla.
    ///
    /// No afecta a `WriteGuard::raw()`: las tablas de control y la propia restauración van por ahí.
    pub fn bloquear_escrituras_de_negocio(&self, bloqueadas: bool) {
        self.escrituras_bloqueadas.store(bloqueadas, Ordering::Relaxed);
    }

    pub fn escrituras_de_negocio_bloqueadas(&self) -> bool {
        self.escrituras_bloqueadas.load(Ordering::Relaxed)
    }

    /// Presta una conexión de solo-lectura del pool (espera si están todas en uso).
    pub async fn read(&self) -> ReadGuard {
        self.reads.acquire().await
    }

    /// Toma acceso EXCLUSIVO a la conexión de escritura (espera a que termine la operación en
    /// curso). Mantén el guard vivo durante toda la transacción.
    pub async fn write(&self) -> WriteGuard<'_> {
        let lock = self.write.lock.lock().await;
        // Red de seguridad: la conexión de escritura es ÚNICA y compartida entre operaciones.
        // Si una operación previa dejó una transacción abierta (un COMMIT que falló, un lock por
        // `busy_timeout`, o un panic que saltó el COMMIT/ROLLBACK explícito), la conexión queda
        // "envenenada" y todo `BEGIN` posterior revienta con "cannot start a transaction within a
        // transaction". `WriteGuard::Drop` no puede hacer rollback (es síncrono), así que lo
        // saneamos aquí: si no estamos en autocommit, hay una transacción colgada → la abortamos
        // para arrancar limpios.
        if !self.write.conn.is_autocommit() {
            let _ = self.write.conn.execute_batch("ROLLBACK;").await;
        }
        WriteGuard {
            conn: &self.write.conn,
            bloqueadas: &self.escrituras_bloqueadas,
            tx_buf: Mutex::new(None),
            outbox_notify: self.outbox_notify.clone(),
            _lock: lock,
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests: determinismo temporal de las sentencias replicables (DB-15)
// ──────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_now_literals_resuelve_formas_canonicas() {
        // Tras reescribir, no debe quedar ninguna fuente de tiempo sin resolver.
        let sql =
            "INSERT INTO T (a,b) VALUES (datetime('now','localtime'), date('now','localtime'));";
        let out = rewrite_now_literals(sql);
        assert!(
            !out.contains("'now'"),
            "las formas canónicas deben quedar resueltas: {out}"
        );
        assert!(uncovered_time_source(&out).is_none());
    }

    #[test]
    fn uncovered_time_source_acepta_solo_formas_canonicas() {
        // Permitidas.
        assert!(uncovered_time_source("SET x = datetime('now','localtime')").is_none());
        assert!(uncovered_time_source("SET x = date('now','localtime')").is_none());
        // Literales de texto normales no son 'now'.
        assert!(
            uncovered_time_source("Estado = 'Abierta', T = datetime('now','localtime')").is_none()
        );
        // julianday/strftime sobre PARÁMETROS (no 'now') son deterministas → permitidos.
        assert!(uncovered_time_source(
            "CAST(julianday(date(?2)) - julianday(date(?1)) AS INTEGER)"
        )
        .is_none());

        // Prohibidas (divergirían al replicar).
        assert_eq!(
            uncovered_time_source("VALUES (datetime('now'))"),
            Some("'now'")
        );
        assert_eq!(
            uncovered_time_source("datetime('now','localtime','-2 days')"),
            Some("'now'"),
            "las variantes con modificador NO están cubiertas por rewrite_now_literals"
        );
        assert_eq!(uncovered_time_source("strftime('%H','now')"), Some("'now'"));
        assert_eq!(uncovered_time_source("julianday('now')"), Some("'now'"));
        assert_eq!(
            uncovered_time_source("SET T = CURRENT_TIMESTAMP"),
            Some("CURRENT_TIMESTAMP")
        );
    }

    fn collect_commands_ts(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    collect_commands_ts(&p, out);
                } else if p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.ends_with(".commands.ts"))
                    .unwrap_or(false)
                {
                    out.push(p);
                }
            }
        }
    }

    /// DB-15 (lado worker): los `*.commands.ts` construyen las sentencias REPLICABLES de la nube.
    /// Deben usar SOLO las dos formas canónicas para la hora actual (las únicas que resuelve
    /// `resolveNowLiterals` en el worker, espejo de `rewrite_now_literals`). Este scan lo garantiza
    /// desde el harness de Rust (el worker no tiene runner de tests propio).
    #[test]
    fn worker_commands_solo_usan_formas_canonicas_de_now() {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/cloud-worker-licensing/src/domains");
        assert!(
            base.exists(),
            "No se encontró {base:?}. Si el layout del worker cambió, actualiza la ruta del test."
        );

        let mut files = Vec::new();
        collect_commands_ts(&base, &mut files);
        assert!(
            !files.is_empty(),
            "No se encontró ningún *.commands.ts bajo {base:?}: el scan no cubriría nada."
        );

        let mut violations = Vec::new();
        for f in &files {
            let content = std::fs::read_to_string(f).unwrap();
            for (i, line) in content.lines().enumerate() {
                if let Some(tok) = uncovered_time_source(line) {
                    violations.push(format!("{}:{} → {tok}", f.display(), i + 1));
                }
            }
        }
        assert!(
            violations.is_empty(),
            "Sentencias replicables (*.commands.ts) deben usar SOLO datetime('now','localtime') o \
             date('now','localtime') para la hora actual. Violaciones:\n{}",
            violations.join("\n")
        );
    }

    // ── SYNC-11: contrato de los pasos `value` ─────────────────────────────────────────────────
    // `evalValueStep` (worker) evalúa en JS un set CERRADO de 3 formas. Este mirror + scan garantiza
    // que ningún `*.commands.ts` introduzca una forma de `value` que la nube no sepa evaluar (lo que
    // rompería la replicación en RUNTIME). Debe mantenerse en sync con `evalValueStep` de tenantHub.ts.

    /// ¿Es `sql` una forma de paso `value` evaluable por `evalValueStep`?
    fn value_step_evaluable(sql: &str) -> bool {
        let s = sql.trim().trim_end_matches(';').trim();
        let rest = match s.get(..7) {
            Some(p) if p.eq_ignore_ascii_case("SELECT ") => s[7..].trim(),
            _ => return false,
        };
        // SELECT ?N
        if let Some(num) = rest.strip_prefix('?') {
            return !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit());
        }
        // SELECT <número> (entero o decimal, signo opcional)
        if !rest.is_empty() && rest.parse::<f64>().is_ok() {
            return true;
        }
        // SELECT 'prefijo' || ?N
        if let Some(after_open) = rest.strip_prefix('\'') {
            if let Some(close) = after_open.find('\'') {
                let after = after_open[close + 1..].trim();
                if let Some(r2) = after.strip_prefix("||") {
                    if let Some(num) = r2.trim().strip_prefix('?') {
                        return !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit());
                    }
                }
            }
        }
        false
    }

    /// Extrae el literal de cadena de un `sql: "..."` (o `'...'`). Devuelve `None` si el valor no es
    /// un literal estático (p. ej. template literal con backtick o una variable): eso es justo lo
    /// que queremos flaggear en un paso `value`.
    fn extract_sql_literal(line: &str) -> Option<String> {
        let idx = line.find("sql:")?;
        let after = line[idx + 4..].trim_start();
        let quote = after.chars().next()?;
        if quote != '"' && quote != '\'' {
            return None;
        }
        let rest = &after[quote.len_utf8()..];
        let end = rest.find(quote)?;
        Some(rest[..end].to_string())
    }

    #[test]
    fn worker_value_steps_solo_usan_formas_evaluables() {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/cloud-worker-licensing/src/domains");
        assert!(
            base.exists(),
            "No se encontró {base:?}. ¿Cambió el layout del worker?"
        );

        let mut files = Vec::new();
        collect_commands_ts(&base, &mut files);
        assert!(
            !files.is_empty(),
            "No se encontró ningún *.commands.ts bajo {base:?}."
        );

        // Sanidad del mirror: las 3 formas válidas y algunas inválidas.
        assert!(value_step_evaluable("SELECT ?1;"));
        assert!(value_step_evaluable("SELECT 1"));
        assert!(value_step_evaluable("SELECT -2.5"));
        assert!(value_step_evaluable("SELECT 'pref' || ?2"));
        assert!(!value_step_evaluable("SELECT id FROM T WHERE x = ?1"));
        assert!(!value_step_evaluable("SELECT ?1 + ?2"));

        let mut violations = Vec::new();
        for f in &files {
            let content = std::fs::read_to_string(f).unwrap();
            let lines: Vec<&str> = content.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if !(line.contains("kind: \"value\"") || line.contains("kind: 'value'")) {
                    continue;
                }
                // Buscar el `sql:` del mismo objeto (misma línea o siguientes, hasta el cierre `}`).
                let mut found: Option<String> = None;
                for (desplazamiento, linea) in lines[i..(i + 8).min(lines.len())].iter().enumerate()
                {
                    if let Some(sql) = extract_sql_literal(linea) {
                        found = Some(sql);
                        break;
                    }
                    if desplazamiento > 0 && linea.contains('}') {
                        break;
                    }
                }
                match found {
                    Some(sql) if value_step_evaluable(&sql) => {}
                    Some(sql) => violations.push(format!(
                        "{}:{} → paso `value` no evaluable por evalValueStep: {sql:?}",
                        f.display(),
                        i + 1
                    )),
                    None => violations.push(format!(
                        "{}:{} → paso `value` sin `sql:` literal estático (¿template/variable?)",
                        f.display(),
                        i + 1
                    )),
                }
            }
        }
        assert!(
            violations.is_empty(),
            "SYNC-11: todo paso `value` debe usar una forma evaluable por evalValueStep \
             (SELECT ?N | SELECT <número> | SELECT 'pref' || ?N). Violaciones:\n{}",
            violations.join("\n")
        );
    }
}
