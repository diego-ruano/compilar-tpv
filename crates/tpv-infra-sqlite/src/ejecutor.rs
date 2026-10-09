//! RI-16: libsql local ejecuta SQLite sin ceder. Cada conexión pertenece a un hilo;
//! Tokio sólo espera respuestas. Los cursores nativos nunca salen de ese hilo.

use std::collections::{HashMap, VecDeque};
use std::sync::{mpsc, Arc};
use std::sync::atomic::{AtomicU64, Ordering};
use libsql::{Error, Value};
use tokio::runtime::Handle;
use tokio::sync::{oneshot, Semaphore};

const MAX_PENDIENTES: usize = 32;
const FILAS_POR_LOTE: usize = 64;
type Trabajo = Box<dyn FnOnce(&mut Estado, &Handle) + Send>;
enum Mensaje { Trabajo(Trabajo), Cerrar(oneshot::Sender<()>) }

struct Estado {
    conn: libsql::Connection,
    cursores: HashMap<u64, libsql::Rows>,
}

struct Ejecutor {
    cola: mpsc::Sender<Mensaje>,
    admision: Arc<Semaphore>,
    siguiente: AtomicU64,
}

fn cerrado() -> Error { Error::Misuse("El ejecutor de SQLite se ha cerrado".into()) }

impl Ejecutor {
    async fn pedir<T: Send + 'static>(&self, f: impl FnOnce(&mut Estado, &Handle) -> Result<T, Error> + Send + 'static) -> Result<T, Error> {
        // El permiso acompaña al trabajo, incluso si el solicitante cancela su Future.
        let permiso = self.admision.clone().acquire_owned().await.map_err(|_| cerrado())?;
        let (tx, rx) = oneshot::channel();
        self.cola.send(Mensaje::Trabajo(Box::new(move |estado, rt| {
            let _permiso = permiso;
            let _ = tx.send(f(estado, rt));
        }))).map_err(|_| cerrado())?;
        rx.await.map_err(|_| cerrado())?
    }

    fn limpiar(&self, f: impl FnOnce(&mut Estado, &Handle) + Send + 'static) {
        // Control de vida: no puede esperar ni perderse por saturación durante un Drop.
        // Sólo los trabajos admitidos y sus cursores generan estas limpiezas.
        let _ = self.cola.send(Mensaje::Trabajo(Box::new(f)));
    }
}

/// Fachada async, también para SQL local sin captura (`raw`). No expone la conexión nativa.
#[derive(Clone)]
pub struct Connection { ejecutor: Arc<Ejecutor> }

impl Connection {
    pub(crate) fn nueva(conn: libsql::Connection, nombre: &str) -> Result<Self, std::io::Error> {
        let rt = Handle::current();
        let (cola, entrada) = mpsc::channel::<Mensaje>();
        std::thread::Builder::new().name(nombre.into()).spawn(move || {
            let mut estado = Estado { conn, cursores: HashMap::new() };
            let mut cierre = None;
            while let Ok(mensaje) = entrada.recv() {
                let trabajo = match mensaje {
                    Mensaje::Trabajo(t) => t,
                    Mensaje::Cerrar(tx) => { cierre = Some(tx); break; }
                };
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| trabajo(&mut estado, &rt))).is_err() {
                    // No reutilizar una conexión cuyo trabajo haya entrado en pánico.
                    tracing::error!("El ejecutor de SQLite terminó por un pánico");
                    break;
                }
            }
            estado.cursores.clear();
            if !estado.conn.is_autocommit() {
                if let Err(e) = rt.block_on(estado.conn.execute_batch("ROLLBACK;")) {
                    tracing::error!(error = %e, "No se pudo revertir al cerrar SQLite");
                }
            }
            // Conexión y sentencias se destruyen aquí, fuera del runtime async.
            drop(estado);
            if let Some(tx) = cierre { let _ = tx.send(()); }
        })?;
        Ok(Self { ejecutor: Arc::new(Ejecutor { cola, admision: Arc::new(Semaphore::new(MAX_PENDIENTES)), siguiente: AtomicU64::new(1) }) })
    }

    pub async fn execute(&self, sql: &str, params: impl libsql::params::IntoParams) -> Result<u64, Error> {
        let sql = sql.to_owned();
        let params = params.into_params()?;
        self.ejecutor.pedir(move |s, rt| rt.block_on(s.conn.execute(&sql, params))).await
    }

    pub async fn execute_batch(&self, sql: &str) -> Result<(), Error> {
        let sql = sql.to_owned();
        self.ejecutor.pedir(move |s, rt| rt.block_on(s.conn.execute_batch(&sql)).map(|_| ())).await
    }

    pub async fn query(&self, sql: &str, params: impl libsql::params::IntoParams) -> Result<Rows, Error> {
        let sql = sql.to_owned();
        let params = params.into_params()?;
        let ejecutor = self.ejecutor.clone();
        let id = ejecutor.siguiente.fetch_add(1, Ordering::Relaxed);
        self.ejecutor.pedir(move |s, rt| {
            let cursor = rt.block_on(s.conn.query(&sql, params))?;
            s.cursores.insert(id, cursor);
            Ok(Rows { ejecutor, id, lote: VecDeque::new(), terminadas: false, pendiente: None })
        }).await
    }

    pub(crate) async fn sanear(&self) -> Result<(), Error> {
        self.ejecutor.pedir(|s, rt| {
            if !s.conn.is_autocommit() { rt.block_on(s.conn.execute_batch("ROLLBACK;"))?; }
            Ok(())
        }).await
    }

    pub(crate) fn revertir_al_soltar(&self) {
        self.ejecutor.limpiar(|s, rt| {
            if !s.conn.is_autocommit() {
                if let Err(e) = rt.block_on(s.conn.execute_batch("ROLLBACK;")) {
                    tracing::error!(error = %e, "No se pudo revertir la operación abandonada");
                }
            }
        });
    }

    pub(crate) async fn cerrar(&self) -> Result<(), Error> {
        self.ejecutor.admision.close();
        let (tx, rx) = oneshot::channel();
        self.ejecutor.cola.send(Mensaje::Cerrar(tx)).map_err(|_| cerrado())?;
        rx.await.map_err(|_| cerrado())
    }
}

/// Valores copiados en el hilo SQL: leer una columna ya no accede al motor nativo.
#[derive(Debug)]
pub struct Row { valores: Vec<Value> }

impl Row {
    pub fn get_value(&self, idx: i32) -> Result<Value, Error> {
        self.valores.get(usize::try_from(idx).map_err(|_| Error::InvalidColumnIndex)?).cloned().ok_or(Error::InvalidColumnIndex)
    }
    pub fn get<T: FromValue>(&self, idx: i32) -> Result<T, Error> { T::from_value(self.get_value(idx)?) }
}

/// Conversiones usadas por los repositorios; tipos incorrectos son errores, nunca pánicos.
pub trait FromValue: Sized { fn from_value(v: Value) -> Result<Self, Error>; }
impl FromValue for i64 {
    fn from_value(v: Value) -> Result<Self, Error> {
        match v { Value::Integer(n) => Ok(n), Value::Null => Err(Error::NullValue), _ => Err(Error::InvalidColumnType) }
    }
}
impl FromValue for f64 {
    fn from_value(v: Value) -> Result<Self, Error> {
        match v { Value::Real(n) => Ok(n), Value::Null => Err(Error::NullValue), _ => Err(Error::InvalidColumnType) }
    }
}
impl FromValue for String {
    fn from_value(v: Value) -> Result<Self, Error> {
        match v { Value::Text(s) => Ok(s), Value::Null => Err(Error::NullValue), _ => Err(Error::InvalidColumnType) }
    }
}

/// Cursor paginado. Como máximo mantiene un lote de valores materializados.
pub struct Rows {
    ejecutor: Arc<Ejecutor>,
    id: u64,
    lote: VecDeque<Result<Row, Error>>,
    terminadas: bool,
    pendiente: Option<PeticionLote>,
}
type Lote = (VecDeque<Result<Row, Error>>, bool);
type PeticionLote = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Lote, Error>> + Send>>;

impl Rows {
    pub async fn next(&mut self) -> Result<Option<Row>, Error> {
        if self.lote.is_empty() && !self.terminadas {
            let id = self.id;
            if self.pendiente.is_none() {
                let ejecutor = self.ejecutor.clone();
                self.pendiente = Some(Box::pin(async move { ejecutor.pedir(move |s, rt| {
                let mut lote = VecDeque::new();
                let mut terminadas = false;
                if let Some(cursor) = s.cursores.get_mut(&id) {
                    for _ in 0..FILAS_POR_LOTE {
                        let fila = rt.block_on(cursor.next()).and_then(|r| r.map(|r| {
                            let valores = (0..r.column_count()).map(|i| r.get_value(i)).collect::<Result<Vec<_>, _>>()?;
                            Ok(Row { valores })
                        }).transpose());
                        match fila {
                            Ok(Some(r)) => lote.push_back(Ok(r)),
                            Ok(None) => { terminadas = true; break; }
                            Err(e) => { lote.push_back(Err(e)); terminadas = true; break; }
                        }
                    }
                } else { terminadas = true; }
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
        self.ejecutor.limpiar(move |s, _| { s.cursores.remove(&id); });
    }
}
