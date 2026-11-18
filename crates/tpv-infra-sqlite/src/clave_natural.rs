//! SYN-INC-07 · Dos fichas con la misma clave natural, una aquí y otra en la nube: se funde la de
//! aquí en la de la nube.
//!
//! La Main da de alta a una clienta con su correo y, antes de que suba, una Handy da de alta a la
//! misma clienta con el mismo correo (o una reserva web recogida aquí trae el correo de una ficha
//! que una Handy acaba de crear). Cada lado tiene su ficha y el índice único del correo
//! (`ux_clientes_email`, sobre `lower(Email)`) no deja que entre la del otro:
//!
//! - **Subiendo**, la nube rechaza el alta de la Main como permanente, y la reparación por estado,
//!   que es el mismo `INSERT … ON CONFLICT(clave)`, vuelve a chocar: las dos quedan apartadas. Lo que
//!   después cuelga de esa ficha (sus reservas, el cliente de un cobro) choca con la foránea arriba y
//!   se aparta también.
//! - **Bajando**, el alta de la Handy choca aquí con la ficha de la Main y acaba en cuarentena; la
//!   salida de la cuarentena (SYNC-36) trae la fila de la nube y sigue chocando. Y con una cuarentena
//!   de bajada el contraste no repara nada de ninguna tabla.
//!
//! El correo dice que es la misma persona (CLI-01), así que se queda una ficha, **la de la nube**,
//! que es la que ya ven las Handy y la agenda web ([`fundir`]). Lo hace la salida de las cuarentenas
//! de bajada, que es quien tiene delante la fila de la nube (traída por su clave con la foto del
//! contraste, `cuarentenas_bajada::resolver`), cuando una cuarentena sigue sin entrar por un índice
//! único. En una transacción y por `WriteGuard`, para que la nube haga lo mismo:
//!
//! 1. Se le quitan a la ficha de aquí sus valores únicos (el correo), para que la de la nube quepa.
//! 2. Se escribe la de la nube **rellenando sólo sus huecos** con lo de la de aquí, el criterio de
//!    RES-01: un dato que la de la nube ya tiene no se cambia. Aquí se escribe entera, como la trajo
//!    la foto (un `INSERT` que sólo escribe donde la de aquí está todavía, y arriba no está); arriba
//!    sólo un `UPDATE` de los huecos, con lo de la de aquí y nada más (`COALESCE(NULLIF(col, ''), ?)`).
//!    Así no se pisa lo que una Handy haya cambiado o vaciado después de la foto, ni se resucita la
//!    ficha si la ha borrado.
//! 3. Todo lo que apunta a la de aquí pasa a apuntar a la de la nube: las foráneas se leen del
//!    esquema (`sync_reparacion::foraneas`), no de una lista escrita a mano.
//! 4. Lo que es un agregado de la ficha (`Total_Gastado`) se re-deriva en el SQL, con lo que haya en
//!    cada base al aplicarlo.
//! 5. Se borra la de aquí.
//!
//! En la misma transacción se retira lo apartado de la subida que nombraba la ficha de aquí
//! ([`retirar_lo_apartado`]): lo que sólo escribía esa ficha ya no dice nada y se borra; lo demás
//! (una reserva, un cobro) se repara por estado en una operación que lo enlaza en `Repara_Op_Id`, y se
//! retira cuando esa operación sube. En la pasada siguiente la cuarentena sale sola (lo que trae de la
//! nube ya cabe) y, sin cuarentenas, el contraste vuelve a reparar.
//!
//! **Sólo se funde lo que esta Main escribió y la nube no tiene**: la ficha de aquí tiene que estar
//! escrita por algo apartado de la subida (`Estaticas::claves`). Con todo subido —la salida de las
//! cuarentenas sólo corre así— una ficha de aquí con el correo de otra de la nube es eso o algo que no
//! se sabe explicar, y lo que no se sabe explicar no se toca: la cuarentena se queda, y a la semana se
//! avisa (`bajada_atascada`).
//!
//! Es idempotente: si la de aquí ya se fundió, no hay choque y no hay nada que fundir; si la de la
//! nube ya no está, la salida no la trae y tampoco. Las fichas de Proveedores (correo y CIF únicos)
//! siguen la misma descripción ([`DESCRIPCIONES`]).

use std::collections::HashMap;

use serde_json::Value as Json;
use tpv_application::error::AppResult;
use tpv_contracts::sync::SqlStatement;

use crate::consultas::db_err;
use crate::cuarentenas_bajada::Traida;
use crate::db::{WriteGuard, Writer};
use crate::ejecutor::{Connection, Value};
use crate::filas_tocadas::{self as tocadas, cita, FilaTocada, Tocadas};

/// Un valor único que identifica a la entidad (el correo de una clienta).
#[derive(Debug)]
pub(crate) struct Unico {
    pub columna: &'static str,
    /// El índice no distingue mayúsculas (`lower(Email)`): se compara igual.
    pub sin_mayusculas: bool,
}

/// Cómo se funden dos filas de una tabla que chocan por una clave natural.
#[derive(Debug)]
pub(crate) struct Descripcion {
    pub tabla: &'static str,
    /// Su clave primaria, de una columna.
    pub clave: &'static str,
    pub unicos: &'static [Unico],
    /// Las columnas que son un agregado: no se rellenan, se re-derivan.
    pub derivadas: &'static [&'static str],
    /// Las sentencias que las re-derivan en la fila que se queda (`?1`).
    pub rederivar: &'static [&'static str],
}

/// Las tablas cuyas fichas se funden. Clientes (el correo) y Proveedores (el correo y el CIF), las
/// dos que dan de alta la Main y las Handy con un valor único que dice quién es.
pub(crate) const DESCRIPCIONES: &[Descripcion] = &[
    Descripcion {
        tabla: "Clientes",
        clave: "ID_Cliente",
        unicos: &[Unico { columna: "Email", sin_mayusculas: true }],
        derivadas: &["Total_Gastado"],
        rederivar: &[crate::reconciliacion::SQL_REDERIVAR_GASTO],
    },
    Descripcion {
        tabla: "Proveedores",
        clave: "ID_Proveedor",
        unicos: &[Unico { columna: "Email", sin_mayusculas: false }, Unico { columna: "CIF", sin_mayusculas: false }],
        derivadas: &[],
        rederivar: &[],
    },
];

/// ¿Un valor que no identifica a nadie, o un hueco que se puede rellenar? `NULL` o `''`, tal cual:
/// el índice de Clientes no los cuenta (`Email <> ''`), dos proveedores sin correo no son el mismo,
/// y es lo que la sentencia replicada trata como hueco (`NULLIF(col, '')`). Un texto de sólo
/// espacios no está vacío para ninguno de los tres: si aquí lo fuera, aquí se rellenaría y arriba no.
fn vacio(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Text(t) => t.is_empty(),
        _ => false,
    }
}

/// Un valor que una sentencia replicada no puede llevar tal cual (`db.rs::value_to_json`).
fn no_se_replica(v: &Value) -> bool {
    match v {
        Value::Blob(_) => true,
        Value::Real(x) => !x.is_finite(),
        _ => false,
    }
}

fn texto(v: &Value) -> Option<&str> {
    match v {
        Value::Text(t) => Some(t),
        _ => None,
    }
}

/// La forma canónica de la fila de `tabla` con esa clave, para cruzarla con lo apartado.
fn canonica(tabla: &str, id: &str) -> Option<String> {
    tocadas::canonica_de(&FilaTocada { tabla: tabla.to_owned(), clave: vec![Json::String(id.to_owned())], borrada: false })
}

/// Funde en la de la nube las fichas de aquí que chocan con las filas que ha traído para una
/// cuarentena de bajada (`tocadas`), si son de una tabla de [`DESCRIPCIONES`]. Devuelve cuántas ha
/// fundido. Ver el encabezado.
pub(crate) async fn fundir(
    w: &WriteGuard<'_>,
    tocadas: &Tocadas,
    arriba: &HashMap<String, Traida>,
    claves: &HashMap<String, Vec<String>>,
    subida: &tocadas::Estaticas,
) -> AppResult<usize> {
    let conn: &Connection = w.raw();
    let mut fundidas = 0usize;
    for f in tocadas.filas.iter().filter(|f| !f.borrada) {
        let Some(d) = DESCRIPCIONES.iter().find(|d| d.tabla == f.tabla) else { continue };
        if claves.get(d.tabla).map(Vec::as_slice) != Some(&[d.clave.to_owned()][..]) {
            continue;
        }
        let Some(traida) = arriba.get(d.tabla).filter(|t| !t.sin_buscar) else { continue };
        let Some(nube) = tocadas::canonica_de(f).and_then(|k| traida.filas.get(&k)) else { continue };
        let Some(nube) = nube.iter().map(crate::convergencia::celda).collect::<Option<Vec<Value>>>() else { continue };
        let columnas = &traida.columnas;
        let posicion = |c: &str| columnas.iter().position(|x| x.eq_ignore_ascii_case(c));
        let Some(i_clave) = posicion(d.clave) else { continue };
        let Some(id_nube) = nube.get(i_clave).and_then(texto).map(str::to_owned) else { continue };

        let locales = las_que_chocan(conn, d, columnas, &nube, &id_nube).await?;
        if locales.is_empty() {
            continue;
        }
        // Sólo lo que esta Main escribió y la nube no tiene (ver el encabezado).
        if locales.iter().any(|l| canonica(d.tabla, l).is_none_or(|k| !subida.claves.contains(&k))) {
            tracing::warn!(
                target: "tpv::sync",
                tabla = d.tabla,
                "una ficha de la nube choca con una de aquí que no está apartada de la subida: no se funden (SYN-INC-07)"
            );
            continue;
        }
        let Some(de_aqui) = filas_de_aqui(conn, d, columnas, &locales).await? else { continue };
        // Un valor que no se sabe replicar (un blob, un número no finito) llegaría arriba como `NULL`
        // (`valor_a_json`): la ficha de aquí se borraría con él dentro. No se funde.
        if de_aqui.iter().flatten().any(no_se_replica) {
            tracing::warn!(
                target: "tpv::sync",
                tabla = d.tabla,
                "la ficha de aquí tiene un valor que no se puede replicar: no se funde (SYN-INC-07)"
            );
            continue;
        }

        let sentencias = sentencias_de_la_fusion(conn, d, columnas, &nube, &id_nube, &locales, &de_aqui).await?;
        w.transaccion(async {
            for s in &sentencias {
                let args = s
                    .args
                    .iter()
                    .map(crate::convergencia::celda)
                    .collect::<Option<Vec<Value>>>()
                    .ok_or_else(|| tpv_application::error::AppError::internal("valor_binario"))?;
                w.execute(&s.sql, args).await.map_err(db_err)?;
            }
            retirar_lo_apartado(conn, d, &locales).await
        })
        .await?;
        fundidas += locales.len();
        tracing::info!(
            target: "tpv::sync",
            tabla = d.tabla,
            fundidas = locales.len(),
            "fichas de aquí fundidas en la de la nube por una clave natural repetida (SYN-INC-07)"
        );
    }
    Ok(fundidas)
}

/// Las fichas de aquí, otras que la de la nube, que tienen alguno de sus valores únicos.
async fn las_que_chocan(conn: &Connection, d: &Descripcion, columnas: &[String], nube: &[Value], id_nube: &str) -> AppResult<Vec<String>> {
    let mut salida: Vec<String> = Vec::new();
    for u in d.unicos {
        let Some(i) = columnas.iter().position(|x| x.eq_ignore_ascii_case(u.columna)) else { continue };
        let Some(valor) = nube.get(i).filter(|v| !vacio(v)) else { continue };
        let igual = match u.sin_mayusculas {
            true => format!("lower({}) = lower(?2)", cita(u.columna)),
            false => format!("{} = ?2", cita(u.columna)),
        };
        let mut filas = conn
            .query(
                &format!("SELECT {k} FROM {t} WHERE {k} <> ?1 AND {igual} ORDER BY {k};", k = cita(d.clave), t = cita(d.tabla)),
                vec![Value::Text(id_nube.to_owned()), valor.clone()],
            )
            .await
            .map_err(db_err)?;
        while let Some(f) = filas.next().await.map_err(db_err)? {
            if let Ok(Value::Text(id)) = f.get_value(0) {
                if !salida.contains(&id) {
                    salida.push(id);
                }
            }
        }
    }
    Ok(salida)
}

/// Las fichas de aquí, con las columnas que ha traído la nube. `None` si alguna ya no está.
async fn filas_de_aqui(conn: &Connection, d: &Descripcion, columnas: &[String], ids: &[String]) -> AppResult<Option<Vec<Vec<Value>>>> {
    let lista = columnas.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
    let mut salida = Vec::with_capacity(ids.len());
    for id in ids {
        let mut filas = conn
            .query(&format!("SELECT {lista} FROM {} WHERE {} = ?1;", cita(d.tabla), cita(d.clave)), vec![Value::Text(id.clone())])
            .await
            .map_err(db_err)?;
        let Some(f) = filas.next().await.map_err(db_err)? else { return Ok(None) };
        salida.push((0..columnas.len()).map(|i| f.get_value(i as i32).unwrap_or(Value::Null)).collect());
    }
    Ok(Some(salida))
}

/// Lo que funde `locales` en la de la nube, en su orden (ver el encabezado).
async fn sentencias_de_la_fusion(
    conn: &Connection,
    d: &Descripcion,
    columnas: &[String],
    nube: &[Value],
    id_nube: &str,
    locales: &[String],
    de_aqui: &[Vec<Value>],
) -> AppResult<Vec<SqlStatement>> {
    let json = crate::sync_reparacion::valor_a_json;
    let es = |c: &str, lista: &[&str]| lista.iter().any(|x| x.eq_ignore_ascii_case(c));
    let mut sentencias = Vec::new();

    // 1. Los valores únicos de las de aquí, fuera.
    let libres = d.unicos.iter().map(|u| format!("{} = NULL", cita(u.columna))).collect::<Vec<_>>().join(", ");
    for l in locales {
        sentencias.push(SqlStatement {
            sql: format!("UPDATE {} SET {libres} WHERE {} = ?1;", cita(d.tabla), cita(d.clave)),
            args: vec![Json::String(l.clone())],
        });
    }

    // 2. La de la nube, con sus huecos rellenos con lo de las de aquí (la primera que lo tenga).
    //    Son dos sentencias, porque aquí y arriba hay que hacer cosas distintas con la misma:
    //
    //    - El `INSERT` la escribe como la trajo la foto, con los huecos ya rellenos. Sólo escribe donde
    //      está todavía la de aquí (`WHERE EXISTS`): aquí, que es donde falta (su alta está en
    //      cuarentena). Arriba la de aquí no está (la nube no la tiene: ver [`fundir`]), así que no
    //      escribe nada y no resucita una ficha que una Handy haya borrado después de la foto.
    //    - El `UPDATE` rellena sólo los huecos, y sólo lleva lo de la de aquí: lo que la de la nube ya
    //      tenía no viaja, así que arriba no vuelve al valor de la foto un campo que una Handy haya
    //      cambiado o vaciado entretanto. Si la ficha ya no está, no toca nada.
    let mut huecos: Vec<(usize, Json)> = Vec::new();
    let valores: Vec<Json> = columnas
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let arriba = &nube[i];
            if c.eq_ignore_ascii_case(d.clave) || es(c, d.derivadas) || !vacio(arriba) {
                return json(arriba);
            }
            match de_aqui.iter().map(|f| &f[i]).find(|v| !vacio(v)) {
                Some(v) => {
                    huecos.push((i, json(v)));
                    json(v)
                }
                None => json(arriba),
            }
        })
        .collect();
    let lista = columnas.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
    let marcas = (1..=columnas.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let mut args = valores;
    args.push(Json::String(locales[0].clone()));
    sentencias.push(SqlStatement {
        sql: format!(
            "INSERT INTO {t} ({lista}) SELECT {marcas} WHERE EXISTS (SELECT 1 FROM {t} WHERE {k} = ?{n}) ON CONFLICT({k}) DO NOTHING;",
            t = cita(d.tabla),
            k = cita(d.clave),
            n = columnas.len() + 1
        ),
        args,
    });
    if !huecos.is_empty() {
        let rellenar = huecos
            .iter()
            .enumerate()
            .map(|(j, (i, _))| format!("{c} = COALESCE(NULLIF({c}, ''), ?{n})", c = cita(&columnas[*i]), n = j + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let mut args: Vec<Json> = huecos.into_iter().map(|(_, v)| v).collect();
        args.push(Json::String(id_nube.to_owned()));
        sentencias.push(SqlStatement {
            sql: format!("UPDATE {} SET {rellenar} WHERE {} = ?{};", cita(d.tabla), cita(d.clave), args.len()),
            args,
        });
    }

    // 3. Lo que apunta a las de aquí, a la de la nube.
    let foraneas = crate::sync_reparacion::foraneas(conn).await.map_err(db_err)?;
    for l in locales {
        for fk in foraneas.iter().filter(|fk| fk.padre == d.tabla && fk.hasta.eq_ignore_ascii_case(d.clave)) {
            sentencias.push(SqlStatement {
                sql: format!("UPDATE {h} SET {c} = ?1 WHERE {c} = ?2;", h = cita(&fk.hija), c = cita(&fk.desde)),
                args: vec![Json::String(id_nube.to_owned()), Json::String(l.clone())],
            });
        }
    }

    // 4. Los agregados, re-derivados.
    for sql in d.rederivar {
        sentencias.push(SqlStatement { sql: (*sql).to_owned(), args: vec![Json::String(id_nube.to_owned())] });
    }

    // 5. Las de aquí, fuera.
    for l in locales {
        sentencias.push(SqlStatement {
            sql: format!("DELETE FROM {} WHERE {} = ?1;", cita(d.tabla), cita(d.clave)),
            args: vec![Json::String(l.clone())],
        });
    }
    Ok(sentencias)
}

/// Lo apartado de la subida que nombra alguna de las fichas fundidas (`ids`). Lo que sólo escribía
/// esas fichas se borra: ya no existen, y su aviso no se apagaría nunca (ningún contraste subirá una
/// fila que no está). Lo demás —una reserva o un cobro que apuntaban a la ficha y la nube rechazó por
/// su foránea— se repara por estado, como está ahora (apuntando a la de la nube), en una operación
/// que lo enlaza en `Repara_Op_Id` y lo retira cuando sube (SYNC-26, SYNC-31). Va por `raw()`: es el
/// andamiaje del outbox.
///
/// Esa operación se encola antes que la de la fusión, que se escribe al confirmar: arriba entran
/// antes la reserva y el cobro (la ficha de la nube ya está allí) y después la fusión, que re-deriva
/// el gasto con el cobro ya dentro.
pub(crate) async fn retirar_lo_apartado(conn: &Connection, d: &Descripcion, ids: &[String]) -> AppResult<()> {
    let lista = Value::Text(serde_json::to_string(ids).map_err(db_err)?);
    let mut filas = conn
        .query(
            "SELECT Op_Id, Statements_Json FROM _Sync_Outbox o WHERE Cuarentena = 1 \
               AND EXISTS (SELECT 1 FROM json_each(?1) j WHERE instr(o.Statements_Json, json_quote(j.value)) > 0) \
             ORDER BY Seq;",
            vec![lista],
        )
        .await
        .map_err(db_err)?;
    let mut apartadas: Vec<(String, Vec<SqlStatement>)> = Vec::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        let Ok(Value::Text(op)) = f.get_value(0) else { continue };
        let sentencias = match f.get_value(1) {
            Ok(Value::Text(t)) => serde_json::from_str(&t).unwrap_or_default(),
            _ => Vec::new(),
        };
        apartadas.push((op, sentencias));
    }
    drop(filas);
    if apartadas.is_empty() {
        return Ok(());
    }

    let mut claves: HashMap<String, Vec<String>> = HashMap::new();
    for (_, sentencias) in &apartadas {
        for s in sentencias {
            for palabra in s.sql.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
                if !palabra.is_empty() && !claves.contains_key(palabra) {
                    let pks = crate::sync_reparacion::claves_primarias(conn, palabra).await.unwrap_or_default();
                    claves.insert(palabra.to_owned(), pks);
                }
            }
        }
    }
    let de_la_ficha = |f: &crate::sync_reparacion::FilaAfectada| {
        f.tabla == d.tabla && matches!(f.clave.as_slice(), [(c, v)] if c.eq_ignore_ascii_case(d.clave) && ids.contains(v))
    };
    let mut solo_la_ficha: Vec<&str> = Vec::new();
    let mut resto: Vec<&str> = Vec::new();
    let mut sentencias_del_resto: Vec<SqlStatement> = Vec::new();
    for (op, sentencias) in &apartadas {
        let a = crate::sync_reparacion::analizar(sentencias, &|t: &str| claves.get(t).cloned().unwrap_or_default());
        if !a.incierto && a.borrados.is_empty() && a.filas.iter().all(de_la_ficha) {
            solo_la_ficha.push(op);
        } else {
            resto.push(op);
            sentencias_del_resto.extend(sentencias.iter().cloned());
        }
    }

    if !solo_la_ficha.is_empty() {
        conn.execute(
            "DELETE FROM _Sync_Outbox WHERE Cuarentena = 1 AND Op_Id IN (SELECT value FROM json_each(?1));",
            vec![Value::Text(serde_json::to_string(&solo_la_ficha).map_err(db_err)?)],
        )
        .await
        .map_err(db_err)?;
    }
    if !resto.is_empty() {
        let reparacion = crate::sync::reparacion_de(conn, &sentencias_del_resto, "fusión (SYN-INC-07)").await?;
        // Sin nada que mandar (lo que tocaban ya no está aquí), se quedan como cualquier apartada
        // cuya reparación no tiene filas: las retira un contraste que suba lo suyo, o la purga.
        if !reparacion.is_empty() {
            let repara = serde_json::to_string(&resto).map_err(db_err)?;
            crate::contraste::encolar_operacion(conn, &reparacion, Some(&repara)).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::db::Db;

    #[test]
    fn vacio_es_lo_mismo_que_el_hueco_de_la_sentencia_y_del_indice() {
        // La sentencia replicada rellena con `NULLIF(col, '')`, y el índice de Clientes sólo deja
        // fuera `NULL` y `''`: un texto de espacios no es un hueco para ellos, ni aquí.
        assert!(vacio(&Value::Null));
        assert!(vacio(&Value::Text(String::new())));
        assert!(!vacio(&Value::Text("   ".into())));
        assert!(!vacio(&Value::Text("\t".into())));
        assert!(!vacio(&Value::Integer(0)));
    }

    async fn base(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(&format!("clave-natural-{nombre}"));
        Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap()
    }

    #[tokio::test]
    async fn los_unicos_de_cada_descripcion_son_todos_los_indices_unicos_de_su_tabla() {
        // La fusión sólo quita a la ficha de aquí los valores de `unicos`: si el esquema gana otro
        // índice único en Clientes o en Proveedores y no se añade aquí, la de la nube no cabría y la
        // fusión no entraría nunca. Y `sin_mayusculas` tiene que decir lo mismo que el índice.
        let db = base("unicos").await;
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for d in DESCRIPCIONES {
            let todos = conn
                .query(
                    "SELECT COUNT(*) FROM pragma_index_list(?1) WHERE \"unique\" = 1 AND origin <> 'pk';",
                    vec![Value::Text(d.tabla.to_owned())],
                )
                .await
                .unwrap()
                .next()
                .await
                .unwrap()
                .and_then(|f| f.get_value(0).ok());
            assert_eq!(todos, Some(Value::Integer(d.unicos.len() as i64)), "{}: índices únicos del esquema", d.tabla);

            let mut del_esquema: Vec<String> = crate::aparcar::indices_unicos(conn, d.tabla)
                .await
                .unwrap()
                .into_iter()
                .map(|i| {
                    let mut c = i.decide;
                    c.dedup();
                    c.join("+")
                })
                .collect();
            del_esquema.sort();
            let mut descritos: Vec<String> = d.unicos.iter().map(|u| u.columna.to_owned()).collect();
            descritos.sort();
            assert_eq!(descritos, del_esquema, "{}", d.tabla);

            let textos = conn
                .query(
                    "SELECT lower(group_concat(sql, ' ')) FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL;",
                    vec![Value::Text(d.tabla.to_owned())],
                )
                .await
                .unwrap()
                .next()
                .await
                .unwrap()
                .and_then(|f| f.get_value(0).ok());
            let textos = match textos {
                Some(Value::Text(t)) => t,
                _ => String::new(),
            };
            for u in d.unicos {
                let con_lower = textos.contains(&format!("lower({})", u.columna.to_lowercase()));
                assert_eq!(u.sin_mayusculas, con_lower, "{}.{}: sin_mayusculas", d.tabla, u.columna);
            }
        }
    }

    #[tokio::test]
    async fn se_mueven_todas_las_foraneas_de_cada_tabla_y_ninguna_choca_con_un_indice_unico() {
        // Las foráneas se leen del esquema: si alguien añade una tabla que apunta a Clientes o a
        // Proveedores, la fusión la mueve sin tocar nada aquí. Esto fija las de hoy (las de 0001) y
        // que mover una no puede chocar con un índice único de la hija.
        let db = base("foraneas").await;
        let w = db.write().await;
        let conn: &Connection = w.raw();
        let foraneas = crate::sync_reparacion::foraneas(conn).await.unwrap();
        let de = |t: &str| {
            let mut v: Vec<String> = foraneas.iter().filter(|f| f.padre == t).map(|f| format!("{}.{}", f.hija, f.desde)).collect();
            v.sort();
            v
        };
        assert_eq!(de("Clientes"), vec!["Comandas.ID_Cliente", "Reservas.ID_Cliente"]);
        assert_eq!(
            de("Proveedores"),
            vec![
                "Cuentas_Gastos.ID_Proveedor",
                "Lotes_Producto.ID_Proveedor",
                "Pedidos_Proveedor.ID_Proveedor",
                "Productos.ID_Proveedor"
            ]
        );
        for d in DESCRIPCIONES {
            for f in foraneas.iter().filter(|f| f.padre == d.tabla) {
                for i in crate::aparcar::indices_unicos(conn, &f.hija).await.unwrap() {
                    assert!(
                        !i.decide.iter().any(|c| c.eq_ignore_ascii_case(&f.desde)),
                        "{}.{} está en un índice único: moverla podría chocar",
                        f.hija,
                        f.desde
                    );
                }
            }
        }
    }
}
