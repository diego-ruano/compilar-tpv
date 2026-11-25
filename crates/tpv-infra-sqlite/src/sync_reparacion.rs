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
//! mandar un `INSERT … ON CONFLICT(clave) DO UPDATE` con su contenido actual. No depende del orden,
//! se puede repetir sin consecuencias y converge — da igual cuántas operaciones se perdieran por el
//! camino.
//!
//! # Y la comanda, entera (SYNC-31)
//!
//! Las filas que se reparan son las que la operación apartada escribió y su analizador sabe
//! localizar ([`analizar`]), y además, si alguna cuelga de una comanda, **la comanda entera**: ella,
//! sus líneas, sus cobros y lo que cuelga de ellos (las líneas de cada cobro, sus consumos de stock,
//! su movimiento de caja, su registro fiscal…), por sus claves foráneas ([`comandas_de`],
//! [`filas_de_las_comandas`]). Un cobro que la nube rechaza porque una Handy borró el ticket mientras
//! subía no se arregla con su pago suelto: hace falta lo que el borrado se llevó y lo que el cobro
//! escribió con un `INSERT … SELECT`, que el analizador no sabe leer.
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

use std::collections::{HashMap, HashSet, VecDeque};

use crate::ejecutor::{ErrorSql, Value};
use crate::ejecutor::Connection;
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
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
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
    /// es una fila que mandar. Se marca para poder informarlo (SYNC-23).
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
pub async fn claves_primarias(conn: &Connection, tabla: &str) -> Result<Vec<String>, ErrorSql> {
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

// ──────────────────────────────────────────────────────────────────────────────
// SYNC-31: la comanda afectada, entera
// ──────────────────────────────────────────────────────────────────────────────

/// La tabla de la que cuelga lo que se repara entero.
const COMANDAS: &str = "Comandas";

/// Lo más que se repara de las comandas afectadas en una operación. Una comanda con sus líneas, sus
/// cobros y lo que cuelga de ellos son decenas o cientos de filas; con más, la reparación se queda
/// en lo que tocaba la operación, y lo demás lo sube el contraste con la nube.
pub(crate) const MAX_FILAS_DE_LAS_COMANDAS: usize = 2_000;

/// Una clave foránea de una columna entre dos tablas de negocio: `hija.desde` → `padre.hasta`.
#[derive(Debug, Clone)]
pub(crate) struct Foranea {
    pub hija: String,
    pub desde: String,
    pub padre: String,
    pub hasta: String,
}

/// Las claves foráneas de una sola columna entre las tablas de negocio de esta base. Las compuestas
/// no se siguen: ninguna lleva a una comanda.
pub(crate) async fn foraneas(conn: &Connection) -> Result<Vec<Foranea>, ErrorSql> {
    let mut filas = conn
        .query(
            "SELECT m.name, f.id, f.\"from\", f.\"table\", f.\"to\" FROM sqlite_master m \
               JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq;",
            (),
        )
        .await?;
    // (hija, id) → sus columnas: (desde, padre, hasta).
    type Columnas = Vec<(String, String, Option<String>)>;
    let mut por_id: Vec<((String, i64), Columnas)> = Vec::new();
    while let Some(f) = filas.next().await? {
        let (Value::Text(hija), Value::Integer(id), Value::Text(desde), Value::Text(padre)) =
            (f.get_value(0)?, f.get_value(1)?, f.get_value(2)?, f.get_value(3)?)
        else {
            continue;
        };
        let hasta = match f.get_value(4)? {
            Value::Text(t) => Some(t),
            _ => None,
        };
        match por_id.last_mut() {
            Some(((h, i), columnas)) if *h == hija && *i == id => columnas.push((desde, padre, hasta)),
            _ => por_id.push(((hija, id), vec![(desde, padre, hasta)])),
        }
    }
    drop(filas);

    let mut salida = Vec::new();
    for ((hija, _), columnas) in por_id {
        let [(desde, padre, hasta)] = columnas.as_slice() else { continue };
        if crate::sync::no_es_tabla_de_negocio(&hija) || crate::sync::no_es_tabla_de_negocio(padre) {
            continue;
        }
        // Sin columna destino, la foránea apunta a la clave primaria del padre.
        let hasta = match hasta {
            Some(h) => h.clone(),
            None => match claves_primarias(conn, padre).await?.as_slice() {
                [clave] => clave.clone(),
                _ => continue,
            },
        };
        salida.push(Foranea { hija, desde: desde.clone(), padre: padre.clone(), hasta });
    }
    Ok(salida)
}

/// El valor de `columna` en la fila de `tabla` que cumple las igualdades de `donde`, como texto.
/// `None` si la fila no está o la columna es nula.
async fn columna_de(
    conn: &Connection,
    tabla: &str,
    columna: &str,
    donde: &[(String, String)],
) -> Result<Option<String>, ErrorSql> {
    if !nombre_aceptable(tabla) || !nombre_aceptable(columna) || donde.is_empty() || donde.iter().any(|(c, _)| !nombre_aceptable(c)) {
        return Ok(None);
    }
    let condiciones = donde.iter().enumerate().map(|(i, (c, _))| format!("\"{c}\" = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ");
    let args: Vec<Value> = donde.iter().map(|(_, v)| Value::Text(v.clone())).collect();
    let mut filas = conn.query(&format!("SELECT \"{columna}\" FROM \"{tabla}\" WHERE {condiciones} LIMIT 1;"), args).await?;
    Ok(match filas.next().await? {
        Some(f) => match f.get_value(0)? {
            Value::Text(t) => Some(t),
            Value::Integer(n) => Some(n.to_string()),
            _ => None,
        },
        None => None,
    })
}

/// SYNC-31 · Las comandas de las que cuelgan estas filas: la propia, si es una comanda, o la que se
/// alcanza subiendo por sus claves foráneas (la línea de un cobro → el cobro → su comanda). Sólo
/// las que están en esta base.
pub(crate) async fn comandas_de(
    conn: &Connection,
    foraneas: &[Foranea],
    filas: &[FilaAfectada],
) -> Result<Vec<String>, ErrorSql> {
    let Some(clave_comanda) = claves_primarias(conn, COMANDAS).await?.into_iter().next() else {
        return Ok(Vec::new());
    };
    // Las tablas desde las que se llega a una comanda subiendo por sus foráneas.
    let mut llegan: HashSet<&str> = HashSet::from([COMANDAS]);
    loop {
        let antes = llegan.len();
        for f in foraneas {
            if llegan.contains(f.padre.as_str()) {
                llegan.insert(f.hija.as_str());
            }
        }
        if llegan.len() == antes {
            break;
        }
    }

    let mut comandas: Vec<String> = Vec::new();
    let mut vistas: HashSet<(String, String, String)> = HashSet::new();
    // Una fila por mirar: su tabla, las igualdades que la nombran y cuántos saltos lleva.
    type PorMirar = (String, Vec<(String, String)>, usize);
    let mut pila: Vec<PorMirar> =
        filas.iter().filter(|f| llegan.contains(f.tabla.as_str())).map(|f| (f.tabla.clone(), f.clave.clone(), 0)).collect();
    while let Some((tabla, donde, saltos)) = pila.pop() {
        if tabla == COMANDAS {
            if let Some(id) = columna_de(conn, COMANDAS, &clave_comanda, &donde).await? {
                if !comandas.contains(&id) {
                    comandas.push(id);
                }
            }
            continue;
        }
        if saltos == 4 {
            continue;
        }
        for f in foraneas.iter().filter(|f| f.hija == tabla && llegan.contains(f.padre.as_str())) {
            if let Some(valor) = columna_de(conn, &tabla, &f.desde, &donde).await? {
                if vistas.insert((f.padre.clone(), f.hasta.clone(), valor.clone())) {
                    pila.push((f.padre.clone(), vec![(f.hasta.clone(), valor)], saltos + 1));
                }
            }
        }
    }
    Ok(comandas)
}

/// Las filas de `tabla` cuya `columna` es uno de `valores`, por su clave primaria, hasta `tope`.
async fn filas_donde(
    conn: &Connection,
    tabla: &str,
    clave: &[String],
    columna: &str,
    valores: &[String],
    tope: usize,
) -> Result<Vec<FilaAfectada>, ErrorSql> {
    if clave.is_empty() || !nombre_aceptable(tabla) || !nombre_aceptable(columna) || clave.iter().any(|c| !nombre_aceptable(c)) {
        return Ok(Vec::new());
    }
    let lista = clave.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    // La lista va en un solo parámetro, como en todo lo que tiene un tamaño que no se sabe. Sin
    // `ORDER BY`: con él, SQLite recorrería todas las que cumplen para ordenarlas antes de cortar, y
    // el orden de lo que sube lo pone después quien las encola.
    let mut filas = conn
        .query(
            &format!("SELECT {lista} FROM \"{tabla}\" WHERE \"{columna}\" IN (SELECT value FROM json_each(?1)) LIMIT ?2;"),
            vec![Value::Text(serde_json::to_string(valores).unwrap_or_else(|_| "[]".into())), Value::Integer(tope as i64)],
        )
        .await?;
    let mut salida = Vec::new();
    'filas: while let Some(f) = filas.next().await? {
        let mut valores = Vec::with_capacity(clave.len());
        for (i, c) in clave.iter().enumerate() {
            match f.get_value(i as i32)? {
                Value::Text(t) => valores.push((c.clone(), t)),
                Value::Integer(n) => valores.push((c.clone(), n.to_string())),
                _ => continue 'filas,
            }
        }
        salida.push(FilaAfectada { tabla: tabla.to_string(), clave: valores });
    }
    Ok(salida)
}

/// SYNC-31 · Lo que hay de unas comandas en esta base, ellas incluidas: bajando por las claves
/// foráneas, sus líneas y sus cobros, y de éstos lo que cuelga de ellos (las líneas de cada cobro,
/// sus devoluciones, sus consumos de stock, su movimiento de caja, su registro fiscal). Sólo se baja
/// por una foránea que apunta a la clave de una columna de su padre, que en este esquema son todas.
///
/// `None` si pasa de [`MAX_FILAS_DE_LAS_COMANDAS`].
pub(crate) async fn filas_de_las_comandas(
    conn: &Connection,
    foraneas: &[Foranea],
    comandas: &[String],
) -> Result<Option<Vec<FilaAfectada>>, ErrorSql> {
    let mut claves: HashMap<String, Vec<String>> = HashMap::new();
    let mut salida: Vec<FilaAfectada> = Vec::new();
    let mut vistas: HashSet<FilaAfectada> = HashSet::new();
    let Some(clave_comanda) = claves_primarias(conn, COMANDAS).await?.into_iter().next() else {
        return Ok(Some(Vec::new()));
    };
    // Lo que queda por bajar: de qué tabla, por qué columna y qué valores.
    let mut cola: VecDeque<(String, String, Vec<String>)> =
        VecDeque::from([(COMANDAS.to_string(), clave_comanda, comandas.to_vec())]);
    while let Some((tabla, columna, valores)) = cola.pop_front() {
        if valores.is_empty() {
            continue;
        }
        if !claves.contains_key(&tabla) {
            claves.insert(tabla.clone(), claves_primarias(conn, &tabla).await?);
        }
        let clave = claves[&tabla].clone();
        // No se lee más de lo que cabe: una que pasa del tope ya dice que no cabe.
        let leidas = filas_donde(conn, &tabla, &clave, &columna, &valores, MAX_FILAS_DE_LAS_COMANDAS + 1).await?;
        if leidas.len() > MAX_FILAS_DE_LAS_COMANDAS {
            return Ok(None);
        }
        let nuevas: Vec<FilaAfectada> = leidas.into_iter().filter(|f| vistas.insert(f.clone())).collect();
        if salida.len() + nuevas.len() > MAX_FILAS_DE_LAS_COMANDAS {
            return Ok(None);
        }
        // De las nuevas se baja a sus hijas, por su clave si es de una columna.
        if let [columna_clave] = clave.as_slice() {
            let suyas: Vec<String> = nuevas.iter().filter_map(|f| f.clave.first().map(|(_, v)| v.clone())).collect();
            for f in foraneas.iter().filter(|f| f.padre == tabla && f.hasta == *columna_clave) {
                cola.push_back((f.hija.clone(), f.desde.clone(), suyas.clone()));
            }
        }
        salida.extend(nuevas);
    }
    Ok(Some(salida))
}

/// Construye la sentencia que vuelve a igualar una fila: su contenido ACTUAL en la Main.
///
/// Devuelve `Ok(None)` si la fila ya no existe en local. Ese caso **no es un error y no se repara**:
/// significa que se borró, y un borrado no se puede expresar como estado (ver `Analisis::borrados`).
pub async fn sentencia_de_reparacion(
    conn: &Connection,
    fila: &FilaAfectada,
) -> Result<Option<SqlStatement>, ErrorSql> {
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

    // ⚠️ **NUNCA `INSERT OR REPLACE`.** En SQLite eso BORRA la fila que hay y la reinserta, así que
    // dispara los `ON DELETE CASCADE` que la apuntan — y este esquema tiene DIECIOCHO. Reparar el
    // nombre de una `Zona` se habría llevado por delante todas sus `Mesas` en la nube, y la Handy
    // se habría quedado sin plano. Un `ON CONFLICT … DO UPDATE` actualiza en el sitio: no borra
    // nada, no cascadea nada, y sigue insertando si la fila no estaba.
    //
    // El objetivo del conflicto son las columnas de la clave primaria; `excluded` es la fila que se
    // intentaba insertar, o sea el estado que trae esta reparación.
    let objetivo = fila
        .clave
        .iter()
        .map(|(c, _)| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let claves: std::collections::HashSet<&str> =
        fila.clave.iter().map(|(c, _)| c.as_str()).collect();
    let asignaciones = columnas
        .iter()
        .filter(|c| !claves.contains(c.as_str()))
        .map(|c| format!("\"{c}\" = excluded.\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");

    // Una tabla que es TODA clave primaria (las de unión, como `Producto_Alergenos`) no tiene nada
    // que actualizar: basta con que la fila exista.
    let accion = if asignaciones.is_empty() {
        "DO NOTHING".to_string()
    } else {
        format!("DO UPDATE SET {asignaciones}")
    };

    Ok(Some(SqlStatement {
        sql: format!(
            "INSERT INTO \"{}\" ({cols}) VALUES ({marcas}) ON CONFLICT({objetivo}) {accion};",
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
/// `1` y la base local puede devolverlo como `1.0`, y un `4.0` frente a un `4` no es un descuadre,
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
) -> Result<Option<bool>, ErrorSql> {
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

/// La condición que señala una fila por su clave (`"ID" = ?1 AND …`) y sus argumentos. `None` si la
/// tabla o una columna no es un nombre aceptable, o no tiene clave.
pub(crate) fn donde_de_la_clave(fila: &FilaAfectada) -> Option<(String, Vec<serde_json::Value>)> {
    if !nombre_aceptable(&fila.tabla) || fila.clave.is_empty() {
        return None;
    }
    let mut donde = Vec::new();
    let mut args = Vec::new();
    for (i, (c, v)) in fila.clave.iter().enumerate() {
        if !nombre_aceptable(c) {
            return None;
        }
        donde.push(format!("\"{c}\" = ?{}", i + 1));
        args.push(json!(v));
    }
    Some((donde.join(" AND "), args))
}
