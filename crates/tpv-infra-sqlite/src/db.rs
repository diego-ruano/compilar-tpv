//! # Manejo de conexiones a la BD local (SQLite): escritor único + pool de lectura
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
//! traits `Reader` / `Writer`, de modo que los helpers (`select_one_*`, …) son
//! genéricos y los cuerpos de los métodos apenas cambian.

use crate::util::now_ms;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use crate::ejecutor::{Connection, ErrorSql, Rows, Value};
use serde_json::json;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

use tpv_contracts::sync::SqlStatement;

/// Nombre de comando con el que viajan las operaciones de la Main a la nube. La idempotencia es
/// por `Op_Id` (uuid único), así que basta una constante estable.
const MAIN_COMMAND_NAME: &str = "main_op";

/// Nº de conexiones del pool de lectura. 4 da concurrencia de sobra para un TPV.
const READ_POOL_SIZE: usize = 4;

pub use crate::ejecutor::Bindable;

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
    ) -> impl Future<Output = Result<Rows, ErrorSql>> + Send;
}

/// Capacidad de ESCRITURA (solo `WriteGuard`). `execute` captura la escritura en el outbox;
/// `execute_batch` maneja BEGIN/COMMIT/ROLLBACK agrupando la operación.
pub trait Writer: Reader {
    fn execute(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<u64, ErrorSql>> + Send;

    fn execute_batch(&self, sql: &str) -> impl Future<Output = Result<(), ErrorSql>> + Send;

    /// RI-32: todo el control transaccional en un sitio, incluida cancelación y COMMIT fallido.
    fn abandonar_transaccion(&self);

    fn transaccion<T: Send, F: Future<Output = tpv_application::error::AppResult<T>> + Send>(
        &self, trabajo: F,
    ) -> impl Future<Output = tpv_application::error::AppResult<T>> + Send {
        async move {
            use crate::consultas::db_err;
            // Crear la guarda ANTES de esperar BEGIN: éste puede ejecutarse aunque se cancele.
            let mut guarda = Reversion { writer: self, armada: true };
            self.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;").await.map_err(db_err)?;
            let resultado = match trabajo.await {
                Ok(v) => self.execute_batch("COMMIT;").await.map(|_| v).map_err(db_err),
                Err(e) => Err(e),
            };
            if resultado.is_err() {
                if let Err(e) = self.execute_batch("ROLLBACK;").await {
                    self.abandonar_transaccion();
                    tracing::error!(error = %e, "No se pudo revertir la transacción");
                }
            }
            guarda.armada = false;
            resultado
        }
    }
}

struct Reversion<'a, W: Writer + ?Sized> { writer: &'a W, armada: bool }
impl<W: Writer + ?Sized> Drop for Reversion<'_, W> {
    fn drop(&mut self) { if self.armada { self.writer.abandonar_transaccion(); } }
}

// La conexión raw comparte control transaccional, pero nunca captura negocio en el outbox.
impl Reader for Connection {
    fn query(&self, sql: &str, params: impl Bindable + Send) -> impl Future<Output = Result<Rows, ErrorSql>> + Send {
        Connection::query(self, sql, params.into_values())
    }
}
impl Writer for Connection {
    fn execute(&self, sql: &str, params: impl Bindable + Send) -> impl Future<Output = Result<u64, ErrorSql>> + Send {
        Connection::execute(self, sql, params.into_values())
    }
    fn execute_batch(&self, sql: &str) -> impl Future<Output = Result<(), ErrorSql>> + Send {
        Connection::execute_batch(self, sql)
    }
    fn abandonar_transaccion(&self) { self.revertir_al_soltar(); }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers de captura (antes en recording.rs)
// ──────────────────────────────────────────────────────────────────────────────

fn value_to_json(v: &Value) -> Result<serde_json::Value, ErrorSql> {
    Ok(match v {
        Value::Null => serde_json::Value::Null,
        Value::Integer(i) => json!(i),
        Value::Real(f) if f.is_finite() => json!(f),
        Value::Text(s) => json!(s),
        // RI-38: rechazar antes de escribir; nunca replicar un BLOB como NULL.
        Value::Blob(_) => return Err(ErrorSql::Misuse("No se admiten BLOB en escrituras replicables".into())),
        Value::Real(_) => return Err(ErrorSql::Misuse("Número no finito en escritura replicable".into())),
    })
}

/// El instante de una operación (CFG-04). Se toma UNO —al abrir la transacción, o al ejecutar una
/// escritura suelta— y con él se fijan todas sus sentencias: la línea y el pago de un mismo cobro
/// llevan la misma hora, en el TPV y en la nube.
#[derive(Clone, Copy)]
struct Instante(chrono::DateTime<chrono::Local>);

impl Instante {
    fn ahora() -> Self {
        Self(chrono::Local::now())
    }

    fn local(&self) -> String {
        self.0.format("%Y-%m-%d %H:%M:%S").to_string()
    }

    fn fecha_local(&self) -> String {
        self.0.format("%Y-%m-%d").to_string()
    }

    fn utc(&self, formato: &str) -> String {
        self.0.with_timezone(&chrono::Utc).format(formato).to_string()
    }
}

/// Las funciones de fecha de SQLite. Un `'now'` sólo es «ahora» cuando es argumento de una de ellas:
/// fuera de ellas es un texto como otro cualquiera, y una nota que diga "now" no es una hora.
const FUNCIONES_DE_FECHA: [&str; 7] =
    ["datetime", "date", "time", "julianday", "strftime", "unixepoch", "timediff"];

fn es_de_identificador(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// ¿El `'now'` que empieza en `i` es argumento de una función de fecha? Se busca hacia atrás el
/// paréntesis que lo abre y el nombre que lleva delante. `b` es el SQL en minúsculas.
fn es_argumento_de_fecha(b: &[u8], i: usize) -> bool {
    let mut profundidad = 0usize;
    let mut j = i;
    while j > 0 {
        j -= 1;
        match b[j] {
            b')' => profundidad += 1,
            b'(' if profundidad > 0 => profundidad -= 1,
            b'(' => {
                let mut fin = j;
                while fin > 0 && b[fin - 1].is_ascii_whitespace() {
                    fin -= 1;
                }
                let mut ini = fin;
                while ini > 0 && es_de_identificador(b[ini - 1]) {
                    ini -= 1;
                }
                return FUNCIONES_DE_FECHA.iter().any(|f| b[ini..fin] == *f.as_bytes());
            }
            _ => {}
        }
    }
    false
}

/// Si tras el `'now'` que acaba en `pos` viene `, 'localtime'`, devuelve dónde acaba.
fn tras_localtime(b: &[u8], mut pos: usize) -> Option<usize> {
    while pos < b.len() && b[pos].is_ascii_whitespace() {
        pos += 1;
    }
    if b.get(pos) != Some(&b',') {
        return None;
    }
    pos += 1;
    while pos < b.len() && b[pos].is_ascii_whitespace() {
        pos += 1;
    }
    b[pos..]
        .starts_with(b"'localtime'")
        .then_some(pos + b"'localtime'".len())
}

/// `CURRENT_TIMESTAMP`, `CURRENT_DATE` o `CURRENT_TIME` en la posición `i`: su largo y el formato del
/// literal UTC que lo sustituye. Tiene que ser la palabra entera, no parte de un nombre de columna.
fn marca_current(b: &[u8], i: usize) -> Option<(usize, &'static str)> {
    if i > 0 && es_de_identificador(b[i - 1]) {
        return None;
    }
    [
        ("current_timestamp", "%Y-%m-%d %H:%M:%S"),
        ("current_date", "%Y-%m-%d"),
        ("current_time", "%H:%M:%S"),
    ]
    .into_iter()
    .find(|(palabra, _)| {
        b[i..].starts_with(palabra.as_bytes())
            && !matches!(b.get(i + palabra.len()), Some(c) if es_de_identificador(*c))
    })
    .map(|(palabra, formato)| (palabra.len(), formato))
}

/// Fija a literal TODA forma de «ahora» de una escritura replicable (DB-15, CFG-04).
///
/// Si la sentencia viajara con su `datetime('now')`, la nube la evaluaría al aplicarla —segundos
/// después, o días si el TPV estuvo sin conexión— y en UTC. Así que la hora la pone el TPV:
///
///   - `datetime('now','localtime')` y `date('now','localtime')` pasan a ser el literal suelto.
///   - `'now','localtime'` con modificadores detrás pasa a ser la hora local fija, y los
///     modificadores se quedan: `datetime('2026-09-14 16:04:43','-2 days')` da lo mismo que antes.
///   - un `'now'` sin `localtime` es UTC, y pasa a ser la hora UTC fija.
///   - `CURRENT_TIMESTAMP`, `CURRENT_DATE` y `CURRENT_TIME`, que también son UTC, igual.
///
/// La sentencia fijada es la que se ejecuta en local **y** la que sube (ver `build_stmt`), así que
/// el TPV y la nube guardan el mismo valor.
fn rewrite_now_literals(sql: &str, t: &Instante) -> String {
    let minus = sql.to_ascii_lowercase();
    if !minus.contains("'now'") && !minus.contains("current_") {
        return sql.to_string();
    }
    let sql = sql
        .replace("datetime('now','localtime')", &format!("'{}'", t.local()))
        .replace("date('now','localtime')", &format!("'{}'", t.fecha_local()));

    // Todo lo que se busca es ASCII, así que las posiciones del SQL en minúsculas valen para el
    // original, y cortar por ellas nunca parte un carácter.
    let minus = sql.to_ascii_lowercase();
    let b = minus.as_bytes();
    let mut out = String::with_capacity(sql.len() + 32);
    let mut copiado = 0;
    let mut i = 0;
    while i < b.len() {
        let sustitucion = if b[i..].starts_with(b"'now'") && es_argumento_de_fecha(b, i) {
            Some(match tras_localtime(b, i + 5) {
                Some(fin) => (fin, t.local()),
                None => (i + 5, t.utc("%Y-%m-%d %H:%M:%S")),
            })
        } else {
            marca_current(b, i).map(|(largo, formato)| (i + largo, t.utc(formato)))
        };
        match sustitucion {
            Some((fin, literal)) => {
                out.push_str(&sql[copiado..i]);
                out.push('\'');
                out.push_str(&literal);
                out.push('\'');
                copiado = fin;
                i = fin;
            }
            None => i += 1,
        }
    }
    out.push_str(&sql[copiado..]);
    out
}

/// Lo que ni siquiera el TPV puede fijar (CFG-04): un `'localtime'` o un `'utc'` aplicados a un
/// VALOR —una columna, un parámetro—. La conversión depende de la zona horaria de quien ejecuta la
/// sentencia, y la nube corre en UTC: el mismo `datetime(Fecha,'localtime')` da dos horas distintas.
/// Aplicados a `'now'` no llegan aquí, porque `rewrite_now_literals` ya los ha resuelto.
fn tiempo_sin_fijar(sql_fijada: &str) -> Option<&'static str> {
    let minus = sql_fijada.to_ascii_lowercase();
    ["'localtime'", "'utc'"]
        .into_iter()
        .find(|token| minus.contains(*token))
}

/// DO-01 · Lo que admite por sentencia el SQLite del Durable Object, que es donde se aplica lo que
/// sube la Main (`apps/cloud-worker-licensing/test/sondaSqliteDo.test.ts`). El de aquí admite
/// mucho más, así que una sentencia que se pasa entra en local sin rechistar y es la nube la que la
/// rechaza, como permanente: la operación acaba apartada.
const MAX_PARAMETROS_EN_LA_NUBE: usize = 100;
const MAX_BYTES_DE_SQL_EN_LA_NUBE: usize = 100_000;

/// DO-01 · Por qué la nube rechazaría esta sentencia, si la rechazaría.
///
/// Lo normal es que sea una lista de tamaño variable con un `?` por elemento: va en un solo
/// parámetro, un array JSON (`consultas::lista_json`).
fn no_cabe_en_la_nube(sql: &str, parametros: usize) -> Option<String> {
    if parametros > MAX_PARAMETROS_EN_LA_NUBE {
        return Some(format!(
            "{parametros} parámetros (la nube admite {MAX_PARAMETROS_EN_LA_NUBE} por sentencia)"
        ));
    }
    if sql.len() > MAX_BYTES_DE_SQL_EN_LA_NUBE {
        return Some(format!(
            "{} bytes de SQL (la nube admite {MAX_BYTES_DE_SQL_EN_LA_NUBE} por sentencia)",
            sql.len()
        ));
    }
    None
}

/// De qué sentencia se habla, sin sus datos: el verbo y la tabla. Se corta en el primer paréntesis,
/// signo igual o comilla, que es donde empiezan las columnas, las condiciones y los literales, así
/// que lo que queda son palabras del SQL y nombres del esquema (sale del equipo con el aviso).
fn cabeza_de_la_sentencia(sql: &str) -> String {
    let limpio = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let fin = limpio.find(['(', '=', '\'', '"']).unwrap_or(limpio.len());
    limpio[..fin].trim_end().chars().take(60).collect()
}

/// La sentencia sin el espacio ni los comentarios (`--` y `/* */`) que lleve delante.
///
/// Clasificar por la cabeza del texto sin quitarlos antes hacía que una escritura comentada no se
/// reconociera como escritura, y entonces no entraba en `_Sync_Outbox`: se guardaba en el TPV y no
/// llegaba nunca a la nube. Le pasaba al alta de un lote, así que su movimiento de stock y el primer
/// cobro que gastaba de él se rechazaban arriba por la clave foránea (SYNC-27).
///
/// Lo que sube es también la sentencia recortada: en local se ejecuta la misma que sube (CFG-04), y
/// el parser de Turso rechaza los comentarios de bloque (ver `tenantMigrations.ts`).
fn sin_comentarios_iniciales(sql: &str) -> &str {
    let mut resto = sql.trim_start();
    loop {
        if let Some(tras) = resto.strip_prefix("--") {
            resto = tras.find('\n').map_or("", |i| tras[i + 1..].trim_start());
        } else if let Some(tras) = resto.strip_prefix("/*") {
            resto = tras.find("*/").map_or("", |i| tras[i + 2..].trim_start());
        } else {
            return resto;
        }
    }
}

fn is_write_sql(sql: &str) -> bool {
    let head: String = sin_comentarios_iniciales(sql)
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
    let head: String = sin_comentarios_iniciales(sql)
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
async fn write_op(conn: &Connection, stmts: &[SqlStatement]) -> Result<(), ErrorSql> {
    // RI-33: v7 y no v4, para que cada `Op_Id` nuevo entre al final de los índices de
    // `_Sync_Outbox`, `_Sync_Applied_Ops` y `Applied_Operations` y no en un sitio cualquiera.
    let op_id = uuid::Uuid::now_v7().to_string();
    let now = now_ms();
    let statements_json = serde_json::to_string(stmts)
        .map_err(|e| ErrorSql::Misuse(format!("No se pudo serializar la operación del outbox: {e}")))?;

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
/// Algunas PRAGMA (`journal_mode`, `busy_timeout`) DEVUELVEN una fila con el valor resultante
/// incluso al fijarlas, y por la vía de `execute` darían `Execute returned rows`: se recorren sus
/// filas y se descartan.
pub(crate) fn tune(conn: &rusqlite::Connection) -> Result<(), ErrorSql> {
    for pragma in [
        "PRAGMA busy_timeout = 5000;",
        "PRAGMA journal_mode = WAL;",
        "PRAGMA foreign_keys = ON;",
        "PRAGMA synchronous = NORMAL;",
    ] {
        let mut stmt = conn.prepare(pragma)?;
        let mut filas = stmt.raw_query();
        while filas.next()?.is_some() {}
    }
    Ok(())
}

/// AUD-02 · La conexión deja de admitir `ATTACH` (`SQLITE_LIMIT_ATTACHED` a 0).
///
/// Es para el escritor, que ejecuta tal cual las sentencias que llegan de la nube
/// (`sync::apply_one`): con un `ATTACH`, una de ellas abría como base cualquier ruta del disco y
/// escribía en ella. Nada de la aplicación adjunta otra base por el escritor.
///
/// Las conexiones de lectura lo conservan a propósito: las copias (`VACUUM INTO`, `recovery.rs`)
/// van por ellas, y SQLite las hace adjuntando el destino por dentro, así que con el límite a 0
/// fallarían («too many attached databases - max 0»). Por ellas no pasa ninguna sentencia que venga
/// de fuera.
pub(crate) fn sin_attach(conn: &rusqlite::Connection) -> Result<(), ErrorSql> {
    conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_ATTACHED, 0)?;
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
            .unwrap_or_else(|p| p.into_inner())
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
            self.pool.free.lock().unwrap_or_else(|p| p.into_inner()).push(conn);
        }
        // El permiso se libera al soltar `_permit`.
    }
}

impl Reader for ReadGuard {
    fn query(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<Rows, ErrorSql>> + Send {
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
    tx_buf: StdMutex<Option<Vec<SqlStatement>>>,
    /// Serializa llamadas concurrentes hechas a través de un mismo guard, sin retener mutex std.
    operacion: Mutex<()>,
    /// El instante de la transacción en curso (Some entre BEGIN y COMMIT/ROLLBACK): todas sus
    /// escrituras se fijan con él (CFG-04).
    instante: StdMutex<Option<Instante>>,
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

    /// El instante de la operación en curso: el de su transacción, o uno nuevo si es suelta.
    fn instante(&self) -> Instante {
        self.instante.lock().unwrap_or_else(|p| p.into_inner()).unwrap_or_else(Instante::ahora)
    }

    /// Fija (o suelta, con `None`) el instante de la transacción. Es síncrono a propósito: el
    /// cerrojo no puede quedar vivo a través de un `await`.
    fn fijar_instante(&self, instante: Option<Instante>) {
        *self.instante.lock().unwrap_or_else(|p| p.into_inner()) = instante;
    }

    /// Construye la escritura tal como se ejecuta en local y tal como sube a la nube: la misma
    /// sentencia, con la hora ya fijada (CFG-04), y sus args serializados a JSON.
    fn build_stmt(&self, sql: &str, values: &[Value]) -> Result<SqlStatement, ErrorSql> {
        let sql = rewrite_now_literals(sql, &self.instante());
        if let Some(token) = tiempo_sin_fijar(&sql) {
            // No se bloquea la escritura: podría ser un cobro, y nada de lo que rodea a una venta
            // puede impedirla. Pero la nube haría esa conversión en su zona horaria, así que se
            // grita: en desarrollo y en los tests revienta, y en el equipo del cliente queda anotado.
            #[cfg(debug_assertions)]
            panic!(
                "SQL replicable con una hora que depende de la zona de quien la ejecuta ({token}): {sql}"
            );
            #[cfg(not(debug_assertions))]
            tracing::error!(
                target: "tpv::sync",
                token,
                sql = %sql,
                "escritura con una hora que la nube convertiría a su zona horaria"
            );
        }
        if let Some(motivo) = no_cabe_en_la_nube(&sql, values.len()) {
            // DO-01. Tampoco se bloquea, por lo mismo: en local la sentencia entra, y nada de lo
            // que rodea a una venta puede impedirla. Lo que no entraría es su réplica, así que se
            // grita: en desarrollo y en los tests revienta, que es donde se arregla; en el equipo
            // del cliente queda anotado, y la operación acabará apartada y reparada por estado.
            let sentencia = cabeza_de_la_sentencia(&sql);
            #[cfg(debug_assertions)]
            panic!(
                "SQL replicable que la nube rechazaría: {motivo}. Una lista de tamaño variable va en \
                 un solo parámetro JSON (`consultas::lista_json`). Sentencia: {sentencia}"
            );
            #[cfg(not(debug_assertions))]
            tracing::error!(
                target: "tpv::sync",
                motivo = %motivo,
                sentencia = %sentencia,
                "escritura que la nube rechazará por tamaño"
            );
        }
        Ok(SqlStatement {
            sql,
            args: values.iter().map(value_to_json).collect::<Result<_, _>>()?,
        })
    }
}

impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        // RI-16: se encola antes de liberar el escritor, incluso tras cancelación o pánico.
        self.conn.revertir_al_soltar();
    }
}

impl<'a> Reader for WriteGuard<'a> {
    fn query(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<Rows, ErrorSql>> + Send {
        let conn = self.conn.clone();
        let values = params.into_values();
        async move { conn.query(sql, values).await }
    }
}

impl<'a> Writer for WriteGuard<'a> {
    fn abandonar_transaccion(&self) {
        *self.tx_buf.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.fijar_instante(None);
        self.conn.revertir_al_soltar();
    }

    fn execute(
        &self,
        sql: &str,
        params: impl Bindable + Send,
    ) -> impl Future<Output = Result<u64, ErrorSql>> + Send {
        let values = params.into_values();
        async move {
            let _operacion = self.operacion.lock().await;
            let sql = sin_comentarios_iniciales(sql);
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
                return Err(ErrorSql::Misuse(
                    "Este equipo está recuperando sus datos: no admite escrituras todavía."
                        .to_string(),
                ));
            }

            let en_transaccion = self.tx_buf.lock().unwrap_or_else(|p| p.into_inner()).is_some();
            match en_transaccion {
                true => {
                    // Dentro de una transacción (BEGIN..COMMIT): ejecutamos el negocio y
                    // ACUMULAMOS la captura en el buffer; se vuelca en el COMMIT dentro de la
                    // misma transacción → ya es atómico (negocio + outbox commitean juntos).
                    //
                    // Lo que se ejecuta es la sentencia con la hora ya fijada, no la original: así
                    // queda en local exactamente lo que sube (CFG-04).
                    let stmt = self.build_stmt(sql, &values)?;
                    let affected = self.conn.execute(&stmt.sql, values).await?;
                    self.tx_buf.lock().unwrap_or_else(|p| p.into_inner()).as_mut()
                        .ok_or_else(|| ErrorSql::Misuse("Transacción abandonada".into()))?.push(stmt);
                    Ok(affected)
                }
                false => {
                    // Escritura suelta (autocommit). SYNC-02: envolvemos la escritura de negocio
                    // Y su registro en el outbox (`write_op`) en UNA sola transacción, para que un
                    // crash entre ambas no deje la fila escrita sin su entrada en el outbox (que
                    // nunca se replicaría). Todo o nada.
                    let stmt = self.build_stmt(sql, &values)?;
                    self.conn.execute_batch("BEGIN;").await?;
                    let res: Result<u64, ErrorSql> = async {
                        let affected = self.conn.execute(&stmt.sql, values.clone()).await?;
                        write_op(self.conn, std::slice::from_ref(&stmt)).await?;
                        Ok(affected)
                    }
                    .await;
                    match res {
                        Ok(affected) => {
                            if let Err(e) = self.conn.execute_batch("COMMIT;").await {
                                self.conn.revertir_al_soltar();
                                return Err(e);
                            }
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

    fn execute_batch(&self, sql: &str) -> impl Future<Output = Result<(), ErrorSql>> + Send {
        let sql = sql.to_string();
        async move {
            let _operacion = self.operacion.lock().await;
            match batch_kind(&sql) {
                BatchKind::Begin => {
                    self.conn.execute_batch(&sql).await?;
                    *self.tx_buf.lock().unwrap_or_else(|p| p.into_inner()) = Some(Vec::new());
                    // Una operación, un instante: todas las escrituras de esta transacción se fijan
                    // con la hora de ahora, aunque la transacción dure más de un segundo (CFG-04).
                    self.fijar_instante(Some(Instante::ahora()));
                    Ok(())
                }
                BatchKind::Commit => {
                    let buffered = self.tx_buf.lock().unwrap_or_else(|p| p.into_inner()).take();
                    self.fijar_instante(None);
                    let had_writes = buffered.as_ref().map(|v| !v.is_empty()).unwrap_or(false);
                    // Registrar la operación en el outbox DENTRO de la misma transacción (BEGIN
                    // ya enviado, COMMIT no aún). La captura es incondicional: el outbox acumula
                    // también en offline y se drena al activar online.
                    let mut pre: Result<(), ErrorSql> = Ok(());
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
                            if r.is_err() { self.conn.revertir_al_soltar(); }
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
                    *self.tx_buf.lock().unwrap_or_else(|p| p.into_inner()) = None;
                    self.fijar_instante(None);
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
    /// La carpeta del fichero (AppData en la Main). Ahí viven las señales que tienen que
    /// sobrevivir a la propia base, como la marca de traslado (`recovery::marcar_traslado`).
    carpeta: std::path::PathBuf,
}

impl Db {
    /// Abre la BD local en `path`, construye/actualiza el esquema aplicando las migraciones
    /// embebidas, crea las tablas de control y monta el escritor único + el pool de lectura (todas
    /// las conexiones afinadas: WAL, etc.). El seed (admin inicial) lo hace el llamador con un
    /// `write()` guard tras abrir.
    pub async fn open(path: &str) -> Result<Arc<Db>, Box<dyn std::error::Error + Send + Sync>> {
        let path = path.to_owned();
        // Abrir y migrar es SQLite síncrono: fuera de los hilos del runtime.
        tokio::task::spawn_blocking(move || Self::abrir(&path)).await?
    }

    fn abrir(path: &str) -> Result<Arc<Db>, Box<dyn std::error::Error + Send + Sync>> {
        // Conexión de escritura: afinar, construir el esquema y crear tablas de control.
        let write_conn = crate::ejecutor::abrir(path)?;
        tune(&write_conn)?;

        // Esquema = migraciones embebidas (ya no hay schema.sql). Construye desde cero en BDs
        // nuevas y pone al día las existentes. Ver `migrations.rs`.
        //
        // Aquí ya NO se crea nada más a mano. El andamiaje local del dispositivo (`_Sync_*`,
        // `_Jobs_State`, `_Verifactu_*`, `_Recovery_State`, `_Backfill_Historico`) vive en §16 del
        // `0001`, con el resto del esquema: dos funciones que creaban tablas por su cuenta eran un
        // segundo esquema, sin versión, sin hash y fuera del snapshot anti-drift.
        crate::migrations::run(&write_conn)?;

        // AUD-02: desde aquí el escritor no adjunta otras bases. Las de lectura, sí (las copias).
        sin_attach(&write_conn)?;

        // Pool de lectura.
        let mut read_conns = Vec::with_capacity(READ_POOL_SIZE);
        for i in 0..READ_POOL_SIZE {
            let c = crate::ejecutor::abrir(path)?;
            tune(&c)?;
            read_conns.push(Arc::new(Connection::nueva(c, &format!("tpv-sql-lectura-{i}"))?));
        }

        Ok(Arc::new(Db {
            write: WriteConn {
                conn: Arc::new(Connection::nueva(write_conn, "tpv-sql-escritor")?),
                lock: Mutex::new(()),
            },
            reads: Arc::new(ReadPool::new(read_conns)),
            outbox_notify: Arc::new(OnceLock::new()),
            // Por defecto abierta: lo decide quien conoce el estado de recuperación
            // (`connection::init_main_db`), no el constructor genérico.
            escrituras_bloqueadas: AtomicBool::new(false),
            carpeta: std::path::Path::new(path)
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default(),
        }))
    }

    /// La carpeta donde está el fichero de la base.
    pub fn carpeta(&self) -> &std::path::Path {
        &self.carpeta
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

    /// Cierre confirmado para intercambiar el fichero en Windows. El shell impide crear nuevos
    /// repositorios antes de llamarlo. Espera a los préstamos y a las operaciones ya admitidas.
    pub async fn cerrar(&self) -> Result<(), ErrorSql> {
        let _writer = self.write.lock.lock().await;
        let _lecturas = self.reads.sem.clone().acquire_many_owned(READ_POOL_SIZE as u32).await
            .map_err(|_| ErrorSql::Misuse("El pool de lectura se ha cerrado".into()))?;
        let conns = self.reads.free.lock().unwrap_or_else(|p| p.into_inner()).clone();
        for c in conns { c.cerrar().await?; }
        self.write.conn.cerrar().await
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
        if let Err(e) = self.write.conn.sanear().await {
            tracing::error!(error = %e, "No se pudo sanear el escritor de SQLite");
        }
        WriteGuard {
            conn: &self.write.conn,
            bloqueadas: &self.escrituras_bloqueadas,
            tx_buf: StdMutex::new(None),
            operacion: Mutex::new(()),
            instante: StdMutex::new(None),
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

    #[tokio::test]
    async fn un_cursor_sobrevive_a_su_fachada_y_las_conexiones_se_cierran() {
        // El hilo de una conexión sigue vivo mientras le quede un cursor, aunque se suelte la
        // fachada; y abrir y cerrar muchas, con cursores a medias, no deja nada colgado.
        for i in 0..200 {
            let nativa = crate::ejecutor::abrir(":memory:").unwrap();
            let conn = Connection::nueva(nativa, "tpv-sql-prueba").unwrap();
            let mut filas = conn.query("SELECT 42 UNION ALL SELECT 43", ()).await.unwrap();
            if i % 2 == 0 {
                drop(conn);
                assert_eq!(filas.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 42);
                assert_eq!(filas.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 43);
                assert!(filas.next().await.unwrap().is_none());
            } else {
                assert_eq!(filas.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 42);
                drop(filas);
                conn.cerrar().await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn un_cursor_abandonado_a_medias_no_retiene_la_lectura() {
        // Un cursor lee por lotes, así que su sentencia queda en curso entre uno y otro. Si al
        // soltarlo no se reiniciara, su lectura seguiría abierta y el checkpoint del WAL no podría
        // completarse nunca.
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        {
            let w = db.write().await;
            w.raw().execute_batch(
                "CREATE TABLE prueba_cursor (n INTEGER);
                 WITH RECURSIVE s(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM s WHERE x<500)
                 INSERT INTO prueba_cursor SELECT x FROM s;",
            ).await.unwrap();
        }
        let r = db.read().await;
        let mut filas = r.query("SELECT n FROM prueba_cursor ORDER BY n", ()).await.unwrap();
        assert_eq!(filas.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 1);
        drop(filas);
        // La limpieza del cursor va por la cola de su conexión: un trabajo detrás asegura que pasó.
        r.conn().execute_batch("SELECT 1;").await.unwrap();

        let w = db.write().await;
        w.raw().execute_batch("INSERT INTO prueba_cursor VALUES (0);").await.unwrap();
        let mut cp = w.raw().query("PRAGMA wal_checkpoint(TRUNCATE);", ()).await.unwrap();
        let bloqueado = cp.next().await.unwrap().unwrap().get::<i64>(0).unwrap();
        assert_eq!(bloqueado, 0, "un lector sigue reteniendo la base");
    }

    #[tokio::test]
    async fn los_parametros_que_no_cuadran_se_toleran() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let r = db.read().await;
        // Falta el ?2: vale NULL.
        let mut filas = r.query("SELECT ?1, ?2", vec![Value::Integer(7)]).await.unwrap();
        let fila = filas.next().await.unwrap().unwrap();
        assert_eq!(fila.get_value(0).unwrap(), Value::Integer(7));
        assert_eq!(fila.get_value(1).unwrap(), Value::Null);
        // Sobra uno: se ignora.
        let mut filas = r.query("SELECT ?1", vec![Value::Integer(7), Value::Integer(8)]).await.unwrap();
        assert_eq!(filas.next().await.unwrap().unwrap().get_value(0).unwrap(), Value::Integer(7));
    }

    #[tokio::test]
    async fn varias_sentencias_en_una_consulta_son_un_error() {
        // Un texto con varias sentencias es un error, en vez de ejecutar la primera y perder el resto
        // sin avisar. Varias seguidas van por `execute_batch`.
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let w = db.write().await;
        assert!(w.raw().query("SELECT 1; SELECT 2;", ()).await.is_err());
        assert!(w.raw().execute("UPDATE Zonas SET Nombre_Zona = Nombre_Zona; SELECT 1;", ()).await.is_err());
        // Un `;` final, con espacios o comentarios detrás, no es otra sentencia.
        assert!(w.raw().query("SELECT 1; -- fin\n", ()).await.is_ok());
    }

    #[tokio::test]
    async fn un_texto_con_utf8_invalido_se_lee_con_sustituciones() {
        // La columna se lee con sustituciones, y la consulta no falla por un texto mal codificado.
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let r = db.read().await;
        let mut filas = r.query("SELECT CAST(x'ff41' AS TEXT)", ()).await.unwrap();
        assert_eq!(filas.next().await.unwrap().unwrap().get::<String>(0).unwrap(), "\u{FFFD}A");
    }

    #[tokio::test]
    async fn una_consulta_guardada_trae_las_columnas_de_ahora() {
        // La conexión guarda sus sentencias preparadas. Si el esquema cambia, SQLite vuelve a
        // preparar la guardada al ejecutarla, y la fila tiene que traer las columnas nuevas.
        async fn columnas(c: &Connection) -> Vec<Value> {
            let mut filas = c.query("SELECT * FROM prueba_columnas", ()).await.unwrap();
            let fila = filas.next().await.unwrap().unwrap();
            (0..).map_while(|i| fila.get_value(i).ok()).collect()
        }
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let w = db.write().await;
        w.raw().execute_batch("CREATE TABLE prueba_columnas (a INTEGER); INSERT INTO prueba_columnas VALUES (1);").await.unwrap();
        assert_eq!(columnas(w.raw()).await, vec![Value::Integer(1)]);
        w.raw().execute_batch("ALTER TABLE prueba_columnas ADD COLUMN b INTEGER DEFAULT 7;").await.unwrap();
        assert_eq!(columnas(w.raw()).await, vec![Value::Integer(1), Value::Integer(7)]);
    }

    #[tokio::test]
    async fn la_carga_concurrente_no_da_errores_ni_deja_la_base_a_medias() {
        // Un escritor con transacciones, cuatro lectores (dos sueltan el cursor a medias) y copias en
        // caliente, a la vez durante un rato. Al final: ningún error, la base íntegra y cada
        // escritura con su operación en el outbox.
        use std::sync::atomic::{AtomicI64, Ordering};
        use std::time::{Duration, Instant};

        let dir = crate::test_temp::dir_temporal("carga");
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::connection::init_main_db(&dir, None).await.unwrap();
        let fin = Instant::now() + Duration::from_millis(1500);
        let escritas = Arc::new(AtomicI64::new(0));
        let mut tareas = Vec::new();

        let (escritor, cuenta) = (db.clone(), escritas.clone());
        tareas.push(tokio::spawn(async move {
            while Instant::now() < fin {
                let w = escritor.write().await;
                let id = crate::util::new_id();
                w.transaccion(async {
                    w.execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, 'Carga ' || ?1);", vec![Value::Text(id.clone())])
                        .await.map_err(crate::consultas::db_err)?;
                    w.execute("UPDATE Zonas SET Nombre_Zona = 'Carga ñ ' || ?1 WHERE ID_Zona = ?1;", vec![Value::Text(id.clone())])
                        .await.map_err(crate::consultas::db_err)?;
                    Ok(())
                }).await.unwrap();
                cuenta.fetch_add(1, Ordering::Relaxed);
            }
        }));
        for n in 0..4 {
            let lector = db.clone();
            tareas.push(tokio::spawn(async move {
                while Instant::now() < fin {
                    let r = lector.read().await;
                    let mut filas = r.query("SELECT ID_Zona, Nombre_Zona FROM Zonas ORDER BY ID_Zona;", ()).await.unwrap();
                    let tope = if n < 2 { 3 } else { usize::MAX };
                    let mut leidas = 0;
                    while leidas < tope && filas.next().await.unwrap().is_some() {
                        leidas += 1;
                    }
                }
            }));
        }
        let (copiador, carpeta) = (db.clone(), dir.clone());
        tareas.push(tokio::spawn(async move {
            while Instant::now() < fin {
                crate::recovery::create_backup(&copiador, &carpeta).await.unwrap();
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }));
        for t in tareas {
            t.await.unwrap();
        }

        let escritas = escritas.load(Ordering::Relaxed);
        assert!(escritas > 0);
        let r = db.read().await;
        let mut f = r.query("PRAGMA integrity_check;", ()).await.unwrap();
        assert_eq!(f.next().await.unwrap().unwrap().get::<String>(0).unwrap(), "ok");
        let mut f = r.query(
            "SELECT (SELECT COUNT(*) FROM Zonas WHERE Nombre_Zona LIKE 'Carga ñ %'), (SELECT COUNT(*) FROM _Sync_Outbox);",
            (),
        ).await.unwrap();
        let fila = f.next().await.unwrap().unwrap();
        assert_eq!(fila.get::<i64>(0).unwrap(), escritas, "cada escritura confirmada está en la base");
        assert_eq!(fila.get::<i64>(1).unwrap(), escritas, "y cada una tiene su operación en el outbox");
    }

    #[tokio::test]
    async fn cancelar_una_transaccion_revierte_antes_de_reutilizar_el_guard() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let w = db.write().await;
        let resultado = tokio::time::timeout(std::time::Duration::from_millis(30), w.transaccion(async {
            w.execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('cancelada', 'Cancelada')", ()).await.map_err(crate::consultas::db_err)?;
            std::future::pending::<tpv_application::error::AppResult<()>>().await
        })).await;
        assert!(resultado.is_err());
        w.execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('valida', 'Valida')", ()).await.unwrap();
        let mut r = w.query("SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'cancelada'", ()).await.unwrap();
        assert_eq!(r.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 0);
        let mut r = w.query("SELECT COUNT(*) FROM _Sync_Outbox", ()).await.unwrap();
        assert_eq!(r.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 1);
    }

    #[tokio::test]
    async fn un_commit_con_fk_invalida_revierte_negocio_y_outbox() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let w = db.write().await;
        w.raw().execute_batch("CREATE TABLE prueba_fk (z TEXT REFERENCES Zonas(ID_Zona) DEFERRABLE INITIALLY DEFERRED)").await.unwrap();
        let res = w.transaccion(async {
            w.execute("INSERT INTO prueba_fk VALUES ('no-existe')", ()).await.map_err(crate::consultas::db_err)?;
            Ok(())
        }).await;
        assert!(res.is_err());
        let mut r = w.query("SELECT (SELECT COUNT(*) FROM prueba_fk), (SELECT COUNT(*) FROM _Sync_Outbox)", ()).await.unwrap();
        let fila = r.next().await.unwrap().unwrap();
        assert_eq!(fila.get::<i64>(0).unwrap(), 0);
        assert_eq!(fila.get::<i64>(1).unwrap(), 0);
        w.transaccion(async {
            w.execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('tras-error', 'Valida')", ()).await.map_err(crate::consultas::db_err)?;
            Ok(())
        }).await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn una_consulta_larga_y_sus_filas_no_bloquean_tokio() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let r = db.read().await;
        let sql = "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3000000) SELECT SUM(x) FROM n";
        let consulta = r.query(sql, ());
        tokio::pin!(consulta);
        tokio::select! {
            biased;
            _ = &mut consulta => panic!("la consulta terminó antes de que Tokio pudiera atender su temporizador"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
        }
        let mut rows = consulta.await.unwrap();
        assert_eq!(rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 4_500_001_500_000);

        // La primera fila es trivial; la segunda requiere SQLite al avanzar el cursor.
        let mut rows = r.query(&format!("SELECT 0 UNION ALL SELECT * FROM ({sql})"), ()).await.unwrap();
        let siguiente = rows.next();
        tokio::pin!(siguiente);
        tokio::select! {
            biased;
            _ = &mut siguiente => panic!("next ejecutó la consulta larga en Tokio"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => {}
        }
        assert_eq!(siguiente.await.unwrap().unwrap().get::<i64>(0).unwrap(), 0);
    }

    #[tokio::test]
    async fn las_filas_materializadas_conservan_sus_valores_y_propagan_errores() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let r = db.read().await;
        let mut filas = r.query("WITH n(x) AS (VALUES(1),(2),(3),(4)) SELECT CASE WHEN x=3 THEN abs(-9223372036854775808) ELSE x END FROM n", ()).await.unwrap();
        let primera = filas.next().await.unwrap().unwrap();
        assert_eq!(filas.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 2);
        assert_eq!(primera.get::<i64>(0).unwrap(), 1, "avanzar no altera una fila ya entregada");
        assert!(filas.next().await.is_err(), "la estadística debe fallar, no devolver datos parciales");
    }

    #[tokio::test]
    async fn un_pool_envenenado_conserva_conexiones_y_permisos() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let guard = db.read().await;
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _lock = db.reads.free.lock().unwrap();
            panic!("simular fallo con el mutex tomado");
        })).is_err());
        drop(guard);
        let mut guards = Vec::new();
        for _ in 0..READ_POOL_SIZE {
            let r = db.read().await;
            assert!(r.query("SELECT 1", ()).await.is_ok());
            guards.push(r);
        }
        drop(guards);
        assert_eq!(db.reads.free.lock().unwrap_or_else(|p| p.into_inner()).len(), READ_POOL_SIZE);
    }

    #[tokio::test]
    async fn una_operacion_no_replicable_no_escribe_ni_encola() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let w = db.write().await;
        assert!(w.execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('blob', ?1)",
            vec![Value::Blob(vec![1, 2, 3])]).await.is_err());
        let mut rows = w.query("SELECT (SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'blob'), (SELECT COUNT(*) FROM _Sync_Outbox)", ()).await.unwrap();
        let row = rows.next().await.unwrap().unwrap();
        assert_eq!(row.get::<i64>(0).unwrap(), 0);
        assert_eq!(row.get::<i64>(1).unwrap(), 0);
    }

    #[tokio::test]
    async fn fallo_del_outbox_revierte_la_escritura_de_negocio() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let w = db.write().await;
        w.raw().execute_batch("CREATE TEMP TRIGGER fallo_outbox BEFORE INSERT ON _Sync_Outbox BEGIN SELECT RAISE(ABORT, 'fallo simulado'); END;").await.unwrap();
        assert!(w.execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-error', 'Error')", ()).await.is_err());
        let mut rows = w.query("SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z-error'", ()).await.unwrap();
        assert_eq!(rows.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 0);
    }

    /// Un instante fijo: el 14 de septiembre de 2026 a las 14:04:43 UTC. La hora local depende de la
    /// zona del equipo que corre el test, así que se compara contra `local()` y no contra un texto.
    fn instante_fijo() -> Instante {
        use chrono::TimeZone;
        Instante(
            chrono::Utc
                .with_ymd_and_hms(2026, 9, 14, 14, 4, 43)
                .unwrap()
                .with_timezone(&chrono::Local),
        )
    }

    /// SYNC-27: una escritura con comentarios delante sigue siendo una escritura.
    #[test]
    fn los_comentarios_de_delante_no_esconden_una_escritura() {
        assert!(is_write_sql("-- Alta pura\n  -- otra línea\nINSERT INTO Zonas VALUES (1);"));
        assert!(is_write_sql("/* bloque */ UPDATE Zonas SET Nombre_Zona = 'x';"));
        assert!(is_write_sql("\n  /* a */ -- b\n /* c\n d */ DELETE FROM Zonas;"));
        assert!(!is_write_sql("-- INSERT en un comentario\nSELECT 1;"));
        assert!(!is_write_sql("/* UPDATE */ SELECT 1;"));
        assert!(!is_write_sql("-- sólo un comentario"));
        assert!(!is_write_sql("/* sin cerrar INSERT"));
        assert!(matches!(batch_kind("-- abre\nBEGIN;"), BatchKind::Begin));
        assert!(matches!(batch_kind("/* cierra */ COMMIT;"), BatchKind::Commit));
    }

    #[test]
    fn solo_se_quita_lo_de_delante() {
        assert_eq!(
            sin_comentarios_iniciales("  -- a\n/* b */ INSERT INTO t VALUES ('--', '/* */'); -- fin"),
            "INSERT INTO t VALUES ('--', '/* */'); -- fin"
        );
        assert_eq!(sin_comentarios_iniciales("SELECT 1"), "SELECT 1");
    }

    /// Lo que fallaba de verdad: la escritura comentada se guardaba en el TPV y no entraba en el
    /// outbox, así que no llegaba a la nube. Y lo que sube va sin el comentario, que Turso no
    /// siempre acepta.
    #[tokio::test]
    async fn una_escritura_comentada_sube_a_la_nube_sin_el_comentario() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        {
            let w = db.write().await;
            w.execute(
                "-- Alta de una zona\nINSERT INTO Zonas (ID_Zona, Nombre_Zona, Updated_At) \
                 VALUES ('z1', 'Salon', datetime('now','localtime'));",
                (),
            )
            .await
            .unwrap();
            w.execute_batch("BEGIN;").await.unwrap();
            w.execute(
                "/* dentro de una transacción */ INSERT INTO Zonas (ID_Zona, Nombre_Zona, Updated_At) \
                 VALUES ('z2', 'Terraza', datetime('now','localtime'));",
                (),
            )
            .await
            .unwrap();
            w.execute_batch("COMMIT;").await.unwrap();
        }

        let r = db.read().await;
        let mut ops = r
            .query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq;", ())
            .await
            .unwrap();
        let mut subidas = Vec::new();
        while let Some(f) = ops.next().await.unwrap() {
            subidas.push(f.get::<String>(0).unwrap());
        }
        assert_eq!(subidas.len(), 2, "las dos escrituras tienen que subir: {subidas:?}");
        for s in &subidas {
            assert!(s.contains("INSERT INTO Zonas"), "{s}");
            assert!(!s.contains("--") && !s.contains("/*"), "sube sin el comentario: {s}");
        }
    }

    #[test]
    fn fija_las_formas_canonicas_como_siempre() {
        let t = instante_fijo();
        assert_eq!(
            rewrite_now_literals(
                "INSERT INTO T (a,b) VALUES (datetime('now','localtime'), date('now','localtime'));",
                &t
            ),
            format!("INSERT INTO T (a,b) VALUES ('{}', '{}');", t.local(), t.fecha_local())
        );
    }

    #[test]
    fn fija_la_hora_local_y_conserva_los_modificadores() {
        let t = instante_fijo();
        assert_eq!(
            rewrite_now_literals("SET f = datetime('now','localtime','-2 days')", &t),
            format!("SET f = datetime('{}','-2 days')", t.local())
        );
        // Con espacios, en mayúsculas y como segundo argumento: sigue siendo la hora actual.
        assert_eq!(
            rewrite_now_literals("SET h = strftime('%H', 'NOW' , 'LocalTime')", &t),
            format!("SET h = strftime('%H', '{}')", t.local())
        );
    }

    #[test]
    fn un_now_sin_localtime_es_utc_y_se_fija_en_utc() {
        let t = instante_fijo();
        assert_eq!(
            rewrite_now_literals("VALUES (datetime('now'), julianday('now'))", &t),
            "VALUES (datetime('2026-09-14 14:04:43'), julianday('2026-09-14 14:04:43'))"
        );
        assert_eq!(
            rewrite_now_literals(
                "SET a = CURRENT_TIMESTAMP, b = current_date, c = CURRENT_TIME",
                &t
            ),
            "SET a = '2026-09-14 14:04:43', b = '2026-09-14', c = '14:04:43'"
        );
    }

    #[test]
    fn no_toca_lo_que_no_es_la_hora_actual() {
        let t = instante_fijo();
        for sql in [
            // Un dato que dice "now" no es una hora, aunque vaya junto a otro que diga "localtime".
            "INSERT INTO Notas (a, b) VALUES ('now', 'localtime')",
            "CAST(julianday(date(?2)) - julianday(date(?1)) AS INTEGER)",
            "UPDATE T SET Mi_CURRENT_TIMESTAMP_X = 1",
            "UPDATE Mesas SET Estado = 'Libre' WHERE ID_Mesa = ?1",
        ] {
            assert_eq!(rewrite_now_literals(sql, &t), sql);
        }
    }

    #[test]
    fn un_localtime_sobre_un_valor_no_lo_puede_fijar_nadie() {
        assert_eq!(
            tiempo_sin_fijar("SET f = datetime(Fecha_Utc, 'localtime')"),
            Some("'localtime'")
        );
        assert_eq!(tiempo_sin_fijar("SET f = datetime(?1, 'utc')"), Some("'utc'"));
        let t = instante_fijo();
        assert_eq!(
            tiempo_sin_fijar(&rewrite_now_literals(
                "SET f = datetime('now','localtime','start of day')",
                &t
            )),
            None
        );
    }

    /// Lo que da sentido a todo lo anterior: la fila que queda en el TPV y la sentencia que sube dicen
    /// la misma hora, y las dos escrituras de una misma operación la misma entre sí, aunque entre una y
    /// otra pase más de un segundo.
    #[tokio::test]
    async fn en_local_queda_la_misma_hora_que_sube_a_la_nube() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        {
            let w = db.write().await;
            w.execute_batch("BEGIN;").await.unwrap();
            w.execute(
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona, Updated_At) \
                 VALUES ('z1', 'Salon', datetime('now','localtime'));",
                (),
            )
            .await
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(1100));
            w.execute(
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona, Updated_At) \
                 VALUES ('z2', 'Terraza', datetime('now','localtime'));",
                (),
            )
            .await
            .unwrap();
            w.execute_batch("COMMIT;").await.unwrap();
        }

        let r = db.read().await;
        let mut filas = r
            .query("SELECT Updated_At FROM Zonas ORDER BY ID_Zona;", ())
            .await
            .unwrap();
        let mut locales = Vec::new();
        while let Some(f) = filas.next().await.unwrap() {
            locales.push(f.get::<String>(0).unwrap());
        }
        let mut ops = r
            .query(
                "SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;",
                (),
            )
            .await
            .unwrap();
        let subida: String = ops.next().await.unwrap().unwrap().get(0).unwrap();

        assert_eq!(locales.len(), 2);
        assert_eq!(locales[0], locales[1], "una operación, un instante");
        assert!(
            subida.contains(&format!("'{}'", locales[0])),
            "a la nube tiene que subir la misma hora que quedó en el TPV: {subida}"
        );
        assert!(!subida.to_ascii_lowercase().contains("'now'"));
    }

    /// CFG-04: ninguna columna del esquema elige su hora. Un `DEFAULT` de hora lo evalúa cada base por
    /// su cuenta —la nube, en otro instante y en UTC—, así que la hora la pone quien inserta.
    #[tokio::test]
    async fn ninguna_columna_del_esquema_elige_su_hora() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let r = db.read().await;
        let mut tablas = r
            .query("SELECT name FROM sqlite_master WHERE type = 'table';", ())
            .await
            .unwrap();
        let mut nombres = Vec::new();
        while let Some(f) = tablas.next().await.unwrap() {
            nombres.push(f.get::<String>(0).unwrap());
        }
        let mut con_hora = Vec::new();
        for tabla in nombres {
            let mut columnas = r
                .query(&format!("PRAGMA table_info(\"{tabla}\");"), ())
                .await
                .unwrap();
            while let Some(c) = columnas.next().await.unwrap() {
                let defecto = crate::mapping::v_string(c.get_value(4).unwrap())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if defecto.contains("'now'") || defecto.contains("current_") {
                    con_hora.push(format!("{tabla}.{}", c.get::<String>(1).unwrap()));
                }
            }
        }
        assert!(con_hora.is_empty(), "columnas con DEFAULT de hora: {con_hora:?}");
    }

    // ── DO-01: lo que sube tiene que caber en el SQLite del Durable Object ─────────────────────

    #[test]
    fn la_nube_admite_cien_parametros_y_cien_kb_por_sentencia() {
        let sql = "UPDATE Zonas SET Nombre_Zona = ?1 WHERE ID_Zona = ?2;";
        assert_eq!(no_cabe_en_la_nube(sql, 0), None);
        assert_eq!(no_cabe_en_la_nube(sql, 100), None, "cien entran");
        let motivo = no_cabe_en_la_nube(sql, 101).expect("ciento uno, no");
        assert!(motivo.starts_with("101 parámetros"), "{motivo}");

        let relleno = 100_000 - "UPDATE Zonas SET Nombre_Zona = '';".len();
        let justo = format!("UPDATE Zonas SET Nombre_Zona = '{}';", "a".repeat(relleno));
        assert_eq!(justo.len(), 100_000);
        assert_eq!(no_cabe_en_la_nube(&justo, 0), None, "100 KB justos entran");
        let motivo = no_cabe_en_la_nube(&format!("{justo} "), 0).expect("un byte más, no");
        assert!(motivo.starts_with("100001 bytes"), "{motivo}");
    }

    #[test]
    fn del_aviso_sale_la_sentencia_sin_sus_datos() {
        // Lo que acompaña al aviso sale del equipo: el verbo y la tabla, nunca un literal.
        assert_eq!(
            cabeza_de_la_sentencia(
                "INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)\n  SELECT ?1, dc.ID_Detalle FROM Detalle_Comanda dc"
            ),
            "INSERT OR IGNORE INTO Pago_Detalles"
        );
        assert_eq!(
            cabeza_de_la_sentencia("UPDATE Clientes SET Nombre = 'Ana López', Telefono='600000000' WHERE ID_Cliente = ?1"),
            "UPDATE Clientes SET Nombre"
        );
        assert_eq!(
            cabeza_de_la_sentencia("DELETE FROM Mesas WHERE ID_Zona NOT IN (?1, ?2)"),
            "DELETE FROM Mesas WHERE ID_Zona NOT IN"
        );
        assert_eq!(cabeza_de_la_sentencia(&format!("UPDATE {} SET x = 1", "T".repeat(200))).chars().count(), 60);
    }

    /// Una escritura de negocio con 101 parámetros, suelta o dentro de una transacción.
    async fn escribir_con_101_parametros(db: std::sync::Arc<Db>, en_transaccion: bool) -> Result<u64, ErrorSql> {
        let marcas = (1..=101).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        let sql = format!("UPDATE Zonas SET Nombre_Zona = 'Terraza' WHERE ID_Zona = 'z1' AND ID_Zona NOT IN ({marcas});");
        let valores: Vec<Value> = (1..=101).map(|i| Value::Text(format!("otra-{i}"))).collect();
        let w = db.write().await;
        if en_transaccion {
            w.execute_batch("BEGIN;").await?;
            let filas = w.execute(&sql, valores).await?;
            w.execute_batch("COMMIT;").await?;
            Ok(filas)
        } else {
            w.execute(&sql, valores).await
        }
    }

    async fn nombre_de_z1(db: &Db) -> String {
        let r = db.read().await;
        let mut filas = r.query("SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z1';", ()).await.unwrap();
        filas.next().await.unwrap().unwrap().get::<String>(0).unwrap()
    }

    async fn operaciones_en_el_outbox(db: &Db) -> i64 {
        let r = db.read().await;
        let mut filas = r.query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
        filas.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
    }

    /// DO-01 · Una escritura que la nube rechazaría no pasa inadvertida, y **nunca impide la venta**.
    ///
    /// Lo que hace depende de cómo se haya compilado, y el test afirma lo que toca en cada caso:
    /// en desarrollo y en los tests revienta (aquí se ve y se arregla); en la versión que se
    /// instala la escritura entra y sube igual, con su aviso. Para ver la segunda mitad:
    /// `cargo nextest run -p tpv-infra-sqlite --release una_escritura_que_la_nube_rechazaria`.
    #[tokio::test]
    async fn una_escritura_que_la_nube_rechazaria_revienta_en_desarrollo_y_no_bloquea_en_el_cliente() {
        for en_transaccion in [false, true] {
            let (db, _dir) = crate::contract_comun::db_temporal().await;
            {
                let w = db.write().await;
                w.raw()
                    .execute_batch("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salón');")
                    .await
                    .unwrap();
            }

            // En su propia tarea: un pánico se queda en ella.
            let resultado = tokio::spawn(escribir_con_101_parametros(db.clone(), en_transaccion)).await;

            if cfg!(debug_assertions) {
                let fallo = resultado.expect_err("en desarrollo tiene que reventar");
                assert!(fallo.is_panic());
                // Revienta antes de escribir: ni la fila cambia ni queda nada por subir, y el
                // escritor sigue sirviendo.
                assert_eq!(nombre_de_z1(&db).await, "Salón");
                assert_eq!(operaciones_en_el_outbox(&db).await, 0);
                let w = db.write().await;
                w.execute("UPDATE Zonas SET Nombre_Zona = 'Barra' WHERE ID_Zona = 'z1';", ()).await.unwrap();
                drop(w);
                assert_eq!(nombre_de_z1(&db).await, "Barra");
            } else {
                let filas = resultado.expect("en el cliente no revienta").expect("y la escritura entra");
                assert_eq!(filas, 1);
                assert_eq!(nombre_de_z1(&db).await, "Terraza");
                assert_eq!(operaciones_en_el_outbox(&db).await, 1, "y queda en el outbox para subir");
            }
        }
    }

    #[tokio::test]
    async fn cien_parametros_justos_entran_sin_aviso() {
        let (db, _dir) = crate::contract_comun::db_temporal().await;
        let marcas = (1..=100).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        let valores: Vec<Value> = (1..=100).map(|i| Value::Text(format!("otra-{i}"))).collect();
        let w = db.write().await;
        w.execute(&format!("DELETE FROM Zonas WHERE ID_Zona IN ({marcas});"), valores).await.unwrap();
    }

    /// Espejo de lo que sabe fijar `tenantHub.tiempo.ts` con la hora del emisor: sólo el `'now'`
    /// seguido de `'localtime'`. Un `'now'` en UTC o un `CURRENT_*` no se pueden fijar con una hora
    /// local, y un `'localtime'` sobre un valor no lo puede fijar nadie: el DO los rechaza.
    fn forma_que_la_nube_no_sabe_fijar(sql: &str) -> Option<&'static str> {
        let minus = sql.to_ascii_lowercase();
        let b = minus.as_bytes();
        for i in 0..b.len() {
            if b[i..].starts_with(b"'now'")
                && es_argumento_de_fecha(b, i)
                && tras_localtime(b, i + 5).is_none()
            {
                return Some("'now'");
            }
            if marca_current(b, i).is_some() {
                return Some("CURRENT_*");
            }
        }
        tiempo_sin_fijar(&rewrite_now_literals(sql, &Instante::ahora()))
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

    /// DB-15 (lado worker): los `*.commands.ts` construyen las sentencias REPLICABLES de la nube, y la
    /// nube sólo sabe fijar la hora local del emisor (`'now','localtime'`, con o sin modificadores).
    /// Lo que no puede fijar lo rechaza en tiempo de ejecución (`hora_no_determinista`); este scan lo
    /// caza antes, en los tests de Rust.
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
                if let Some(tok) = forma_que_la_nube_no_sabe_fijar(line) {
                    violations.push(format!("{}:{} → {tok}", f.display(), i + 1));
                }
            }
        }
        assert!(
            violations.is_empty(),
            "Sentencias replicables (*.commands.ts) con una hora que la nube no sabe fijar (sólo sabe \
             'now','localtime', con o sin modificadores). Violaciones:\n{}",
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

