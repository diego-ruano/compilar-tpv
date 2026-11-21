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
//!    al día y sin detener —el final del log de la nube (`hasta_seq` de
//!    `/v1/sync/verificar/por-clave`) es lo que esta Main tiene de ella: su checkpoint o, por encima,
//!    lo suyo que la nube ya confirmó y cuyo eco no ha bajado—, se piden esas filas a la nube por su
//!    clave y se escriben aquí como están, por `raw()`: lo que está arriba con `INSERT … ON
//!    CONFLICT(clave) DO UPDATE`, y lo que arriba ya no está se borra aquí. Con el escritor cogido se
//!    vuelve a mirar que nada de eso haya cambiado; si no, la vuelta se deja sin escribir nada
//!    ([`Convergencia::Aplazada`]) y el motor la repite más tarde. Así lo que se trae ya lleva todo lo
//!    que esta Main ha aplicado, y nada que no haya aplicado: un cambio posterior no se le aplicaría
//!    encima otra vez. Lo de los demás que va por debajo de lo suyo ya confirmado ha bajado: la nube
//!    lo difunde antes que el acuse, y el socket entrega en orden.
//!
//! Lo que no hace nunca: escribir en la nube, tocar el outbox, la bajada o el checkpoint. Y lo que no
//! trae: lo fiscal (lo emite esta Main, y la Handy no lo escribe), una fila de algo apartado de la
//! subida (lo que esta Main escribió y la nube no aceptó, que la reparación sube; traer la de la nube
//! lo desharía aquí), ni un borrado cuyas cascadas lleguen a algo apartado o se lleven un cobro. Esas
//! marcas se retiran con su motivo en el registro, y lo que quede distinto lo verá el contraste.
//!
//! SYNC-37 · Dos filas que la nube dejó con un valor único intercambiado (los nombres de dos zonas)
//! se escriben aparcando antes ese valor (`aparcar.rs`), en la misma transacción. Una fila que aun así
//! no entra aquí (un `UNIQUE` con una fila que no se trae, una foránea) se queda apuntada y se vuelve
//! a intentar detrás de las que no han fallado; una vuelta que no consigue nada acaba `Aplazada`, y
//! el motor espera cada vez el doble, hasta un minuto. Retirarla se la dejaría al contraste, que
//! subiría lo de aquí y desharía el orden de la nube. SYNC-38: la que lleva una semana sin entrar se
//! avisa al administrador ([`atascadas`]), y traer el estado actual de la nube la resuelve.
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

/// Lo más que se trae en una vuelta, salvo lo que haga falta para no partir una tabla entre dos
/// (SYNC-37). La nube lo contesta en una petición por tabla (`por-clave` admite 500 claves).
pub(crate) const MARCAS_POR_VUELTA: usize = 500;

/// Las veces que se intenta traer una fila que esta Main no trae por decisión (un borrado que se
/// llevaría un cobro, un valor que no sabe escribir) antes de dejársela al contraste. Una que no
/// entra por esta base no se deja nunca (SYNC-37): a este intento se avisa de que sigue sin entrar.
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

/// El mayor `Seq` de una operación propia que la nube ya ha confirmado y cuyo eco no ha bajado; 0
/// si ninguna. Un anti-eco con un `Seq` por encima del checkpoint sólo puede ser de una propia: lo
/// que baja de los demás se apunta con su `Seq` al aplicarse, y la bajada va en orden.
async fn adelantada(conn: &Connection) -> AppResult<i64> {
    let mut filas = conn
        .query(
            "SELECT COALESCE(MAX(Seq), 0) FROM _Sync_Applied_Ops \
              WHERE Seq > (SELECT Last_Seq FROM _Sync_State WHERE Id = 1);",
            (),
        )
        .await
        .map_err(db_err)?;
    Ok(match filas.next().await.map_err(db_err)? {
        Some(f) => match f.get_value(0).map_err(db_err)? {
            Value::Integer(n) => n,
            _ => 0,
        },
        None => 0,
    })
}

/// AUD-18 · ¿Está la bajada detenida en un cambio que no ha entrado (un fallo sin cuarentena)?
async fn bajada_detenida(conn: &Connection) -> AppResult<bool> {
    let mut filas = conn
        .query("SELECT 1 FROM _Sync_Failed WHERE Quarantined = 0 LIMIT 1;", ())
        .await
        .map_err(db_err)?;
    Ok(filas.next().await.map_err(db_err)?.is_some())
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
        Ok(Carrera { ops, todas, adelantada: adelantada(conn).await? })
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
    let lista = Value::Text(serde_json::to_string(&lista).map_err(db_err)?);
    // Las que ya estaban apuntadas, con el cambio de ahora y sus intentos otra vez desde el principio;
    // las nuevas, en lo que quede de sitio. SYNC-38 (Codex): una que ya ha fallado se queda en uno, no
    // en cero: con lo que la vuelve a tocar no ha entrado todavía, y el aviso de lo que lleva una
    // semana sin entrar (`atascadas`) no puede apagarse por eso.
    let ya = conn
        .execute(
            "UPDATE _Sync_Por_Contrastar SET Seq = ?2, Intentos = MIN(Intentos, 1) \
              WHERE (Tabla, Clave_Json) IN (SELECT json_extract(value, '$.t'), json_extract(value, '$.k') FROM json_each(?1));",
            vec![lista.clone(), Value::Integer(seq)],
        )
        .await
        .map_err(db_err)?;
    let mut filas_ocupadas = conn.query("SELECT COUNT(*) FROM _Sync_Por_Contrastar;", ()).await.map_err(db_err)?;
    let ocupadas = match filas_ocupadas.next().await.map_err(db_err)?.map(|f| f.get_value(0)) {
        Some(Ok(Value::Integer(n))) => n,
        _ => MAX_MARCAS,
    };
    drop(filas_ocupadas);
    let nuevas = conn
        .execute(
            "INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms) \
             SELECT json_extract(value, '$.t'), json_extract(value, '$.k'), ?2, ?3 FROM json_each(?1) \
              WHERE NOT EXISTS (SELECT 1 FROM _Sync_Por_Contrastar m \
                                 WHERE m.Tabla = json_extract(value, '$.t') AND m.Clave_Json = json_extract(value, '$.k')) \
              LIMIT ?4;",
            vec![lista, Value::Integer(seq), Value::Integer(now_ms()), Value::Integer((MAX_MARCAS - ocupadas).max(0))],
        )
        .await
        .map_err(db_err)?;
    if (ya + nuevas) < filas.len() as u64 {
        tracing::warn!(target: "tpv::sync", seq, filas = filas.len(), "SYNC-29: no caben más filas por traer de la nube; algunas no se apuntan");
    }
    Ok(())
}

/// SYNC-38 · Cuántas filas apuntadas llevan sin traerse desde antes de `antes_de_ms` (desde que se
/// apuntaron: una que entra se borra, y si la vuelve a tocar un cambio se apunta de nuevo) y alguna
/// vez han fallado al intentarlo (`Intentos`: si la vuelve a tocar un cambio, [`marcar`] la deja en
/// uno y no en cero, así que una que ha fallado cuenta mientras siga apuntada).
/// Son las que no entran por algo de esta base que no se trae: una divergencia que nadie ha apuntado,
/// una cadena más larga de lo que se separa. No las retira nadie (el contraste no las toca, y
/// retirarlas dejaría subir lo de aquí encima del orden de la nube); las cuenta el panel de salud
/// (`SyncHealth::bajada_atascada`), con lo que se avisa al administrador, y las resuelve traer el
/// estado actual de la nube, que vacía lo apuntado. Una que nunca se ha podido intentar (el equipo
/// sin conexión) no cuenta.
pub(crate) async fn atascadas(conn: &Connection, antes_de_ms: i64) -> AppResult<i64> {
    let mut filas = conn
        .query(
            "SELECT COUNT(*) FROM _Sync_Por_Contrastar WHERE Intentos > 0 AND Desde_Ms <= ?1;",
            vec![Value::Integer(antes_de_ms)],
        )
        .await
        .map_err(db_err)?;
    Ok(match filas.next().await.map_err(db_err)?.map(|f| f.get_value(0)) {
        Some(Ok(Value::Integer(n))) => n,
        _ => 0,
    })
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
    /// Las vueltas en que no ha entrado aquí.
    intentos: i64,
}

/// Las marcas, las que menos veces han fallado primero (SYNC-37: una que no entra no deja sin
/// intentar a las demás) y, entre ellas, las más antiguas; hasta `cuantas`, y si hay más. Si hay
/// más, se añaden las demás de las tablas que ya salen (hasta [`MAX_MARCAS`]): dos filas que se han
/// cruzado un valor único sólo entran juntas, y partidas entre vueltas no se encontrarían nunca.
async fn leer_marcas(conn: &Connection, cuantas: i64) -> AppResult<(Vec<Marca>, bool)> {
    async fn leer(conn: &Connection, sql: &str, args: Vec<Value>) -> AppResult<Vec<Marca>> {
        let mut filas = conn.query(sql, args).await.map_err(db_err)?;
        let mut salida = Vec::new();
        while let Some(f) = filas.next().await.map_err(db_err)? {
            let (Ok(Value::Text(tabla)), Ok(Value::Text(clave_json))) = (f.get_value(0), f.get_value(1)) else { continue };
            let intentos = match f.get_value(2) {
                Ok(Value::Integer(n)) => n,
                _ => 0,
            };
            let clave: Vec<Json> = serde_json::from_str(&clave_json).unwrap_or_default();
            salida.push(Marca { fila: FilaTocada { tabla, clave, borrada: false }, clave_json, intentos });
        }
        Ok(salida)
    }
    let mut salida = leer(
        conn,
        "SELECT Tabla, Clave_Json, Intentos FROM _Sync_Por_Contrastar ORDER BY Intentos, Desde_Ms, Tabla, Clave_Json LIMIT ?1;",
        vec![Value::Integer(cuantas + 1)],
    )
    .await?;
    if salida.len() as i64 <= cuantas {
        return Ok((salida, false));
    }
    salida.truncate(cuantas as usize);
    let tablas: HashSet<&str> = salida.iter().map(|m| m.fila.tabla.as_str()).collect();
    let tablas = Value::Text(serde_json::to_string(&tablas).map_err(db_err)?);
    let vistas: HashSet<(String, String)> = salida.iter().map(|m| (m.fila.tabla.clone(), m.clave_json.clone())).collect();
    let resto = leer(
        conn,
        "SELECT Tabla, Clave_Json, Intentos FROM _Sync_Por_Contrastar WHERE Tabla IN (SELECT value FROM json_each(?1)) \
          ORDER BY Intentos, Desde_Ms, Tabla, Clave_Json LIMIT ?2;",
        vec![tablas, Value::Integer(MAX_MARCAS)],
    )
    .await?;
    salida.extend(resto.into_iter().filter(|m| !vistas.contains(&(m.fila.tabla.clone(), m.clave_json.clone()))));
    salida.truncate(MAX_MARCAS as usize);
    let mut total = conn.query("SELECT COUNT(*) FROM _Sync_Por_Contrastar;", ()).await.map_err(db_err)?;
    let quedan = match total.next().await.map_err(db_err)?.map(|f| f.get_value(0)) {
        Some(Ok(Value::Integer(n))) => n > salida.len() as i64,
        _ => true,
    };
    Ok((salida, quedan))
}

/// Lo que se hace aquí con una fila apuntada.
enum Accion {
    /// Arriba está así y aquí no: se escribe como está. `existe`: aquí está, con otra cosa.
    Escribir { fila: Vec<Json>, existe: bool },
    /// Arriba ya no está y aquí sí: se borra.
    Borrar,
    /// Ya está igual.
    Nada,
}

/// El valor de una celda que llega en JSON. Un blob (`{"blob": …}`) no se sabe escribir.
pub(crate) fn celda(v: &Json) -> Option<Value> {
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
    /// SYNC-37: la que aparca antes sus valores únicos, si ya está aquí y se escribe con otras de su
    /// tabla (`aparcar.rs`).
    aparcar: Option<SqlStatement>,
}

/// Ejecuta una sentencia con sus argumentos tal como llegan en JSON. Lo usa también la salida de las
/// cuarentenas de bajada (`cuarentenas_bajada.rs`).
pub(crate) async fn una(conn: &Connection, s: &SqlStatement) -> AppResult<()> {
    let args = s.args.iter().map(celda).collect::<Option<Vec<_>>>().ok_or_else(|| AppError::internal("valor_binario"))?;
    conn.execute(&s.sql, args).await.map_err(db_err)?;
    Ok(())
}

/// Ejecuta lo de unos planes, que llegan con los borrados delante: primero los borrados y después
/// lo que se escribe. Con `aparcando`, antes de escribir nada se aparcan los valores únicos de todo
/// lo que se escribe (SYNC-37): así dos que se intercambian uno entran juntas. Cada escritura pisa
/// lo aparcado de su fila.
async fn ejecutar(conn: &Connection, planes: &[&Plan<'_>], aparcando: bool) -> AppResult<()> {
    let borrados = planes.iter().filter(|p| matches!(p.accion, Accion::Borrar)).count();
    let (borrar, escribir) = planes.split_at(borrados);
    // Lo cobrado no se borra desde la nube: si un borrado se llevara un cobro por sus cascadas, no
    // se hace nada (sus registros fiscales perderían el pago al que apuntan). Se cuenta antes y
    // después de los borrados, que van delante.
    let antes = if borrados > 0 { Some(cobros(conn).await?) } else { None };
    for s in borrar.iter().filter_map(|p| p.sentencia.as_ref()) {
        una(conn, s).await?;
    }
    if let Some(antes) = antes.filter(|n| *n > 0) {
        if cobros(conn).await? != antes {
            return Err(AppError::internal("se_llevaria_un_cobro"));
        }
    }
    if aparcando {
        for s in escribir.iter().filter_map(|p| p.aparcar.as_ref()) {
            una(conn, s).await?;
        }
    }
    for s in escribir.iter().filter_map(|p| p.sentencia.as_ref()) {
        una(conn, s).await?;
    }
    Ok(())
}

/// Lo de unos planes en una transacción, con sus marcas retiradas en ella.
async fn intentar(conn: &Connection, planes: &[&Plan<'_>], aparcando: bool) -> AppResult<()> {
    conn.transaccion(async {
        ejecutar(conn, planes, aparcando).await?;
        retirar(conn, &planes.iter().map(|p| p.marca).collect::<Vec<_>>()).await
    })
    .await
}

/// Las veces que [`cruzadas`] aparta lo que choca y lo repite. Cada vez vuelve a escribir el grupo
/// entero con el escritor cogido, y cada una sólo aparta un eslabón de una cadena que acaba en algo
/// que no se trae: sin tope, una cadena larga costaría el cuadrado de su largo (Codex). Lo usa también
/// la salida de las cuarentenas de bajada para las que se intentan juntas (SYNC-38).
pub(crate) const MAX_SEPARACIONES: usize = 4;

/// SYNC-37 · Unas filas de una tabla que solas chocan con un índice único: pueden estar cruzadas
/// entre ellas, y alguna chocar además con algo de aquí que no se trae. Se aparcan todas y se
/// escribe cada una; la que choca no deshace a las demás (SQLite sólo deshace la sentencia), y la que
/// rompe una foránea se busca antes de confirmar (aplazada, sólo saltaría al confirmar, sin decir
/// cuál). Si alguna choca o rompe, se deshace todo y se repite sin ellas, hasta que entran las que
/// quedan, no queda nada que cruzar o se llega a [`MAX_SEPARACIONES`]. Devuelve las que han
/// entrado, con sus marcas retiradas.
async fn cruzadas<'p, 'a>(conn: &Connection, clave: &[String], mut grupo: Vec<&'p Plan<'a>>) -> Vec<&'p Plan<'a>> {
    for _ in 0..MAX_SEPARACIONES {
        if grupo.len() < 2 {
            break;
        }
        let mut chocan: Vec<usize> = Vec::new();
        let r = conn
            .transaccion(async {
                for s in grupo.iter().filter_map(|p| p.aparcar.as_ref()) {
                    una(conn, s).await?;
                }
                for (i, p) in grupo.iter().enumerate() {
                    if let Some(s) = &p.sentencia {
                        if una(conn, s).await.is_err() {
                            chocan.push(i);
                        }
                    }
                }
                for i in rompen_una_foranea(conn, clave, &grupo).await? {
                    if !chocan.contains(&i) {
                        chocan.push(i);
                    }
                }
                if !chocan.is_empty() {
                    return Err(AppError::internal("chocan"));
                }
                retirar(conn, &grupo.iter().map(|p| p.marca).collect::<Vec<_>>()).await
            })
            .await;
        match r {
            Ok(()) => return grupo,
            // Las que chocan, fuera; las demás, otra vez.
            Err(_) if !chocan.is_empty() && chocan.len() < grupo.len() => {
                grupo = grupo.into_iter().enumerate().filter(|(i, _)| !chocan.contains(i)).map(|(_, p)| p).collect();
            }
            // Chocan todas, o falla otra cosa: no hay nada que separar.
            Err(_) => break,
        }
    }
    Vec::new()
}

/// Las filas de `grupo` (todas de una tabla, de clave primaria `clave`) que ahora mismo rompen una
/// clave foránea de su tabla, según `PRAGMA foreign_key_check`.
async fn rompen_una_foranea(conn: &Connection, clave: &[String], grupo: &[&Plan<'_>]) -> AppResult<Vec<usize>> {
    let Some(tabla) = grupo.first().map(|p| p.marca.fila.tabla.as_str()) else { return Ok(Vec::new()) };
    if clave.is_empty() {
        return Ok(Vec::new());
    }
    let lista = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
    let mut filas = conn
        .query(
            &format!("SELECT {lista} FROM {} WHERE rowid IN (SELECT \"rowid\" FROM pragma_foreign_key_check(?1));", cita(tabla)),
            vec![Value::Text(tabla.to_owned())],
        )
        .await
        .map_err(db_err)?;
    let mut rotas: HashSet<String> = HashSet::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        let valores = (0..clave.len()).map(|i| f.get_value(i as i32).map(|v| crate::sync_reparacion::valor_a_json(&v))).collect::<Result<Vec<_>, _>>();
        if let Some(c) = valores.ok().and_then(|v| canonica_de(&FilaTocada { tabla: tabla.to_owned(), clave: v, borrada: false })) {
            rotas.insert(c);
        }
    }
    Ok(grupo.iter().enumerate().filter(|(_, p)| canonica_de(&p.marca.fila).is_some_and(|c| rotas.contains(&c))).map(|(i, _)| i).collect())
}

/// Lo que se intenta junto cuando no entra todo: cada borrado solo, y lo que se escribe, tabla a
/// tabla (lo que se intercambia un valor único es de la misma tabla).
fn tandas<'p, 'a>(en_orden: &'p [&'p Plan<'a>]) -> Vec<&'p [&'p Plan<'a>]> {
    let mut salida: Vec<&'p [&'p Plan<'a>]> = Vec::new();
    let mut desde = 0;
    for i in 1..=en_orden.len() {
        let corta = i == en_orden.len()
            || matches!(en_orden[i].accion, Accion::Borrar)
            || matches!(en_orden[i - 1].accion, Accion::Borrar)
            || en_orden[i].marca.fila.tabla != en_orden[i - 1].marca.fila.tabla;
        if corta {
            salida.push(&en_orden[desde..i]);
            desde = i;
        }
    }
    salida
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

/// Una fila que no ha entrado: un intento más. Si es por decisión de esta Main (un borrado que se
/// llevaría un cobro, un valor que no sabe escribir), al llegar a [`MAX_INTENTOS`] se deja: lo de
/// aquí es lo bueno, y lo sube el contraste. Si no ha entrado en esta base (SYNC-37: un `UNIQUE`
/// con una fila que no se trae, una foránea), se queda apuntada, y a ese intento se avisa de que
/// sigue sin entrar. Devuelve si se ha dejado.
async fn no_ha_entrado(conn: &Connection, m: &Marca, motivo: &str) -> AppResult<bool> {
    let intentos = m.intentos.saturating_add(1);
    let por_decision = matches!(motivo, "se_llevaria_un_cobro" | "valor_binario");
    let dejada = por_decision && intentos >= MAX_INTENTOS;
    let args = vec![Value::Text(m.fila.tabla.clone()), Value::Text(m.clave_json.clone())];
    let sql = match dejada {
        true => "DELETE FROM _Sync_Por_Contrastar WHERE Tabla = ?1 AND Clave_Json = ?2;",
        false => "UPDATE _Sync_Por_Contrastar SET Intentos = Intentos + 1 WHERE Tabla = ?1 AND Clave_Json = ?2;",
    };
    conn.execute(sql, args).await.map_err(db_err)?;
    if intentos == MAX_INTENTOS && !dejada {
        tracing::warn!(
            target: "tpv::sync",
            tabla = %m.fila.tabla,
            motivo,
            intentos,
            "SYNC-37: una fila de la nube sigue sin entrar en esta base; se queda apuntada y se sigue intentando"
        );
    } else if intentos <= MAX_INTENTOS {
        tracing::warn!(target: "tpv::sync", tabla = %m.fila.tabla, motivo, intentos, dejada, "SYNC-29: una fila de la nube no entra en esta base");
    } else {
        tracing::debug!(target: "tpv::sync", tabla = %m.fila.tabla, motivo, intentos, "SYNC-37: una fila de la nube sigue sin entrar");
    }
    Ok(dejada)
}

/// SYNC-29 · Una vuelta: trae de la nube hasta [`MARCAS_POR_VUELTA`] filas apuntadas y las escribe
/// aquí como están arriba. Ver el encabezado.
pub(crate) async fn converger(db: &Db, nube: &dyn PaginasDelContraste) -> AppResult<Convergencia> {
    let (marcas, quedan, marca, hasta) = {
        let r = db.read().await;
        let (marcas, quedan) = leer_marcas(r.conn(), MARCAS_POR_VUELTA as i64).await?;
        if marcas.is_empty() {
            return Ok(Convergencia::Nada);
        }
        let marca = r.conn().foto(crate::contraste::leer_marca).await.map_err(db_err)?;
        // Hasta dónde llega lo que esta Main tiene de la nube: el checkpoint o, por encima, lo suyo
        // que la nube ya ha confirmado y cuyo eco no ha bajado (en vivo no baja: la nube no se lo
        // devuelve a quien lo manda). Lo de los demás anterior a eso ya ha bajado: la nube lo difunde
        // antes que el acuse, y el socket entrega en orden.
        let hasta = marca.checkpoint.max(adelantada(r.conn()).await?);
        (marcas, quedan, marca, hasta)
    };
    // Con algo por subir, la nube no tiene todavía lo de aquí; con la bajada detenida en un cambio,
    // esta Main no tiene todavía lo de allí.
    if marca.pendientes > 0 || bajada_detenida(db.read().await.conn()).await? {
        return Ok(Convergencia::Aplazada);
    }

    // Lo que hay arriba, con la foto del final del log en lo que esta Main tiene de la nube.
    let claves = bajada::claves_primarias(db).await?;
    let mut pedir: BTreeMap<&str, Vec<Vec<Json>>> = BTreeMap::new();
    for m in &marcas {
        pedir.entry(m.fila.tabla.as_str()).or_default().push(m.fila.clave.clone());
    }
    let mut arriba: HashMap<&str, Traida> = HashMap::new();
    for (tabla, pedidas) in &pedir {
        let clave = claves.get(*tabla).map(Vec::as_slice).unwrap_or_default();
        match bajada::traer(nube, tabla, pedidas, clave, hasta).await {
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
    if ahora.checkpoint != marca.checkpoint
        || ahora.pendientes > 0
        || marca.checkpoint.max(adelantada(conn).await?) != hasta
        || bajada_detenida(conn).await?
    {
        return Ok(Convergencia::Aplazada);
    }
    let subida = bajada::lo_apartado_de_la_subida(db, &claves).await?;
    let cascadas = bajada::cascadas(db).await?;
    // DO-SUBIDA: con la subida completa a medias, lo que falta arriba puede faltar porque la nube
    // lo perdió: no se borra aquí. Se queda apuntado, y la subida lo sube si arriba falta.
    let subida_completa = crate::subida_completa::subiendo(conn).await?;

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
                    difiere => Accion::Escribir { fila: fila.clone(), existe: difiere.is_some() },
                }
            }
            None if existe(conn, tabla, &clave, &valores_clave).await? => {
                if subida_completa {
                    dejadas.push((m, "subida_completa_en_curso"));
                    continue;
                }
                Accion::Borrar
            }
            None => Accion::Nada,
        };
        let sentencia = match &accion {
            Accion::Nada => None,
            Accion::Escribir { fila, .. } => Some(SqlStatement {
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
        planes.push(Plan { marca: m, accion, sentencia, aparcar: None });
    }

    // SYNC-37: lo que se escribe sobre una fila que ya está aquí aparca antes sus valores únicos,
    // si se escribe con otra de su tabla: pueden habérselos intercambiado, o la otra puede llevarse
    // el que ésta deja (una zona nueva con el nombre que deja otra), y se escriben en cualquier orden.
    let mut por_tabla: HashMap<&str, usize> = HashMap::new();
    for p in &planes {
        if matches!(p.accion, Accion::Escribir { .. }) {
            *por_tabla.entry(p.marca.fila.tabla.as_str()).or_default() += 1;
        }
    }
    let mut unicos = crate::aparcar::Unicos::default();
    for p in planes.iter_mut() {
        let Accion::Escribir { fila, existe: true } = &p.accion else { continue };
        let tabla = p.marca.fila.tabla.as_str();
        if por_tabla.get(tabla).copied().unwrap_or(0) < 2 {
            continue;
        }
        let indices = unicos.de(conn, tabla).await?;
        p.aparcar = crate::aparcar::aparcar(tabla, indices, &arriba[tabla].columnas, fila, claves.get(tabla).map(Vec::as_slice).unwrap_or_default());
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
    let mut escribir: Vec<&Plan<'_>> = planes.iter().filter(|p| matches!(p.accion, Accion::Escribir { .. })).collect();
    escribir.sort_by_key(|p| posicion(&p.marca.fila.tabla));
    let en_orden: Vec<&Plan<'_>> = borrar.into_iter().chain(escribir).collect();
    let sentencias = |planes: &[&Plan<'_>]| -> Vec<SqlStatement> { planes.iter().filter_map(|p| p.sentencia.clone()).collect() };

    for (m, motivo) in &dejadas {
        tracing::warn!(target: "tpv::sync", tabla = %m.fila.tabla, motivo, "SYNC-29: una fila de la nube no se trae");
    }
    let todas: Vec<&Marca> = planes.iter().map(|p| p.marca).chain(dejadas.iter().map(|(m, _)| *m)).collect();
    let todo = conn
        .transaccion(async {
            ejecutar(conn, &en_orden, true).await?;
            retirar(conn, &todas).await
        })
        .await;
    let (escritas, avanza) = match todo {
        Ok(()) => (sentencias(&en_orden), true),
        // Alguna no entra. Lo de cada tabla junto, aparcando sus valores únicos; y la tabla que no
        // entra, fila a fila (una sola no tiene con quién cruzarse: sin aparcar). Las que solas
        // chocan con un índice único pueden estar cruzadas entre ellas: juntas otra vez, aparcando y
        // apartando las que chocan con algo más ([`cruzadas`]). La que no entra cuenta un intento.
        Err(_) => {
            let mut escritas = Vec::new();
            let mut dejadas_ahora = false;
            for tanda in tandas(&en_orden) {
                if tanda.len() > 1 && intentar(conn, tanda, true).await.is_ok() {
                    escritas.extend(sentencias(tanda));
                    continue;
                }
                let mut fallan: Vec<(&Plan<'_>, String)> = Vec::new();
                for p in tanda {
                    match intentar(conn, &[*p], false).await {
                        Ok(()) => escritas.extend(sentencias(&[*p])),
                        Err(e) => {
                            // Lo nuestro, tal cual; lo de SQLite, en su clase (sin los datos de la fila).
                            let texto = e.to_string();
                            let motivo = match texto.as_str() {
                                "se_llevaria_un_cobro" | "valor_binario" => texto,
                                _ => crate::cuarentenas_bajada::clase_de_error(Some(&texto)).unwrap_or_default(),
                            };
                            fallan.push((p, motivo));
                        }
                    }
                }
                let chocan: Vec<&Plan<'_>> = fallan.iter().filter(|(_, m)| m.starts_with("unique")).map(|(p, _)| *p).collect();
                if chocan.len() > 1 {
                    let clave = claves.get(&chocan[0].marca.fila.tabla).map(Vec::as_slice).unwrap_or_default();
                    let entran = cruzadas(conn, clave, chocan).await;
                    escritas.extend(sentencias(&entran));
                    fallan.retain(|(p, _)| !entran.iter().any(|e| std::ptr::eq(*e, *p)));
                }
                for (p, motivo) in &fallan {
                    dejadas_ahora |= no_ha_entrado(conn, p.marca, motivo).await?;
                }
            }
            let sin_nada: Vec<&Marca> =
                planes.iter().filter(|p| p.sentencia.is_none()).map(|p| p.marca).chain(dejadas.iter().map(|(m, _)| *m)).collect();
            retirar(conn, &sin_nada).await?;
            let avanza = !escritas.is_empty() || !sin_nada.is_empty() || dejadas_ahora;
            (escritas, avanza)
        }
    };
    if !escritas.is_empty() {
        tracing::info!(target: "tpv::sync", filas = escritas.len(), "SYNC-29: filas traídas de la nube, que las ordenó de otra forma");
    }
    // SYNC-37: si no ha entrado nada y todo sigue apuntado, la vuelta no ha cambiado nada: el motor
    // espera más para la siguiente, en vez de volver a pedirlo a los pocos segundos.
    if !avanza {
        return Ok(Convergencia::Aplazada);
    }
    Ok(Convergencia::Hecha { escritas, quedan })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    async fn base(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(&format!("convergencia-{nombre}"));
        Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap()
    }

    async fn numero(db: &Db, sql: &str) -> i64 {
        let r = db.read().await;
        let mut f = r.conn().query(sql, ()).await.unwrap();
        f.next().await.unwrap().unwrap().get::<i64>(0).unwrap()
    }

    fn fila(id: &str) -> FilaTocada {
        FilaTocada { tabla: "Reservas".into(), clave: vec![serde_json::json!(id)], borrada: false }
    }

    #[tokio::test]
    async fn no_se_apuntan_mas_de_las_que_caben_y_las_ya_apuntadas_se_ponen_al_dia() {
        // Codex: el tope se miraba una vez por sentencia, y un cambio grande lo pasaba de largo.
        let db = base("tope").await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(&format!(
                    "WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < {})
                     INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms, Intentos)
                     SELECT 'Reservas', json_array('r' || i), 1, 1, 3 FROM s;",
                    MAX_MARCAS - 1
                ))
                .await
                .unwrap();
            marcar(w.raw(), &[fila("r1"), fila("nueva-1"), fila("nueva-2")], 7).await.unwrap();
        }
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Por_Contrastar;").await, MAX_MARCAS);
        // Con el cambio de ahora, y sus intentos desde el principio (en uno, porque ya había fallado).
        assert_eq!(numero(&db, "SELECT Seq * 10 + Intentos FROM _Sync_Por_Contrastar WHERE Clave_Json = '[\"r1\"]';").await, 71);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Por_Contrastar WHERE Clave_Json LIKE '%nueva%';").await, 1);
    }

    #[tokio::test]
    async fn una_fila_que_ha_fallado_sigue_contando_como_atascada_aunque_la_vuelva_a_apuntar_otro_cambio() {
        // Codex: volver a apuntarla ponía sus intentos a cero, y el aviso de lo que lleva una semana
        // sin entrar se apagaba aunque siguiera sin entrar. La que nunca se ha podido intentar (sin
        // conexión) sigue sin contar.
        let db = base("atascada-reapuntada").await;
        let hace_ocho_dias = now_ms() - 8 * 24 * 60 * 60 * 1000;
        let w = db.write().await;
        w.raw()
            .execute(
                "INSERT INTO _Sync_Por_Contrastar (Tabla, Clave_Json, Seq, Desde_Ms, Intentos)
                 VALUES ('Reservas', '[\"r1\"]', 1, ?1, 6), ('Reservas', '[\"r2\"]', 1, ?1, 0);",
                vec![Value::Integer(hace_ocho_dias)],
            )
            .await
            .unwrap();
        let hace_una_semana = now_ms() - 7 * 24 * 60 * 60 * 1000;
        assert_eq!(atascadas(w.raw(), hace_una_semana).await.unwrap(), 1);
        marcar(w.raw(), &[fila("r1"), fila("r2")], 9).await.unwrap();
        assert_eq!(atascadas(w.raw(), hace_una_semana).await.unwrap(), 1, "r1 sigue sin entrar; r2 no se ha intentado");
        drop(w);
    }
}
