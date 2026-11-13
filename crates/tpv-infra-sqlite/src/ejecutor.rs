//! RI-16: SQLite es síncrono y trabaja sin ceder, así que cada conexión vive en su propio hilo y
//! Tokio sólo espera respuestas. La conexión, sus sentencias y sus cursores nunca salen de ese hilo.
//!
//! El motor es rusqlite, con el SQLite que trae empaquetado: el mismo en Windows, en Windows 7 y en
//! Android. Este módulo es lo único de la crate que lo conoce; el resto trabaja con `Value`,
//! `ErrorSql`, `Rows` y `Row`.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};

use tokio::sync::{oneshot, Semaphore};

/// El valor de una columna o de un parámetro. El resto de la crate lo toma de aquí y no del motor.
pub use rusqlite::types::Value;

/// Error de la base local.
///
/// Sus textos (`SQLite failure: …`) se ven y se buscan: `db_err` los lleva al mensaje del
/// `AppError`, y hay quien comprueba un `UNIQUE` o el `RAISE(ABORT, 'RI48: …')` de un trigger.
#[derive(Debug)]
pub enum ErrorSql {
    /// SQLite rechazó la sentencia: su código extendido y el texto del motor.
    SqliteFailure(i32, String),
    /// Uso indebido: la base está cerrada, una escritura no replicable…
    Misuse(String),
    /// `execute` con una sentencia que devuelve filas.
    ExecuteReturnedRows,
    NullValue,
    InvalidColumnIndex,
    InvalidColumnType,
}

impl std::fmt::Display for ErrorSql {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErrorSql::SqliteFailure(_, m) => write!(f, "SQLite failure: `{m}`"),
            ErrorSql::Misuse(m) => write!(f, "API misuse: `{m}`"),
            ErrorSql::ExecuteReturnedRows => f.write_str("Execute returned rows"),
            ErrorSql::NullValue => f.write_str("Null value"),
            ErrorSql::InvalidColumnIndex => f.write_str("invalid column index"),
            ErrorSql::InvalidColumnType => f.write_str("invalid column type"),
        }
    }
}

impl std::error::Error for ErrorSql {}

impl From<rusqlite::Error> for ErrorSql {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::SqliteFailure(c, m) => {
                ErrorSql::SqliteFailure(c.extended_code, m.unwrap_or_else(|| c.to_string()))
            }
            rusqlite::Error::SqlInputError { error, msg, .. } => ErrorSql::SqliteFailure(error.extended_code, msg),
            rusqlite::Error::ExecuteReturnedResults => ErrorSql::ExecuteReturnedRows,
            otro => ErrorSql::Misuse(otro.to_string()),
        }
    }
}

/// Abre una conexión de lectura y escritura, creando el fichero si no existe y sin interpretar la
/// ruta como URI. Cada conexión es de un solo hilo a la vez (`NO_MUTEX`): las de la `Db` viven en
/// el suyo, y las demás son locales a una función.
pub(crate) fn abrir(ruta: impl AsRef<Path>) -> Result<rusqlite::Connection, ErrorSql> {
    use rusqlite::OpenFlags;
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    Ok(rusqlite::Connection::open_with_flags(ruta, flags)?)
}

/// Lo que aceptan `query` y `execute` como parámetros: `()` (ninguno) o `Vec<Value>`.
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

/// Enlaza los valores por posición (`?1`, `?2`…).
///
/// Tolera que no cuadren con los marcadores: los que faltan quedan `NULL` y los de más se ignoran.
/// Rechazarlo podría tumbar un camino que funciona —y nada que rodee a un cobro puede impedirlo—,
/// así que se tolera, pero se anota: una sentencia que recibe otros parámetros de los que espera
/// suele ser un error.
fn enlazar(stmt: &mut rusqlite::Statement<'_>, valores: &[Value], sql: &str) -> Result<(), ErrorSql> {
    let esperados = stmt.parameter_count();
    if valores.len() != esperados {
        // El aviso sube a la telemetría; la sentencia, no (OBS-02): va a `debug`, que no se
        // reenvía, y se ve en el log local arrancando con `TPV_LOG=info,tpv::sql=debug`.
        tracing::warn!(target: "tpv::sql", esperados, recibidos = valores.len(),
            "una sentencia no recibe los parámetros que espera");
        let sql: String = sql.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect();
        tracing::debug!(target: "tpv::sql", sql = %sql, "la sentencia del aviso anterior");
    }
    for (i, v) in valores.iter().take(esperados).enumerate() {
        stmt.raw_bind_parameter(i + 1, v)?;
    }
    Ok(())
}

const MAX_PENDIENTES: usize = 32;
const FILAS_POR_LOTE: usize = 64;

/// Lo que vive en el hilo de una conexión. Las sentencias de los cursores toman prestada la conexión,
/// así que los dos son locales del hilo y los cursores se sueltan antes que ella.
struct Estado<'c> {
    conn: &'c rusqlite::Connection,
    cursores: HashMap<u64, Cursor<'c>>,
}

type Trabajo = Box<dyn for<'c> FnOnce(&mut Estado<'c>) + Send>;
enum Mensaje { Trabajo(Trabajo), Cerrar(oneshot::Sender<()>) }

/// Una consulta abierta. Sus filas se calculan al pedirlas, por lotes: una consulta que devuelve
/// muchas no se carga de golpe, y una lenta no bloquea el hilo más de lo que tarda cada lote.
struct Cursor<'c> {
    stmt: rusqlite::CachedStatement<'c>,
    /// El primer paso se da al abrir la consulta (ver `query`); su resultado espera aquí al primer lote.
    primero: Option<Result<Option<Vec<Value>>, ErrorSql>>,
}

impl Cursor<'_> {
    /// Avanza una fila.
    ///
    /// El `Rows` de rusqlite reinicia la sentencia al soltarse, y aquí la siguiente llamada tiene que
    /// seguir donde iba: por eso el `Rows` de cada paso se olvida en vez de soltarse. Al llegar al
    /// final, o al fallar, rusqlite ya la ha reiniciado.
    fn paso(&mut self) -> Result<Option<Vec<Value>>, ErrorSql> {
        let mut filas = self.stmt.raw_query();
        let r = match filas.next() {
            Ok(Some(f)) => {
                // Las columnas se cuentan en cada fila: una sentencia de la caché que SQLite vuelve a
                // preparar porque cambió el esquema puede no tener las mismas que al prepararla.
                let columnas = f.as_ref().column_count();
                (0..columnas).map(|i| f.get_ref(i).map(valor)).collect::<Result<Vec<_>, _>>().map(Some).map_err(ErrorSql::from)
            }
            Ok(None) => Ok(None),
            Err(e) => Err(e.into()),
        };
        std::mem::forget(filas);
        r
    }
}

/// Copia el valor de una columna. Un texto con UTF-8 inválido se lee con sustituciones (`U+FFFD`):
/// no hace fallar la consulta entera.
fn valor(v: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::Integer(n),
        ValueRef::Real(n) => Value::Real(n),
        ValueRef::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Blob(b.to_vec()),
    }
}

impl Drop for Cursor<'_> {
    fn drop(&mut self) {
        // Un cursor que se suelta a medias tiene la sentencia en curso, y con ella una lectura
        // abierta. Soltar un `Rows` nuevo la reinicia antes de que vuelva a la caché; si ya estaba
        // reiniciada, no hace nada.
        drop(self.stmt.raw_query());
    }
}

struct Ejecutor {
    cola: mpsc::Sender<Mensaje>,
    admision: Arc<Semaphore>,
    siguiente: AtomicU64,
}

fn cerrado() -> ErrorSql { ErrorSql::Misuse("El ejecutor de SQLite se ha cerrado".into()) }

impl Ejecutor {
    async fn pedir<T: Send + 'static>(
        &self,
        f: impl for<'c> FnOnce(&mut Estado<'c>) -> Result<T, ErrorSql> + Send + 'static,
    ) -> Result<T, ErrorSql> {
        // El permiso acompaña al trabajo, incluso si el solicitante cancela su Future.
        let permiso = self.admision.clone().acquire_owned().await.map_err(|_| cerrado())?;
        let (tx, rx) = oneshot::channel();
        self.cola.send(Mensaje::Trabajo(Box::new(move |estado: &mut Estado<'_>| {
            let _permiso = permiso;
            let _ = tx.send(f(estado));
        }))).map_err(|_| cerrado())?;
        rx.await.map_err(|_| cerrado())?
    }

    fn limpiar(&self, f: impl for<'c> FnOnce(&mut Estado<'c>) + Send + 'static) {
        // Control de vida: no puede esperar ni perderse por saturación durante un Drop.
        // Sólo los trabajos admitidos y sus cursores generan estas limpiezas.
        let _ = self.cola.send(Mensaje::Trabajo(Box::new(f)));
    }
}

/// Fachada async, también para SQL local sin captura (`raw`). No expone la conexión nativa.
#[derive(Clone)]
pub struct Connection { ejecutor: Arc<Ejecutor> }

impl Connection {
    pub(crate) fn nueva(conn: rusqlite::Connection, nombre: &str) -> Result<Self, std::io::Error> {
        let (cola, entrada) = mpsc::channel::<Mensaje>();
        std::thread::Builder::new().name(nombre.into()).spawn(move || {
            let conn = conn;
            let mut estado = Estado { conn: &conn, cursores: HashMap::new() };
            let mut cierre = None;
            while let Ok(mensaje) = entrada.recv() {
                let trabajo = match mensaje {
                    Mensaje::Trabajo(t) => t,
                    Mensaje::Cerrar(tx) => { cierre = Some(tx); break; }
                };
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| trabajo(&mut estado))).is_err() {
                    // No reutilizar una conexión cuyo trabajo haya entrado en pánico.
                    tracing::error!("El ejecutor de SQLite terminó por un pánico");
                    break;
                }
            }
            // Los cursores antes que la conexión: sus sentencias la necesitan para finalizarse.
            drop(estado);
            if !conn.is_autocommit() {
                if let Err(e) = conn.execute_batch("ROLLBACK;") {
                    tracing::error!(error = %e, "No se pudo revertir al cerrar SQLite");
                }
            }
            drop(conn);
            if let Some(tx) = cierre { let _ = tx.send(()); }
        })?;
        Ok(Self { ejecutor: Arc::new(Ejecutor { cola, admision: Arc::new(Semaphore::new(MAX_PENDIENTES)), siguiente: AtomicU64::new(1) }) })
    }

    /// Una sentencia que no devuelve filas. Devuelve las filas que cambió.
    pub async fn execute(&self, sql: &str, params: impl Bindable) -> Result<u64, ErrorSql> {
        let sql = sql.to_owned();
        let valores = params.into_values();
        self.ejecutor.pedir(move |s| {
            let mut stmt = s.conn.prepare_cached(&sql)?;
            enlazar(&mut stmt, &valores, &sql)?;
            Ok(stmt.raw_execute()? as u64)
        }).await
    }

    /// Varias sentencias seguidas, sin parámetros. Las filas que devuelva alguna se descartan.
    pub async fn execute_batch(&self, sql: &str) -> Result<(), ErrorSql> {
        let sql = sql.to_owned();
        self.ejecutor.pedir(move |s| Ok(s.conn.execute_batch(&sql)?)).await
    }

    /// Una consulta. El primer paso se da aquí: una consulta lenta tarda en `query`, el error de
    /// prepararla sale aquí y el de ejecutarla, en el primer `next()`.
    pub async fn query(&self, sql: &str, params: impl Bindable) -> Result<Rows, ErrorSql> {
        let sql = sql.to_owned();
        let valores = params.into_values();
        let ejecutor = self.ejecutor.clone();
        let id = ejecutor.siguiente.fetch_add(1, Ordering::Relaxed);
        self.ejecutor.pedir(move |s| {
            let conn = s.conn;
            let mut stmt = conn.prepare_cached(&sql)?;
            enlazar(&mut stmt, &valores, &sql)?;
            let mut cursor = Cursor { stmt, primero: None };
            cursor.primero = Some(cursor.paso());
            s.cursores.insert(id, cursor);
            Ok(Rows { ejecutor, id, lote: VecDeque::new(), terminadas: false, pendiente: None })
        }).await
    }

    /// Una **foto** de la base: `trabajo` corre entero en el hilo de la conexión, dentro de una
    /// transacción de lectura y con la conexión en `query_only`.
    ///
    /// Es para leer mucho de una vez y que todo salga del mismo instante (el contraste con la nube,
    /// que resume cientos de miles de filas): las filas no se copian ni cruzan de hilo, y mientras
    /// dura esta conexión no atiende a nadie más. Pensada para una conexión de lectura.
    ///
    /// Al terminar, acabe como acabe, la transacción se cierra y la conexión vuelve a admitir
    /// escrituras (las de lectura hacen las copias con `VACUUM INTO`). Si quien llama cancela su
    /// `Future`, el trabajo termina igual en su hilo y deja la conexión como estaba.
    pub(crate) async fn foto<T: Send + 'static>(
        &self,
        trabajo: impl for<'c> FnOnce(&Foto<'c>) -> Result<T, ErrorSql> + Send + 'static,
    ) -> Result<T, ErrorSql> {
        self.ejecutor.pedir(move |s| {
            let conn = s.conn;
            conn.execute_batch("PRAGMA query_only = ON;")?;
            let resultado = conn.execute_batch("BEGIN;").map_err(ErrorSql::from).and_then(|()| trabajo(&Foto { conn }));
            // Lo que lea queda atrás aunque el trabajo falle: se cierra la lectura y se devuelve la
            // conexión a como estaba. Si eso falla, el error que cuenta es el del trabajo.
            if !conn.is_autocommit() {
                if let Err(e) = conn.execute_batch("ROLLBACK;") {
                    tracing::error!(error = %e, "No se pudo cerrar la foto de SQLite");
                }
            }
            let reabierta = conn.execute_batch("PRAGMA query_only = OFF;").map_err(ErrorSql::from);
            match (resultado, reabierta) {
                (Err(e), _) => Err(e),
                (Ok(_), Err(e)) => Err(e),
                (Ok(v), Ok(())) => Ok(v),
            }
        }).await
    }

    pub(crate) async fn sanear(&self) -> Result<(), ErrorSql> {
        self.ejecutor.pedir(|s| {
            if !s.conn.is_autocommit() { s.conn.execute_batch("ROLLBACK;")?; }
            Ok(())
        }).await
    }

    pub(crate) fn revertir_al_soltar(&self) {
        self.ejecutor.limpiar(|s| {
            if !s.conn.is_autocommit() {
                if let Err(e) = s.conn.execute_batch("ROLLBACK;") {
                    tracing::error!(error = %e, "No se pudo revertir la operación abandonada");
                }
            }
        });
    }

    pub(crate) async fn cerrar(&self) -> Result<(), ErrorSql> {
        self.ejecutor.admision.close();
        let (tx, rx) = oneshot::channel();
        self.ejecutor.cola.send(Mensaje::Cerrar(tx)).map_err(|_| cerrado())?;
        rx.await.map_err(|_| cerrado())
    }
}

/// El valor de una columna de la fila en curso, **prestado**: vale mientras dura la llamada que lo
/// recibe. El texto va en sus bytes, sin validar ni copiar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ValorPrestado<'a> {
    Null,
    Integer(i64),
    Real(f64),
    Text(&'a [u8]),
    Blob(&'a [u8]),
}

impl ValorPrestado<'_> {
    /// Una copia que se puede guardar. El texto con UTF-8 inválido, con sustituciones (`U+FFFD`).
    pub fn copia(&self) -> Value {
        match *self {
            ValorPrestado::Null => Value::Null,
            ValorPrestado::Integer(n) => Value::Integer(n),
            ValorPrestado::Real(x) => Value::Real(x),
            ValorPrestado::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
            ValorPrestado::Blob(b) => Value::Blob(b.to_vec()),
        }
    }
}

/// ¿Empieza `sql` como una lectura? `SELECT` o `WITH`, con espacio o comentarios delante o sin
/// ellos. Es la primera de las tres cosas que se le piden a una sentencia que viene de fuera; las
/// otras dos las dice SQLite (que sea una sola, y que no escriba).
fn empieza_como_lectura(sql: &str) -> bool {
    let mut resto = sql.trim_start();
    loop {
        if let Some(tras) = resto.strip_prefix("--") {
            resto = tras.find('\n').map_or("", |i| tras[i + 1..].trim_start());
        } else if let Some(tras) = resto.strip_prefix("/*") {
            resto = tras.find("*/").map_or("", |i| tras[i + 2..].trim_start());
        } else {
            break;
        }
    }
    ["SELECT", "WITH"].iter().any(|palabra| {
        resto.get(..palabra.len()).is_some_and(|cabeza| cabeza.eq_ignore_ascii_case(palabra))
            && !resto[palabra.len()..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// Las lecturas de una [`Connection::foto`]. Todas ven la base del mismo instante.
pub struct Foto<'c> {
    conn: &'c rusqlite::Connection,
}

impl Foto<'_> {
    /// Prepara UNA sentencia de sólo lectura. Lo que no lo sea se rechaza sin ejecutarlo: lo que
    /// no empieza por `SELECT` o `WITH`, un texto con más de una sentencia y lo que SQLite dice
    /// que escribe (un `WITH … DELETE` empieza como una lectura). Con la conexión en `query_only`
    /// tampoco podría escribir; esto lo dice antes y con su nombre.
    fn preparar(&self, sql: &str) -> Result<rusqlite::Statement<'_>, ErrorSql> {
        if !empieza_como_lectura(sql) {
            return Err(ErrorSql::Misuse("la sentencia no empieza como una lectura".into()));
        }
        let stmt = self.conn.prepare(sql)?;
        if !stmt.readonly() {
            return Err(ErrorSql::Misuse("la sentencia no es de sólo lectura".into()));
        }
        Ok(stmt)
    }

    /// Ejecuta una lectura y entrega sus filas de una en una, sin copiarlas. Devuelve los nombres
    /// de sus columnas. Si `fila` devuelve un error, la lectura para ahí y sale con él.
    pub fn recorrer(
        &self,
        sql: &str,
        args: &[Value],
        mut fila: impl FnMut(&[ValorPrestado<'_>]) -> Result<(), ErrorSql>,
    ) -> Result<Vec<String>, ErrorSql> {
        let mut stmt = self.preparar(sql)?;
        let columnas: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
        enlazar(&mut stmt, args, sql)?;
        let mut filas = stmt.raw_query();
        while let Some(f) = filas.next()? {
            let mut valores = Vec::with_capacity(columnas.len());
            for i in 0..columnas.len() {
                use rusqlite::types::ValueRef;
                valores.push(match f.get_ref(i)? {
                    ValueRef::Null => ValorPrestado::Null,
                    ValueRef::Integer(n) => ValorPrestado::Integer(n),
                    ValueRef::Real(x) => ValorPrestado::Real(x),
                    ValueRef::Text(t) => ValorPrestado::Text(t),
                    ValueRef::Blob(b) => ValorPrestado::Blob(b),
                });
            }
            fila(&valores)?;
        }
        Ok(columnas)
    }

    /// Las filas de una lectura, copiadas. Para las que son pocas.
    pub fn filas(&self, sql: &str, args: &[Value]) -> Result<Vec<Vec<Value>>, ErrorSql> {
        let mut salida = Vec::new();
        self.recorrer(sql, args, |valores| {
            salida.push(valores.iter().map(ValorPrestado::copia).collect());
            Ok(())
        })?;
        Ok(salida)
    }

    /// El primer valor de la primera fila, como entero: lo que devuelve un `COUNT(*)` o un `MAX`.
    /// `None` sin filas, o si ese valor no es un entero.
    pub fn entero(&self, sql: &str, args: &[Value]) -> Result<Option<i64>, ErrorSql> {
        Ok(self.filas(sql, args)?.first().and_then(|f| match f.first() {
            Some(Value::Integer(n)) => Some(*n),
            _ => None,
        }))
    }
}

/// Valores copiados en el hilo SQL: leer una columna ya no accede al motor nativo.
#[derive(Debug)]
pub struct Row { valores: Vec<Value> }

impl Row {
    pub fn get_value(&self, idx: i32) -> Result<Value, ErrorSql> {
        self.valores.get(usize::try_from(idx).map_err(|_| ErrorSql::InvalidColumnIndex)?).cloned().ok_or(ErrorSql::InvalidColumnIndex)
    }
    pub fn get<T: FromValue>(&self, idx: i32) -> Result<T, ErrorSql> { T::from_value(self.get_value(idx)?) }
}

/// Conversiones usadas por los repositorios; tipos incorrectos son errores, nunca pánicos.
pub trait FromValue: Sized { fn from_value(v: Value) -> Result<Self, ErrorSql>; }
impl FromValue for i64 {
    fn from_value(v: Value) -> Result<Self, ErrorSql> {
        match v { Value::Integer(n) => Ok(n), Value::Null => Err(ErrorSql::NullValue), _ => Err(ErrorSql::InvalidColumnType) }
    }
}
impl FromValue for f64 {
    fn from_value(v: Value) -> Result<Self, ErrorSql> {
        match v { Value::Real(n) => Ok(n), Value::Null => Err(ErrorSql::NullValue), _ => Err(ErrorSql::InvalidColumnType) }
    }
}
impl FromValue for String {
    fn from_value(v: Value) -> Result<Self, ErrorSql> {
        match v { Value::Text(s) => Ok(s), Value::Null => Err(ErrorSql::NullValue), _ => Err(ErrorSql::InvalidColumnType) }
    }
}

/// Cursor paginado. Como máximo mantiene un lote de valores materializados.
pub struct Rows {
    ejecutor: Arc<Ejecutor>,
    id: u64,
    lote: VecDeque<Result<Row, ErrorSql>>,
    terminadas: bool,
    pendiente: Option<PeticionLote>,
}
type Lote = (VecDeque<Result<Row, ErrorSql>>, bool);
type PeticionLote = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Lote, ErrorSql>> + Send>>;

/// Mete en el lote lo que dio un paso del cursor. Devuelve si el cursor ha terminado.
fn meter(lote: &mut VecDeque<Result<Row, ErrorSql>>, paso: Result<Option<Vec<Value>>, ErrorSql>) -> bool {
    match paso {
        Ok(Some(valores)) => { lote.push_back(Ok(Row { valores })); false }
        Ok(None) => true,
        Err(e) => { lote.push_back(Err(e)); true }
    }
}

impl Rows {
    pub async fn next(&mut self) -> Result<Option<Row>, ErrorSql> {
        if self.lote.is_empty() && !self.terminadas {
            let id = self.id;
            if self.pendiente.is_none() {
                let ejecutor = self.ejecutor.clone();
                self.pendiente = Some(Box::pin(async move { ejecutor.pedir(move |s| {
                    let mut lote = VecDeque::new();
                    let mut terminadas = true;
                    if let Some(cursor) = s.cursores.get_mut(&id) {
                        terminadas = match cursor.primero.take() {
                            Some(primero) => meter(&mut lote, primero),
                            None => false,
                        };
                        while !terminadas && lote.len() < FILAS_POR_LOTE {
                            terminadas = meter(&mut lote, cursor.paso());
                        }
                    }
                    if terminadas { s.cursores.remove(&id); }
                    Ok((lote, terminadas))
                }).await }));
            }
            // Conservar la petición en el cursor hace next() seguro frente a select!/cancelación.
            let resultado = self.pendiente.as_mut().expect("petición del lote creada").await;
            self.pendiente = None;
            let (lote, terminadas) = resultado?;
            self.lote = lote;
            self.terminadas = terminadas;
        }
        self.lote.pop_front().transpose()
    }
}

impl Drop for Rows {
    fn drop(&mut self) {
        let id = self.id;
        self.ejecutor.limpiar(move |s| { s.cursores.remove(&id); });
    }
}
