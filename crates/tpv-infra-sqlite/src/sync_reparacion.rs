//! Volver a igualar una fila que la nube no tiene igual que nosotros (SYNC-22).
//!
//! # Por qué se repara por ESTADO y no reintentando la operación
//!
//! El outbox replica **sentencias**, y una sentencia rechazada no se puede reintentar más tarde sin
//! hacer daño: para cuando alguien arregla la causa, esa fila ya ha cambiado otras veces, así que
//! reaplicar aquel `UPDATE` viejo por encima del nuevo no repara el dato — lo devuelve a un valor
//! que ya no es cierto.
//!
//! Lo que sí se puede afirmar en cualquier momento es **cómo está la fila AHORA** en la Main, que es
//! el escritor único y por tanto la autoridad. Una reparación es eso: leer la fila tal como está y
//! mandar un `INSERT OR REPLACE` con su contenido actual. No depende del orden, se puede repetir sin
//! consecuencias y converge — da igual cuántas operaciones se perdieran por el camino.
//!
//! # Y por qué no hace falta transporte nuevo
//!
//! Una reparación **es una escritura más**. Se encola en `_Sync_Outbox` como cualquier otra y sube
//! por el camino de siempre, con sus acks, su idempotencia por `Op_Id` y su cuarentena si vuelve a
//! fallar. Va al final de la cola, que es justo donde tiene que ir: lleva el estado más reciente, así
//! que aplicarla la última es lo correcto.
//!
//! ⚠️ **Una reparación no se repara.** Las operaciones de reparación llevan su propio
//! `Command_Name`; si una acaba apartada, no se genera otra. Sin eso, una fila que la nube se niega
//! a aceptar produciría una reparación nueva por cada intento, para siempre.

use libsql::{Connection, Error as LibsqlError, Value};
use serde_json::json;

use tpv_contracts::sync::SqlStatement;

/// `Command_Name` de una operación de reparación. Existe para poder distinguirlas: son el punto de
/// parada del bucle (ver el aviso del encabezado) y lo que permite contarlas aparte.
pub const COMANDO_REPARACION: &str = "main_reparacion";

/// La fila que hay que volver a igualar: su tabla y el valor de su clave primaria.
///
/// La clave va como lista porque ocho tablas del esquema tienen clave **compuesta**
/// (`Pago_Detalles`, `Lote_Consumos`, `Producto_Alergenos`…), y tratarlas como si tuvieran una sola
/// columna repararía la fila equivocada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilaAfectada {
    pub tabla: String,
    /// `(columna, valor)` de cada componente de la clave primaria.
    pub clave: Vec<(String, String)>,
}

/// Qué se ha podido deducir de las sentencias de una operación.
///
/// `incierto` NO es un fallo: es el reconocimiento de que este análisis es un heurístico sobre SQL
/// que nosotros mismos generamos, y de que hay formas que no sabe leer. Sigue el mismo criterio que
/// `syncStatements.ts` en el frontend — deducir lo que se pueda y **decir** cuando no se puede— y
/// aquí importa más todavía: una fila que no se identifica no se repara, así que callárselo sería
/// dejar un descuadre creyendo que se ha arreglado.
#[derive(Debug, Clone, Default)]
pub struct Analisis {
    pub filas: Vec<FilaAfectada>,
    /// Alguna sentencia tocó datos que no se han sabido localizar.
    pub incierto: bool,
    /// Alguna sentencia era un `DELETE`. No se puede reparar por estado: la ausencia de una fila no
    /// es una fila que mandar. Se marca para poder informarlo (ver SYNC-23 en HALLAZGOS.md).
    pub borrados: Vec<String>,
}

/// Nombre de tabla aceptable. Se interpolan en el SQL (no se pueden enlazar con `?`), así que se
/// filtran igual que en el bootstrap: sólo lo que puede ser un identificador nuestro.
fn nombre_aceptable(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !n.starts_with('_')
}

/// Índice de un placeholder `?N` (1-based) → posición en `args` (0-based).
fn indice_placeholder(token: &str) -> Option<usize> {
    let n: usize = token.trim().strip_prefix('?')?.parse().ok()?;
    n.checked_sub(1)
}

/// Renderiza un argumento a la forma textual con la que se comparará y se volverá a escribir.
fn arg_a_texto(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(if *b { "1".into() } else { "0".into() }),
        _ => None,
    }
}

/// Quita comillas y espacios de un literal SQL (`'abc'` → `abc`).
fn literal(s: &str) -> String {
    s.trim().trim_matches('\'').trim_matches('"').to_string()
}

/// Analiza las sentencias de una operación para saber qué filas tocó.
///
/// Sólo entiende las tres formas que generan nuestros repositorios; cualquier otra marca
/// `incierto`. Es deliberado: reconocer de menos deja un descuadre **informado**, mientras que
/// reconocer de más repararía la fila equivocada.
pub fn analizar(stmts: &[SqlStatement], pks: &dyn Fn(&str) -> Vec<String>) -> Analisis {
    let mut out = Analisis::default();

    for st in stmts {
        let sql = st.sql.trim();
        let alto = sql.to_ascii_uppercase();

        // ── DELETE ────────────────────────────────────────────────────────────────────────────
        if alto.starts_with("DELETE") {
            if let Some(t) = tabla_tras(sql, "FROM") {
                out.borrados.push(t);
            } else {
                out.incierto = true;
            }
            continue;
        }

        // ── INSERT [OR ...] INTO T (cols) VALUES (...) ────────────────────────────────────────
        if alto.starts_with("INSERT") || alto.starts_with("REPLACE") {
            match analizar_insert(sql, st, pks) {
                Some(f) => out.filas.push(f),
                None => out.incierto = true,
            }
            continue;
        }

        // ── UPDATE T SET ... WHERE pk = ?n ────────────────────────────────────────────────────
        if alto.starts_with("UPDATE") {
            match analizar_update(sql, st, pks) {
                Some(f) => out.filas.push(f),
                None => out.incierto = true,
            }
            continue;
        }

        out.incierto = true;
    }

    out
}

/// `INSERT INTO <tabla>` / `DELETE FROM <tabla>`: el identificador que sigue a la palabra clave.
///
/// Acepta el nombre **entrecomillado** (`INTO "Zonas"`), que no es un caso exótico: es justo lo que
/// genera `sentencia_de_reparacion`. Sin esto, las sentencias de una reparación no se sabían leer y
/// el corte anti-bucle parecía funcionar cuando en realidad lo que fallaba era el análisis.
fn tabla_tras(sql: &str, clave: &str) -> Option<String> {
    let alto = sql.to_ascii_uppercase();
    let pos = alto.find(clave)? + clave.len();
    let resto = sql[pos..].trim_start().trim_start_matches(['"', '`', '[']);
    let nombre: String = resto
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    nombre_aceptable(&nombre).then_some(nombre)
}

fn analizar_insert(
    sql: &str,
    st: &SqlStatement,
    pks: &dyn Fn(&str) -> Vec<String>,
) -> Option<FilaAfectada> {
    let tabla = tabla_tras(sql, "INTO")?;
    let claves = pks(&tabla);
    if claves.is_empty() {
        return None;
    }

    // Lista de columnas entre el primer par de paréntesis.
    let abre = sql.find('(')?;
    let cierra = sql[abre..].find(')')? + abre;
    let columnas: Vec<String> = sql[abre + 1..cierra]
        .split(',')
        .map(|c| c.trim().trim_matches('"').to_string())
        .collect();

    // Valores del primer `VALUES (...)`.
    let alto = sql.to_ascii_uppercase();
    let vpos = alto.find("VALUES")?;
    let vabre = sql[vpos..].find('(')? + vpos;
    let vcierra = sql[vabre..].find(')')? + vabre;
    let valores: Vec<String> = sql[vabre + 1..vcierra]
        .split(',')
        .map(|v| v.trim().to_string())
        .collect();

    if columnas.len() != valores.len() {
        return None;
    }

    let mut clave = Vec::new();
    for col_pk in &claves {
        let i = columnas.iter().position(|c| c.eq_ignore_ascii_case(col_pk))?;
        let bruto = &valores[i];
        let valor = if bruto.starts_with('?') {
            let idx = indice_placeholder(bruto)?;
            arg_a_texto(st.args.get(idx)?)?
        } else {
            literal(bruto)
        };
        clave.push((col_pk.clone(), valor));
    }

    Some(FilaAfectada { tabla, clave })
}

fn analizar_update(
    sql: &str,
    st: &SqlStatement,
    pks: &dyn Fn(&str) -> Vec<String>,
) -> Option<FilaAfectada> {
    let tabla = tabla_tras(sql, "UPDATE")?;
    let claves = pks(&tabla);
    if claves.is_empty() {
        return None;
    }

    // Sólo se mira a partir del WHERE: una columna de clave puede aparecer también en el SET.
    let alto = sql.to_ascii_uppercase();
    let wpos = alto.find(" WHERE ")?;
    let donde = &sql[wpos + 7..];

    let mut clave = Vec::new();
    for col_pk in &claves {
        let valor = valor_en_igualdad(donde, col_pk, st)?;
        clave.push((col_pk.clone(), valor));
    }

    Some(FilaAfectada { tabla, clave })
}

/// Busca `<col> = <valor>` dentro de una cláusula y devuelve el valor ya resuelto.
fn valor_en_igualdad(donde: &str, col: &str, st: &SqlStatement) -> Option<String> {
    let alto = donde.to_ascii_uppercase();
    let objetivo = col.to_ascii_uppercase();
    let mut desde = 0usize;

    while let Some(rel) = alto[desde..].find(&objetivo) {
        let ini = desde + rel;
        let fin = ini + objetivo.len();

        // Que sea la columna entera y no el final de otra (`ID_Pago` dentro de `Sub_ID_Pago`).
        let antes_ok = ini == 0
            || !donde.as_bytes()[ini - 1].is_ascii_alphanumeric() && donde.as_bytes()[ini - 1] != b'_';
        let resto = donde.get(fin..)?;
        let tras = resto.trim_start();

        if antes_ok && tras.starts_with('=') {
            let bruto: String = tras[1..]
                .trim_start()
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != ')' && *c != ';' && *c != ',')
                .collect();
            return if bruto.starts_with('?') {
                let idx = indice_placeholder(&bruto)?;
                arg_a_texto(st.args.get(idx)?)
            } else {
                Some(literal(&bruto))
            };
        }
        desde = fin;
    }
    None
}

/// Columnas de la clave primaria de una tabla, en su orden declarado.
pub async fn claves_primarias(conn: &Connection, tabla: &str) -> Result<Vec<String>, LibsqlError> {
    if !nombre_aceptable(tabla) {
        return Ok(Vec::new());
    }
    let mut rows = conn
        .query(&format!("PRAGMA table_info(\"{tabla}\");"), ())
        .await?;
    // `pk` (columna 5) es 0 si no forma parte de la clave, y 1..n el orden dentro de una compuesta.
    let mut con_orden: Vec<(i64, String)> = Vec::new();
    while let Some(r) = rows.next().await? {
        let nombre = match r.get_value(1)? {
            Value::Text(s) => s,
            _ => continue,
        };
        let pk = match r.get_value(5)? {
            Value::Integer(n) => n,
            _ => 0,
        };
        if pk > 0 {
            con_orden.push((pk, nombre));
        }
    }
    con_orden.sort_by_key(|(o, _)| *o);
    Ok(con_orden.into_iter().map(|(_, n)| n).collect())
}

/// Construye la sentencia que vuelve a igualar una fila: su contenido ACTUAL en la Main.
///
/// Devuelve `Ok(None)` si la fila ya no existe en local. Ese caso **no es un error y no se repara**:
/// significa que se borró, y un borrado no se puede expresar como estado (ver `Analisis::borrados`).
pub async fn sentencia_de_reparacion(
    conn: &Connection,
    fila: &FilaAfectada,
) -> Result<Option<SqlStatement>, LibsqlError> {
    if !nombre_aceptable(&fila.tabla) || fila.clave.is_empty() {
        return Ok(None);
    }
    for (c, _) in &fila.clave {
        if !nombre_aceptable(c) {
            return Ok(None);
        }
    }

    let donde = fila
        .clave
        .iter()
        .enumerate()
        .map(|(i, (c, _))| format!("\"{c}\" = ?{}", i + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let args: Vec<Value> = fila
        .clave
        .iter()
        .map(|(_, v)| Value::Text(v.clone()))
        .collect();

    let mut rows = conn
        .query(
            &format!("SELECT * FROM \"{}\" WHERE {donde} LIMIT 1;", fila.tabla),
            args,
        )
        .await?;

    let Some(r) = rows.next().await? else {
        return Ok(None);
    };

    // Los nombres de columna salen del PRAGMA y no de la fila: así el orden es el declarado y no
    // depende de cómo devuelva las columnas el driver.
    let mut info = conn
        .query(&format!("PRAGMA table_info(\"{}\");", fila.tabla), ())
        .await?;
    let mut columnas: Vec<String> = Vec::new();
    while let Some(c) = info.next().await? {
        if let Value::Text(n) = c.get_value(1)? {
            if !nombre_aceptable(&n) {
                return Ok(None);
            }
            columnas.push(n);
        }
    }
    if columnas.is_empty() {
        return Ok(None);
    }

    let mut valores: Vec<serde_json::Value> = Vec::with_capacity(columnas.len());
    for i in 0..columnas.len() {
        valores.push(match r.get_value(i as i32)? {
            Value::Null => serde_json::Value::Null,
            Value::Integer(n) => json!(n),
            Value::Real(f) => json!(f),
            Value::Text(s) => json!(s),
            // Los blobs no se replican (v1, ver `db.rs::value_to_json`): reparar una fila mandando
            // NULL donde hay un blob la estropearía más que dejarla como está.
            Value::Blob(_) => return Ok(None),
        });
    }

    let cols = columnas
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let marcas = (1..=columnas.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");

    Ok(Some(SqlStatement {
        sql: format!(
            "INSERT OR REPLACE INTO \"{}\" ({cols}) VALUES ({marcas});",
            fila.tabla
        ),
        args: valores,
    }))
}

// ──────────────────────────────────────────────────────────────────────────────
// SYNC-24: contrastar la foto de la nube contra la base local
// ──────────────────────────────────────────────────────────────────────────────

/// ¿Son el mismo valor?
///
/// Comparar el JSON tal cual daría descuadres falsos a mansalva: la nube devuelve un entero como
/// `1` y libsql local puede devolverlo como `1.0`, y un `4.0` frente a un `4` no es un descuadre,
/// es la misma cifra escrita de dos maneras. Los números se comparan **como números**; el resto,
/// por texto.
///
/// Fallar hacia "son iguales" es lo correcto aquí: un falso descuadre genera una reparación inútil
/// y, sobre todo, una alarma que enseña a ignorar las alarmas.
fn mismo_valor(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value as J;
    match (a, b) {
        (J::Null, J::Null) => true,
        (J::Number(x), J::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(p), Some(q)) => (p - q).abs() < 1e-9,
            _ => x == y,
        },
        // Un número frente a su texto: pasa al cruzar dos drivers distintos.
        (J::Number(x), J::String(s)) | (J::String(s), J::Number(x)) => {
            match (x.as_f64(), s.parse::<f64>()) {
                (Some(p), Ok(q)) => (p - q).abs() < 1e-9,
                _ => false,
            }
        }
        (J::Bool(x), J::Number(y)) | (J::Number(y), J::Bool(x)) => {
            y.as_i64() == Some(if *x { 1 } else { 0 })
        }
        _ => a == b,
    }
}

/// Convierte el valor de una columna local al JSON con el que se compara.
pub fn valor_a_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Integer(n) => json!(n),
        Value::Real(f) => json!(f),
        Value::Text(s) => json!(s),
        Value::Blob(_) => serde_json::Value::Null,
    }
}

/// Compara UNA fila que viene de la nube contra su gemela local.
///
/// Devuelve `None` si la fila no existe en local (la nube tiene algo que aquí no está), y
/// `Some(true)` si existe pero con contenido distinto.
pub async fn fila_difiere(
    conn: &Connection,
    tabla: &str,
    columnas: &[String],
    valores: &[serde_json::Value],
    claves: &[String],
) -> Result<Option<bool>, LibsqlError> {
    if !nombre_aceptable(tabla) || claves.is_empty() {
        return Ok(None);
    }

    let mut donde = Vec::new();
    let mut args = Vec::new();
    for (i, k) in claves.iter().enumerate() {
        let pos = match columnas.iter().position(|c| c.eq_ignore_ascii_case(k)) {
            Some(p) => p,
            None => return Ok(None),
        };
        if !nombre_aceptable(k) {
            return Ok(None);
        }
        donde.push(format!("\"{k}\" = ?{}", i + 1));
        args.push(match valores.get(pos) {
            Some(serde_json::Value::String(s)) => Value::Text(s.clone()),
            Some(serde_json::Value::Number(n)) => Value::Text(n.to_string()),
            _ => return Ok(None),
        });
    }

    let cols = columnas
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    for c in columnas {
        if !nombre_aceptable(c) {
            return Ok(None);
        }
    }

    let mut rows = conn
        .query(
            &format!(
                "SELECT {cols} FROM \"{tabla}\" WHERE {} LIMIT 1;",
                donde.join(" AND ")
            ),
            args,
        )
        .await?;

    let Some(r) = rows.next().await? else {
        return Ok(None);
    };

    for (i, esperado) in valores.iter().enumerate() {
        let local = valor_a_json(&r.get_value(i as i32)?);
        if !mismo_valor(&local, esperado) {
            return Ok(Some(true));
        }
    }
    Ok(Some(false))
}
