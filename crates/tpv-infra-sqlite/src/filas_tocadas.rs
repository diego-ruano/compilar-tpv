//! SYNC-36 · Las filas que toca un cambio de la nube que no entra en esta base.
//!
//! Un cambio que no se puede aplicar acaba en cuarentena (`_Sync_Failed`), y mientras esté ahí el
//! contraste con la nube no repara nada: lo que aquí falta puede ser lo que escribió ese cambio. La
//! salida es traer de la nube cómo están **ahora** las filas que tocó (`cuarentenas_bajada.rs`), y
//! para eso hace falta saber cuáles son: su tabla y su clave primaria. Se apunta en `Filas_Json`, y
//! es lo único que queda del cambio cuando, a los 30 días, se vacían sus sentencias: una clave es un
//! identificador, no un dato de nadie.
//!
//! # De dónde salen
//!
//! Ni el cambio ni el log de la nube lo dicen: un cambio son sentencias ya resueltas, y muchas no
//! nombran sus filas (`UPDATE Productos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1`, `INSERT …
//! SELECT`, `DELETE … WHERE ID_Lote IN (SELECT …)`). Leerlas a mano sólo entiende las formas
//! sencillas. Lo que sí sabe cuáles son es SQLite al ejecutarlas, así que se ejecutan en un
//! **simulacro** (`Connection::simulacro`: una transacción que se deshace siempre) con un
//! `RETURNING` de la clave primaria, sobre esta base tal como está cuando el cambio falla por
//! primera vez: con la bajada en orden (AUD-18) es la base de justo antes del cambio, que es la de la
//! nube en ese momento salvo lo que ya divergía (y eso tiene su propia cuarentena).
//!
//! Lo que el `RETURNING` no ve, se suma por otro lado:
//!
//! - **La sentencia que falla** (la que choca con un `UNIQUE`, un `CHECK` o un trigger) no devuelve
//!   nada. Ni las que se saltan: un `INSERT OR IGNORE` o un `ON CONFLICT … DO NOTHING` que choca, o
//!   un `UPDATE … WHERE ID_Lote = ?1 AND Stock = ?2` cuyo stock aquí es otro. Por eso, antes de
//!   ejecutarla, se mira qué filas tocaría: de un `INSERT`, las claves de lo que inserta (su
//!   `VALUES` o su `SELECT`, leído como una tabla); de un `UPDATE` o un `DELETE`, las de las filas
//!   que cumplen las igualdades de su `WHERE` (`ID_Lote = ?1`), sin las demás condiciones, que es un
//!   conjunto mayor; sin igualdades que usar, las de su `WHERE` entero.
//! - **Lo que no se sabe** se dice (`incierto`), y entonces el cambio no se trae por estado: su
//!   cuarentena se queda. Es una sentencia que no se sabe leer ni ejecutar (una tabla que esta versión
//!   no tiene), una que no escribe filas (un `COMMIT`), un `REPLACE` (que borra lo que choca, sea cual
//!   sea su clave) o más filas de las que caben.
//!
//! Las filas que una sentencia **borra** se marcan (`borrada`): si la nube ya no las tiene, aquí
//! tampoco tienen que estar. De las demás, que la nube no las tenga no dice nada de esta base.

use std::collections::HashMap;

use serde_json::{json, Value as Json};
use tpv_contracts::sync::SqlStatement;

use crate::ejecutor::{Connection, Simulacro, Value};

/// Lo más que se apunta de un cambio. Un cambio que toca más (un borrado de una tabla entera) no se
/// trae por estado: sería bajar media base para cerrar una cuarentena.
pub(crate) const MAX_FILAS_TOCADAS: usize = 5_000;

/// Lo que se sabe de las filas que toca un cambio.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Tocadas {
    /// Las tablas de negocio en las que escribe alguna de sus sentencias, sin repetir y en orden.
    pub tablas: Vec<String>,
    /// Las filas, por su clave primaria.
    pub filas: Vec<FilaTocada>,
    /// Alguna sentencia toca filas que no se saben localizar: no se puede traer de la nube por estado.
    pub incierto: bool,
}

/// Una fila que toca un cambio.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FilaTocada {
    pub tabla: String,
    /// Los valores de su clave primaria, en el orden de la clave, como viajan en JSON.
    pub clave: Vec<Json>,
    /// Alguna sentencia del cambio la borra.
    pub borrada: bool,
}

impl Tocadas {
    pub(crate) fn incierta(tablas: Vec<String>) -> Self {
        Tocadas { tablas, filas: Vec::new(), incierto: true }
    }

    /// Como se guarda en `_Sync_Failed.Filas_Json`.
    pub(crate) fn a_json(&self) -> String {
        json!({
            "tablas": self.tablas,
            "incierto": self.incierto,
            "filas": self.filas.iter().map(|f| json!({ "tabla": f.tabla, "clave": f.clave, "borrada": f.borrada })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// Lo guardado en `Filas_Json`. Lo que no se sabe leer es incierto: no se trae nada.
    pub(crate) fn de_json(texto: &str) -> Tocadas {
        let Ok(v) = serde_json::from_str::<Json>(texto) else {
            return Tocadas::incierta(Vec::new());
        };
        let tablas: Vec<String> =
            v["tablas"].as_array().map(|t| t.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()).unwrap_or_default();
        let mut filas = Vec::new();
        for f in v["filas"].as_array().map(Vec::as_slice).unwrap_or_default() {
            match (f["tabla"].as_str(), f["clave"].as_array()) {
                (Some(tabla), Some(clave)) if !clave.is_empty() => filas.push(FilaTocada {
                    tabla: tabla.to_owned(),
                    clave: clave.clone(),
                    borrada: f["borrada"].as_bool().unwrap_or(false),
                }),
                _ => return Tocadas::incierta(tablas),
            }
        }
        Tocadas { incierto: v["incierto"].as_bool().unwrap_or(true), tablas, filas }
    }
}

/// Las filas que tocan `sentencias` sobre esta base tal como está, en un simulacro: no escribe nada.
/// Nunca falla: lo que no se puede saber sale como incierto.
///
/// Por la conexión de escritura (el simulacro escribe y deshace), sin otra transacción abierta.
pub(crate) async fn de_un_cambio(conn: &Connection, sentencias: &[SqlStatement]) -> Tocadas {
    let tablas = tablas_escritas(sentencias);
    let sentencias = sentencias.to_vec();
    let de_reserva = tablas.clone();
    match conn.simulacro(move |sim| simular(sim, &sentencias, tablas)).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(target: "tpv::sync", error = %e, "no se ha podido saber qué filas toca un cambio de la nube");
            Tocadas::incierta(de_reserva)
        }
    }
}

/// Las tablas de negocio en las que escriben las sentencias, por cómo empiezan.
fn tablas_escritas(sentencias: &[SqlStatement]) -> Vec<String> {
    let mut tablas: Vec<String> = sentencias
        .iter()
        .filter_map(|s| Forma::leer(&s.sql))
        .map(|f| f.tabla)
        .filter(|t| !crate::sync::no_es_tabla_de_negocio(t))
        .collect();
    tablas.sort();
    tablas.dedup();
    tablas
}

/// Las claves que se van juntando, sin repetir.
#[derive(Default)]
struct Junta {
    filas: Vec<FilaTocada>,
    vistas: HashMap<String, usize>,
}

impl Junta {
    /// Apunta una fila; `false` si ya no caben.
    fn apuntar(&mut self, tabla: &str, clave: Vec<Json>, borrada: bool) -> bool {
        let Some(canonica) = canonica(tabla, &clave) else {
            return false;
        };
        if let Some(&i) = self.vistas.get(&canonica) {
            self.filas[i].borrada |= borrada;
            return true;
        }
        if self.filas.len() == MAX_FILAS_TOCADAS {
            return false;
        }
        self.vistas.insert(canonica, self.filas.len());
        self.filas.push(FilaTocada { tabla: tabla.to_owned(), clave, borrada });
        true
    }
}

/// Una forma de la clave que no depende de cómo llegó (`1` y `1.0` son lo mismo).
fn canonica(tabla: &str, clave: &[Json]) -> Option<String> {
    let mut s = format!("{tabla}\u{1f}");
    s.push_str(&crate::contraste::clave_canonica(clave)?);
    Some(s)
}

/// El valor de una columna de clave, como viaja en JSON. Una clave nula o binaria no se sabe pedir.
fn clave_en_json(v: &Value) -> Option<Json> {
    match v {
        Value::Integer(n) => Some(json!(n)),
        Value::Real(x) => serde_json::Number::from_f64(*x).map(Json::Number),
        Value::Text(t) => Some(Json::String(t.clone())),
        Value::Null | Value::Blob(_) => None,
    }
}

fn argumento(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(i64::from(*b)),
        Json::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
        Json::String(s) => Value::Text(s.clone()),
        otro => Value::Text(otro.to_string()),
    }
}

/// Lo que hace falta de una tabla de aquí.
#[derive(Debug, Clone)]
struct Esquema {
    /// Su nombre como está en el esquema (el de la sentencia puede ir en otras mayúsculas).
    nombre: String,
    /// Sus columnas, en su orden.
    columnas: Vec<String>,
    /// Las de su clave primaria, en el orden de la clave. Vacía si la tabla no está.
    clave: Vec<String>,
    /// Las que son una clave foránea.
    foraneas: Vec<String>,
    /// Si cada columna de la clave guarda enteros (`INT` en su tipo) o textos, como dice SQLite de
    /// su afinidad; `None` si ninguna de las dos.
    enteras: Vec<Option<bool>>,
}

impl Esquema {
    /// Las columnas por las que se puede buscar una fila sin que lo que se busca dependa de un
    /// valor que cambia: las de su clave y las de sus foráneas, que son identificadores.
    fn identifica(&self, columna: &str) -> bool {
        self.clave.iter().chain(&self.foraneas).any(|c| c.eq_ignore_ascii_case(columna))
    }

    /// Una clave leída de la sentencia (no de la base), con el tipo con el que la guarda la tabla:
    /// `WHERE ID = '1'` en una clave entera es la fila 1, y una vez guardada se lee como `1`.
    fn como_se_guarda(&self, clave: Vec<Json>) -> Vec<Json> {
        clave
            .into_iter()
            .zip(&self.enteras)
            .map(|(v, entera)| match (v, entera) {
                (Json::String(s), Some(true)) => s.trim().parse::<i64>().map(|n| json!(n)).unwrap_or(Json::String(s)),
                (Json::Number(n), Some(false)) => Json::String(n.to_string()),
                (v, _) => v,
            })
            .collect()
    }
}

fn esquema_de(sim: &Simulacro<'_>, tabla: &str) -> Option<Esquema> {
    let canonico = sim
        .filas("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1 COLLATE NOCASE;", &[Value::Text(tabla.to_owned())], 2)
        .ok()?
        .into_iter()
        .find_map(|f| match f.into_iter().next() {
            Some(Value::Text(n)) => Some(n),
            _ => None,
        })
        .unwrap_or_else(|| tabla.to_owned());
    let nombre = [Value::Text(canonico.clone())];
    let filas = sim.filas("SELECT name, pk, upper(type) FROM pragma_table_info(?1) ORDER BY cid;", &nombre, 1_000).ok()?;
    let mut columnas = Vec::new();
    let mut clave: Vec<(i64, String, Option<bool>)> = Vec::new();
    for f in filas {
        let (Some(Value::Text(nombre)), Some(Value::Integer(pk))) = (f.first(), f.get(1)) else { continue };
        if *pk > 0 {
            let tipo = match f.get(2) {
                Some(Value::Text(t)) => t.clone(),
                _ => String::new(),
            };
            let entera = if tipo.contains("INT") {
                Some(true)
            } else if ["CHAR", "CLOB", "TEXT"].iter().any(|x| tipo.contains(x)) {
                Some(false)
            } else {
                None
            };
            clave.push((*pk, nombre.clone(), entera));
        }
        columnas.push(nombre.clone());
    }
    clave.sort_by_key(|(pk, _, _)| *pk);
    let enteras = clave.iter().map(|(_, _, e)| *e).collect();
    let foraneas = sim
        .filas("SELECT \"from\" FROM pragma_foreign_key_list(?1);", &nombre, 1_000)
        .ok()?
        .into_iter()
        .filter_map(|f| match f.into_iter().next() {
            Some(Value::Text(c)) => Some(c),
            _ => None,
        })
        .collect();
    Some(Esquema { nombre: canonico, columnas, clave: clave.into_iter().map(|(_, c, _)| c).collect(), foraneas, enteras })
}

/// El cuerpo del simulacro: cada sentencia, en orden, con lo que se sabe de ella.
fn simular(sim: &Simulacro<'_>, sentencias: &[SqlStatement], tablas: Vec<String>) -> Tocadas {
    let mut junta = Junta::default();
    let mut esquemas: HashMap<String, Option<Esquema>> = HashMap::new();
    for st in sentencias {
        let args: Vec<Value> = st.args.iter().map(argumento).collect();
        match una_sentencia(sim, st, &args, &mut esquemas, &mut junta) {
            Ok(()) => {}
            Err(()) => return Tocadas::incierta(tablas),
        }
    }
    Tocadas { tablas, filas: junta.filas, incierto: false }
}

/// Lo que toca una sentencia. `Err` si no se sabe.
fn una_sentencia(
    sim: &Simulacro<'_>,
    st: &SqlStatement,
    args: &[Value],
    esquemas: &mut HashMap<String, Option<Esquema>>,
    junta: &mut Junta,
) -> Result<(), ()> {
    let Some(forma) = Forma::leer(&st.sql) else {
        // Un `PRAGMA` no toca filas (el cambio puede llevar el de las foráneas). Cualquier otra cosa
        // que no se sabe leer, no se sabe qué toca.
        return if empieza_por_pragma(&st.sql) { Ok(()) } else { Err(()) };
    };
    if forma.reemplaza {
        // `REPLACE` borra lo que choca con cualquier índice único, sea cual sea su clave.
        return Err(());
    }
    if crate::sync::no_es_tabla_de_negocio(&forma.tabla) {
        // Estado de cada lado: no se trae de la nube. Se ejecuta para que lo de detrás vea lo mismo.
        let _ = sim.filas(&st.sql, args, MAX_FILAS_TOCADAS);
        return Ok(());
    }
    let Some(esquema) = esquemas.entry(forma.tabla.clone()).or_insert_with(|| esquema_de(sim, &forma.tabla)).clone() else {
        return Err(());
    };
    let clave = &esquema.clave;
    if clave.is_empty() {
        // Una tabla que aquí no está, o sin clave primaria: sus filas no se saben pedir.
        return Err(());
    }
    let borra = forma.tipo == Tipo::Borrar;

    // La fila que nombra entera por su clave (`WHERE ID_Mesa = ?1 AND …`), esté aquí o no.
    let mut nombrada = false;
    if forma.tipo != Tipo::Insertar {
        if let Some(claves) = claves_estaticas(&st.sql, &st.args, &forma, clave) {
            nombrada = true;
            for k in claves {
                if !junta.apuntar(&esquema.nombre, esquema.como_se_guarda(k), borra) {
                    return Err(());
                }
            }
        }
    }

    // Antes de ejecutarla, lo que tocaría. Si se puede mirar y no se puede leer (un `?` sin
    // número, una lectura que aquí no corre), el `RETURNING` solo diría lo que toca aquí con lo que
    // hay aquí, que puede ser menos de lo que tocó arriba: no se sabe, salvo que nombre su fila.
    let previa = match forma.previa(&st.sql, &esquema) {
        None => None,
        Some(sql) => match con_sus_parametros(&sql, args).map(|a| sim.filas(&sql, &a, MAX_FILAS_TOCADAS)) {
            Some(Ok(filas)) => Some(filas),
            // Más de las que caben: no se puede traer por estado.
            Some(Err(e)) if e.to_string().contains(crate::ejecutor::DEMASIADAS_FILAS) => return Err(()),
            _ if nombrada => None,
            _ => return Err(()),
        },
    };
    if let Some(filas) = &previa {
        for f in filas {
            let Some(k) = f.iter().map(clave_en_json).collect::<Option<Vec<_>>>() else { return Err(()) };
            if !junta.apuntar(&esquema.nombre, k, borra) {
                return Err(());
            }
        }
    }

    // Y la sentencia, con su `RETURNING`: lo que de verdad toca aquí.
    let ejecutada = if forma.con_returning {
        sim.filas(&st.sql, args, usize::MAX).map(|_| Vec::new())
    } else {
        let lista = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
        sim.filas(&format!("{} RETURNING {lista}", forma.cuerpo(&st.sql)), args, MAX_FILAS_TOCADAS)
    };
    match ejecutada {
        Err(e) if e.to_string().contains(crate::ejecutor::DEMASIADAS_FILAS) => return Err(()),
        Ok(filas) => {
            if forma.con_returning && previa.is_none() {
                // Ya traía su `RETURNING` y no se ha podido mirar antes: no se sabe qué tocó.
                return Err(());
            }
            for f in filas {
                let Some(k) = f.iter().map(clave_en_json).collect::<Option<Vec<_>>>() else { return Err(()) };
                if !junta.apuntar(&esquema.nombre, k, borra) {
                    return Err(());
                }
            }
        }
        // Falla aquí (es la que choca, o depende de una que chocó): vale lo que se miró antes.
        Err(_) if previa.is_some() => {}
        Err(_) => return Err(()),
    }
    // Lo que se salta al chocar no sale en el `RETURNING`: sin haberlo mirado antes, no se sabe.
    if forma.puede_saltarse && previa.is_none() {
        return Err(());
    }
    Ok(())
}

fn empieza_por_pragma(sql: &str) -> bool {
    trocear(sql).and_then(|p| p.first().copied()).is_some_and(|p| p.clase == Clase::Palabra && sql[p.ini..p.fin].eq_ignore_ascii_case("PRAGMA"))
}

/// Los argumentos que usa `sql`, que numera los suyos (`?N`) como la sentencia de la que sale: los
/// primeros hasta el mayor que aparece. Con un `?` sin número o uno con nombre, no se sabe cuáles.
fn con_sus_parametros(sql: &str, args: &[Value]) -> Option<Vec<Value>> {
    let piezas = trocear(sql)?;
    let mut mayor = 0usize;
    for p in piezas.iter().filter(|p| p.clase == Clase::Parametro) {
        let n: usize = sql[p.ini + 1..p.fin].parse().ok()?;
        mayor = mayor.max(n);
    }
    (mayor <= args.len()).then(|| args[..mayor].to_vec())
}

/// Un identificador entre comillas dobles.
pub(crate) fn cita(nombre: &str) -> String {
    format!("\"{}\"", nombre.replace('"', "\"\""))
}

/* ===== Leer una sentencia ===== */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Clase {
    /// Una palabra sin comillas: una palabra clave o un nombre.
    Palabra,
    /// Un nombre entre comillas (`"x"`, `[x]`, `` `x` ``).
    Cita,
    /// Un texto (`'x'`).
    Texto,
    Numero,
    /// `?N`, `?`, `:x`, `@x`, `$x`.
    Parametro,
    Signo,
}

#[derive(Debug, Clone, Copy)]
struct Pieza {
    clase: Clase,
    ini: usize,
    fin: usize,
}

/// Las piezas de una sentencia, sin espacios ni comentarios. `None` si un texto, una cita o un
/// comentario no se cierra.
fn trocear(sql: &str) -> Option<Vec<Pieza>> {
    let b = sql.as_bytes();
    let mut piezas = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if c == b'-' && b.get(i + 1) == Some(&b'-') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2 + sql[i + 2..].find("*/")? + 2;
            continue;
        }
        let ini = i;
        let clase = match c {
            b'\'' => {
                i = cerrar(b, i, b'\'')?;
                Clase::Texto
            }
            b'"' | b'`' => {
                i = cerrar(b, i, c)?;
                Clase::Cita
            }
            b'[' => {
                i += sql[i..].find(']')? + 1;
                Clase::Cita
            }
            b'?' => {
                i += 1;
                while i < b.len() && b[i].is_ascii_digit() {
                    i += 1;
                }
                Clase::Parametro
            }
            b':' | b'@' | b'$' if b.get(i + 1).is_some_and(|x| x.is_ascii_alphanumeric() || *x == b'_') => {
                i += 1;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                Clase::Parametro
            }
            b'0'..=b'9' => {
                i = numero(b, i);
                Clase::Numero
            }
            b'.' if b.get(i + 1).is_some_and(u8::is_ascii_digit) => {
                i = numero(b, i);
                Clase::Numero
            }
            c if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 => {
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$' || b[i] >= 0x80) {
                    i += 1;
                }
                Clase::Palabra
            }
            _ => {
                let dos = sql.get(i..i + 2).unwrap_or("");
                i += if sql.get(i..i + 3) == Some("->>") {
                    3
                } else if ["==", "!=", "<>", "<=", ">=", "||", "<<", ">>", "->"].contains(&dos) {
                    2
                } else {
                    1
                };
                Clase::Signo
            }
        };
        piezas.push(Pieza { clase, ini, fin: i });
    }
    Some(piezas)
}

/// El final de un texto o una cita que empieza en `i` (la comilla doblada es una comilla dentro).
fn cerrar(b: &[u8], mut i: usize, comilla: u8) -> Option<usize> {
    i += 1;
    loop {
        let c = *b.get(i)?;
        i += 1;
        if c == comilla {
            if b.get(i) == Some(&comilla) {
                i += 1;
                continue;
            }
            return Some(i);
        }
    }
}

fn numero(b: &[u8], mut i: usize) -> usize {
    if b[i] == b'0' && matches!(b.get(i + 1), Some(b'x' | b'X')) {
        i += 2;
        while i < b.len() && b[i].is_ascii_hexdigit() {
            i += 1;
        }
        return i;
    }
    while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.' || b[i] == b'_') {
        i += 1;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if matches!(b.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        if b.get(j).is_some_and(u8::is_ascii_digit) {
            i = j;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
        }
    }
    i
}

/// Una sentencia troceada, con la profundidad de paréntesis de cada pieza.
struct Troceada<'a> {
    sql: &'a str,
    piezas: Vec<Pieza>,
    nivel: Vec<i32>,
}

impl<'a> Troceada<'a> {
    fn de(sql: &'a str) -> Option<Self> {
        let piezas = trocear(sql)?;
        let mut nivel = Vec::with_capacity(piezas.len());
        let mut n = 0i32;
        for p in &piezas {
            let s = &sql[p.ini..p.fin];
            if p.clase == Clase::Signo && s == ")" {
                n -= 1;
            }
            nivel.push(n);
            if p.clase == Clase::Signo && s == "(" {
                n += 1;
            }
        }
        (n == 0 && nivel.iter().all(|x| *x >= 0)).then_some(Troceada { sql, piezas, nivel })
    }

    fn texto(&self, i: usize) -> &'a str {
        let p = self.piezas[i];
        &self.sql[p.ini..p.fin]
    }

    fn es(&self, i: usize, palabra: &str) -> bool {
        self.piezas.get(i).is_some_and(|p| p.clase == Clase::Palabra) && self.texto(i).eq_ignore_ascii_case(palabra)
    }

    fn signo(&self, i: usize, s: &str) -> bool {
        self.piezas.get(i).is_some_and(|p| p.clase == Clase::Signo) && self.texto(i) == s
    }

    /// Un nombre (con comillas o sin ellas), sin sus comillas.
    fn nombre(&self, i: usize) -> Option<String> {
        let p = *self.piezas.get(i)?;
        let s = self.texto(i);
        match p.clase {
            Clase::Palabra => Some(s.to_owned()),
            Clase::Cita if s.starts_with('[') => Some(s[1..s.len() - 1].to_owned()),
            Clase::Cita => {
                let q = &s[..1];
                Some(s[1..s.len() - 1].replace(&format!("{q}{q}"), q))
            }
            _ => None,
        }
    }

    /// La primera pieza desde `desde` (hasta `hasta`) al nivel 0 que cumple `f`.
    fn buscar(&self, desde: usize, hasta: usize, f: impl Fn(usize) -> bool) -> Option<usize> {
        (desde..hasta).find(|&i| self.nivel[i] == 0 && f(i))
    }

    /// El cierre del paréntesis que abre `i`.
    fn cierre(&self, i: usize) -> Option<usize> {
        let nivel = self.nivel[i];
        (i + 1..self.piezas.len()).find(|&j| self.nivel[j] == nivel && self.signo(j, ")"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tipo {
    Insertar,
    Actualizar,
    Borrar,
}

/// El `WHERE` de un `UPDATE` o un `DELETE`.
#[derive(Debug, Clone)]
enum Donde {
    /// Sin `WHERE`: toca la tabla entera.
    Toda,
    /// Las piezas de su condición.
    Piezas(usize, usize),
    /// Un `UPDATE … FROM` o un `INDEXED BY`: no se mira antes.
    NoSe,
}

/// Lo que importa de una sentencia que escribe.
#[derive(Debug, Clone)]
struct Forma {
    tipo: Tipo,
    tabla: String,
    alias: Option<String>,
    /// `INSERT OR REPLACE`, `REPLACE INTO` o `UPDATE OR REPLACE`.
    reemplaza: bool,
    /// `INSERT OR IGNORE`, `UPDATE OR IGNORE` o un `ON CONFLICT … DO NOTHING`: lo que choca se salta,
    /// y el `RETURNING` no lo da.
    puede_saltarse: bool,
    /// Empieza por `WITH`.
    con_with: bool,
    /// Ya lleva su `RETURNING`.
    con_returning: bool,
    /// Dónde acaba su última pieza: lo que sigue (un `;`, un comentario) no cuenta.
    fin: usize,
    /// Las columnas de un `INSERT`, si las dice.
    columnas: Option<Vec<String>>,
    /// Lo que inserta (su `VALUES` o su `SELECT`), en bytes del texto.
    origen: Option<(usize, usize)>,
    donde: Donde,
    /// Las igualdades de su `WHERE` que se pueden usar solas: `columna = valor`.
    igualdades: Vec<(String, String)>,
}

impl Forma {
    /// Lee una sentencia que escribe filas. `None` si no lo es, o no se sabe leer.
    fn leer(sql: &str) -> Option<Forma> {
        let t = Troceada::de(sql)?;
        let mut n = t.piezas.len();
        while n > 0 && t.signo(n - 1, ";") {
            n -= 1;
        }
        if n == 0 || (0..n).any(|i| t.signo(i, ";")) {
            return None;
        }
        let fin = t.piezas[n - 1].fin;

        let con_with = t.es(0, "WITH");
        let mut i = if con_with {
            t.buscar(1, n, |j| ["INSERT", "REPLACE", "UPDATE", "DELETE"].iter().any(|p| t.es(j, p)))?
        } else {
            0
        };
        let mut reemplaza = false;
        let mut puede_saltarse = false;
        let tipo = if t.es(i, "INSERT") || t.es(i, "REPLACE") {
            reemplaza = t.es(i, "REPLACE");
            i += 1;
            if t.es(i, "OR") {
                reemplaza |= t.es(i + 1, "REPLACE");
                puede_saltarse |= t.es(i + 1, "IGNORE");
                i += 2;
            }
            if !t.es(i, "INTO") {
                return None;
            }
            i += 1;
            Tipo::Insertar
        } else if t.es(i, "UPDATE") {
            i += 1;
            if t.es(i, "OR") {
                reemplaza |= t.es(i + 1, "REPLACE");
                puede_saltarse |= t.es(i + 1, "IGNORE");
                i += 2;
            }
            Tipo::Actualizar
        } else if t.es(i, "DELETE") && t.es(i + 1, "FROM") {
            i += 2;
            Tipo::Borrar
        } else {
            return None;
        };

        let tabla = t.nombre(i)?;
        i += 1;
        if t.signo(i, ".") {
            // Con el nombre de la base delante: no es nuestro.
            return None;
        }
        let mut alias = None;
        if t.es(i, "AS") {
            alias = Some(t.nombre(i + 1)?);
            i += 2;
        }
        let con_returning = t.buscar(i, n, |j| t.es(j, "RETURNING")).is_some();

        let mut forma = Forma {
            tipo,
            tabla,
            alias,
            reemplaza,
            puede_saltarse,
            con_with,
            con_returning,
            fin,
            columnas: None,
            origen: None,
            donde: Donde::NoSe,
            igualdades: Vec::new(),
        };

        match tipo {
            Tipo::Insertar => {
                if t.signo(i, "(") {
                    let cierre = t.cierre(i)?;
                    let mut columnas = Vec::new();
                    let mut j = i + 1;
                    while j < cierre {
                        let nombre = t.nombre(j)?;
                        columnas.push(nombre);
                        j += 1;
                        if j < cierre && !t.signo(j, ",") {
                            return None;
                        }
                        j += 1;
                    }
                    forma.columnas = Some(columnas);
                    i = cierre + 1;
                }
                if i < n && !t.es(i, "DEFAULT") {
                    let corte = t
                        .buscar(i, n, |j| (t.es(j, "ON") && t.es(j + 1, "CONFLICT")) || t.es(j, "RETURNING"))
                        .unwrap_or(n);
                    if corte > i {
                        forma.origen = Some((t.piezas[i].ini, t.piezas[corte - 1].fin));
                    }
                    // Un `ON CONFLICT … DO NOTHING`, en cualquiera de sus cláusulas.
                    forma.puede_saltarse |= t.buscar(corte, n, |j| t.es(j, "DO") && t.es(j + 1, "NOTHING")).is_some();
                }
            }
            Tipo::Actualizar | Tipo::Borrar => {
                let desde = if tipo == Tipo::Actualizar { t.buscar(i, n, |j| t.es(j, "SET"))? } else { i };
                let raro = t.es(i, "INDEXED") || t.es(i, "NOT")
                    || (tipo == Tipo::Actualizar && t.buscar(desde, n, |j| t.es(j, "FROM")).is_some());
                let donde = t.buscar(desde, n, |j| t.es(j, "WHERE"));
                let corte = t.buscar(donde.unwrap_or(desde), n, |j| t.es(j, "RETURNING") || t.es(j, "ORDER") || t.es(j, "LIMIT")).unwrap_or(n);
                forma.donde = match donde {
                    _ if raro => Donde::NoSe,
                    None => Donde::Toda,
                    Some(w) if w + 1 < corte => Donde::Piezas(w + 1, corte),
                    Some(_) => return None,
                };
                if let Donde::Piezas(a, b) = forma.donde {
                    forma.igualdades = igualdades(&t, a, b, &forma.tabla, forma.alias.as_deref());
                }
            }
        }
        Some(forma)
    }

    /// El texto de la sentencia hasta su última pieza.
    fn cuerpo<'s>(&self, sql: &'s str) -> &'s str {
        &sql[..self.fin]
    }

    /// La lectura que dice, antes de ejecutarla, qué filas tocaría: las claves de lo que inserta, o
    /// las de las filas que cumplen su `WHERE`. De éste valen solas sus igualdades sobre la clave o
    /// una foránea (`ID_Lote = ?1`): las demás condiciones (`Stock = ?2`) hablan de cómo estaba la
    /// fila en la nube, que aquí puede ser otro. Sin ninguna, el `WHERE` entero. `None` si no hay.
    fn previa(&self, sql: &str, esquema: &Esquema) -> Option<String> {
        let (columnas_de_la_tabla, clave) = (&esquema.columnas, &esquema.clave);
        let lista = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
        match self.tipo {
            Tipo::Insertar => {
                // Lo que inserta, leído como una tabla. Con un `WITH` delante, su origen puede usar
                // lo que define, y no se lee aparte.
                if self.con_with {
                    return None;
                }
                let (a, b) = self.origen?;
                let columnas = self.columnas.clone().unwrap_or_else(|| columnas_de_la_tabla.to_vec());
                if clave.iter().any(|k| !columnas.iter().any(|c| c.eq_ignore_ascii_case(k))) {
                    // La clave no viene en lo que inserta: la pone SQLite.
                    return None;
                }
                let nombres = columnas.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
                Some(format!("WITH \"_tocadas\"({nombres}) AS ({}) SELECT {lista} FROM \"_tocadas\";", &sql[a..b]))
            }
            Tipo::Actualizar | Tipo::Borrar => {
                let tabla = match &self.alias {
                    Some(a) => format!("{} AS {}", cita(&self.tabla), cita(a)),
                    None => cita(&self.tabla),
                };
                let condicion = match &self.donde {
                    Donde::NoSe => return None,
                    Donde::Toda => None,
                    Donde::Piezas(..) if !self.igualdades.is_empty() => {
                        let usables: Vec<String> = self
                            .igualdades
                            .iter()
                            .filter(|(c, _)| esquema.identifica(c))
                            .map(|(c, v)| format!("{} = {v}", cita(c)))
                            .collect();
                        if usables.is_empty() {
                            Some(self.donde_entero(sql)?)
                        } else {
                            Some(usables.join(" AND "))
                        }
                    }
                    Donde::Piezas(..) => Some(self.donde_entero(sql)?),
                };
                let Some(condicion) = condicion else {
                    return Some(format!("SELECT {lista} FROM {tabla};"));
                };
                Some(format!("SELECT {lista} FROM {tabla} WHERE {condicion};"))
            }
        }
    }

    fn donde_entero(&self, sql: &str) -> Option<String> {
        let t = Troceada::de(sql)?;
        let Donde::Piezas(a, b) = self.donde else { return None };
        Some(sql[t.piezas[a].ini..t.piezas[b - 1].fin].to_owned())
    }
}

/// Las igualdades `columna = valor` de una condición que es una conjunción: cada una, por su cuenta,
/// es una condición necesaria, y todas juntas dan un conjunto que contiene al de la condición
/// entera. Con un `OR`, un `BETWEEN` o un `CASE` en lo alto no se parte: no sería una conjunción
/// (o su `AND` no sería el de partir).
fn igualdades(t: &Troceada<'_>, a: usize, b: usize, tabla: &str, alias: Option<&str>) -> Vec<(String, String)> {
    if t.buscar(a, b, |j| t.es(j, "OR") || t.es(j, "BETWEEN") || t.es(j, "CASE")).is_some() {
        return Vec::new();
    }
    let mut salida = Vec::new();
    let mut ini = a;
    for j in a..=b {
        if j < b && !(t.nivel[j] == 0 && t.es(j, "AND")) {
            continue;
        }
        if let Some(par) = igualdad(t, ini, j, tabla, alias) {
            salida.push(par);
        }
        ini = j + 1;
    }
    salida
}

/// `columna = valor` (o al revés), con la columna de esta tabla y el valor un parámetro numerado o
/// un literal.
fn igualdad(t: &Troceada<'_>, a: usize, b: usize, tabla: &str, alias: Option<&str>) -> Option<(String, String)> {
    let columna = |i: usize, j: usize| -> Option<String> {
        match j - i {
            1 => t.nombre(i),
            3 if t.signo(i + 1, ".") => {
                let q = t.nombre(i)?;
                (q.eq_ignore_ascii_case(tabla) || alias.is_some_and(|x| x.eq_ignore_ascii_case(&q))).then(|| t.nombre(i + 2))?
            }
            _ => None,
        }
    };
    let valor = |i: usize, j: usize| -> Option<String> {
        if j <= i {
            return None;
        }
        let unico = j - i == 1;
        let negativo = j - i == 2 && t.signo(i, "-") && t.piezas[i + 1].clase == Clase::Numero;
        let p = t.piezas[j - 1];
        let vale = match p.clase {
            Clase::Parametro => unico && t.texto(j - 1)[1..].parse::<usize>().is_ok(),
            Clase::Texto => unico,
            Clase::Numero => unico || negativo,
            _ => false,
        };
        vale.then(|| t.sql[t.piezas[i].ini..p.fin].to_owned())
    };
    let igual = t.buscar(a, b, |j| t.signo(j, "=") || t.signo(j, "=="))?;
    if let (Some(c), Some(v)) = (columna(a, igual), valor(igual + 1, b)) {
        return Some((c, v));
    }
    if let (Some(v), Some(c)) = (valor(a, igual), columna(igual + 1, b)) {
        return Some((c, v));
    }
    None
}

/* ===== Lo que se sabe sin ejecutar ===== */

/// El valor de un parámetro numerado o un literal, sin ejecutar nada.
fn valor_estatico(texto: &str, args: &[Json]) -> Option<Json> {
    if let Some(n) = texto.strip_prefix('?') {
        return args.get(n.parse::<usize>().ok()?.checked_sub(1)?).cloned().filter(|v| v.is_string() || v.is_number());
    }
    if texto.starts_with('\'') && texto.ends_with('\'') && texto.len() >= 2 {
        return Some(Json::String(texto[1..texto.len() - 1].replace("''", "'")));
    }
    if let Ok(n) = texto.parse::<i64>() {
        return Some(json!(n));
    }
    texto.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Json::Number)
}

fn claves_estaticas(sql: &str, args: &[Json], forma: &Forma, clave: &[String]) -> Option<Vec<Vec<Json>>> {
    match forma.tipo {
        Tipo::Insertar => {
            let columnas = forma.columnas.as_ref()?;
            let (a, b) = forma.origen?;
            let t = Troceada::de(&sql[a..b])?;
            if !t.es(0, "VALUES") {
                return None;
            }
            let posiciones: Vec<usize> = clave
                .iter()
                .map(|k| columnas.iter().position(|c| c.eq_ignore_ascii_case(k)))
                .collect::<Option<_>>()?;
            let mut filas = Vec::new();
            let mut i = 1;
            while i < t.piezas.len() {
                if !t.signo(i, "(") {
                    return None;
                }
                let cierre = t.cierre(i)?;
                // Los valores de la tupla, partidos por sus comas de primer nivel.
                let mut valores: Vec<(usize, usize)> = Vec::new();
                let mut ini = i + 1;
                for j in i + 1..=cierre {
                    if j == cierre || (t.nivel[j] == 1 && t.signo(j, ",")) {
                        if j == ini {
                            return None;
                        }
                        valores.push((t.piezas[ini].ini, t.piezas[j - 1].fin));
                        ini = j + 1;
                    }
                }
                if valores.len() != columnas.len() {
                    return None;
                }
                let tupla = &sql[a..b];
                filas.push(
                    posiciones.iter().map(|p| valor_estatico(tupla[valores[*p].0..valores[*p].1].trim(), args)).collect::<Option<Vec<_>>>()?,
                );
                i = cierre + 1;
                if t.signo(i, ",") {
                    i += 1;
                }
            }
            Some(filas)
        }
        Tipo::Actualizar | Tipo::Borrar => {
            let k = clave
                .iter()
                .map(|c| forma.igualdades.iter().find(|(col, _)| col.eq_ignore_ascii_case(c)).and_then(|(_, v)| valor_estatico(v, args)))
                .collect::<Option<Vec<_>>>()?;
            Some(vec![k])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::sync::Arc;

    async fn base(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(&format!("filas-tocadas-{nombre}"));
        Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap()
    }

    async fn sembrar(db: &Db, sql: &str) {
        let w = db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    async fn numero(db: &Db, sql: &str) -> i64 {
        let r = db.read().await;
        let mut f = r.conn().query(sql, ()).await.unwrap();
        f.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
    }

    fn st(sql: &str, args: Vec<Json>) -> SqlStatement {
        SqlStatement { sql: sql.into(), args }
    }

    async fn tocadas(db: &Db, sentencias: &[SqlStatement]) -> Tocadas {
        let w = db.write().await;
        de_un_cambio(w.raw(), sentencias).await
    }

    fn fila(tabla: &str, clave: &[&str], borrada: bool) -> FilaTocada {
        FilaTocada { tabla: tabla.into(), clave: clave.iter().map(|c| json!(c)).collect(), borrada }
    }

    const NEGOCIO: &str = "
        INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza'), ('z2', 'Salón');
        INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
             VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80), ('m2', 'z1', '2', 2, 0, 0, 'rect', 80, 80), ('m3', 'z2', '7', 6, 0, 0, 'rect', 80, 80);
        INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa) VALUES ('pr1', 'Bebidas SL');
        INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Cervezas');
        INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta, ID_Proveedor)
             VALUES ('p1', 'cat-1', 'Caña', 250, 'pr1'), ('p2', 'cat-1', 'Tercio', 320, 'pr1'), ('p3', 'cat-1', 'Agua', 150, NULL);
    ";

    #[tokio::test]
    async fn un_insert_con_varias_filas_y_un_update_por_su_clave() {
        let db = base("insert-update").await;
        sembrar(&db, NEGOCIO).await;
        let t = tocadas(
            &db,
            &[
                st(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2), (?3, 'Patio, el de atrás');",
                    vec![json!("z8"), json!("Barra"), json!("z9")],
                ),
                // El stock que se vio no es el de aquí: no actualiza nada, y aun así es su fila.
                st("UPDATE Mesas SET Capacidad = ?2 WHERE ID_Mesa = ?1 AND Capacidad = 99;", vec![json!("m2"), json!(8)]),
            ],
        )
        .await;
        assert!(!t.incierto, "{t:?}");
        assert_eq!(t.tablas, vec!["Mesas", "Zonas"]);
        assert_eq!(t.filas, vec![fila("Zonas", &["z8"], false), fila("Zonas", &["z9"], false), fila("Mesas", &["m2"], false)]);
        // Un simulacro: no ha quedado nada.
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas;").await, 2);
        assert_eq!(numero(&db, "SELECT Capacidad FROM Mesas WHERE ID_Mesa = 'm2';").await, 2);
    }

    #[tokio::test]
    async fn por_una_foranea_son_las_filas_de_aqui_que_la_cumplen_y_las_que_se_borran_se_marcan() {
        let db = base("foranea").await;
        sembrar(&db, NEGOCIO).await;
        let t = tocadas(
            &db,
            &[
                st("UPDATE Productos SET ID_Proveedor = NULL WHERE ID_Proveedor = ?1;", vec![json!("pr1")]),
                st("DELETE FROM Mesas WHERE ID_Zona = ?1;", vec![json!("z1")]),
                st("DELETE FROM Proveedores WHERE ID_Proveedor = ?1;", vec![json!("pr1")]),
            ],
        )
        .await;
        assert!(!t.incierto, "{t:?}");
        assert_eq!(
            t.filas,
            vec![
                fila("Productos", &["p1"], false),
                fila("Productos", &["p2"], false),
                fila("Mesas", &["m1"], true),
                fila("Mesas", &["m2"], true),
                fila("Proveedores", &["pr1"], true),
            ]
        );
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 3);
    }

    #[tokio::test]
    async fn la_sentencia_que_choca_y_la_hija_sin_padre_tambien_se_saben() {
        let db = base("choca").await;
        sembrar(&db, NEGOCIO).await;
        let t = tocadas(
            &db,
            &[
                // Choca con el nombre de una zona activa: no entra, pero sus claves se saben.
                st("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);", vec![json!("z7"), json!("Terraza")]),
                // Su mesa apunta a una zona que aquí no está: la foránea se mira al final.
                st("INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES (?1, ?2, ?3, 4, 0, 0, 'rect', 80, 80);", vec![json!("m7"), json!("z7"), json!("70")]),
                // Y lo que va detrás también.
                st("UPDATE Mesas SET Capacidad = 9 WHERE ID_Mesa = ?1;", vec![json!("m3")]),
            ],
        )
        .await;
        assert!(!t.incierto, "{t:?}");
        assert_eq!(t.filas, vec![fila("Zonas", &["z7"], false), fila("Mesas", &["m7"], false), fila("Mesas", &["m3"], false)]);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 3);
    }

    #[tokio::test]
    async fn lo_que_se_salta_al_chocar_se_sabe_por_lo_que_iba_a_insertar() {
        let db = base("salta").await;
        sembrar(&db, NEGOCIO).await;
        sembrar(&db, "INSERT INTO Alergenos (ID_Alergeno, Nombre) VALUES ('a1', 'Alérgeno de prueba'); INSERT INTO Producto_Alergenos (ID_Producto, ID_Alergeno) VALUES ('p1', 'a1');").await;
        let t = tocadas(
            &db,
            &[
                st("INSERT OR IGNORE INTO Producto_Alergenos (ID_Producto, ID_Alergeno) VALUES (?1, ?2);", vec![json!("p1"), json!("a1")]),
                st(
                    "INSERT INTO Producto_Alergenos (ID_Producto, ID_Alergeno) SELECT ?1, ID_Alergeno FROM Alergenos WHERE ID_Alergeno = 'a1' ON CONFLICT DO NOTHING;",
                    vec![json!("p2")],
                ),
            ],
        )
        .await;
        assert!(!t.incierto, "{t:?}");
        assert_eq!(t.filas, vec![fila("Producto_Alergenos", &["p1", "a1"], false), fila("Producto_Alergenos", &["p2", "a1"], false)]);
    }

    #[tokio::test]
    async fn lo_que_no_se_sabe_es_incierto() {
        let db = base("incierto").await;
        sembrar(&db, NEGOCIO).await;
        for (sql, por) in [
            ("INSERT OR REPLACE INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z5', 'x');", "un REPLACE borra lo que choca"),
            ("REPLACE INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z5', 'x');", "ídem"),
            ("INSERT INTO Tabla_Que_No_Hay (ID) VALUES ('x');", "una tabla que aquí no está"),
            ("SAVEPOINT x;", "no escribe filas"),
            ("UPDATE Zonas SET Nombre_Zona = 'x' WHERE ID_Zona = 'z1'; UPDATE Zonas SET Nombre_Zona = 'y';", "dos sentencias"),
        ] {
            let t = tocadas(&db, &[st(sql, vec![])]).await;
            assert!(t.incierto, "{por}: {t:?}");
        }
        // Un PRAGMA no toca filas.
        let t = tocadas(&db, &[st("PRAGMA defer_foreign_keys = ON;", vec![])]).await;
        assert!(!t.incierto && t.filas.is_empty(), "{t:?}");
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas;").await, 2);
    }

    #[tokio::test]
    async fn un_commit_entre_las_sentencias_no_confirma_nada() {
        // Lo peor que puede traer un cambio: un `COMMIT` en medio. El simulacro no lo ejecuta, y si
        // algo cerrara su transacción, no ejecutaría nada más.
        let db = base("commit").await;
        sembrar(&db, NEGOCIO).await;
        let t = tocadas(
            &db,
            &[
                st("DELETE FROM Mesas WHERE ID_Mesa = 'm1';", vec![]),
                st("COMMIT;", vec![]),
                st("DELETE FROM Mesas WHERE ID_Mesa = 'm2';", vec![]),
            ],
        )
        .await;
        assert!(t.incierto, "{t:?}");
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 3, "nada se ha borrado de verdad");
        // Y la conexión queda como estaba, sin transacción.
        sembrar(&db, "DELETE FROM Mesas WHERE ID_Mesa = 'm3';").await;
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 2);
    }

    #[tokio::test]
    async fn el_simulacro_no_ejecuta_nada_sin_su_transaccion() {
        // El simulacro rechaza lo que no lee ni escribe filas, y si un error deshace su transacción
        // entera (un `RAISE(ROLLBACK)`), lo que viniera detrás ya no se ejecuta: se confirmaría.
        let db = base("simulacro").await;
        sembrar(&db, NEGOCIO).await;
        sembrar(
            &db,
            "CREATE TRIGGER deshace BEFORE INSERT ON Zonas WHEN NEW.Nombre_Zona = 'deshace'
               BEGIN SELECT RAISE(ROLLBACK, 'deshace'); END;",
        )
        .await;
        let resultado = {
            let w = db.write().await;
            w.raw()
                .simulacro(|s| {
                    let borra = s.filas("DELETE FROM Mesas WHERE ID_Mesa = 'm1';", &[], 10).is_ok();
                    let commit = s.filas("COMMIT;", &[], 10).is_err();
                    let deshace = s.filas("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zx', 'deshace');", &[], 10).is_err();
                    let detras = s.filas("DELETE FROM Mesas WHERE ID_Mesa = 'm2';", &[], 10).is_err();
                    (borra, commit, deshace, detras)
                })
                .await
                .unwrap()
        };
        assert_eq!(resultado, (true, true, true, true));
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 3, "nada se ha borrado de verdad");
        sembrar(&db, "DELETE FROM Mesas WHERE ID_Mesa = 'm3';").await;
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 2, "la conexión sigue sirviendo");
    }

    #[tokio::test]
    async fn con_with_delante_y_sin_where() {
        let db = base("with").await;
        sembrar(&db, NEGOCIO).await;
        let t = tocadas(
            &db,
            &[
                st("WITH nuevas(id) AS (VALUES ('z5'), ('z6')) INSERT INTO Zonas (ID_Zona, Nombre_Zona) SELECT id, 'Zona ' || id FROM nuevas;", vec![]),
                st("UPDATE Mesas SET Capacidad = Capacidad + 1;", vec![]),
            ],
        )
        .await;
        assert!(!t.incierto, "{t:?}");
        let mut claves: Vec<String> = t.filas.iter().map(|f| format!("{}:{}", f.tabla, f.clave[0])).collect();
        claves.sort();
        assert_eq!(claves, vec!["Mesas:\"m1\"", "Mesas:\"m2\"", "Mesas:\"m3\"", "Zonas:\"z5\"", "Zonas:\"z6\""]);
    }

    #[tokio::test]
    async fn una_tabla_que_no_es_de_negocio_no_cuenta() {
        let db = base("local").await;
        let t = tocadas(&db, &[st("INSERT INTO _Estad_Dias_Sucios (Dia) VALUES ('2026-11-14') ON CONFLICT DO NOTHING;", vec![])]).await;
        assert!(!t.incierto, "{t:?}");
        assert!(t.filas.is_empty() && t.tablas.is_empty(), "{t:?}");
    }

    #[tokio::test]
    async fn mas_filas_de_las_que_caben_es_incierto() {
        let db = base("tope").await;
        sembrar(&db, NEGOCIO).await;
        sembrar(
            &db,
            &format!(
                "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i <= {MAX_FILAS_TOCADAS})
                 INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                 SELECT 'mx' || i, 'z2', 'x' || i, 2, 0, 0, 'rect', 80, 80 FROM s;"
            ),
        )
        .await;
        let t = tocadas(&db, &[st("DELETE FROM Mesas WHERE ID_Zona = 'z2';", vec![])]).await;
        assert!(t.incierto, "{} filas", t.filas.len());
    }

    #[test]
    fn se_guarda_y_se_lee_igual() {
        let t = Tocadas {
            tablas: vec!["Mesas".into(), "Pago_Detalles".into()],
            filas: vec![fila("Mesas", &["m1"], true), FilaTocada { tabla: "Pago_Detalles".into(), clave: vec![json!("p1"), json!(3)], borrada: false }],
            incierto: false,
        };
        assert_eq!(Tocadas::de_json(&t.a_json()), t);
        assert!(Tocadas::de_json("no es json").incierto);
        assert!(Tocadas::de_json(r#"{"tablas":[],"filas":[{"tabla":"Mesas"}],"incierto":false}"#).incierto);
        assert!(Tocadas::de_json(r#"{"tablas":[],"filas":[]}"#).incierto, "sin decirlo, no se sabe");
    }

    #[test]
    fn se_lee_lo_que_hay_que_leer_de_una_sentencia() {
        let f = Forma::leer("  -- comentario\n UPDATE \"Mesas\" AS m SET Capacidad = (SELECT 1 FROM x WHERE a = 1) WHERE m.ID_Mesa = ?3 AND Capacidad > 2 AND 'z' = ID_Zona RETURNING 1; -- fin").unwrap();
        assert_eq!((f.tipo, f.tabla.as_str(), f.alias.as_deref(), f.con_returning), (Tipo::Actualizar, "Mesas", Some("m"), true));
        assert_eq!(f.igualdades, vec![("ID_Mesa".to_string(), "?3".to_string()), ("ID_Zona".to_string(), "'z'".to_string())]);

        // Un `OR` o un `BETWEEN` en lo alto: no se parte.
        assert!(Forma::leer("DELETE FROM Mesas WHERE ID_Mesa = ?1 OR ID_Zona = ?2").unwrap().igualdades.is_empty());
        assert!(Forma::leer("DELETE FROM Mesas WHERE Capacidad BETWEEN 1 AND 2 AND ID_Mesa = ?1").unwrap().igualdades.is_empty());
        // Un `;` dentro de un texto no es el final.
        let f = Forma::leer("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('a;b', 'c''d');").unwrap();
        assert_eq!(f.columnas, Some(vec!["ID_Zona".to_string(), "Nombre_Zona".to_string()]));
        // `UPDATE … FROM`: no se mira antes.
        assert!(matches!(Forma::leer("UPDATE Mesas SET Capacidad = x.c FROM x WHERE x.id = Mesas.ID_Mesa").unwrap().donde, Donde::NoSe));
        // Lo que no escribe filas no es una forma.
        assert!(Forma::leer("SELECT 1").is_none());
        assert!(Forma::leer("UPDATE 'x").is_none(), "un texto sin cerrar");
    }
}
