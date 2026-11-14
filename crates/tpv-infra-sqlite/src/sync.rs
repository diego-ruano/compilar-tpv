//! Adaptador SQLite del puerto `SyncRepository`: aplica en la BD local de la Main las
//! operaciones que llegan de la nube (Opción 3: sentencias ya resueltas), de forma idempotente
//! (por `op_id`) y llevando un checkpoint (`seq`).
//!
//! Tras el refactor de conexiones (`db.rs`): el aplicador corre sobre la **conexión de escritura
//! exclusiva** (vía `Db::write()`), usando su conexión CRUDA (`raw()`) para NO re-capturar los
//! cambios remotos en el outbox. Como el escritor es único, queda serializado con las
//! transacciones de los repos sin necesidad de la antigua "puerta de transacción". Las lecturas
//! del outbox / checkpoint usan el pool de lectura (`Db::read()`).
//!
//! Las tablas de control (`_Sync_*`) las crea `Db::open` al arrancar, así que aquí no hace falta
//! asegurarlas en cada llamada.

use tpv_domain::licensing::{procedencia, Procedencia, Sello};
use crate::consultas::{db_err};
use crate::util::now_ms;
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;
use crate::ejecutor::{Connection, ErrorSql};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::sync::{
    BajadaAplicada, CambioDetenido, ContrasteLocal, MarcaLocal, PaginasDelContraste,
    SyncRepository,
};
use tpv_contracts::sync::{
    BackfillEstado, BootstrapResultado, BootstrapSnapshot, HistoricoPagina, OutboxEntry,
    OutboxFallo, ResumenNube, SqlStatement, SyncChange, SyncHealth,
};

use crate::db::{Db, Writer};
use crate::mapping::v_i64;

pub struct SqliteSyncRepository {
    db: Arc<Db>,
}

impl SqliteSyncRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

/// Margen (en nº de operaciones) que la purga por cursor deja SIN borrar por debajo del checkpoint.
/// Cubre el solape catch-up/live al reconectar: una op con `Seq` ya superado por `Last_Seq` solo
/// puede re-llegar dentro de esa ventana de reconexión, mucho más estrecha que este margen.
const PURGE_CURSOR_MARGIN: i64 = 500;

/// Antigüedad mínima (ms) para que la purga TTL retire un registro ya confirmado en la nube.
const PURGE_TTL_MS: i64 = 72 * 60 * 60 * 1000;

/// Reintentos de una op nube→Main antes de ponerla en CUARENTENA (SYNC-01). AUD-18: el motor los
/// hace dentro de la sesión, con esperas cortas entre ellos (`use_cases::replicacion`), y mientras
/// tanto la bajada está detenida en ella: no se aplica nada posterior ni se mueve el checkpoint.
/// Agotados, la op se salta para no bloquear el resto de la sincronización indefinidamente.
pub(crate) const MAX_APPLY_ATTEMPTS: i64 = 5;

/// Reintentos de una op Main→nube antes de APARTARLA (SYNC-20). Es el espejo de
/// `MAX_APPLY_ATTEMPTS` para la dirección contraria, y existe por el mismo motivo: el outbox es
/// una cola **ordenada**, así que una operación que la nube rechaza siempre no se quedaba
/// reintentando sola — dejaba detenido todo lo que viniera detrás, que es un día de ventas.
///
/// Es más generoso que el de bajada a propósito. Un fallo de subida se reintenta en cada pasada
/// del drenado, que puede dispararse varias veces por minuto (el evento `outbox:pending`), no una
/// vez por ciclo de catch-up. Con 5 se apartaría una operación por un bache de red de segundos.
const MAX_SUBIDA_ATTEMPTS: i64 = 20;

/// SYNC-26 · Las apartadas que repara la fila `alias` de `_Sync_Outbox`, como tabla (`json_each`) de
/// su `Repara_Op_Id`: el `Op_Id` de la apartada que motivó una reparación inmediata o, en las del
/// contraste con la nube, la lista JSON de las que resuelve su plan (SYNC-31, `contraste::encolar_plan`).
fn apartadas_que_repara(alias: &str) -> String {
    format!(
        "json_each(CASE WHEN json_valid({alias}.Repara_Op_Id) AND substr({alias}.Repara_Op_Id, 1, 1) = '[' \
         THEN {alias}.Repara_Op_Id ELSE json_array({alias}.Repara_Op_Id) END)"
    )
}

/// Convierte un escalar JSON al `Value` de la base para enlazarlo como argumento.
fn json_to_value(v: &serde_json::Value) -> Value {
    use serde_json::Value as J;
    match v {
        J::Null => Value::Null,
        J::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        J::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                Value::Null
            }
        }
        J::String(s) => Value::Text(s.clone()),
        // arrays/objetos no deberían llegar como args; los guardamos como texto JSON.
        other => Value::Text(other.to_string()),
    }
}

/// Tope de parámetros (`?`) por sentencia al restaurar. El límite real de SQLite es mayor, pero el
/// margen no compra nada aquí: lo que importa es no volver a una sentencia por fila.
const MAX_PARAMS_POR_SENTENCIA: usize = 900;

/// Las tablas del esquema compartido que sólo usa la nube (`TABLAS_DE_ANDAMIAJE` del worker): el
/// log, el gate de idempotencia y los checkpoints de las Main. En la Main existen vacías, y
/// `Sync_Changes` tiene que seguir estándolo: es lo que deja sin efecto aquí el borrado condicionado
/// del contraste (`contraste.rs::borrado_si_la_nube_no_ha_cambiado`).
const ANDAMIAJE_DE_LA_NUBE: [&str; 3] = ["Sync_Changes", "Applied_Operations", "Sync_Main_Checkpoints"];

/// El freno del PIN: cada lado lleva el suyo y sus filas no viajan (`TABLAS_NO_RESTAURADAS` del
/// worker).
const ESTADO_DE_CADA_LADO: [&str; 1] = ["Intentos_Login"];

/// ¿Es una tabla que no es de negocio? Lo que empieza por `_` es estado local de este equipo (el
/// outbox, el sello del negocio, el resumen de las estadísticas, el progreso del histórico…), lo de
/// `sqlite_` es de SQLite, y están el andamiaje de la nube y el freno del PIN. Nada de eso viaja:
/// aunque la nube lo mandara en un volcado o en una página del histórico, no se restaura ni se
/// rellena encima de lo de aquí. El worker tampoco lo manda (`esTablaDeNegocio`, el mismo criterio).
pub(crate) fn no_es_tabla_de_negocio(nombre: &str) -> bool {
    nombre.starts_with('_')
        || nombre.starts_with("sqlite_")
        || ANDAMIAJE_DE_LA_NUBE.iter().chain(ESTADO_DE_CADA_LADO.iter()).any(|t| t.eq_ignore_ascii_case(nombre))
}

/// Las tablas de negocio realmente presentes en la BD local. El volcado de la nube se filtra contra
/// esto: una Main con una versión por detrás recibirá tablas que su esquema aún no tiene, y eso
/// tiene que informarse, no reventar la recuperación. Las que no son de negocio no están
/// ([`no_es_tabla_de_negocio`]).
async fn tablas_de_negocio_locales(conn: &Connection) -> AppResult<std::collections::HashSet<String>> {
    let mut rows = conn
        .query("SELECT name FROM sqlite_master WHERE type = 'table';", ())
        .await
        .map_err(db_err)?;
    let mut out = std::collections::HashSet::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        if let Ok(Value::Text(n)) = row.get_value(0) {
            if !no_es_tabla_de_negocio(&n) {
                out.insert(n);
            }
        }
    }
    Ok(out)
}

/// Dónde está cada cosa en las filas de una página del histórico.
struct Fila<'a> {
    columnas: &'a [String],
    clave_primaria: &'a [String],
}

impl Fila<'_> {
    /// Los valores de la clave primaria de una fila, para nombrarla en un error. Son
    /// identificadores (UUID, fechas, números), nunca un dato de nadie.
    fn clave(&self, fila: &[serde_json::Value]) -> String {
        self.clave_primaria
            .iter()
            .filter_map(|k| self.columnas.iter().position(|c| c == k).and_then(|i| fila.get(i)))
            .map(|v| match v {
                serde_json::Value::String(s) => s.clone(),
                otro => otro.to_string(),
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// El error de una página del histórico que no entra, con la fila que no entra y por qué.
///
/// Una fila del histórico que choca con OTRA de esta base por un índice único (dos cierres de caja
/// vigentes del mismo periodo, `idx_cierres_un_periodo`) o que no cumple una restricción no se puede
/// saltar: el backfill acabaría sin ella, y el contraste con la nube la vería después como una fila
/// que sobra arriba y la borraría también allí. Tampoco se puede pisar la de aquí. Así que la
/// página no se aplica (la transacción se deshace y el cursor no se mueve), el error dice qué fila
/// y qué restricción, y el siguiente intento la repite: lo normal es que la fila de aquí vaya por
/// detrás de la nube (un cambio suyo todavía en el catch-up) y para entonces ya no choque. Si
/// choca siempre, el histórico se queda sin completar, con el error a la vista, y el contraste no
/// corre (VERIF-01): no se pierde nada mientras alguien lo mira.
///
/// Para nombrar la fila se vuelve a intentar el lote de una en una, dentro de la misma transacción,
/// que se deshará entera.
async fn choque_del_historico(
    conn: &Connection,
    tabla: &str,
    de_una_en_una: &str,
    fila: Fila<'_>,
    lote: &[Vec<serde_json::Value>],
    error: ErrorSql,
) -> AppError {
    if matches!(&error, ErrorSql::SqliteFailure(codigo, _) if codigo & 0xff == 19) {
        for valores in lote {
            if let Err(ErrorSql::SqliteFailure(_, motivo)) =
                conn.execute(de_una_en_una, valores.iter().map(json_to_value).collect::<Vec<_>>()).await
            {
                return AppError::repository(format!(
                    "histórico {tabla}: la fila ({}) choca con otra de esta base o no cumple una restricción \
                     ({motivo}); la página no se aplica y se reintentará",
                    fila.clave(valores)
                ));
            }
        }
    }
    AppError::repository(format!("histórico {tabla}: {error}"))
}

/// El error de una página del histórico que hace fallar el `COMMIT` por una clave foránea: una fila
/// apunta a otra que aquí no está. Se vuelve a meter la página en una transacción que se deshace,
/// se mira con `PRAGMA foreign_key_check` qué fila es y se dice, con su clave y la tabla a la que
/// apunta. `None` si no se encuentra (y entonces vale el error de antes).
async fn foranea_del_historico(
    conn: &Connection,
    pagina: &HistoricoPagina,
    si_ya_esta: &str,
    clave_primaria: &[String],
) -> Option<AppError> {
    let tabla = &pagina.tabla;
    let cols = pagina.columnas.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let marcas = vec!["?"; pagina.columnas.len()].join(", ");
    let insertar = format!("INSERT INTO \"{tabla}\" ({cols}) VALUES ({marcas}) {si_ya_esta};");
    let mut mensaje: Option<String> = None;
    let _ = conn
        .transaccion(async {
            for fila in &pagina.filas {
                conn.execute(&insertar, fila.iter().map(json_to_value).collect::<Vec<_>>()).await.map_err(db_err)?;
            }
            let mut filas = conn.query(&format!("PRAGMA foreign_key_check(\"{tabla}\");"), ()).await.map_err(db_err)?;
            let infraccion = filas.next().await.map_err(db_err)?;
            drop(filas);
            if let Some(f) = infraccion {
                let padre = match f.get_value(2).map_err(db_err)? {
                    Value::Text(t) => t,
                    _ => String::new(),
                };
                let clave = match (f.get_value(1).map_err(db_err)?, clave_primaria.is_empty()) {
                    (Value::Integer(rowid), false) => {
                        let lista = clave_primaria.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
                        let mut fila = conn
                            .query(&format!("SELECT {lista} FROM \"{tabla}\" WHERE rowid = ?1;"), vec![Value::Integer(rowid)])
                            .await
                            .map_err(db_err)?;
                        match fila.next().await.map_err(db_err)? {
                            Some(r) => (0..clave_primaria.len())
                                .map(|i| match r.get_value(i as i32) {
                                    Ok(Value::Text(t)) => t,
                                    Ok(Value::Integer(n)) => n.to_string(),
                                    _ => String::new(),
                                })
                                .collect::<Vec<_>>()
                                .join(", "),
                            None => String::new(),
                        }
                    }
                    _ => String::new(),
                };
                mensaje = Some(format!(
                    "histórico {tabla}: la fila ({clave}) apunta a una de {padre} que aquí no está; la página no se \
                     aplica y se reintentará"
                ));
            }
            // Siempre se deshace: esto sólo era para mirar.
            Err::<(), _>(AppError::internal("diagnóstico de la página del histórico"))
        })
        .await;
    mensaje.map(AppError::repository)
}

/// ¿Es un identificador SQL simple? El volcado llega de la red, y sus nombres de tabla y de columna
/// se interpolan en el SQL (no se pueden enlazar con `?`). Un nombre que no sea `[A-Za-z0-9_]` se
/// descarta: no hay ningún caso legítimo en este esquema y sí una inyección si se deja pasar.
fn identificador_simple(nombre: &str) -> bool {
    !nombre.is_empty()
        && nombre
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

async fn checkpoint(conn: &Connection) -> AppResult<i64> {
    let mut rows = conn
        .query("SELECT Last_Seq FROM _Sync_State WHERE Id = 1 LIMIT 1;", ())
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(r) => Ok(v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0)),
        None => Ok(0),
    }
}

async fn op_already_applied(conn: &Connection, op_id: &str) -> AppResult<bool> {
    let mut rows = conn
        .query(
            "SELECT 1 FROM _Sync_Applied_Ops WHERE Op_Id = ?1 LIMIT 1;",
            vec![Value::Text(op_id.to_string())],
        )
        .await
        .map_err(db_err)?;
    Ok(rows.next().await.map_err(db_err)?.is_some())
}

/// La nube confirma (devolviéndonosla) que una operación NUESTRA está aplicada allí: se retira del
/// outbox. Si no era nuestra, no hay nada que borrar. Si era una reparación, con ella sale lo
/// apartado que reparaba, como al llegar su acuse: el eco puede adelantarse a un acuse perdido.
async fn confirmar_subida(conn: &Connection, op_id: &str) -> AppResult<()> {
    retirar_lo_que_repara(conn, op_id).await?;
    conn.execute(
        "DELETE FROM _Sync_Outbox WHERE Op_Id = ?1;",
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// SYNC-26 · Si `op_id` es una reparación, retira las operaciones apartadas que repara (la que la
/// motivó o, SYNC-31, las que resuelve una del contraste), en la transacción de quien la da por
/// subida. Sólo las apartadas (`Cuarentena = 1`): una que siguiera viva no se toca.
///
/// SYNC-31: y sólo si ninguna otra fila del outbox las repara todavía. Un plan del contraste de más
/// de una operación las lleva en todas, así que se retiran con la última que sube; y si una de ellas
/// no entró y se quedó apartada, siguen ahí, porque lo suyo no está arriba. Lo que se retira a la vez
/// no cuenta (el contraste resuelve a la vez un cobro y su reparación inmediata).
async fn retirar_lo_que_repara(conn: &Connection, op_id: &str) -> AppResult<()> {
    let r = apartadas_que_repara("r");
    let o = apartadas_que_repara("o");
    conn.execute(
        &format!(
            "DELETE FROM _Sync_Outbox \
              WHERE Cuarentena = 1 \
                AND Op_Id IN (SELECT j.value FROM _Sync_Outbox r, {r} j \
                               WHERE r.Op_Id = ?1 AND r.Repara_Op_Id IS NOT NULL) \
                AND NOT EXISTS (SELECT 1 FROM _Sync_Outbox o, {o} k \
                                 WHERE o.Repara_Op_Id IS NOT NULL AND k.value = _Sync_Outbox.Op_Id \
                                   AND o.Op_Id <> ?1 \
                                   AND o.Op_Id NOT IN (SELECT j.value FROM _Sync_Outbox r, {r} j \
                                                        WHERE r.Op_Id = ?1 AND r.Repara_Op_Id IS NOT NULL));"
        ),
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// AUD-18 · El checkpoint pasa por encima de `ch` (sólo hacia delante), y con él su fallo de
/// bajada, si lo tenía: lo que no está en cuarentena es que se ha resuelto (entró, o ya estaba
/// aplicado) y se borra. Es lo único, fuera de la restauración desde la nube (que vacía
/// `_Sync_Failed` en la misma transacción), que mueve `Last_Seq`: así ningún camino deja atrás un
/// fallo sin resolver ni en cuarentena, que nada volvería a intentar y que bloquearía
/// `verificar_nube` para siempre. Lo vigila `el_checkpoint_solo_se_mueve_resolviendo_el_fallo`.
async fn pasar_el_checkpoint(conn: &Connection, ch: &SyncChange) -> AppResult<()> {
    conn.execute(
        "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1 AND Last_Seq < ?1;",
        vec![Value::Integer(ch.seq)],
    )
    .await
    .map_err(db_err)?;
    conn.execute(
        "DELETE FROM _Sync_Failed WHERE Op_Id = ?1 AND Quarantined = 0;",
        vec![Value::Text(ch.op_id.clone())],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Purga por cursor de `_Sync_Applied_Ops`: retira los registros cuyo `Seq` ya quedó superado por
/// el checkpoint con holgura (`PURGE_CURSOR_MARGIN`). Solo afecta a `Seq > 0` (remotos aplicados o
/// anti-ecos ya ascendidos a su Seq real tras el acuse de su lote); los anti-ecos sin ascender (`Seq=0`)
/// quedan intactos —los retira la purga TTL una vez subidos—. Es seguro: un `Seq` por debajo del
/// margen ya no puede volver a llegar (el catch-up pide solo `Seq > Last_Seq`).
async fn purge_by_cursor(conn: &Connection, last_seq: i64) -> AppResult<()> {
    conn.execute(
        "DELETE FROM _Sync_Applied_Ops WHERE Seq > 0 AND Seq <= ?1;",
        vec![Value::Integer(last_seq - PURGE_CURSOR_MARGIN)],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// SYNC-22: encola la reparación de las filas que tocaba una operación apartada, y devuelve
/// cuántas se han encolado.
///
/// ¿Esta operación ya está apartada? (REV-04)
///
/// Es la guardia que hace repetible `outbox_mark_failed`. Una fila que ya está en cuarentena tiene
/// su reparación encolada desde la primera vez: volver a pasar por ahí sólo sumaría copias de la
/// misma reparación y un contador de intentos que ya no significa nada.
async fn ya_apartada(conn: &Connection, op_id: &str) -> AppResult<bool> {
    let mut rows = conn
        .query(
            "SELECT Cuarentena FROM _Sync_Outbox WHERE Op_Id = ?1 LIMIT 1;",
            vec![Value::Text(op_id.to_string())],
        )
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(r) => Ok(v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0) == 1),
        None => Ok(false),
    }
}

/// AUD-19 · ¿Es esta base una copia restaurada que todavía no se ha reconciliado? Por el pool de
/// lectura: se mira antes de tomar el escritor, para guardar la base con `VACUUM INTO`.
async fn reconciliacion_pendiente(db: &Db) -> AppResult<bool> {
    let r = db.read().await;
    let mut rows = r
        .conn()
        .query("SELECT Reconciliation_Pending FROM _Recovery_State WHERE Id = 1;", ())
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(f) => Ok(v_i64(f.get_value(0).map_err(db_err)?).unwrap_or(0) != 0),
        None => Ok(false),
    }
}

/// No reintenta la sentencia rechazada: lee cómo está **ahora** cada fila en la Main —que es el
/// escritor único, o sea la autoridad— y encola un `INSERT … ON CONFLICT DO UPDATE` con su contenido
/// actual. Eso no depende del orden, se puede repetir sin daño y converge; reaplicar la sentencia
/// vieja, en cambio, devolvería la fila a un valor que ya no es cierto.
///
/// SYNC-31: todo en UNA operación, padres primero, y con la comanda entera si lo que tocaba cuelga
/// de una (`sync_reparacion::filas_de_las_comandas`).
///
/// Va por `raw()` y escribe directamente en `_Sync_Outbox`: esta sentencia se fabrica **para**
/// replicarse, no es una escritura de negocio que haya que capturar. Y NO se aplica en local: la
/// fila ya está bien aquí, lo que está mal es la copia de la nube.
async fn encolar_reparaciones(conn: &Connection, op_id: &str) -> AppResult<i64> {
    use crate::sync_reparacion as rep;

    let mut rows = conn
        .query(
            "SELECT Statements_Json FROM _Sync_Outbox WHERE Op_Id = ?1 LIMIT 1;",
            vec![Value::Text(op_id.to_string())],
        )
        .await
        .map_err(db_err)?;
    let Some(fila) = rows.next().await.map_err(db_err)? else {
        return Ok(0);
    };
    let json = match fila.get_value(0).map_err(db_err)? {
        Value::Text(s) => s,
        _ => return Ok(0),
    };
    let stmts: Vec<SqlStatement> = serde_json::from_str(&json).unwrap_or_default();
    if stmts.is_empty() {
        return Ok(0);
    }

    // Las claves primarias se leen del esquema, no de una lista escrita a mano: ocho tablas las
    // tienen compuestas y una lista paralela se queda vieja en cuanto alguien añada la novena.
    let mut cache: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for st in &stmts {
        for palabra in st.sql.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
            if !palabra.is_empty() && !cache.contains_key(palabra) {
                let pks = rep::claves_primarias(conn, palabra).await.unwrap_or_default();
                cache.insert(palabra.to_string(), pks);
            }
        }
    }
    let analisis = rep::analizar(&stmts, &|t: &str| cache.get(t).cloned().unwrap_or_default());

    if analisis.incierto {
        tracing::warn!(
            "op {op_id}: hay sentencias cuya fila no se ha sabido identificar; esa parte NO se repara"
        );
    }
    for t in &analisis.borrados {
        // Un borrado no se puede expresar como estado: la ausencia de una fila no es una fila.
        tracing::warn!("op {op_id}: borrado en {t} sin reparación posible por estado (SYNC-23)");
    }

    // SYNC-31: si algo de lo que tocaba cuelga de una comanda, la comanda va entera. Un cobro que la
    // nube rechaza porque una Handy borró el ticket mientras subía necesita lo que el borrado se
    // llevó (la comanda y sus líneas) y lo que el cobro escribió con un `INSERT … SELECT` (las
    // líneas del cobro, sus consumos), que el analizador no sabe leer.
    let foraneas = rep::foraneas(conn).await.map_err(db_err)?;
    let mut filas = analisis.filas.clone();
    let comandas = rep::comandas_de(conn, &foraneas, &analisis.filas).await.map_err(db_err)?;
    if !comandas.is_empty() {
        match rep::filas_de_las_comandas(conn, &foraneas, &comandas).await.map_err(db_err)? {
            Some(enteras) => filas.extend(enteras),
            None => tracing::warn!(
                "op {op_id}: la comanda afectada pasa de {} filas; se repara sólo lo que tocaba la operación",
                rep::MAX_FILAS_DE_LAS_COMANDAS
            ),
        }
    }
    let sentencias = sentencias_padres_primero(conn, &foraneas, filas).await?;
    if sentencias.is_empty() {
        return Ok(0);
    }

    let n = sentencias.len() as i64;
    let nuevo_op = uuid::Uuid::now_v7().to_string();
    let ahora = now_ms();
    // Se anota de qué operación apartada viene: cuando esta reparación suba, aquélla deja de tener
    // sentido y se retira (ver `outbox_confirmar_lote`). Sin el enlace, el aviso de cuarentena no se
    // apagaría nunca aunque el problema ya estuviera resuelto.
    conn.execute(
        "INSERT INTO _Sync_Outbox \
           (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Repara_Op_Id) \
         VALUES (?1, ?2, ?3, ?4, ?5);",
        vec![
            Value::Text(nuevo_op.clone()),
            Value::Text(rep::COMANDO_REPARACION.to_string()),
            Value::Text(serde_json::to_string(&sentencias).unwrap_or_else(|_| "[]".into())),
            Value::Integer(ahora),
            Value::Text(op_id.to_string()),
        ],
    )
    .await
    .map_err(db_err)?;
    // Anti-eco, igual que cualquier escritura capturada: sin esto la reparación volvería por el
    // catch-up y se aplicaría otra vez en local.
    conn.execute(
        "INSERT OR IGNORE INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, 0, ?2);",
        vec![Value::Text(nuevo_op), Value::Integer(ahora)],
    )
    .await
    .map_err(db_err)?;

    tracing::info!("op {op_id} apartada: encoladas {n} fila(s) de reparación");
    Ok(n)
}

/// SYNC-31 · Las sentencias que dejan arriba estas filas como están aquí, en UNA operación y en el
/// orden en que pueden entrar: las tablas por sus claves foráneas, padres primero, y dentro de una
/// que se apunta a sí misma (`Pagos`, con sus devoluciones), cada fila detrás de aquélla a la que
/// apunta. Una fila repetida va una vez; una que aquí ya no está o que lleva un blob, ninguna.
async fn sentencias_padres_primero(
    conn: &Connection,
    foraneas: &[crate::sync_reparacion::Foranea],
    filas: Vec<crate::sync_reparacion::FilaAfectada>,
) -> AppResult<Vec<SqlStatement>> {
    use crate::sync_reparacion as rep;
    let mut vistas = std::collections::HashSet::new();
    let mut por_tabla: std::collections::HashMap<String, Vec<rep::FilaAfectada>> = std::collections::HashMap::new();
    for f in filas {
        if vistas.insert(f.clone()) {
            por_tabla.entry(f.tabla.clone()).or_default().push(f);
        }
    }
    let nombres: Vec<String> = por_tabla.keys().cloned().collect();
    let mut padres: std::collections::HashMap<String, std::collections::HashSet<String>> = std::collections::HashMap::new();
    for f in foraneas {
        padres.entry(f.hija.clone()).or_default().insert(f.padre.clone());
    }
    let mut sentencias = Vec::new();
    for (tabla, _) in crate::contraste::ordenar_padres_primero(&nombres, &padres) {
        let mut de_la_tabla = Vec::new();
        for f in &por_tabla[&tabla] {
            if let Ok(Some(st)) = rep::sentencia_de_reparacion(conn, f).await {
                de_la_tabla.push(st);
            }
        }
        let refs = crate::contraste::autorreferencias(conn, &tabla).await?;
        sentencias.extend(crate::contraste::padres_antes(de_la_tabla, &refs));
    }
    Ok(sentencias)
}

/// SYNC-36 · Lo que se sabe ya de las filas que toca este cambio, de un intento anterior.
async fn filas_ya_sabidas(conn: &Connection, op_id: &str) -> AppResult<Option<crate::filas_tocadas::Tocadas>> {
    let mut rows = conn
        .query("SELECT Filas_Json FROM _Sync_Failed WHERE Op_Id = ?1 LIMIT 1;", vec![Value::Text(op_id.to_string())])
        .await
        .map_err(db_err)?;
    Ok(match rows.next().await.map_err(db_err)?.map(|f| f.get_value(0)) {
        Some(Ok(Value::Text(t))) => Some(crate::filas_tocadas::Tocadas::de_json(&t)),
        _ => None,
    })
}

/// SYNC-36 · Las filas que toca un cambio que acaba de fallar, si no se sabían ya: se miran con la
/// base de justo antes del cambio y con lo apartado de la subida de ahora (`dudosa`), que se arrastra
/// de un intento a otro.
async fn mirar_lo_que_toca(db: &Db, conn: &Connection, ch: &SyncChange) -> AppResult<Option<String>> {
    let antes = filas_ya_sabidas(conn, &ch.op_id).await?;
    if antes.as_ref().is_some_and(|t| !t.incierto) {
        return Ok(None);
    }
    let mut ahora = crate::filas_tocadas::de_un_cambio(conn, &ch.statements).await;
    ahora.dudosa |= antes.is_some_and(|t| t.dudosa);
    crate::cuarentenas_bajada::marcar_si_dudosa(db, &mut ahora).await?;
    Ok(Some(ahora.a_json()))
}

/// Registra (o incrementa) el fallo de una op en `_Sync_Failed` y devuelve el nº de intentos
/// acumulados. Sirve de contador persistente entre ciclos de catch-up para decidir la cuarentena.
///
/// SYNC-36: `tocadas` son las filas que toca el cambio (`filas_tocadas`), si se han mirado. Se
/// guardan las primeras que se saben; unas inciertas se sustituyen por las de otro intento.
async fn bump_failure(conn: &Connection, ch: &SyncChange, err: &str, tocadas: Option<&str>) -> AppResult<i64> {
    let now = now_ms();
    let stmts_json = serde_json::to_string(&ch.statements).unwrap_or_else(|_| "[]".to_string());
    let err_trunc: String = err.chars().take(500).collect();
    conn.execute(
        "INSERT INTO _Sync_Failed \
           (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms, Filas_Json) \
         VALUES (?1, ?2, ?3, 1, 0, ?4, ?5, ?5, ?6) \
         ON CONFLICT(Op_Id) DO UPDATE SET \
           Attempts = Attempts + 1, Last_Error = ?4, Last_Failed_At_Ms = ?5, \
           Filas_Json = CASE WHEN Filas_Json IS NULL OR json_extract(Filas_Json, '$.incierto') THEN COALESCE(?6, Filas_Json) \
                             ELSE Filas_Json END;",
        vec![
            Value::Text(ch.op_id.clone()),
            Value::Integer(ch.seq),
            Value::Text(stmts_json),
            Value::Text(err_trunc),
            Value::Integer(now),
            tocadas.map_or(Value::Null, |t| Value::Text(t.to_owned())),
        ],
    )
    .await
    .map_err(db_err)?;

    let mut rows = conn
        .query(
            "SELECT Attempts FROM _Sync_Failed WHERE Op_Id = ?1 LIMIT 1;",
            vec![Value::Text(ch.op_id.clone())],
        )
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(r) => Ok(v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(1)),
        None => Ok(1),
    }
}

/// Pone una op en CUARENTENA: la marca como aplicada (para que el gate de idempotencia la salte),
/// deja constancia en `_Sync_Failed` (Quarantined=1, visible en el panel de salud) y AVANZA el
/// checkpoint para no volver a pedirla. El resto del pipeline puede así seguir convergiendo.
///
/// ⚠️ AUD-18: sólo dentro de la transacción de `anotar_fallo`. Las tres cosas van juntas o ninguna.
async fn quarantine(conn: &Connection, ch: &SyncChange) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, ?2, ?3);",
        vec![
            Value::Text(ch.op_id.clone()),
            Value::Integer(ch.seq),
            Value::Integer(now_ms()),
        ],
    )
    .await
    .map_err(db_err)?;
    conn.execute(
        "UPDATE _Sync_Failed SET Quarantined = 1 WHERE Op_Id = ?1;",
        vec![Value::Text(ch.op_id.clone())],
    )
    .await
    .map_err(db_err)?;
    pasar_el_checkpoint(conn, ch).await?;
    Ok(())
}

/// AUD-18 · Qué fue de un cambio con el que `apply_one` falló.
enum Fallo {
    /// Su `Seq` no pasa del checkpoint: ya se procesó, y no hay nada que reintentar ni anotar.
    YaProcesado,
    /// Anotado en `_Sync_Failed`, con los intentos que lleva: la bajada se detiene en él.
    Anotado(i64),
    /// Agotó los intentos: en cuarentena, y el checkpoint ya pasó por encima.
    Cuarentena(i64),
}

/// AUD-18 · Lo que queda de un cambio que no entró, en UNA transacción: la confirmación de su
/// subida, el intento contado y, agotados los intentos, la cuarentena (el marcador de
/// `_Sync_Applied_Ops`, la marca en `_Sync_Failed` y el checkpoint). Eran sentencias sueltas, cada
/// una con su commit, y una copia (`VACUUM INTO`) podía fotografiar el marcador sin el checkpoint:
/// al restaurarla, el catch-up traía el cambio, el gate lo daba por aplicado y el checkpoint lo
/// dejaba atrás sin haberlo aplicado nunca.
///
/// SYNC-36: `tocadas`, las filas que toca el cambio, se guardan con el fallo (`bump_failure`).
async fn anotar_fallo(conn: &Connection, ch: &SyncChange, err: &str, tocadas: Option<&str>) -> AppResult<Fallo> {
    conn.transaccion(async {
        // El ROLLBACK de `apply_one` se llevó también la confirmación de subida, y ésa no depende
        // de que aquí se pueda aplicar: el cambio ha vuelto de la nube, así que allí está.
        confirmar_subida(conn, &ch.op_id).await?;

        // AUD-18: lo que no pasa del checkpoint (releído aquí, en esta transacción) ya se procesó:
        // un duplicado con el que `apply_one` falló por algo pasajero. No se anota. Anotarlo dejaría
        // un fallo por debajo del checkpoint que nada volvería a intentar y que bloquearía
        // `verificar_nube`; el que hubiera de antes, se resuelve.
        if ch.seq <= checkpoint(conn).await? {
            resolver_fallo_ya_procesado(conn, &ch.op_id).await?;
            return Ok(Fallo::YaProcesado);
        }

        // AUD-18: si era el eco de una escritura propia (su anti-eco está, sin `Seq` todavía: el
        // acuse de su lote se perdió), el anti-eco pasa a llevar el `Seq` del eco.
        // `confirmar_subida` acaba de sacarla del outbox, y un anti-eco con `Seq = 0` fuera del
        // outbox es lo que la purga TTL retira: el reintento volvería a aplicar la escritura.
        // Con su `Seq`, por delante del checkpoint, la purga no lo toca hasta que el eco entre.
        conn.execute(
            "UPDATE _Sync_Applied_Ops SET Seq = ?1 WHERE Op_Id = ?2 AND Seq = 0;",
            vec![Value::Integer(ch.seq), Value::Text(ch.op_id.clone())],
        )
        .await
        .map_err(db_err)?;

        let attempts = bump_failure(conn, ch, err, tocadas).await?;
        if attempts >= MAX_APPLY_ATTEMPTS {
            quarantine(conn, ch).await?;
            return Ok(Fallo::Cuarentena(attempts));
        }
        Ok(Fallo::Anotado(attempts))
    })
    .await
}

/// AUD-18 · Un cambio que ya se procesó (su `Seq` no pasa del checkpoint) y que tiene un fallo sin
/// cuarentena: el fallo se resuelve. Si la operación consta como procesada (`_Sync_Applied_Ops`),
/// se borra. Si no, es un fallo de antes de AUD-18, de cuando el checkpoint se saltaba lo que fallaba:
/// ese cambio no se aplicó nunca, y pasa a cuarentena, que es lo que es. Así no queda nada por
/// debajo del checkpoint sin resolver ni en cuarentena.
async fn resolver_fallo_ya_procesado(conn: &Connection, op_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM _Sync_Failed \
          WHERE Op_Id = ?1 AND Quarantined = 0 \
            AND EXISTS (SELECT 1 FROM _Sync_Applied_Ops WHERE Op_Id = ?1);",
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    conn.execute(
        "UPDATE _Sync_Failed SET Quarantined = 1 WHERE Op_Id = ?1 AND Quarantined = 0;",
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// RI-33: cuántos cambios se aplican seguidos antes de soltar el escritor. Una página de catch-up
/// son hasta 500, y con el escritor cogido para toda ella ningún cobro podía escribir: tras una
/// tarde sin red, la reconexión congelaba la caja unos segundos. Soltarlo entre cambios es seguro
/// porque cada uno es su propia transacción y avanza su propio checkpoint.
const CAMBIOS_POR_TURNO_DE_ESCRITOR: usize = 50;

/// Qué pasó con un cambio que no falló.
enum Aplicacion {
    /// Ya estaba aplicado (re-broadcast, eco de nuestras escrituras, cuarentena): sólo se avanzó
    /// el checkpoint.
    YaEstaba,
    Aplicada,
    /// AUD-18: su `Seq` no pasa del checkpoint, así que ya se procesó (aplicado, saltado o
    /// apartado). No se aplica ni mueve nada.
    YaProcesada,
    /// AUD-18: hay un cambio anterior detenido. Éste no entra hasta que aquél entre o pase a
    /// cuarentena.
    Bloqueada(CambioDetenido),
}

/// AUD-18 · El cambio detenido que va por delante de `seq`: un fallo de `_Sync_Failed` sin
/// cuarentena con `Seq` entre el checkpoint y `seq`. Mientras exista, nada posterior entra.
async fn detenido_antes_de(
    conn: &Connection,
    seq: i64,
    checkpoint: i64,
) -> AppResult<Option<CambioDetenido>> {
    let mut rows = conn
        .query(
            "SELECT Op_Id, Seq, Attempts FROM _Sync_Failed \
              WHERE Quarantined = 0 AND Seq > ?1 AND Seq < ?2 \
              ORDER BY Seq LIMIT 1;",
            vec![Value::Integer(checkpoint), Value::Integer(seq)],
        )
        .await
        .map_err(db_err)?;
    let Some(r) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    let op_id = match r.get_value(0).map_err(db_err)? {
        Value::Text(s) => s,
        _ => String::new(),
    };
    Ok(Some(CambioDetenido {
        op_id,
        seq: v_i64(r.get_value(1).map_err(db_err)?).unwrap_or(0),
        intentos: v_i64(r.get_value(2).map_err(db_err)?).unwrap_or(0),
    }))
}

/// Aplica un cambio en UNA transacción: la confirmación de subida, el gate de idempotencia, sus
/// sentencias, el registro de idempotencia, el avance del checkpoint y la limpieza de un fallo
/// anterior. Antes eran la transacción más cuatro sentencias sueltas en autocommit, cada una con su
/// propio commit (RI-33). `defer_foreign_keys` evita fallos por orden dentro de la propia
/// operación. Corre sobre la conexión CRUDA de escritura (sin captura).
///
/// SYNC-29: `marcas` son las filas que toca el cambio y que esta Main puede tener de otra forma que
/// la nube (`convergencia::Carrera`); si se aplica, se apuntan en la misma transacción.
async fn apply_one(conn: &Connection, ch: &SyncChange, marcas: &[crate::filas_tocadas::FilaTocada]) -> AppResult<Aplicacion> {
    let res: AppResult<Aplicacion> = conn.transaccion(async {
        // AUD-18: nada pasa por delante de uno anterior que falló y no se ha resuelto. Va lo
        // primero, antes incluso de dar por confirmada una subida: un cambio que no se procesa ahora
        // volverá por el catch-up, y si fuera el eco de una escritura propia, sacarla ya del outbox
        // dejaría su anti-eco a merced de la purga TTL antes de que vuelva. Y va antes que el gate de
        // idempotencia: tampoco ese eco puede llevar el checkpoint por encima del detenido.
        let cp = checkpoint(conn).await?;
        if ch.seq > cp {
            if let Some(detenido) = detenido_antes_de(conn, ch.seq, cp).await? {
                return Ok(Aplicacion::Bloqueada(detenido));
            }
        }

        // Que un cambio VUELVA de la nube es la prueba de que allí se aplicó. Si era una de las
        // nuestras (subida, y el acuse de su lote se perdió), esta es su confirmación: se retira
        // del outbox y deja de estar pendiente.
        confirmar_subida(conn, &ch.op_id).await?;

        // AUD-18: la bajada va en orden de `Seq` y el checkpoint sólo pasa por encima de lo que
        // ya se procesó. Lo que llega por debajo (un reenvío, el solape del catch-up con lo que
        // llegó en vivo al conectar) no se aplica otra vez, aunque su registro de idempotencia ya
        // se haya purgado: repetiría un `Stock - 1` o devolvería una fila a un valor viejo.
        if ch.seq <= cp {
            tracing::warn!(
                target: "tpv::sync",
                op_id = %ch.op_id,
                seq = ch.seq,
                checkpoint = cp,
                "cambio de la nube por debajo del checkpoint: ya procesado, no se aplica"
            );
            // Y si tenía un fallo anotado (por debajo del checkpoint, nada lo reintentaría), se
            // resuelve con él.
            resolver_fallo_ya_procesado(conn, &ch.op_id).await?;
            return Ok(Aplicacion::YaProcesada);
        }

        // Idempotencia: una op ya aplicada (re-broadcast, solape con el catch-up, eco de las
        // propias escrituras de la Main o una op en cuarentena) se ignora, pero igualmente avanza
        // el checkpoint. AUD-18: y si era el reintento de un fallo (el eco propio cuyo checkpoint no
        // se pudo mover), el fallo se resuelve con él; si no, quedaría por debajo del checkpoint
        // sin que nada lo reintentara.
        if op_already_applied(conn, &ch.op_id).await? {
            pasar_el_checkpoint(conn, ch).await?;
            return Ok(Aplicacion::YaEstaba);
        }

        for (i, st) in ch.statements.iter().enumerate() {
            let args: Vec<Value> = st.args.iter().map(json_to_value).collect();
            conn.execute(&st.sql, args).await.map_err(|e| {
                // El SQL queda SÓLO en el log local a nivel `debug` (no se reenvía a la nube: la
                // capa de telemetría descarta DEBUG/TRACE). El error que se PROPAGA no incluye la
                // sentencia, para no filtrar esquema/valores a la telemetría (OBS-02).
                tracing::debug!(
                    target: "tpv::sync",
                    op_id = %ch.op_id,
                    seq = ch.seq,
                    stmt_index = i,
                    sql = %st.sql.split_whitespace().collect::<Vec<_>>().join(" "),
                    "fallo aplicando sentencia de sync"
                );
                AppError::repository(format!(
                    "op {} (seq {}) sentencia #{i}: {e}",
                    ch.op_id, ch.seq,
                ))
            })?;
        }

        conn.execute(
            "INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, ?2, ?3);",
            vec![
                Value::Text(ch.op_id.clone()),
                Value::Integer(ch.seq),
                Value::Integer(now_ms()),
            ],
        )
        .await
        .map_err(db_err)?;

        // SYNC-29: lo que la nube ordenó de otra forma, para traerlo cuando lo de aquí esté subido.
        // Que no se pueda apuntar no detiene la bajada: lo que quede distinto lo verá el contraste.
        if let Err(e) = crate::convergencia::marcar(conn, marcas, ch.seq).await {
            tracing::warn!(target: "tpv::sync", op_id = %ch.op_id, seq = ch.seq, error = %e, "SYNC-29: no se han podido apuntar las filas del cambio");
        }

        // Éxito (posible recuperación de un fallo transitorio previo): limpia su marca.
        pasar_el_checkpoint(conn, ch).await?;

        Ok(Aplicacion::Aplicada)
    }).await;

    res
}

#[async_trait]
impl SyncRepository for SqliteSyncRepository {
    async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<BajadaAplicada> {
        // Se anota lo que se aplica DE VERDAD. Lo que el gate de idempotencia salta (un
        // re-broadcast, el eco de nuestras propias escrituras al volver por el catch-up, una op en
        // cuarentena) no cambió nada en esta BD, así que el frontend no tiene por qué reaccionar.
        let mut aplicadas: Vec<String> = Vec::new();
        let mut detenida: Option<CambioDetenido> = None;

        'lote: for tramo in changes.chunks(CAMBIOS_POR_TURNO_DE_ESCRITOR) {
            // Acceso EXCLUSIVO de escritura, pero por tramos (RI-33): serializa con las
            // transacciones de los repos (un único escritor) y entre tramo y tramo deja pasar a
            // quien espera, un cobro por ejemplo. Conexión CRUDA → no se re-captura en el outbox.
            let w = self.db.write().await;
            let conn: &Connection = w.raw();
            // SYNC-29: lo de aquí que la nube todavía no ha ordenado. Con el escritor cogido, dentro
            // del tramo no entra nada nuevo.
            let mut carrera = crate::convergencia::Carrera::leer(conn).await?;

            for ch in tramo {
                // Las filas que este cambio toca en tablas en las que esta Main tiene escrituras sin
                // ordenar: aquí van detrás de ellas y en la nube irán delante. Se miran con la base
                // de justo antes del cambio.
                let marcas = match carrera.alcance(ch) {
                    Some(alcance) => crate::convergencia::filas_a_marcar(conn, ch, &alcance).await,
                    None => Vec::new(),
                };
                let resultado = apply_one(conn, ch, &marcas).await;
                // Lo que baje después de un eco propio va también después en la nube.
                carrera.ya_ordenada(&ch.op_id);
                let e = match resultado {
                    Ok(Aplicacion::Aplicada) => {
                        aplicadas.push(ch.op_id.clone());
                        continue;
                    }
                    Ok(Aplicacion::YaEstaba | Aplicacion::YaProcesada) => continue,
                    // AUD-18: hay uno anterior detenido; la tanda se para aquí sin gastarle
                    // intentos a éste.
                    Ok(Aplicacion::Bloqueada(anterior)) => {
                        detenida = Some(anterior);
                        break 'lote;
                    }
                    Err(e) => e,
                };

                // SYNC-01: política de poison-message. Contamos el intento; agotados los
                // reintentos, ponemos la op en cuarentena (se salta + avanza checkpoint +
                // alerta) para NO bloquear el resto de la cola indefinidamente. AUD-18: todo en
                // una transacción (`anotar_fallo`).
                //
                // SYNC-36: con el fallo se guardan las filas que toca, para poder traerlas de la nube
                // si acaba en cuarentena. Se miran ahora, con la base de justo antes del cambio, y
                // sólo si no se saben ya de un intento anterior.
                let tocadas = mirar_lo_que_toca(&self.db, conn, ch).await?;
                let (attempts, cuarentena) = match anotar_fallo(conn, ch, &e.to_string(), tocadas.as_deref()).await? {
                    // AUD-18: un duplicado de algo ya procesado: no se anota ni detiene nada.
                    Fallo::YaProcesado => {
                        tracing::warn!(
                            target: "tpv::sync",
                            op_id = %ch.op_id,
                            seq = ch.seq,
                            error = %e,
                            "fallo descartando un cambio ya procesado; no se anota"
                        );
                        continue;
                    }
                    Fallo::Anotado(intentos) => (intentos, false),
                    Fallo::Cuarentena(intentos) => (intentos, true),
                };
                if cuarentena {
                    tracing::error!(
                        target: "tpv::sync",
                        op_id = %ch.op_id,
                        seq = ch.seq,
                        attempts,
                        error = %e,
                        "op de sync en CUARENTENA tras agotar reintentos: se salta para no bloquear el pipeline"
                    );
                    // Cuarentenada: seguimos, en orden, con el resto del lote.
                } else {
                    // AUD-18: aún dentro del margen. La bajada se detiene aquí SIN avanzar el
                    // checkpoint: no se aplica nada posterior hasta que ésta entre o se aparte, y
                    // el motor la reintenta dentro de la sesión, tras una espera corta.
                    tracing::warn!(
                        target: "tpv::sync",
                        op_id = %ch.op_id,
                        seq = ch.seq,
                        attempts,
                        error = %e,
                        "fallo aplicando op de sync; la bajada se detiene aquí y se reintentará"
                    );
                    detenida = Some(CambioDetenido {
                        op_id: ch.op_id.clone(),
                        seq: ch.seq,
                        intentos: attempts,
                    });
                    break 'lote;
                }
            }
        }

        // Cada vez que el checkpoint avanza (por catch-up o por cambios en vivo) intentamos retirar
        // los registros de idempotencia ya superados. Coste despreciable (DELETE indexado) y solo
        // borra filas seguras.
        let w = self.db.write().await;
        let conn: &Connection = w.raw();
        let last_seq = checkpoint(conn).await?;
        purge_by_cursor(conn, last_seq).await?;
        Ok(BajadaAplicada {
            aplicadas,
            last_seq,
            detenida,
        })
    }

    async fn cambio_detenido(&self) -> AppResult<Option<SyncChange>> {
        // AUD-18: el que no ha entrado ni está en cuarentena y va por delante del checkpoint.
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT Op_Id, Seq, Statements_Json FROM _Sync_Failed \
                  WHERE Quarantined = 0 \
                    AND Seq > (SELECT Last_Seq FROM _Sync_State WHERE Id = 1) \
                  ORDER BY Seq LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        let Some(fila) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };
        let op_id = match fila.get_value(0).map_err(db_err)? {
            Value::Text(s) => s,
            _ => return Err(AppError::repository("Cambio detenido sin operación")),
        };
        let seq = v_i64(fila.get_value(1).map_err(db_err)?).unwrap_or(0);
        let statements: Vec<SqlStatement> = match fila.get_value(2).map_err(db_err)? {
            Value::Text(s) => serde_json::from_str(&s).map_err(|_| {
                AppError::repository(format!("Sentencias ilegibles del cambio detenido {op_id}"))
            })?,
            _ => return Err(AppError::repository("Cambio detenido sin sentencias")),
        };
        Ok(Some(SyncChange { op_id, seq, statements }))
    }

    async fn get_checkpoint(&self) -> AppResult<i64> {
        let r = self.db.read().await;
        checkpoint(r.conn()).await
    }

    async fn outbox_pending(&self, limit: i64) -> AppResult<Vec<OutboxEntry>> {
        // Tras un traslado de licencia no sube nada: lo que hay en este outbox es de antes, y la
        // nube ya tiene lo que hizo el otro equipo desde entonces. Subirlo lo pisaría. Se descarta
        // al reconstruir la base (`bootstrap_restaurar`), que guarda antes una copia.
        if crate::recovery::hay_traslado_pendiente(self.db.carpeta()) {
            return Ok(Vec::new());
        }

        let r = self.db.read().await;
        let conn = r.conn();

        // SYNC-20: se excluyen las APARTADAS. Una operación que la nube rechaza de forma
        // permanente no vuelve a ofrecerse: si volviera, el drenado la reintentaría, fallaría otra
        // vez y pararía ahí — que es exactamente el atasco que la cuarentena existe para romper.
        // Su fila NO se borra (es lo único que queda de un dato que la nube no tiene), sólo deja
        // de bloquear a las de detrás.
        let mut rows = conn
            .query(
                "SELECT Seq, Op_Id, Command_Name, Statements_Json \
                 FROM _Sync_Outbox \
                 WHERE Cuarentena = 0 \
                 ORDER BY Seq ASC LIMIT ?1;",
                vec![Value::Integer(limit)],
            )
            .await
            .map_err(db_err)?;

        let mut out = Vec::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let seq = v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0);
            let op_id = match r.get_value(1).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let command_name = match r.get_value(2).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "main_op".to_string(),
            };
            let statements_json = match r.get_value(3).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "[]".to_string(),
            };
            let statements: Vec<SqlStatement> =
                serde_json::from_str(&statements_json).unwrap_or_default();

            out.push(OutboxEntry {
                seq,
                op_id,
                command_name,
                statements,
            });
        }

        Ok(out)
    }

    async fn outbox_confirmar_lote(&self, confirmadas: &[(String, i64)]) -> AppResult<()> {
        if confirmadas.is_empty() {
            return Ok(());
        }
        // Tras el acuse de un lote, por cada operación que la nube ha confirmado: (1) ascendemos el
        // anti-eco de `_Sync_Applied_Ops` a su `Seq` real (la nube ya ordenó la op) para que la
        // purga por cursor pueda retirarlo más tarde; y (2) borramos la fila del outbox (ya subida).
        // Ambas tablas de control van por la conexión CRUDA de escritura (no deben capturarse como
        // cambio de negocio) y quedan serializadas por el escritor único. Todo el lote va en UNA
        // transacción: un anti-eco con Seq>0 implica invariablemente "ya no está en el outbox", y
        // un corte a mitad deja el lote confirmado entero o sin confirmar (y entonces vuelve a
        // subir, y la nube contesta «ya estaba»).
        let w = self.db.write().await;
        let conn = w.raw();

        conn.transaccion(async {
            for (op_id, seq) in confirmadas {
                if *seq > 0 {
                    conn.execute(
                        "UPDATE _Sync_Applied_Ops SET Seq = ?1 WHERE Op_Id = ?2 AND Seq = 0;",
                        vec![Value::Integer(*seq), Value::Text(op_id.clone())],
                    )
                    .await
                    .map_err(db_err)?;
                }
                // SYNC-26: si lo que acaba de subir es una REPARACIÓN, la operación apartada que la
                // motivó ya no dice nada — la nube tiene el dato. Se retira, y con ella su aviso.
                //
                // Va DENTRO de la misma transacción que borra la reparación, y no después: si el
                // proceso muriera entre las dos, quedaría una cuarentena eterna por un problema ya
                // resuelto, que es exactamente lo que esto arregla.
                retirar_lo_que_repara(conn, op_id).await?;
                conn.execute(
                    "DELETE FROM _Sync_Outbox WHERE Op_Id = ?1;",
                    vec![Value::Text(op_id.clone())],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(())
        })
        .await
    }

    async fn outbox_mark_failed(
        &self,
        op_id: &str,
        error: &str,
        permanente: bool,
    ) -> AppResult<OutboxFallo> {
        // Espejo de `bump_failure`/`quarantine` (la cuarentena de bajada) para la dirección
        // contraria. Va por `raw()`: `_Sync_Outbox` es andamiaje local y capturarlo como escritura
        // de negocio replicaría a la nube el estado de la cola que le estamos ocultando.
        let w = self.db.write().await;
        let conn = w.raw();
        let err_trunc: String = error.chars().take(500).collect();

        conn.transaccion(async {
        // REV-04: anotar dos veces el mismo fallo tiene que ser inocuo. Una apartada deja de
        // ofrecerse, pero el acuse de un lote puede traer el veredicto de una que se apartó
        // mientras el lote estaba en vuelo. Sin esta salida, cada repetición encolaría OTRA
        // reparación de las mismas filas.
        if ya_apartada(conn, op_id).await? {
            return Ok(OutboxFallo::default());
        }

        conn.execute(
            "UPDATE _Sync_Outbox \
                SET Intentos = Intentos + 1, Ultimo_Error = ?1, Ultimo_Intento_Ms = ?2 \
              WHERE Op_Id = ?3;",
            vec![
                Value::Text(err_trunc),
                Value::Integer(now_ms()),
                Value::Text(op_id.to_string()),
            ],
        )
        .await
        .map_err(db_err)?;

        let mut rows = conn
            .query(
                "SELECT Intentos, Command_Name FROM _Sync_Outbox WHERE Op_Id = ?1 LIMIT 1;",
                vec![Value::Text(op_id.to_string())],
            )
            .await
            .map_err(db_err)?;
        let (intentos, command_name) = match rows.next().await.map_err(db_err)? {
            Some(r) => (
                v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(1),
                match r.get_value(1).map_err(db_err)? {
                    Value::Text(s) => s,
                    _ => "main_op".to_string(),
                },
            ),
            // La fila ya no está: otra pasada la subió o la apartó. No hay nada que decidir.
            None => return Ok(OutboxFallo::default()),
        };

        // Un rechazo PERMANENTE se aparta a la primera y sin agotar intentos. Repetir una
        // sentencia que la nube no sabe aplicar da el mismo resultado las veinte veces, y cada
        // vuelta es un minuto más con las ventas de detrás paradas.
        let apartar = permanente || intentos >= MAX_SUBIDA_ATTEMPTS;
        if apartar {
            conn.execute(
                "UPDATE _Sync_Outbox SET Cuarentena = 1 WHERE Op_Id = ?1;",
                vec![Value::Text(op_id.to_string())],
            )
            .await
            .map_err(db_err)?;
        }

        // SYNC-22: apartar evita el atasco, pero deja la nube distinta de la Main — y con la Handy
        // leyendo de la nube, eso es que camarero y TPV ven cosas distintas. Así que en cuanto se
        // aparta, se encola la reparación: no el reintento de la sentencia rechazada, sino el
        // estado ACTUAL de las filas que tocaba. Ver `sync_reparacion`.
        let mut reparadas = 0i64;
        if apartar && command_name != crate::sync_reparacion::COMANDO_REPARACION {
            reparadas = encolar_reparaciones(conn, op_id).await.unwrap_or_else(|e| {
                // Que la reparación no salga no puede convertir esto en un fallo distinto: la
                // cuarentena ya está puesta y la cola ya avanza, que es lo urgente.
                tracing::warn!("no se pudo encolar la reparación de {op_id}: {e}");
                0
            });
        }

        Ok(OutboxFallo {
            intentos,
            apartada: apartar,
            command_name,
            reparadas,
        })
        }).await
    }

    async fn contraste_marca(&self) -> AppResult<MarcaLocal> {
        crate::contraste::marca(&self.db).await
    }

    async fn contrastar_con_la_nube(
        &self,
        resumen: ResumenNube,
        marca: MarcaLocal,
        nube: &dyn PaginasDelContraste,
        reparar: bool,
    ) -> AppResult<ContrasteLocal> {
        // El cuerpo vive en su módulo (`contraste.rs`): no comparte nada con el resto de la interfaz.
        crate::contraste::contrastar(&self.db, resumen, marca, nube, reparar).await
    }

    async fn converger_con_la_nube(&self, nube: &dyn PaginasDelContraste) -> AppResult<tpv_application::ports::sync::Convergencia> {
        // SYNC-29. Por `raw()`: lo que se trae ya está en la nube.
        crate::convergencia::converger(&self.db, nube).await
    }

    async fn purge_applied_ops(&self) -> AppResult<()> {
        // Red de seguridad para los anti-ecos que no se ascendieron por cursor (p. ej. un acuse
        // sin `seq` por cache-hit de idempotencia): retira los registros ANTIGUOS (TTL) cuyo
        // `Op_Id` YA NO está pendiente en el outbox (es decir, ya confirmados en la nube). El
        // filtro `NOT IN (_Sync_Outbox)` es la garantía de "solo borrar lo subido": jamás retira
        // un anti-eco cuya op siga sin enviarse (lo que provocaría su re-aplicación tras catch-up).
        //
        // AUD-18: y tampoco el de una op propia cuyo `Seq` va por delante del checkpoint. La bajada
        // no pasa por encima de un cambio que falla mientras se reintenta, así que lo que esta Main
        // subió después le volverá por el catch-up; sin su anti-eco, se aplicaría otra vez. Un
        // `Seq = 0` fuera del outbox ya no puede volver: o su eco ya entró (una operación cuyo acuse
        // se perdió sale del outbox al volver su eco, y si ese eco falla, `anotar_fallo` le pone su
        // `Seq`), o el acuse no trajo `Seq` porque la nube ya había purgado su log, cosa que sólo
        // hace por debajo del checkpoint de las Main activas (el DO no contesta `Seq` 0 por un error).
        let cutoff = now_ms() - PURGE_TTL_MS;
        let w = self.db.write().await;
        w.raw()
            .execute(
                "DELETE FROM _Sync_Applied_Ops \
                 WHERE Applied_At_Ms < ?1 \
                   AND Seq <= (SELECT Last_Seq FROM _Sync_State WHERE Id = 1) \
                   AND Op_Id NOT IN (SELECT Op_Id FROM _Sync_Outbox);",
                vec![Value::Integer(cutoff)],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn purgar_cuarentenas(&self, antes_de_ms: i64) -> AppResult<u64> {
        // Por `raw()`: es una tabla de control local, no una escritura de negocio que replicar.
        //
        // Una apartada cuya reparación sigue en el outbox sin subir no se toca: la retira esa
        // subida (SYNC-26, `outbox_confirmar_lote`), que es cuando de verdad se ha resuelto. Las demás
        // —sin reparación (no quedaba ninguna fila que reparar) o con la reparación también
        // apartada— ya no tienen nada que las vaya a cerrar. El último intento es la hora a la
        // que se apartó; sin él, la de su creación.
        //
        // `_Sync_Failed` no se toca: un cambio de la nube en cuarentena es la barrera del contraste
        // (`contraste.rs::Guarda::sin_fallos`). Retirarlo le dejaría borrar arriba lo que la Handy
        // escribió y aquí no entró, o subir lo que la nube ya había borrado. Sólo se vacían sus
        // datos (`vaciar_cuarentenas_de_bajada`), y lo cierra el contraste (SYNC-36).
        let w = self.db.write().await;
        let r = apartadas_que_repara("r");
        w.raw()
            .execute(
                &format!(
                    "DELETE FROM _Sync_Outbox \
                      WHERE Cuarentena = 1 \
                        AND COALESCE(Ultimo_Intento_Ms, Created_At_Ms) < ?1 \
                        AND Op_Id NOT IN (SELECT j.value FROM _Sync_Outbox r, {r} j \
                                           WHERE r.Repara_Op_Id IS NOT NULL AND r.Cuarentena = 0);"
                ),
                vec![Value::Integer(antes_de_ms)],
            )
            .await
            .map_err(db_err)
    }

    async fn vaciar_cuarentenas_de_bajada(&self, antes_de_ms: i64) -> AppResult<u64> {
        // SYNC-36. Por `raw()`: `_Sync_Failed` es estado local de este equipo.
        crate::cuarentenas_bajada::vaciar(&self.db, antes_de_ms).await
    }

    async fn health(&self) -> AppResult<SyncHealth> {
        let r = self.db.read().await;
        let conn = r.conn();

        async fn count(conn: &Connection, sql: &str) -> AppResult<i64> {
            let mut rows = conn.query(sql, ()).await.map_err(db_err)?;
            match rows.next().await.map_err(db_err)? {
                Some(row) => Ok(v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0)),
                None => Ok(0),
            }
        }

        // SYNC-20: "pendiente" es lo que todavía puede subir. Una operación apartada ya no está en
        // camino y sumarla aquí haría que este número no bajara nunca — que es justo el síntoma
        // mudo que se está arreglando. Se cuenta aparte, que es lo que permite decir la verdad:
        // "quedan 3 por subir" y "hay 1 que no va a subir" son dos frases distintas.
        let outbox_pending =
            count(conn, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Cuarentena = 0;").await?;
        let last_seq = checkpoint(conn).await?;
        let quarantined = count(
            conn,
            "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 1;",
        )
        .await?;
        let failing = count(
            conn,
            "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 0;",
        )
        .await?;
        let subida_en_cuarentena =
            count(conn, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Cuarentena = 1;").await?;
        // "Fallando" es una op que ya se ha llevado algún rechazo pero aún no ha agotado sus
        // intentos: sigue en camino. Es el aviso temprano, antes de que se aparte.
        let subida_fallando = count(
            conn,
            "SELECT COUNT(*) FROM _Sync_Outbox WHERE Cuarentena = 0 AND Intentos > 0;",
        )
        .await?;

        Ok(SyncHealth {
            outbox_pending,
            last_seq,
            quarantined,
            failing,
            subida_fallando,
            subida_en_cuarentena,
        })
    }

    async fn bootstrap_restaurar(
        &self,
        snapshot: BootstrapSnapshot,
        negocio: &str,
    ) -> AppResult<BootstrapResultado> {
        // Tras un traslado de licencia la base de este equipo es de antes: se guarda entera (puede
        // tener operaciones que nunca subieron) y se reemplaza por la de la nube, outbox incluido.
        // La copia va ANTES de tomar el escritor: `VACUUM INTO` usa el pool de lectura.
        let traslado = crate::recovery::hay_traslado_pendiente(self.db.carpeta());
        if traslado {
            let copia = crate::recovery::guardar_base_de_antes_del_traslado(&self.db).await?;
            tracing::info!(target: "tpv::sync", copia = %copia.display(), "base de antes del traslado guardada");
        }
        // AUD-19: lo mismo con una copia restaurada que todavía no se ha reconciliado (la que se
        // rechaza por anterior a lo que guarda la nube, o cualquier otra que no converge). Su outbox
        // es de antes: lo que el equipo de entonces ya subió volvería a aplicarse en cuanto caducara
        // su `Applied_Operations`, y un `UPDATE` viejo devolvería un PIN o un rol ya cambiados. Se
        // guarda la base entera, con ese outbox, y no se sube.
        let copia_sin_reconciliar = !traslado && reconciliacion_pendiente(&self.db).await?;
        if copia_sin_reconciliar {
            let copia = crate::recovery::guardar_base_de_antes_de_la_nube(&self.db).await?;
            tracing::info!(target: "tpv::sync", copia = %copia.display(), "copia sin reconciliar guardada antes de traer la nube");
        }
        let apartar_outbox = traslado || copia_sin_reconciliar;

        let w = self.db.write().await;
        let conn = w.raw();

        let locales = tablas_de_negocio_locales(conn).await?;

        // Se decide TODO antes de tocar nada: qué tablas se restauran y cuáles no existen aquí.
        let mut restaurables: Vec<&tpv_contracts::sync::BootstrapTabla> = Vec::new();
        let mut desconocidas: Vec<String> = Vec::new();
        for t in &snapshot.tablas {
            if !identificador_simple(&t.nombre) || !locales.contains(&t.nombre) {
                desconocidas.push(t.nombre.clone());
                continue;
            }
            if t.columnas.iter().any(|c| !identificador_simple(c)) {
                desconocidas.push(t.nombre.clone());
                continue;
            }
            restaurables.push(t);
        }

        if restaurables.is_empty() {
            return Err(AppError::validation(
                "El volcado de la nube no trae ninguna tabla que esta versión reconozca",
            ));
        }

        // `defer_foreign_keys` deja que el orden entre tablas dé igual: se comprueban las FK al
        // COMMIT, cuando ya está todo dentro. Sin esto habría que ordenar 41 tablas por sus
        // dependencias y mantener ese orden a mano en cada cambio de esquema.
        let res: AppResult<i64> = conn.transaccion(async {
            // AUD-06: una base sólo se usa con la licencia de su negocio. La que lleva el sello de
            // otro no se rellena con los datos de éste: se aparta entera al volver a abrirla
            // (`connection::init_main_db`). La que queda, con el sello de la nube de la que viene,
            // en esta misma transacción: no hay base reconstruida sin sello, ni con el de otro.
            let sello = Sello::leido(crate::sello::leer(&**conn).await?.as_deref());
            if procedencia(&sello, negocio) == Procedencia::DeOtroNegocio {
                return Err(AppError::conflict(
                    "Los datos de este ordenador son de otro negocio y hay que apartarlos antes de traer los de la licencia. Cierra el programa y vuelve a abrirlo.",
                ));
            }
            crate::sello::escribir(conn, negocio).await?;

            // Restaurar VACÍA las tablas: una operación local aún sin subir se perdería sin dejar
            // rastro y sin que nadie lo supiera. Va DENTRO de la transacción a propósito —
            // comprobarlo antes dejaría una ventana por la que puede colarse una venta entre el
            // permiso y el borrado. En el camino real (una BD recién perdida, todavía sin
            // escrituras) el outbox está vacío y esto no se nota.
            //
            // La excepción: una BD que YA está bloqueada en reconciliación (viene de una
            // restauración anterior que no consiguió converger) no está vendiendo, y su outbox es
            // el de la copia, no el de un servicio en curso. Negarle también este camino la dejaría
            // sin ninguna salida, que es justo el callejón que esta pantalla existe para evitar.
            let reconciliando = {
                let mut rows = conn
                    .query(
                        "SELECT Reconciliation_Pending FROM _Recovery_State WHERE Id = 1;",
                        (),
                    )
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0) != 0,
                    None => false,
                }
            };
            // Una base SIN USUARIOS tampoco está vendiendo —no se puede iniciar sesión—, así que
            // lo que tenga en el outbox no es una venta: lo escribió algo que no debería haber
            // escrito. Ver la misma excepción, con su porqué, en `recovery::asegurar_reemplazo_seguro`.
            let sin_usuarios = {
                let mut rows = conn
                    .query("SELECT COUNT(*) FROM Usuarios;", ())
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0) == 0,
                    None => true,
                }
            };
            let pendientes = {
                let mut rows = conn
                    .query("SELECT COUNT(*) FROM _Sync_Outbox;", ())
                    .await
                    .map_err(db_err)?;
                match rows.next().await.map_err(db_err)? {
                    Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                    None => 0,
                }
            };
            if pendientes > 0 && !reconciliando && !sin_usuarios && !traslado {
                return Err(AppError::conflict(format!(
                    "Hay {pendientes} operaciones de este equipo sin subir a la nube. Restaurar las borraría: espera a que se sincronicen antes de recuperar."
                )));
            }

            for t in &restaurables {
                conn.execute(&format!("DELETE FROM \"{}\";", t.nombre), ())
                    .await
                    .map_err(|e| {
                        AppError::repository(format!("vaciando {}: {e}", t.nombre))
                    })?;
            }

            let mut filas = 0i64;
            for t in &restaurables {
                if t.filas.is_empty() {
                    continue;
                }
                let n_cols = t.columnas.len();
                let cols = t
                    .columnas
                    .iter()
                    .map(|c| format!("\"{c}\""))
                    .collect::<Vec<_>>()
                    .join(", ");

                // Una fila por `execute()` significaba reparsear el mismo INSERT decenas de miles
                // de veces. Se agrupan en sentencias multi-fila, acotadas por el número de
                // parámetros que SQLite acepta en una sentencia.
                let por_lote = (MAX_PARAMS_POR_SENTENCIA / n_cols.max(1)).max(1);
                let marcas_fila = format!("({})", vec!["?"; n_cols].join(", "));

                for lote in t.filas.chunks(por_lote) {
                    let mut args: Vec<Value> = Vec::with_capacity(lote.len() * n_cols);
                    for fila in lote {
                        if fila.len() != n_cols {
                            return Err(AppError::validation(format!(
                                "{}: fila con {} valores para {n_cols} columnas",
                                t.nombre,
                                fila.len(),
                            )));
                        }
                        args.extend(fila.iter().map(json_to_value));
                    }

                    let valores = vec![marcas_fila.as_str(); lote.len()].join(", ");
                    let sql = format!(
                        "INSERT INTO \"{}\" ({cols}) VALUES {valores};",
                        t.nombre
                    );
                    conn.execute(&sql, args).await.map_err(|e| {
                        AppError::repository(format!("restaurando {}: {e}", t.nombre))
                    })?;
                    filas += lote.len() as i64;
                }
            }

            // El andamiaje de sync se rehace desde cero: el checkpoint pasa a ser el `seq` de la
            // foto y todo lo anterior (anti-ecos, fallos, cuarentenas) hablaba de una BD que ya no
            // existe. Conservarlo haría que el catch-up saltase operaciones que esta BD nueva sí
            // necesita.
            conn.execute("DELETE FROM _Sync_Applied_Ops;", ())
                .await
                .map_err(db_err)?;
            conn.execute("DELETE FROM _Sync_Failed;", ())
                .await
                .map_err(db_err)?;
            // SYNC-29: lo que había que traer de la nube ya es la nube.
            conn.execute("DELETE FROM _Sync_Por_Contrastar;", ())
                .await
                .map_err(db_err)?;
            if apartar_outbox {
                // Lo que quedaba por subir es de antes del traslado o de la copia (ver arriba): ya
                // está en la base guardada, y en el outbox lo subiría el primer drenado encima de
                // datos más nuevos.
                conn.execute("DELETE FROM _Sync_Outbox;", ())
                    .await
                    .map_err(db_err)?;
            }
            conn.execute(
                "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1;",
                vec![Value::Integer(snapshot.seq)],
            )
            .await
            .map_err(db_err)?;

            // El snapshot es coherente en su `seq`, pero puede entrar una escritura nueva justo
            // después de tomarlo. El login permanece bloqueado hasta que el WebSocket haga el
            // ciclo catch-up → outbox → catch-up y confirme el high-water de la nube.
            conn.execute(
                "UPDATE _Recovery_State SET Reconciliation_Pending = 1 WHERE Id = 1;",
                (),
            )
            .await
            .map_err(db_err)?;

            // SYNC-19 · siembra de la fase 2. El volcado que acaba de entrar viene recortado por
            // una ventana; lo que quedó fuera lo irá trayendo el job `backfill_historico`. La cola
            // se siembra DENTRO de la misma transacción que restaura: si se hiciera después y algo
            // fallara en medio, quedaría una base a medias sin nada que la complete, y nadie se
            // enteraría hasta buscar un ticket de hace meses.
            //
            // Se rehace desde cero (`DELETE` antes) por lo mismo que el resto del andamiaje: un
            // progreso anterior hablaba de una base que ya no existe.
            conn.execute("DELETE FROM _Backfill_Historico;", ())
                .await
                .map_err(db_err)?;
            // El orden lo manda el worker (padres primero). Si viniera vacío —worker anterior a
            // SYNC-19— se cae al orden en que llegaron las tablas marcadas `parcial`, que es lo
            // único que hay; y si ninguna lo está, no hay fase 2 y esto no siembra nada.
            let orden_backfill: Vec<String> = if snapshot.backfill.is_empty() {
                restaurables
                    .iter()
                    .filter(|t| t.parcial)
                    .map(|t| t.nombre.clone())
                    .collect()
            } else {
                snapshot.backfill.clone()
            };
            for (i, nombre) in orden_backfill.iter().enumerate() {
                if !identificador_simple(nombre) || no_es_tabla_de_negocio(nombre) {
                    continue;
                }
                conn.execute(
                    "INSERT OR REPLACE INTO _Backfill_Historico (Tabla, Orden) VALUES (?1, ?2);",
                    vec![Value::Text(nombre.clone()), Value::Integer(i as i64)],
                )
                .await
                .map_err(db_err)?;
            }

            // El resumen diario de las estadísticas hablaba de los datos de antes. Los triggers ya
            // han apuntado los días de lo que se ha borrado y de lo que ha entrado; aquí se vacía lo
            // resumido y se deja por calcular todo día con cobros, dentro de la misma transacción.
            crate::estadisticas_diarias::reiniciar(conn).await?;

            Ok(filas)
        }).await;

        let filas = res?;
                // La base queda restaurada pero pendiente de reconciliar: hasta que converja no
                // admite escrituras de negocio (aquí no se reabre el `Db`, así que el cerrojo no
                // lo recalcula nadie más).
                self.db.bloquear_escrituras_de_negocio(true);
                tracing::info!(
                    target: "tpv::sync",
                    seq = snapshot.seq,
                    filas,
                    tablas = restaurables.len(),
                    "BD local reconstruida desde la nube"
                );
                if traslado {
                    // Después del COMMIT: si se quitara antes y la restauración fallara, el equipo
                    // volvería a trabajar con la base vieja. Si falla quitarla, la base ya está
                    // bien y lo único que pasa es que se volverá a pedir la reconstrucción.
                    if let Err(e) = crate::recovery::quitar_marca_traslado(self.db.carpeta()) {
                        tracing::warn!(target: "tpv::sync", error = %e, "no se pudo quitar la marca de traslado");
                    }
                }
                Ok(BootstrapResultado {
                    seq: snapshot.seq,
                    filas_restauradas: filas,
                    tablas_restauradas: restaurables.iter().map(|t| t.nombre.clone()).collect(),
                    tablas_desconocidas: desconocidas,
                })
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SYNC-19 · fase 2: el histórico que la ventana del bootstrap dejó fuera
    // ─────────────────────────────────────────────────────────────────────────

    async fn backfill_siguiente(&self) -> AppResult<Option<(String, i64)>> {
        let r = self.db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT Tabla, Cursor FROM _Backfill_Historico \
                 WHERE Completada = 0 ORDER BY Orden ASC, Tabla ASC LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        match rows.next().await.map_err(db_err)? {
            Some(row) => {
                let tabla = match row.get_value(0).map_err(db_err)? {
                    Value::Text(t) => t,
                    _ => return Ok(None),
                };
                let cursor = v_i64(row.get_value(1).map_err(db_err)?).unwrap_or(0);
                Ok(Some((tabla, cursor)))
            }
            None => Ok(None),
        }
    }

    async fn backfill_aplicar_pagina(&self, pagina: HistoricoPagina) -> AppResult<i64> {
        if !identificador_simple(&pagina.tabla) {
            return Err(AppError::validation(format!(
                "nombre de tabla inaceptable en el histórico: {}",
                pagina.tabla
            )));
        }
        if pagina.columnas.iter().any(|c| !identificador_simple(c)) {
            return Err(AppError::validation(format!(
                "{}: el histórico trae un nombre de columna inaceptable",
                pagina.tabla
            )));
        }

        let w = self.db.write().await;
        let conn = w.raw();

        // Un worker más nuevo puede listar una tabla que esta versión todavía no tiene. Se da por
        // completada en vez de fallar: si no, el backfill se atascaría en ella para siempre y
        // ninguna de las siguientes llegaría a bajarse. Misma regla que en el bootstrap, también
        // para una tabla que no es de negocio, que no se rellena desde la nube (`no_es_tabla_de_negocio`).
        if !tablas_de_negocio_locales(conn).await?.contains(&pagina.tabla) {
            conn.execute(
                "UPDATE _Backfill_Historico \
                 SET Completada = 1, Ultimo_Error = 'esta versión no tiene esa tabla de negocio', \
                     Ultimo_Intento_Ms = ?2 \
                 WHERE Tabla = ?1;",
                vec![Value::Text(pagina.tabla.clone()), Value::Integer(now_ms())],
            )
            .await
            .map_err(db_err)?;
            return Ok(0);
        }

        // La única fila que se da por buena sin insertarla es la que ya está: la de la misma clave
        // primaria. Ver `choque_del_historico`.
        let clave_primaria =
            crate::sync_reparacion::claves_primarias(conn, &pagina.tabla).await.map_err(db_err)?;
        let si_ya_esta = if clave_primaria.is_empty() {
            // Todas las tablas del esquema tienen clave primaria (lo comprueba
            // `tests_backfill::todas_las_tablas_del_negocio_tienen_clave_primaria`).
            "ON CONFLICT DO NOTHING".to_string()
        } else {
            let objetivo = clave_primaria.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
            format!("ON CONFLICT({objetivo}) DO NOTHING")
        };

        let res: AppResult<i64> = conn.transaccion(async {
            let n_cols = pagina.columnas.len();
            let mut insertadas = 0i64;

            if n_cols > 0 && !pagina.filas.is_empty() {
                let cols = pagina
                    .columnas
                    .iter()
                    .map(|c| format!("\"{c}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                let marcas_fila = format!("({})", vec!["?"; n_cols].join(", "));
                let por_lote = (MAX_PARAMS_POR_SENTENCIA / n_cols.max(1)).max(1);

                for lote in pagina.filas.chunks(por_lote) {
                    let mut args: Vec<Value> = Vec::with_capacity(lote.len() * n_cols);
                    for fila in lote {
                        if fila.len() != n_cols {
                            return Err(AppError::validation(format!(
                                "{}: fila con {} valores para {n_cols} columnas",
                                pagina.tabla,
                                fila.len(),
                            )));
                        }
                        args.extend(fila.iter().map(json_to_value));
                    }
                    let valores = vec![marcas_fila.as_str(); lote.len()].join(", ");
                    // La fase 2 NUNCA pisa una fila que ya esté: lo que ya está llegó por el
                    // catch-up y es más nuevo que esta foto del histórico. Y la fase 2 re-descarga
                    // a propósito la ventana que ya trajo la fase 1. Así que la que ya está por su
                    // clave primaria se deja como está, y nada más: no `INSERT OR IGNORE`, que se
                    // salta también la fila que choca con OTRA por un índice único (o que no
                    // cumple un NOT NULL o un CHECK), en silencio y para siempre.
                    let sql = format!(
                        "INSERT INTO \"{}\" ({cols}) VALUES {valores} {si_ya_esta};",
                        pagina.tabla
                    );
                    if let Err(e) = conn.execute(&sql, args).await {
                        let de_una_en_una = format!(
                            "INSERT INTO \"{}\" ({cols}) VALUES {marcas_fila} {si_ya_esta};",
                            pagina.tabla
                        );
                        let fila = Fila { columnas: &pagina.columnas, clave_primaria: &clave_primaria };
                        return Err(choque_del_historico(conn, &pagina.tabla, &de_una_en_una, fila, lote, e).await);
                    }
                    insertadas += lote.len() as i64;
                }
            }

            // El cursor avanza en la MISMA transacción que inserta. Si la página falla, el cursor
            // no se mueve y el siguiente intento la repite: reanudable por construcción.
            let (cursor, completada) = match pagina.siguiente_cursor {
                Some(c) => (c, 0i64),
                None => (0i64, 1i64),
            };
            conn.execute(
                "UPDATE _Backfill_Historico \
                 SET Cursor = CASE WHEN ?3 = 1 THEN Cursor ELSE ?2 END, \
                     Filas_Traidas = Filas_Traidas + ?4, \
                     Completada = ?3, \
                     Ultimo_Intento_Ms = ?5, \
                     Ultimo_Error = NULL \
                 WHERE Tabla = ?1;",
                vec![
                    Value::Text(pagina.tabla.clone()),
                    Value::Integer(cursor),
                    Value::Integer(completada),
                    Value::Integer(insertadas),
                    Value::Integer(now_ms()),
                ],
            )
            .await
            .map_err(db_err)?;

            Ok(insertadas)
        }).await;

        match res {
            // Las foráneas van diferidas: una fila cuyo padre no está aquí entra bien y lo que falla
            // es el COMMIT, sin decir cuál. Se busca, para decirlo.
            Err(e) if e.to_string().contains("FOREIGN KEY constraint failed") => {
                Err(foranea_del_historico(conn, &pagina, &si_ya_esta, &clave_primaria).await.unwrap_or(e))
            }
            otro => otro,
        }
    }

    async fn backfill_marcar_error(&self, tabla: &str, error: &str) -> AppResult<()> {
        let w = self.db.write().await;
        w.raw()
            .execute(
                "UPDATE _Backfill_Historico SET Ultimo_Error = ?2, Ultimo_Intento_Ms = ?3 \
                 WHERE Tabla = ?1;",
                vec![
                    Value::Text(tabla.to_string()),
                    Value::Text(error.chars().take(500).collect::<String>()),
                    Value::Integer(now_ms()),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn backfill_estado(&self) -> AppResult<BackfillEstado> {
        let r = self.db.read().await;
        let conn = r.conn();

        let mut rows = conn
            .query(
                "SELECT \
                   COALESCE(SUM(CASE WHEN Completada = 0 THEN 1 ELSE 0 END), 0), \
                   COALESCE(SUM(CASE WHEN Completada = 1 THEN 1 ELSE 0 END), 0), \
                   COALESCE(SUM(Filas_Traidas), 0) \
                 FROM _Backfill_Historico;",
                (),
            )
            .await
            .map_err(db_err)?;
        let (pendientes, completadas, filas) = match rows.next().await.map_err(db_err)? {
            Some(row) => (
                v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0),
                v_i64(row.get_value(1).map_err(db_err)?).unwrap_or(0),
                v_i64(row.get_value(2).map_err(db_err)?).unwrap_or(0),
            ),
            None => (0, 0, 0),
        };

        let mut rows = conn
            .query(
                "SELECT Tabla, Ultimo_Error FROM _Backfill_Historico \
                 WHERE Completada = 0 ORDER BY Orden ASC, Tabla ASC LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        let (tabla_actual, ultimo_error) = match rows.next().await.map_err(db_err)? {
            Some(row) => (
                match row.get_value(0).map_err(db_err)? {
                    Value::Text(t) => Some(t),
                    _ => None,
                },
                match row.get_value(1).map_err(db_err)? {
                    Value::Text(e) => Some(e),
                    _ => None,
                },
            ),
            None => (None, None),
        };

        Ok(BackfillEstado {
            tablas_pendientes: pendientes,
            tablas_completadas: completadas,
            filas_traidas: filas,
            tabla_actual,
            ultimo_error,
        })
    }

    async fn ultima_escritura_ms(&self, ahora_ms: i64) -> AppResult<Option<i64>> {
        let r = self.db.read().await;
        crate::verificacion_nube::ultima_escritura_creible(&r, ahora_ms).await
    }
}

#[cfg(test)]
mod tests_subida {
    //! El outbox visto desde quien lo sube: qué se ofrece, qué lo da por subido (el acuse de su
    //! lote, o verlo volver de la nube) y qué pasa con lo que la nube rechaza (SYNC-20).

    use super::*;
    use crate::db::Db;
    use crate::ejecutor::Connection;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{SqlStatement, SyncChange};

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("sync");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap())
            .await
            .unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    /// Mete una operación en el outbox como si la hubiera capturado una escritura local.
    async fn encolar_en_outbox(db: &Arc<Db>, op_id: &str) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        conn.execute(
            "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
             VALUES (?1, 'test', '[]', ?2);",
            vec![Value::Text(op_id.to_string()), Value::Integer(now_ms())],
        )
        .await
        .unwrap();
    }

    async fn ids_pendientes(repo: &SqliteSyncRepository) -> Vec<String> {
        repo.outbox_pending(100)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.op_id)
            .collect()
    }

    async fn numero(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        let mut rows = r.conn().query(sql, Vec::<Value>::new()).await.unwrap();
        let fila = rows.next().await.unwrap().unwrap();
        v_i64(fila.get_value(0).unwrap()).unwrap_or(-1)
    }

    /// El anti-eco que deja la captura de una escritura local: sin `Seq` hasta que la nube la numera.
    async fn anti_eco(db: &Arc<Db>, op_id: &str) {
        let w = db.write().await;
        w.raw()
            .execute(
                "INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, 0, ?2);",
                vec![Value::Text(op_id.to_string()), Value::Integer(now_ms())],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn mientras_la_nube_no_la_confirma_se_sigue_ofreciendo_y_en_orden() {
        // No hay estado intermedio: una operación mandada sin acuse sigue pendiente, y vuelve a
        // salir en el lote siguiente. Reenviarla es inocuo: la nube es idempotente por `Op_Id`.
        let (repo, db, _dir) = repo_temporal().await;
        for op in ["op-1", "op-2", "op-3"] {
            encolar_en_outbox(&db, op).await;
        }
        assert_eq!(ids_pendientes(&repo).await, vec!["op-1", "op-2", "op-3"]);
        assert_eq!(ids_pendientes(&repo).await, vec!["op-1", "op-2", "op-3"]);
    }

    #[tokio::test]
    async fn el_acuse_de_un_lote_saca_del_outbox_todo_lo_confirmado_y_numera_sus_anti_ecos() {
        let (repo, db, _dir) = repo_temporal().await;
        for op in ["op-1", "op-2", "op-3"] {
            encolar_en_outbox(&db, op).await;
            anti_eco(&db, op).await;
        }

        // La nube confirma las dos primeras; de la segunda ya había purgado el log (`Seq` 0).
        repo.outbox_confirmar_lote(&[("op-1".to_string(), 41), ("op-2".to_string(), 0)])
            .await
            .unwrap();

        assert_eq!(ids_pendientes(&repo).await, vec!["op-3".to_string()]);
        assert_eq!(numero(&db, "SELECT Seq FROM _Sync_Applied_Ops WHERE Op_Id = 'op-1';").await, 41);
        assert_eq!(numero(&db, "SELECT Seq FROM _Sync_Applied_Ops WHERE Op_Id = 'op-2';").await, 0);
        assert_eq!(numero(&db, "SELECT Seq FROM _Sync_Applied_Ops WHERE Op_Id = 'op-3';").await, 0);

        // Repetirlo (el acuse de un lote reenviado) no cambia nada, ni confirmar algo que no está.
        repo.outbox_confirmar_lote(&[("op-1".to_string(), 99), ("no-esta".to_string(), 7)])
            .await
            .unwrap();
        assert_eq!(numero(&db, "SELECT Seq FROM _Sync_Applied_Ops WHERE Op_Id = 'op-1';").await, 41);
        assert_eq!(ids_pendientes(&repo).await, vec!["op-3".to_string()]);
        repo.outbox_confirmar_lote(&[]).await.unwrap();
    }

    #[tokio::test]
    async fn un_lote_se_confirma_entero_o_no_se_confirma() {
        // Si la transacción no llega a cerrarse, no queda ni la primera confirmada: el lote
        // volverá a subir entero y la nube contestará «ya estaba» a cada una.
        let (repo, db, _dir) = repo_temporal().await;
        for op in ["op-1", "op-2"] {
            encolar_en_outbox(&db, op).await;
            anti_eco(&db, op).await;
        }
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "CREATE TRIGGER no_se_borra_la_segunda BEFORE DELETE ON _Sync_Outbox
                     WHEN OLD.Op_Id = 'op-2'
                     BEGIN SELECT RAISE(ABORT, 'la segunda no sale'); END;",
                )
                .await
                .unwrap();
        }

        let r = repo
            .outbox_confirmar_lote(&[("op-1".to_string(), 5), ("op-2".to_string(), 6)])
            .await;

        assert!(r.is_err());
        assert_eq!(ids_pendientes(&repo).await, vec!["op-1".to_string(), "op-2".to_string()]);
        assert_eq!(numero(&db, "SELECT MAX(Seq) FROM _Sync_Applied_Ops;").await, 0);
    }

    #[tokio::test]
    async fn verla_volver_de_la_nube_tambien_la_da_por_subida() {
        // El acuse de su lote se perdió, pero el catch-up la devuelve: prueba de que allí está.
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;

        repo.apply_changes(vec![SyncChange {
            op_id: "op-1".to_string(),
            seq: 7,
            statements: Vec::<SqlStatement>::new(),
        }])
        .await
        .unwrap();

        assert!(ids_pendientes(&repo).await.is_empty());
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0);
    }

    /* ===== SYNC-20: la cola no se queda parada detrás de un rechazo ===== */

    #[tokio::test]
    async fn un_rechazo_permanente_aparta_la_op_y_la_cola_sigue() {
        // ESTE es el bug. El outbox es una cola ordenada, así que el drenado sube la primera y no
        // pasa a la segunda hasta que la nube confirma. Con una operación que la nube NO puede
        // aplicar —una columna que su esquema no tiene—, eso significaba que `op-2` y `op-3`
        // (ventas) no subían nunca. Sin error, sin aviso: sólo un `last_seq` que no avanzaba.
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        encolar_en_outbox(&db, "op-2").await;
        encolar_en_outbox(&db, "op-3").await;

        let fallo = repo
            .outbox_mark_failed("op-1", "no such column: Razon_Social", true)
            .await
            .unwrap();

        // Un rechazo definitivo no gasta los 20 intentos: se aparta a la primera.
        assert!(fallo.apartada, "un rechazo permanente debe apartar a la primera");
        assert_eq!(fallo.intentos, 1);

        // Y lo que había detrás sigue subiendo, que es el objetivo entero.
        assert_eq!(
            ids_pendientes(&repo).await,
            vec!["op-2".to_string(), "op-3".to_string()],
        );
    }

    #[tokio::test]
    async fn un_fallo_transitorio_no_aparta_nada_y_reintenta() {
        // La otra mitad, y la que impide que el arreglo se convierta en una forma nueva de perder
        // datos: un corte de red no puede apartar una venta. Se reintenta, y sólo al agotar los
        // intentos se da por imposible.
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;

        for intento in 1..MAX_SUBIDA_ATTEMPTS {
            let fallo = repo
                .outbox_mark_failed("op-1", "fetch failed", false)
                .await
                .unwrap();
            assert_eq!(fallo.intentos, intento);
            assert!(!fallo.apartada, "no puede apartarse en el intento {intento}");
            // Mientras tanto sigue en la cola, esperando su turno.
            assert_eq!(ids_pendientes(&repo).await, vec!["op-1".to_string()]);
        }

        let ultimo = repo
            .outbox_mark_failed("op-1", "fetch failed", false)
            .await
            .unwrap();
        assert_eq!(ultimo.intentos, MAX_SUBIDA_ATTEMPTS);
        assert!(ultimo.apartada, "agotados los intentos, se aparta");
        assert!(ids_pendientes(&repo).await.is_empty());
    }

    #[tokio::test]
    async fn una_op_apartada_no_se_borra_ni_desaparece_de_la_salud() {
        // Apartar no es olvidar. Esa fila es lo único que queda de un dato que la nube no tiene:
        // borrarla convertiría el arreglo del atasco en una pérdida silenciosa, y es además lo que
        // hace que la guardia de restauración (`asegurar_reemplazo_seguro`) se siga negando.
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        encolar_en_outbox(&db, "op-2").await;
        repo.outbox_mark_failed("op-1", "no such table: X", true)
            .await
            .unwrap();

        let salud = repo.health().await.unwrap();
        // "Pendiente" es lo que todavía puede subir: sumar la apartada dejaría este número clavado
        // para siempre, que es justo el síntoma mudo que se está arreglando.
        assert_eq!(salud.outbox_pending, 1, "sólo op-2 sigue en camino");
        assert_eq!(salud.subida_en_cuarentena, 1, "y op-1 se cuenta aparte");

        // La fila sigue ahí, con su motivo escrito.
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT Ultimo_Error FROM _Sync_Outbox WHERE Op_Id = 'op-1';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().expect("la fila no se borra");
        match fila.get_value(0).unwrap() {
            Value::Text(s) => assert!(s.contains("no such table")),
            v => panic!("se esperaba el motivo del rechazo, no {v:?}"),
        }
    }

    #[tokio::test]
    async fn la_salud_avisa_de_un_rechazo_antes_de_apartarlo() {
        // El aviso temprano. Mientras la op sigue reintentándose no está apartada, pero tampoco va
        // bien: `subida_fallando` es lo que separa "hay cola" de "hay cola y algo va mal".
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        assert_eq!(repo.health().await.unwrap().subida_fallando, 0);

        repo.outbox_mark_failed("op-1", "timeout", false)
            .await
            .unwrap();

        let salud = repo.health().await.unwrap();
        assert_eq!(salud.subida_fallando, 1);
        assert_eq!(salud.subida_en_cuarentena, 0);
        assert_eq!(salud.outbox_pending, 1, "sigue en camino");
    }
}

#[cfg(test)]
mod tests_aplicadas {
    //! Qué se aplica DE VERDAD en un lote.
    //!
    //! El frontend reacciona a esta lista: invalidar la caché, recargar el POS y releer los ajustes.
    //! Si aquí se colaran las operaciones que el gate de idempotencia salta —las propias de esta
    //! Main volviendo por el catch-up, o un re-broadcast—, media aplicación se recargaría sin que
    //! nada hubiera cambiado. En el caso de los ajustes eso realimentaba un bucle que llegó a
    //! generar decenas de miles de operaciones.

    use super::*;
    use crate::db::Db;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{SqlStatement, SyncChange};

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("aplicadas");
        let db = Db::open(dir.join("data.db").to_str().unwrap())
            .await
            .unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    fn cambio(op_id: &str, seq: i64) -> SyncChange {
        SyncChange {
            op_id: op_id.to_string(),
            seq,
            statements: vec![SqlStatement {
                sql: "UPDATE Business_Settings SET Business_Name = ?1 WHERE ID = 1;".into(),
                args: vec![serde_json::json!("Bar de Prueba")],
            }],
        }
    }

    #[tokio::test]
    async fn el_mismo_lote_solo_se_aplica_la_primera_vez() {
        let (repo, _db, dir) = repo_temporal().await;
        let lote = vec![cambio("op-1", 1), cambio("op-2", 2)];

        let primera = repo.apply_changes(lote.clone()).await.unwrap();
        assert_eq!(
            primera.aplicadas,
            vec!["op-1".to_string(), "op-2".to_string()]
        );
        assert_eq!(primera.last_seq, 2);

        // Segunda vuelta con el MISMO lote: el checkpoint sigue avanzando, pero no se aplica nada.
        // Es exactamente lo que pasa cuando el catch-up devuelve las operaciones de esta Main.
        let segunda = repo.apply_changes(lote).await.unwrap();
        assert!(
            segunda.aplicadas.is_empty(),
            "un lote repetido no aplica nada: {:?}",
            segunda.aplicadas
        );
        assert_eq!(segunda.last_seq, 2);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn en_un_lote_mixto_solo_salen_las_nuevas() {
        let (repo, _db, dir) = repo_temporal().await;

        repo.apply_changes(vec![cambio("op-1", 1)]).await.unwrap();

        let r = repo
            .apply_changes(vec![cambio("op-1", 1), cambio("op-2", 2)])
            .await
            .unwrap();

        assert_eq!(r.aplicadas, vec!["op-2".to_string()]);

        let _ = std::fs::remove_dir_all(dir);
    }

    // RI-33: el escritor se suelta cada `CAMBIOS_POR_TURNO_DE_ESCRITOR` cambios. Un lote que cruza
    // varios tramos se aplica entero y en orden, y un fallo en un tramo posterior para ahí sin
    // perder lo que ya entró.
    #[tokio::test]
    async fn un_lote_que_cruza_tramos_se_aplica_entero() {
        let (repo, _db, dir) = repo_temporal().await;
        let n = CAMBIOS_POR_TURNO_DE_ESCRITOR as i64 * 2 + 20;
        let lote: Vec<SyncChange> = (1..=n).map(|s| cambio(&format!("op-{s}"), s)).collect();

        let r = repo.apply_changes(lote).await.unwrap();

        assert_eq!(r.aplicadas.len() as i64, n);
        assert_eq!(r.aplicadas.last().unwrap(), &format!("op-{n}"));
        assert_eq!(r.last_seq, n);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn un_fallo_en_un_tramo_posterior_para_el_lote_ahi() {
        let (repo, _db, dir) = repo_temporal().await;
        let rota = CAMBIOS_POR_TURNO_DE_ESCRITOR as i64 + 10;
        let lote: Vec<SyncChange> = (1..=rota + 5)
            .map(|s| {
                let mut c = cambio(&format!("op-{s}"), s);
                if s == rota {
                    c.statements[0].sql = "UPDATE Tabla_Que_No_Existe SET x = 1;".into();
                }
                c
            })
            .collect();

        let r = repo.apply_changes(lote).await.unwrap();

        assert_eq!(r.aplicadas.len() as i64, rota - 1, "entra todo lo anterior");
        assert_eq!(r.last_seq, rota - 1, "el checkpoint se queda delante de la rota");

        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests_bootstrap {
    //! Reconstrucción de la BD local desde un volcado de la nube.
    //!
    //! Lo que se comprueba aquí no es "los INSERT funcionan", es lo que hace que esto sea seguro:
    //! que reemplaza en vez de acumular, que el checkpoint queda donde dice la foto, que un
    //! volcado a medias no deja la BD a medias, y que una tabla que esta versión no conoce se
    //! informa en vez de tumbar la recuperación.

    use super::*;
    use crate::db::Db;
    use crate::ejecutor::Connection;
    use serde_json::json;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{BootstrapSnapshot, BootstrapTabla};

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("bootstrap");
        std::fs::create_dir_all(&dir).unwrap();
        // `Db::open` aplica las migraciones reales, así que se prueba contra el esquema de verdad
        // (`Zonas`) y no contra una tabla de juguete que podría no parecerse en nada.
        let db = Db::open(dir.join("data.db").to_str().unwrap())
            .await
            .unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    fn tabla(nombre: &str, filas: Vec<Vec<serde_json::Value>>) -> BootstrapTabla {
        BootstrapTabla {
            nombre: nombre.to_string(),
            columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
            filas,
            parcial: false,
        }
    }

    async fn zonas(db: &Arc<Db>) -> Vec<String> {
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query("SELECT Nombre_Zona FROM Zonas ORDER BY Nombre_Zona;", ())
            .await
            .unwrap();
        let mut out = Vec::new();
        while let Some(row) = rows.next().await.unwrap() {
            if let Ok(Value::Text(n)) = row.get_value(0) {
                out.push(n);
            }
        }
        out
    }

    /// Restaurar REEMPLAZA. Una fila que ya estaba y no viene en la foto tiene que desaparecer: si
    /// se acumulara, la BD "recuperada" sería la mezcla de dos momentos distintos.
    #[tokio::test]
    async fn restaurar_reemplaza_lo_que_habia() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('vieja', 'Terraza vieja');",
                    (),
                )
                .await
                .unwrap();
        }

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 42,
                total_filas: 1,
                tablas: vec![tabla("Zonas", vec![vec![json!("z1"), json!("Salon")]])],
                backfill: vec![],
            }, "negocio-de-prueba")
            .await
            .unwrap();

        assert_eq!(zonas(&db).await, vec!["Salon".to_string()]);
        assert_eq!(r.filas_restauradas, 1);
        assert_eq!(r.seq, 42);
    }

    /// El resumen diario de las estadísticas es una caché de la base de antes: restaurar lo vacía y
    /// deja por rehacer todos los días con cobros de la base nueva.
    #[tokio::test]
    async fn restaurar_deja_por_rehacer_el_resumen_de_las_estadisticas() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO _Estad_Mesa_Dia VALUES ('2025-01-01', 'm-vieja', 999, 1, 1, 1);
                     INSERT INTO _Estad_Producto_Dia VALUES ('2025-01-01', 'p-viejo', 'Viejo', 9);",
                )
                .await
                .unwrap();
        }

        let fila = |id: &str, comanda: &str, cuando: &str| {
            vec![json!(id), json!(comanda), json!(cuando), json!("Efectivo"), json!(500), json!("total")]
        };
        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 5,
            total_filas: 4,
            tablas: vec![
                BootstrapTabla {
                    nombre: "Comandas".into(),
                    columnas: ["ID_Comanda", "Canal", "Fecha_Hora_Apertura", "Estado"].map(String::from).to_vec(),
                    filas: vec![
                        vec![json!("c1"), json!("BARRA"), json!("2026-03-02 12:00:00"), json!("Pagada")],
                        vec![json!("c2"), json!("BARRA"), json!("2026-03-05 12:00:00"), json!("Pagada")],
                    ],
                    parcial: false,
                },
                BootstrapTabla {
                    nombre: "Pagos".into(),
                    columnas: ["ID_Pago", "ID_Comanda", "Fecha_Hora", "Metodo_Pago", "Importe_Total", "Tipo"]
                        .map(String::from)
                        .to_vec(),
                    filas: vec![fila("p1", "c1", "2026-03-02 13:00:00"), fila("p2", "c2", "2026-03-05 13:00:00")],
                    parcial: false,
                },
            ],
            backfill: vec![],
        }, "negocio-de-prueba")
        .await
        .unwrap();

        let r = db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT (SELECT COUNT(*) FROM _Estad_Mesa_Dia) + (SELECT COUNT(*) FROM _Estad_Producto_Dia), \
                        (SELECT group_concat(Dia, ',') FROM (SELECT Dia FROM _Estad_Dias_Sucios ORDER BY Dia));",
                (),
            )
            .await
            .unwrap();
        let f = rows.next().await.unwrap().unwrap();
        assert_eq!(f.get_value(0).unwrap(), Value::Integer(0), "lo resumido de antes no se queda");
        assert_eq!(f.get_value(1).unwrap(), Value::Text("2026-03-02,2026-03-05".into()));
    }

    /// El checkpoint queda EXACTAMENTE en el `seq` de la foto: es lo que hace que el catch-up
    /// siga desde justo después, sin repetir lo que ya está ni saltarse lo que falta.
    #[tokio::test]
    async fn restaurar_deja_el_checkpoint_en_el_seq_de_la_foto() {
        let (repo, _db, _dir) = repo_temporal().await;
        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 777,
            total_filas: 0,
            tablas: vec![tabla("Zonas", vec![])],
            backfill: vec![],
        }, "negocio-de-prueba")
        .await
        .unwrap();

        assert_eq!(repo.get_checkpoint().await.unwrap(), 777);
    }

    /// Un volcado que falla a mitad no puede dejar la BD a medias: o entra entera o no entra nada.
    /// Aquí la segunda fila repite la clave primaria, así que el INSERT revienta después de que el
    /// DELETE previo ya se haya ejecutado.
    #[tokio::test]
    async fn un_volcado_invalido_no_deja_la_bd_a_medias() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('previa', 'Barra');",
                    (),
                )
                .await
                .unwrap();
        }

        let err = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 9,
                total_filas: 2,
                tablas: vec![tabla(
                    "Zonas",
                    vec![
                        vec![json!("dup"), json!("Uno")],
                        vec![json!("dup"), json!("Dos")],
                    ],
                )],
                backfill: vec![],
            }, "negocio-de-prueba")
            .await;

        assert!(err.is_err());
        // Ni el DELETE ni los INSERT deben haber quedado: la fila de antes sigue ahí.
        assert_eq!(zonas(&db).await, vec!["Barra".to_string()]);
        assert_eq!(repo.get_checkpoint().await.unwrap(), 0);
    }

    /// Una nube más nueva manda tablas que esta versión aún no tiene. Recuperar debe seguir
    /// funcionando con lo que sí conoce, y DECIR lo que se ha quedado fuera.
    #[tokio::test]
    async fn una_tabla_desconocida_se_informa_sin_romper_la_recuperacion() {
        let (repo, db, _dir) = repo_temporal().await;

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 5,
                total_filas: 1,
                tablas: vec![
                    tabla("Zonas", vec![vec![json!("z1"), json!("Salon")]]),
                    tabla("Tabla_Del_Futuro", vec![vec![json!("x"), json!("y")]]),
                ],
                backfill: vec![],
            }, "negocio-de-prueba")
            .await
            .unwrap();

        assert_eq!(zonas(&db).await, vec!["Salon".to_string()]);
        assert_eq!(r.tablas_restauradas, vec!["Zonas".to_string()]);
        assert_eq!(r.tablas_desconocidas, vec!["Tabla_Del_Futuro".to_string()]);
    }

    /// Los nombres del volcado se interpolan en el SQL (no se pueden enlazar con `?`), así que uno
    /// que no sea un identificador simple se descarta en vez de acabar en una sentencia.
    #[tokio::test]
    async fn un_nombre_de_tabla_con_sintaxis_se_descarta() {
        let (repo, db, _dir) = repo_temporal().await;

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 1,
                total_filas: 0,
                tablas: vec![
                    tabla("Zonas", vec![]),
                    tabla("Zonas\"; DROP TABLE Zonas; --", vec![]),
                ],
                backfill: vec![],
            }, "negocio-de-prueba")
            .await
            .unwrap();

        assert_eq!(r.tablas_restauradas, vec!["Zonas".to_string()]);
        assert_eq!(r.tablas_desconocidas.len(), 1);
        // La tabla sigue viva: la sentencia nunca llegó a construirse.
        assert!(zonas(&db).await.is_empty());
    }

    /// El agrupado en sentencias multi-fila tiene que dar el mismo resultado que fila a fila,
    /// incluido el caso que cruza el tope de parámetros por sentencia.
    #[tokio::test]
    async fn restaura_bien_por_encima_del_tope_de_parametros() {
        let (repo, db, _dir) = repo_temporal().await;

        let n = (MAX_PARAMS_POR_SENTENCIA / 2) + 7;
        let filas: Vec<Vec<serde_json::Value>> = (0..n)
            .map(|i| vec![json!(format!("z{i}")), json!(format!("Zona {i}"))])
            .collect();

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 3,
                total_filas: n as i64,
                tablas: vec![tabla("Zonas", filas)],
                backfill: vec![],
            }, "negocio-de-prueba")
            .await
            .unwrap();

        assert_eq!(r.filas_restauradas, n as i64);
        assert_eq!(zonas(&db).await.len(), n);
    }

    /// La guardia que hace que esto no pueda comerse una venta: restaurar VACÍA las tablas, así que
    /// una escritura local que todavía no ha llegado a la nube desaparecería sin dejar rastro.
    #[tokio::test]
    async fn no_restaura_si_quedan_escrituras_locales_sin_subir() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            // Un usuario: es lo que distingue una BD que ESTÁ operando —y cuyo outbox puede
            // contener una venta— de una que perdió sus datos, donde ni se puede iniciar sesión.
            // La guardia sólo protege a la primera (ver el test siguiente).
            conn.execute(
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre)                  SELECT 'u1', ID_Rol, 'ana@bar.example', 'x', 'Ana' FROM Roles LIMIT 1;",
                (),
            )
            .await
            .unwrap();
            conn.execute(
                "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('local', 'Sin subir');",
                (),
            )
            .await
            .unwrap();
            conn.execute(
                "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
                 VALUES ('op-1', 'test', '[]', 1);",
                (),
            )
            .await
            .unwrap();
        }

        let err = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 100,
                total_filas: 0,
                tablas: vec![tabla("Zonas", vec![])],
                backfill: vec![],
            }, "negocio-de-prueba")
            .await;

        assert!(err.is_err(), "no puede restaurar con el outbox pendiente");
        // Y no ha tocado nada: ni la fila local ni el checkpoint.
        assert_eq!(zonas(&db).await, vec!["Sin subir".to_string()]);
        assert_eq!(repo.get_checkpoint().await.unwrap(), 0);
    }

    /// La otra cara: sin usuarios, ese mismo outbox NO puede cerrar la única salida.
    ///
    /// En una BD sin usuarios no se puede iniciar sesión, así que lo que tenga pendiente no es una
    /// venta: lo escribió algo que no debería haber escrito (el aviso de actualización lo hacía).
    /// Negarle la restauración por eso deja el equipo inservible para siempre, porque el socket no
    /// se abre mientras faltan los datos y esa operación no se puede subir jamás.
    #[tokio::test]
    async fn una_bd_sin_usuarios_restaura_aunque_le_quede_outbox() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-huerfana', 'test', '[]', 1);",
                    (),
                )
                .await
                .unwrap();
        }

        let r = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 100,
                total_filas: 1,
                tablas: vec![tabla(
                    "Zonas",
                    vec![vec![json!("z1"), json!("Terraza")]],
                )],
                backfill: vec![],
            }, "negocio-de-prueba")
            .await
            .unwrap();

        assert_eq!(r.filas_restauradas, 1);
        assert_eq!(zonas(&db).await, vec!["Terraza".to_string()]);
        assert_eq!(repo.get_checkpoint().await.unwrap(), 100);
    }

    // -- Traslado de licencia ---------------------------------------------------------------
    //
    // Un equipo que fue la Main y al que la licencia vuelve después de haber estado en otro: su
    // base tiene usuarios, datos y operaciones que nunca subieron, todo de antes. Lo que se fija es
    // que ese outbox no sube (pisaría lo que hizo el otro equipo), que la nube reemplaza la base
    // igualmente, que lo de antes queda guardado y que un fallo a mitad no da el traslado por hecho.

    async fn base_de_una_main_de_antes(db: &Arc<Db>) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in [
            "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) \
             SELECT 'u1', ID_Rol, 'ana@bar.example', 'x', 'Ana' FROM Roles LIMIT 1;",
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('vieja', 'De antes');",
            "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
             VALUES ('op-de-antes', 'test', '[]', 1);",
        ] {
            conn.execute(sql, ()).await.unwrap();
        }
    }

    async fn contar(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        let mut rows = r.conn().query(sql, ()).await.unwrap();
        v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap_or(0)
    }

    #[tokio::test]
    async fn tras_un_traslado_el_outbox_de_antes_no_sube() {
        let (repo, db, dir) = repo_temporal().await;
        base_de_una_main_de_antes(&db).await;
        assert_eq!(repo.outbox_pending(10).await.unwrap().len(), 1);

        crate::recovery::marcar_traslado(&dir).unwrap();
        assert!(repo.outbox_pending(10).await.unwrap().is_empty());
        // No se borra por no ofrecerlo: sigue ahí hasta que la reconstrucción lo guarde aparte.
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 1);
    }

    #[tokio::test]
    async fn tras_un_traslado_la_nube_reemplaza_la_base_y_lo_de_antes_queda_guardado() {
        let (repo, db, dir) = repo_temporal().await;
        base_de_una_main_de_antes(&db).await;
        crate::recovery::marcar_traslado(&dir).unwrap();

        // Sin traslado, este mismo outbox impediría restaurar (ver el test de la guardia).
        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 100,
            total_filas: 1,
            tablas: vec![tabla("Zonas", vec![vec![json!("z1"), json!("Terraza")]])],
            backfill: vec![],
        }, "negocio-de-prueba")
        .await
        .unwrap();

        assert_eq!(zonas(&db).await, vec!["Terraza".to_string()]);
        assert_eq!(repo.get_checkpoint().await.unwrap(), 100);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0);
        assert!(!crate::recovery::hay_traslado_pendiente(&dir));
        // Y sigue el camino de cualquier restauración: reconciliar antes de abrir el login.
        assert_eq!(
            crate::recovery::status(&db).await.unwrap().state,
            tpv_contracts::recovery::RecoveryState::ReconciliationPending
        );

        // La base de antes, entera y con lo que no llegó a subir.
        let copia = std::fs::read_dir(dir.join("backups"))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("antes-de-traslado-"))
            })
            .expect("la base de antes del traslado tiene que quedar guardada");
        // Se guarda comprimida, como todas las copias (RI-41).
        let abierta = dir.join("antes-de-traslado.db");
        crate::recovery::descomprimir(&copia, &abierta).await.unwrap();
        let vieja = Db::open(abierta.to_str().unwrap()).await.unwrap();
        assert_eq!(zonas(&vieja).await, vec!["De antes".to_string()]);
        assert_eq!(contar(&vieja, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 1);
    }

    #[tokio::test]
    async fn si_la_reconstruccion_falla_el_traslado_sigue_pendiente() {
        let (repo, db, dir) = repo_temporal().await;
        base_de_una_main_de_antes(&db).await;
        crate::recovery::marcar_traslado(&dir).unwrap();

        // La misma clave primaria dos veces: el volcado revienta a mitad.
        let err = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 100,
                total_filas: 2,
                tablas: vec![tabla(
                    "Zonas",
                    vec![vec![json!("z1"), json!("A")], vec![json!("z1"), json!("B")]],
                )],
                backfill: vec![],
            }, "negocio-de-prueba")
            .await;

        assert!(err.is_err());
        assert!(crate::recovery::hay_traslado_pendiente(&dir), "sin reconstruir, sigue pendiente");
        assert_eq!(zonas(&db).await, vec!["De antes".to_string()]);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 1);
        assert!(repo.outbox_pending(10).await.unwrap().is_empty());
    }

    /// AUD-06 · La reconstrucción sella la base con el negocio de la nube de la que viene, en la
    /// misma transacción. Y una base sellada con otro negocio no se rellena con los datos de éste:
    /// se rechaza sin tocar nada (se aparta entera al volver a abrirla).
    #[tokio::test]
    async fn la_reconstruccion_sella_la_base_y_no_rellena_la_de_otro_negocio() {
        let (repo, db, _dir) = repo_temporal().await;
        let volcado = || BootstrapSnapshot {
            seq: 10,
            total_filas: 1,
            tablas: vec![tabla("Zonas", vec![vec![json!("z1"), json!("Salon")]])],
            backfill: vec![],
        };

        repo.bootstrap_restaurar(volcado(), "negocio-a").await.unwrap();
        assert_eq!(crate::sello::leer(&db.read().await).await.unwrap().as_deref(), Some("negocio-a"));

        {
            let w = db.write().await;
            w.raw().execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z2', 'De A');", ()).await.unwrap();
        }
        let err = repo.bootstrap_restaurar(volcado(), "negocio-x").await.unwrap_err();
        assert!(err.to_string().contains("son de otro negocio"), "{err}");
        assert_eq!(zonas(&db).await, vec!["De A".to_string(), "Salon".to_string()], "no se ha tocado nada");
        assert_eq!(crate::sello::leer(&db.read().await).await.unwrap().as_deref(), Some("negocio-a"));
    }

}

#[cfg(test)]
mod tests_backfill {
    //! SYNC-19 · fase 2: el histórico que la ventana del bootstrap dejó fuera.
    //!
    //! Los dos fallos que este módulo existe para impedir no se ven mirando la app:
    //!
    //! - si la fase 2 pisara una fila que ya está, machacaría con una versión vieja del histórico
    //!   lo que el catch-up acaba de traer al día;
    //! - si sus escrituras pasaran por la captura del outbox, el equipo devolvería a la nube —fila
    //!   a fila, y facturado como escrituras en Turso— el histórico entero que acaba de bajarse de
    //!   ella, para no cambiar absolutamente nada.
    //!
    //! Ninguno de los dos da un error. El primero da un dato incorrecto que nadie mira y el segundo
    //! da una factura.

    use super::*;
    use crate::db::Db;
    use serde_json::json;
    use tpv_application::ports::sync::SyncRepository;
    use tpv_contracts::sync::{BootstrapSnapshot, BootstrapTabla, HistoricoPagina};

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("backfill");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap())
            .await
            .unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    /// Deja el equipo como tras una recuperación: restaurado y con `Zonas` pendiente de backfill.
    async fn tras_recuperar(repo: &SqliteSyncRepository) {
        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 10,
            total_filas: 0,
            tablas: vec![BootstrapTabla {
                nombre: "Zonas".into(),
                columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
                filas: vec![],
                parcial: true,
            }],
            backfill: vec!["Zonas".into()],
        }, "negocio-de-prueba")
        .await
        .unwrap();
    }

    fn pagina(filas: Vec<Vec<serde_json::Value>>, siguiente: Option<i64>) -> HistoricoPagina {
        HistoricoPagina {
            tabla: "Zonas".into(),
            columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
            filas,
            siguiente_cursor: siguiente,
        }
    }

    async fn contar(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        let mut rows = r.conn().query(sql, ()).await.unwrap();
        match rows.next().await.unwrap() {
            Some(row) => v_i64(row.get_value(0).unwrap()).unwrap_or(0),
            None => 0,
        }
    }

    async fn nombre_zona(db: &Arc<Db>, id: &str) -> Option<String> {
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = ?1;",
                vec![Value::Text(id.to_string())],
            )
            .await
            .unwrap();
        match rows.next().await.unwrap() {
            Some(row) => match row.get_value(0).unwrap() {
                Value::Text(n) => Some(n),
                _ => None,
            },
            None => None,
        }
    }

    /// El bootstrap siembra la cola con lo que el worker marcó recortado, y en SU orden.
    #[tokio::test]
    async fn restaurar_siembra_la_cola_del_backfill() {
        let (repo, _db, dir) = repo_temporal().await;

        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 1,
            total_filas: 0,
            tablas: vec![
                BootstrapTabla {
                    nombre: "Zonas".into(),
                    columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
                    filas: vec![],
                    parcial: false,
                },
                BootstrapTabla {
                    nombre: "Comandas".into(),
                    columnas: vec!["ID_Comanda".into()],
                    filas: vec![],
                    parcial: true,
                },
            ],
            // Padres primero: es lo único que hace viable la fase 2, porque cada página es su
            // propia transacción y `defer_foreign_keys` no cubre entre transacciones.
            backfill: vec!["Comandas".into(), "Detalle_Comanda".into()],
        }, "negocio-de-prueba")
        .await
        .unwrap();

        assert_eq!(
            repo.backfill_siguiente().await.unwrap(),
            Some(("Comandas".to_string(), 0)),
            "la primera del orden que dio el worker, no la primera alfabéticamente"
        );

        let e = repo.backfill_estado().await.unwrap();
        assert_eq!(e.tablas_pendientes, 2);
        assert_eq!(e.tablas_completadas, 0);
        // `Zonas` vino entera: no tiene nada que rellenar y no entra en la cola.
        assert_eq!(e.tabla_actual.as_deref(), Some("Comandas"));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Lo que no es de negocio no viaja: lo que empieza por `_` es estado de este equipo (aquí, el
    /// resumen de las estadísticas) y `Sync_Changes` es el log de la nube, que en la Main está vacío
    /// (es lo que deja sin efecto aquí el borrado condicionado del contraste). Aunque la nube los
    /// mandara en el volcado o en una página del histórico, no se restauran, no entran en la cola del
    /// histórico y no se rellenan.
    #[tokio::test]
    async fn lo_que_no_es_de_negocio_no_se_restaura_ni_se_rellena_aunque_lo_mande_la_nube() {
        let (repo, db, dir) = repo_temporal().await;
        let ajeno = |dia: &str| vec![json!(dia)];
        let cambio = |seq: i64| vec![json!(seq), json!(format!("op-{seq}")), json!("[]"), json!(1)];
        let columnas_del_log = || vec!["Seq".into(), "Op_Id".into(), "Statements_Json".into(), "Created_At_Ms".into()];

        let resultado = repo
            .bootstrap_restaurar(BootstrapSnapshot {
                seq: 1,
                total_filas: 3,
                tablas: vec![
                    BootstrapTabla {
                        nombre: "Zonas".into(),
                        columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
                        filas: vec![vec![json!("z1"), json!("Sala")]],
                        parcial: false,
                    },
                    BootstrapTabla {
                        nombre: "_Estad_Dias_Sucios".into(),
                        columnas: vec!["Dia".into()],
                        filas: vec![ajeno("1999-01-01")],
                        parcial: true,
                    },
                    BootstrapTabla { nombre: "Sync_Changes".into(), columnas: columnas_del_log(), filas: vec![cambio(1)], parcial: true },
                ],
                backfill: vec!["_Estad_Dias_Sucios".into(), "Sync_Changes".into()],
            }, "negocio-de-prueba")
            .await
            .unwrap();

        assert_eq!(resultado.tablas_restauradas, ["Zonas"]);
        assert_eq!(resultado.filas_restauradas, 1);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Zonas;").await, 1);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Sync_Changes;").await, 0);
        assert_eq!(repo.backfill_siguiente().await.unwrap(), None, "ninguna de las dos entra en la cola");

        let pagina = HistoricoPagina {
            tabla: "_Estad_Dias_Sucios".into(),
            columnas: vec!["Dia".into()],
            filas: vec![ajeno("1999-01-02")],
            siguiente_cursor: None,
        };
        assert_eq!(repo.backfill_aplicar_pagina(pagina).await.unwrap(), 0);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM _Estad_Dias_Sucios WHERE Dia LIKE '1999-%';").await, 0);
        let pagina = HistoricoPagina { tabla: "Sync_Changes".into(), columnas: columnas_del_log(), filas: vec![cambio(2)], siguiente_cursor: None };
        assert_eq!(repo.backfill_aplicar_pagina(pagina).await.unwrap(), 0);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Sync_Changes;").await, 0);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn no_es_de_negocio_lo_que_el_worker_tampoco_manda() {
        for t in ["_Estad_Dias_Sucios", "_Negocio", "_Sync_Outbox", "sqlite_sequence", "Sync_Changes", "sync_changes", "Applied_Operations", "Sync_Main_Checkpoints", "Intentos_Login"] {
            assert!(no_es_tabla_de_negocio(t), "{t}");
        }
        for t in ["Zonas", "Pagos", "Detalle_Comanda", "Usuarios"] {
            assert!(!no_es_tabla_de_negocio(t), "{t}");
        }
    }

    /// SYNC-19. La fase 2 NUNCA pisa una fila que ya esté: lo que está en local llegó por el
    /// catch-up y es más nuevo que esta foto del histórico.
    #[tokio::test]
    async fn una_pagina_no_pisa_lo_que_ya_esta() {
        let (repo, db, dir) = repo_temporal().await;
        tras_recuperar(&repo).await;

        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Nombre nuevo');",
                    (),
                )
                .await
                .unwrap();
        }

        repo.backfill_aplicar_pagina(pagina(
            vec![
                vec![json!("z1"), json!("Nombre VIEJO del historico")],
                vec![json!("z2"), json!("Terraza")],
            ],
            None,
        ))
        .await
        .unwrap();

        assert_eq!(
            nombre_zona(&db, "z1").await.as_deref(),
            Some("Nombre nuevo"),
            "la versión que ya estaba manda"
        );
        assert_eq!(
            nombre_zona(&db, "z2").await.as_deref(),
            Some("Terraza"),
            "y la que no estaba sí entra"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// SYNC-19: el backfill va por `raw()`, y es el más caro de los dos si se rompe.
    #[tokio::test]
    async fn el_backfill_no_deja_nada_en_el_outbox() {
        let (repo, db, dir) = repo_temporal().await;
        tras_recuperar(&repo).await;

        assert_eq!(contar(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0);

        repo.backfill_aplicar_pagina(pagina(
            vec![
                vec![json!("z1"), json!("Terraza")],
                vec![json!("z2"), json!("Salon")],
            ],
            None,
        ))
        .await
        .unwrap();

        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Zonas;").await, 2);
        assert_eq!(
            contar(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await,
            0,
            "el histórico que baja de la nube NO puede volver a subir a la nube"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// El cursor avanza mientras haya páginas, y la tabla se cierra con la que no trae cursor.
    #[tokio::test]
    async fn el_cursor_avanza_y_la_tabla_se_completa() {
        let (repo, _db, dir) = repo_temporal().await;
        tras_recuperar(&repo).await;

        repo.backfill_aplicar_pagina(pagina(vec![vec![json!("z1"), json!("A")]], Some(50)))
            .await
            .unwrap();
        assert_eq!(
            repo.backfill_siguiente().await.unwrap(),
            Some(("Zonas".to_string(), 50))
        );

        repo.backfill_aplicar_pagina(pagina(vec![vec![json!("z2"), json!("B")]], None))
            .await
            .unwrap();
        assert_eq!(
            repo.backfill_siguiente().await.unwrap(),
            None,
            "sin cursor siguiente, la tabla está completa"
        );

        let e = repo.backfill_estado().await.unwrap();
        assert_eq!(e.tablas_pendientes, 0);
        assert_eq!(e.tablas_completadas, 1);
        assert_eq!(e.filas_traidas, 2);
        assert_eq!(e.tabla_actual, None);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Repetir una página no cambia nada. Es lo que el motor de jobs exige de cualquier cuerpo, y
    /// aquí es además lo que permite reanudar tras un apagón sin llevar más contabilidad.
    #[tokio::test]
    async fn repetir_una_pagina_es_un_no_op() {
        let (repo, db, dir) = repo_temporal().await;
        tras_recuperar(&repo).await;

        let p = || pagina(vec![vec![json!("z1"), json!("Terraza")]], Some(7));
        repo.backfill_aplicar_pagina(p()).await.unwrap();
        repo.backfill_aplicar_pagina(p()).await.unwrap();

        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Zonas;").await, 1);
        assert_eq!(
            repo.backfill_siguiente().await.unwrap(),
            Some(("Zonas".to_string(), 7))
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una página que falla no mueve el cursor: el siguiente intento la repite entera. Si el cursor
    /// avanzara igualmente, ese trozo del histórico se perdería para siempre y en silencio.
    #[tokio::test]
    async fn una_pagina_que_falla_no_mueve_el_cursor() {
        let (repo, db, dir) = repo_temporal().await;
        tras_recuperar(&repo).await;

        let mala = HistoricoPagina {
            tabla: "Zonas".into(),
            columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
            // Una fila con menos valores que columnas: el volcado viene de la red y puede llegar mal.
            filas: vec![vec![json!("z1")]],
            siguiente_cursor: Some(99),
        };

        assert!(repo.backfill_aplicar_pagina(mala).await.is_err());
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Zonas;").await, 0);
        assert_eq!(
            repo.backfill_siguiente().await.unwrap(),
            Some(("Zonas".to_string(), 0)),
            "el cursor se queda donde estaba"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Tras recuperar con la ventana de los cierres: el de la fase 1 (`cierre-y`, que empieza en `A`)
    /// y el histórico de esa tabla pendiente.
    async fn tras_recuperar_los_cierres(repo: &SqliteSyncRepository) {
        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 10,
            total_filas: 1,
            tablas: vec![BootstrapTabla {
                nombre: "Cierres_Caja".into(),
                columnas: vec!["ID_Cierre".into(), "Fecha_Hora".into(), "Periodo_Desde".into()],
                filas: vec![vec![json!("cierre-y"), json!("2026-11-12 02:00:00"), json!("2026-04-30 02:00:00")]],
                parcial: true,
            }],
            backfill: vec!["Cierres_Caja".into()],
        }, "negocio-de-prueba")
        .await
        .unwrap();
    }

    fn pagina_de_cierres(filas: Vec<Vec<serde_json::Value>>) -> HistoricoPagina {
        HistoricoPagina {
            tabla: "Cierres_Caja".into(),
            columnas: vec!["ID_Cierre".into(), "Fecha_Hora".into(), "Periodo_Desde".into()],
            filas,
            siguiente_cursor: None,
        }
    }

    /// Una fila del histórico que choca con OTRA de aquí por un índice único no se salta.
    ///
    /// Con `INSERT OR IGNORE` se saltaba en silencio: el cursor avanzaba, la tabla quedaba
    /// completada sin ella, y el contraste con la nube la veía después como una fila que sobra
    /// arriba y la borraba también allí. Aquí `cierre-x` y `cierre-y` empiezan en el mismo sitio y
    /// los dos están vigentes (`idx_cierres_un_periodo`): en la nube no pueden estarlo a la vez, así
    /// que el de aquí va por detrás (la reapertura de `cierre-y` todavía no ha bajado).
    #[tokio::test]
    async fn una_fila_que_choca_con_otra_por_un_indice_unico_no_se_salta() {
        let (repo, db, dir) = repo_temporal().await;
        tras_recuperar_los_cierres(&repo).await;
        let pagina = || {
            pagina_de_cierres(vec![
                vec![json!("cierre-v"), json!("2026-03-31 02:00:00"), serde_json::Value::Null],
                vec![json!("cierre-x"), json!("2026-05-31 02:00:00"), json!("2026-04-30 02:00:00")],
                vec![json!("cierre-y"), json!("2026-11-12 02:00:00"), json!("2026-04-30 02:00:00")],
            ])
        };

        let e = repo.backfill_aplicar_pagina(pagina()).await.unwrap_err().to_string();
        assert!(e.contains("cierre-x") && e.contains("idx_cierres_un_periodo"), "dice qué fila y por qué: {e}");
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 1, "la página no entra a medias");
        let estado = repo.backfill_estado().await.unwrap();
        assert_eq!((estado.tablas_pendientes, estado.filas_traidas), (1, 0), "ni se da por completada");
        assert_eq!(repo.backfill_siguiente().await.unwrap(), Some(("Cierres_Caja".to_string(), 0)));

        // Baja la reapertura de `cierre-y` y la página, repetida, entra entera; el de aquí se queda
        // como está.
        {
            let w = db.write().await;
            w.raw()
                .execute_batch("UPDATE Cierres_Caja SET Reabierto_En = '2026-06-01 10:00:00' WHERE ID_Cierre = 'cierre-y';")
                .await
                .unwrap();
        }
        assert_eq!(repo.backfill_aplicar_pagina(pagina()).await.unwrap(), 3);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Cierres_Caja;").await, 3);
        assert_eq!(
            contar(&db, "SELECT COUNT(*) FROM Cierres_Caja WHERE ID_Cierre = 'cierre-y' AND Reabierto_En IS NOT NULL;").await,
            1
        );
        assert_eq!(repo.backfill_estado().await.unwrap().tablas_pendientes, 0);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una fila cuyo padre no está aquí hace fallar la página al final (las foráneas van
    /// diferidas), y el error dice cuál es y a qué tabla apunta.
    #[tokio::test]
    async fn una_fila_sin_su_padre_no_entra_y_se_dice_cual_es() {
        let (repo, db, dir) = repo_temporal().await;
        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 10,
            total_filas: 0,
            tablas: vec![BootstrapTabla {
                nombre: "Detalle_Comanda".into(),
                columnas: vec!["ID_Detalle".into()],
                filas: vec![],
                parcial: true,
            }],
            backfill: vec!["Detalle_Comanda".into()],
        }, "negocio-de-prueba")
        .await
        .unwrap();

        let e = repo
            .backfill_aplicar_pagina(HistoricoPagina {
                tabla: "Detalle_Comanda".into(),
                columnas: vec!["ID_Detalle".into(), "ID_Comanda".into(), "Cantidad".into(), "Precio_Unitario".into()],
                filas: vec![vec![json!("d-1"), json!("c-que-no-esta"), json!(1), json!(250)]],
                siguiente_cursor: None,
            })
            .await
            .unwrap_err()
            .to_string();
        assert!(e.contains("d-1") && e.contains("Comandas"), "{e}");
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Detalle_Comanda;").await, 0);
        assert_eq!(repo.backfill_estado().await.unwrap().tablas_pendientes, 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Lo mismo con una fila que no cumple una restricción de la tabla: `INSERT OR IGNORE` también
    /// se la saltaba.
    #[tokio::test]
    async fn una_fila_que_no_cumple_una_restriccion_tampoco_se_salta() {
        let (repo, db, dir) = repo_temporal().await;
        tras_recuperar(&repo).await;

        let mala = pagina(vec![vec![json!("z1"), json!("Terraza")], vec![json!("z2"), serde_json::Value::Null]], None);
        let e = repo.backfill_aplicar_pagina(mala).await.unwrap_err().to_string();
        assert!(e.contains("z2") && e.contains("NOT NULL"), "{e}");
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Zonas;").await, 0);
        assert_eq!(repo.backfill_estado().await.unwrap().tablas_pendientes, 1);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Lo único que la fase 2 da por bueno sin insertarlo es lo que ya está por su clave primaria,
    /// así que cada tabla del negocio tiene que tener una.
    #[tokio::test]
    async fn todas_las_tablas_del_negocio_tienen_clave_primaria() {
        let (_repo, db, dir) = repo_temporal().await;
        let r = db.read().await;
        let mut filas = r
            .conn()
            .query(
                "SELECT m.name FROM sqlite_master m WHERE m.type = 'table' \
                   AND substr(m.name, 1, 7) <> 'sqlite_' AND substr(m.name, 1, 1) <> '_' \
                   AND NOT EXISTS (SELECT 1 FROM pragma_table_info(m.name) WHERE pk > 0);",
                (),
            )
            .await
            .unwrap();
        let mut sin_clave = Vec::new();
        while let Some(f) = filas.next().await.unwrap() {
            sin_clave.push(f.get::<String>(0).unwrap());
        }
        assert!(sin_clave.is_empty(), "{sin_clave:?}");
        drop(filas);
        drop(r);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Una tabla que esta versión no conoce se salta. Si fallara, el backfill se quedaría atascado
    /// en ella para siempre y ninguna de las siguientes llegaría a bajarse.
    #[tokio::test]
    async fn una_tabla_desconocida_se_salta_en_vez_de_atascar_la_cola() {
        let (repo, _db, dir) = repo_temporal().await;

        repo.bootstrap_restaurar(BootstrapSnapshot {
            seq: 1,
            total_filas: 0,
            tablas: vec![BootstrapTabla {
                nombre: "Zonas".into(),
                columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
                filas: vec![],
                parcial: true,
            }],
            backfill: vec!["Tabla_Del_Futuro".into(), "Zonas".into()],
        }, "negocio-de-prueba")
        .await
        .unwrap();

        assert_eq!(
            repo.backfill_siguiente().await.unwrap(),
            Some(("Tabla_Del_Futuro".to_string(), 0))
        );

        repo.backfill_aplicar_pagina(HistoricoPagina {
            tabla: "Tabla_Del_Futuro".into(),
            columnas: vec![],
            filas: vec![],
            siguiente_cursor: None,
        })
        .await
        .unwrap();

        assert_eq!(
            repo.backfill_siguiente().await.unwrap(),
            Some(("Zonas".to_string(), 0)),
            "la cola sigue avanzando"
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Los nombres de tabla y de columna se interpolan en el SQL (no se pueden enlazar con `?`) y
    /// llegan de la red, así que se filtran antes de construir nada.
    #[tokio::test]
    async fn un_nombre_inaceptable_se_rechaza() {
        let (repo, _db, dir) = repo_temporal().await;
        tras_recuperar(&repo).await;

        assert!(repo
            .backfill_aplicar_pagina(HistoricoPagina {
                tabla: "Zonas; DROP TABLE Pagos".into(),
                columnas: vec!["ID_Zona".into()],
                filas: vec![],
                siguiente_cursor: None,
            })
            .await
            .is_err());

        assert!(repo
            .backfill_aplicar_pagina(HistoricoPagina {
                tabla: "Zonas".into(),
                columnas: vec!["ID_Zona\") --".into()],
                filas: vec![vec![json!("z1")]],
                siguiente_cursor: None,
            })
            .await
            .is_err());

        let _ = std::fs::remove_dir_all(dir);
    }

    /// Un equipo que nunca ha perdido su base no tiene cola, y preguntarlo tiene que ser barato y
    /// no exigir saber antes si hay una recuperación en curso.
    #[tokio::test]
    async fn sin_recuperacion_no_hay_backfill() {
        let (repo, _db, dir) = repo_temporal().await;

        assert_eq!(repo.backfill_siguiente().await.unwrap(), None);
        let e = repo.backfill_estado().await.unwrap();
        assert_eq!(e.tablas_pendientes, 0);
        assert_eq!(e.tablas_completadas, 0);
        assert_eq!(e.filas_traidas, 0);

        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests_reparacion {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! SYNC-22 — volver a igualar la fila que la nube no tiene igual.
    //!
    //! Lo que se fija aquí es que apartar una operación **no** deje la nube distinta para siempre.
    //! Sin esto, la Handy —que lee de la nube y no tiene BD— enseñaría al camarero un precio, una
    //! carta o una mesa distintos de los que ve la Main, y nadie se enteraría hasta el arqueo.

    use std::sync::Arc;

    use crate::ejecutor::Value;
use crate::ejecutor::Connection;
    use tpv_contracts::sync::SqlStatement;

    use super::*;
    use crate::db::Db;
    use crate::sync_reparacion::{analizar, claves_primarias, sentencia_de_reparacion, FilaAfectada};

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("reparacion");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    /// Mete en el outbox una operación con las sentencias que se le den.
    async fn encolar_con(db: &Arc<Db>, op_id: &str, stmts: &[SqlStatement]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        conn.execute(
            "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
             VALUES (?1, 'main_op', ?2, ?3);",
            vec![
                Value::Text(op_id.to_string()),
                Value::Text(serde_json::to_string(stmts).unwrap()),
                Value::Integer(now_ms()),
            ],
        )
        .await
        .unwrap();
    }

    async fn pks(db: &Arc<Db>, tabla: &str) -> Vec<String> {
        let r = db.read().await;
        claves_primarias(r.conn(), tabla).await.unwrap()
    }

    #[tokio::test]
    async fn una_op_apartada_encola_el_estado_ACTUAL_de_la_fila() {
        // El corazón del asunto. La nube rechazó el UPDATE que ponía el nombre a "Terraza". Lo que
        // NO se hace es reintentar aquel UPDATE: para cuando alguien arregle la causa, esa fila
        // puede haber cambiado otra vez y reaplicarlo la devolvería a un valor que ya no es cierto.
        // Lo que se manda es cómo está AHORA.
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');",
                )
                .await
                .unwrap();
        }
        let stmt = SqlStatement {
            sql: "UPDATE Zonas SET Nombre_Zona = ?1 WHERE ID_Zona = ?2;".into(),
            args: vec![serde_json::json!("Terraza"), serde_json::json!("z1")],
        };
        encolar_con(&db, "op-mala", &[stmt]).await;

        // La fila cambia DESPUÉS de que aquella operación se quedara atrás.
        {
            let w = db.write().await;
            w.raw()
                .execute_batch("UPDATE Zonas SET Nombre_Zona = 'Terraza de arriba' WHERE ID_Zona = 'z1';")
                .await
                .unwrap();
        }

        let fallo = repo
            .outbox_mark_failed("op-mala", "no such column: Nombre_Zona", true)
            .await
            .unwrap();
        assert!(fallo.apartada);
        assert_eq!(fallo.reparadas, 1, "debe encolarse la reparación de esa fila");

        // Lo encolado lleva el valor NUEVO, no el que llevaba la sentencia rechazada.
        let pendientes = repo.outbox_pending(100).await.unwrap();
        let rep = pendientes
            .iter()
            .find(|e| e.command_name == crate::sync_reparacion::COMANDO_REPARACION)
            .expect("la reparación tiene que estar en la cola");
        // Upsert, NUNCA `INSERT OR REPLACE`: aquello borra la fila y la reinserta, disparando los
        // `ON DELETE CASCADE` que la apuntan (SYNC-26).
        let sql = &rep.statements[0].sql;
        assert!(sql.contains("INSERT INTO \"Zonas\""), "sql: {sql}");
        assert!(sql.contains("ON CONFLICT(\"ID_Zona\")"), "sql: {sql}");
        assert!(!sql.contains("OR REPLACE"), "sql: {sql}");
        let json = serde_json::to_string(&rep.statements[0].args).unwrap();
        assert!(json.contains("Terraza de arriba"), "args: {json}");
        assert!(!json.contains("\"Terraza\","), "no puede llevar el valor viejo: {json}");
    }

    #[tokio::test]
    async fn apartar_dos_veces_la_misma_op_no_encola_dos_reparaciones() {
        // REV-04: el aviso de que la nube apartó una operación se REPITE —el DO vuelve a ofrecerlo
        // en cada conexión hasta que alguien lo acuse, y un acuse puede perderse—. Sin la guardia,
        // cada repetición encolaría otra reparación de las mismas filas y la cola crecería sola.
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Barra');")
                .await
                .unwrap();
        }
        let stmt = SqlStatement {
            sql: "UPDATE Zonas SET Nombre_Zona = ?1 WHERE ID_Zona = ?2;".into(),
            args: vec![serde_json::json!("Barra"), serde_json::json!("z1")],
        };
        encolar_con(&db, "op-mala", &[stmt]).await;

        let primera = repo
            .outbox_mark_failed("op-mala", "la nube la apartó de su cola", true)
            .await
            .unwrap();
        assert!(primera.apartada);
        assert_eq!(primera.reparadas, 1);

        // El mismo aviso otra vez: ya está todo hecho, así que no pasa nada más.
        let segunda = repo
            .outbox_mark_failed("op-mala", "la nube la apartó de su cola", true)
            .await
            .unwrap();
        assert!(!segunda.apartada, "no vuelve a apartarse lo ya apartado");
        assert_eq!(segunda.reparadas, 0, "y NO se encola otra reparación");

        let reparaciones = repo
            .outbox_pending(100)
            .await
            .unwrap()
            .into_iter()
            .filter(|e| e.command_name == crate::sync_reparacion::COMANDO_REPARACION)
            .count();
        assert_eq!(reparaciones, 1, "una sola reparación en la cola");
    }

    #[tokio::test]
    async fn una_reparacion_que_falla_NO_engendra_otra() {
        // Sin este corte, una fila que la nube se niega a aceptar produciría una reparación nueva
        // por cada intento: la cola crecería sola para siempre.
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Barra');")
                .await
                .unwrap();
        }
        let w = db.write().await;
        w.raw()
            .execute(
                "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
                 VALUES ('op-rep', ?1, ?2, ?3);",
                vec![
                    Value::Text(crate::sync_reparacion::COMANDO_REPARACION.to_string()),
                    Value::Text(
                        serde_json::to_string(&[SqlStatement {
                            sql: "INSERT OR REPLACE INTO \"Zonas\" (\"ID_Zona\") VALUES (?1);".into(),
                            args: vec![serde_json::json!("z1")],
                        }])
                        .unwrap(),
                    ),
                    Value::Integer(now_ms()),
                ],
            )
            .await
            .unwrap();
        drop(w);

        let fallo = repo
            .outbox_mark_failed("op-rep", "no such table: Zonas", true)
            .await
            .unwrap();
        assert!(fallo.apartada);
        assert_eq!(fallo.reparadas, 0, "una reparación apartada no genera otra");
    }

    #[tokio::test]
    async fn un_borrado_no_se_repara_y_se_dice() {
        // La ausencia de una fila no es una fila que mandar. Lo importante no es que no se repare
        // —no se puede— sino que quede CONTADO, para que no se confunda con "ya está igualado".
        let (_repo, db, _dir) = repo_temporal().await;
        let claves = pks(&db, "Zonas").await;
        let a = analizar(
            &[SqlStatement {
                sql: "DELETE FROM Zonas WHERE ID_Zona = ?1;".into(),
                args: vec![serde_json::json!("z1")],
            }],
            &|t: &str| if t == "Zonas" { claves.clone() } else { vec![] },
        );
        assert_eq!(a.borrados, vec!["Zonas".to_string()]);
        assert!(a.filas.is_empty());
        assert!(!a.incierto, "un DELETE se entiende perfectamente: lo que no se puede es repararlo");
    }

    #[tokio::test]
    async fn una_clave_COMPUESTA_no_repara_la_fila_equivocada() {
        // Ocho tablas del esquema tienen clave compuesta. Tratarlas como si tuvieran una sola
        // columna repararía otra fila — y sin error, que es la peor forma de fallar.
        let (_repo, db, _dir) = repo_temporal().await;
        let claves = pks(&db, "Pago_Detalles").await;
        assert_eq!(claves, vec!["ID_Pago".to_string(), "ID_Detalle".to_string()]);

        let a = analizar(
            &[SqlStatement {
                sql: "INSERT INTO Pago_Detalles (ID_Pago, ID_Detalle) VALUES (?1, ?2);".into(),
                args: vec![serde_json::json!("p1"), serde_json::json!("d9")],
            }],
            &|t: &str| if t == "Pago_Detalles" { claves.clone() } else { vec![] },
        );
        assert_eq!(
            a.filas,
            vec![FilaAfectada {
                tabla: "Pago_Detalles".into(),
                clave: vec![
                    ("ID_Pago".into(), "p1".into()),
                    ("ID_Detalle".into(), "d9".into()),
                ],
            }]
        );
    }

    #[tokio::test]
    async fn lo_que_no_se_sabe_leer_se_declara_incierto() {
        // El heurístico reconoce de menos a propósito: una fila que no se identifica NO se repara,
        // así que callárselo sería dejar un descuadre creyendo que está arreglado.
        let (_repo, _db, _dir) = repo_temporal().await;
        let a = analizar(
            &[SqlStatement {
                sql: "UPDATE Productos SET Stock = Stock - 1 WHERE ID_Categoria IN (SELECT x FROM y);"
                    .into(),
                args: vec![],
            }],
            &|_: &str| vec!["ID_Producto".to_string()],
        );
        assert!(a.incierto);
        assert!(a.filas.is_empty());
    }

    #[tokio::test]
    async fn una_fila_ya_borrada_no_produce_sentencia() {
        // Si la fila ya no está en local, no hay estado que mandar. Devolver una sentencia con
        // NULLs la "repararía" dejándola vacía en la nube, que es peor que no tocarla.
        let (_repo, db, _dir) = repo_temporal().await;
        let r = db.read().await;
        let st = sentencia_de_reparacion(
            r.conn(),
            &FilaAfectada {
                tabla: "Zonas".into(),
                clave: vec![("ID_Zona".into(), "no-existe".into())],
            },
        )
        .await
        .unwrap();
        assert!(st.is_none());
    }
}

#[cfg(test)]
mod tests_cascada {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! SYNC-26 — una reparación no puede llevarse por delante las filas hijas.
    //!
    //! Este esquema tiene DIECIOCHO `ON DELETE CASCADE`, y en SQLite un `INSERT OR REPLACE` **borra
    //! la fila que hay y la reinserta**: repararla dispararía todas las cascadas que la apuntan. Con
    //! `Zonas → Mesas` eso significa que arreglar el nombre de una zona dejaría el plano vacío en la
    //! nube, y la Handy sin mesas que pulsar.
    //!
    //! No se comprueba leyendo el SQL: se APLICA la sentencia contra una base de verdad con las FK
    //! encendidas, que es lo único que prueba que la cascada no salta.

    use std::sync::Arc;

    use crate::ejecutor::Value;

    use super::*;
    use crate::db::Db;
    use crate::sync_reparacion::{sentencia_de_reparacion, FilaAfectada};

    async fn base() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("cascada");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    async fn contar(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        let mut rows = r.conn().query(sql, ()).await.unwrap();
        let f = rows.next().await.unwrap().unwrap();
        v_i64(f.get_value(0).unwrap()).unwrap_or(-1)
    }

    #[tokio::test]
    async fn reparar_una_ZONA_no_borra_sus_MESAS() {
        let (db, _dir) = base().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','Terraza');\
                     INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m1','z1','1',4,10,10,'rect',60,60);\
                     INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m2','z1','2',2,80,10,'rect',60,60);",
                )
                .await
                .unwrap();
        }
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Mesas;").await, 2);

        let fila = FilaAfectada {
            tabla: "Zonas".into(),
            clave: vec![("ID_Zona".into(), "z1".into())],
        };
        let st = {
            let r = db.read().await;
            sentencia_de_reparacion(r.conn(), &fila).await.unwrap().unwrap()
        };

        // La prueba: se aplica DE VERDAD, con las FK encendidas (las pone `tune()` al abrir), que es
        // exactamente lo que hará el DO contra el tenant.
        {
            let w = db.write().await;
            let args: Vec<Value> = st
                .args
                .iter()
                .map(|v| match v {
                    serde_json::Value::Null => Value::Null,
                    serde_json::Value::Number(n) => match n.as_i64() {
                        Some(i) => Value::Integer(i),
                        None => Value::Real(n.as_f64().unwrap_or(0.0)),
                    },
                    serde_json::Value::String(s) => Value::Text(s.clone()),
                    otro => Value::Text(otro.to_string()),
                })
                .collect();
            w.raw().execute(&st.sql, args).await.unwrap();
        }

        assert_eq!(
            contar(&db, "SELECT COUNT(*) FROM Mesas;").await,
            2,
            "las mesas de la zona NO pueden desaparecer al reparar la zona (sql: {})",
            st.sql
        );
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM Zonas;").await, 1);
    }

    #[tokio::test]
    async fn la_reparacion_ACTUALIZA_el_valor_no_solo_lo_deja_estar() {
        // El otro lado de la moneda: evitar la cascada no puede costar que la reparación no repare.
        // Si el `DO UPDATE` no asignara las columnas, la fila de la nube se quedaría como estaba y
        // el descuadre seguiría ahí — pero contado como arreglado, que es peor.
        let (db, _dir) = base().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','Nuevo');")
                .await
                .unwrap();
        }
        let st = {
            let r = db.read().await;
            sentencia_de_reparacion(
                r.conn(),
                &FilaAfectada {
                    tabla: "Zonas".into(),
                    clave: vec![("ID_Zona".into(), "z1".into())],
                },
            )
            .await
            .unwrap()
            .unwrap()
        };

        // Se simula "la nube tiene el valor viejo" y se aplica la reparación encima.
        {
            let w = db.write().await;
            w.raw()
                .execute_batch("UPDATE Zonas SET Nombre_Zona = 'Viejo' WHERE ID_Zona = 'z1';")
                .await
                .unwrap();
            let args: Vec<Value> = st
                .args
                .iter()
                .map(|v| match v {
                    serde_json::Value::String(s) => Value::Text(s.clone()),
                    serde_json::Value::Null => Value::Null,
                    otro => Value::Text(otro.to_string()),
                })
                .collect();
            w.raw().execute(&st.sql, args).await.unwrap();
        }

        let r = db.read().await;
        let mut rows = r
            .conn()
            .query("SELECT Nombre_Zona FROM Zonas WHERE ID_Zona = 'z1';", ())
            .await
            .unwrap();
        let f = rows.next().await.unwrap().unwrap();
        match f.get_value(0).unwrap() {
            Value::Text(s) => assert_eq!(s, "Nuevo", "la reparación tiene que pisar el valor viejo"),
            v => panic!("inesperado: {v:?}"),
        }
    }
}

#[cfg(test)]
mod tests_cierre_del_aviso {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! SYNC-26 — el aviso de cuarentena tiene que apagarse SOLO.
    //!
    //! La regla ya estaba escrita en este repo para la escalera fiscal: «un aviso que hay que
    //! descartar a mano después de que el problema se arregle enseña a descartar avisos». Aquí
    //! pasaba: una operación apartada se quedaba en cuarentena para siempre aunque su reparación
    //! hubiera subido, así que Conectividad seguiría en rojo con el problema resuelto.

    use std::sync::Arc;

    use super::*;
    use crate::db::Db;

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("cierre_aviso");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    #[tokio::test]
    async fn cuando_la_reparacion_sube_el_aviso_se_apaga_SOLO() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','Terraza');")
                .await
                .unwrap();
            w.raw()
                .execute(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
                     VALUES ('op-mala', 'main_op', ?1, 1);",
                    vec![Value::Text(
                        serde_json::to_string(&[SqlStatement {
                            sql: "UPDATE Zonas SET Nombre_Zona = ?1 WHERE ID_Zona = ?2;".into(),
                            args: vec![serde_json::json!("Terraza"), serde_json::json!("z1")],
                        }])
                        .unwrap(),
                    )],
                )
                .await
                .unwrap();
        }

        // La nube la rechaza: se aparta y se encola su reparación.
        let fallo = repo
            .outbox_mark_failed("op-mala", "no such column", true)
            .await
            .unwrap();
        assert!(fallo.apartada);
        assert_eq!(fallo.reparadas, 1);
        assert_eq!(
            repo.health().await.unwrap().subida_en_cuarentena,
            1,
            "mientras no se repare, el aviso tiene que estar",
        );

        // La reparación sube.
        let rep = repo
            .outbox_pending(100)
            .await
            .unwrap()
            .into_iter()
            .find(|e| e.command_name == crate::sync_reparacion::COMANDO_REPARACION)
            .expect("la reparación está en la cola");
        repo.outbox_confirmar_lote(&[(rep.op_id.clone(), 7)]).await.unwrap();

        // Y el aviso se apaga sin que nadie lo descarte.
        let salud = repo.health().await.unwrap();
        assert_eq!(
            salud.subida_en_cuarentena, 0,
            "con el dato ya en la nube, el aviso no puede seguir encendido",
        );
        assert_eq!(salud.outbox_pending, 0, "y no queda nada por subir");
    }

    #[tokio::test]
    async fn subir_una_operacion_NORMAL_no_retira_ninguna_cuarentena() {
        // El borrado va guiado por el enlace, no por "se ha subido algo". Sin esa precisión, la
        // primera venta que subiera después de un rechazo borraría la prueba del rechazo.
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena) \
                     VALUES ('apartada', 'main_op', '[]', 1, 1);\
                     INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
                     VALUES ('normal', 'main_op', '[]', 2);",
                )
                .await
                .unwrap();
        }

        repo.outbox_confirmar_lote(&[("normal".to_string(), 9)]).await.unwrap();

        assert_eq!(
            repo.health().await.unwrap().subida_en_cuarentena,
            1,
            "la apartada sigue ahí: nadie ha reparado nada",
        );
    }

    #[tokio::test]
    async fn una_reparacion_del_contraste_retira_al_subir_todas_las_que_resuelve() {
        // SYNC-31: el contraste enlaza su reparación a una LISTA de apartadas (el cobro y la
        // reparación inmediata que tampoco entró). Mientras no sube, la purga no se las lleva.
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena) VALUES
                       ('cobro', 'main_op', '[]', 1, 1), ('otra', 'main_op', '[]', 1, 1);
                     INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena, Repara_Op_Id) VALUES
                       ('inmediata', 'main_reparacion', '[]', 2, 1, 'cobro');
                     INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Repara_Op_Id) VALUES
                       ('contraste', 'main_reparacion', '[]', 3, '[\"cobro\",\"inmediata\"]');",
                )
                .await
                .unwrap();
        }

        assert_eq!(repo.purgar_cuarentenas(i64::MAX).await.unwrap(), 1, "sólo la que nadie va a reparar");
        assert_eq!(repo.health().await.unwrap().subida_en_cuarentena, 2);

        repo.outbox_confirmar_lote(&[("contraste".to_string(), 11)]).await.unwrap();
        let salud = repo.health().await.unwrap();
        assert_eq!((salud.subida_en_cuarentena, salud.outbox_pending), (0, 0));
    }

    #[tokio::test]
    async fn un_plan_de_varias_operaciones_retira_lo_que_resuelve_con_la_ultima_y_no_si_una_se_aparta() {
        // SYNC-31 (Codex): todas las del plan llevan la lista. Con la primera subida no basta, y si
        // una se queda apartada lo suyo no está arriba: la apartada que resolvía sigue.
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena) VALUES
                       ('cobro', 'main_op', '[]', 1, 1), ('otro', 'main_op', '[]', 1, 1);
                     INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Repara_Op_Id) VALUES
                       ('plan-1', 'main_reparacion', '[]', 2, '[\"cobro\"]'), ('plan-2', 'main_reparacion', '[]', 2, '[\"cobro\"]'),
                       ('otro-1', 'main_reparacion', '[]', 3, '[\"otro\"]'), ('otro-2', 'main_reparacion', '[]', 3, '[\"otro\"]');",
                )
                .await
                .unwrap();
        }
        let apartadas = |db: Arc<Db>| async move {
            let r = db.read().await;
            let mut f = r.conn().query("SELECT group_concat(Op_Id, ',') FROM (SELECT Op_Id FROM _Sync_Outbox WHERE Cuarentena = 1 ORDER BY Op_Id);", ()).await.unwrap();
            match f.next().await.unwrap().unwrap().get_value(0).unwrap() {
                Value::Text(t) => t,
                _ => String::new(),
            }
        };

        // Sube la primera del plan: la otra todavía lo repara.
        repo.outbox_confirmar_lote(&[("plan-1".to_string(), 11)]).await.unwrap();
        assert_eq!(apartadas(db.clone()).await, "cobro,otro");
        // Sube la segunda: ya está todo arriba.
        repo.outbox_confirmar_lote(&[("plan-2".to_string(), 12)]).await.unwrap();
        assert_eq!(apartadas(db.clone()).await, "otro");

        // La primera del otro plan no entra y se aparta: con la segunda arriba, «otro» se queda.
        repo.outbox_mark_failed("otro-1", "rechazada", true).await.unwrap();
        repo.outbox_confirmar_lote(&[("otro-2".to_string(), 13)]).await.unwrap();
        assert_eq!(apartadas(db.clone()).await, "otro,otro-1");
    }

    #[tokio::test]
    async fn si_el_eco_de_la_reparacion_llega_antes_que_su_acuse_tambien_retira_lo_que_reparaba() {
        // El acuse de su lote se perdió y la reparación vuelve por el catch-up: es la prueba de que
        // está arriba, y sacarla del outbox sin retirar la apartada la dejaría para siempre.
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena) VALUES
                       ('cobro', 'main_op', '[]', 1, 1);
                     INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Repara_Op_Id) VALUES
                       ('inmediata', 'main_reparacion', '[]', 2, 'cobro');
                     INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('inmediata', 0, 1);",
                )
                .await
                .unwrap();
        }
        repo.apply_changes(vec![SyncChange { op_id: "inmediata".into(), seq: 1, statements: vec![] }]).await.unwrap();
        let salud = repo.health().await.unwrap();
        assert_eq!((salud.subida_en_cuarentena, salud.outbox_pending), (0, 0));
    }
}

#[cfg(test)]
mod tests_bajada_en_orden {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! AUD-18 — la bajada se aplica estrictamente en orden de `Seq`.
    //!
    //! Lo que se fija aquí, contra el SQLite de verdad: un cambio que falla detiene la bajada (ni lo
    //! de detrás entra ni el checkpoint pasa por encima de él), se reintenta con lo que se guardó al
    //! fallar y a los cinco intentos pasa a cuarentena; lo que ya se procesó no se aplica otra vez;
    //! el anti-eco de lo propio que va por delante sobrevive a la purga; y con cualquier fallo de
    //! bajada `verificar_nube` no toca nada arriba.

    use std::sync::Arc;

    use crate::ejecutor::Value;
    use super::*;
    use crate::db::Db;

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("bajada_en_orden");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sql: &str) {
        let w = db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    async fn numero(db: &Arc<Db>, sql: &str) -> i64 {
        let r = db.read().await;
        let mut filas = r.conn().query(sql, ()).await.unwrap();
        let fila = filas.next().await.unwrap().expect("una fila");
        v_i64(fila.get_value(0).unwrap()).unwrap_or(0)
    }

    fn cambio(op: &str, seq: i64, sql: &str) -> SyncChange {
        SyncChange {
            op_id: op.into(),
            seq,
            statements: vec![SqlStatement { sql: sql.into(), args: vec![] }],
        }
    }

    fn zona(op: &str, seq: i64, id: &str) -> SyncChange {
        cambio(op, seq, &format!("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('{id}','{id}');"))
    }

    /// Una zona en una tabla que esta versión no tiene: falla siempre.
    fn rota(op: &str, seq: i64) -> SyncChange {
        cambio(op, seq, "UPDATE Tabla_Que_No_Existe SET x = 1;")
    }

    /// Una mesa de una zona que aquí todavía no existe: falla hasta que la zona entra.
    fn mesa(op: &str, seq: i64, id: &str, zona: &str) -> SyncChange {
        cambio(
            op,
            seq,
            &format!(
                "INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, \
                 Shape, Width, Height) VALUES ('{id}', '{zona}', '{id}', 4, 0, 0, 'rect', 80, 80);"
            ),
        )
    }

    fn detenida(r: &BajadaAplicada) -> Option<(String, i64, i64)> {
        r.detenida.as_ref().map(|d| (d.op_id.clone(), d.seq, d.intentos))
    }

    #[tokio::test]
    async fn un_cambio_que_falla_detiene_la_tanda_y_no_se_aplica_nada_posterior() {
        let (repo, db, _dir) = repo_temporal().await;

        let r = repo
            .apply_changes(vec![zona("op-1", 1, "z1"), rota("op-2", 2), zona("op-3", 3, "z3")])
            .await
            .unwrap();

        assert_eq!(r.aplicadas, vec!["op-1".to_string()]);
        assert_eq!(r.last_seq, 1, "el checkpoint no pasa por encima del que falla");
        assert_eq!(detenida(&r), Some(("op-2".into(), 2, 1)));
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z3';").await, 0, "ni lo de detrás");
        assert_eq!(
            numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Op_Id = 'op-2' AND Quarantined = 0;").await,
            1,
        );
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Op_Id = 'op-3';").await, 0);
        let salud = repo.health().await.unwrap();
        assert_eq!((salud.failing, salud.quarantined), (1, 0), "«Reintentándose» dice la verdad");
    }

    #[tokio::test]
    async fn con_un_cambio_detenido_lo_posterior_no_entra_ni_gasta_intentos() {
        // Lo que llega en vivo mientras la bajada está detenida no pasa por delante, aunque se le
        // pida al repositorio: la tanda se para sin anotarle nada.
        let (repo, db, _dir) = repo_temporal().await;
        repo.apply_changes(vec![zona("op-1", 1, "z1"), rota("op-2", 2)]).await.unwrap();

        let r = repo.apply_changes(vec![zona("op-3", 3, "z3")]).await.unwrap();

        assert!(r.aplicadas.is_empty());
        assert_eq!(r.last_seq, 1);
        assert_eq!(detenida(&r), Some(("op-2".into(), 2, 1)), "el detenido sigue con su intento");
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z3';").await, 0);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed;").await, 1, "op-3 no se anota");
    }

    #[tokio::test]
    async fn el_detenido_se_reintenta_con_lo_que_se_guardo_y_al_entrar_sigue_lo_de_detras() {
        // La mesa de la zona `zx` falla por su clave foránea; mientras tanto la zona aparece (en
        // la realidad, el conflicto que la frenaba se resuelve) y al reintentarla entra. Lo de
        // detrás entra después, en orden.
        let (repo, db, _dir) = repo_temporal().await;
        repo.apply_changes(vec![zona("op-1", 1, "z1"), mesa("op-2", 2, "m1", "zx")]).await.unwrap();
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zx','X');").await;

        let detenido = repo.cambio_detenido().await.unwrap().expect("el detenido");
        assert_eq!((detenido.op_id.as_str(), detenido.seq), ("op-2", 2));
        assert_eq!(
            serde_json::to_value(&detenido.statements).unwrap(),
            serde_json::to_value(mesa("op-2", 2, "m1", "zx").statements).unwrap(),
            "lo que se guardó al fallar"
        );

        let r = repo.apply_changes(vec![detenido]).await.unwrap();
        assert_eq!((r.aplicadas.clone(), r.last_seq, r.detenida.clone()), (vec!["op-2".to_string()], 2, None));
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed;").await, 0, "entró: se olvida el fallo");
        assert!(repo.cambio_detenido().await.unwrap().is_none());

        let r = repo.apply_changes(vec![zona("op-3", 3, "z3")]).await.unwrap();
        assert_eq!((r.aplicadas, r.last_seq), (vec!["op-3".to_string()], 3));
    }

    #[tokio::test]
    async fn a_los_cinco_intentos_pasa_a_cuarentena_y_el_checkpoint_sigue_en_orden() {
        let (repo, db, _dir) = repo_temporal().await;
        repo.apply_changes(vec![zona("op-1", 1, "z1"), rota("op-2", 2), zona("op-3", 3, "z3")])
            .await
            .unwrap();
        for intento in 2..MAX_APPLY_ATTEMPTS {
            let detenido = repo.cambio_detenido().await.unwrap().unwrap();
            let r = repo.apply_changes(vec![detenido]).await.unwrap();
            assert_eq!(detenida(&r), Some(("op-2".into(), 2, intento)));
            assert_eq!(r.last_seq, 1);
        }

        let detenido = repo.cambio_detenido().await.unwrap().unwrap();
        let r = repo.apply_changes(vec![detenido, zona("op-3", 3, "z3")]).await.unwrap();

        assert_eq!(r.detenida, None);
        assert_eq!(r.aplicadas, vec!["op-3".to_string()], "lo de detrás entra, en orden");
        assert_eq!(r.last_seq, 3);
        let salud = repo.health().await.unwrap();
        assert_eq!((salud.failing, salud.quarantined), (0, 1), "se ve como cualquier cuarentena");
        assert_eq!(
            numero(&db, "SELECT Attempts FROM _Sync_Failed WHERE Op_Id = 'op-2' AND Quarantined = 1;").await,
            MAX_APPLY_ATTEMPTS,
        );
        assert!(repo.cambio_detenido().await.unwrap().is_none());
        // SYNC-36: una tabla que esta versión no tiene: no se sabe qué filas toca.
        let filas = texto(&db, "SELECT Filas_Json FROM _Sync_Failed WHERE Op_Id = 'op-2';").await;
        assert!(crate::filas_tocadas::Tocadas::de_json(&filas).incierto, "{filas}");
    }

    async fn texto(db: &Arc<Db>, sql: &str) -> String {
        let r = db.read().await;
        let mut filas = r.conn().query(sql, ()).await.unwrap();
        let fila = filas.next().await.unwrap().expect("una fila");
        match fila.get_value(0).unwrap() {
            Value::Text(t) => t,
            otro => panic!("no es un texto: {otro:?}"),
        }
    }

    #[tokio::test]
    async fn al_fallar_se_guardan_las_filas_que_toca_y_la_cuarentena_las_conserva() {
        // SYNC-36: la mesa de una zona que aquí no existe. Se mira en el primer intento, con la
        // base de justo antes del cambio, y no se vuelve a mirar.
        let (repo, db, _dir) = repo_temporal().await;
        repo.apply_changes(vec![zona("op-1", 1, "z1"), mesa("op-2", 2, "m1", "zx")]).await.unwrap();
        let primera = texto(&db, "SELECT Filas_Json FROM _Sync_Failed WHERE Op_Id = 'op-2';").await;
        let tocadas = crate::filas_tocadas::Tocadas::de_json(&primera);
        assert!(!tocadas.incierto, "{primera}");
        assert_eq!(tocadas.tablas, vec!["Mesas".to_string()]);
        assert_eq!(
            tocadas.filas,
            vec![crate::filas_tocadas::FilaTocada { tabla: "Mesas".into(), clave: vec![serde_json::json!("m1")], borrada: false }]
        );
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Mesas;").await, 0, "el simulacro no deja nada");

        for _ in 1..MAX_APPLY_ATTEMPTS {
            let detenido = repo.cambio_detenido().await.unwrap().unwrap();
            repo.apply_changes(vec![detenido]).await.unwrap();
        }
        assert_eq!(numero(&db, "SELECT Quarantined FROM _Sync_Failed WHERE Op_Id = 'op-2';").await, 1);
        assert_eq!(texto(&db, "SELECT Filas_Json FROM _Sync_Failed WHERE Op_Id = 'op-2';").await, primera);
    }

    #[tokio::test]
    async fn la_cuarentena_es_atomica_o_todo_o_nada() {
        // Codex (tercera revisión, 4): el marcador de `_Sync_Applied_Ops`, la marca en
        // `_Sync_Failed` y el checkpoint iban en tres commits sueltos, y una copia podía fotografiar
        // el marcador solo. Si el último paso no puede escribirse, no queda ninguno de los tres.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
               First_Failed_At_Ms, Last_Failed_At_Ms) VALUES ('op-rota', 1, '[]', 4, 0, 1, 1);
             CREATE TRIGGER checkpoint_bloqueado BEFORE UPDATE ON _Sync_State
             BEGIN SELECT RAISE(ABORT, 'checkpoint bloqueado'); END;",
        )
        .await;

        assert!(repo.apply_changes(vec![rota("op-rota", 1)]).await.is_err());

        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Applied_Ops WHERE Op_Id = 'op-rota';").await, 0);
        assert_eq!(
            numero(&db, "SELECT Attempts * 10 + Quarantined FROM _Sync_Failed WHERE Op_Id = 'op-rota';").await,
            40,
            "ni el intento ni la cuarentena"
        );
        assert_eq!(numero(&db, "SELECT Last_Seq FROM _Sync_State WHERE Id = 1;").await, 0);

        // Sin el bloqueo, el quinto intento la pone en cuarentena con las tres cosas a la vez.
        sembrar(&db, "DROP TRIGGER checkpoint_bloqueado;").await;
        let r = repo.apply_changes(vec![rota("op-rota", 1)]).await.unwrap();
        assert_eq!(r.last_seq, 1);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Applied_Ops WHERE Op_Id = 'op-rota';").await, 1);
        assert_eq!(
            numero(&db, "SELECT Attempts * 10 + Quarantined FROM _Sync_Failed WHERE Op_Id = 'op-rota';").await,
            51
        );
    }

    #[tokio::test]
    async fn la_cuarentena_guarda_lo_necesario_para_diagnosticarla() {
        let (repo, db, _dir) = repo_temporal().await;
        let mut r = repo.apply_changes(vec![rota("op-2", 2)]).await.unwrap();
        while r.detenida.is_some() {
            let detenido = repo.cambio_detenido().await.unwrap().unwrap();
            r = repo.apply_changes(vec![detenido]).await.unwrap();
        }
        let r = db.read().await;
        let mut filas = r
            .conn()
            .query(
                "SELECT Seq, Statements_Json, Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms \
                 FROM _Sync_Failed WHERE Op_Id = 'op-2';",
                (),
            )
            .await
            .unwrap();
        let f = filas.next().await.unwrap().expect("la fila de la cuarentena");
        assert_eq!(v_i64(f.get_value(0).unwrap()), Some(2));
        let texto = |v: Value| match v {
            Value::Text(s) => s,
            v => panic!("{v:?}"),
        };
        let sentencias: Vec<SqlStatement> = serde_json::from_str(&texto(f.get_value(1).unwrap())).unwrap();
        assert_eq!(
            serde_json::to_value(&sentencias).unwrap(),
            serde_json::to_value(rota("op-2", 2).statements).unwrap()
        );
        assert!(texto(f.get_value(2).unwrap()).contains("no such table"));
        assert!(v_i64(f.get_value(3).unwrap()).unwrap() > 0 && v_i64(f.get_value(4).unwrap()).unwrap() > 0);
    }

    #[tokio::test]
    async fn lo_que_llega_por_debajo_del_checkpoint_no_se_aplica_aunque_se_haya_purgado_su_registro() {
        // Codex (primera revisión, 4): el DO reenvía el `Seq` 10 (SYNC-03) cuando esta Main ya va
        // por el 701 y la purga por cursor ya retiró su registro de idempotencia. Aplicarlo otra
        // vez devolvería la zona a su nombre viejo.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','Nuevo');
             UPDATE _Sync_State SET Last_Seq = 701 WHERE Id = 1;",
        )
        .await;

        let r = repo
            .apply_changes(vec![cambio("op-10", 10, "UPDATE Zonas SET Nombre_Zona = 'Viejo' WHERE ID_Zona = 'z1';")])
            .await
            .unwrap();

        assert!(r.aplicadas.is_empty());
        assert_eq!((r.last_seq, r.detenida), (701, None));
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE Nombre_Zona = 'Nuevo';").await, 1);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Applied_Ops WHERE Op_Id = 'op-10';").await, 0);
    }

    #[tokio::test]
    async fn el_eco_propio_no_lleva_el_checkpoint_por_encima_de_un_cambio_detenido() {
        // Codex (primera revisión, 2): la Main sube una operación suya (el 3) mientras la bajada
        // está detenida en el 2. Su eco no puede subir el checkpoint por encima del 2: si lo
        // hiciera, el 2 no se volvería a pedir y la Main se quedaría sin él.
        let (repo, db, _dir) = repo_temporal().await;
        repo.apply_changes(vec![zona("op-1", 1, "z1"), mesa("op-2", 2, "m1", "zx")]).await.unwrap();
        sembrar(
            &db,
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-propia','Propia');
             INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES ('op-propia', 'zona', '[]', 1);
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-propia', 0, 1);",
        )
        .await;

        let eco = zona("op-propia", 3, "z-propia");
        let r = repo.apply_changes(vec![eco.clone()]).await.unwrap();
        assert_eq!((r.last_seq, detenida(&r)), (1, Some(("op-2".into(), 2, 1))));
        // Ni siquiera se da por confirmada la subida: volverá por el catch-up, y fuera del outbox su
        // anti-eco quedaría expuesto a la purga TTL antes de que vuelva.
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Op_Id = 'op-propia';").await, 1);

        // Resuelto el 2, el eco entra como siempre: no se aplica (ya está aquí), confirma la subida
        // y mueve el checkpoint.
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zx','X');").await;
        let detenido = repo.cambio_detenido().await.unwrap().unwrap();
        repo.apply_changes(vec![detenido]).await.unwrap();
        let r = repo.apply_changes(vec![eco]).await.unwrap();
        assert!(r.aplicadas.is_empty(), "el eco no se aplica: {:?}", r.aplicadas);
        assert_eq!((r.last_seq, r.detenida), (3, None));
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z-propia';").await, 1);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Op_Id = 'op-propia';").await, 0);
    }

    #[tokio::test]
    async fn la_purga_no_retira_el_anti_eco_de_lo_propio_que_va_por_delante() {
        // Lo que esta Main subió mientras la bajada estaba detenida vuelve por el catch-up cuando
        // se resuelve. Si la purga TTL retirara antes su anti-eco, se aplicaría otra vez.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "UPDATE _Sync_State SET Last_Seq = 10 WHERE Id = 1;
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES
               ('propia-delante', 50, 1), ('propia-detras', 5, 1), ('propia-sin-seq', 0, 1),
               ('reciente-delante', 60, 9999999999999);",
        )
        .await;

        repo.purge_applied_ops().await.unwrap();

        let r = db.read().await;
        let mut filas = r
            .conn()
            .query("SELECT Op_Id FROM _Sync_Applied_Ops ORDER BY Op_Id;", ())
            .await
            .unwrap();
        let mut quedan = Vec::new();
        while let Some(f) = filas.next().await.unwrap() {
            if let Value::Text(s) = f.get_value(0).unwrap() {
                quedan.push(s);
            }
        }
        assert_eq!(quedan, vec!["propia-delante".to_string(), "reciente-delante".to_string()]);
    }

    /// Lo que el checkpoint ha dejado atrás sin resolver ni en cuarentena: nada lo volvería a
    /// intentar, y bloquearía `verificar_nube` para siempre.
    async fn fallos_atras_sin_resolver(db: &Arc<Db>) -> i64 {
        numero(
            db,
            "SELECT COUNT(*) FROM _Sync_Failed \
              WHERE Quarantined = 0 AND Seq <= (SELECT Last_Seq FROM _Sync_State WHERE Id = 1);",
        )
        .await
    }

    async fn checkpoint_de(db: &Arc<Db>) -> i64 {
        numero(db, "SELECT Last_Seq FROM _Sync_State WHERE Id = 1;").await
    }

    const CHECKPOINT_BLOQUEADO: &str = "CREATE TRIGGER checkpoint_bloqueado BEFORE UPDATE ON _Sync_State
         BEGIN SELECT RAISE(ABORT, 'checkpoint bloqueado'); END;";

    #[tokio::test]
    async fn el_reintento_de_un_eco_propio_resuelve_su_fallo() {
        // Codex (tercera revisión bis, 3): el eco de una escritura propia no pudo mover el
        // checkpoint, y el reintento salía por el anti-eco sin borrar el fallo. Quedaba por debajo
        // del checkpoint, sin que nada lo reintentara, y bloqueando verificar_nube para siempre.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "UPDATE _Sync_State SET Last_Seq = 10 WHERE Id = 1;
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-propia', 12, 1);",
        )
        .await;
        sembrar(&db, CHECKPOINT_BLOQUEADO).await;

        let r = repo.apply_changes(vec![zona("op-propia", 12, "z-propia")]).await.unwrap();
        assert_eq!(detenida(&r), Some(("op-propia".into(), 12, 1)));

        sembrar(&db, "DROP TRIGGER checkpoint_bloqueado;").await;
        let detenido = repo.cambio_detenido().await.unwrap().expect("el eco se reintenta");
        let r = repo.apply_changes(vec![detenido]).await.unwrap();

        assert_eq!((r.last_seq, r.detenida.is_none()), (12, true));
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed;").await, 0, "el fallo se resuelve");
        assert_eq!(
            numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona = 'z-propia';").await,
            0,
            "lo propio no se aplica otra vez"
        );
        // Y verificar_nube vuelve a poder tocar arriba: su guarda mira que no quede ningún fallo.
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed;").await, 0);
    }

    #[tokio::test]
    async fn ningun_camino_deja_atras_un_fallo_sin_resolver_ni_en_cuarentena() {
        // AUD-18: cada forma que tiene el checkpoint de pasar por encima de un fallo lo resuelve o lo
        // deja en cuarentena: entrar al reintentarlo, salir por el anti-eco y la cuarentena.
        let (repo, db, _dir) = repo_temporal().await;

        // 1) Falla (la mesa antes que su zona) y entra al reintentarlo.
        let r = repo.apply_changes(vec![mesa("op-mesa", 1, "m-1", "z-a")]).await.unwrap();
        assert!(r.detenida.is_some());
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-a', 'A');").await;
        let d = repo.cambio_detenido().await.unwrap().unwrap();
        repo.apply_changes(vec![d]).await.unwrap();
        assert_eq!((checkpoint_de(&db).await, fallos_atras_sin_resolver(&db).await), (1, 0));

        // 2) El eco de lo propio que no pudo mover el checkpoint sale por el anti-eco al reintentarlo.
        sembrar(
            &db,
            "INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-propia', 2, 1);",
        )
        .await;
        sembrar(&db, CHECKPOINT_BLOQUEADO).await;
        let r = repo.apply_changes(vec![zona("op-propia", 2, "z-propia")]).await.unwrap();
        assert!(r.detenida.is_some());
        sembrar(&db, "DROP TRIGGER checkpoint_bloqueado;").await;
        let d = repo.cambio_detenido().await.unwrap().unwrap();
        repo.apply_changes(vec![d]).await.unwrap();
        assert_eq!((checkpoint_de(&db).await, fallos_atras_sin_resolver(&db).await), (2, 0));

        // 3) No entra nunca: cuarentena, con el checkpoint en la misma transacción.
        for _ in 0..MAX_APPLY_ATTEMPTS {
            repo.apply_changes(vec![rota("op-rota", 3)]).await.unwrap();
        }
        assert_eq!((checkpoint_de(&db).await, fallos_atras_sin_resolver(&db).await), (3, 0));
        assert_eq!(numero(&db, "SELECT Quarantined FROM _Sync_Failed WHERE Op_Id = 'op-rota';").await, 1);
    }

    #[tokio::test]
    async fn el_anti_eco_de_un_eco_propio_que_falla_no_lo_retira_la_purga() {
        // Codex (tercera revisión ter, 1): una operación subida cuyo acuse se perdió tiene su
        // anti-eco con `Seq = 0`. Si su eco no podía mover el checkpoint, `anotar_fallo` lo sacaba
        // del outbox y la purga TTL retiraba el anti-eco durante la espera: el reintento descontaba
        // el stock otra vez (9 → 8).
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('c-1', 'Bebidas');
             INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Stock_Suelto)
             VALUES ('p-1', 'c-1', 'Agua', 9);
             UPDATE _Sync_State SET Last_Seq = 10 WHERE Id = 1;
             INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms)
             VALUES ('op-venta', 'venta', '[]', 1);
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-venta', 0, 1);",
        )
        .await;
        sembrar(&db, CHECKPOINT_BLOQUEADO).await;
        let eco = cambio(
            "op-venta",
            12,
            "UPDATE Productos SET Stock_Suelto = Stock_Suelto - 1 WHERE ID_Producto = 'p-1';",
        );

        let r = repo.apply_changes(vec![eco]).await.unwrap();
        assert_eq!(detenida(&r), Some(("op-venta".into(), 12, 1)));
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Op_Id = 'op-venta';").await, 0);
        assert_eq!(
            numero(&db, "SELECT Seq FROM _Sync_Applied_Ops WHERE Op_Id = 'op-venta';").await,
            12,
            "el anti-eco lleva ya el Seq de su eco"
        );

        // Mientras se espera al reintento corre la purga, y el anti-eco se queda.
        sembrar(&db, "DROP TRIGGER checkpoint_bloqueado;").await;
        repo.purge_applied_ops().await.unwrap();
        let detenido = repo.cambio_detenido().await.unwrap().unwrap();
        let r = repo.apply_changes(vec![detenido]).await.unwrap();

        assert_eq!((r.last_seq, r.detenida.is_none()), (12, true));
        assert_eq!(
            numero(&db, "SELECT CAST(Stock_Suelto AS INTEGER) FROM Productos WHERE ID_Producto = 'p-1';").await,
            9,
            "no se descuenta dos veces"
        );
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed;").await, 0);
    }

    #[tokio::test]
    async fn un_fallo_de_algo_ya_procesado_no_se_anota() {
        // Codex (tercera revisión ter, 2): con el checkpoint en 20, un error puntual al descartar un
        // duplicado del 12 dejaba anotado un fallo 12 sin cuarentena, por debajo del checkpoint: nada
        // lo reintentaba y bloqueaba `verificar_nube`. Cuando `apply_one` falla, `apply_changes`
        // llama a `anotar_fallo`; aquí se le llama igual, con el error que fuera.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "UPDATE _Sync_State SET Last_Seq = 20 WHERE Id = 1;").await;
        let duplicado = zona("op-12", 12, "z-12");
        {
            let w = db.write().await;
            let fallo = anotar_fallo(w.raw(), &duplicado, "error puntual leyendo el checkpoint", None)
                .await
                .unwrap();
            assert!(matches!(fallo, Fallo::YaProcesado));
        }
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed;").await, 0);

        // Recibido otra vez, sale por `YaProcesada` sin anotar nada, y `verificar_nube` puede actuar.
        let r = repo.apply_changes(vec![duplicado]).await.unwrap();
        assert_eq!((r.last_seq, r.detenida.is_none()), (20, true));
        assert_eq!(fallos_atras_sin_resolver(&db).await, 0);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed;").await, 0);
    }

    #[tokio::test]
    async fn un_duplicado_resuelve_el_fallo_que_tuviera_por_debajo_del_checkpoint() {
        // Lo que dejara anotado una versión anterior por debajo del checkpoint se resuelve al llegar
        // su duplicado: con la operación procesada, se borra; sin ella (un fallo de antes de AUD-18,
        // que el checkpoint se saltó sin aplicarlo), pasa a cuarentena, que es lo que es.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "UPDATE _Sync_State SET Last_Seq = 20 WHERE Id = 1;
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('op-12', 12, 1);
             INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
               First_Failed_At_Ms, Last_Failed_At_Ms)
             VALUES ('op-12', 12, '[]', 1, 0, 1, 1), ('op-11', 11, '[]', 1, 0, 1, 1);",
        )
        .await;
        assert_eq!(fallos_atras_sin_resolver(&db).await, 2);

        repo.apply_changes(vec![zona("op-11", 11, "z-11"), zona("op-12", 12, "z-12")])
            .await
            .unwrap();

        assert_eq!(fallos_atras_sin_resolver(&db).await, 0);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM _Sync_Failed WHERE Op_Id = 'op-12';").await, 0);
        assert_eq!(numero(&db, "SELECT Quarantined FROM _Sync_Failed WHERE Op_Id = 'op-11';").await, 1);
        assert_eq!(numero(&db, "SELECT COUNT(*) FROM Zonas WHERE ID_Zona IN ('z-11', 'z-12');").await, 0);
    }

    #[test]
    fn el_checkpoint_solo_se_mueve_resolviendo_el_fallo() {
        // AUD-18 (tercera revisión bis, 3): lo que mueve `Last_Seq` tiene que resolver a la vez el
        // fallo que deja atrás. Fuera de los tests sólo lo hacen `pasar_el_checkpoint` (que borra el
        // de esa operación si no está en cuarentena) y `bootstrap_restaurar` (que vacía
        // `_Sync_Failed` en la misma transacción). Un sitio nuevo tiene que pasar por la primera.
        let fuente = include_str!("sync.rs").replace("\r\n", "\n");
        // Sin los tests: cada bloque `#[cfg(test)]` acaba en la primera llave de columna 0.
        let mut codigo = String::new();
        let mut resto = fuente.as_str();
        while let Some(i) = resto.find("\n#[cfg(test)]\n") {
            codigo.push_str(&resto[..i]);
            let tras = &resto[i + 1..];
            let fin = tras.find("\n}\n").expect("el bloque de tests se cierra");
            resto = &tras[fin + 2..];
        }
        codigo.push_str(resto);

        let mut donde: Vec<String> = codigo
            .match_indices("SET Last_Seq")
            .map(|(i, _)| {
                let antes = &codigo[..i];
                let f = antes.rfind("fn ").expect("dentro de una función");
                antes[f + 3..].chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect()
            })
            .collect();
        donde.sort();
        donde.dedup();
        assert_eq!(donde, ["bootstrap_restaurar", "pasar_el_checkpoint"]);

        let cuerpo = &codigo[codigo.find("fn bootstrap_restaurar").unwrap()..];
        let fin = cuerpo[1..].find("\n    async fn ").map_or(cuerpo.len(), |i| i + 1);
        assert!(cuerpo[..fin].contains("DELETE FROM _Sync_Failed;"));
    }
}

#[cfg(test)]
mod tests_purga_de_cuarentenas {
    //! Lo apartado de la subida no se guarda para siempre: se retira pasada la retención
    //! (`use_cases::sync::RETENCION_CUARENTENAS_MS`), salvo lo que todavía espera a su reparación.
    //! Lo que no entró de la bajada, sí: es la barrera del contraste (`contraste.rs::Guarda::sin_fallos`).

    use std::sync::Arc;

    use super::*;
    use crate::db::Db;

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("purga_cuarentenas");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    async fn ids(db: &Arc<Db>, sql: &str) -> Vec<String> {
        let r = db.read().await;
        let mut filas = r.conn().query(sql, ()).await.unwrap();
        let mut out = Vec::new();
        while let Some(f) = filas.next().await.unwrap() {
            if let Value::Text(s) = f.get_value(0).unwrap() {
                out.push(s);
            }
        }
        out
    }

    #[tokio::test]
    async fn retira_las_cuarentenas_viejas_y_deja_las_recientes_las_vivas_y_las_que_esperan_su_reparacion() {
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    // Subida: (Op_Id, Cuarentena, Ultimo_Intento_Ms, Repara_Op_Id). El corte es 1000.
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena, Ultimo_Intento_Ms, Repara_Op_Id) VALUES
                       ('apartada-vieja',      'main_op',    '[]', 10,   1, 500,  NULL),
                       ('apartada-sin-intento','main_op',    '[]', 20,   1, NULL, NULL),
                       ('apartada-reciente',   'main_op',    '[]', 30,   1, 5000, NULL),
                       ('pendiente-vieja',     'main_op',    '[]', 40,   0, 500,  NULL),
                       ('espera-reparacion',   'main_op',    '[]', 50,   1, 500,  NULL),
                       ('su-reparacion',       'reparacion', '[]', 60,   0, NULL, 'espera-reparacion'),
                       ('reparacion-apartada', 'reparacion', '[]', 70,   1, 600,  'apartada-vieja');
                     INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms) VALUES
                       ('bajada-vieja',    1, '[]', 5, 1, 'x', 100, 500),
                       ('bajada-reciente', 2, '[]', 5, 1, 'x', 100, 5000),
                       ('bajada-viva',     3, '[]', 2, 0, 'x', 100, 500);",
                )
                .await
                .unwrap();
        }

        assert_eq!(repo.purgar_cuarentenas(1000).await.unwrap(), 3);

        assert_eq!(
            ids(&db, "SELECT Op_Id FROM _Sync_Outbox ORDER BY Seq;").await,
            ["apartada-reciente", "pendiente-vieja", "espera-reparacion", "su-reparacion"],
            "lo pendiente no se toca nunca, y una apartada se queda mientras su reparación no suba",
        );
        assert_eq!(
            ids(&db, "SELECT Op_Id FROM _Sync_Failed ORDER BY Seq;").await,
            ["bajada-vieja", "bajada-reciente", "bajada-viva"],
            "lo de la bajada no caduca: es lo que le impide al contraste dar esta base por al día",
        );
        // El panel de Conectividad cuenta lo que queda.
        let salud = repo.health().await.unwrap();
        assert_eq!((salud.subida_en_cuarentena, salud.quarantined), (2, 2));

        // Repetirla no retira nada más.
        assert_eq!(repo.purgar_cuarentenas(1000).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn la_retencion_la_pone_el_caso_de_uso() {
        let (repo, db, _dir) = repo_temporal().await;
        let ahora = now_ms();
        let dia = 24 * 60 * 60 * 1000;
        {
            let w = db.write().await;
            for (op, hace_dias) in [("hace-31-dias", 31), ("hace-29-dias", 29)] {
                w.raw()
                    .execute(
                        "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena, Ultimo_Intento_Ms) \
                         VALUES (?1, 'main_op', '[]', ?2, 1, ?2);",
                        vec![Value::Text(op.into()), Value::Integer(ahora - hace_dias * dia)],
                    )
                    .await
                    .unwrap();
            }
        }
        let purgadas = tpv_application::use_cases::sync::purgar_cuarentenas(&repo, ahora).await.unwrap();
        assert_eq!(purgadas, 1);
        assert_eq!(ids(&db, "SELECT Op_Id FROM _Sync_Outbox;").await, ["hace-29-dias"]);
    }
}
