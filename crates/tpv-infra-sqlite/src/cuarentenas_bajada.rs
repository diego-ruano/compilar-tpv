//! SYNC-36 · Lo que no entró de la bajada: sus datos caducan y su cuarentena tiene salida.
//!
//! Un cambio de la nube que no se puede aplicar aquí acaba, al quinto intento, en cuarentena
//! (`_Sync_Failed`, AUD-18), y una fila ahí es la barrera del contraste con la nube: con ella no se
//! repara nada, porque lo que aquí falta puede ser lo que escribió ese cambio, y repararlo sería
//! borrar arriba lo que una Handy escribió. Antes no había salida en la operación normal (sólo una
//! recuperación vaciaba la tabla): un cambio atascado dejaba al negocio sin reparaciones para
//! siempre, y sus datos —nombres, teléfonos, notas— en el equipo.
//!
//! # Los datos caducan ([`vaciar`])
//!
//! A los 30 días de apartarse (`RETENCION_CUARENTENAS_MS`, la misma que lo apartado de la subida) se
//! vacían sus sentencias y el texto de su error se queda en su clase (`unique (Comandas.ID_Mesa)`).
//! La fila sigue: su operación, su `Seq`, sus intentos, sus fechas y las filas que tocó
//! (`Filas_Json`: tabla y clave primaria, identificadores). Con eso se diagnostica sin datos de nadie
//! y se sigue pudiendo traer de la nube, y la barrera sigue en pie.
//!
//! # La salida ([`resolver`])
//!
//! En cada pasada del contraste con permiso para reparar, antes de comparar nada, se trae de la nube
//! **cómo están ahora** las filas que tocó cada cuarentena (`/v1/sync/verificar/por-clave`) y se
//! aplican aquí por estado. Si todo entra, la cuarentena se cierra en la misma transacción, y si no
//! queda ninguna la barrera se levanta y el contraste repara en esa misma pasada.
//!
//! - **Con la foto del resumen.** El resumen de esa pasada ya garantiza que la nube no tiene nada
//!   ajeno por encima del checkpoint de esta Main (`por_delante`) ni actividad reciente, y cada
//!   página por clave tiene que traer su mismo `hasta_seq`; aquí, con el escritor cogido, la marca
//!   tiene que seguir siendo la de entonces (ni un cambio de la nube aplicado ni una escritura de
//!   aquí entre medias). Así lo que se trae no es anterior al cambio en cuarentena (su `Seq` no pasa
//!   del checkpoint) ni posterior a lo que esta Main ha aplicado: un cambio que aún no ha bajado no
//!   se aplicaría encima otra vez al bajar (un `Stock - 1` dos veces).
//! - **Sólo se escribe aquí**, por `raw()`, y nada en la nube: lo que se trae ya está arriba.
//! - **Lo que está arriba** se escribe con `INSERT … ON CONFLICT(clave) DO UPDATE` (nunca `INSERT OR
//!   REPLACE`, que borraría y dispararía las cascadas). **Lo que no está arriba** sólo se borra aquí
//!   si el cambio lo borraba: que la nube no tenga una fila que el cambio insertó o cambió dice que
//!   alguien la borró después, y ese borrado ya bajó o tiene su propia cuarentena. Un borrado aquí
//!   arrastra sus cascadas, como arriba. Todo va en una transacción con las foráneas aplazadas:
//!   primero lo que se borra (hijas primero) y después lo que se escribe (padres primero).
//! - **Una a una, en orden de `Seq`**: la que no entra no frena a las demás, y la hija que fallaba
//!   porque su padre estaba en otra cuarentena entra en cuanto entra la del padre.
//! - **Lo que no se puede traer, se queda** y se informa: un cambio cuyas filas no se saben
//!   (`incierto`), uno que toca lo mismo que algo apartado de la subida (la nube no tiene lo que esta
//!   Main escribió ahí, y traerla lo desharía aquí) o cuyas filas de una tabla salieron de un filtro
//!   sobre esta base y en esa tabla hay algo apartado (`por_filtro`), o cuyo borrado llegaría por
//!   sus cascadas a algo apartado; una fila que sigue sin entrar (el `UNIQUE` con el que chocaba
//!   sigue ahí) o una tabla con columnas que esta versión no tiene. Se vuelve a intentar en la pasada
//!   siguiente, y cada pasada tiene su tope de trabajo.
//!
//! **Reintentar sus sentencias** no sirve de salida: para cuando entraran, lo de detrás ya habría
//! pasado por esas filas, y aplicarlas encima devolvería una fila a un valor viejo o repetiría un
//! `Stock - 1`. El estado de la nube, en cambio, ya lleva el cambio y todo lo posterior.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value as Json;
use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::sync::{MarcaLocal, PaginasDelContraste, PedidoPorClave};
use tpv_contracts::errors::ErrorCode;
use tpv_contracts::sync::SqlStatement;

use crate::consultas::db_err;
use crate::db::{Db, Writer};
use crate::ejecutor::{Connection, Value};
use crate::filas_tocadas::{self as tocadas, cita, FilaTocada, Tocadas};
use crate::util::now_ms;

/// Lo más que se intenta cerrar en una pasada (traerlo de la nube y aplicarlo). Lo que no quepa, en
/// la siguiente. Las que ni se intentan (inciertas, o que chocan con lo apartado de la subida) no
/// cuentan: así unas cuantas atascadas al principio no dejan sin intentar a las de detrás.
pub(crate) const MAX_CUARENTENAS_POR_PASADA: usize = 50;

/// Lo más que se lee de las cuarentenas en una pasada: sin sus sentencias, sólo lo que dice qué
/// tocan.
const MAX_CUARENTENAS_LEIDAS: usize = 10_000;

/// De cuántas inciertas se vuelve a mirar qué tocan en una pasada (un simulacro cada una).
const MAX_RECALCULOS_POR_PASADA: usize = 20;

/// Lo más que se lee de lo apartado de la subida para cruzarlo. Con más, se da por chocado todo.
const MAX_APARTADAS_LEIDAS: usize = 1_000;

/// Lo más que se trae de la nube en una pasada, en filas. La primera cuarentena se intenta siempre,
/// aunque toque más (hasta `MAX_FILAS_TOCADAS`).
pub(crate) const MAX_FILAS_POR_PASADA: usize = 5_000;

/// Claves por petición a `/v1/sync/verificar/por-clave`, como el contraste.
const CLAVES_POR_PETICION: usize = 500;

/* ===== Los datos caducan ===== */

/// Cuántas se vacían de una vez, con el escritor cogido. Entre tanda y tanda se suelta: de una que se
/// mira otra vez qué tocó hay que ejecutar sus sentencias, y un cobro no tiene por qué esperar a todas.
const VACIADAS_POR_TANDA: usize = 20;

/// Vacía los datos de lo que no entró de la bajada y lleva en cuarentena desde antes de
/// `antes_de_ms`, y devuelve cuántas. Ver el encabezado.
pub(crate) async fn vaciar(db: &Db, antes_de_ms: i64) -> AppResult<u64> {
    let mut total = 0u64;
    // Hasta vaciarlas todas, sin tope de vueltas (Codex: con uno, una acumulación grande esperaba a
    // otro día). Lo vaciado no se vuelve a leer, así que cada tanda va más allá y esto acaba: una
    // tanda que no llega a su tope es la última, y una que no vacía nada (lo leído ya no está en
    // cuarentena) también.
    loop {
        let (leidas, vaciadas) = vaciar_una_tanda(db, antes_de_ms).await?;
        total += vaciadas;
        if leidas < VACIADAS_POR_TANDA || vaciadas == 0 {
            break;
        }
    }
    Ok(total)
}

/// Una tanda de [`vaciar`]: cuántas ha leído y cuántas ha vaciado.
async fn vaciar_una_tanda(db: &Db, antes_de_ms: i64) -> AppResult<(usize, u64)> {
    let w = db.write().await;
    let conn: &Connection = w.raw();

    let mut filas = conn
        .query(
            "SELECT Op_Id, Statements_Json, Filas_Json, Last_Error FROM _Sync_Failed \
              WHERE Quarantined = 1 AND Datos_Vaciados_At_Ms IS NULL AND Last_Failed_At_Ms < ?1 \
              ORDER BY Seq LIMIT ?2;",
            vec![Value::Integer(antes_de_ms), Value::Integer(VACIADAS_POR_TANDA as i64)],
        )
        .await
        .map_err(db_err)?;
    let mut pendientes: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        let texto = |i| match f.get_value(i) {
            Ok(Value::Text(t)) => Some(t),
            _ => None,
        };
        let Some(op) = texto(0) else { continue };
        pendientes.push((op, texto(1).unwrap_or_default(), texto(2), texto(3)));
    }
    drop(filas);
    let leidas = pendientes.len();
    if leidas == 0 {
        return Ok((0, 0));
    }

    // Es la última ocasión de saber qué filas tocó: después ya no quedan sentencias.
    let mut vaciadas: Vec<(String, String, Option<String>)> = Vec::with_capacity(pendientes.len());
    for (op, sentencias, filas, error) in pendientes {
        let sabidas = filas.as_deref().map(Tocadas::de_json);
        let filas = match sabidas {
            Some(t) if !t.incierto => t,
            antes => {
                let sentencias: Vec<SqlStatement> = serde_json::from_str(&sentencias).unwrap_or_default();
                let ahora = match sentencias.is_empty() {
                    true => None,
                    false => {
                        let mut t = tocadas::de_un_cambio(conn, &sentencias).await;
                        t.dudosa |= antes.as_ref().is_some_and(|a| a.dudosa);
                        marcar_si_dudosa(db, &mut t).await?;
                        Some(t)
                    }
                };
                // Si sigue incierta se queda la de antes, pero sin perder una duda recién vista.
                let dudosa = ahora.as_ref().is_some_and(|t| t.dudosa);
                let mut elegida = match (ahora, antes) {
                    (Some(t), _) if !t.incierto => t,
                    (_, Some(t)) => t,
                    (Some(t), None) => t,
                    (None, None) => Tocadas::incierta_de_todo(Vec::new()),
                };
                elegida.dudosa |= dudosa;
                elegida
            }
        };
        vaciadas.push((op, filas.a_json(), clase_de_error(error.as_deref())));
    }

    let ahora = now_ms();
    let n = conn.transaccion(async {
        let mut n = 0u64;
        for (op, filas, error) in &vaciadas {
            n += conn
                .execute(
                    "UPDATE _Sync_Failed \
                        SET Statements_Json = '[]', Last_Error = ?2, Filas_Json = ?3, Datos_Vaciados_At_Ms = ?4 \
                      WHERE Op_Id = ?1 AND Quarantined = 1 AND Datos_Vaciados_At_Ms IS NULL;",
                    vec![
                        Value::Text(op.clone()),
                        error.clone().map_or(Value::Null, Value::Text),
                        Value::Text(filas.clone()),
                        Value::Integer(ahora),
                    ],
                )
                .await
                .map_err(db_err)?;
        }
        Ok(n)
    })
    .await?;
    Ok((leidas, n))
}

/// La clase de un error al aplicar un cambio, sin nada de lo que el cambio llevaba: qué restricción
/// saltó y en qué columnas, o qué no existe aquí. Lo que no es de una clase conocida es `otro`. El
/// número de la sentencia que falló, si lo dice.
pub(crate) fn clase_de_error(texto: Option<&str>) -> Option<String> {
    let texto = texto?;
    let nombres = |s: &str| -> Option<String> {
        let s = s.trim();
        (!s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ',' | ' '))).then(|| s.to_owned())
    };
    // El mensaje del motor va entre comillas invertidas (`SQLite failure: `…``).
    let motor = texto
        .find('`')
        .and_then(|i| texto[i + 1..].find('`').map(|j| &texto[i + 1..i + 1 + j]))
        .unwrap_or(texto)
        .trim();
    let con = |clase: &str, resto: &str| match nombres(resto) {
        Some(n) => format!("{clase} ({n})"),
        None => clase.to_owned(),
    };
    let clase = if let Some(r) = motor.strip_prefix("UNIQUE constraint failed:") {
        con("unique", r)
    } else if let Some(r) = motor.strip_prefix("NOT NULL constraint failed:") {
        con("not_null", r)
    } else if motor.starts_with("FOREIGN KEY constraint failed") {
        "foreign_key".to_owned()
    } else if motor.starts_with("CHECK constraint failed") {
        "check".to_owned()
    } else if let Some(r) = motor.strip_prefix("no such table:") {
        con("tabla_desconocida", r)
    } else if let Some(r) = motor.strip_prefix("no such column:") {
        con("columna_desconocida", r)
    } else if let Some(i) = motor.find("has no column named") {
        con("columna_desconocida", &motor[i + "has no column named".len()..])
    } else if motor.starts_with("datatype mismatch") {
        "tipo".to_owned()
    } else if motor.starts_with("RI48:") {
        "trigger (RI48)".to_owned()
    } else if motor.starts_with("horario_") && motor.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
        format!("trigger ({motor})")
    } else {
        "otro".to_owned()
    };
    let sentencia = texto
        .find("sentencia #")
        .map(|i| texto[i + "sentencia #".len()..].chars().take_while(char::is_ascii_digit).collect::<String>())
        .filter(|n| !n.is_empty());
    Some(match sentencia {
        Some(n) => format!("sentencia #{n}: {clase}"),
        None => clase,
    })
}

/* ===== La salida ===== */

/// Lo que ha hecho una pasada con las cuarentenas de bajada.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Salida {
    pub resueltas: usize,
    pub quedan: usize,
}

/// Una cuarentena de bajada, como se lee.
struct Cuarentena {
    op_id: String,
    seq: i64,
    /// Aún tiene sus sentencias (no se han vaciado).
    con_sentencias: bool,
    tocadas: Tocadas,
    sabidas: bool,
}

/// Los motivos propios por los que una cuarentena que se intenta cerrar se queda.
const MOTIVOS: [&str; 6] = [
    "la_nube_no_la_ha_traido",
    "la_nube_no_la_sabe_buscar",
    "la_clave_no_es_la_de_aqui",
    "clave_ilegible",
    "columnas_desconocidas",
    "valor_binario",
];

/// Por qué una cuarentena se queda. Va a la telemetría: no lleva datos de nadie (lo que dice SQLite,
/// en su clase).
fn motivo_de(e: &AppError) -> String {
    let texto = e.to_string();
    if MOTIVOS.contains(&texto.as_str()) {
        return texto;
    }
    format!("no_entra: {}", clase_de_error(Some(&texto)).unwrap_or_else(|| "otro".into()))
}

/// La salida de las cuarentenas de bajada, con la foto del resumen de esta pasada del contraste
/// (`hasta_seq`) y la marca de esta base de antes de pedirlo. `None` si una de las dos bases se ha
/// movido: no se ha escrito nada. Ver el encabezado.
pub(crate) async fn resolver(
    db: &Db,
    hasta_seq: i64,
    marca: MarcaLocal,
    nube: &dyn PaginasDelContraste,
) -> AppResult<Option<Salida>> {
    let (mut cuarentenas, total) = leer_cuarentenas(db).await?;
    if cuarentenas.is_empty() {
        return Ok(Some(Salida::default()));
    }

    // Las que no saben qué tocan. Todas, en cada pasada, se cruzan con lo apartado de ahora: si lo
    // apartado se retirara antes de que se supiera qué tocan, ya no se vería (`dudosa`, Codex). Y de
    // las que aún tienen sus sentencias se vuelve a mirar qué tocan (la tabla que esta versión no
    // tenía puede tenerla ya), unas pocas por pasada; las que no caben no se marcan como miradas, y
    // la pasada siguiente empieza por ellas.
    let mut sin_recalcular: HashSet<String> = HashSet::new();
    {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        let apartado = lo_apartado_de_la_subida(db, &HashMap::new()).await?;
        let mut recalculos = 0usize;
        for c in cuarentenas.iter_mut().filter(|c| c.tocadas.incierto) {
            let dudosa_antes = c.tocadas.dudosa;
            c.tocadas.dudosa |= es_dudosa(&c.tocadas, &apartado);
            let mut sentencias: Vec<SqlStatement> = Vec::new();
            if c.con_sentencias {
                if recalculos == MAX_RECALCULOS_POR_PASADA {
                    sin_recalcular.insert(c.op_id.clone());
                } else {
                    recalculos += 1;
                    let mut filas = conn
                        .query("SELECT Statements_Json FROM _Sync_Failed WHERE Op_Id = ?1;", vec![Value::Text(c.op_id.clone())])
                        .await
                        .map_err(db_err)?;
                    if let Some(Ok(Value::Text(t))) = filas.next().await.map_err(db_err)?.map(|f| f.get_value(0)) {
                        sentencias = serde_json::from_str(&t).unwrap_or_default();
                    }
                }
            }
            let mut cambiada = c.tocadas.dudosa != dudosa_antes;
            if !sentencias.is_empty() {
                let mut ahora = tocadas::de_un_cambio(conn, &sentencias).await;
                ahora.dudosa |= c.tocadas.dudosa || es_dudosa(&ahora, &apartado);
                if !ahora.incierto || !c.sabidas {
                    c.tocadas = ahora;
                    cambiada = true;
                } else if ahora.dudosa && !c.tocadas.dudosa {
                    // Sigue incierta: se queda la de antes, pero no la duda recién vista.
                    c.tocadas.dudosa = true;
                    cambiada = true;
                }
            }
            if cambiada {
                conn.execute(
                    "UPDATE _Sync_Failed SET Filas_Json = ?2 WHERE Op_Id = ?1 AND Quarantined = 1;",
                    vec![Value::Text(c.op_id.clone()), Value::Text(c.tocadas.a_json())],
                )
                .await
                .map_err(db_err)?;
            }
        }
    }

    let claves = claves_primarias(db).await?;
    let subida = lo_apartado_de_la_subida(db, &claves).await?;
    let cascadas = cascadas(db).await?;

    // Las que se intentan en esta pasada, y lo que hay que pedir de cada tabla. Las que no caben (por
    // número o por filas) se dejan para otra pasada, y se sigue mirando las de detrás.
    let mut intentadas: Vec<&Cuarentena> = Vec::new();
    let mut quedan: Vec<(&Cuarentena, String)> = Vec::new();
    let mut saltadas: HashSet<&str> = HashSet::new();
    let mut pedir: BTreeMap<String, Vec<Vec<Json>>> = BTreeMap::new();
    let mut pedidas: HashSet<String> = HashSet::new();
    for c in &cuarentenas {
        if c.seq > hasta_seq {
            // La foto de la nube es anterior al cambio: con ella no se puede cerrar.
            quedan.push((c, "anterior_al_cambio".into()));
            continue;
        }
        if c.tocadas.incierto {
            quedan.push((c, "filas_inciertas".into()));
            continue;
        }
        if c.tocadas.dudosa {
            quedan.push((c, "apuntada_con_lo_apartado_de_la_subida".into()));
            continue;
        }
        if choca_con_la_subida(&c.tocadas, &subida, &cascadas) {
            quedan.push((c, "choca_con_lo_apartado_de_la_subida".into()));
            continue;
        }
        let nuevas: Vec<&FilaTocada> = c
            .tocadas
            .filas
            .iter()
            .filter(|f| !crate::sync::no_es_tabla_de_negocio(&f.tabla))
            .filter(|f| tocadas::canonica_de(f).is_some_and(|k| !pedidas.contains(&k)))
            .collect();
        if intentadas.len() == MAX_CUARENTENAS_POR_PASADA
            || (!intentadas.is_empty() && pedidas.len() + nuevas.len() > MAX_FILAS_POR_PASADA)
        {
            saltadas.insert(c.op_id.as_str());
            continue;
        }
        for f in nuevas {
            if let Some(k) = tocadas::canonica_de(f) {
                pedidas.insert(k);
                pedir.entry(f.tabla.clone()).or_default().push(f.clave.clone());
            }
        }
        intentadas.push(c);
    }

    let mut arriba: HashMap<String, Traida> = HashMap::new();
    for (tabla, claves_de_la_tabla) in &pedir {
        match traer(nube, tabla, claves_de_la_tabla, claves.get(tabla).map(Vec::as_slice).unwrap_or_default(), hasta_seq).await? {
            Some(t) => {
                arriba.insert(tabla.clone(), t);
            }
            None => return Ok(None),
        }
    }

    // Con el escritor cogido: la base tiene que seguir como estaba al pedir el resumen.
    let w = db.write().await;
    let conn: &Connection = w.raw();
    let (ahora, historico_completo) = conn
        .foto(|foto| {
            let marca = crate::contraste::leer_marca(foto)?;
            let pendiente = foto.entero("SELECT COUNT(*) FROM _Backfill_Historico WHERE Completada = 0;", &[])?.unwrap_or(0);
            Ok((marca, pendiente == 0))
        })
        .await
        .map_err(db_err)?;
    if ahora != marca || !historico_completo {
        return Ok(None);
    }
    let tablas: Vec<String> = pedir.keys().cloned().collect();
    let orden: Vec<String> = conn
        .foto(move |foto| crate::contraste::padres_primero(foto, &tablas))
        .await
        .map_err(db_err)?
        .into_iter()
        .map(|(t, _)| t)
        .collect();

    // Se han elegido empezando por las que hace más que no se miran; se aplican en orden de `Seq`,
    // que es el de la nube: la del padre antes que la de la hija.
    intentadas.sort_by_key(|c| c.seq);
    let mut resueltas = 0usize;
    for c in &intentadas {
        match aplicar(conn, c, &arriba, &orden, &claves).await {
            Ok(true) => {
                resueltas += 1;
                tracing::info!(
                    target: "tpv::sync",
                    op_id = %c.op_id,
                    seq = c.seq,
                    filas = c.tocadas.filas.len(),
                    "cuarentena de bajada cerrada: lo que tocó se ha traído de la nube (SYNC-36)"
                );
            }
            // Ya no estaba: la ha cerrado otro camino.
            Ok(false) => {}
            Err(e) => quedan.push((c, motivo_de(&e))),
        }
    }
    for (c, motivo) in &quedan {
        tracing::warn!(
            target: "tpv::sync",
            op_id = %c.op_id,
            seq = c.seq,
            motivo = %motivo,
            "cuarentena de bajada que no se puede cerrar todavía (SYNC-36)"
        );
    }
    if !saltadas.is_empty() {
        tracing::info!(target: "tpv::sync", sin_intentar = saltadas.len(), "cuarentenas de bajada que no caben en esta pasada (SYNC-36)");
    }
    // Las que se han mirado van detrás en la pasada siguiente; las que no cabían, no: así ni unas
    // atascadas al principio ni el tope de lectura dejan a ninguna sin intentar para siempre.
    let miradas: Vec<&str> = cuarentenas
        .iter()
        .map(|c| c.op_id.as_str())
        .filter(|op| !saltadas.contains(op) && !sin_recalcular.contains(*op))
        .collect();
    conn.execute(
        "UPDATE _Sync_Failed SET Ultima_Salida_Ms = ?1 WHERE Quarantined = 1 AND Op_Id IN (SELECT value FROM json_each(?2));",
        vec![Value::Integer(now_ms()), Value::Text(serde_json::to_string(&miradas).map_err(db_err)?)],
    )
    .await
    .map_err(db_err)?;
    Ok(Some(Salida { resueltas, quedan: total - resueltas }))
}

/// Las cuarentenas de bajada, por orden, sin sus sentencias, y cuántas hay.
async fn leer_cuarentenas(db: &Db) -> AppResult<(Vec<Cuarentena>, usize)> {
    let r = db.read().await;
    let total = r
        .conn()
        .foto(|foto| foto.entero("SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 1;", &[]))
        .await
        .map_err(db_err)?
        .unwrap_or(0) as usize;
    let mut filas = r
        .conn()
        .query(
            "SELECT Op_Id, Seq, Statements_Json <> '[]', Filas_Json FROM _Sync_Failed \
              WHERE Quarantined = 1 ORDER BY COALESCE(Ultima_Salida_Ms, 0), Seq LIMIT ?1;",
            vec![Value::Integer(MAX_CUARENTENAS_LEIDAS as i64)],
        )
        .await
        .map_err(db_err)?;
    let mut salida = Vec::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        let Ok(Value::Text(op_id)) = f.get_value(0) else { continue };
        let seq = match f.get_value(1) {
            Ok(Value::Integer(n)) => n,
            _ => continue,
        };
        let con_sentencias = matches!(f.get_value(2), Ok(Value::Integer(1)));
        let (tocadas, sabidas) = match f.get_value(3) {
            Ok(Value::Text(t)) => (Tocadas::de_json(&t), true),
            _ => (Tocadas::incierta_de_todo(Vec::new()), false),
        };
        salida.push(Cuarentena { op_id, seq, con_sentencias, tocadas, sabidas });
    }
    Ok((salida, total))
}

/// Las columnas de la clave primaria de cada tabla de aquí.
async fn claves_primarias(db: &Db) -> AppResult<HashMap<String, Vec<String>>> {
    let r = db.read().await;
    r.conn()
        .foto(|foto| {
            let mut claves: HashMap<String, Vec<(i64, String)>> = HashMap::new();
            for f in foto.filas(
                "SELECT m.name, p.name, p.pk FROM sqlite_master m JOIN pragma_table_info(m.name) p \
                  WHERE m.type = 'table' AND p.pk > 0;",
                &[],
            )? {
                if let (Some(Value::Text(t)), Some(Value::Text(c)), Some(Value::Integer(pk))) = (f.first(), f.get(1), f.get(2)) {
                    claves.entry(t.clone()).or_default().push((*pk, c.clone()));
                }
            }
            Ok(claves
                .into_iter()
                .map(|(t, mut cs)| {
                    cs.sort();
                    (t, cs.into_iter().map(|(_, c)| c).collect())
                })
                .collect())
        })
        .await
        .map_err(db_err)
}

/// ¿Se apuntan estas filas con algo apartado de la subida en una de las tablas de las que salieron
/// por un filtro (`por_filtro`)? Entonces lo que se sacó de esta base pudo no ser lo de la nube, y
/// queda `dudosa` para siempre: cuando lo apartado se retire, a los 30 días, lo de aquí seguirá siendo
/// otra cosa que lo de arriba y nada lo dirá (Codex, SYNC-36). Unas inciertas también se marcan: si
/// se vuelven a mirar más tarde, ya no se vería.
pub(crate) async fn marcar_si_dudosa(db: &Db, t: &mut Tocadas) -> AppResult<()> {
    if t.dudosa || t.por_filtro.is_empty() {
        return Ok(());
    }
    let apartado = lo_apartado_de_la_subida(db, &HashMap::new()).await?;
    t.dudosa = es_dudosa(t, &apartado);
    Ok(())
}

/// Lo de [`marcar_si_dudosa`], con lo apartado ya leído. Un `*` en `por_filtro` (no se sabe ni qué
/// tablas lee) es dudosa con cualquier cosa apartada.
fn es_dudosa(t: &Tocadas, apartado: &tocadas::Estaticas) -> bool {
    !t.por_filtro.is_empty()
        && (apartado.tablas.contains("*")
            || t.por_filtro.iter().any(|x| (x == tocadas::TODAS && !apartado.todas.is_empty()) || apartado.todas.contains(x)))
}

/// Lo que toca lo apartado de la subida: lo que esta Main escribió y la nube no tiene.
async fn lo_apartado_de_la_subida(db: &Db, claves: &HashMap<String, Vec<String>>) -> AppResult<tocadas::Estaticas> {
    let r = db.read().await;
    let mut filas = r
        .conn()
        .query(
            "SELECT Statements_Json FROM _Sync_Outbox WHERE Cuarentena = 1 LIMIT ?1;",
            vec![Value::Integer(MAX_APARTADAS_LEIDAS as i64 + 1)],
        )
        .await
        .map_err(db_err)?;
    let mut todas = tocadas::Estaticas { claves: HashSet::new(), tablas: HashSet::new(), todas: HashSet::new() };
    let clave_de = |t: &str| claves.get(t).cloned().unwrap_or_default();
    let mut leidas = 0usize;
    while let Some(f) = filas.next().await.map_err(db_err)? {
        leidas += 1;
        if leidas > MAX_APARTADAS_LEIDAS {
            // Más de las que se miran: se da por chocado todo.
            todas.tablas.insert("*".into());
            break;
        }
        let sentencias: Vec<SqlStatement> = match f.get_value(0) {
            Ok(Value::Text(t)) => serde_json::from_str(&t).unwrap_or_default(),
            _ => Vec::new(),
        };
        let e = tocadas::estaticas(&sentencias, &clave_de);
        todas.claves.extend(e.claves);
        todas.tablas.extend(e.tablas);
        todas.todas.extend(e.todas);
    }
    Ok(todas)
}

/// ¿Toca la cuarentena algo que esta Main escribió y la nube no tiene? Una fila apuntada que es de lo
/// apartado, o una tabla en la que lo apartado no se sabe por su clave. Y si sus filas de una tabla
/// salieron de esta base y no de la sentencia (`por_filtro`), cualquier cosa apartada en esa tabla:
/// lo apartado es lo que aquí es distinto de arriba, y con ello aquí pudo cumplir el filtro otra
/// fila que la de la nube (Codex, SYNC-36). Y si borra una fila, cualquier cosa apartada en las
/// tablas a las que llega su borrado por las cascadas (`cascadas`): borrar aquí se llevaría con
/// ellas lo que esta Main escribió debajo y la nube no tiene.
fn choca_con_la_subida(t: &Tocadas, subida: &tocadas::Estaticas, cascadas: &Cascadas) -> bool {
    subida.tablas.contains("*")
        || t.tablas.iter().any(|x| subida.tablas.contains(x))
        || t.por_filtro.iter().any(|x| subida.todas.contains(x))
        || t.filas.iter().any(|f| subida.tablas.contains(&f.tabla) || tocadas::canonica_de(f).is_some_and(|k| subida.claves.contains(&k)))
        || t.filas.iter().filter(|f| f.borrada).any(|f| cascadas.alcanza(&f.tabla).any(|x| subida.todas.contains(x)))
}

/// Las tablas a las que llega el borrado de una fila de cada tabla: sus hijas por una foránea con
/// `ON DELETE CASCADE`, `SET NULL` o `SET DEFAULT`, y las de éstas.
#[derive(Debug, Default)]
struct Cascadas {
    hijas: HashMap<String, Vec<String>>,
}

impl Cascadas {
    /// `tabla` y todas a las que llega su borrado.
    fn alcanza<'a>(&'a self, tabla: &'a str) -> impl Iterator<Item = &'a str> + 'a {
        let mut vistas: Vec<&'a str> = vec![tabla];
        let mut i = 0;
        while i < vistas.len() {
            for h in self.hijas.get(vistas[i]).map(Vec::as_slice).unwrap_or_default() {
                if !vistas.contains(&h.as_str()) {
                    vistas.push(h);
                }
            }
            i += 1;
        }
        vistas.into_iter()
    }
}

async fn cascadas(db: &Db) -> AppResult<Cascadas> {
    let r = db.read().await;
    r.conn()
        .foto(|foto| {
            let mut c = Cascadas::default();
            for f in foto.filas(
                "SELECT m.name, f.\"table\", upper(f.on_delete) FROM sqlite_master m \
                   JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table';",
                &[],
            )? {
                if let (Some(Value::Text(hija)), Some(Value::Text(padre)), Some(Value::Text(al_borrar))) = (f.first(), f.get(1), f.get(2)) {
                    if ["CASCADE", "SET NULL", "SET DEFAULT"].contains(&al_borrar.as_str()) {
                        c.hijas.entry(padre.clone()).or_default().push(hija.clone());
                    }
                }
            }
            Ok(c)
        })
        .await
        .map_err(db_err)
}

/// Lo que se ha traído de una tabla.
struct Traida {
    columnas: Vec<String>,
    /// Por la forma canónica de su clave (`filas_tocadas::canonica_de`).
    filas: HashMap<String, Vec<Json>>,
    /// La nube no ha sabido buscarla: las cuarentenas que la tocan se quedan.
    sin_buscar: bool,
}

/// Trae de la nube las filas de `tabla` con esas claves. `None` si la nube se ha movido desde el
/// resumen (otro `hasta_seq`).
async fn traer(
    nube: &dyn PaginasDelContraste,
    tabla: &str,
    pedidas: &[Vec<Json>],
    clave: &[String],
    hasta_seq: i64,
) -> AppResult<Option<Traida>> {
    let mut traida = Traida { columnas: Vec::new(), filas: HashMap::new(), sin_buscar: false };
    if clave.is_empty() {
        // Sin clave aquí, no se sabe qué fila es cada una.
        traida.sin_buscar = true;
        return Ok(Some(traida));
    }
    for tanda in pedidas.chunks(CLAVES_POR_PETICION) {
        let mut pendientes: Vec<Vec<Json>> = tanda.to_vec();
        loop {
            let pagina = match nube.por_clave(PedidoPorClave { tabla: tabla.to_owned(), claves: pendientes.clone() }).await {
                Ok(p) => p,
                // La nube no la sabe buscar (otra clave arriba): se queda sin traer, y con ella las
                // cuarentenas que la tocan. Cualquier otro fallo es de la pasada.
                Err(e) if e.code() == ErrorCode::Validation => {
                    traida.sin_buscar = true;
                    return Ok(Some(traida));
                }
                Err(e) => return Err(e),
            };
            if pagina.hasta_seq != hasta_seq {
                return Ok(None);
            }
            if pagina.tabla != tabla {
                return Err(AppError::external("las filas por clave de la nube son de otra tabla"));
            }
            if !pagina.filas.is_empty() {
                if traida.columnas.is_empty() {
                    traida.columnas = pagina.columnas.clone();
                } else if traida.columnas != pagina.columnas {
                    return Ok(None);
                }
            }
            let posiciones: Option<Vec<usize>> =
                clave.iter().map(|k| traida.columnas.iter().position(|c| c.eq_ignore_ascii_case(k))).collect();
            let antes = traida.filas.len();
            for fila in pagina.filas {
                let Some(posiciones) = posiciones.as_ref() else {
                    traida.sin_buscar = true;
                    return Ok(Some(traida));
                };
                let valores: Vec<Json> = posiciones.iter().filter_map(|i| fila.get(*i).cloned()).collect();
                match crate::filas_tocadas::canonica_de(&FilaTocada { tabla: tabla.to_owned(), clave: valores, borrada: false }) {
                    Some(k) => {
                        traida.filas.insert(k, fila);
                    }
                    None => {
                        traida.sin_buscar = true;
                        return Ok(Some(traida));
                    }
                }
            }
            if !pagina.cortada {
                break;
            }
            // Lo que no ha cabido se vuelve a pedir; una página cortada trae al menos una fila.
            if traida.filas.len() == antes {
                return Err(AppError::external("las filas por clave de la nube no avanzan"));
            }
            pendientes.retain(|k| {
                crate::filas_tocadas::canonica_de(&FilaTocada { tabla: tabla.to_owned(), clave: k.clone(), borrada: false })
                    .is_some_and(|c| !traida.filas.contains_key(&c))
            });
            if pendientes.is_empty() {
                break;
            }
        }
    }
    Ok(Some(traida))
}

/// El valor de una celda que llega de la nube. Un blob (`{"blob": …}`) no se sabe escribir.
fn celda(v: &Json) -> Option<Value> {
    match v {
        Json::Null => Some(Value::Null),
        Json::Bool(b) => Some(Value::Integer(i64::from(*b))),
        Json::Number(n) => n.as_i64().map(Value::Integer).or_else(|| n.as_f64().map(Value::Real)),
        Json::String(s) => Some(Value::Text(s.clone())),
        _ => None,
    }
}

/// Aplica aquí lo que se ha traído de una cuarentena y la cierra, en una transacción. `false` si ya
/// no estaba en cuarentena. Un `Err` deja todo como estaba.
async fn aplicar(
    conn: &Connection,
    c: &Cuarentena,
    arriba: &HashMap<String, Traida>,
    orden: &[String],
    claves: &HashMap<String, Vec<String>>,
) -> AppResult<bool> {
    // Lo que no se ha podido traer, ni se intenta.
    for f in &c.tocadas.filas {
        if crate::sync::no_es_tabla_de_negocio(&f.tabla) {
            continue;
        }
        let Some(t) = arriba.get(&f.tabla) else {
            return Err(AppError::internal("la_nube_no_la_ha_traido"));
        };
        if t.sin_buscar {
            return Err(AppError::internal("la_nube_no_la_sabe_buscar"));
        }
        // Una clave que no es la de la tabla de aquí no dice qué fila es.
        if claves.get(&f.tabla).is_none_or(|k| k.is_empty() || k.len() != f.clave.len()) {
            return Err(AppError::internal("la_clave_no_es_la_de_aqui"));
        }
    }

    let posicion = |tabla: &str| orden.iter().position(|t| t == tabla).unwrap_or(usize::MAX);
    let mut filas: Vec<&FilaTocada> =
        c.tocadas.filas.iter().filter(|f| !crate::sync::no_es_tabla_de_negocio(&f.tabla)).collect();
    filas.sort_by_key(|f| posicion(&f.tabla));

    conn.transaccion(async {
        let mut sigue = conn
            .query("SELECT 1 FROM _Sync_Failed WHERE Op_Id = ?1 AND Quarantined = 1;", vec![Value::Text(c.op_id.clone())])
            .await
            .map_err(db_err)?;
        if sigue.next().await.map_err(db_err)?.is_none() {
            return Ok(false);
        }
        drop(sigue);

        let mut columnas_de: HashMap<&str, Vec<String>> = HashMap::new();
        // Lo que el cambio borraba y arriba ya no está: hijas primero.
        for f in filas.iter().rev() {
            let traida = &arriba[&f.tabla];
            let k = tocadas::canonica_de(f).unwrap_or_default();
            if !f.borrada || traida.filas.contains_key(&k) {
                continue;
            }
            let clave = claves.get(&f.tabla).cloned().unwrap_or_default();
            if clave.len() != f.clave.len() {
                return Err(AppError::internal("la_clave_no_es_la_de_aqui"));
            }
            let donde = clave.iter().enumerate().map(|(i, c)| format!("{} = ?{}", cita(c), i + 1)).collect::<Vec<_>>().join(" AND ");
            let args = f.clave.iter().map(celda).collect::<Option<Vec<_>>>().ok_or_else(|| AppError::internal("clave_ilegible"))?;
            conn.execute(&format!("DELETE FROM {} WHERE {donde};", cita(&f.tabla)), args).await.map_err(db_err)?;
        }
        // Lo que está arriba, como está: padres primero.
        for f in &filas {
            let traida = &arriba[&f.tabla];
            let k = tocadas::canonica_de(f).unwrap_or_default();
            let Some(fila) = traida.filas.get(&k) else { continue };
            let locales = match columnas_de.get(f.tabla.as_str()) {
                Some(c) => c.clone(),
                None => {
                    let c = columnas_locales(conn, &f.tabla).await?;
                    columnas_de.insert(&f.tabla, c.clone());
                    c
                }
            };
            if traida.columnas.iter().any(|c| !locales.iter().any(|l| l.eq_ignore_ascii_case(c))) {
                return Err(AppError::internal("columnas_desconocidas"));
            }
            let clave = claves.get(&f.tabla).cloned().unwrap_or_default();
            let valores = fila.iter().map(celda).collect::<Option<Vec<_>>>().ok_or_else(|| AppError::internal("valor_binario"))?;
            conn.execute(&escribir_como_esta(&f.tabla, &traida.columnas, &clave), valores).await.map_err(db_err)?;
        }
        conn.execute(
            "DELETE FROM _Sync_Failed WHERE Op_Id = ?1 AND Quarantined = 1;",
            vec![Value::Text(c.op_id.clone())],
        )
        .await
        .map_err(db_err)?;
        Ok(true)
    })
    .await
}

async fn columnas_locales(conn: &Connection, tabla: &str) -> AppResult<Vec<String>> {
    let mut filas = conn
        .query("SELECT name FROM pragma_table_info(?1) ORDER BY cid;", vec![Value::Text(tabla.to_owned())])
        .await
        .map_err(db_err)?;
    let mut salida = Vec::new();
    while let Some(f) = filas.next().await.map_err(db_err)? {
        if let Ok(Value::Text(n)) = f.get_value(0) {
            salida.push(n);
        }
    }
    Ok(salida)
}

/// La sentencia que deja una fila como está en la nube: `INSERT … ON CONFLICT(clave) DO UPDATE`.
/// ⚠️ Nunca `INSERT OR REPLACE`: borraría la fila y dispararía las cascadas que la apuntan.
fn escribir_como_esta(tabla: &str, columnas: &[String], clave: &[String]) -> String {
    let lista = columnas.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
    let marcas = (1..=columnas.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
    let objetivo = clave.iter().map(|c| cita(c)).collect::<Vec<_>>().join(", ");
    let asignaciones = columnas
        .iter()
        .filter(|c| !clave.iter().any(|k| k.eq_ignore_ascii_case(c)))
        .map(|c| format!("{} = excluded.{}", cita(c), cita(c)))
        .collect::<Vec<_>>()
        .join(", ");
    let accion = if asignaciones.is_empty() { "DO NOTHING".to_owned() } else { format!("DO UPDATE SET {asignaciones}") };
    format!("INSERT INTO {} ({lista}) VALUES ({marcas}) ON CONFLICT({objetivo}) {accion};", cita(tabla))
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    async fn base(nombre: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(&format!("cuarentenas-bajada-{nombre}"));
        Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap()
    }

    async fn sembrar(db: &Db, sql: &str) {
        let w = db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    async fn fila(db: &Db, op: &str) -> Vec<Value> {
        let r = db.read().await;
        let mut f = r
            .conn()
            .query(
                "SELECT Statements_Json, Last_Error, Filas_Json, Datos_Vaciados_At_Ms, Quarantined, Attempts, Seq \
                   FROM _Sync_Failed WHERE Op_Id = ?1;",
                vec![Value::Text(op.into())],
            )
            .await
            .unwrap();
        let f = f.next().await.unwrap().expect("la fila sigue");
        (0..7).map(|i| f.get_value(i).unwrap()).collect()
    }

    #[test]
    fn la_clase_de_un_error_no_lleva_nada_de_lo_que_escribia() {
        let casos = [
            ("op a (seq 3) sentencia #2: SQLite failure: `UNIQUE constraint failed: Clientes.Email`", "sentencia #2: unique (Clientes.Email)"),
            ("SQLite failure: `FOREIGN KEY constraint failed`", "foreign_key"),
            ("op a (seq 3) sentencia #0: SQLite failure: `NOT NULL constraint failed: Mesas.ID_Zona`", "sentencia #0: not_null (Mesas.ID_Zona)"),
            ("op a (seq 3) sentencia #1: SQLite failure: `CHECK constraint failed: typeof(Importe) IN ('integer','null')`", "sentencia #1: check"),
            ("op a (seq 3) sentencia #0: SQLite failure: `no such table: Tabla_Nueva`", "sentencia #0: tabla_desconocida (Tabla_Nueva)"),
            ("op a (seq 3) sentencia #0: SQLite failure: `table Clientes has no column named Alias`", "sentencia #0: columna_desconocida (Alias)"),
            ("op a (seq 3) sentencia #0: SQLite failure: `RI48: Reservas.Estado no admitido`", "sentencia #0: trigger (RI48)"),
            ("op a (seq 3) sentencia #0: SQLite failure: `horario_solapado`", "sentencia #0: trigger (horario_solapado)"),
            // Lo que no se conoce no se copia: podría llevar un valor.
            ("op a (seq 3) sentencia #0: SQLite failure: `Ana López 600123456`", "sentencia #0: otro"),
            ("algo raro con Ana", "otro"),
        ];
        for (texto, clase) in casos {
            assert_eq!(clase_de_error(Some(texto)).as_deref(), Some(clase), "{texto}");
        }
        assert_eq!(clase_de_error(None), None);
    }

    #[tokio::test]
    async fn a_los_treinta_dias_se_vacian_sus_datos_y_la_fila_se_queda() {
        let db = base("vaciar").await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');").await;
        let sentencias = r#"[{"sql":"INSERT INTO Clientes (ID_Cliente, Nombre, Telefono) VALUES (?1, ?2, ?3);","args":["c1","Ana López","600123456"]}]"#;
        sembrar(
            &db,
            &format!(
                "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms) VALUES
                   ('vieja', 7, '{sentencias}', 5, 1, 'op vieja (seq 7) sentencia #0: SQLite failure: `UNIQUE constraint failed: Clientes.Telefono`', 100, 100),
                   ('reciente', 8, '{sentencias}', 5, 1, 'x', 100, 5000),
                   ('detenida', 9, '{sentencias}', 2, 0, 'x', 100, 100);"
            ),
        )
        .await;

        assert_eq!(vaciar(&db, 1000).await.unwrap(), 1);

        let v = fila(&db, "vieja").await;
        assert_eq!(v[0], Value::Text("[]".into()), "sin sentencias");
        assert_eq!(v[1], Value::Text("sentencia #0: unique (Clientes.Telefono)".into()));
        // Lo que tocó no se sabía (era de antes): se mira por última vez, antes de vaciarla.
        let Value::Text(filas) = &v[2] else { panic!("{v:?}") };
        let t = Tocadas::de_json(filas);
        assert!(!t.incierto, "{filas}");
        assert_eq!(t.filas, vec![FilaTocada { tabla: "Clientes".into(), clave: vec![serde_json::json!("c1")], borrada: false }]);
        assert!(matches!(v[3], Value::Integer(_)));
        assert_eq!((v[4].clone(), v[5].clone(), v[6].clone()), (Value::Integer(1), Value::Integer(5), Value::Integer(7)));
        for (i, valor) in v.iter().enumerate() {
            if let Value::Text(t) = valor {
                assert!(!t.contains("Ana") && !t.contains("600123456"), "columna {i}: {t}");
            }
        }

        // La reciente y la que se está reintentando (sin cuarentena) no se tocan.
        assert_eq!(fila(&db, "reciente").await[0], Value::Text(sentencias.into()));
        assert_eq!(fila(&db, "detenida").await[0], Value::Text(sentencias.into()));
        // Y nada se aplicó: el simulacro no deja la clienta.
        let r = db.read().await;
        let mut f = r.conn().query("SELECT COUNT(*) FROM Clientes;", ()).await.unwrap();
        assert_eq!(f.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 0);
        drop(f);
        drop(r);

        // Una vez.
        assert_eq!(vaciar(&db, 1000).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn se_vacian_todas_por_tandas() {
        // Codex: se leían y simulaban todas de una vez con el escritor cogido. Ahora van por tandas,
        // y se vacían todas igual.
        let db = base("tandas").await;
        sembrar(
            &db,
            r#"WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 45)
               INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms)
               SELECT 'op-' || i, i, '[{"sql":"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES (?1, ?2);","args":["z-' || i || '","Zona de Ana ' || i || '"]}]',
                      5, 1, 'x', 1, 1 FROM s;"#,
        )
        .await;

        assert_eq!(vaciar(&db, 1000).await.unwrap(), 45);
        let r = db.read().await;
        let mut f = r
            .conn()
            .query("SELECT COUNT(*) FROM _Sync_Failed WHERE Statements_Json = '[]' AND Filas_Json LIKE '%z-%';", ())
            .await
            .unwrap();
        assert_eq!(f.next().await.unwrap().unwrap().get::<i64>(0).unwrap(), 45, "todas, con lo que tocaron");
    }

    fn mesa(id: &str) -> FilaTocada {
        FilaTocada { tabla: "Mesas".into(), clave: vec![serde_json::json!(id)], borrada: false }
    }

    #[test]
    fn lo_que_sale_de_un_filtro_no_se_trae_si_lo_apartado_de_la_subida_toca_su_tabla() {
        // Codex: con una fila apartada en la tabla, el filtro de aquí pudo dejar fuera otra que
        // arriba sí lo cumplía. Una fila nombrada por su clave, en cambio, es la que es.
        let subida = tocadas::Estaticas {
            claves: ["Mesas\u{1f}tm-main".to_string()].into_iter().collect(),
            tablas: HashSet::new(),
            todas: ["Mesas".to_string()].into_iter().collect(),
        };
        let sin_cascadas = Cascadas::default();
        let por_clave = Tocadas { tablas: vec!["Mesas".into()], filas: vec![mesa("m2")], incierto: false, por_filtro: vec![], dudosa: false };
        assert!(!choca_con_la_subida(&por_clave, &subida, &sin_cascadas), "otra fila de la tabla, nombrada por su clave");
        let por_filtro = Tocadas { por_filtro: vec!["Mesas".into()], ..por_clave.clone() };
        assert!(choca_con_la_subida(&por_filtro, &subida, &sin_cascadas));
        let la_misma = Tocadas { filas: vec![mesa("m-main")], ..por_clave.clone() };
        assert!(choca_con_la_subida(&la_misma, &subida, &sin_cascadas));
    }

    #[tokio::test]
    async fn un_borrado_no_se_trae_si_sus_cascadas_llegan_a_lo_apartado_de_la_subida() {
        // Codex: borrar aquí una zona que la Handy borró se llevaría por su `ON DELETE CASCADE` las
        // mesas que esta Main le puso y la nube rechazó.
        let db = base("cascadas").await;
        let cascadas = cascadas(&db).await.unwrap();
        let mut de_zonas: Vec<&str> = cascadas.alcanza("Zonas").collect();
        de_zonas.sort_unstable();
        assert!(de_zonas.contains(&"Zonas") && de_zonas.contains(&"Mesas"), "{de_zonas:?}");

        let subida = tocadas::Estaticas {
            claves: ["Mesas\u{1f}tm-main".to_string()].into_iter().collect(),
            tablas: HashSet::new(),
            todas: ["Mesas".to_string()].into_iter().collect(),
        };
        let zona = |borrada| Tocadas {
            tablas: vec!["Zonas".into()],
            filas: vec![FilaTocada { tabla: "Zonas".into(), clave: vec![serde_json::json!("z1")], borrada }],
            incierto: false,
            por_filtro: vec![],
            dudosa: false,
        };
        assert!(choca_con_la_subida(&zona(true), &subida, &cascadas), "su borrado llega a las mesas");
        assert!(!choca_con_la_subida(&zona(false), &subida, &cascadas), "escribirla no borra nada");
    }

    #[test]
    fn una_fila_se_escribe_como_esta_sin_reemplazarla() {
        let sql = escribir_como_esta("Mesas", &["ID_Mesa".into(), "Capacidad".into()], &["ID_Mesa".into()]);
        assert_eq!(
            sql,
            "INSERT INTO \"Mesas\" (\"ID_Mesa\", \"Capacidad\") VALUES (?1, ?2) ON CONFLICT(\"ID_Mesa\") DO UPDATE SET \"Capacidad\" = excluded.\"Capacidad\";"
        );
        let sql = escribir_como_esta("Producto_Alergenos", &["ID_Producto".into(), "ID_Alergeno".into()], &["ID_Producto".into(), "ID_Alergeno".into()]);
        assert!(sql.ends_with("DO NOTHING;"), "{sql}");
        assert!(!sql.contains("REPLACE"));
    }
}
