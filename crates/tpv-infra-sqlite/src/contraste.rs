//! El contraste con la nube, por resúmenes: el lado de la Main.
//!
//! La nube manda, por tabla, cuántas filas tiene, la sentencia de su ventana y el resumen por cubos
//! de lo que esa sentencia devuelve (`/v1/sync/verificar/resumen`; `tpv_domain::contraste` dice
//! cómo se resume). Aquí se ejecuta **esa misma sentencia** sobre la base local, se resume igual y
//! se comparan los dos resúmenes. Lo que cuadra, cuadra sin haber bajado una fila. De lo que no:
//!
//! 1. **Dentro de la ventana**, se bajan las filas de los cubos que no cuadran
//!    (`/v1/sync/verificar/filas`) y cada una se compara con la de aquí, con la tolerancia de
//!    siempre (`sync_reparacion::fila_difiere`): distinta, o sobra arriba. Las de aquí que caen en
//!    esos cubos y no han venido, faltan arriba.
//! 2. **Fuera de la ventana** sólo hay conteos. Si el de una tabla no cuadra, se recorren sus claves
//!    por páginas y en orden (`/v1/sync/verificar/claves`), y de cada tramo se restan las de aquí.
//!
//! Y se repara como siempre, por estado y por el outbox (`sync_reparacion`).
//!
//! Antes de comparar, lo que no entró de la bajada y está en cuarentena se trae de la nube por
//! estado con la foto del resumen (`cuarentenas_bajada.rs`, SYNC-36): con una cuarentena no se
//! repara nada, y así sale.
//!
//! # Las dos fotos tienen que ser del mismo instante
//!
//! Comparar la nube de las 9:00 con la base de las 9:01 da por descuadre lo que se ha vendido en
//! ese minuto. Así que sólo se compara si esta Main puede afirmar que no hay nada de aquí por subir
//! ni nada de allí por bajar, y que sigue siendo así en cada paso:
//!
//! - **De aquí**: la [`MarcaLocal`] (checkpoint, contador de escrituras, pendientes de subir, filas
//!   apuntadas para la convergencia) se lee
//!   antes de pedir el resumen, otra vez dentro de la foto que resume la base, otra vez antes de
//!   mirar las filas que faltan arriba y, con el escritor cogido, justo antes de encolar. Si en
//!   algún momento no es la misma, la pasada se deja sin tocar nada ([`ContrasteLocal::SeHaMovido`]).
//! - **De allí**: el resumen dice hasta qué `Seq` llega su foto y que por encima del checkpoint de
//!   esta Main no hay nada ajeno; cada página de filas o de claves trae su `Seq`, y tiene que ser el
//!   mismo.
//!
//! Con eso no hace falta tener una transacción de lectura abierta mientras se habla con la nube: si
//! la marca no ha cambiado entre el principio y el final, la base no ha cambiado entre medias.
//!
//! # Lo que llega de fuera
//!
//! La sentencia de cada tabla la escribe el worker y aquí se ejecuta tal cual: es lo que hace que
//! la definición de la ventana viva en un solo sitio. Se ejecuta por [`Connection::foto`], que sólo
//! admite UNA sentencia que empiece por `SELECT` o `WITH` y que SQLite dé por de sólo lectura, en
//! una conexión de lectura puesta en `query_only`. Una sentencia que esta versión no sepa ejecutar
//! (una columna que aquí no existe) deja esa tabla sin comparar; no hace fallar la pasada.
//!
//! Y lo que se baja para comparar se comprueba contra el resumen del que sale: las filas de cada
//! cubo pedido tienen que sumar lo que el resumen decía de ese cubo. Si no, esas filas no son las de
//! la foto, y de esa tabla no se repara nada.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::sync::{
    ContrasteLocal, MarcaLocal, PaginasDelContraste, PedidoDeClaves, PedidoDeFilas, PedidoPorClave,
};
use tpv_contracts::sync::{
    DescuadreTabla, ResultadoVerificacion, ResumenNube, ResumenTabla, SqlStatement,
};
use tpv_domain::contraste::{self as cubos, Celda, ResumenCubos, Resumidor};

use crate::consultas::db_err;
use crate::db::{Db, Writer};
use crate::ejecutor::{Connection, ErrorSql, Foto, ValorPrestado, Value};
use crate::sync_reparacion::{self as rep, FilaAfectada};
use crate::util::now_ms;

/// Lo más que una pasada baja de la nube para comparar fila a fila. Con todo en orden no baja
/// nada; con una fila distinta, su cubo (una de cada 256 partes de su tabla). Esto es para el día
/// en que no cuadra media base: se repara lo que quepa y el resto queda para la pasada siguiente,
/// que ya no encuentra lo reparado.
pub(crate) const MAX_FILAS_POR_PASADA: i64 = 250_000;

/// Lo más que una pasada recorre de claves de la nube, fuera de la ventana.
pub(crate) const MAX_CLAVES_POR_PASADA: i64 = 2_000_000;

/// Sentencias por operación de reparación. Una operación sube en un mensaje y la nube la aplica en
/// una transacción: partida, ni el mensaje ni la transacción crecen con el descuadre.
const SENTENCIAS_POR_OPERACION: usize = 500;

/// Lo que la base dice, de una vez, de si se puede tocar algo arriba.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Guarda {
    marca: MarcaLocal,
    /// No hay ningún cambio de la nube sin aplicar en `_Sync_Failed`, en cuarentena o no (AUD-18).
    sin_fallos: bool,
    /// No queda histórico por bajar tras una recuperación (VERIF-01).
    historico_completo: bool,
}

impl Guarda {
    /// ¿Se puede encolar algo? Sólo con la base como estaba al pedir el resumen, sin un cambio de
    /// la nube que aquí no ha entrado (lo que no cuadra puede ser lo que hizo él) y con todo el
    /// histórico en casa (lo que falta aquí puede ser lo que aún no ha bajado).
    fn deja_reparar(&self, marca: &MarcaLocal) -> bool {
        self.marca == *marca && self.sin_fallos && self.historico_completo
    }
}

pub(crate) fn leer_marca(foto: &Foto<'_>) -> Result<MarcaLocal, ErrorSql> {
    Ok(MarcaLocal {
        checkpoint: foto.entero("SELECT Last_Seq FROM _Sync_State WHERE Id = 1;", &[])?.unwrap_or(0),
        // El contador de un `AUTOINCREMENT` no vuelve atrás aunque se vacíe la tabla: es cuántas
        // operaciones ha generado esta base en toda su vida.
        escrituras: foto
            .entero("SELECT seq FROM sqlite_sequence WHERE name = '_Sync_Outbox';", &[])?
            .unwrap_or(0),
        // Lo apartado no cuenta: no va a subir solo, y repararlo es cosa de este contraste.
        pendientes: foto.entero("SELECT COUNT(*) FROM _Sync_Outbox WHERE Cuarentena = 0;", &[])?.unwrap_or(0),
        // SYNC-29: lo que la convergencia escribe aquí no pasa por el outbox ni mueve el checkpoint.
        apuntadas: foto.entero("SELECT COUNT(*) FROM _Sync_Por_Contrastar;", &[])?.unwrap_or(0),
    })
}

fn leer_guarda(foto: &Foto<'_>) -> Result<Guarda, ErrorSql> {
    Ok(Guarda {
        marca: leer_marca(foto)?,
        sin_fallos: foto.entero("SELECT COUNT(*) FROM _Sync_Failed;", &[])?.unwrap_or(0) == 0,
        historico_completo: foto
            .entero("SELECT COUNT(*) FROM _Backfill_Historico WHERE Completada = 0;", &[])?
            .unwrap_or(0)
            == 0,
    })
}

/// La marca de la base ahora mismo, leída de una vez.
pub(crate) async fn marca(db: &Db) -> AppResult<MarcaLocal> {
    let r = db.read().await;
    r.conn().foto(leer_marca).await.map_err(db_err)
}

/* ===== La foto local ===== */

/// La ventana de una tabla, comparada por resúmenes.
struct Ventana {
    sql: String,
    args: Vec<Value>,
    columnas: Vec<String>,
    claves: Vec<String>,
    /// Dónde está cada columna de la clave dentro de `columnas`.
    posiciones: Vec<usize>,
    /// El resumen de la nube, para comprobar contra él las filas que se bajen.
    nube: ResumenCubos,
    /// Las filas de cada cubo aquí: con las de la nube, lo que costará examinar un cubo.
    cuentas_locales: Vec<u64>,
    /// Los cubos que no cuadran.
    distintos: Vec<u32>,
}

/// Lo que la foto local dice de una tabla del resumen.
struct TablaLocal {
    nombre: String,
    total_local: i64,
    total_nube: i64,
    /// Filas de la ventana aquí y en la nube; cero las dos si la ventana no se compara.
    filas_local: i64,
    filas_nube: i64,
    /// Las columnas de su clave primaria aquí. Vacío: no tiene.
    claves: Vec<String>,
    /// Las tablas del resumen a las que apunta por sus claves foráneas.
    padres: HashSet<String>,
    ventana: Option<Ventana>,
}

struct FotoLocal {
    guarda: Guarda,
    /// Las tablas del resumen que existen aquí, **padres primero**: una fila nunca se examina ni se
    /// repara antes que aquélla de la que depende.
    tablas: Vec<TablaLocal>,
    sin_comparar: Vec<String>,
}

fn nombre_aceptable(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !n.starts_with('_')
}

fn celda<'a>(v: &ValorPrestado<'a>) -> Celda<'a> {
    match *v {
        ValorPrestado::Null => Celda::Nulo,
        ValorPrestado::Integer(n) => Celda::entero(n),
        ValorPrestado::Real(x) => Celda::Numero(x),
        ValorPrestado::Text(t) => Celda::Texto(t),
        ValorPrestado::Blob(b) => Celda::Blob(b),
    }
}

/// Un argumento de la sentencia de la ventana, tal como llega en JSON.
fn argumento(v: &serde_json::Value) -> Option<Value> {
    match v {
        serde_json::Value::Null => Some(Value::Null),
        serde_json::Value::String(s) => Some(Value::Text(s.clone())),
        serde_json::Value::Number(n) => n.as_i64().map(Value::Integer).or_else(|| n.as_f64().map(Value::Real)),
        _ => None,
    }
}

fn claves_primarias(foto: &Foto<'_>, tabla: &str) -> Result<Vec<String>, ErrorSql> {
    Ok(foto
        .filas("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk;", &[Value::Text(tabla.to_string())])?
        .into_iter()
        .filter_map(|f| match f.into_iter().next() {
            Some(Value::Text(nombre)) => Some(nombre),
            _ => None,
        })
        .collect())
}

/// El resumen de la nube de una tabla, si está entero y bien formado.
fn resumen_de_la_nube(t: &ResumenTabla) -> Option<ResumenCubos> {
    let n = t.cubos as usize;
    if !cubos::cubos_validos(t.cubos) || t.cuentas.len() != n || t.sumas.len() != n {
        return None;
    }
    Some(ResumenCubos {
        cuentas: t.cuentas.iter().map(|c| u64::try_from(*c).ok()).collect::<Option<_>>()?,
        sumas: t.sumas.iter().map(|s| cubos::de_hex64(s)).collect::<Option<_>>()?,
    })
}

/// ¿Es el error de una sentencia que esta versión no sabe ejecutar, y no el de la base?
///
/// Lo es lo que SQLite rechaza al prepararla (el código genérico `SQLITE_ERROR`: una tabla o una
/// columna que aquí no existe) y lo que no se deja ejecutar por no ser una lectura. Lo demás —la
/// base ocupada, el disco— es un fallo de la pasada.
fn no_se_sabe_ejecutar(e: &ErrorSql) -> bool {
    match e {
        ErrorSql::SqliteFailure(codigo, _) => codigo & 0xff == 1,
        ErrorSql::Misuse(_) => true,
        _ => false,
    }
}

/// Resume la ventana de una tabla ejecutando la sentencia que manda la nube. `None` si no se puede
/// comparar: otra clave, otras columnas, un resumen mal formado o una sentencia que aquí no corre.
fn resumir_ventana(
    foto: &Foto<'_>,
    t: &ResumenTabla,
    sql: &str,
    claves_locales: &[String],
) -> Result<Option<Ventana>, ErrorSql> {
    let Some(nube) = resumen_de_la_nube(t) else {
        return Ok(None);
    };
    if t.claves.is_empty() || t.claves != claves_locales {
        return Ok(None);
    }
    let Some(posiciones) =
        t.claves.iter().map(|k| t.columnas.iter().position(|c| c == k)).collect::<Option<Vec<usize>>>()
    else {
        return Ok(None);
    };
    let Some(args) = t.args.iter().map(argumento).collect::<Option<Vec<Value>>>() else {
        return Ok(None);
    };
    let Some(mut resumidor) = Resumidor::nuevo(t.cubos) else {
        return Ok(None);
    };

    let ancho = t.columnas.len();
    let recorrida = foto.recorrer(sql, &args, |valores| {
        // Con otro número de columnas no hay nada que resumir: se corta aquí.
        if valores.len() != ancho {
            return Err(ErrorSql::Misuse("la ventana no tiene las columnas del resumen".into()));
        }
        let celdas: Vec<Celda<'_>> = valores.iter().map(celda).collect();
        resumidor.fila(&celdas, &posiciones);
        Ok(())
    });
    let columnas = match recorrida {
        Ok(columnas) => columnas,
        Err(e) if no_se_sabe_ejecutar(&e) => {
            tracing::warn!(target: "tpv::sync", tabla = %t.nombre, error = %e, "contraste: la ventana de la nube no se puede ejecutar aquí");
            return Ok(None);
        }
        Err(e) => return Err(e),
    };
    if columnas != t.columnas {
        return Ok(None);
    }

    let local = resumidor.fin();
    let distintos = local.distintos(&nube).unwrap_or_default();
    Ok(Some(Ventana {
        sql: sql.to_string(),
        args,
        columnas,
        claves: t.claves.clone(),
        posiciones,
        nube,
        cuentas_locales: local.cuentas,
        distintos,
    }))
}

/// Ordena las tablas **padres primero**, siguiendo sus claves foráneas, y dice de cada una a qué
/// tablas apunta. Lo que no se puede ordenar (un ciclo) va detrás, por nombre.
pub(crate) fn padres_primero(foto: &Foto<'_>, nombres: &[String]) -> Result<Vec<(String, HashSet<String>)>, ErrorSql> {
    let mut padres: HashMap<String, HashSet<String>> = HashMap::new();
    for nombre in nombres {
        let de = foto
            .filas("SELECT \"table\" FROM pragma_foreign_key_list(?1);", &[Value::Text(nombre.clone())])?
            .into_iter()
            .filter_map(|f| match f.into_iter().next() {
                Some(Value::Text(padre)) => Some(padre),
                _ => None,
            })
            .collect();
        padres.insert(nombre.clone(), de);
    }
    Ok(ordenar_padres_primero(nombres, &padres))
}

/// Lo de [`padres_primero`] con las foráneas ya leídas: `padres` dice a qué tablas apunta cada una.
/// Sólo cuentan los padres que están en `nombres`, y una tabla que se apunta a sí misma no espera a
/// nadie. Lo que no se puede ordenar (un ciclo) va detrás, por nombre.
pub(crate) fn ordenar_padres_primero(
    nombres: &[String],
    padres: &HashMap<String, HashSet<String>>,
) -> Vec<(String, HashSet<String>)> {
    let presentes: HashSet<&str> = nombres.iter().map(String::as_str).collect();
    let de = |t: &str| -> HashSet<String> {
        padres
            .get(t)
            .map(|ps| ps.iter().filter(|p| p.as_str() != t && presentes.contains(p.as_str())).cloned().collect())
            .unwrap_or_default()
    };
    let padres: HashMap<&str, HashSet<String>> = presentes.iter().map(|t| (*t, de(t))).collect();

    let mut pendientes: Vec<&str> = presentes.iter().copied().collect();
    pendientes.sort_unstable();
    let mut orden: Vec<(String, HashSet<String>)> = Vec::with_capacity(pendientes.len());
    let mut puestas: HashSet<&str> = HashSet::new();
    while !pendientes.is_empty() {
        let listas: Vec<&str> = pendientes
            .iter()
            .copied()
            .filter(|t| padres[t].iter().all(|p| puestas.contains(p.as_str())))
            .collect();
        // Un ciclo: lo que queda, tal cual.
        let tanda = if listas.is_empty() { pendientes.clone() } else { listas };
        for t in &tanda {
            puestas.insert(t);
            orden.push(((*t).to_string(), padres[t].clone()));
        }
        pendientes.retain(|t| !puestas.contains(t));
    }
    orden
}

/// La foto local: la marca, y de cada tabla del resumen sus filas y el resumen de su ventana.
/// `None` si la base ya no es la de `marca`.
fn foto_local(foto: &Foto<'_>, resumen: &ResumenNube, marca: MarcaLocal) -> Result<Option<FotoLocal>, ErrorSql> {
    let guarda = leer_guarda(foto)?;
    if guarda.marca != marca {
        return Ok(None);
    }

    let locales: HashSet<String> = foto
        .filas("SELECT name FROM sqlite_master WHERE type = 'table';", &[])?
        .into_iter()
        .filter_map(|f| match f.into_iter().next() {
            Some(Value::Text(nombre)) => Some(nombre),
            _ => None,
        })
        .collect();

    let mut por_nombre: HashMap<String, TablaLocal> = HashMap::new();
    let mut sin_comparar = Vec::new();
    for t in &resumen.tablas {
        // Una tabla que aquí no existe es otra versión del programa, no un descuadre.
        if !nombre_aceptable(&t.nombre) || !locales.contains(&t.nombre) || por_nombre.contains_key(&t.nombre) {
            continue;
        }
        let total_local = foto.entero(&format!("SELECT COUNT(*) FROM \"{}\";", t.nombre), &[])?.unwrap_or(0);
        let claves = claves_primarias(foto, &t.nombre)?;
        let ventana = match &t.sql {
            None => None,
            Some(sql) => {
                let ventana = resumir_ventana(foto, t, sql, &claves)?;
                if ventana.is_none() {
                    sin_comparar.push(t.nombre.clone());
                }
                ventana
            }
        };
        let (filas_local, filas_nube) = match &ventana {
            Some(v) => (v.cuentas_locales.iter().sum::<u64>() as i64, t.filas),
            None => (0, 0),
        };
        por_nombre.insert(
            t.nombre.clone(),
            TablaLocal {
                nombre: t.nombre.clone(),
                total_local,
                total_nube: t.total,
                filas_local,
                filas_nube,
                claves,
                padres: HashSet::new(),
                ventana,
            },
        );
    }

    let nombres: Vec<String> = por_nombre.keys().cloned().collect();
    let tablas = padres_primero(foto, &nombres)?
        .into_iter()
        .filter_map(|(n, padres)| por_nombre.remove(&n).map(|t| TablaLocal { padres, ..t }))
        .collect();
    Ok(Some(FotoLocal { guarda, tablas, sin_comparar }))
}

/* ===== Las filas de los cubos que no cuadran ===== */

/// Escribe la forma canónica de un valor que llega en JSON. `false` si no es un valor de SQLite.
///
/// Un número es su doble, lo mismo que resumió la nube; un blob llega como `{"blob": "<hex>"}`.
fn escribir_json(v: &serde_json::Value, salida: &mut Vec<u8>) -> bool {
    use serde_json::Value as J;
    match v {
        J::Null => cubos::escribir_canonico(&Celda::Nulo, salida),
        J::Bool(b) => cubos::escribir_canonico(&Celda::Numero(if *b { 1.0 } else { 0.0 }), salida),
        J::Number(n) => match n.as_f64() {
            Some(x) => cubos::escribir_canonico(&Celda::Numero(x), salida),
            None => return false,
        },
        J::String(s) => cubos::escribir_canonico(&Celda::Texto(s.as_bytes()), salida),
        J::Object(o) => {
            let Some(hex) = o.get("blob").and_then(J::as_str).filter(|_| o.len() == 1) else {
                return false;
            };
            if hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return false;
            }
            let bytes: Vec<u8> =
                (0..hex.len()).step_by(2).filter_map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect();
            cubos::escribir_canonico(&Celda::Blob(&bytes), salida);
        }
        J::Array(_) => return false,
    }
    true
}

/// El hash de la clave y el de la fila entera de una fila que llega en JSON, como los calculó la
/// nube. `None` si la fila no tiene la forma de la tabla.
fn hashes_de_fila(fila: &[serde_json::Value], posiciones: &[usize], ancho: usize) -> Option<(u64, u64)> {
    if fila.len() != ancho {
        return None;
    }
    let mut bytes = Vec::with_capacity(64);
    for i in posiciones {
        if !escribir_json(fila.get(*i)?, &mut bytes) {
            return None;
        }
    }
    let clave = cubos::fnv1a64(&bytes);
    bytes.clear();
    for v in fila {
        if !escribir_json(v, &mut bytes) {
            return None;
        }
    }
    Some((clave, cubos::fnv1a64(&bytes)))
}

/// La clave primaria de una fila que llega en JSON. `None` si algún valor no sirve de clave.
fn clave_de_json(tabla: &str, claves: &[String], posiciones: &[usize], fila: &[serde_json::Value]) -> Option<FilaAfectada> {
    let mut clave = Vec::with_capacity(claves.len());
    for (k, i) in claves.iter().zip(posiciones) {
        let v = match fila.get(*i)? {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => return None,
        };
        clave.push((k.clone(), v));
    }
    Some(FilaAfectada { tabla: tabla.to_string(), clave })
}

/// La clave primaria de una fila local. `None` si algún valor no sirve de clave.
fn clave_local(tabla: &str, claves: &[String], posiciones: &[usize], fila: &[ValorPrestado<'_>]) -> Option<FilaAfectada> {
    let mut clave = Vec::with_capacity(claves.len());
    for (k, i) in claves.iter().zip(posiciones) {
        let v = match fila.get(*i)? {
            ValorPrestado::Text(t) => String::from_utf8_lossy(t).into_owned(),
            ValorPrestado::Integer(n) => n.to_string(),
            ValorPrestado::Real(x) => x.to_string(),
            _ => return None,
        };
        clave.push((k.clone(), v));
    }
    Some(FilaAfectada { tabla: tabla.to_string(), clave })
}

/// Lo que no cuadra en una tabla, con las filas a las que toca cada cosa.
#[derive(Default)]
struct Hallazgo {
    /// Están en los dos sitios con otro contenido: se pisa arriba con lo de aquí.
    distintas: Vec<FilaAfectada>,
    /// Están aquí y no arriba: se suben.
    faltan: Vec<FilaAfectada>,
    /// Están arriba y no aquí: se borran arriba.
    sobran: Vec<FilaAfectada>,
}

impl Hallazgo {
    fn vacio(&self) -> bool {
        self.distintas.is_empty() && self.faltan.is_empty() && self.sobran.is_empty()
    }
}

/// Cómo ha acabado el examen de una tabla.
enum Examen {
    Hecho(Hallazgo),
    /// Lo que ha llegado no es lo que decía el resumen: de esta tabla no se saca nada.
    SinComparar,
    /// La nube o esta base se han movido.
    SeHaMovido,
}

/// Los cubos de `v` que se examinan sin pasar de `quedan` filas, y cuántas son. Siempre al menos
/// uno: un cubo que sólo él pasa del tope se examina igual, o no se examinaría nunca.
fn cubos_que_caben(v: &Ventana, quedan: i64) -> (Vec<u32>, i64) {
    let mut elegidos = Vec::new();
    let mut filas = 0i64;
    for c in &v.distintos {
        let i = *c as usize;
        let suyas = v.nube.cuentas[i].max(v.cuentas_locales[i]) as i64;
        if !elegidos.is_empty() && filas + suyas > quedan {
            break;
        }
        elegidos.push(*c);
        filas += suyas;
    }
    (elegidos, filas)
}

/// Lo que comparten los pasos de una pasada: las dos bases, el resumen de la nube y la marca de
/// esta base al pedirlo.
#[derive(Clone, Copy)]
struct Pasada<'a> {
    db: &'a Db,
    nube: &'a dyn PaginasDelContraste,
    resumen: &'a ResumenNube,
    marca: MarcaLocal,
}

/// Baja las filas de `pedir` (cubos de `tabla` que no cuadran), compara cada una con la de aquí y
/// busca las de aquí que no han venido.
async fn examinar_cubos(
    p: Pasada<'_>,
    tabla: &str,
    v: &Ventana,
    pedir: &[u32],
    examinadas: &mut i64,
) -> AppResult<Examen> {
    let Pasada { db, nube, resumen, marca } = p;
    let n_cubos = v.nube.cubos();
    let pedidos: HashSet<u32> = pedir.iter().copied().collect();
    let mut recibido = ResumenCubos::nuevo(n_cubos).ok_or_else(|| AppError::repository("contraste: cubos no válidos"))?;
    let mut claves_de_la_nube: HashSet<u64> = HashSet::new();
    let mut hallazgo = Hallazgo::default();

    let mut cursor = 0i64;
    loop {
        let pagina = nube
            .filas(PedidoDeFilas {
                tabla: tabla.to_string(),
                desde: resumen.desde.clone(),
                cubos: n_cubos,
                pedir: pedir.to_vec(),
                cursor,
            })
            .await?;
        // La página es de otra foto: algo se ha escrito en la nube desde el resumen.
        if pagina.hasta_seq != resumen.hasta_seq {
            return Ok(Examen::SeHaMovido);
        }
        if pagina.tabla != tabla || pagina.columnas != v.columnas {
            return Ok(Examen::SinComparar);
        }

        let r = db.read().await;
        for fila in &pagina.filas {
            let Some((hash_clave, hash_fila)) = hashes_de_fila(fila, &v.posiciones, v.columnas.len()) else {
                return Ok(Examen::SinComparar);
            };
            // Lo que no sea de un cubo pedido no se ha pedido: no cuenta ni se compara.
            if !pedidos.contains(&cubos::cubo_de(hash_clave, n_cubos)) {
                continue;
            }
            recibido.anadir(hash_clave, hash_fila);
            claves_de_la_nube.insert(hash_clave);
            *examinadas += 1;

            let difiere = rep::fila_difiere(r.conn(), tabla, &v.columnas, fila, &v.claves).await.map_err(db_err)?;
            let lista = match difiere {
                Some(false) => continue,
                Some(true) => &mut hallazgo.distintas,
                None => &mut hallazgo.sobran,
            };
            match clave_de_json(tabla, &v.claves, &v.posiciones, fila) {
                Some(f) => lista.push(f),
                None => return Ok(Examen::SinComparar),
            }
        }
        drop(r);

        match pagina.siguiente_cursor {
            None => break,
            Some(siguiente) if siguiente > cursor => cursor = siguiente,
            Some(_) => return Err(AppError::external("el cursor de las filas del contraste no avanza")),
        }
    }

    // Lo que ha llegado de cada cubo tiene que ser lo que el resumen decía de él. Si no, estas
    // filas no son las de la foto que se resumió, y compararlas no dice nada.
    for c in pedir {
        let i = *c as usize;
        if recibido.cuentas[i] != v.nube.cuentas[i] || recibido.sumas[i] != v.nube.sumas[i] {
            tracing::warn!(target: "tpv::sync", tabla, cubo = *c, "contraste: las filas de un cubo no son las del resumen");
            return Ok(Examen::SinComparar);
        }
    }

    // Las de aquí que caen en esos cubos y no han venido. Otra foto, así que se vuelve a mirar la
    // marca: tiene que ser la misma base que se resumió.
    let (sql, args, claves, posiciones) = (v.sql.clone(), v.args.clone(), v.claves.clone(), v.posiciones.clone());
    let nombre = tabla.to_string();
    let no_han_venido = {
        let r = db.read().await;
        r.conn()
            .foto(move |foto| {
                if leer_marca(foto)? != marca {
                    return Ok(None);
                }
                let mut no_han_venido = Vec::new();
                let mut bytes = Vec::with_capacity(64);
                foto.recorrer(&sql, &args, |valores| {
                    bytes.clear();
                    for i in &posiciones {
                        match valores.get(*i) {
                            Some(v) => cubos::escribir_canonico(&celda(v), &mut bytes),
                            None => return Ok(()),
                        }
                    }
                    let hash = cubos::fnv1a64(&bytes);
                    if pedidos.contains(&cubos::cubo_de(hash, n_cubos)) && !claves_de_la_nube.contains(&hash) {
                        if let Some(f) = clave_local(&nombre, &claves, &posiciones, valores) {
                            no_han_venido.push((f, clave_local_en_json(&posiciones, valores)));
                        }
                    }
                    Ok(())
                })?;
                Ok(Some(no_han_venido))
            })
            .await
            .map_err(db_err)?
    };
    let Some(no_han_venido) = no_han_venido else {
        return Ok(Examen::SeHaMovido);
    };

    // Una que no ha venido en su cubo puede faltar arriba, o estar arriba fuera de la ventana (la de
    // una línea depende de su comanda): se busca por su clave y sólo es distinta si lo es.
    match comprobar_por_clave(p, tabla, v, no_han_venido, examinadas).await? {
        Examen::Hecho(h) => {
            hallazgo.distintas.extend(h.distintas);
            hallazgo.faltan = h.faltan;
            Ok(Examen::Hecho(hallazgo))
        }
        otro => Ok(otro),
    }
}

/// Claves por petición a `/v1/sync/verificar/por-clave`.
const CLAVES_POR_PETICION: usize = 500;

/// Los valores de la clave primaria de una fila local, como viajan en JSON.
fn clave_local_en_json(posiciones: &[usize], fila: &[ValorPrestado<'_>]) -> Vec<serde_json::Value> {
    posiciones
        .iter()
        .map(|i| match fila.get(*i) {
            Some(ValorPrestado::Text(t)) => serde_json::Value::String(String::from_utf8_lossy(t).into_owned()),
            Some(ValorPrestado::Integer(n)) => serde_json::Value::from(*n),
            Some(ValorPrestado::Real(x)) => serde_json::Value::from(*x),
            _ => serde_json::Value::Null,
        })
        .collect()
}

/// Busca arriba, por su clave, las filas de aquí que no han venido en su cubo. Las que no están
/// arriba faltan; las que están se comparan con la tolerancia de siempre, y sólo si son distintas se
/// reparan. Devuelve lo que falta y lo que es distinto.
async fn comprobar_por_clave(
    p: Pasada<'_>,
    tabla: &str,
    v: &Ventana,
    candidatas: Vec<(FilaAfectada, Vec<serde_json::Value>)>,
    examinadas: &mut i64,
) -> AppResult<Examen> {
    let Pasada { db, nube, resumen, .. } = p;
    let mut hallazgo = Hallazgo::default();
    for tanda in candidatas.chunks(CLAVES_POR_PETICION) {
        let mut pendientes: Vec<&(FilaAfectada, Vec<serde_json::Value>)> = tanda.iter().collect();
        let mut arriba: HashSet<String> = HashSet::new();
        while !pendientes.is_empty() {
            let pagina = nube
                .por_clave(PedidoPorClave {
                    tabla: tabla.to_string(),
                    claves: pendientes.iter().map(|(_, k)| k.clone()).collect(),
                })
                .await?;
            if pagina.hasta_seq != resumen.hasta_seq {
                return Ok(Examen::SeHaMovido);
            }
            if pagina.tabla != tabla || pagina.columnas != v.columnas {
                return Ok(Examen::SinComparar);
            }
            let r = db.read().await;
            for fila in &pagina.filas {
                let clave: Vec<serde_json::Value> = v.posiciones.iter().filter_map(|i| fila.get(*i).cloned()).collect();
                let Some(canonica) = clave_canonica(&clave) else {
                    return Ok(Examen::SinComparar);
                };
                if !arriba.insert(canonica) {
                    continue;
                }
                *examinadas += 1;
                match rep::fila_difiere(r.conn(), tabla, &v.columnas, fila, &v.claves).await.map_err(db_err)? {
                    Some(true) => match clave_de_json(tabla, &v.claves, &v.posiciones, fila) {
                        Some(f) => hallazgo.distintas.push(f),
                        None => return Ok(Examen::SinComparar),
                    },
                    Some(false) => {}
                    // Aquí ya no está: la base se ha movido, y lo dirá la marca antes de encolar.
                    None => return Ok(Examen::SeHaMovido),
                }
            }
            drop(r);
            if !pagina.cortada {
                break;
            }
            // Lo que no ha cabido se vuelve a pedir; una página cortada trae al menos una fila.
            let antes = pendientes.len();
            pendientes.retain(|(_, k)| clave_canonica(k).is_some_and(|c| !arriba.contains(&c)));
            if pendientes.len() == antes {
                return Err(AppError::external("las filas por clave del contraste no avanzan"));
            }
        }
        for (f, k) in tanda {
            if clave_canonica(k).is_none_or(|c| !arriba.contains(&c)) {
                hallazgo.faltan.push(f.clone());
            }
        }
    }
    Ok(Examen::Hecho(hallazgo))
}

/* ===== Las claves de lo que no cuadra fuera de la ventana ===== */

/// Forma canónica de una clave, para poder restar los dos conjuntos.
///
/// Los dos lados llegan por caminos distintos —uno de la base local, otro de JSON— y la misma
/// clave tiene que verse igual: un entero, como entero aunque venga como `1.0`. El separador es
/// `\u{1f}` y no una coma: (`"a"`, `"b,c"`) y (`"a,b"`, `"c"`) no pueden dar la misma cadena.
pub(crate) fn clave_canonica(valores: &[serde_json::Value]) -> Option<String> {
    let mut partes = Vec::with_capacity(valores.len());
    for v in valores {
        partes.push(match v {
            serde_json::Value::String(s) => format!("t{s}"),
            serde_json::Value::Number(n) => match n.as_i64() {
                Some(i) => format!("n{i}"),
                None => match n.as_f64() {
                    Some(x) if x.fract() == 0.0 && x.abs() < 9.0e15 => format!("n{}", x as i64),
                    _ => format!("n{n}"),
                },
            },
            // Un NULL no puede ser clave primaria: de esa fila no se decide nada.
            _ => return None,
        });
    }
    Some(partes.join("\u{1f}"))
}

/// El orden de SQLite entre dos claves de una misma tabla, valor a valor: un número va antes que
/// un texto, los números por su valor y los textos por sus bytes (la intercalación `BINARY`, la de
/// todas las claves del esquema). Es el que da el `ORDER BY` de las páginas de claves.
fn orden_sqlite(a: &[serde_json::Value], b: &[serde_json::Value]) -> std::cmp::Ordering {
    use serde_json::Value as J;
    use std::cmp::Ordering;
    fn rango(v: &J) -> u8 {
        match v {
            J::Null => 0,
            J::Number(_) => 1,
            J::String(_) => 2,
            _ => 3,
        }
    }
    for (x, y) in a.iter().zip(b) {
        let orden = match (x, y) {
            (J::Number(p), J::Number(q)) => match (p.as_i64(), q.as_i64()) {
                (Some(p), Some(q)) => p.cmp(&q),
                _ => p.as_f64().partial_cmp(&q.as_f64()).unwrap_or(Ordering::Equal),
            },
            (J::String(p), J::String(q)) => p.as_bytes().cmp(q.as_bytes()),
            _ => rango(x).cmp(&rango(y)),
        };
        if orden != Ordering::Equal {
            return orden;
        }
    }
    a.len().cmp(&b.len())
}

/// El valor de una clave como se enlaza en una consulta.
fn valor_de_clave(v: &serde_json::Value) -> Option<Value> {
    match v {
        serde_json::Value::String(s) => Some(Value::Text(s.clone())),
        serde_json::Value::Number(n) => n.as_i64().map(Value::Integer).or_else(|| n.as_f64().map(Value::Real)),
        _ => None,
    }
}

fn fila_de_clave(tabla: &str, claves: &[String], valores: &[serde_json::Value]) -> Option<FilaAfectada> {
    let mut clave = Vec::with_capacity(claves.len());
    for (k, v) in claves.iter().zip(valores) {
        clave.push((
            k.clone(),
            match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => return None,
            },
        ));
    }
    (clave.len() == claves.len()).then(|| FilaAfectada { tabla: tabla.to_string(), clave })
}

/// Lo más que se carga de claves de aquí en un tramo. Un tramo de la nube puede abarcar muchas más
/// de aquí (si a la nube le falta medio histórico, la última página es «hasta el final»): entonces el
/// tramo se corta en la última de éstas y lo de la nube que pasa de ella se vuelve a pedir.
const CLAVES_LOCALES_POR_TRAMO: usize = 20_000;

/// Las claves de `tabla` que hay aquí en el tramo `(desde, hasta]`, en orden de clave y con su forma
/// canónica, hasta `limite`. Sin `desde` empieza por el principio; sin `hasta`, llega al final. El
/// orden y los límites los pone SQLite con la clave de la tabla, igual que en la nube.
async fn claves_locales_del_tramo(
    conn: &Connection,
    tabla: &str,
    claves: &[String],
    desde: Option<&[serde_json::Value]>,
    hasta: Option<&[serde_json::Value]>,
    limite: usize,
) -> AppResult<Option<Vec<(String, Vec<serde_json::Value>)>>> {
    let columnas = claves.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let mut args: Vec<Value> = Vec::new();
    let mut condiciones: Vec<String> = Vec::new();
    for (tope, operador) in [(desde, ">"), (hasta, "<=")] {
        let Some(tope) = tope else { continue };
        if tope.len() != claves.len() {
            return Ok(None);
        }
        let mut marcas = Vec::with_capacity(tope.len());
        for v in tope {
            let Some(valor) = valor_de_clave(v) else {
                return Ok(None);
            };
            args.push(valor);
            marcas.push(format!("?{}", args.len()));
        }
        condiciones.push(format!("({columnas}) {operador} ({})", marcas.join(", ")));
    }
    let donde = if condiciones.is_empty() { String::new() } else { format!(" WHERE {}", condiciones.join(" AND ")) };
    args.push(Value::Integer(limite as i64));
    let mut filas = conn
        .query(&format!("SELECT {columnas} FROM \"{tabla}\"{donde} ORDER BY {columnas} LIMIT ?{};", args.len()), args)
        .await
        .map_err(db_err)?;

    let mut salida = Vec::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        let mut valores = Vec::with_capacity(claves.len());
        for i in 0..claves.len() {
            valores.push(rep::valor_a_json(&f.get_value(i as i32).map_err(db_err)?));
        }
        if let Some(c) = clave_canonica(&valores) {
            salida.push((c, valores));
        }
    }
    Ok(Some(salida))
}

/// Por dónde sigue, en la pasada siguiente, el recorrido de las claves de cada tabla que no cupo en
/// una pasada (`MAX_CLAVES_POR_PASADA`). Sin esto, una tabla de más claves que el tope empezaría
/// siempre por el principio y no llegaría nunca a lo que hay detrás. Vive en memoria: si la
/// aplicación se reinicia, se vuelve a empezar por el principio, que sólo cuesta tiempo. Cada tramo
/// se compara por su cuenta, con las dos fotos de su pasada, así que empezar por la mitad no cambia
/// lo que se encuentra.
static REANUDAR_CLAVES: std::sync::Mutex<Option<HashMap<String, Vec<serde_json::Value>>>> =
    std::sync::Mutex::new(None);

fn por_donde_seguir(tabla: &str) -> Option<Vec<serde_json::Value>> {
    let guardado = REANUDAR_CLAVES.lock().unwrap_or_else(|p| p.into_inner());
    guardado.as_ref().and_then(|m| m.get(tabla).cloned())
}

fn seguir_por(tabla: &str, cursor: Option<Vec<serde_json::Value>>) {
    let mut guardado = REANUDAR_CLAVES.lock().unwrap_or_else(|p| p.into_inner());
    let mapa = guardado.get_or_insert_with(HashMap::new);
    match cursor {
        Some(c) => mapa.insert(tabla.to_string(), c),
        None => mapa.remove(tabla),
    };
}

/// Recorre las claves de `tabla` en la nube, por páginas, y de cada tramo resta las de aquí.
/// Devuelve lo que falta y lo que sobra arriba, y si se ha recorrido la tabla entera en esta pasada.
///
/// Empieza donde lo dejó la pasada anterior si no llegó al final ([`por_donde_seguir`]), y se para
/// al pasar de `MAX_CLAVES_POR_PASADA` claves vistas, de aquí y de allí.
async fn examinar_claves(
    p: Pasada<'_>,
    tabla: &str,
    claves: &[String],
    vistas: &mut i64,
) -> AppResult<(Examen, bool)> {
    let Pasada { db, nube, resumen, .. } = p;
    let mut hallazgo = Hallazgo::default();
    let inicio = por_donde_seguir(tabla);
    let mut cursor = inicio.clone();
    loop {
        let pagina = nube.claves(PedidoDeClaves { tabla: tabla.to_string(), cursor: cursor.clone() }).await?;
        if pagina.hasta_seq != resumen.hasta_seq {
            return Ok((Examen::SeHaMovido, false));
        }
        if pagina.tabla != tabla || pagina.columnas != claves {
            return Ok((Examen::SinComparar, false));
        }

        let mut de_la_nube: Vec<(String, &Vec<serde_json::Value>)> = Vec::with_capacity(pagina.claves.len());
        for k in &pagina.claves {
            match clave_canonica(k) {
                Some(c) if k.len() == claves.len() => de_la_nube.push((c, k)),
                _ => return Ok((Examen::SinComparar, false)),
            }
        }

        let locales = {
            let r = db.read().await;
            claves_locales_del_tramo(
                r.conn(),
                tabla,
                claves,
                cursor.as_deref(),
                pagina.siguiente_cursor.as_deref(),
                CLAVES_LOCALES_POR_TRAMO + 1,
            )
            .await?
        };
        let Some(mut locales) = locales else {
            return Ok((Examen::SinComparar, false));
        };
        // Si aquí hay más de las que se cargan, el tramo acaba en la última que se carga, y de la
        // nube sólo cuenta lo que no pasa de ella.
        let corte = if locales.len() > CLAVES_LOCALES_POR_TRAMO {
            locales.truncate(CLAVES_LOCALES_POR_TRAMO);
            locales.last().map(|(_, valores)| valores.clone())
        } else {
            None
        };
        if let Some(corte) = &corte {
            de_la_nube.retain(|(_, k)| orden_sqlite(k, corte) != std::cmp::Ordering::Greater);
        }
        *vistas += (de_la_nube.len() + locales.len()) as i64;

        // En orden de clave, para que lo que se encola salga siempre igual.
        let arriba: HashSet<&str> = de_la_nube.iter().map(|(c, _)| c.as_str()).collect();
        let aqui: HashSet<&str> = locales.iter().map(|(c, _)| c.as_str()).collect();
        for (c, valores) in &locales {
            if !arriba.contains(c.as_str()) {
                if let Some(f) = fila_de_clave(tabla, claves, valores) {
                    hallazgo.faltan.push(f);
                }
            }
        }
        for (c, valores) in &de_la_nube {
            if !aqui.contains(c.as_str()) {
                if let Some(f) = fila_de_clave(tabla, claves, valores) {
                    hallazgo.sobran.push(f);
                }
            }
        }

        match corte.or(pagina.siguiente_cursor) {
            // Al final de la tabla: si se empezó a mitad, lo de delante se vio en las pasadas
            // anteriores, y la vuelta está completa.
            None => {
                seguir_por(tabla, None);
                return Ok((Examen::Hecho(hallazgo), true));
            }
            Some(siguiente) => {
                if cursor.as_ref() == Some(&siguiente) {
                    return Err(AppError::external("el cursor de las claves del contraste no avanza"));
                }
                if *vistas >= MAX_CLAVES_POR_PASADA {
                    seguir_por(tabla, Some(siguiente));
                    return Ok((Examen::Hecho(hallazgo), false));
                }
                cursor = Some(siguiente);
            }
        }
    }
}

/* ===== El contraste ===== */

/// Encola una operación de reparación. Va por la conexión cruda: estas sentencias se fabrican para
/// replicarse y no se aplican aquí (esta base ya está bien; la que no, es la de la nube).
///
/// SYNC-31: `repara` es la lista JSON de las operaciones apartadas que retira al subir
/// (`Repara_Op_Id`, `outbox_confirmar_lote`).
pub(crate) async fn encolar_operacion(conn: &Connection, sentencias: &[SqlStatement], repara: Option<&str>) -> AppResult<()> {
    let op = uuid::Uuid::now_v7().to_string();
    let ahora = now_ms();
    conn.execute(
        "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Repara_Op_Id) VALUES (?1, ?2, ?3, ?4, ?5);",
        vec![
            Value::Text(op.clone()),
            Value::Text(rep::COMANDO_REPARACION.to_string()),
            Value::Text(serde_json::to_string(sentencias).map_err(db_err)?),
            Value::Integer(ahora),
            repara.map_or(Value::Null, |r| Value::Text(r.to_string())),
        ],
    )
    .await
    .map_err(db_err)?;
    // Su anti-eco: cuando vuelva de la nube no se aplica aquí.
    conn.execute(
        "INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, 0, ?2) ON CONFLICT(Op_Id) DO NOTHING;",
        vec![Value::Text(op), Value::Integer(ahora)],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Lo que se ha encolado.
struct Encolado {
    reparadas: i64,
    borradas: i64,
    /// SYNC-29: filas que no se tocan arriba porque las trae la convergencia.
    por_converger: i64,
}

/// El borrado arriba de una fila que sobra, **sólo si la nube no ha cambiado desde la foto**, y
/// **sólo en la nube**.
///
/// Entre la última página que se comparó y el momento en que el TenantHub aplica la reparación pasa
/// un rato, y en él una Handy puede haber escrito algo que cuelga de esa fila (una línea en una
/// comanda que aquí no existe): borrarla se llevaría lo nuevo con sus cascadas, y la Main, que no
/// tiene la fila, no lo podría aplicar. Así que el `DELETE` lleva la condición: que en el log no
/// haya nada por encima del `hasta_seq` de la foto salvo las reparaciones de esta misma pasada
/// (que lo que la Main ha escrito después sube detrás de ellas). El TenantHub aplica las
/// operaciones de la Main en el turno del log, así que la condición y el borrado son del mismo
/// instante. Si algo ha cambiado no borra nada, y la pasada siguiente lo vuelve a mirar.
///
/// La sentencia queda en el log de la nube, y la aplicaría una Main que no fuera ésta (una que la
/// sustituye y se pone al día desde una foto anterior a ella): en su base `Sync_Changes` está vacía,
/// la condición daría otra cosa que en la nube y borraría lo que allí no se borró. Por eso exige
/// además que el log tenga algo a partir del `hasta_seq`, que en la nube siempre es así (la purga
/// deja la cola del log) y en una Main nunca: allí no hace nada.
fn borrado_si_la_nube_no_ha_cambiado(fila: &FilaAfectada, hasta_seq: i64) -> Option<SqlStatement> {
    let (donde, mut args) = rep::donde_de_la_clave(fila)?;
    let condicion = si_la_nube_no_ha_cambiado(&mut args, hasta_seq);
    Some(SqlStatement { sql: format!("DELETE FROM \"{}\" WHERE {donde} AND {condicion};", fila.tabla), args })
}

/// La condición de [`borrado_si_la_nube_no_ha_cambiado`]: en el log de la nube hay algo a partir
/// de `hasta_seq`, y por encima nada que no sea una reparación. Sus dos argumentos van al final de
/// `args`.
fn si_la_nube_no_ha_cambiado(args: &mut Vec<serde_json::Value>, hasta_seq: i64) -> String {
    args.push(serde_json::Value::from(hasta_seq));
    let n_seq = args.len();
    args.push(serde_json::Value::from(rep::COMANDO_REPARACION));
    format!(
        "EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq >= ?{n_seq}) \
         AND NOT EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq > ?{n_seq} AND Command_Name IS NOT ?{})",
        n_seq + 1
    )
}

/// SYNC-38 · Lo que aparca, antes de subir lo demás, los valores únicos de una fila que sobra arriba,
/// con la misma condición que su borrado ([`borrado_si_la_nube_no_ha_cambiado`]). Una fila que falta
/// arriba puede necesitar el nombre de una que sobra (aquí se renombró la zona y se creó otra con el
/// nombre de antes): subida antes del borrado, chocaría con ella. Va en la misma operación que lo que
/// sube y que su borrado, que la nube aplica en una transacción y en el turno del log: la condición da
/// lo mismo en las dos sentencias, así que lo aparcado se borra en ella, y si no se borra, tampoco se
/// aparca. En una Main, como el borrado, no hace nada.
fn aparcar_si_la_nube_no_ha_cambiado(fila: &FilaAfectada, indices: &[crate::aparcar::IndiceUnico], hasta_seq: i64) -> Option<SqlStatement> {
    let (donde, mut args) = rep::donde_de_la_clave(fila)?;
    let clave: Vec<serde_json::Value> = args.clone();
    let condicion = si_la_nube_no_ha_cambiado(&mut args, hasta_seq);
    crate::aparcar::aparcar_la_que_sobra(&fila.tabla, indices, &format!("{donde} AND {condicion}"), args, &clave)
}

/// Las claves foráneas de `tabla` que apuntan a ella misma (un cobro que devuelve otro cobro): de
/// cada una, las posiciones de sus columnas y las de las columnas a las que apunta, en el orden de
/// las columnas de la tabla, que es el de los argumentos de `sentencia_de_reparacion`.
pub(crate) async fn autorreferencias(conn: &Connection, tabla: &str) -> AppResult<Vec<(Vec<usize>, Vec<usize>)>> {
    let leer = |sql: &'static str| async move {
        let mut filas = conn.query(sql, vec![Value::Text(tabla.to_string())]).await.map_err(db_err)?;
        let mut salida: Vec<Vec<Value>> = Vec::new();
        while let Some(f) = filas.next().await.map_err(db_err)? {
            salida.push((0..4).map(|i| f.get_value(i).unwrap_or(Value::Null)).collect());
        }
        AppResult::Ok(salida)
    };
    let texto = |v: &Value| match v {
        Value::Text(t) => Some(t.clone()),
        _ => None,
    };
    let columnas: Vec<String> = leer("SELECT name, pk, 0, 0 FROM pragma_table_info(?1) ORDER BY cid;")
        .await?
        .iter()
        .filter_map(|f| texto(&f[0]))
        .collect();
    let mut clave: Vec<(i64, String)> = leer("SELECT name, pk, 0, 0 FROM pragma_table_info(?1) WHERE pk > 0;")
        .await?
        .iter()
        .filter_map(|f| Some((match f[1] { Value::Integer(n) => n, _ => 0 }, texto(&f[0])?)))
        .collect();
    clave.sort();
    let posicion = |c: &str| columnas.iter().position(|x| x == c);

    let mut por_id: Vec<(i64, Vec<usize>, Vec<usize>)> = Vec::new();
    for f in leer("SELECT id, seq, \"from\", \"to\" FROM pragma_foreign_key_list(?1) WHERE \"table\" = ?1 ORDER BY id, seq;").await? {
        let (Value::Integer(id), Value::Integer(seq)) = (&f[0], &f[1]) else { continue };
        let Some(desde) = texto(&f[2]).and_then(|c| posicion(&c)) else { continue };
        // Sin columna destino, la foránea apunta a la clave primaria.
        let destino = texto(&f[3]).or_else(|| clave.get(*seq as usize).map(|(_, c)| c.clone()));
        let Some(hasta) = destino.and_then(|c| posicion(&c)) else { continue };
        match por_id.last_mut() {
            Some((ultimo, d, h)) if *ultimo == *id => {
                d.push(desde);
                h.push(hasta);
            }
            _ => por_id.push((*id, vec![desde], vec![hasta])),
        }
    }
    Ok(por_id.into_iter().map(|(_, d, h)| (d, h)).collect())
}

/// Ordena las reparaciones de una tabla que se apunta a sí misma para que una fila vaya siempre
/// detrás de aquélla a la que apunta, si las dos suben. Las operaciones se aplican una a una y cada
/// una en su transacción: partidas en tandas sin este orden, la devolución de un cobro podría subir
/// en una operación anterior a la del cobro, y las dos fallarían por la foránea. Lo que forme un
/// ciclo se queda como estaba, al final.
pub(crate) fn padres_antes(sentencias: Vec<SqlStatement>, refs: &[(Vec<usize>, Vec<usize>)]) -> Vec<SqlStatement> {
    if refs.is_empty() || sentencias.len() < 2 {
        return sentencias;
    }
    let valores = |st: &SqlStatement, idx: &[usize]| -> Option<String> {
        let v: Vec<&serde_json::Value> = idx.iter().map(|i| st.args.get(*i)).collect::<Option<_>>()?;
        if v.iter().any(|x| x.is_null()) {
            return None;
        }
        serde_json::to_string(&v).ok()
    };
    let mut depende: Vec<HashSet<usize>> = vec![HashSet::new(); sentencias.len()];
    for (desde, hasta) in refs {
        let por_destino: HashMap<String, usize> =
            sentencias.iter().enumerate().filter_map(|(i, st)| Some((valores(st, hasta)?, i))).collect();
        for (i, st) in sentencias.iter().enumerate() {
            if let Some(j) = valores(st, desde).and_then(|k| por_destino.get(&k).copied()) {
                if j != i {
                    depende[i].insert(j);
                }
            }
        }
    }
    let mut puesta = vec![false; sentencias.len()];
    let mut orden: Vec<usize> = Vec::with_capacity(sentencias.len());
    loop {
        let listas: Vec<usize> = (0..sentencias.len())
            .filter(|i| !puesta[*i] && depende[*i].iter().all(|j| puesta[*j]))
            .collect();
        if listas.is_empty() {
            break;
        }
        for i in listas {
            puesta[i] = true;
            orden.push(i);
        }
    }
    orden.extend((0..sentencias.len()).filter(|i| !puesta[*i]));
    let mut sentencias: Vec<Option<SqlStatement>> = sentencias.into_iter().map(Some).collect();
    orden.into_iter().filter_map(|i| sentencias[i].take()).collect()
}

/// Encola el plan, con el escritor cogido y la guarda vista otra vez. `None` si ya no se puede:
/// entre comparar y escribir la base se ha movido, ha fallado un cambio de la nube o una
/// recuperación ha sembrado la cola del histórico.
///
/// Lo que se sube va **padres primero** (las tablas por sus foráneas y, dentro de una que se apunta
/// a sí misma, sus filas: [`padres_antes`]) y lo que se borra, hijas primero, partido en operaciones
/// de `SENTENCIAS_POR_OPERACION`: el outbox sube en orden, así que ninguna operación lleva una fila
/// cuyo padre viaja en una posterior. Los borrados de una tabla que se apunta a sí misma van de la
/// clave mayor a la menor: con claves UUIDv7, que crecen con la hora, una devolución se borra antes
/// que el cobro al que apunta. Lo que se borra sólo se borra si la nube no ha cambiado desde la foto
/// ([`borrado_si_la_nube_no_ha_cambiado`]). Todas las operaciones entran en el outbox juntas o
/// ninguna.
///
/// SYNC-37 · Con dos filas o más de una tabla que están arriba con otra cosa, lo de esa tabla
/// empieza aparcando sus valores únicos (`aparcar.rs`), y va entero en una operación, que la nube
/// aplica en una transacción: dos que se han intercambiado un nombre entran juntas, y lo aparcado
/// no sale de esa transacción.
///
/// SYNC-38 · Y lo que sobra arriba de una tabla de la que algo sube aparca antes sus valores únicos,
/// con la condición de su borrado ([`aparcar_si_la_nube_no_ha_cambiado`]): una fila que falta arriba
/// puede necesitar el nombre de una que sobra. Entonces el plan va entero en una operación, porque lo
/// aparcado y su borrado tienen que ir en la misma; si no cabe, no se aparca. Los borrados no se
/// adelantan a lo que sube: borrar antes un padre que sobra se llevaría por su `ON DELETE CASCADE`
/// una hija que aquí está en otro padre (la subida la mueve antes) y, con ella, lo que cuelga de ésta,
/// que no sube porque es igual en los dos lados.
///
/// SYNC-31 · Todas llevan en `Repara_Op_Id` las operaciones apartadas de la subida que el plan
/// resuelve ([`apartadas_que_resuelve`]): el outbox las retira cuando sube la última que las lleva, y
/// no si alguna de ellas se queda apartada (`sync::retirar_lo_que_repara`). `completas` son las tablas que esta pasada ha comparado
/// enteras.
async fn encolar_plan(
    db: &Db,
    marca: MarcaLocal,
    hasta_seq: i64,
    hallazgos: &[(String, Hallazgo)],
    borrar: bool,
    completas: &HashSet<String>,
) -> AppResult<Option<Encolado>> {
    let w = db.write().await;
    let conn: &Connection = w.raw();
    let guarda = conn.foto(leer_guarda).await.map_err(db_err)?;
    if !guarda.deja_reparar(&marca) {
        return Ok(None);
    }

    // SYNC-29: una fila que un cambio de la nube tocó con algo de aquí sin ordenar no se sube ni se
    // borra arriba, sea distinta, falte o sobre: la nube la ordenó de otra forma, y la trae la
    // convergencia. Salvo que la escribiera algo apartado de la subida: eso es lo de aquí que la nube
    // no aceptó, y se repara como siempre.
    let por_converger = apuntadas_por_converger(db, conn, hallazgos).await?;

    // Lo que sube, tabla a tabla: (sus sentencias, si van juntas en una operación). Y cuántas filas.
    let mut subir: Vec<(Vec<SqlStatement>, bool)> = Vec::new();
    // SYNC-38: de cada tabla de `subir`, lo que aparca antes lo que le sobra arriba.
    let mut aparcan_las_que_sobran: Vec<Vec<SqlStatement>> = Vec::new();
    let mut reparadas = 0i64;
    let mut unicos = crate::aparcar::Unicos::default();
    for (tabla, h) in hallazgos {
        let mut vistas: HashSet<&FilaAfectada> = HashSet::new();
        let mut de_la_tabla = Vec::new();
        // SYNC-37: lo que está arriba con otra cosa aparca antes sus valores únicos, por si dos de
        // ellas se los han intercambiado (arriba `A/B`, aquí `B/A`): escritas una a una, la primera
        // chocaría con la segunda en la nube.
        let mut aparcan = Vec::new();
        let indices = match h.distintas.len() >= 2 {
            true => unicos.de(conn, tabla).await?.to_vec(),
            false => Vec::new(),
        };
        let columnas = match indices.is_empty() {
            true => Vec::new(),
            false => crate::cuarentenas_bajada::columnas_locales(conn, tabla).await?,
        };
        let distintas: HashSet<&FilaAfectada> = h.distintas.iter().collect();
        for f in h.distintas.iter().chain(&h.faltan) {
            if !vistas.insert(f) || por_converger.contains(f) {
                continue;
            }
            // `None`: la fila tiene algo que no se replica (un blob). No se manda a medias.
            if let Some(st) = rep::sentencia_de_reparacion(conn, f).await.map_err(db_err)? {
                if !indices.is_empty() && distintas.contains(f) {
                    let clave: Vec<String> = f.clave.iter().map(|(c, _)| c.clone()).collect();
                    aparcan.extend(crate::aparcar::aparcar(tabla, &indices, &columnas, &st.args, &clave));
                }
                de_la_tabla.push(st);
            }
        }
        let refs = autorreferencias(conn, tabla).await?;
        let de_la_tabla = padres_antes(de_la_tabla, &refs);
        reparadas += de_la_tabla.len() as i64;
        // SYNC-38: lo que sobra arriba de esta tabla y se va a borrar puede tener el valor único que
        // necesita algo de lo que sube: se aparca antes, con la condición de su borrado.
        let mut las_que_sobran = Vec::new();
        if borrar && !de_la_tabla.is_empty() {
            let sobran: Vec<&FilaAfectada> = h.sobran.iter().filter(|f| !por_converger.contains(*f)).collect();
            if !sobran.is_empty() {
                let indices = unicos.de(conn, tabla).await?;
                las_que_sobran = sobran.into_iter().filter_map(|f| aparcar_si_la_nube_no_ha_cambiado(f, indices, hasta_seq)).collect();
            }
        }
        aparcan_las_que_sobran.push(las_que_sobran);
        // Lo aparcado va en la misma operación que lo que lo pisa: si no cabe todo en una, no se
        // aparca (y dos filas que se cruzan no entran, como sin esto).
        if aparcan.len() >= 2 && aparcan.len() + de_la_tabla.len() <= SENTENCIAS_POR_OPERACION {
            subir.push((aparcan.into_iter().chain(de_la_tabla).collect(), true));
        } else {
            subir.push((de_la_tabla, false));
        }
    }
    let mut quitar: Vec<SqlStatement> = Vec::new();
    if borrar {
        for (tabla, h) in hallazgos.iter().rev() {
            let mut vistas: HashSet<&FilaAfectada> = HashSet::new();
            let mut sobran: Vec<&FilaAfectada> =
                h.sobran.iter().filter(|f| !por_converger.contains(*f) && vistas.insert(f)).collect();
            if !autorreferencias(conn, tabla).await?.is_empty() {
                let valores = |f: &FilaAfectada| -> Vec<serde_json::Value> {
                    f.clave.iter().map(|(_, v)| serde_json::Value::String(v.clone())).collect()
                };
                sobran.sort_by(|a, b| orden_sqlite(&valores(b), &valores(a)));
            }
            quitar.extend(sobran.into_iter().filter_map(|f| borrado_si_la_nube_no_ha_cambiado(f, hasta_seq)));
        }
    }

    let borradas = quitar.len() as i64;
    if reparadas + borradas > 0 {
        let plan: Vec<&FilaAfectada> = hallazgos
            .iter()
            .flat_map(|(_, h)| h.distintas.iter().chain(&h.faltan).chain(h.sobran.iter().filter(|_| borrar)))
            .filter(|f| !por_converger.contains(*f))
            .collect();
        let resueltas = apartadas_que_resuelve(db, conn, &plan, completas).await?;
        let repara = match resueltas.is_empty() {
            true => None,
            false => Some(serde_json::to_string(&resueltas).map_err(db_err)?),
        };
        // SYNC-38: lo que aparca lo que sobra va en la misma operación que lo que sube y que los
        // borrados, que van detrás de todo: con eso, el plan entero en una. Si no cabe, no se aparca
        // (y lo que choque con una fila que sobra no entra, como sin esto; la pasada siguiente, con
        // menos que reparar, lo vuelve a intentar).
        let aparcadas: usize = aparcan_las_que_sobran.iter().map(Vec::len).sum();
        let total = aparcadas + quitar.len() + subir.iter().map(|(s, _)| s.len()).sum::<usize>();
        let operaciones = if aparcadas > 0 && total <= SENTENCIAS_POR_OPERACION {
            let mut una: Vec<SqlStatement> = Vec::with_capacity(total);
            for (aparcan, (de_la_tabla, _)) in aparcan_las_que_sobran.into_iter().zip(subir) {
                una.extend(aparcan);
                una.extend(de_la_tabla);
            }
            una.extend(quitar);
            vec![una]
        } else {
            en_operaciones(subir.into_iter().chain([(quitar, false)]))
        };
        conn.transaccion(async {
            for operacion in &operaciones {
                encolar_operacion(conn, operacion, repara.as_deref()).await?;
            }
            Ok(())
        })
        .await?;
        if !resueltas.is_empty() {
            tracing::info!(
                target: "tpv::sync",
                apartadas = resueltas.len(),
                "contraste: la reparación encolada resuelve operaciones apartadas de la subida (SYNC-31)"
            );
        }
    }
    Ok(Some(Encolado { reparadas, borradas, por_converger: por_converger.len() as i64 }))
}

/// Parte lo que sube en operaciones de [`SENTENCIAS_POR_OPERACION`] sentencias, en su orden. Un
/// grupo que va `junto` (SYNC-37: una tabla con valores únicos aparcados y lo que los pisa) no se
/// parte: si no cabe en lo que queda de la operación, empieza otra. Cabe en una, o no va junto.
fn en_operaciones(grupos: impl IntoIterator<Item = (Vec<SqlStatement>, bool)>) -> Vec<Vec<SqlStatement>> {
    let mut operaciones: Vec<Vec<SqlStatement>> = Vec::new();
    let mut actual: Vec<SqlStatement> = Vec::new();
    for (sentencias, junto) in grupos {
        if junto && !actual.is_empty() && actual.len() + sentencias.len() > SENTENCIAS_POR_OPERACION {
            operaciones.push(std::mem::take(&mut actual));
        }
        for s in sentencias {
            if actual.len() == SENTENCIAS_POR_OPERACION {
                operaciones.push(std::mem::take(&mut actual));
            }
            actual.push(s);
        }
    }
    if !actual.is_empty() {
        operaciones.push(actual);
    }
    operaciones
}

/// Las formas canónicas de una fila (`filas_tocadas::canonica_de`), para cruzarla con lo que se sabe
/// de otras sentencias: con su clave como texto y, si parece un número, como número (`WHERE ID =
/// 7`), que es otra forma.
fn formas_canonicas(f: &FilaAfectada) -> Vec<String> {
    use crate::filas_tocadas::{canonica_de, FilaTocada};
    let texto = f.clave.iter().map(|(_, v)| serde_json::Value::String(v.clone())).collect();
    let numero = f
        .clave
        .iter()
        .map(|(_, v)| v.parse::<i64>().map_or_else(|_| serde_json::Value::String(v.clone()), serde_json::Value::from))
        .collect();
    [texto, numero]
        .into_iter()
        .filter_map(|clave| canonica_de(&FilaTocada { tabla: f.tabla.clone(), clave, borrada: false }))
        .collect()
}

/// SYNC-29 · Las filas de lo hallado (distintas, que faltan o que sobran arriba) que la convergencia
/// tiene apuntadas (`_Sync_Por_Contrastar`) y que no escribió nada apartado de la subida: el
/// contraste no las toca.
async fn apuntadas_por_converger<'h>(
    db: &Db,
    conn: &Connection,
    hallazgos: &'h [(String, Hallazgo)],
) -> AppResult<HashSet<&'h FilaAfectada>> {
    let marcadas = crate::convergencia::marcadas(conn).await?;
    if marcadas.is_empty() {
        return Ok(HashSet::new());
    }
    let claves = crate::cuarentenas_bajada::claves_primarias(db).await?;
    let apartado = crate::cuarentenas_bajada::lo_apartado_de_la_subida(db, &claves).await?;
    Ok(hallazgos
        .iter()
        .flat_map(|(_, h)| h.distintas.iter().chain(&h.faltan).chain(&h.sobran))
        .filter(|f| {
            let formas = formas_canonicas(f);
            formas.iter().any(|c| marcadas.contains(c))
                && !(apartado.tablas.contains("*")
                    || apartado.tablas.contains(&f.tabla)
                    || formas.iter().any(|c| apartado.claves.contains(c)))
        })
        .collect())
}

/// Lo más que se lee de lo apartado de la subida para enlazarlo a un plan. Lo que no quepa se
/// enlaza en otra pasada, o lo retira la purga a los 30 días.
const MAX_APARTADAS_A_ENLAZAR: i64 = 1_000;

/// SYNC-31 · Las operaciones apartadas de la subida que resuelve un plan del contraste, por orden.
///
/// Una apartada es algo que esta Main escribió y la nube no aceptó. La resuelve el plan si escribió
/// alguna de las filas que el plan sube o borra (por su clave o, si su sentencia no la nombra, en la
/// misma tabla) y si todas las tablas en las que escribió se han comparado enteras en esta pasada:
/// con el plan arriba, esas tablas dicen lo mismo aquí que en la nube, sea porque el plan lo repara
/// o porque ya estaba igual. Una cuyas sentencias no se saben leer ni para eso no se enlaza: la
/// retira la purga.
async fn apartadas_que_resuelve(
    db: &Db,
    conn: &Connection,
    plan: &[&FilaAfectada],
    completas: &HashSet<String>,
) -> AppResult<Vec<String>> {
    use crate::filas_tocadas::estaticas;

    let mut filas = conn
        .query(
            "SELECT Op_Id, Statements_Json FROM _Sync_Outbox WHERE Cuarentena = 1 ORDER BY Seq LIMIT ?1;",
            vec![Value::Integer(MAX_APARTADAS_A_ENLAZAR)],
        )
        .await
        .map_err(db_err)?;
    let mut apartadas: Vec<(String, Vec<SqlStatement>)> = Vec::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        if let (Ok(Value::Text(op)), Ok(Value::Text(json))) = (f.get_value(0), f.get_value(1)) {
            apartadas.push((op, serde_json::from_str(&json).unwrap_or_default()));
        }
    }
    drop(filas);
    if apartadas.is_empty() {
        return Ok(Vec::new());
    }

    let mut claves_del_plan: HashSet<String> = HashSet::new();
    let mut tablas_del_plan: HashSet<&str> = HashSet::new();
    for f in plan {
        tablas_del_plan.insert(f.tabla.as_str());
        claves_del_plan.extend(formas_canonicas(f));
    }

    let claves = crate::cuarentenas_bajada::claves_primarias(db).await?;
    let clave_de = |t: &str| claves.get(t).cloned().unwrap_or_default();
    Ok(apartadas
        .into_iter()
        .filter(|(_, sentencias)| {
            let e = estaticas(sentencias, &clave_de);
            !e.tablas.contains("*")
                && !e.todas.is_empty()
                && e.todas.iter().all(|t| completas.contains(t))
                && (e.claves.iter().any(|c| claves_del_plan.contains(c)) || e.tablas.iter().any(|t| tablas_del_plan.contains(t.as_str())))
        })
        .map(|(op, _)| op)
        .collect())
}

/// El contraste entero. Ver el puerto (`SyncRepository::contrastar_con_la_nube`).
pub(crate) async fn contrastar(
    db: &Db,
    resumen: ResumenNube,
    marca: MarcaLocal,
    nube: &dyn PaginasDelContraste,
    reparar: bool,
) -> AppResult<ContrasteLocal> {
    // Lo que tiene que cumplirse para que las dos fotos sean del mismo instante, visto desde aquí:
    // la nube ha comprobado que por encima de ESTE checkpoint no hay nada ajeno, y aquí no queda
    // nada por subir.
    if resumen.aplazar
        || resumen.checkpoint != Some(marca.checkpoint)
        || resumen.hasta_seq < marca.checkpoint
        || marca.pendientes != 0
    {
        return Ok(ContrasteLocal::SeHaMovido);
    }

    // SYNC-36: lo que no entró de la bajada se trae de la nube por estado, con la foto de este
    // resumen, antes de mirar nada. Lo que entra cierra su cuarentena, y si no queda ninguna, la
    // guarda deja reparar en esta misma pasada. Escribe sólo aquí, y no mueve la marca, salvo si
    // funde una ficha de aquí en la de la nube (SYN-INC-07): eso sube, y esta pasada se deja.
    if reparar && crate::cuarentenas_bajada::resolver(db, resumen.hasta_seq, marca, nube).await?.is_none() {
        return Ok(ContrasteLocal::SeHaMovido);
    }

    let resumen = Arc::new(resumen);
    let local = {
        let r = db.read().await;
        let resumen = Arc::clone(&resumen);
        r.conn().foto(move |foto| foto_local(foto, &resumen, marca)).await.map_err(db_err)?
    };
    let Some(FotoLocal { guarda, tablas, mut sin_comparar }) = local else {
        return Ok(ContrasteLocal::SeHaMovido);
    };
    let puede_reparar = reparar && guarda.deja_reparar(&marca);
    let pasada = Pasada { db, nube, resumen: &resumen, marca };

    let mut hallazgos: Vec<(String, Hallazgo)> = Vec::new();
    let mut descuadres: Vec<DescuadreTabla> = Vec::new();
    let mut examinadas = 0i64;
    let mut claves_vistas = 0i64;
    // Algo se ha quedado sin mirar entero: no se sabe todo lo que sobra arriba, y no se borra nada.
    let mut a_medias = false;
    // Hay un descuadre que esta pasada no va a reparar entero.
    let mut sin_tocar = false;
    // Las tablas de las que no se sabe todo lo que falta arriba. Lo de sus hijas no se sube: podría
    // apuntar a una fila suya que falta arriba sin que se sepa, y la operación entera fallaría por
    // su clave foránea (SYNC-31: con las claves truncadas, cada día).
    let mut incompletas: HashSet<String> = sin_comparar.iter().cloned().collect();

    for t in &tablas {
        // Una tabla cuya ventana no se ha podido comparar (otra clave, otras columnas, una sentencia
        // que aquí no corre) no se compara de ninguna otra forma: no se repara lo que no se compara.
        // Y como no se sabe lo que le sobra arriba, no se borra nada en ninguna.
        if incompletas.contains(&t.nombre) {
            a_medias = true;
            continue;
        }
        let mut hallazgo = Hallazgo::default();
        let mut comparable = true;
        let mut entera = true;

        // 1) La ventana: las filas de los cubos que no cuadran.
        if let Some(v) = t.ventana.as_ref().filter(|v| !v.distintos.is_empty()) {
            if examinadas >= MAX_FILAS_POR_PASADA {
                entera = false;
            } else {
                let (pedir, _) = cubos_que_caben(v, MAX_FILAS_POR_PASADA - examinadas);
                if pedir.len() < v.distintos.len() {
                    entera = false;
                }
                match examinar_cubos(pasada, &t.nombre, v, &pedir, &mut examinadas).await? {
                    Examen::Hecho(h) => hallazgo = h,
                    Examen::SinComparar => comparable = false,
                    Examen::SeHaMovido => return Ok(ContrasteLocal::SeHaMovido),
                }
            }
        }

        // 2) Fuera de la ventana sólo hay conteos. Si no cuadran, las claves de la tabla entera.
        let fuera_local = t.total_local - t.filas_local;
        let fuera_nube = t.total_nube - t.filas_nube;
        let mut estimado: Option<(i64, i64)> = None;
        if comparable && fuera_local != fuera_nube {
            if puede_reparar && !t.claves.is_empty() && claves_vistas < MAX_CLAVES_POR_PASADA {
                let (examen, completa) =
                    examinar_claves(pasada, &t.nombre, &t.claves, &mut claves_vistas).await?;
                match examen {
                    Examen::Hecho(h) => juntar_claves(&mut hallazgo, h),
                    Examen::SinComparar => comparable = false,
                    Examen::SeHaMovido => return Ok(ContrasteLocal::SeHaMovido),
                }
                entera &= completa;
            } else {
                // Sin bajar las claves se sabe cuántas, por los conteos, pero no cuáles.
                estimado = Some(((fuera_local - fuera_nube).max(0), (fuera_nube - fuera_local).max(0)));
                entera = false;
            }
        }

        if !comparable {
            sin_comparar.push(t.nombre.clone());
            incompletas.insert(t.nombre.clone());
            a_medias = true;
            continue;
        }

        let (mas_faltan, mas_sobran) = estimado.unwrap_or((0, 0));
        if !hallazgo.vacio() || mas_faltan + mas_sobran > 0 {
            descuadres.push(DescuadreTabla {
                tabla: t.nombre.clone(),
                faltan: hallazgo.faltan.len() as i64 + mas_faltan,
                sobran: hallazgo.sobran.len() as i64 + mas_sobran,
                distintas: hallazgo.distintas.len() as i64,
            });
        }
        if mas_faltan + mas_sobran > 0 {
            sin_tocar = true;
        }
        if !entera {
            // Lo que no se ha mirado puede esconder un descuadre más.
            a_medias = true;
            incompletas.insert(t.nombre.clone());
        }
        // Una tabla hija de otra de la que no se sabe todo no sube nada (ver `incompletas`), y pasa a
        // ser de las que no se sabe todo: lo que no sube de ella falta para sus hijas. Lo que le
        // sobra arriba sí se borra: se sabe que sobra, y su padre sólo se puede borrar detrás.
        if t.padres.iter().any(|p| incompletas.contains(p)) && !(hallazgo.distintas.is_empty() && hallazgo.faltan.is_empty()) {
            sin_tocar = true;
            incompletas.insert(t.nombre.clone());
            hallazgo.distintas.clear();
            hallazgo.faltan.clear();
        }
        if !hallazgo.vacio() {
            hallazgos.push((t.nombre.clone(), hallazgo));
        }
    }

    let hay_que_reparar = hallazgos.iter().any(|(_, h)| !h.vacio());
    let mut resultado = ResultadoVerificacion {
        descuadres,
        ventana_omitida: resumen.ventana_omitida,
        filas_examinadas: examinadas,
        tablas_sin_comparar: sin_comparar,
        aplazado: a_medias || sin_tocar,
        ..Default::default()
    };

    if hay_que_reparar && puede_reparar {
        // SYNC-31: las tablas que esta pasada ha comparado enteras, con las que se sabe qué
        // operaciones apartadas resuelve el plan.
        let completas: HashSet<String> =
            tablas.iter().map(|t| t.nombre.clone()).filter(|n| !incompletas.contains(n)).collect();
        // Lo que sobra arriba y se ha visto se borra aunque algo se haya quedado sin mirar: cada
        // fila que sobra se sabe que sobra. Lo que no se ha mirado queda para otra pasada.
        match encolar_plan(db, marca, resumen.hasta_seq, &hallazgos, true, &completas).await? {
            Some(encolado) => {
                resultado.reparadas = encolado.reparadas;
                resultado.borradas = encolado.borradas;
                // SYNC-29: lo que trae la convergencia queda sin tocar en esta pasada.
                resultado.aplazado |= encolado.por_converger > 0;
            }
            // Entre comparar y escribir ha cambiado algo: lo visto ya no vale ni para contarlo.
            None => return Ok(ContrasteLocal::SeHaMovido),
        }
    } else {
        // Nada que escribir: lo que se informa tiene que ser de la base que se resumió.
        if marca_de(db).await? != marca {
            return Ok(ContrasteLocal::SeHaMovido);
        }
        if hay_que_reparar {
            resultado.aplazado = true;
        }
    }

    Ok(ContrasteLocal::Hecho(resultado))
}

/// Junta a lo que encontró la ventana de una tabla lo que dicen sus claves: lo que falta y lo que
/// sobra, sin repetir. Lo de la ventana ya está comprobado fila a fila (lo que no vino en su cubo se
/// buscó por su clave), y las claves ven lo de fuera; una fila puede salir en las dos.
fn juntar_claves(hallazgo: &mut Hallazgo, claves: Hallazgo) {
    let Hallazgo { faltan, sobran, .. } = claves;
    for (destino, nuevas) in [(&mut hallazgo.faltan, faltan), (&mut hallazgo.sobran, sobran)] {
        let mut vistas: HashSet<FilaAfectada> = destino.iter().cloned().collect();
        destino.extend(nuevas.into_iter().filter(|f| vistas.insert(f.clone())));
    }
}

async fn marca_de(db: &Db) -> AppResult<MarcaLocal> {
    marca(db).await
}

#[cfg(test)]
mod tests {
    //! Lo que no se ve desde fuera (`tests/contraste_diario.rs` recorre el contraste de punta a
    //! punta): la guarda que se vuelve a mirar con el escritor cogido, cómo se juntan la ventana y
    //! las claves, el orden de las tablas y el reparto del tope de filas.

    use std::sync::Arc;

    use super::*;

    async fn base(nombre: &str) -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal(nombre);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn sembrar(db: &Db, sql: &str) {
        let w = db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    async fn numero(db: &Db, sql: &str) -> i64 {
        let r = db.read().await;
        let mut filas = r.conn().query(sql, ()).await.unwrap();
        filas.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
    }

    fn zona(id: &str) -> FilaAfectada {
        FilaAfectada { tabla: "Zonas".into(), clave: vec![("ID_Zona".into(), id.into())] }
    }

    fn hallazgo(distintas: &[&str], faltan: &[&str], sobran: &[&str]) -> Hallazgo {
        let filas = |ids: &[&str]| ids.iter().map(|i| zona(i)).collect();
        Hallazgo { distintas: filas(distintas), faltan: filas(faltan), sobran: filas(sobran) }
    }

    #[tokio::test]
    async fn al_encolar_se_vuelve_a_mirar_la_guarda_con_el_escritor_cogido() {
        // Lo que se decidió comparando puede no valer al ir a escribir: la bajada registra un
        // fallo (AUD-18), una recuperación siembra la cola del histórico (VERIF-01) o la base
        // se mueve. En cualquiera de los tres no se encola nada.
        let (db, _dir) = base("contraste_guarda").await;
        sembrar(
            &db,
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza'), ('z2', 'Barra');
             UPDATE _Sync_State SET Last_Seq = 100 WHERE Id = 1;",
        )
        .await;
        let marca_antes = marca(&db).await.unwrap();
        let plan = vec![("Zonas".to_string(), hallazgo(&["z1"], &["z2"], &["z-arriba"]))];

        sembrar(
            &db,
            "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
               First_Failed_At_Ms, Last_Failed_At_Ms) VALUES ('op-x', 101, '[]', 1, 0, 1, 1);",
        )
        .await;
        assert!(encolar_plan(&db, marca_antes, 100, &plan, true, &HashSet::new()).await.unwrap().is_none(), "un fallo de bajada");
        sembrar(&db, "DELETE FROM _Sync_Failed;").await;

        sembrar(&db, "INSERT INTO _Backfill_Historico (Tabla, Orden, Completada) VALUES ('Zonas', 0, 0);").await;
        assert!(encolar_plan(&db, marca_antes, 100, &plan, true, &HashSet::new()).await.unwrap().is_none(), "el histórico a medias");
        sembrar(&db, "DELETE FROM _Backfill_Historico;").await;

        sembrar(&db, "UPDATE _Sync_State SET Last_Seq = 101 WHERE Id = 1;").await;
        assert!(encolar_plan(&db, marca_antes, 100, &plan, true, &HashSet::new()).await.unwrap().is_none(), "la base se ha movido");
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0);

        // Con la marca de ahora, sí: la distinta y la que falta suben, la que sobra se borra.
        let marca_ahora = marca(&db).await.unwrap();
        let e = encolar_plan(&db, marca_ahora, 101, &plan, true, &HashSet::new()).await.unwrap().expect("se encola");
        assert_eq!((e.reparadas, e.borradas), (2, 1));
        // Y lo encolado cambia la marca: la pasada siguiente parte de otra base.
        assert_ne!(marca(&db).await.unwrap(), marca_ahora);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Command_Name = 'main_reparacion';").await, 1);
        // Su eco no se aplicará aquí cuando vuelva.
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Applied_Ops;").await, 1);

        // Sin permiso para borrar, sólo sube.
        let marca_ahora = marca(&db).await.unwrap();
        let e = encolar_plan(&db, marca_ahora, 101, &plan, false, &HashSet::new()).await.unwrap().expect("se encola");
        assert_eq!((e.reparadas, e.borradas), (2, 0));
    }

    #[tokio::test]
    async fn una_apartada_se_enlaza_al_plan_que_toca_lo_suyo_si_sus_tablas_se_han_comparado_enteras() {
        // SYNC-31. La apartada cambió el nombre de `z1` (por su clave) y las mesas de esa zona (sin
        // nombrarlas): la resuelve un plan que toca `z1` o alguna mesa, con las dos tablas vistas.
        let (db, _dir) = base("contraste_apartadas").await;
        let sentencias = serde_json::json!([
            { "sql": "UPDATE Zonas SET Nombre_Zona = ?1 WHERE ID_Zona = ?2;", "args": ["Terraza", "z1"] },
            { "sql": "UPDATE Mesas SET Capacidad = 2 WHERE ID_Zona = ?1;", "args": ["z1"] },
        ]);
        sembrar(
            &db,
            &format!(
                "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena) VALUES ('apartada', 'main_op', '{sentencias}', 1, 1);"
            ),
        )
        .await;
        let w = db.write().await;
        let conn = w.raw();
        let tablas = |t: &[&str]| t.iter().map(|x| x.to_string()).collect::<HashSet<String>>();
        let mesa = FilaAfectada { tabla: "Mesas".into(), clave: vec![("ID_Mesa".into(), "m7".into())] };

        let enteras = tablas(&["Zonas", "Mesas"]);
        assert_eq!(apartadas_que_resuelve(&db, conn, &[&zona("z1")], &enteras).await.unwrap(), ["apartada"]);
        assert_eq!(apartadas_que_resuelve(&db, conn, &[&mesa], &enteras).await.unwrap(), ["apartada"], "no se sabe qué mesas tocó");
        assert!(apartadas_que_resuelve(&db, conn, &[&zona("z2")], &enteras).await.unwrap().is_empty(), "otra zona no es lo suyo");
        assert!(
            apartadas_que_resuelve(&db, conn, &[&zona("z1")], &tablas(&["Zonas"])).await.unwrap().is_empty(),
            "las mesas no se han comparado enteras"
        );
    }

    #[tokio::test]
    async fn una_foto_solo_deja_leer_y_deja_la_conexion_como_estaba() {
        // La sentencia de la ventana la escribe la nube: lo que no es una lectura no se ejecuta.
        let (db, _dir) = base("contraste_foto").await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');").await;
        let w = db.write().await;
        let conn = w.raw();
        for sql in [
            "DELETE FROM Zonas;",
            "WITH x AS (SELECT 1) DELETE FROM Zonas;",
            "SELECT 1; DELETE FROM Zonas;",
            "  -- un comentario\n UPDATE Zonas SET Nombre_Zona = 'x';",
            "/* otro */ INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z9', 'x');",
            "PRAGMA query_only = OFF;",
            "ATTACH 'otra.db' AS otra;",
            "SELECTED;",
        ] {
            let texto = sql.to_string();
            let r = conn.foto(move |foto| foto.filas(&texto, &[])).await;
            assert!(matches!(r, Err(ErrorSql::Misuse(_)) | Err(ErrorSql::SqliteFailure(..))), "{sql}: {r:?}");
        }
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas;").await, 1, "nada se ha borrado");

        // Lo que sí es una lectura, con comentarios delante y en minúsculas.
        let n = conn
            .foto(|foto| foto.entero("/* x */ -- y\n  with z as (select count(*) as n from Zonas) select n from z;", &[]))
            .await
            .unwrap();
        assert_eq!(n, Some(1));
        // La conexión vuelve a escribir, también tras una foto que falla dentro.
        conn.execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z2', 'Barra');", ()).await.unwrap();
        assert!(conn.foto(|foto| foto.filas("SELECT * FROM Tabla_Que_No_Existe;", &[])).await.is_err());
        conn.execute("DELETE FROM Zonas WHERE ID_Zona = 'z2';", ()).await.unwrap();
    }

    /// Las mismas filas resumen igual aquí y en el SQLite del TenantHub: `tests/contract/contraste/`.
    ///
    /// Se siembra la semilla, se resume cada tabla entera con el mismo código que la ventana
    /// (`celda` y `Resumidor`) y se compara con `golden.json`, que bendice este test
    /// (`BLESS_CONTRASTE=1`) y contra el que se conforma el worker (`test/contrasteGolden.test.ts`).
    #[tokio::test]
    async fn contraste_golden_las_mismas_filas_resumen_igual_en_los_dos_lados() {
        let carpeta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/contract/contraste");
        let semilla: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(carpeta.join("semilla.json")).unwrap()).unwrap();
        let (db, _dir) = base("contraste_golden").await;
        for sql in semilla["sentencias"].as_array().unwrap() {
            sembrar(&db, sql.as_str().unwrap()).await;
        }

        // Sólo las que siembra: la base de la Main trae además lo que crea al abrirse.
        let tablas: Vec<String> =
            semilla["tablas"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect();
        let r = db.read().await;
        let resumen = r
            .conn()
            .foto(move |foto| {
                let mut salida = serde_json::Map::new();
                for tabla in tablas {
                    let filas = foto.entero(&format!("SELECT COUNT(*) FROM \"{tabla}\";"), &[])?.unwrap_or(0);
                    let claves = claves_primarias(foto, &tabla)?;
                    let n_cubos = cubos::cubos_para(filas as u64);
                    // `SELECT *` da las columnas en el orden de la tabla: el de `pragma_table_info`.
                    let columnas: Vec<String> = foto
                        .filas("SELECT name FROM pragma_table_info(?1) ORDER BY cid;", &[Value::Text(tabla.clone())])?
                        .into_iter()
                        .filter_map(|f| match f.into_iter().next() {
                            Some(Value::Text(n)) => Some(n),
                            _ => None,
                        })
                        .collect();
                    let posiciones: Vec<usize> =
                        claves.iter().map(|k| columnas.iter().position(|c| c == k).unwrap()).collect();
                    let mut resumidor = Resumidor::nuevo(n_cubos).unwrap();
                    foto.recorrer(&format!("SELECT * FROM \"{tabla}\";"), &[], |valores| {
                        let celdas: Vec<Celda<'_>> = valores.iter().map(celda).collect();
                        resumidor.fila(&celdas, &posiciones);
                        Ok(())
                    })?;
                    let r = resumidor.fin();
                    salida.insert(
                        tabla,
                        serde_json::json!({
                            "filas": filas,
                            "cubos": n_cubos,
                            "cuentas": r.cuentas,
                            "sumas": r.sumas.iter().map(|s| cubos::hex64(*s)).collect::<Vec<_>>(),
                        }),
                    );
                }
                Ok(serde_json::Value::Object(salida))
            })
            .await
            .unwrap();
        drop(r);

        let ruta = carpeta.join("golden.json");
        if std::env::var("BLESS_CONTRASTE").is_ok() || !ruta.exists() {
            std::fs::write(&ruta, serde_json::to_string_pretty(&resumen).unwrap() + "\n").unwrap();
            eprintln!("[contraste] golden bendecido: {}", ruta.display());
            return;
        }
        let golden: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&ruta).unwrap()).unwrap();
        assert_eq!(resumen, golden, "el resumen de la semilla ya no es el de golden.json");
    }

    /// Lo que le cuesta a la Main resumir la ventana de un bar con mucho movimiento: un mes de mil
    /// comandas diarias, unas 600.000 filas (el gemelo de `test/verificarVolumen.test.ts`). Es una
    /// medida, no una comprobación: `cargo nextest run -p tpv-infra-sqlite --run-ignored only
    /// lo_que_cuesta_resumir --no-capture`.
    #[tokio::test]
    #[ignore]
    async fn lo_que_cuesta_resumir_el_mes_de_un_bar() {
        let (db, _dir) = base("contraste_volumen").await;
        let serie = |n: u32| format!("WITH RECURSIVE serie(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM serie WHERE i + 1 < {n})");
        let id = |p: &str, e: &str| format!("printf('{p}%07x-0000-7000-8000-%012x', {e}, {e})");
        let cuando = "datetime('2026-11-13 11:00:00', '-' || (i % 43000) || ' minutes')";
        let sql = [
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Cervezas');".to_string(),
            "INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, IVA_Percent) VALUES ('prod-1', 'cat-1', 'Caña', 250, 10);".to_string(),
            format!("{} INSERT INTO Comandas (ID_Comanda, Canal, Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado) SELECT {}, 'BARRA', {cuando}, {cuando}, 2250, 'Pagada' FROM serie;", serie(30_000), id("c", "i")),
            format!("{} INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Nombre_Producto, Cantidad, Precio_Unitario, IVA_Percent) SELECT {}, {}, 'prod-1', 'Caña de la casa', 1 + (i % 3) * 0.5, 250, 10.0 FROM serie;", serie(270_000), id("d", "i"), id("c", "i / 9")),
            format!("{} INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, Numero_Ticket) SELECT {}, {}, {cuando}, 'Efectivo', 2250, 'TOTAL', printf('T-%08d', i) FROM serie;", serie(30_000), id("p", "i"), id("c", "i")),
            format!("{} INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) SELECT {}, {} FROM serie;", serie(270_000), id("p", "i / 9"), id("d", "i")),
        ];
        for s in &sql {
            sembrar(&db, s).await;
        }
        let tablas = ["Comandas", "Detalle_Comanda", "Pagos", "Pago_Detalles"];
        let resumen = ResumenNube {
            checkpoint: Some(0),
            tablas: tablas
                .iter()
                .map(|t| ResumenTabla {
                    nombre: t.to_string(),
                    sql: Some(format!("SELECT * FROM \"{t}\";")),
                    cubos: 256,
                    cuentas: vec![0; 256],
                    sumas: vec!["0000000000000000".into(); 256],
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        // Las columnas y la clave las pone la Main desde su esquema, como las mandaría la nube.
        let resumen = {
            let r = db.read().await;
            r.conn()
                .foto(move |foto| {
                    let mut resumen = resumen;
                    for t in &mut resumen.tablas {
                        t.claves = claves_primarias(foto, &t.nombre)?;
                        t.columnas = foto
                            .filas("SELECT name FROM pragma_table_info(?1) ORDER BY cid;", &[Value::Text(t.nombre.clone())])?
                            .into_iter()
                            .filter_map(|f| match f.into_iter().next() {
                                Some(Value::Text(n)) => Some(n),
                                _ => None,
                            })
                            .collect();
                    }
                    Ok(resumen)
                })
                .await
                .unwrap()
        };
        let marca_ahora = marca(&db).await.unwrap();
        let resumen = Arc::new(resumen);
        let inicio = std::time::Instant::now();
        let r = db.read().await;
        let local = r.conn().foto(move |foto| foto_local(foto, &resumen, marca_ahora)).await.unwrap().unwrap();
        let tardado = inicio.elapsed();
        let filas: i64 = local.tablas.iter().map(|t| t.filas_local).sum();
        assert_eq!(filas, 600_000);
        println!("contraste en la Main · {filas} filas resumidas en {} ms", tardado.as_millis());
    }

    #[test]
    fn lo_de_la_ventana_y_lo_de_las_claves_se_juntan_sin_repetir() {
        let mut h = hallazgo(&["d"], &["a", "b"], &["x"]);
        juntar_claves(&mut h, hallazgo(&[], &["b", "c"], &["x", "y"]));
        assert_eq!(h.distintas, vec![zona("d")]);
        assert_eq!(h.faltan, vec![zona("a"), zona("b"), zona("c")]);
        assert_eq!(h.sobran, vec![zona("x"), zona("y")]);
    }

    #[test]
    fn el_orden_de_las_claves_es_el_de_sqlite() {
        use serde_json::json;
        use std::cmp::Ordering::{Equal, Greater, Less};
        assert_eq!(orden_sqlite(&[json!(2)], &[json!(10)]), Less);
        assert_eq!(orden_sqlite(&[json!("10")], &[json!("2")]), Less, "un texto, por sus bytes");
        assert_eq!(orden_sqlite(&[json!(99)], &[json!("1")]), Less, "un número va antes que un texto");
        assert_eq!(orden_sqlite(&[json!("ñ")], &[json!("z")]), Greater, "por bytes, no por letras");
        assert_eq!(orden_sqlite(&[json!("x"), json!(3)], &[json!("x"), json!(3)]), Equal);
        assert_eq!(orden_sqlite(&[json!("x"), json!(3)], &[json!("x"), json!(4)]), Less);
        assert_eq!(orden_sqlite(&[json!(1.5)], &[json!(1)]), Greater);
    }

    #[test]
    fn un_cobro_sube_antes_que_su_devolucion_aunque_venga_detras() {
        // `Pagos(ID_Pago, ID_Pago_Origen)`: la devolución `d1` apunta a `p1`, y `d2` a `d1`.
        let st = |id: &str, origen: Option<&str>| SqlStatement {
            sql: format!("-- {id}"),
            args: vec![serde_json::json!(id), origen.map_or(serde_json::Value::Null, |o| serde_json::json!(o))],
        };
        let refs = vec![(vec![1usize], vec![0usize])];
        let orden: Vec<String> = padres_antes(vec![st("d2", Some("d1")), st("d1", Some("p1")), st("x", None), st("p1", None)], &refs)
            .into_iter()
            .map(|s| s.sql)
            .collect();
        assert_eq!(orden, ["-- x", "-- p1", "-- d1", "-- d2"]);
        // Sin autorreferencias, como venían.
        assert_eq!(padres_antes(vec![st("b", None), st("a", None)], &[]).len(), 2);
    }

    #[test]
    fn lo_que_aparca_valores_unicos_va_entero_en_una_operacion() {
        // SYNC-37: lo aparcado y lo que lo pisa no se separan; lo demás se parte como siempre.
        let st = |n: usize| SqlStatement { sql: format!("-- {n}"), args: vec![] };
        let grupo = |desde: usize, cuantas: usize| (desde..desde + cuantas).map(st).collect::<Vec<_>>();
        let tamanos = |ops: Vec<Vec<SqlStatement>>| ops.iter().map(Vec::len).collect::<Vec<_>>();
        let n = SENTENCIAS_POR_OPERACION;
        // Sin aparcar, en tandas llenas.
        assert_eq!(tamanos(en_operaciones([(grupo(0, n - 10), false), (grupo(n, 30), false)])), [n, 20]);
        // Lo que aparca, si no cabe en lo que queda, empieza otra operación.
        let ops = en_operaciones([(grupo(0, n - 10), false), (grupo(n, 30), true), (grupo(2 * n, 5), false)]);
        assert_eq!(tamanos(ops.clone()), [n - 10, 35]);
        assert_eq!(ops[1][0].sql, format!("-- {n}"));
        // Si cabe, sigue en la misma; y todo en su orden.
        let ops = en_operaciones([(grupo(0, 10), false), (grupo(10, 30), true), (grupo(40, 5), false)]);
        assert_eq!(ops.concat().iter().map(|s| s.sql.clone()).collect::<Vec<_>>(), (0..45).map(|i| format!("-- {i}")).collect::<Vec<_>>());
        assert_eq!(tamanos(ops), [45]);
    }

    #[tokio::test]
    async fn las_autorreferencias_de_pagos_son_su_origen() {
        let (db, _dir) = base("contraste_autorreferencias").await;
        let w = db.write().await;
        let refs = autorreferencias(w.raw(), "Pagos").await.unwrap();
        assert_eq!(refs.len(), 1, "{refs:?}");
        assert!(autorreferencias(w.raw(), "Zonas").await.unwrap().is_empty());
    }

    #[test]
    fn un_borrado_solo_se_aplica_si_la_nube_no_ha_cambiado_desde_la_foto() {
        let st = borrado_si_la_nube_no_ha_cambiado(&zona("z9"), 45).unwrap();
        assert_eq!(
            st.sql,
            "DELETE FROM \"Zonas\" WHERE \"ID_Zona\" = ?1 AND EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq >= ?2) \
             AND NOT EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq > ?2 AND Command_Name IS NOT ?3);"
        );
        assert_eq!(st.args, vec![serde_json::json!("z9"), serde_json::json!(45), serde_json::json!("main_reparacion")]);
    }

    #[tokio::test]
    async fn el_borrado_condicionado_no_hace_nada_en_una_main() {
        // Una Main que se pone al día con el log de la nube (otra que sustituye a ésta) recibe la
        // sentencia: en su base `Sync_Changes` está vacía, y no tiene que borrar nada.
        let (db, _dir) = base("contraste_borrado_en_main").await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z9', 'Almacén');").await;
        let st = borrado_si_la_nube_no_ha_cambiado(&zona("z9"), 45).unwrap();
        {
            let w = db.write().await;
            let args: Vec<Value> = st
                .args
                .iter()
                .map(|v| match v {
                    serde_json::Value::String(s) => Value::Text(s.clone()),
                    otro => Value::Integer(otro.as_i64().unwrap()),
                })
                .collect();
            w.raw().execute(&st.sql, args).await.unwrap();
        }
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z9';").await, 1);
    }

    #[tokio::test]
    async fn lo_que_sobra_aparca_sus_valores_unicos_con_la_condicion_de_su_borrado() {
        // SYNC-38. La zona que sobra arriba suelta su nombre si, y sólo si, se va a borrar.
        let (db, _dir) = base("contraste_aparcar_lo_que_sobra").await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z9', 'Patio');").await;
        let w = db.write().await;
        let indices = crate::aparcar::indices_unicos(w.raw(), "Zonas").await.unwrap();
        let st = aparcar_si_la_nube_no_ha_cambiado(&zona("z9"), &indices, 45).unwrap();
        assert_eq!(
            st.sql,
            "UPDATE \"Zonas\" SET \"Nombre_Zona\" = ?4 WHERE \"ID_Zona\" = ?1 AND EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq >= ?2) \
             AND NOT EXISTS (SELECT 1 FROM Sync_Changes WHERE Seq > ?2 AND Command_Name IS NOT ?3);"
        );
        let temporal = crate::aparcar::valor_temporal(&[serde_json::json!("z9")]);
        assert_eq!(st.args, vec![serde_json::json!("z9"), serde_json::json!(45), serde_json::json!("main_reparacion"), serde_json::json!(temporal)]);
        // Lo que sube lo leen la subida y SYNC-31 sin ejecutarlo: es una escritura de esa zona.
        let e = crate::filas_tocadas::estaticas(std::slice::from_ref(&st), &|_| vec!["ID_Zona".to_string()]);
        assert!(e.todas.contains("Zonas") && !e.tablas.contains("*"), "{:?}", e.tablas);
        assert_eq!(e.claves.len(), 1);
        // Sin índices únicos no hay nada que aparcar.
        assert!(aparcar_si_la_nube_no_ha_cambiado(&zona("z9"), &[], 45).is_none());

        // En una Main (`Sync_Changes` vacía) no hace nada, como el borrado.
        let args: Vec<Value> = st
            .args
            .iter()
            .map(|v| match v {
                serde_json::Value::String(s) => Value::Text(s.clone()),
                otro => Value::Integer(otro.as_i64().unwrap()),
            })
            .collect();
        assert_eq!(w.raw().execute(&st.sql, args).await.unwrap(), 0);
        drop(w);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE Nombre_Zona = 'Patio';").await, 1);
    }

    #[tokio::test]
    async fn lo_que_aparca_lo_que_sobra_va_con_todo_el_plan_en_una_operacion_y_si_no_cabe_no_se_aparca() {
        // SYNC-38. Aquí la zona `z4` se llama Patio y arriba no está; arriba sobra `z9`, que se llama
        // así. Lo de las dos va en una operación: aparcar `z9`, subir `z4`, borrar `z9`.
        let (db, _dir) = base("contraste_plan_con_lo_que_sobra").await;
        sembrar(
            &db,
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z4', 'Patio');
             UPDATE _Sync_State SET Last_Seq = 100 WHERE Id = 1;",
        )
        .await;
        let plan = vec![("Zonas".to_string(), hallazgo(&[], &["z4"], &["z9"]))];
        let marca_ahora = marca(&db).await.unwrap();
        encolar_plan(&db, marca_ahora, 100, &plan, true, &HashSet::new()).await.unwrap().expect("se encola");
        let ops = {
            let r = db.read().await;
            let mut f = r.conn().query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq;", ()).await.unwrap();
            let mut ops: Vec<Vec<SqlStatement>> = Vec::new();
            while let Some(fila) = f.next().await.unwrap() {
                ops.push(serde_json::from_str(&fila.get::<String>(0).unwrap()).unwrap());
            }
            ops
        };
        assert_eq!(ops.len(), 1);
        let sql: Vec<&str> = ops[0].iter().map(|s| s.sql.as_str()).collect();
        assert_eq!(sql.len(), 3, "{sql:?}");
        assert!(sql[0].starts_with("UPDATE \"Zonas\" SET \"Nombre_Zona\" = ?4 WHERE \"ID_Zona\" = ?1 AND EXISTS"), "{}", sql[0]);
        assert!(sql[1].starts_with("INSERT INTO \"Zonas\""), "{}", sql[1]);
        assert!(sql[2].starts_with("DELETE FROM \"Zonas\""), "{}", sql[2]);

        // Sin nada que suba de esa tabla, lo que sobra no aparca nada.
        sembrar(&db, "DELETE FROM _Sync_Outbox;").await;
        let solo_sobra = vec![("Zonas".to_string(), hallazgo(&[], &[], &["z9"]))];
        let marca_ahora = marca(&db).await.unwrap();
        encolar_plan(&db, marca_ahora, 100, &solo_sobra, true, &HashSet::new()).await.unwrap().expect("se encola");
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Statements_Json LIKE '%UPDATE%';").await, 0);

        // Un plan que no cabe en una operación no aparca lo que sobra, y se parte como siempre.
        sembrar(&db, "DELETE FROM _Sync_Outbox;").await;
        sembrar(
            &db,
            &format!(
                "WITH RECURSIVE s(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM s WHERE i + 1 < {SENTENCIAS_POR_OPERACION})
                 INSERT INTO Zonas (ID_Zona, Nombre_Zona) SELECT printf('zn-%04d', i), printf('Nueva %04d', i) FROM s;"
            ),
        )
        .await;
        let muchas: Vec<String> = (0..SENTENCIAS_POR_OPERACION).map(|i| format!("zn-{i:04}")).collect();
        let muchas: Vec<&str> = muchas.iter().map(String::as_str).collect();
        let grande = vec![("Zonas".to_string(), hallazgo(&[], &muchas, &["z9"]))];
        let marca_ahora = marca(&db).await.unwrap();
        encolar_plan(&db, marca_ahora, 100, &grande, true, &HashSet::new()).await.unwrap().expect("se encola");
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 2);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Statements_Json LIKE '%\"UPDATE %';").await, 0);
    }

    #[tokio::test]
    async fn los_borrados_de_una_tabla_que_se_apunta_a_si_misma_van_de_la_clave_mayor_a_la_menor() {
        let (db, _dir) = base("contraste_borrado_autorreferencia").await;
        sembrar(&db, "UPDATE _Sync_State SET Last_Seq = 100 WHERE Id = 1;").await;
        let pago = |id: &str| FilaAfectada { tabla: "Pagos".into(), clave: vec![("ID_Pago".into(), id.into())] };
        let plan = vec![(
            "Pagos".to_string(),
            Hallazgo { sobran: vec![pago("0193-a-cobro"), pago("0193-c-devolucion"), pago("0193-b-cobro")], ..Default::default() },
        )];
        let marca_ahora = marca(&db).await.unwrap();
        encolar_plan(&db, marca_ahora, 100, &plan, true, &HashSet::new()).await.unwrap().expect("se encola");
        let r = db.read().await;
        let mut f = r.conn().query("SELECT Statements_Json FROM _Sync_Outbox;", ()).await.unwrap();
        let json: String = f.next().await.unwrap().unwrap().get(0).unwrap();
        let sentencias: Vec<SqlStatement> = serde_json::from_str(&json).unwrap();
        let orden: Vec<&str> = sentencias.iter().map(|s| s.args[0].as_str().unwrap()).collect();
        assert_eq!(orden, ["0193-c-devolucion", "0193-b-cobro", "0193-a-cobro"]);
    }

    #[test]
    fn el_tope_de_filas_se_reparte_por_cubos_y_al_menos_entra_uno() {
        let ventana = Ventana {
            sql: String::new(),
            args: vec![],
            columnas: vec![],
            claves: vec![],
            posiciones: vec![],
            nube: ResumenCubos { cuentas: vec![10, 300, 20, 5], sumas: vec![0; 4] },
            cuentas_locales: vec![12, 290, 20, 7],
            distintos: vec![0, 1, 3],
        };
        assert_eq!(cubos_que_caben(&ventana, 1_000), (vec![0, 1, 3], 12 + 300 + 7));
        assert_eq!(cubos_que_caben(&ventana, 100), (vec![0], 12));
        // Un cubo que sólo él pasa del tope se examina igual, o no se examinaría nunca.
        assert_eq!(cubos_que_caben(&ventana, 1), (vec![0], 12));
    }

    #[tokio::test]
    async fn las_tablas_van_padres_primero_y_cada_una_sabe_a_quien_apunta() {
        let (db, _dir) = base("contraste_orden").await;
        let r = db.read().await;
        let nombres: Vec<String> =
            ["Pago_Detalles", "Detalle_Comanda", "Pagos", "Comandas", "Zonas", "Mesas"].iter().map(|t| t.to_string()).collect();
        let orden = r.conn().foto(move |foto| padres_primero(foto, &nombres)).await.unwrap();
        let posicion = |t: &str| orden.iter().position(|(n, _)| n == t).unwrap();
        assert!(posicion("Zonas") < posicion("Mesas"));
        assert!(posicion("Mesas") < posicion("Comandas"));
        assert!(posicion("Comandas") < posicion("Detalle_Comanda") && posicion("Comandas") < posicion("Pagos"));
        assert!(posicion("Pagos") < posicion("Pago_Detalles") && posicion("Detalle_Comanda") < posicion("Pago_Detalles"));
        let padres = &orden[posicion("Pago_Detalles")].1;
        assert!(padres.contains("Pagos") && padres.contains("Detalle_Comanda"), "{padres:?}");
    }
}
