//! SYNC-29 · El orden de la nube manda: lo que su orden dejó de otra forma aquí se trae de ella.
//!
//! La Main aplica lo que baja de la nube aunque tenga escrituras suyas sin confirmar. Si una Handy
//! toca una fila en los segundos que van de que la Main la escribe a que la sube, en la nube la
//! escritura de la Main va **detrás** del cambio de la Handy (llegó después) y aquí fue **delante**
//! (se aplicó el cambio encima). Las dos copias quedan distintas: la nube con lo de la Main encima de
//! lo de la Handy, la Main con lo de la Handy encima de lo suyo. El orden que vale es el de la nube,
//! que es el que ven las Handy y la agenda de la web, y la Main se ajusta a él en segundos:
//!
//! 1. **Marcar** ([`Carrera`], [`marcar`]). Al aplicar un cambio de la nube, si esta Main tiene
//!    escrituras suyas que la nube todavía no ha ordenado —por subir o sin acuse en el outbox, o
//!    confirmadas con un `Seq` posterior al del cambio y cuyo eco aún no ha vuelto— en alguna de las
//!    tablas que el cambio escribe, se apuntan las filas que toca el cambio (las de esas tablas) en
//!    `_Sync_Por_Contrastar`, en la misma transacción que lo aplica. Qué filas toca lo dice el
//!    simulacro de `filas_tocadas` (el de las cuarentenas de bajada), con la base de justo antes.
//! 2. **Traer** ([`converger`]). Con todo lo de aquí subido (nada pendiente en el outbox) y la bajada
//!    al día —el final del log de la nube (`hasta_seq` de `/v1/sync/verificar/por-clave`) es el
//!    checkpoint de esta Main—, se piden esas filas a la nube por su clave y se escriben aquí como
//!    están, por `raw()`: lo que está arriba con `INSERT … ON CONFLICT(clave) DO UPDATE`, y lo que
//!    arriba ya no está se borra aquí. Con el escritor cogido se vuelve a mirar que el checkpoint siga
//!    siendo ése y que no haya nada por subir; si no, la vuelta se deja sin escribir nada
//!    ([`Convergencia::Aplazada`]) y el motor la repite más tarde. Así lo que se trae ya lleva todo lo
//!    que esta Main ha aplicado, y nada que no haya aplicado: un cambio posterior no se le aplicaría
//!    encima otra vez.
//!
//! Lo que no hace nunca: escribir en la nube, tocar el outbox, la bajada o el checkpoint. Y lo que no
//! trae: lo fiscal (lo emite esta Main, y la Handy no lo escribe), una fila de algo apartado de la
//! subida (lo que esta Main escribió y la nube no aceptó, que la reparación sube; traer la de la nube
//! lo desharía aquí), ni un borrado cuyas cascadas lleguen a algo apartado o se lleven un cobro. Esas
//! marcas se retiran con su motivo en el registro, y lo que quede distinto lo verá el contraste.
//!
//! Lo que no se ve: lo que una escritura de aquí lee de una fila que el cambio tocó para escribir
//! otra (un `INSERT … SELECT` sobre ella), y un cambio cuyas filas el simulacro no sabe decir.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value as Json;
use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::sync::{Convergencia, PaginasDelContraste};
use tpv_contracts::sync::{SqlStatement, SyncChange};

use crate::consultas::db_err;
use crate::cuarentenas_bajada::{self as bajada, Traida};
use crate::db::{Db, Writer};
use crate::ejecutor::{Connection, Value};
use crate::filas_tocadas::{self as tocadas, canonica_de, cita, FilaTocada, Tocadas};
use crate::util::now_ms;

/// Lo fiscal lo emite sólo esta Main (la Handy lo tiene vetado, `lib/hub.ts::TABLAS_SOLO_MAIN`): no se
/// trae nunca de la nube.
const FISCALES: [&str; 2] = ["Registros_Facturacion", "Serie_Facturacion"];

/// Lo más que se apunta. Con más, lo que llegue no se marca (y lo dice): sería que esta Main lleva
/// mucho sin poder traer nada, y lo que quede distinto lo verá el contraste.
pub(crate) const MAX_MARCAS: i64 = 10_000;

/// Lo más que se trae en una vuelta. La nube lo contesta en una petición por tabla (`por-clave`
/// admite 500 claves).
pub(crate) const MARCAS_POR_VUELTA: usize = 500;

/// Las veces que se intenta escribir aquí una fila que no entra (una clave foránea, un `UNIQUE`)
/// antes de dejarla.
const MAX_INTENTOS: i64 = 5;

/// Lo más que se lee del outbox para saber en qué tablas está escribiendo esta Main. Con más, se da
/// por hecho que en todas.
const MAX_OPS_LEIDAS: i64 = 500;

fn no_se_trae(tabla: &str) -> bool {
    crate::sync::no_es_tabla_de_negocio(tabla) || FISCALES.iter().any(|f| f.eq_ignore_ascii_case(tabla))
}

/* ===== Marcar ===== */

/// Lo que esta Main ha escrito y la nube todavía no ha ordenado respecto de lo que baja, leído al
/// empezar una tanda de la bajada (con el escritor cogido: dentro de la tanda no entra ninguna
/// escritura de aquí).
pub(crate) struct Carrera {
    /// Lo que está en el outbox sin apartar (por subir o sin acuse), con las tablas en las que
    /// escribe cada operación.
    ops: Vec<(String, HashSet<String>)>,
    /// Alguna escribe donde no se sabe, o hay más de las que se leen: cuenta como todas.
    todas: bool,
    /// El mayor `Seq` de una operación propia que la nube ya confirmó y cuyo eco no ha vuelto: va
    /// detrás de todo cambio anterior a él, y ya no está en el outbox para saber dónde escribe.
    adelantada: i64,
}

/// Las tablas que escribe un cambio o una operación, y si alguna no se sabe (`*`).
fn tablas_que_escribe(sentencias: &[SqlStatement]) -> (HashSet<String>, bool) {
    let e = tocadas::estaticas(sentencias, &|_| Vec::new());
    (e.todas, e.tablas.contains("*"))
}

/// Lo que dice [`Carrera::alcance`] de un cambio.
pub(crate) enum Alcance {
    Tablas(HashSet<String>),
    Todas,
}

impl Alcance {
    fn incluye(&self, tabla: &str) -> bool {
        match self {
            Alcance::Todas => true,
            Alcance::Tablas(t) => t.contains(tabla),
        }
    }
}

impl Carrera {
    pub(crate) async fn leer(conn: &Connection) -> AppResult<Carrera> {
        let mut filas = conn
            .query(
                "SELECT Op_Id, Statements_Json FROM _Sync_Outbox WHERE Cuarentena = 0 ORDER BY Seq LIMIT ?1;",
                vec![Value::Integer(MAX_OPS_LEIDAS + 1)],
            )
            .await
            .map_err(db_err)?;
        let mut ops = Vec::new();
        let mut todas = false;
        while let Some(f) = filas.next().await.map_err(db_err)? {
            if ops.len() as i64 == MAX_OPS_LEIDAS {
                todas = true;
                break;
            }
            let (Ok(Value::Text(op)), Ok(Value::Text(json))) = (f.get_value(0), f.get_value(1)) else { continue };
            let sentencias: Vec<SqlStatement> = serde_json::from_str(&json).unwrap_or_default();
            let (tablas, alguna_no_se_sabe) = tablas_que_escribe(&sentencias);
            todas |= alguna_no_se_sabe;
            ops.push((op, tablas));
        }
        drop(filas);
        // Un anti-eco con un `Seq` por encima del checkpoint es de una operación propia: lo que baja
        // de los demás se apunta con su `Seq` al aplicarse, y la bajada va en orden.
        let mut filas = conn
            .query(
                "SELECT COALESCE(MAX(Seq), 0) FROM _Sync_Applied_Ops \
                  WHERE Seq > (SELECT Last_Seq FROM _Sync_State WHERE Id = 1);",
                (),
            )
            .await
            .map_err(db_err)?;
        let adelantada = match filas.next().await.map_err(db_err)? {
            Some(f) => match f.get_value(0).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 0,
            },
            None => 0,
        };
        Ok(Carrera { ops, todas, adelantada })
    }

    /// Las tablas de `ch` en las que lo de aquí puede ir delante aquí y detrás en la nube. `None`
    /// si ninguna, o si `ch` es el eco de algo de aquí.
    pub(crate) fn alcance(&self, ch: &SyncChange) -> Option<Alcance> {
        if self.ops.iter().any(|(op, _)| *op == ch.op_id) {
            return None;
        }
        if self.adelantada > ch.seq || (self.todas && !self.ops.is_empty()) {
            return Some(Alcance::Todas);
        }
        let (del_cambio, alguna_no_se_sabe) = tablas_que_escribe(&ch.statements);
        let nuestras: HashSet<String> = self.ops.iter().flat_map(|(_, t)| t.iter().cloned()).collect();
        let cruzan: HashSet<String> = match alguna_no_se_sabe {
            true => nuestras,
            false => del_cambio.into_iter().filter(|t| nuestras.contains(t)).collect(),
        };
        (!cruzan.is_empty()).then_some(Alcance::Tablas(cruzan))
    }

    /// El eco de una operación de aquí ya ha pasado: lo que baja después va también después en la
    /// nube.
    pub(crate) fn ya_ordenada(&mut self, op_id: &str) {
        self.ops.retain(|(op, _)| op != op_id);
    }
}

/// Las filas de `ch` que hay que apuntar: las que toca, de las tablas de `alcance` y que se traen.
/// Se miran con la base de justo antes del cambio, en un simulacro (sin otra transacción abierta).
pub(crate) async fn filas_a_marcar(conn: &Connection, ch: &SyncChange, alcance: &Alcance) -> Vec<FilaTocada> {
    let t: Tocadas = tocadas::de_un_cambio(conn, &ch.statements).await;
    if t.incierto {
        tracing::warn!(
            target: "tpv::sync",
            op_id = %ch.op_id,
            seq = ch.seq,
            "SYNC-29: un cambio de la nube toca filas que esta Main también escribe y no se sabe cuáles; no se traen"
        );
        return Vec::new();
    }
    t.filas.into_iter().filter(|f| alcance.incluye(&f.tabla) && !no_se_trae(&f.tabla)).collect()
}

/// Apunta `filas`, que acaba de tocar el cambio `seq`. Va dentro de la transacción que lo aplica.
pub(crate) async fn marcar(conn: &Connection, filas: &[FilaTocada], seq: i64) -> AppResult<()> {
    if filas.is_empty() {
        return Ok(());
    }
    let lista: Vec<Json> = filas
        .iter()
        .map(|f| serde_json::json!({ "t": f.tabla, "k": serde_json::to_string(&f.clave).unwrap_or_default() }))
        .collect();
    let n = conn
        .execute(
            "INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms) \
             SELECT json_extract(value, '$.t'), json_extract(value, '$.k'), ?2, ?3 FROM json_each(?1) \
              WHERE (SELECT COUNT(*) FROM _Sync_Por_Contrastar) < ?4 \
             ON CONFLICT(Tabla, Clave_Json) DO UPDATE SET Seq = excluded.Seq, Intentos = 0;",
            vec![
                Value::Text(serde_json::to_string(&lista).map_err(db_err)?),
                Value::Integer(seq),
                Value::Integer(now_ms()),
                Value::Integer(MAX_MARCAS),
            ],
        )
        .await
        .map_err(db_err)?;
    if n == 0 {
        tracing::warn!(target: "tpv::sync", seq, filas = filas.len(), "SYNC-29: no caben más filas por traer de la nube; éstas no se apuntan");
    }
    Ok(())
}

/// SYNC-29 · Las filas apuntadas, en su forma canónica (`filas_tocadas::canonica_de`), hasta
/// [`MAX_MARCAS`]: las que el contraste no sube, porque las trae la convergencia.
pub(crate) async fn marcadas(conn: &Connection) -> AppResult<HashSet<String>> {
    Ok(leer_marcas(conn, MAX_MARCAS).await?.0.into_iter().filter_map(|m| canonica_de(&m.fila)).collect())
}

/* ===== Traer ===== */

/// Una fila apuntada.
struct Marca {
    fila: FilaTocada,
    /// Como está guardada (`Clave_Json`), para retirarla.
    clave_json: String,
}

/// Las marcas, las más antiguas primero, hasta `cuantas`, y si hay más.
async fn leer_marcas(conn: &Connection, cuantas: i64) -> AppResult<(Vec<Marca>, bool)> {
    let mut filas = conn
        .query(
            "SELECT Tabla, Clave_Json FROM _Sync_Por_Contrastar ORDER BY Desde_Ms, Tabla, Clave_Json LIMIT ?1;",
            vec![Value::Integer(cuantas + 1)],
        )
        .await
        .map_err(db_err)?;
    let mut salida = Vec::new();
    let mut mas = false;
    while let Some(f) = filas.next().await.map_err(db_err)? {
        if salida.len() as i64 == cuantas {
            mas = true;
            break;
        }
        let (Ok(Value::Text(tabla)), Ok(Value::Text(clave_json))) = (f.get_value(0), f.get_value(1)) else { continue };
        let clave: Vec<Json> = serde_json::from_str(&clave_json).unwrap_or_default();
        salida.push(Marca { fila: FilaTocada { tabla, clave, borrada: false }, clave_json });
    }
    Ok((salida, mas))
}

/// Lo que se hace aquí con una fila apuntada.
enum Accion {
    /// Arriba está así y aquí no: se escribe como está.
    Escribir(Vec<Json>),
    /// Arriba ya no está y aquí sí: se borra.
    Borrar,
    /// Ya está igual.
    Nada,
}

fn celda(v: &Json) -> Option<Value> {
    match v {
        Json::Null => Some(Value::Null),
        Json::Bool(b) => Some(Value::Integer(i64::from(*b))),
        Json::Number(n) => n.as_i64().map(Value::Integer).or_else(|| n.as_f64().map(Value::Real)),
        Json::String(s) => Some(Value::Text(s.clone())),
        _ => None,
    }
}

fn donde(clave: &[String]) -> String {
    clave.iter().enumerate().map(|(i, c)| format!("{} = ?{}", cita(c), i + 1)).collect::<Vec<_>>().join(" AND ")
}

async fn existe(conn: &Connection, tabla: &str, clave: &[String], valores: &[Value]) -> AppResult<bool> {
    let mut filas = conn
        .query(&format!("SELECT 1 FROM {} WHERE {} LIMIT 1;", cita(tabla), donde(clave)), valores.to_vec())
        .await
        .map_err(db_err)?;
    Ok(filas.next().await.map_err(db_err)?.is_some())
}

async fn cobros(conn: &Connection) -> AppResult<i64> {
    let mut filas = conn.query("SELECT COUNT(*) FROM Pagos;", ()).await.map_err(db_err)?;
    Ok(match filas.next().await.map_err(db_err)? {
        Some(f) => match f.get_value(0).map_err(db_err)? {
            Value::Integer(n) => n,
            _ => 0,
        },
        None => 0,
    })
}

/// Una fila apuntada con lo que hay que hacer con ella.
struct Plan<'a> {
    marca: &'a Marca,
    accion: Accion,
    /// La sentencia que la deja aquí como arriba (`None` con [`Accion::Nada`]).
    sentencia: Option<SqlStatement>,
}

/// Ejecuta lo de unos planes en orden: primero los borrados, después lo que se escribe.
async fn ejecutar(conn: &Connection, planes: &[&Plan<'_>]) -> AppResult<()> {
    let borrados = planes.iter().filter(|p| matches!(p.accion, Accion::Borrar)).count();
    // Lo cobrado no se borra desde la nube: si un borrado se llevara un cobro por sus cascadas, no
    // se hace nada (sus registros fiscales perderían el pago al que apuntan). Se cuenta antes y
    // después de los borrados, que van delante.
    let antes = if borrados > 0 { Some(cobros(conn).await?) } else { None };
    for (i, p) in planes.iter().enumerate() {
        let Some(s) = &p.sentencia else { continue };
        let args = s.args.iter().map(celda).collect::<Option<Vec<_>>>().ok_or_else(|| AppError::internal("valor_binario"))?;
        conn.execute(&s.sql, args).await.map_err(db_err)?;
        if i + 1 == borrados {
            if let Some(antes) = antes.filter(|n| *n > 0) {
                if cobros(conn).await? != antes {
                    return Err(AppError::internal("se_llevaria_un_cobro"));
                }
            }
        }
    }
    Ok(())
}

async fn retirar(conn: &Connection, marcas: &[&Marca]) -> AppResult<()> {
    if marcas.is_empty() {
        return Ok(());
    }
    let lista: Vec<Json> = marcas.iter().map(|m| serde_json::json!({ "t": m.fila.tabla, "k": m.clave_json })).collect();
    conn.execute(
        "DELETE FROM _Sync_Por_Contrastar WHERE (Tabla, Clave_Json) IN \
           (SELECT json_extract(value, '$.t'), json_extract(value, '$.k') FROM json_each(?1));",
        vec![Value::Text(serde_json::to_string(&lista).map_err(db_err)?)],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Una fila que no ha entrado: un intento más, y al llegar a [`MAX_INTENTOS`], se deja.
async fn no_ha_entrado(conn: &Connection, m: &Marca, motivo: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE _Sync_Por_Contrastar SET Intentos = Intentos + 1 WHERE Tabla = ?1 AND Clave_Json = ?2;",
        vec![Value::Text(m.fila.tabla.clone()), Value::Text(m.clave_json.clone())],
    )
    .await
    .map_err(db_err)?;
    let n = conn
        .execute(
            "DELETE FROM _Sync_Por_Contrastar WHERE Tabla = ?1 AND Clave_Json = ?2 AND Intentos >= ?3;",
            vec![Value::Text(m.fila.tabla.clone()), Value::Text(m.clave_json.clone()), Value::Integer(MAX_INTENTOS)],
        )
        .await
        .map_err(db_err)?;
    tracing::warn!(
        target: "tpv::sync",
        tabla = %m.fila.tabla,
        motivo,
        dejada = n > 0,
        "SYNC-29: una fila de la nube no entra en esta base"
    );
    Ok(())
}

/// SYNC-29 · Una vuelta: trae de la nube hasta [`MARCAS_POR_VUELTA`] filas apuntadas y las escribe
/// aquí como están arriba. Ver el encabezado.
pub(crate) async fn converger(db: &Db, nube: &dyn PaginasDelContraste) -> AppResult<Convergencia> {
    let (marcas, quedan, marca) = {
        let r = db.read().await;
        let (marcas, quedan) = leer_marcas(r.conn(), MARCAS_POR_VUELTA as i64).await?;
        if marcas.is_empty() {
            return Ok(Convergencia::Nada);
        }
        (marcas, quedan, r.conn().foto(crate::contraste::leer_marca).await.map_err(db_err)?)
    };
    // Con algo por subir, la nube no tiene todavía lo de aquí.
    if marca.pendientes > 0 {
        return Ok(Convergencia::Aplazada);
    }

    // Lo que hay arriba, con la foto del final del log en el checkpoint de esta Main.
    let claves = bajada::claves_primarias(db).await?;
    let mut pedir: BTreeMap<&str, Vec<Vec<Json>>> = BTreeMap::new();
    for m in &marcas {
        pedir.entry(m.fila.tabla.as_str()).or_default().push(m.fila.clave.clone());
    }
    let mut arriba: HashMap<&str, Traida> = HashMap::new();
    for (tabla, pedidas) in &pedir {
        let clave = claves.get(*tabla).map(Vec::as_slice).unwrap_or_default();
        match bajada::traer(nube, tabla, pedidas, clave, marca.checkpoint).await {
            Ok(Some(t)) => {
                arriba.insert(tabla, t);
            }
            // La nube va por delante de esta Main (o se ha movido entre página y página).
            Ok(None) => return Ok(Convergencia::Aplazada),
            Err(e) => {
                tracing::warn!(target: "tpv::sync", codigo = ?e.code(), "SYNC-29: no se ha podido pedir a la nube lo que su orden dejó distinto");
                return Err(e);
            }
        }
    }

    // Con el escritor cogido: la base tiene que seguir donde estaba.
    let w = db.write().await;
    let conn: &Connection = w.raw();
    let ahora = conn.foto(crate::contraste::leer_marca).await.map_err(db_err)?;
    if ahora.checkpoint != marca.checkpoint || ahora.pendientes > 0 {
        return Ok(Convergencia::Aplazada);
    }
    let subida = bajada::lo_apartado_de_la_subida(db, &claves).await?;
    let cascadas = bajada::cascadas(db).await?;

    let mut columnas_de: HashMap<String, Vec<String>> = HashMap::new();
    let mut planes: Vec<Plan<'_>> = Vec::new();
    let mut dejadas: Vec<(&Marca, &str)> = Vec::new();
    for m in &marcas {
        let tabla = m.fila.tabla.as_str();
        let clave = claves.get(tabla).cloned().unwrap_or_default();
        let Some(traida) = arriba.get(tabla) else {
            dejadas.push((m, "la_nube_no_la_ha_traido"));
            continue;
        };
        if no_se_trae(tabla) {
            dejadas.push((m, "no_se_trae"));
            continue;
        }
        if traida.sin_buscar {
            dejadas.push((m, "la_nube_no_la_sabe_buscar"));
            continue;
        }
        let Some(valores_clave) = m.fila.clave.iter().map(celda).collect::<Option<Vec<_>>>().filter(|v| !clave.is_empty() && v.len() == clave.len()) else {
            dejadas.push((m, "la_clave_no_es_la_de_aqui"));
            continue;
        };
        let accion = match canonica_de(&m.fila).and_then(|k| traida.filas.get(&k)) {
            Some(fila) => {
                if !columnas_de.contains_key(tabla) {
                    columnas_de.insert(tabla.to_string(), bajada::columnas_locales(conn, tabla).await?);
                }
                if traida.columnas.iter().any(|c| !columnas_de[tabla].iter().any(|l| l.eq_ignore_ascii_case(c))) {
                    dejadas.push((m, "columnas_desconocidas"));
                    continue;
                }
                match crate::sync_reparacion::fila_difiere(conn, tabla, &traida.columnas, fila, &clave).await.map_err(db_err)? {
                    Some(false) => Accion::Nada,
                    _ => Accion::Escribir(fila.clone()),
                }
            }
            None if existe(conn, tabla, &clave, &valores_clave).await? => Accion::Borrar,
            None => Accion::Nada,
        };
        let sentencia = match &accion {
            Accion::Nada => None,
            Accion::Escribir(fila) => Some(SqlStatement {
                sql: bajada::escribir_como_esta(tabla, &traida.columnas, &clave),
                args: fila.clone(),
            }),
            Accion::Borrar => Some(SqlStatement {
                sql: format!("DELETE FROM {} WHERE {};", cita(tabla), donde(&clave)),
                args: m.fila.clave.clone(),
            }),
        };
        // Lo que esta Main escribió y la nube no aceptó se queda como está aquí: lo sube su
        // reparación, y traer lo de la nube lo desharía.
        if sentencia.is_some() {
            let t = Tocadas {
                tablas: vec![tabla.to_string()],
                filas: vec![FilaTocada { borrada: matches!(accion, Accion::Borrar), ..m.fila.clone() }],
                incierto: false,
                por_filtro: Vec::new(),
                dudosa: false,
            };
            if bajada::choca_con_la_subida(&t, &subida, &cascadas) {
                dejadas.push((m, "choca_con_lo_apartado_de_la_subida"));
                continue;
            }
        }
        planes.push(Plan { marca: m, accion, sentencia });
    }

    // Lo que se borra, hijas primero; lo que se escribe, padres primero.
    let foraneas = crate::sync_reparacion::foraneas(conn).await.map_err(db_err)?;
    let mut padres: HashMap<String, HashSet<String>> = HashMap::new();
    for f in &foraneas {
        padres.entry(f.hija.clone()).or_default().insert(f.padre.clone());
    }
    let nombres: Vec<String> = planes.iter().map(|p| p.marca.fila.tabla.clone()).collect::<HashSet<_>>().into_iter().collect();
    let orden: Vec<String> = crate::contraste::ordenar_padres_primero(&nombres, &padres).into_iter().map(|(t, _)| t).collect();
    let posicion = |t: &str| orden.iter().position(|x| x == t).unwrap_or(usize::MAX);
    let mut borrar: Vec<&Plan<'_>> = planes.iter().filter(|p| matches!(p.accion, Accion::Borrar)).collect();
    borrar.sort_by_key(|p| std::cmp::Reverse(posicion(&p.marca.fila.tabla)));
    let mut escribir: Vec<&Plan<'_>> = planes.iter().filter(|p| matches!(p.accion, Accion::Escribir(_))).collect();
    escribir.sort_by_key(|p| posicion(&p.marca.fila.tabla));
    let en_orden: Vec<&Plan<'_>> = borrar.into_iter().chain(escribir).collect();
    let sentencias: Vec<&SqlStatement> = en_orden.iter().filter_map(|p| p.sentencia.as_ref()).collect();

    for (m, motivo) in &dejadas {
        tracing::warn!(target: "tpv::sync", tabla = %m.fila.tabla, motivo, "SYNC-29: una fila de la nube no se trae");
    }
    let todas: Vec<&Marca> = planes.iter().map(|p| p.marca).chain(dejadas.iter().map(|(m, _)| *m)).collect();
    let todo = conn
        .transaccion(async {
            ejecutar(conn, &en_orden).await?;
            retirar(conn, &todas).await
        })
        .await;
    let escritas: Vec<SqlStatement> = match todo {
        Ok(()) => sentencias.into_iter().cloned().collect(),
        // Alguna no entra: una a una, y la que no entra cuenta un intento.
        Err(_) => {
            let mut escritas = Vec::new();
            for p in &en_orden {
                let Some(s) = &p.sentencia else { continue };
                let una = conn
                    .transaccion(async {
                        ejecutar(conn, &[*p]).await?;
                        retirar(conn, &[p.marca]).await
                    })
                    .await;
                match una {
                    Ok(()) => escritas.push(s.clone()),
                    Err(e) => {
                        // Lo nuestro, tal cual; lo de SQLite, en su clase (sin los datos de la fila).
                        let texto = e.to_string();
                        let motivo = match texto.as_str() {
                            "se_llevaria_un_cobro" | "valor_binario" => texto,
                            _ => crate::cuarentenas_bajada::clase_de_error(Some(&texto)).unwrap_or_default(),
                        };
                        no_ha_entrado(conn, p.marca, &motivo).await?;
                    }
                }
            }
            let sin_nada: Vec<&Marca> =
                planes.iter().filter(|p| p.sentencia.is_none()).map(|p| p.marca).chain(dejadas.iter().map(|(m, _)| *m)).collect();
            retirar(conn, &sin_nada).await?;
            escritas
        }
    };
    if !escritas.is_empty() {
        tracing::info!(target: "tpv::sync", filas = escritas.len(), "SYNC-29: filas traídas de la nube, que las ordenó de otra forma");
    }
    Ok(Convergencia::Hecha { escritas, quedan })
}
