//! SYNC-37 · Escribir de una vez filas que se intercambian un valor único.
//!
//! Dos filas que se cambian un valor que tiene que ser único (los nombres de dos zonas: `z1 = A`,
//! `z2 = B` pasan a `z1 = B`, `z2 = A`) no se pueden escribir una detrás de otra: SQLite comprueba
//! el índice sentencia a sentencia, y la primera choca con la segunda mientras ésta siga como está,
//! sea cual sea el orden. Con tres que rotan (`A → B → C → A`) o en cadena (`A → B`, `B → C`), igual.
//! Así que, en la misma transacción y antes de escribir ninguna, cada fila que va a cambiar algo de
//! un índice único **aparca** su valor en uno que no choca con nada, y la escritura de cada una lo
//! pisa con el bueno. Lo usan la convergencia, que escribe aquí lo de la nube (`convergencia.rs`), la
//! salida de las cuarentenas de bajada, que también (`cuarentenas_bajada.rs`, SYNC-38), y la
//! reparación del contraste, que sube lo de aquí en una operación que la nube aplica en una
//! transacción (`contraste.rs`). Lo aparcado no sobrevive a su transacción: la escritura de la fila
//! va en la misma y lo pisa, y si algo no entra se deshace todo.
//!
//! - De cada índice único se aparca **una columna de su clave**, nunca de la clave primaria ni de un
//!   `CHECK` (que no admitiría el valor). Si hay una que admite `NULL` y va tal cual en la clave, en
//!   `NULL`: en un índice único dos `NULL` no chocan, y no rompe una foránea. Si no, en un texto que
//!   sale de la clave primaria de la fila ([`valor_temporal`]: no lo puede tener otra fila ni lo
//!   escribe nadie), en una columna que no sea de una foránea o, si no queda otra, en una que lo sea
//!   (las foráneas se comprueban al confirmar, y para entonces ya tiene su valor). En una clave con
//!   expresiones (`lower(Email)`), la columna sale del texto del índice, y ahí el `NULL` no sirve
//!   (`COALESCE(x, '')` lo convierte en un valor).
//! - SYNC-38 · Si no queda otra, sí una de un `CHECK` que **sólo mira si es `NULL`** y va tal cual
//!   en la clave: la mesa de una comanda abierta (`(Canal = 'MESA') = (ID_Mesa IS NOT NULL)`, en
//!   `Comandas(ID_Mesa) WHERE Estado = 'Abierta'`). Ese `CHECK` da lo mismo con cualquier valor que
//!   no sea `NULL`, así que se aparca en el texto y sólo si no es `NULL`: una fila con `NULL` en la
//!   clave no choca con nada en un índice único.
//! - Se aparca **sólo si cambia algo de lo que decide el índice**: su clave y, en uno parcial, su
//!   condición (`Nombre_Zona … WHERE Archivada_En IS NULL`: una zona que se archiva y otra con su
//!   nombre que se desarchiva también se cruzan). Lo decide la sentencia al ejecutarse, comparando lo
//!   que hay con lo que se va a escribir: una fila que sólo cambia otra cosa no se toca, y la nube lo
//!   compara con lo que tenga ella al aplicarla.
//! - Hace falta con **dos filas o más de una tabla** escritas juntas: una sola no se cruza con nada
//!   que se escriba con ella. Lo mira quien escribe.
//!
//! Un índice que no se sabe aparcar se queda como estaba: si dos filas se cruzan en él, no entran.
//! Es el de una clave cuyas columnas son todas de la clave primaria o de un `CHECK` que mira su
//! valor, o el de una expresión que no deja único el valor temporal (`substr(x, 1, 3)`). En el
//! esquema de hoy no hay ninguno.

use std::collections::{HashMap, HashSet};

use serde_json::Value as Json;
use tpv_application::error::AppResult;
use tpv_contracts::sync::SqlStatement;

use crate::consultas::db_err;
use crate::ejecutor::{Connection, Value};
use crate::filas_tocadas::{cita, nombres_de_un_indice, nombres_en_checks};

/// Un índice único de una tabla, visto para aparcar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IndiceUnico {
    /// La columna que se aparca.
    pub aparcada: String,
    /// Se aparca en `NULL`; si no, en el texto de [`valor_temporal`].
    pub en_nulo: bool,
    /// SYNC-38: se aparca sólo si no es `NULL` (un `CHECK` mira si lo es).
    pub si_no_es_nulo: bool,
    /// Las columnas que deciden el índice: su clave y su condición.
    pub decide: Vec<String>,
}

/// Los índices únicos de cada tabla, leídos del esquema una vez por pasada.
#[derive(Default)]
pub(crate) struct Unicos(HashMap<String, Vec<IndiceUnico>>);

impl Unicos {
    pub(crate) async fn de(&mut self, conn: &Connection, tabla: &str) -> AppResult<&[IndiceUnico]> {
        if !self.0.contains_key(tabla) {
            let leidos = indices_unicos(conn, tabla).await?;
            self.0.insert(tabla.to_owned(), leidos);
        }
        Ok(&self.0[tabla])
    }
}

async fn filas(conn: &Connection, sql: &str, nombre: &str, ancho: i32) -> AppResult<Vec<Vec<Value>>> {
    let mut filas = conn.query(sql, vec![Value::Text(nombre.to_owned())]).await.map_err(db_err)?;
    let mut salida = Vec::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        salida.push((0..ancho).map(|i| f.get_value(i).unwrap_or(Value::Null)).collect());
    }
    Ok(salida)
}

fn texto(v: &Value) -> Option<String> {
    match v {
        Value::Text(t) => Some(t.clone()),
        _ => None,
    }
}

fn entero(v: &Value) -> i64 {
    match v {
        Value::Integer(n) => *n,
        _ => 0,
    }
}

/// Los índices únicos de `tabla` que se saben aparcar, sin el de su clave primaria.
pub(crate) async fn indices_unicos(conn: &Connection, tabla: &str) -> AppResult<Vec<IndiceUnico>> {
    let info = filas(conn, "SELECT name, \"notnull\", pk FROM pragma_table_info(?1) ORDER BY cid;", tabla, 3).await?;
    let columnas: Vec<String> = info.iter().filter_map(|f| texto(&f[0])).collect();
    // Lo que sale del texto del esquema, con el nombre de la columna como lo dice la tabla.
    let columna = |n: &String| columnas.iter().find(|c| c.eq_ignore_ascii_case(n)).cloned();
    let primaria: Vec<String> = info.iter().filter(|f| entero(&f[2]) > 0).filter_map(|f| texto(&f[0])).collect();
    let admite_nulo: HashSet<String> = info.iter().filter(|f| entero(&f[1]) == 0).filter_map(|f| texto(&f[0])).collect();
    let foraneas: HashSet<String> = filas(conn, "SELECT \"from\" FROM pragma_foreign_key_list(?1);", tabla, 1)
        .await?
        .iter()
        .filter_map(|f| texto(&f[0]))
        .filter_map(|c| columna(&c))
        .collect();
    let en_checks: Vec<(String, bool)> = filas(conn, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1;", tabla, 1)
        .await?
        .first()
        .and_then(|f| texto(&f[0]))
        .and_then(|sql| nombres_en_checks(&sql))
        .unwrap_or_default();
    // Las columnas que algún `CHECK` mira por su valor, y las que sólo por si son `NULL` (SYNC-38).
    let checks: HashSet<String> = en_checks.iter().filter(|(_, nulo)| !nulo).filter_map(|(c, _)| columna(c)).collect();
    let solo_si_es_nulo: HashSet<String> =
        en_checks.iter().filter_map(|(c, _)| columna(c)).filter(|c| !checks.contains(c)).collect();

    let mut salida = Vec::new();
    let indices = filas(
        conn,
        "SELECT l.name, m.sql FROM pragma_index_list(?1) l \
           LEFT JOIN sqlite_master m ON m.type = 'index' AND m.name = l.name \
          WHERE l.\"unique\" = 1 AND l.origin <> 'pk' ORDER BY l.name;",
        tabla,
        2,
    )
    .await?;
    for ix in indices {
        let Some(nombre) = texto(&ix[0]) else { continue };
        let partes = filas(conn, "SELECT cid, name FROM pragma_index_xinfo(?1) WHERE key = 1 ORDER BY seqno;", &nombre, 2).await?;
        let tal_cual: Vec<String> = partes.iter().filter(|p| entero(&p[0]) >= 0).filter_map(|p| texto(&p[1])).collect();
        let con_expresion = partes.iter().any(|p| entero(&p[0]) < 0);
        // El de una restricción `UNIQUE` no tiene texto: ni expresiones ni condición.
        let (de_la_clave, de_la_condicion) = match texto(&ix[1]) {
            Some(sql) => match nombres_de_un_indice(&sql) {
                Some(n) => n,
                None => continue,
            },
            None => (Vec::new(), Vec::new()),
        };
        let mut clave = tal_cual.clone();
        if con_expresion {
            for c in de_la_clave.iter().filter_map(columna) {
                if !clave.contains(&c) {
                    clave.push(c);
                }
            }
        }
        // Con toda la clave primaria dentro, dos filas no pueden chocar en él.
        if clave.is_empty() || (!primaria.is_empty() && primaria.iter().all(|p| tal_cual.contains(p))) {
            continue;
        }
        let mut decide = clave.clone();
        for c in de_la_condicion.iter().filter_map(columna) {
            if !decide.contains(&c) {
                decide.push(c);
            }
        }
        let libre = |c: &&String| !primaria.contains(*c) && !checks.contains(*c) && !solo_si_es_nulo.contains(*c);
        // SYNC-38: si no queda otra, una que un `CHECK` sólo mira por si es `NULL`, tal cual en la
        // clave, y mejor si no es de una foránea.
        let por_su_nulidad = tal_cual
            .iter()
            .filter(|c| !primaria.contains(*c) && solo_si_es_nulo.contains(*c))
            .min_by_key(|c| foraneas.contains(*c));
        let (aparcada, en_nulo, si_no_es_nulo) = if let Some(c) = tal_cual.iter().filter(libre).find(|c| admite_nulo.contains(*c)) {
            (c.clone(), true, false)
        } else if let Some(c) = clave.iter().filter(libre).find(|c| !foraneas.contains(*c)) {
            (c.clone(), false, false)
        } else if let Some(c) = clave.iter().find(libre) {
            (c.clone(), false, false)
        } else if let Some(c) = por_su_nulidad {
            (c.clone(), false, true)
        } else {
            continue;
        };
        salida.push(IndiceUnico { aparcada, en_nulo, si_no_es_nulo, decide });
    }
    Ok(salida)
}

/// El texto en que se aparca una columna de una fila: sale de su clave primaria, así que no lo
/// tiene otra, y empieza por un carácter de control que no escribe nadie. La clave va en
/// hexadecimal y en minúsculas, para que un `lower()` o un `upper()` en el índice no junten dos.
pub(crate) fn valor_temporal(clave: &[Json]) -> String {
    let json = serde_json::to_string(clave).unwrap_or_default();
    let hex: String = json.bytes().map(|b| format!("{b:02x}")).collect();
    format!("\u{1}SYNC-37 {hex}")
}

/// La sentencia que aparca los valores únicos de una fila que se va a escribir con `valores` (en
/// el orden de `columnas`, como su escritura): la columna aparcada de cada índice de `indices` en el
/// que va a cambiar algo de lo que lo decide. `None` si no hay ninguno que aparcar. Sólo toca la
/// fila de esa clave, y sólo una columna que su escritura vuelve a poner.
pub(crate) fn aparcar(
    tabla: &str,
    indices: &[IndiceUnico],
    columnas: &[String],
    valores: &[Json],
    clave: &[String],
) -> Option<SqlStatement> {
    if indices.is_empty() || clave.is_empty() || valores.len() != columnas.len() {
        return None;
    }
    let posicion = |c: &str| columnas.iter().position(|x| x.eq_ignore_ascii_case(c));
    let valores_clave: Vec<Json> = clave.iter().map(|k| posicion(k).map(|p| valores[p].clone())).collect::<Option<_>>()?;

    // Cada valor viaja una vez, aunque lo usen varias condiciones.
    let mut args: Vec<Json> = Vec::new();
    let mut numeros: Vec<Option<usize>> = vec![None; columnas.len()];
    let mut numero = |p: usize| -> usize {
        *numeros[p].get_or_insert_with(|| {
            args.push(valores[p].clone());
            args.len()
        })
    };
    let donde: Vec<String> =
        clave.iter().map(|k| posicion(k).map(|p| format!("{} = ?{}", cita(k), numero(p)))).collect::<Option<_>>()?;
    // Las columnas que se aparcan, con las condiciones de los índices que las aparcan.
    let mut aparcadas: Vec<(Aparcada, Vec<String>)> = Vec::new();
    for ix in indices {
        if posicion(&ix.aparcada).is_none() {
            continue;
        }
        let cambia: Vec<String> = ix
            .decide
            .iter()
            .filter_map(|d| posicion(d).map(|p| format!("{} IS NOT ?{}", cita(d), numero(p))))
            .collect();
        if cambia.is_empty() {
            continue;
        }
        let cambia = cambia.join(" OR ");
        match aparcadas.iter_mut().find(|(a, _)| a.columna.eq_ignore_ascii_case(&ix.aparcada)) {
            Some((a, condiciones)) => {
                a.juntar(ix);
                condiciones.push(cambia);
            }
            None => aparcadas.push((Aparcada::de(ix), vec![cambia])),
        }
    }
    if aparcadas.is_empty() {
        return None;
    }
    let temporal = match aparcadas.iter().all(|(a, _)| a.en_nulo) {
        true => String::new(),
        false => {
            args.push(Json::String(valor_temporal(&valores_clave)));
            format!("?{}", args.len())
        }
    };
    let asignaciones: Vec<String> =
        aparcadas.iter().map(|(a, condiciones)| a.asignacion(Some(condiciones.join(" OR ")), &temporal)).collect();
    let alguna = aparcadas.iter().flat_map(|(_, condiciones)| condiciones.iter().cloned()).collect::<Vec<_>>().join(" OR ");
    Some(SqlStatement {
        sql: format!("UPDATE {} SET {} WHERE {} AND ({alguna});", cita(tabla), asignaciones.join(", "), donde.join(" AND ")),
        args,
    })
}

/// SYNC-38 · La sentencia que aparca todos los valores únicos de una fila que se va a borrar en la
/// misma transacción: la columna aparcada de cada índice de `indices`, sin mirar qué tiene. La fila
/// es la que cumple `donde`, cuyos argumentos son `args`; `clave` son los valores de su clave
/// primaria, de los que sale su valor temporal. `None` si no hay nada que aparcar.
///
/// Es la de una fila que sobra en la nube y tiene el valor que necesita otra que se sube: aparcada,
/// la otra entra antes de que se borre. Quien la manda le pone a `donde` la misma condición que a su
/// borrado, en la misma transacción: si no se borra, tampoco se aparca.
pub(crate) fn aparcar_la_que_sobra(tabla: &str, indices: &[IndiceUnico], donde: &str, mut args: Vec<Json>, clave: &[Json]) -> Option<SqlStatement> {
    let mut aparcadas: Vec<Aparcada> = Vec::new();
    for ix in indices {
        match aparcadas.iter_mut().find(|a| a.columna.eq_ignore_ascii_case(&ix.aparcada)) {
            Some(a) => a.juntar(ix),
            None => aparcadas.push(Aparcada::de(ix)),
        }
    }
    if aparcadas.is_empty() {
        return None;
    }
    let temporal = match aparcadas.iter().all(|a| a.en_nulo) {
        true => String::new(),
        false => {
            args.push(Json::String(valor_temporal(clave)));
            format!("?{}", args.len())
        }
    };
    let asignaciones: Vec<String> = aparcadas.iter().map(|a| a.asignacion(None, &temporal)).collect();
    Some(SqlStatement { sql: format!("UPDATE {} SET {} WHERE {donde};", cita(tabla), asignaciones.join(", ")), args })
}

/// Una columna que se aparca, con lo de todos los índices que la aparcan.
struct Aparcada {
    columna: String,
    /// En `NULL` si todos lo admiten; si no, en el texto temporal.
    en_nulo: bool,
    /// SYNC-38: sólo si no es `NULL`, si alguno lo pide.
    si_no_es_nulo: bool,
}

impl Aparcada {
    fn de(ix: &IndiceUnico) -> Self {
        Aparcada { columna: ix.aparcada.clone(), en_nulo: ix.en_nulo, si_no_es_nulo: ix.si_no_es_nulo }
    }

    fn juntar(&mut self, ix: &IndiceUnico) {
        self.en_nulo &= ix.en_nulo;
        self.si_no_es_nulo |= ix.si_no_es_nulo;
    }

    /// `columna = …`: el valor aparcado (`NULL` o `temporal`, el número de su argumento) cuando se
    /// cumple `cuando` (siempre, sin ella) y, si lo pide, la columna no es `NULL`; si no, lo que tiene.
    fn asignacion(&self, cuando: Option<String>, temporal: &str) -> String {
        let c = cita(&self.columna);
        let valor = if self.en_nulo { "NULL" } else { temporal };
        let cuando = match (cuando, self.si_no_es_nulo) {
            (Some(cuando), false) => cuando,
            (Some(cuando), true) => format!("({cuando}) AND {c} IS NOT NULL"),
            (None, true) => format!("{c} IS NOT NULL"),
            (None, false) => return format!("{c} = {valor}"),
        };
        format!("{c} = CASE WHEN {cuando} THEN {valor} ELSE {c} END")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use serde_json::json;
    use std::sync::Arc;

    async fn base(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(&format!("aparcar-{nombre}"));
        Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap()
    }

    fn indice(aparcada: &str, en_nulo: bool, decide: &[&str]) -> IndiceUnico {
        IndiceUnico { aparcada: aparcada.into(), en_nulo, si_no_es_nulo: false, decide: decide.iter().map(|d| d.to_string()).collect() }
    }

    #[tokio::test]
    async fn de_cada_indice_unico_del_esquema_se_aparca_una_columna_que_lo_admite() {
        let db = base("esquema").await;
        let w = db.write().await;
        let conn = w.raw();
        let de = |t: &'static str| async move { indices_unicos(conn, t).await.unwrap() };
        // Uno parcial: su condición también decide.
        assert_eq!(de("Zonas").await, vec![indice("Nombre_Zona", false, &["Nombre_Zona", "Archivada_En"])]);
        assert_eq!(de("Productos").await, vec![indice("Nombre", false, &["Nombre", "Archivado_En"])]);
        // La zona es una foránea: se aparca el número.
        assert_eq!(de("Mesas").await, vec![indice("Numero_Mesa", false, &["ID_Zona", "Numero_Mesa", "Archivada_En"])]);
        // Una expresión: la columna sale del texto, y en texto (en `NULL` no sería único).
        assert_eq!(de("Clientes").await, vec![indice("Email", false, &["Email"])]);
        assert_eq!(de("Cierres_Caja").await, vec![indice("Periodo_Desde", false, &["Periodo_Desde", "Reabierto_En"])]);
        // Lo que admite NULL va en NULL, aunque sea una foránea; `Tipo` tiene un CHECK y no se toca.
        assert_eq!(
            de("Movimientos_Caja").await,
            vec![indice("ID_Gasto", true, &["Tipo", "ID_Gasto"]), indice("ID_Pago", true, &["Tipo", "ID_Pago"])]
        );
        // Restricciones UNIQUE de la tabla, sin texto propio. Una foránea que no admite NULL, en
        // texto si no queda otra.
        assert_eq!(de("Roles_Permisos").await, vec![indice("Permiso", false, &["ID_Rol", "Permiso"])]);
        assert_eq!(
            de("Trabajadores").await,
            vec![
                indice("ID_Usuario", false, &["ID_Usuario"]),
                indice("DNI", true, &["DNI"]),
                indice("Numero_Seguridad_Social", true, &["Numero_Seguridad_Social"]),
            ]
        );
        // SYNC-38: la mesa de una comanda sale en un CHECK que sólo mira si es NULL
        // (`(Canal = 'MESA') = (ID_Mesa IS NOT NULL)`): en texto, y sólo si no lo es.
        assert_eq!(
            de("Comandas").await,
            vec![IndiceUnico { si_no_es_nulo: true, ..indice("ID_Mesa", false, &["ID_Mesa", "Estado"]) }]
        );
        // Sin índices únicos, o sólo el de la clave primaria.
        assert!(de("Reservas").await.is_empty());
        assert!(de("Producto_Alergenos").await.is_empty());

        // Y no queda ningún índice único de una tabla de negocio que no se sepa aparcar.
        let mut tablas = conn
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;", ())
            .await
            .unwrap();
        let mut nombres: Vec<String> = Vec::new();
        while let Some(f) = tablas.next().await.unwrap() {
            nombres.push(f.get::<String>(0).unwrap());
        }
        drop(tablas);
        let mut sin_aparcar = Vec::new();
        for t in nombres.iter().filter(|t| !crate::sync::no_es_tabla_de_negocio(t)) {
            let mut f = conn
                .query(
                    "SELECT COUNT(*) FROM pragma_index_list(?1) l WHERE l.\"unique\" = 1 AND l.origin <> 'pk' \
                       AND (NOT EXISTS (SELECT 1 FROM pragma_table_info(?1) WHERE pk > 0) \
                            OR EXISTS (SELECT 1 FROM pragma_table_info(?1) p WHERE p.pk > 0 \
                                        AND p.name NOT IN (SELECT name FROM pragma_index_info(l.name) WHERE name IS NOT NULL)));",
                    vec![Value::Text(t.clone())],
                )
                .await
                .unwrap();
            let unicos = f.next().await.unwrap().unwrap().get::<i64>(0).unwrap();
            drop(f);
            if unicos != indices_unicos(conn, t).await.unwrap().len() as i64 {
                sin_aparcar.push(t.clone());
            }
        }
        assert!(sin_aparcar.is_empty(), "{sin_aparcar:?}");
        drop(w);
    }

    #[tokio::test]
    async fn ningun_choque_del_esquema_deshace_la_transaccion_entera() {
        // Lo que separa lo que choca (la convergencia y la salida de las cuarentenas, SYNC-37 y
        // SYNC-38) sigue escribiendo tras una sentencia que choca, porque SQLite sólo deshace ésa. Un
        // `ON CONFLICT ROLLBACK` o un `RAISE(ROLLBACK)` deshace la transacción entera, y lo que viniera
        // detrás se confirmaría suelto, con lo aparcado incluido (Codex). Si alguno hace falta, eso
        // hay que revisarlo antes.
        let db = base("sin-rollback").await;
        let r = db.read().await;
        let mut f = r
            .conn()
            .query("SELECT group_concat(name, ', ') FROM sqlite_master WHERE sql LIKE '%ROLLBACK%';", ())
            .await
            .unwrap();
        assert_eq!(f.next().await.unwrap().unwrap().get_value(0).unwrap(), Value::Null);
    }

    #[tokio::test]
    async fn la_mesa_de_una_comanda_abierta_se_aparca_solo_si_tiene_mesa() {
        // SYNC-38: dos comandas abiertas que se cambian la mesa, y un ticket de barra (sin mesa), que
        // no ocupa sitio en el índice y al que el CHECK no le deja tener mesa.
        let db = base("comanda-abierta").await;
        let w = db.write().await;
        let conn = w.raw();
        conn.execute_batch(
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');
             INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
                  VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80), ('m2', 'z1', '2', 4, 0, 0, 'rect', 80, 80);
             INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado) VALUES
                  ('c1', 'm1', 'MESA', '2026-11-15 12:00:00', 'Abierta'),
                  ('c2', 'm2', 'MESA', '2026-11-15 12:00:00', 'Abierta'),
                  ('c3', NULL, 'BARRA', '2026-11-15 12:00:00', 'Abierta');",
        )
        .await
        .unwrap();
        let indices = indices_unicos(conn, "Comandas").await.unwrap();
        let columnas: Vec<String> = ["ID_Comanda", "ID_Mesa", "Canal", "Estado"].map(String::from).to_vec();
        let clave = vec!["ID_Comanda".to_string()];
        let ejecutar = |s: SqlStatement| async move {
            let args = s.args.iter().map(|a| match a {
                Json::String(t) => Value::Text(t.clone()),
                Json::Null => Value::Null,
                otro => Value::Integer(otro.as_i64().unwrap()),
            });
            conn.execute(&s.sql, args.collect::<Vec<_>>()).await.unwrap()
        };
        conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;").await.unwrap();
        // La de la mesa 1 pasa a la 2, y la de la 2 a la 1: se aparcan las dos.
        let c1 = aparcar("Comandas", &indices, &columnas, &[json!("c1"), json!("m2"), json!("MESA"), json!("Abierta")], &clave).unwrap();
        // El texto que fija `test/nombresCruzadosEnUnLote.test.ts` en el TenantHub.
        assert_eq!(
            c1.sql,
            "UPDATE \"Comandas\" SET \"ID_Mesa\" = CASE WHEN (\"ID_Mesa\" IS NOT ?2 OR \"Estado\" IS NOT ?3) AND \"ID_Mesa\" IS NOT NULL \
             THEN ?4 ELSE \"ID_Mesa\" END WHERE \"ID_Comanda\" = ?1 AND (\"ID_Mesa\" IS NOT ?2 OR \"Estado\" IS NOT ?3);"
        );
        assert_eq!(c1.args, vec![json!("c1"), json!("m2"), json!("Abierta"), json!(valor_temporal(&[json!("c1")]))]);
        assert_eq!(ejecutar(c1).await, 1);
        let c2 = aparcar("Comandas", &indices, &columnas, &[json!("c2"), json!("m1"), json!("MESA"), json!("Abierta")], &clave).unwrap();
        assert_eq!(ejecutar(c2).await, 1);
        // El ticket de barra pasa a una mesa: la sentencia lo toca, pero sin mesa no aparca nada (el
        // CHECK no lo admitiría).
        let c3 = aparcar("Comandas", &indices, &columnas, &[json!("c3"), json!("m1"), json!("MESA"), json!("Abierta")], &clave).unwrap();
        ejecutar(c3).await;
        // Y las escrituras entran, sin nada aparcado.
        conn.execute_batch(
            "UPDATE Comandas SET ID_Mesa = 'm2' WHERE ID_Comanda = 'c1';
             UPDATE Comandas SET ID_Mesa = 'm1' WHERE ID_Comanda = 'c2';
             COMMIT;",
        )
        .await
        .unwrap();
        let mut f = conn
            .query("SELECT group_concat(ID_Comanda || '=' || COALESCE(ID_Mesa, '-'), ' ') FROM (SELECT * FROM Comandas ORDER BY ID_Comanda);", ())
            .await
            .unwrap();
        assert_eq!(f.next().await.unwrap().unwrap().get::<String>(0).unwrap(), "c1=m2 c2=m1 c3=-");
        drop(f);
        // Lo que sobra arriba también: con mesa, en texto; sin ella, se queda como está.
        let sobra = aparcar_la_que_sobra("Comandas", &indices, "\"ID_Comanda\" = ?1", vec![json!("c9")], &[json!("c9")]).unwrap();
        assert_eq!(
            sobra.sql,
            "UPDATE \"Comandas\" SET \"ID_Mesa\" = CASE WHEN \"ID_Mesa\" IS NOT NULL THEN ?2 ELSE \"ID_Mesa\" END WHERE \"ID_Comanda\" = ?1;"
        );
        drop(w);
    }

    #[tokio::test]
    async fn la_sentencia_aparca_solo_lo_que_cambia_de_un_indice_y_deja_lo_demas() {
        let db = base("sentencia").await;
        let w = db.write().await;
        let conn = w.raw();
        conn.execute_batch(
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points) VALUES ('z1', 'A', '[1]'), ('z2', 'B', '[2]'), ('z3', 'C', '[3]');",
        )
        .await
        .unwrap();
        let indices = indices_unicos(conn, "Zonas").await.unwrap();
        let columnas: Vec<String> = ["ID_Zona", "Nombre_Zona", "Room_Points", "Updated_At", "Archivada_En"].map(String::from).to_vec();
        let clave = vec!["ID_Zona".to_string()];
        let ejecutar = |s: SqlStatement| async move {
            let args = s.args.iter().map(|a| match a {
                Json::String(t) => Value::Text(t.clone()),
                Json::Null => Value::Null,
                otro => Value::Integer(otro.as_i64().unwrap()),
            });
            conn.execute(&s.sql, args.collect::<Vec<_>>()).await.unwrap()
        };

        // z1 pasa a llamarse B: se aparca.
        let s = aparcar("Zonas", &indices, &columnas, &[json!("z1"), json!("B"), json!("[9]"), Json::Null, Json::Null], &clave).unwrap();
        assert_eq!(ejecutar(s).await, 1);
        // z3 sólo cambia sus puntos: la sentencia no la toca.
        let s = aparcar("Zonas", &indices, &columnas, &[json!("z3"), json!("C"), json!("[9]"), Json::Null, Json::Null], &clave).unwrap();
        assert_eq!(ejecutar(s).await, 0);
        // Ni otra fila, ni otra columna.
        let mut filas = conn.query("SELECT ID_Zona, Nombre_Zona, Room_Points FROM Zonas ORDER BY ID_Zona;", ()).await.unwrap();
        let mut vistas = Vec::new();
        while let Some(f) = filas.next().await.unwrap() {
            vistas.push((f.get::<String>(0).unwrap(), f.get::<String>(1).unwrap(), f.get::<String>(2).unwrap()));
        }
        let temporal = valor_temporal(&[json!("z1")]);
        assert_eq!(
            vistas,
            vec![
                ("z1".into(), temporal.clone(), "[1]".into()),
                ("z2".into(), "B".into(), "[2]".into()),
                ("z3".into(), "C".into(), "[3]".into()),
            ]
        );
        // Lo que la escritura no vuelve a poner no se aparca.
        assert!(aparcar("Zonas", &indices, &columnas[..3], &[json!("z1"), json!("B"), json!("[9]")], &clave).is_some());
        let sin_nombre: Vec<String> = vec!["ID_Zona".into(), "Room_Points".into()];
        assert!(aparcar("Zonas", &indices, &sin_nombre, &[json!("z1"), json!("[9]")], &clave).is_none());
        drop(filas);
        drop(w);
    }

    #[test]
    fn lo_que_aparca_se_lee_como_una_escritura_de_su_fila() {
        // Lo que sube en una reparación lo leen la subida (`Carrera`) y SYNC-31 sin ejecutarlo: tiene
        // que verse como lo que es, una escritura de esa fila de esa tabla.
        let indices = vec![indice("Nombre_Zona", false, &["Nombre_Zona", "Archivada_En"])];
        let columnas: Vec<String> = ["ID_Zona", "Nombre_Zona", "Archivada_En"].map(String::from).to_vec();
        let s = aparcar("Zonas", &indices, &columnas, &[json!("z1"), json!("B"), Json::Null], &["ID_Zona".to_string()]).unwrap();
        assert_eq!(
            s.sql,
            "UPDATE \"Zonas\" SET \"Nombre_Zona\" = CASE WHEN \"Nombre_Zona\" IS NOT ?2 OR \"Archivada_En\" IS NOT ?3 THEN ?4 \
             ELSE \"Nombre_Zona\" END WHERE \"ID_Zona\" = ?1 AND (\"Nombre_Zona\" IS NOT ?2 OR \"Archivada_En\" IS NOT ?3);"
        );
        assert_eq!(s.args, vec![json!("z1"), json!("B"), Json::Null, json!(valor_temporal(&[json!("z1")]))]);
        let e = crate::filas_tocadas::estaticas(&[s], &|_| vec!["ID_Zona".to_string()]);
        assert!(e.todas.contains("Zonas") && !e.tablas.contains("*"));
        assert_eq!(e.claves.len(), 1);
    }

    #[test]
    fn el_valor_temporal_es_el_de_su_fila_y_no_se_confunde_con_el_de_otra() {
        let a = valor_temporal(&[json!("z1")]);
        assert_eq!(a, valor_temporal(&[json!("z1")]));
        assert_ne!(a.to_lowercase(), valor_temporal(&[json!("Z1")]).to_lowercase());
        assert_ne!(a, valor_temporal(&[json!("z1"), json!("")]));
        assert!(a.starts_with('\u{1}'));
    }
}
