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

use std::sync::Arc;

use async_trait::async_trait;
use libsql::{Connection, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::sync::SyncRepository;
use tpv_contracts::sync::{
    AplicacionSync, BackfillEstado, BootstrapResultado, BootstrapSnapshot, HistoricoPagina,
    DescuadreTabla, OutboxEntry, OutboxFallo, ResultadoVerificacion, SqlStatement,
    SyncChange, SyncHealth, TablaAExaminar, VerificacionClaves, VerificacionNube,
};

use crate::db::Db;
use crate::mapping::v_i64;

pub struct SqliteSyncRepository {
    db: Arc<Db>,
}

impl SqliteSyncRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(i64::MAX)
}

/// Margen (en nº de operaciones) que la purga por cursor deja SIN borrar por debajo del checkpoint.
/// Cubre el solape catch-up/live al reconectar: una op con `Seq` ya superado por `Last_Seq` solo
/// puede re-llegar dentro de esa ventana de reconexión, mucho más estrecha que este margen.
const PURGE_CURSOR_MARGIN: i64 = 500;

/// Antigüedad mínima (ms) para que la purga TTL retire un registro ya confirmado en la nube.
const PURGE_TTL_MS: i64 = 72 * 60 * 60 * 1000;

/// Reintentos de una op nube→Main antes de ponerla en CUARENTENA (SYNC-01). Cada intento ocurre
/// en un ciclo de catch-up distinto (el pipeline para y reintenta), así que cubre fallos
/// transitorios sin descartar datos a la primera. Agotados, la op se salta para no bloquear el
/// resto de la sincronización indefinidamente.
const MAX_APPLY_ATTEMPTS: i64 = 5;

/// Reintentos de una op Main→nube antes de APARTARLA (SYNC-20). Es el espejo de
/// `MAX_APPLY_ATTEMPTS` para la dirección contraria, y existe por el mismo motivo: el outbox es
/// una cola **ordenada**, así que una operación que la nube rechaza siempre no se quedaba
/// reintentando sola — dejaba detenido todo lo que viniera detrás, que es un día de ventas.
///
/// Es más generoso que el de bajada a propósito. Un fallo de subida se reintenta en cada pasada
/// del drenado, que puede dispararse varias veces por minuto (el evento `outbox:pending`), no una
/// vez por ciclo de catch-up. Con 5 se apartaría una operación por un bache de red de segundos.
const MAX_SUBIDA_ATTEMPTS: i64 = 20;

/// Convierte un escalar JSON al `Value` de libsql para enlazarlo como argumento.
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

/// Nombres de tabla realmente presentes en la BD local. El volcado de la nube se filtra contra
/// esto: una Main con una versión por detrás recibirá tablas que su esquema aún no tiene, y eso
/// tiene que informarse, no reventar la recuperación.
async fn tablas_locales(conn: &Connection) -> AppResult<std::collections::HashSet<String>> {
    let mut rows = conn
        .query("SELECT name FROM sqlite_master WHERE type = 'table';", ())
        .await
        .map_err(db_err)?;
    let mut out = std::collections::HashSet::new();
    while let Some(row) = rows.next().await.map_err(db_err)? {
        if let Ok(Value::Text(n)) = row.get_value(0) {
            out.insert(n);
        }
    }
    Ok(out)
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

/// Avanza el checkpoint hasta `seq` (solo hacia delante). Se usa al SALTAR una op ya aplicada
/// (p. ej. un eco de las propias escrituras de la Main que vuelve por el catch-up): aunque no se
/// reaplique, hay que mover el cursor para no volver a pedirla indefinidamente.
/// SYNC-18: la nube confirma (devolviéndonosla) que una operación NUESTRA está aplicada allí.
/// Se retira del outbox y de las encoladas. Si no era nuestra, no hay nada que borrar.
async fn confirmar_subida(conn: &Connection, op_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM _Sync_Outbox WHERE Op_Id = ?1;",
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    conn.execute(
        "DELETE FROM _Sync_Encoladas WHERE Op_Id = ?1;",
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

async fn advance_checkpoint(conn: &Connection, seq: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1 AND Last_Seq < ?1;",
        vec![Value::Integer(seq)],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Purga por cursor de `_Sync_Applied_Ops`: retira los registros cuyo `Seq` ya quedó superado por
/// el checkpoint con holgura (`PURGE_CURSOR_MARGIN`). Solo afecta a `Seq > 0` (remotos aplicados o
/// anti-ecos ya ascendidos a su Seq real tras el `apply_ack`); los anti-ecos sin ascender (`Seq=0`)
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

/// No reintenta la sentencia rechazada: lee cómo está **ahora** cada fila en la Main —que es el
/// escritor único, o sea la autoridad— y encola un `INSERT OR REPLACE` con su contenido actual. Eso
/// no depende del orden, se puede repetir sin daño y converge; reaplicar la sentencia vieja, en
/// cambio, devolvería la fila a un valor que ya no es cierto.
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

    let mut sentencias: Vec<SqlStatement> = Vec::new();
    for f in &analisis.filas {
        if let Ok(Some(st)) = rep::sentencia_de_reparacion(conn, f).await {
            sentencias.push(st);
        }
    }
    if sentencias.is_empty() {
        return Ok(0);
    }

    let n = sentencias.len() as i64;
    let nuevo_op = uuid::Uuid::new_v4().to_string();
    let ahora = now_ms();
    // Se anota de qué operación apartada viene: cuando esta reparación suba, aquélla deja de tener
    // sentido y se retira (ver `outbox_mark_sent`). Sin el enlace, el aviso de cuarentena no se
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

/// Registra (o incrementa) el fallo de una op en `_Sync_Failed` y devuelve el nº de intentos
/// acumulados. Sirve de contador persistente entre ciclos de catch-up para decidir la cuarentena.
async fn bump_failure(conn: &Connection, ch: &SyncChange, err: &str) -> AppResult<i64> {
    let now = now_ms();
    let stmts_json = serde_json::to_string(&ch.statements).unwrap_or_else(|_| "[]".to_string());
    let err_trunc: String = err.chars().take(500).collect();
    conn.execute(
        "INSERT INTO _Sync_Failed \
           (Op_Id, Seq, Statements_Json, Attempts, Quarantined, Last_Error, First_Failed_At_Ms, Last_Failed_At_Ms) \
         VALUES (?1, ?2, ?3, 1, 0, ?4, ?5, ?5) \
         ON CONFLICT(Op_Id) DO UPDATE SET \
           Attempts = Attempts + 1, Last_Error = ?4, Last_Failed_At_Ms = ?5;",
        vec![
            Value::Text(ch.op_id.clone()),
            Value::Integer(ch.seq),
            Value::Text(stmts_json),
            Value::Text(err_trunc),
            Value::Integer(now),
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
    advance_checkpoint(conn, ch.seq).await?;
    Ok(())
}

/// Limpia el registro de fallo de una op que acabó aplicándose (fallo transitorio recuperado).
/// No toca las ya en cuarentena (que igualmente no vuelven a `apply_one`, al estar marcadas).
async fn clear_failure(conn: &Connection, op_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM _Sync_Failed WHERE Op_Id = ?1 AND Quarantined = 0;",
        vec![Value::Text(op_id.to_string())],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Aplica una operación de forma atómica: sus sentencias + el registro de idempotencia + el
/// avance del checkpoint, todo dentro de una transacción. `defer_foreign_keys` evita fallos por
/// orden dentro de la propia operación. Corre sobre la conexión CRUDA de escritura (sin captura).
async fn apply_one(conn: &Connection, ch: &SyncChange) -> AppResult<()> {
    conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;")
        .await
        .map_err(db_err)?;

    let res: AppResult<()> = async {
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

        conn.execute(
            "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1 AND Last_Seq < ?1;",
            vec![Value::Integer(ch.seq)],
        )
        .await
        .map_err(db_err)?;

        Ok(())
    }
    .await;

    match res {
        Ok(()) => match conn.execute_batch("COMMIT;").await {
            Ok(_) => Ok(()),
            Err(e) => {
                // Con `defer_foreign_keys`, las violaciones de FK saltan AQUÍ (en el COMMIT), no
                // en la sentencia. Volcamos el op_id + sus sentencias para identificar qué fila
                // hija quedó sin padre en la BD local.
                let _ = conn.execute_batch("ROLLBACK;").await;
                let sqls: Vec<String> = ch
                    .statements
                    .iter()
                    .map(|s| s.sql.split_whitespace().collect::<Vec<_>>().join(" "))
                    .collect();
                Err(AppError::repository(format!(
                    "COMMIT op {} (seq {}) falló: {e} :: sentencias={sqls:?}",
                    ch.op_id, ch.seq
                )))
            }
        },
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;").await;
            Err(e)
        }
    }
}

#[async_trait]
impl SyncRepository for SqliteSyncRepository {
    async fn apply_changes(&self, changes: Vec<SyncChange>) -> AppResult<AplicacionSync> {
        // Se anota lo que se aplica DE VERDAD. Lo que el gate de idempotencia salta (un
        // re-broadcast, el eco de nuestras propias escrituras al volver por el catch-up, una op en
        // cuarentena) no cambió nada en esta BD, así que el frontend no tiene por qué reaccionar.
        let mut aplicadas: Vec<String> = Vec::new();
        // Acceso EXCLUSIVO de escritura durante todo el lote: serializa con las transacciones de
        // los repos (un único escritor). Conexión CRUDA → no se re-captura en el outbox.
        let w = self.db.write().await;
        let conn: &Connection = w.raw();

        for ch in &changes {
            // SYNC-18: que un cambio VUELVA de la nube es la prueba de que allí se aplicó. Si era
            // una de las nuestras (encolada o simplemente sin ack), esta es su confirmación: se
            // retira del outbox y deja de estar pendiente. Cubre de una vez el camino de la cola y
            // cualquier `apply_ack` que se perdiera por el camino.
            confirmar_subida(conn, &ch.op_id).await?;

            // Idempotencia: una op ya aplicada (re-broadcast, solape con el catch-up, eco de las
            // propias escrituras de la Main o una op en cuarentena) se ignora, pero igualmente
            // avanza el checkpoint.
            if op_already_applied(conn, &ch.op_id).await? {
                advance_checkpoint(conn, ch.seq).await?;
                continue;
            }
            match apply_one(conn, ch).await {
                Ok(()) => {
                    // Éxito (posible recuperación de un fallo transitorio previo): limpia su marca.
                    clear_failure(conn, &ch.op_id).await?;
                    aplicadas.push(ch.op_id.clone());
                }
                Err(e) => {
                    // SYNC-01: política de poison-message. Contamos el intento; agotados los
                    // reintentos, ponemos la op en cuarentena (se salta + avanza checkpoint +
                    // alerta) para NO bloquear el resto de la cola indefinidamente.
                    let attempts = bump_failure(conn, ch, &e.to_string()).await?;
                    if attempts >= MAX_APPLY_ATTEMPTS {
                        quarantine(conn, ch).await?;
                        tracing::error!(
                            target: "tpv::sync",
                            op_id = %ch.op_id,
                            seq = ch.seq,
                            attempts,
                            error = %e,
                            "op de sync en CUARENTENA tras agotar reintentos: se salta para no bloquear el pipeline"
                        );
                        // Cuarentenada: seguimos con el resto del lote.
                    } else {
                        // Aún dentro del margen: paramos el lote SIN avanzar el checkpoint, para
                        // reintentar esta op (y las siguientes) en el próximo ciclo de catch-up.
                        tracing::warn!(
                            target: "tpv::sync",
                            op_id = %ch.op_id,
                            seq = ch.seq,
                            attempts,
                            error = %e,
                            "fallo aplicando op de sync; se reintentará en el próximo ciclo"
                        );
                        break;
                    }
                }
            }
        }

        // Cada vez que el checkpoint avanza (por catch-up o por cambios en vivo) intentamos retirar
        // los registros de idempotencia ya superados. Coste despreciable (DELETE indexado) y solo
        // borra filas seguras.
        let last_seq = checkpoint(conn).await?;
        purge_by_cursor(conn, last_seq).await?;
        Ok(AplicacionSync {
            aplicadas,
            last_seq,
        })
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

        // SYNC-18: se excluyen las que la nube ya aceptó en su cola. Siguen en el outbox (su prueba
        // de aplicación es volver por el catch-up), pero reenviarlas mientras tanto sería repetir
        // trabajo en cada ciclo de drenado.
        //
        // SYNC-20: y se excluyen las APARTADAS. Una operación que la nube rechaza de forma
        // permanente no vuelve a ofrecerse: si volviera, el drenado la reintentaría, fallaría otra
        // vez y pararía ahí — que es exactamente el atasco que la cuarentena existe para romper.
        // Su fila NO se borra (es lo único que queda de un dato que la nube no tiene), sólo deja
        // de bloquear a las de detrás.
        let mut rows = conn
            .query(
                "SELECT Seq, Op_Id, Command_Name, Statements_Json \
                 FROM _Sync_Outbox \
                 WHERE Cuarentena = 0 \
                   AND Op_Id NOT IN (SELECT Op_Id FROM _Sync_Encoladas) \
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

    async fn outbox_mark_sent(&self, op_id: &str, seq: i64) -> AppResult<()> {
        // Tras el `apply_ack`: (1) ascendemos el anti-eco de `_Sync_Applied_Ops` a su `Seq` real
        // (la nube ya ordenó la op) para que la purga por cursor pueda retirarlo más tarde; y
        // (2) borramos la fila del outbox (ya subida). Ambas tablas de control van por la conexión
        // CRUDA de escritura (no deben capturarse como cambio de negocio) y quedan serializadas por
        // el escritor único; las hacemos en una transacción para que el upgrade y el borrado sean
        // atómicos (un anti-eco con Seq>0 implica invariablemente "ya no está en el outbox").
        let w = self.db.write().await;
        let conn = w.raw();

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            if seq > 0 {
                conn.execute(
                    "UPDATE _Sync_Applied_Ops SET Seq = ?1 WHERE Op_Id = ?2 AND Seq = 0;",
                    vec![Value::Integer(seq), Value::Text(op_id.to_string())],
                )
                .await
                .map_err(db_err)?;
            }
            // SYNC-26: si lo que acaba de subir es una REPARACIÓN, la operación apartada que la
            // motivó ya no dice nada — la nube tiene el dato. Se retira, y con ella su aviso.
            //
            // Va DENTRO de la misma transacción que borra la reparación, y no después: si el
            // proceso muriera entre las dos, quedaría una cuarentena eterna por un problema ya
            // resuelto, que es exactamente lo que esto arregla. Y se exige `Cuarentena = 1` para
            // no retirar por error una operación que siguiera viva.
            conn.execute(
                "DELETE FROM _Sync_Outbox \
                  WHERE Cuarentena = 1 \
                    AND Op_Id = (SELECT Repara_Op_Id FROM _Sync_Outbox WHERE Op_Id = ?1);",
                vec![Value::Text(op_id.to_string())],
            )
            .await
            .map_err(db_err)?;
            conn.execute(
                "DELETE FROM _Sync_Outbox WHERE Op_Id = ?1;",
                vec![Value::Text(op_id.to_string())],
            )
            .await
            .map_err(db_err)?;
            Ok(())
        }
        .await;

        match res {
            Ok(()) => conn.execute_batch("COMMIT;").await.map(|_| ()).map_err(db_err),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
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

        // REV-04: anotar dos veces el mismo fallo tiene que ser inocuo. El camino en vivo no repite
        // (una apartada deja de ofrecerse), pero el aviso de la nube SÍ: el DO reofrece lo que no se
        // le ha acusado en cada conexión, y un acuse que se pierda traería el mismo `Op_Id` mañana.
        // Sin esta salida, cada repetición encolaría OTRA reparación de las mismas filas.
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
            // REV-04: y deja de estar "encolada en la nube". Esa marca dice «está en camino, no la
            // reenvíes», y su única forma de levantarse es que la operación vuelva por el catch-up
            // — que es justo lo que no va a pasar con una apartada. Dejarla sería que la fila
            // arrastrara dos estados contradictorios a la vez.
            conn.execute(
                "DELETE FROM _Sync_Encoladas WHERE Op_Id = ?1;",
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
    }

    async fn contrastar_con_la_nube(
        &self,
        foto: VerificacionNube,
        reparar: bool,
    ) -> AppResult<ResultadoVerificacion> {
        // El cuerpo vive en un `impl` propio (más abajo) para no engordar el del trait: es lo más
        // largo de este fichero y no comparte nada con el resto de la interfaz.
        SqliteSyncRepository::contrastar_con_la_nube_con(self, foto, reparar).await
    }

    async fn contrastar_claves(
        &self,
        respuesta: VerificacionClaves,
        hasta_seq: i64,
        reparar: bool,
    ) -> AppResult<(Vec<DescuadreTabla>, i64, i64, bool)> {
        SqliteSyncRepository::contrastar_claves_con(self, respuesta, hasta_seq, reparar).await
    }

    async fn outbox_mark_encolada(&self, op_ids: &[String]) -> AppResult<()> {
        if op_ids.is_empty() {
            return Ok(());
        }
        // Tabla de control: conexión CRUDA (no debe capturarse como cambio de negocio).
        let w = self.db.write().await;
        let conn = w.raw();
        let ahora = now_ms();

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            for op_id in op_ids {
                conn.execute(
                    "INSERT OR REPLACE INTO _Sync_Encoladas (Op_Id, Encolada_En_Ms) VALUES (?1, ?2);",
                    vec![Value::Text(op_id.clone()), Value::Integer(ahora)],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(())
        }
        .await;

        match res {
            Ok(()) => conn.execute_batch("COMMIT;").await.map(|_| ()).map_err(db_err),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn liberar_encoladas_caducadas(&self, antiguedad_ms: i64) -> AppResult<i64> {
        let w = self.db.write().await;
        let conn = w.raw();
        let corte = now_ms() - antiguedad_ms.max(0);

        // `<=` y no `<`: con `antiguedad_ms = 0` la lectura natural es "libera todas", y con un
        // plazo real (una hora) la diferencia en el borde es irrelevante. Con `<`, una encolada en
        // el mismo milisegundo que la consulta se salvaba por un pelo.
        let n = conn
            .execute(
                "DELETE FROM _Sync_Encoladas WHERE Encolada_En_Ms <= ?1;",
                vec![Value::Integer(corte)],
            )
            .await
            .map_err(db_err)?;

        Ok(n as i64)
    }

    async fn purge_applied_ops(&self) -> AppResult<()> {
        // Red de seguridad para los anti-ecos que no se ascendieron por cursor (p. ej. `apply_ack`
        // sin `seq` por cache-hit de idempotencia): retira los registros ANTIGUOS (TTL) cuyo
        // `Op_Id` YA NO está pendiente en el outbox (es decir, ya confirmados en la nube). El
        // filtro `NOT IN (_Sync_Outbox)` es la garantía de "solo borrar lo subido": jamás retira
        // un anti-eco cuya op siga sin enviarse (lo que provocaría su re-aplicación tras catch-up).
        let cutoff = now_ms() - PURGE_TTL_MS;
        let w = self.db.write().await;
        w.raw()
            .execute(
                "DELETE FROM _Sync_Applied_Ops \
                 WHERE Applied_At_Ms < ?1 \
                   AND Op_Id NOT IN (SELECT Op_Id FROM _Sync_Outbox);",
                vec![Value::Integer(cutoff)],
            )
            .await
            .map_err(db_err)?;
        Ok(())
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
    ) -> AppResult<BootstrapResultado> {
        // Tras un traslado de licencia la base de este equipo es de antes: se guarda entera (puede
        // tener operaciones que nunca subieron) y se reemplaza por la de la nube, outbox incluido.
        // La copia va ANTES de tomar el escritor: `VACUUM INTO` usa el pool de lectura.
        let traslado = crate::recovery::hay_traslado_pendiente(self.db.carpeta());
        if traslado {
            let copia = crate::recovery::guardar_base_de_antes_del_traslado(&self.db).await?;
            tracing::info!(target: "tpv::sync", copia = %copia.display(), "base de antes del traslado guardada");
        }

        let w = self.db.write().await;
        let conn = w.raw();

        let locales = tablas_locales(conn).await?;

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
        conn.execute_batch("BEGIN; PRAGMA defer_foreign_keys = ON;")
            .await
            .map_err(db_err)?;

        let res: AppResult<i64> = async {
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
            conn.execute("DELETE FROM _Sync_Encoladas;", ())
                .await
                .map_err(db_err)?;
            if traslado {
                // Lo que quedaba por subir es de antes del traslado (ver arriba): ya está en la
                // copia, y en el outbox lo subiría el primer drenado encima de datos más nuevos.
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
                if !identificador_simple(nombre) {
                    continue;
                }
                conn.execute(
                    "INSERT OR REPLACE INTO _Backfill_Historico (Tabla, Orden) VALUES (?1, ?2);",
                    vec![Value::Text(nombre.clone()), Value::Integer(i as i64)],
                )
                .await
                .map_err(db_err)?;
            }

            Ok(filas)
        }
        .await;

        match res {
            Ok(filas) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
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
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
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
        // ninguna de las siguientes llegaría a bajarse. Misma regla que en el bootstrap.
        if !tablas_locales(conn).await?.contains(&pagina.tabla) {
            conn.execute(
                "UPDATE _Backfill_Historico \
                 SET Completada = 1, Ultimo_Error = 'esta versión no conoce la tabla', \
                     Ultimo_Intento_Ms = ?2 \
                 WHERE Tabla = ?1;",
                vec![Value::Text(pagina.tabla.clone()), Value::Integer(now_ms())],
            )
            .await
            .map_err(db_err)?;
            return Ok(0);
        }

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;

        let res: AppResult<i64> = async {
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
                    // `INSERT OR IGNORE` y no `INSERT`: la fase 2 NUNCA pisa una fila que ya esté.
                    // Lo que ya está llegó por el catch-up y por tanto es más nuevo que esta foto
                    // del histórico. Y la fase 2 re-descarga a propósito la ventana que ya trajo la
                    // fase 1: sin `IGNORE`, la primera página de cada tabla reventaría por PK.
                    let sql = format!(
                        "INSERT OR IGNORE INTO \"{}\" ({cols}) VALUES {valores};",
                        pagina.tabla
                    );
                    conn.execute(&sql, args).await.map_err(|e| {
                        AppError::repository(format!("histórico {}: {e}", pagina.tabla))
                    })?;
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
        }
        .await;

        match res {
            Ok(n) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(n)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
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
}

#[cfg(test)]
mod tests_encoladas {
    //! SYNC-18 · lado Main: el estado intermedio "la nube la tiene en su cola, pero aún no me
    //! consta aplicada".
    //!
    //! Es el estado que permite a este TPV soltar su atraso y desconectarse. Lo delicado es que no
    //! se dé una operación por buena antes de tiempo: mientras no vuelva por el catch-up, su copia
    //! local se conserva.

    use super::*;
    use crate::db::Db;
    use libsql::Connection;
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

    #[tokio::test]
    async fn una_encolada_deja_de_ofrecerse_pero_no_se_borra() {
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        encolar_en_outbox(&db, "op-2").await;

        repo.outbox_mark_encolada(&["op-1".to_string()])
            .await
            .unwrap();

        // Ya no se ofrece para reenviar...
        assert_eq!(ids_pendientes(&repo).await, vec!["op-2".to_string()]);
        // ...pero su copia sigue aquí: que la nube la tenga en la cola no prueba que la aplicara.
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT COUNT(*) FROM _Sync_Outbox WHERE Op_Id = 'op-1';",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().unwrap();
        assert_eq!(v_i64(fila.get_value(0).unwrap()).unwrap_or(0), 1);
    }

    #[tokio::test]
    async fn verla_volver_de_la_nube_es_lo_que_la_da_por_subida() {
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        repo.outbox_mark_encolada(&["op-1".to_string()])
            .await
            .unwrap();

        // El catch-up la devuelve: prueba de que allí está aplicada.
        repo.apply_changes(vec![SyncChange {
            op_id: "op-1".to_string(),
            seq: 7,
            statements: Vec::<SqlStatement>::new(),
        }])
        .await
        .unwrap();

        assert!(ids_pendientes(&repo).await.is_empty());
        let r = db.read().await;
        let mut rows = r
            .conn()
            .query(
                "SELECT (SELECT COUNT(*) FROM _Sync_Outbox) + (SELECT COUNT(*) FROM _Sync_Encoladas);",
                Vec::<Value>::new(),
            )
            .await
            .unwrap();
        let fila = rows.next().await.unwrap().unwrap();
        assert_eq!(v_i64(fila.get_value(0).unwrap()).unwrap_or(-1), 0);
    }

    #[tokio::test]
    async fn una_encolada_que_nunca_se_confirma_vuelve_a_ofrecerse() {
        // La red que impide el limbo: si la nube nunca la devuelve (se perdió el ack, o acabó
        // apartada allí), se reenvía. Reenviar es inocuo: la nube es idempotente por `Op_Id`.
        let (repo, db, _dir) = repo_temporal().await;
        encolar_en_outbox(&db, "op-1").await;
        repo.outbox_mark_encolada(&["op-1".to_string()])
            .await
            .unwrap();
        assert!(ids_pendientes(&repo).await.is_empty());

        // Todavía es reciente: no se toca.
        assert_eq!(repo.liberar_encoladas_caducadas(60_000).await.unwrap(), 0);

        assert!(ids_pendientes(&repo).await.is_empty());

        // Con el plazo vencido, vuelve a estar disponible.
        assert_eq!(repo.liberar_encoladas_caducadas(0).await.unwrap(), 1);
        assert_eq!(ids_pendientes(&repo).await, vec!["op-1".to_string()]);
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
    use libsql::Connection;
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
            })
            .await
            .unwrap();

        assert_eq!(zonas(&db).await, vec!["Salon".to_string()]);
        assert_eq!(r.filas_restauradas, 1);
        assert_eq!(r.seq, 42);
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
        })
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
            })
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
            })
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
            })
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
            })
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
            })
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
            })
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
        })
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
        let vieja = Db::open(copia.to_str().unwrap()).await.unwrap();
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
            })
            .await;

        assert!(err.is_err());
        assert!(crate::recovery::hay_traslado_pendiente(&dir), "sin reconstruir, sigue pendiente");
        assert_eq!(zonas(&db).await, vec!["De antes".to_string()]);
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 1);
        assert!(repo.outbox_pending(10).await.unwrap().is_empty());
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
        })
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
        })
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

    /// §4.1 del plan. La fase 2 NUNCA pisa una fila que ya esté: lo que está en local llegó por el
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

    /// §4.2 del plan, y el más caro de los dos si se rompe.
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
        })
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

    use libsql::{Connection, Value};
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
    async fn apartar_suelta_la_marca_de_encolada() {
        // REV-04: la marca dice «está en la cola de la nube, no la reenvíes», y sólo se levanta
        // viendo volver la operación por el catch-up — que es justo lo que no va a pasar con una
        // apartada. Dejarla sería que la fila arrastrara dos estados que se contradicen.
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
        repo.outbox_mark_encolada(&["op-mala".to_string()])
            .await
            .unwrap();

        repo.outbox_mark_failed("op-mala", "la nube la apartó de su cola", true)
            .await
            .unwrap();

        let quedan = {
            let r = db.read().await;
            let mut rows = r
                .conn()
                .query(
                    "SELECT COUNT(*) FROM _Sync_Encoladas WHERE Op_Id = 'op-mala';",
                    (),
                )
                .await
                .unwrap();
            v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap_or(-1)
        };
        assert_eq!(quedan, 0, "una apartada ya no está en camino");
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

// ──────────────────────────────────────────────────────────────────────────────
// SYNC-24: contrastar la nube contra esta base, y reparar lo que se pueda
// ──────────────────────────────────────────────────────────────────────────────

impl SqliteSyncRepository {
    /// Compara la foto que manda el worker contra la base local y encola la reparación de lo que
    /// no cuadre.
    ///
    /// Lo que cada señal puede y no puede decir, porque confundirlo lleva a creer que se ha
    /// comprobado más de lo que se ha comprobado:
    ///
    /// - **`faltan`** sale de restar los `COUNT(*)`, así que dice CUÁNTAS filas tiene esta Main de
    ///   más, no cuáles. Saber cuáles exigiría reproducir aquí la definición de la ventana, que
    ///   vive en el worker **a propósito** (una sola fuente; ver `bootstrap.ventana.ts`). No es un
    ///   agujero: las filas que de verdad importan —las de una operación apartada— ya las repara
    ///   SYNC-22 en el momento, sin esperar a esta pasada.
    /// - **`sobran`** son filas que la nube tiene y aquí no. Es un borrado que no llegó a subir, y
    ///   **no se toca**: la ausencia de una fila no es un estado que se pueda mandar, y borrar
    ///   arriba por iniciativa propia se llevaría por delante una fila recién creada por la Handy
    ///   que esta Main todavía no ha recibido. Se cuenta y se informa (SYNC-23).
    /// - **`distintas`** son las que están en los dos sitios con contenido distinto. Éstas sí se
    ///   reparan: la Main es el escritor único, así que su versión es la buena.
    pub async fn contrastar_con_la_nube(
        &self,
        foto: VerificacionNube,
    ) -> AppResult<ResultadoVerificacion> {
        self.contrastar_con_la_nube_con(foto, true).await
    }

    /// Igual, pero con `reparar = false` sólo compara (PROD-06, interruptor `reparacion_nube`):
    /// cuenta lo que no cuadra y no encola nada. Lo que habría reparado sale como `aplazado`,
    /// que es exactamente lo que es: se reparará en la pasada en que vuelva a estar encendido.
    pub async fn contrastar_con_la_nube_con(
        &self,
        foto: VerificacionNube,
        reparar: bool,
    ) -> AppResult<ResultadoVerificacion> {
        use crate::sync_reparacion as rep;

        let mut descuadres: Vec<DescuadreTabla> = Vec::new();
        let mut a_reparar: Vec<rep::FilaAfectada> = Vec::new();
        let mut a_examinar: Vec<TablaAExaminar> = Vec::new();

        // SYNC-26: la misma guardia que protege los borrados protege las ACTUALIZACIONES, y por el
        // mismo motivo. Si esta Main va por detrás de la foto, una fila «distinta» puede serlo
        // porque la Handy acaba de escribirla y aquí todavía no ha llegado: repararla entonces
        // pisaría lo nuevo con lo viejo. Y esto no es un caso raro — el job va por REST, así que
        // corre igual con el WebSocket caído, que es justo cuando la Main está más atrasada.
        let seguro = reparar && self.puede_borrar_arriba(foto.hasta_seq).await?;
        let mut aplazado = false;

        {
            let r = self.db.read().await;
            let conn = r.conn();

            // 1) Conteos de tabla entera.
            //
            // Un contador que no cuadra dice que algo baila, pero no QUÉ: para eso hay una segunda
            // fase que pide las claves de esa tabla (SYNC-25). Se apunta aquí y la decide el caso
            // de uso, que es quien puede hablar con la nube.
            //
            // Se apunta en las DOS direcciones (local > nube y local < nube): la primera es una
            // fila que no subió, la segunda es una que sobra arriba. Antes sólo se miraba la
            // primera, así que una fila de más en la nube —lo que hace que la Handy enseñe algo
            // que ya no existe— no se detectaba ni contando.
            for c in &foto.conteos {
                let local = match contar_tabla(conn, &c.nombre).await? {
                    Some(n) => n,
                    // La tabla no existe aquí: es otra versión del programa, no un descuadre.
                    None => continue,
                };
                if local != c.filas {
                    let claves = rep::claves_primarias(conn, &c.nombre).await.unwrap_or_default();
                    if !claves.is_empty() {
                        a_examinar.push(TablaAExaminar {
                            nombre: c.nombre.clone(),
                            claves,
                        });
                    }
                }
                if local > c.filas {
                    descuadres.push(DescuadreTabla {
                        tabla: c.nombre.clone(),
                        faltan: local - c.filas,
                        ..Default::default()
                    });
                }
            }

            // 2) Contenido de la ventana, fila a fila.
            for t in &foto.ventana {
                let claves = rep::claves_primarias(conn, &t.nombre)
                    .await
                    .unwrap_or_default();
                if claves.is_empty() {
                    continue;
                }
                let mut sobran = 0i64;
                let mut distintas = 0i64;

                for fila in &t.filas {
                    match rep::fila_difiere(conn, &t.nombre, &t.columnas, fila, &claves).await {
                        Ok(None) => sobran += 1,
                        Ok(Some(true)) => {
                            distintas += 1;
                            if seguro {
                                if let Some(f) = clave_de(&t.nombre, &t.columnas, fila, &claves) {
                                    a_reparar.push(f);
                                }
                            } else {
                                aplazado = true;
                            }
                        }
                        Ok(Some(false)) => {}
                        Err(e) => {
                            tracing::warn!("verificacion: {} no se pudo comparar: {e}", t.nombre);
                        }
                    }
                }

                if sobran > 0 || distintas > 0 {
                    match descuadres.iter_mut().find(|d| d.tabla == t.nombre) {
                        Some(d) => {
                            d.sobran = sobran;
                            d.distintas = distintas;
                        }
                        None => descuadres.push(DescuadreTabla {
                            tabla: t.nombre.clone(),
                            faltan: 0,
                            sobran,
                            distintas,
                        }),
                    }
                }
            }
        }

        // 3) Reparar. En su propio guard de escritura, ya soltado el de lectura.
        let mut reparadas = 0i64;
        if !a_reparar.is_empty() {
            let w = self.db.write().await;
            let conn = w.raw();
            let mut sentencias = Vec::new();
            for f in &a_reparar {
                if let Ok(Some(st)) = rep::sentencia_de_reparacion(conn, f).await {
                    sentencias.push(st);
                }
            }
            if !sentencias.is_empty() {
                reparadas = sentencias.len() as i64;
                let op = uuid::Uuid::new_v4().to_string();
                let ahora = now_ms();
                conn.execute(
                    "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
                     VALUES (?1, ?2, ?3, ?4);",
                    vec![
                        Value::Text(op.clone()),
                        Value::Text(rep::COMANDO_REPARACION.to_string()),
                        Value::Text(
                            serde_json::to_string(&sentencias).unwrap_or_else(|_| "[]".into()),
                        ),
                        Value::Integer(ahora),
                    ],
                )
                .await
                .map_err(db_err)?;
                conn.execute(
                    "INSERT OR IGNORE INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) \
                     VALUES (?1, 0, ?2);",
                    vec![Value::Text(op), Value::Integer(ahora)],
                )
                .await
                .map_err(db_err)?;
            }
        }

        Ok(ResultadoVerificacion {
            descuadres,
            reparadas,
            ventana_omitida: foto.ventana_omitida,
            tablas_a_examinar: a_examinar,
            borradas: 0,
            aplazado,
        })
    }
}

/// `COUNT(*)` local. `None` = la tabla no existe aquí (una versión con menos tablas), que no es un
/// descuadre sino otra versión del programa.
async fn contar_tabla(conn: &Connection, tabla: &str) -> AppResult<Option<i64>> {
    if tabla.is_empty()
        || tabla.len() > 64
        || !tabla.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Ok(None);
    }
    let mut existe = conn
        .query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1;",
            vec![Value::Text(tabla.to_string())],
        )
        .await
        .map_err(db_err)?;
    if existe.next().await.map_err(db_err)?.is_none() {
        return Ok(None);
    }
    let mut rows = conn
        .query(&format!("SELECT COUNT(*) FROM \"{tabla}\";"), ())
        .await
        .map_err(db_err)?;
    Ok(match rows.next().await.map_err(db_err)? {
        Some(r) => Some(v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0)),
        None => Some(0),
    })
}

/// Extrae la clave primaria de una fila que llega de la nube.
fn clave_de(
    tabla: &str,
    columnas: &[String],
    fila: &[serde_json::Value],
    claves: &[String],
) -> Option<crate::sync_reparacion::FilaAfectada> {
    let mut clave = Vec::new();
    for k in claves {
        let pos = columnas.iter().position(|c| c.eq_ignore_ascii_case(k))?;
        let v = match fila.get(pos)? {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => return None,
        };
        clave.push((k.clone(), v));
    }
    Some(crate::sync_reparacion::FilaAfectada {
        tabla: tabla.to_string(),
        clave,
    })
}

#[cfg(test)]
mod tests_verificacion {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! SYNC-24 — contrastar la nube contra esta base.
    //!
    //! La asimetría que esto cubre: la Handy no tiene base local y lee de la nube, así que una fila
    //! que se quedó distinta arriba no es "falta un dato en una copia" — es que el camarero y el TPV
    //! ven cosas distintas. Y hasta ahora no lo comprobaba nadie.

    use std::sync::Arc;

    use tpv_contracts::sync::{BootstrapTabla, ConteoTabla, VerificacionNube};

    use super::*;
    use crate::db::Db;

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("verificacion");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    /// Siembra datos y deja el checkpoint por delante de la foto: sin eso, la verificación se
    /// declara «no estoy al día» y no toca nada, que es lo correcto pero no es lo que estos tests
    /// quieren comprobar. El caso de ir atrasado tiene sus propios tests.
    async fn sembrar(db: &Arc<Db>, sql: &str) {
        let w = db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
        w.raw()
            .execute_batch("UPDATE _Sync_State SET Last_Seq = 1000 WHERE Id = 1;")
            .await
            .unwrap();
    }

    fn ventana_zonas(filas: Vec<Vec<serde_json::Value>>) -> BootstrapTabla {
        BootstrapTabla {
            nombre: "Zonas".into(),
            columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
            filas,
            parcial: false,
        }
    }

    #[tokio::test]
    async fn un_VALOR_distinto_se_detecta_y_se_repara() {
        // El caso que nos mordió: la fila está en los dos sitios, así que ningún contador la ve.
        // Sólo comparar el contenido la encuentra.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');").await;

        let foto = VerificacionNube {
            conteos: vec![ConteoTabla { nombre: "Zonas".into(), filas: 1 }],
            // La nube se quedó con el nombre viejo.
            ventana: vec![ventana_zonas(vec![vec![
                serde_json::json!("z1"),
                serde_json::json!("Salón"),
            ]])],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq: 1,
        };

        let r = repo.contrastar_con_la_nube(foto).await.unwrap();
        let d = r.descuadres.iter().find(|d| d.tabla == "Zonas").expect("descuadre en Zonas");
        assert_eq!(d.distintas, 1);
        assert_eq!(d.sobran, 0);
        assert_eq!(r.reparadas, 1, "la fila distinta se repara");

        // Y lo encolado lleva el valor de la MAIN, que es el escritor único.
        let pend = repo.outbox_pending(100).await.unwrap();
        let rep = pend
            .iter()
            .find(|e| e.command_name == crate::sync_reparacion::COMANDO_REPARACION)
            .expect("tiene que haberse encolado la reparación");
        let args = serde_json::to_string(&rep.statements[0].args).unwrap();
        assert!(args.contains("Terraza"), "args: {args}");
    }

    #[tokio::test]
    async fn lo_que_YA_coincide_no_genera_ruido() {
        // Si esto fallara, cada pasada encolaría reparaciones inútiles y llenaría Axiom de avisos
        // que no significan nada. Un panel que siempre grita es un panel apagado.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');").await;

        let foto = VerificacionNube {
            conteos: vec![ConteoTabla { nombre: "Zonas".into(), filas: 1 }],
            ventana: vec![ventana_zonas(vec![vec![
                serde_json::json!("z1"),
                serde_json::json!("Terraza"),
            ]])],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq: 1,
        };

        let r = repo.contrastar_con_la_nube(foto).await.unwrap();
        assert!(r.descuadres.is_empty(), "no hay nada que reportar: {:?}", r.descuadres);
        assert_eq!(r.reparadas, 0);
    }

    #[tokio::test]
    async fn un_4_y_un_4_punto_0_NO_son_un_descuadre() {
        // Dos drivers distintos escriben el mismo número de formas distintas. Sin esto, cada pasada
        // "encontraría" descuadrada toda tabla con una columna numérica — y el aviso que de verdad
        // importa se perdería entre cientos de falsos.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('c1','Bebidas');\
             INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) \
             VALUES ('p1','c1','Caña', 2.5);",
        )
        .await;

        let foto = VerificacionNube {
            conteos: vec![],
            ventana: vec![BootstrapTabla {
                nombre: "Productos".into(),
                columnas: vec!["ID_Producto".into(), "Precio_Venta".into()],
                // La nube lo devuelve como "2.50" en texto: mismo precio, otra grafía.
                filas: vec![vec![serde_json::json!("p1"), serde_json::json!("2.50")]],
                parcial: false,
            }],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq: 1,
        };

        let r = repo.contrastar_con_la_nube(foto).await.unwrap();
        assert!(r.descuadres.is_empty(), "2.5 y \"2.50\" son el mismo precio: {:?}", r.descuadres);
    }

    #[tokio::test]
    async fn una_fila_que_la_nube_tiene_y_aqui_NO_se_cuenta_pero_NO_se_borra() {
        // Es un borrado que no llegó a subir… o una fila que acaba de crear la Handy y esta Main
        // todavía no ha recibido. No se puede distinguir, así que borrarla arriba por iniciativa
        // propia se llevaría por delante una comanda recién abierta. Se cuenta y se informa.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Terraza');").await;

        let foto = VerificacionNube {
            conteos: vec![],
            ventana: vec![ventana_zonas(vec![
                vec![serde_json::json!("z1"), serde_json::json!("Terraza")],
                vec![serde_json::json!("z-fantasma"), serde_json::json!("Otra")],
            ])],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq: 1,
        };

        let r = repo.contrastar_con_la_nube(foto).await.unwrap();
        let d = r.descuadres.iter().find(|d| d.tabla == "Zonas").expect("descuadre en Zonas");
        assert_eq!(d.sobran, 1);
        assert_eq!(r.reparadas, 0, "un borrado no se puede reparar por estado");
        // Y sobre todo: no se ha encolado NADA que borre en la nube.
        let pend = repo.outbox_pending(100).await.unwrap();
        assert!(pend.is_empty(), "no puede salir ninguna operación: {pend:?}");
    }

    #[tokio::test]
    async fn una_fila_que_falta_ARRIBA_se_ve_por_los_conteos() {
        // El contador es lo único que ve una fila perdida fuera de la ventana.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A'),('z2','B');",
        )
        .await;

        let foto = VerificacionNube {
            conteos: vec![ConteoTabla { nombre: "Zonas".into(), filas: 1 }],
            ventana: vec![],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq: 1,
        };

        let r = repo.contrastar_con_la_nube(foto).await.unwrap();
        let d = r.descuadres.iter().find(|d| d.tabla == "Zonas").expect("descuadre en Zonas");
        assert_eq!(d.faltan, 1, "la Main tiene una fila que la nube no");
    }

    #[tokio::test]
    async fn una_tabla_que_esta_version_no_conoce_no_es_un_descuadre() {
        // Un TPV con una versión por detrás no puede llenar el panel de falsos positivos por una
        // tabla que su esquema todavía no tiene. Es la misma regla del bootstrap.
        let (repo, _db, _dir) = repo_temporal().await;
        let foto = VerificacionNube {
            conteos: vec![ConteoTabla { nombre: "Tabla_Del_Futuro".into(), filas: 9 }],
            ventana: vec![],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq: 1,
        };
        let r = repo.contrastar_con_la_nube(foto).await.unwrap();
        assert!(r.descuadres.is_empty());
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SYNC-25: saber CUÁLES filas bailan, y borrar arriba sólo cuando es seguro
// ──────────────────────────────────────────────────────────────────────────────

/// Forma canónica de una clave, para poder restar los dos conjuntos.
///
/// Los dos lados llegan por caminos distintos —uno de libsql local, otro de JSON— y el mismo
/// identificador puede venir como `"z1"` o, si alguna vez fuera numérico, como `1` o `1.0`. Se
/// normaliza con la MISMA función en los dos sitios, que es lo único que garantiza que dos claves
/// iguales se vean iguales.
///
/// El separador es `\u{1f}` (unit separator) y no una coma o un guion: una clave compuesta
/// (`"a"`,`"b,c"`) y (`"a,b"`,`"c"`) darían la misma cadena con cualquier separador que pueda
/// aparecer dentro de un valor, y entonces dos filas distintas se tomarían por la misma.
fn clave_canonica(valores: &[serde_json::Value]) -> Option<String> {
    let mut partes = Vec::with_capacity(valores.len());
    for v in valores {
        partes.push(match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => match n.as_i64() {
                Some(i) => i.to_string(),
                None => n.to_string(),
            },
            // Un NULL no puede ser clave primaria. Si llega, esta fila no se compara: mejor no
            // saber nada de ella que decidir un borrado sobre una clave que no identifica nada.
            _ => return None,
        });
    }
    Some(partes.join("\u{1f}"))
}

impl SqliteSyncRepository {
    /// Segunda fase del contraste (SYNC-25): con las claves de la nube delante, resta los dos
    /// conjuntos y actúa.
    ///
    /// - **En la Main y no en la nube** → falta arriba → se repara mandando su estado actual.
    /// - **En la nube y no en la Main** → sobra arriba → se borra, **pero sólo si se puede afirmar
    ///   que esta Main está al día**. Ver `puede_borrar_arriba`.
    pub async fn contrastar_claves(
        &self,
        respuesta: VerificacionClaves,
        hasta_seq: i64,
    ) -> AppResult<(Vec<DescuadreTabla>, i64, i64, bool)> {
        self.contrastar_claves_con(respuesta, hasta_seq, true).await
    }

    /// Igual, pero con `reparar = false` sólo cuenta (PROD-06): ni repara lo que falta arriba ni
    /// borra lo que sobra.
    pub async fn contrastar_claves_con(
        &self,
        respuesta: VerificacionClaves,
        hasta_seq: i64,
        reparar: bool,
    ) -> AppResult<(Vec<DescuadreTabla>, i64, i64, bool)> {
        use crate::sync_reparacion as rep;

        let seguro = reparar && self.puede_borrar_arriba(hasta_seq).await?;
        let mut descuadres: Vec<DescuadreTabla> = Vec::new();
        let mut a_reparar: Vec<rep::FilaAfectada> = Vec::new();
        let mut a_borrar: Vec<rep::FilaAfectada> = Vec::new();
        let mut aplazado = false;

        {
            let r = self.db.read().await;
            let conn = r.conn();

            for t in &respuesta.tablas {
                if t.truncada {
                    // La lista no cabía. Sin ella no se puede restar nada, y actuar sobre media
                    // sería leer "te sobran 400.000 filas" y borrarlas.
                    tracing::warn!(
                        "verificacion: {} es demasiado grande para comparar por claves",
                        t.nombre
                    );
                    continue;
                }

                // Claves de la nube.
                let mut en_la_nube: std::collections::HashSet<String> =
                    std::collections::HashSet::with_capacity(t.claves.len());
                let mut por_clave: std::collections::HashMap<String, Vec<serde_json::Value>> =
                    std::collections::HashMap::new();
                for k in &t.claves {
                    if let Some(c) = clave_canonica(k) {
                        en_la_nube.insert(c.clone());
                        por_clave.insert(c, k.clone());
                    }
                }

                // Claves locales.
                let Some(locales) = leer_claves_locales(conn, &t.nombre, &t.columnas).await? else {
                    continue;
                };

                let faltan: Vec<&String> = locales
                    .keys()
                    .filter(|c| !en_la_nube.contains(*c))
                    .collect();
                let sobran: Vec<&String> = en_la_nube
                    .iter()
                    .filter(|c| !locales.contains_key(*c))
                    .collect();

                if faltan.is_empty() && sobran.is_empty() {
                    continue;
                }

                if reparar {
                    for c in &faltan {
                        if let Some(valores) = locales.get(*c) {
                            if let Some(f) = fila_de(&t.nombre, &t.columnas, valores) {
                                a_reparar.push(f);
                            }
                        }
                    }
                } else if !faltan.is_empty() {
                    aplazado = true;
                }

                if !sobran.is_empty() {
                    if seguro {
                        for c in &sobran {
                            if let Some(valores) = por_clave.get(*c) {
                                if let Some(f) = fila_de(&t.nombre, &t.columnas, valores) {
                                    a_borrar.push(f);
                                }
                            }
                        }
                    } else {
                        aplazado = true;
                    }
                }

                descuadres.push(DescuadreTabla {
                    tabla: t.nombre.clone(),
                    faltan: faltan.len() as i64,
                    sobran: sobran.len() as i64,
                    distintas: 0,
                });
            }
        }

        let mut sentencias: Vec<SqlStatement> = Vec::new();
        if !a_reparar.is_empty() || !a_borrar.is_empty() {
            let w = self.db.write().await;
            let conn = w.raw();
            for f in &a_reparar {
                if let Ok(Some(st)) = rep::sentencia_de_reparacion(conn, f).await {
                    sentencias.push(st);
                }
            }
            for f in &a_borrar {
                if let Some(st) = rep::sentencia_de_borrado(f) {
                    sentencias.push(st);
                }
            }
            if !sentencias.is_empty() {
                encolar_op_de_reparacion(conn, &sentencias).await?;
            }
        }

        let reparadas = a_reparar.len().min(sentencias.len()) as i64;
        let borradas = sentencias.len() as i64 - reparadas;
        Ok((descuadres, reparadas, borradas, aplazado))
    }

    /// ¿Puede esta Main afirmar que una fila que la nube tiene y ella no es basura?
    ///
    /// Sólo si se cumplen las dos:
    ///
    /// 1. **Su checkpoint alcanza el final de la foto.** Todo lo que escribe la Handy pasa por el
    ///    DO y recibe un `Seq`; si el marcapáginas local llega hasta el `Seq` de la foto, esta Main
    ///    ya ha pasado por todo lo que hay en ella. Una fila que le falte no puede ser algo que
    ///    todavía esté de camino.
    /// 2. **No hay nada en la cuarentena de BAJADA.** Un cambio que esta Main no supo aplicar
    ///    avanza el checkpoint igual (SYNC-01, para no bloquear el resto), así que la Main *parece*
    ///    al día y en realidad le falta esa fila de verdad. Borrarla arriba sería cargarse el dato
    ///    bueno; lo que hay que hacer ahí es lo contrario, volver a aplicarlo abajo.
    async fn puede_borrar_arriba(&self, hasta_seq: i64) -> AppResult<bool> {
        if hasta_seq <= 0 {
            // Un worker anterior no manda el `Seq`. Sin él no hay forma de saberlo: no se borra.
            return Ok(false);
        }
        let r = self.db.read().await;
        let conn = r.conn();
        if checkpoint(conn).await? < hasta_seq {
            return Ok(false);
        }
        let mut rows = conn
            .query("SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 1;", ())
            .await
            .map_err(db_err)?;
        let cuarentena = match rows.next().await.map_err(db_err)? {
            Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
            None => 0,
        };
        Ok(cuarentena == 0)
    }
}

/// Claves de una tabla local, indexadas por su forma canónica. `None` = la tabla no existe aquí.
async fn leer_claves_locales(
    conn: &Connection,
    tabla: &str,
    columnas: &[String],
) -> AppResult<Option<std::collections::HashMap<String, Vec<serde_json::Value>>>> {
    let aceptable = |n: &str| {
        !n.is_empty()
            && n.len() <= 64
            && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !n.starts_with('_')
    };
    if !aceptable(tabla) || columnas.is_empty() || !columnas.iter().all(|c| aceptable(c)) {
        return Ok(None);
    }
    if contar_tabla(conn, tabla).await?.is_none() {
        return Ok(None);
    }

    let cols = columnas
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let mut rows = conn
        .query(&format!("SELECT {cols} FROM \"{tabla}\";"), ())
        .await
        .map_err(db_err)?;

    let mut out = std::collections::HashMap::new();
    while let Some(r) = rows.next().await.map_err(db_err)? {
        let mut valores = Vec::with_capacity(columnas.len());
        for i in 0..columnas.len() {
            valores.push(crate::sync_reparacion::valor_a_json(
                &r.get_value(i as i32).map_err(db_err)?,
            ));
        }
        if let Some(c) = clave_canonica(&valores) {
            out.insert(c, valores);
        }
    }
    Ok(Some(out))
}

/// Construye una `FilaAfectada` a partir de los valores de su clave.
fn fila_de(
    tabla: &str,
    columnas: &[String],
    valores: &[serde_json::Value],
) -> Option<crate::sync_reparacion::FilaAfectada> {
    let mut clave = Vec::new();
    for (i, c) in columnas.iter().enumerate() {
        let v = match valores.get(i)? {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => return None,
        };
        clave.push((c.clone(), v));
    }
    Some(crate::sync_reparacion::FilaAfectada {
        tabla: tabla.to_string(),
        clave,
    })
}

/// Encola una operación de reparación con las sentencias dadas. Va por `raw()`: estas sentencias se
/// fabrican PARA replicarse, no son escrituras de negocio que haya que capturar, y no se aplican en
/// local (aquí la base ya está bien; la que está mal es la copia de la nube).
async fn encolar_op_de_reparacion(conn: &Connection, sentencias: &[SqlStatement]) -> AppResult<()> {
    let op = uuid::Uuid::new_v4().to_string();
    let ahora = now_ms();
    conn.execute(
        "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms) \
         VALUES (?1, ?2, ?3, ?4);",
        vec![
            Value::Text(op.clone()),
            Value::Text(crate::sync_reparacion::COMANDO_REPARACION.to_string()),
            Value::Text(serde_json::to_string(sentencias).unwrap_or_else(|_| "[]".into())),
            Value::Integer(ahora),
        ],
    )
    .await
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES (?1, 0, ?2);",
        vec![Value::Text(op), Value::Integer(ahora)],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

#[cfg(test)]
mod tests_claves {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! SYNC-25 — saber CUÁLES filas bailan, y borrar arriba sólo cuando es seguro.
    //!
    //! Aquí se fija la regla que evita el peor fallo posible de todo esto: borrar en la nube una
    //! comanda que un camarero acaba de abrir desde la Handy, sólo porque a esta Main todavía no le
    //! había llegado. La diferencia entre «sobra» y «aún no me ha llegado» no se adivina: se mira
    //! el marcapáginas.

    use std::sync::Arc;

    use libsql::Value;
    use tpv_contracts::sync::{ClavesTabla, ConteoTabla, VerificacionClaves, VerificacionNube};

    use super::*;
    use crate::db::Db;

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("claves");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sql: &str) {
        let w = db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    /// Pone el marcapáginas del catch-up donde haga falta.
    async fn checkpoint_en(db: &Arc<Db>, seq: i64) {
        let w = db.write().await;
        w.raw()
            .execute(
                "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1;",
                vec![Value::Integer(seq)],
            )
            .await
            .unwrap();
    }

    fn claves_zonas(ids: &[&str]) -> VerificacionClaves {
        VerificacionClaves {
            tablas: vec![ClavesTabla {
                nombre: "Zonas".into(),
                columnas: vec!["ID_Zona".into()],
                claves: ids.iter().map(|i| vec![serde_json::json!(i)]).collect(),
                truncada: false,
            }],
        }
    }

    #[tokio::test]
    async fn un_contador_que_NO_cuadra_pide_las_claves_de_esa_tabla() {
        // La primera fase sólo sabe CUÁNTAS. Lo que hace que la segunda exista es esta lista: sin
        // ella, un descuadre se quedaba en un número que no se puede reparar.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A'),('z2','B');").await;

        let foto = VerificacionNube {
            conteos: vec![ConteoTabla { nombre: "Zonas".into(), filas: 1 }],
            ventana: vec![],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq: 10,
        };
        let r = repo.contrastar_con_la_nube(foto).await.unwrap();
        let t = r
            .tablas_a_examinar
            .iter()
            .find(|t| t.nombre == "Zonas")
            .expect("hay que pedir las claves de Zonas");
        assert_eq!(t.claves, vec!["ID_Zona".to_string()]);
    }

    #[tokio::test]
    async fn tambien_se_examina_cuando_la_nube_tiene_DE_MAS() {
        // Antes sólo se miraba `local > nube`. Una fila de más arriba —que es lo que hace que la
        // Handy enseñe algo que ya no existe— no se detectaba ni contando.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A');").await;

        let foto = VerificacionNube {
            conteos: vec![ConteoTabla { nombre: "Zonas".into(), filas: 5 }],
            ventana: vec![],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq: 10,
        };
        let r = repo.contrastar_con_la_nube(foto).await.unwrap();
        assert!(
            r.tablas_a_examinar.iter().any(|t| t.nombre == "Zonas"),
            "una tabla con MENOS filas aquí también hay que examinarla",
        );
    }

    #[tokio::test]
    async fn lo_que_falta_ARRIBA_se_identifica_y_se_repara() {
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A'),('z2','B');").await;
        checkpoint_en(&db, 100).await;

        // La nube sólo tiene z1.
        let (desc, reparadas, borradas, aplazado) =
            repo.contrastar_claves(claves_zonas(&["z1"]), 100).await.unwrap();

        let d = desc.iter().find(|d| d.tabla == "Zonas").expect("descuadre en Zonas");
        assert_eq!(d.faltan, 1, "z2 no está arriba");
        assert_eq!(d.sobran, 0);
        assert_eq!(reparadas, 1, "z2 se repara mandando su estado actual");
        assert_eq!(borradas, 0);
        assert!(!aplazado);

        let pend = repo.outbox_pending(100).await.unwrap();
        let rep = pend
            .iter()
            .find(|e| e.command_name == crate::sync_reparacion::COMANDO_REPARACION)
            .expect("tiene que haberse encolado");
        // Un upsert, NUNCA `INSERT OR REPLACE`: aquello borra la fila y la reinserta, disparando
        // los `ON DELETE CASCADE` que la apuntan (SYNC-26).
        let sql = &rep.statements[0].sql;
        assert!(sql.contains("ON CONFLICT"), "sql: {sql}");
        assert!(!sql.contains("OR REPLACE"), "sql: {sql}");
    }

    #[tokio::test]
    async fn con_la_reparacion_APAGADA_ni_repara_ni_borra_arriba() {
        // PROD-06: al día (se podría borrar y reparar), pero con `reparacion_nube` apagado.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A'),('z2','B');").await;
        checkpoint_en(&db, 100).await;

        // Arriba falta z2 y sobra z-vieja.
        let (desc, reparadas, borradas, aplazado) = repo
            .contrastar_claves_con(claves_zonas(&["z1", "z-vieja"]), 100, false)
            .await
            .unwrap();

        let d = desc.iter().find(|d| d.tabla == "Zonas").expect("descuadre en Zonas");
        assert_eq!((d.faltan, d.sobran), (1, 1), "se cuenta igual");
        assert_eq!((reparadas, borradas), (0, 0));
        assert!(aplazado);
        assert!(repo.outbox_pending(100).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn lo_que_SOBRA_arriba_se_borra_cuando_la_Main_esta_al_dia() {
        // El caso bueno: el marcapáginas llega al final de la foto, así que `z-vieja` no puede ser
        // algo de la Handy que esté de camino. Es un borrado local que no llegó a subir.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A');").await;
        checkpoint_en(&db, 100).await;

        let (desc, _rep, borradas, aplazado) = repo
            .contrastar_claves(claves_zonas(&["z1", "z-vieja"]), 100)
            .await
            .unwrap();

        assert_eq!(desc[0].sobran, 1);
        assert_eq!(borradas, 1);
        assert!(!aplazado);

        let pend = repo.outbox_pending(100).await.unwrap();
        let sql = &pend[0].statements[0].sql;
        assert!(sql.starts_with("DELETE FROM \"Zonas\""), "sql: {sql}");
    }

    #[tokio::test]
    async fn NO_se_borra_nada_si_el_marcapaginas_va_por_detras() {
        // El fallo que esto impide: un camarero abre una comanda desde la Handy, a esta Main aún no
        // le ha llegado, y la verificación la borra de la nube. La mesa se abre y se evapora.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A');").await;
        checkpoint_en(&db, 99).await; // la foto llega al 100: falta por leer

        let (desc, _rep, borradas, aplazado) = repo
            .contrastar_claves(claves_zonas(&["z1", "z-de-la-handy"]), 100)
            .await
            .unwrap();

        assert_eq!(desc[0].sobran, 1, "se ve y se informa...");
        assert_eq!(borradas, 0, "...pero NO se toca");
        assert!(aplazado, "y se dice que se ha aplazado, que no es lo mismo que 'no sobra nada'");
        assert!(repo.outbox_pending(100).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn NO_se_borra_nada_si_hay_cuarentena_de_BAJADA() {
        // El marcapáginas avanza aunque un cambio se aparte (SYNC-01), así que la Main *parece* al
        // día y en realidad le falta esa fila de verdad. Borrarla arriba sería destruir el dato
        // bueno: lo que hay que hacer ahí es lo contrario, volver a aplicarlo abajo.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A');").await;
        checkpoint_en(&db, 100).await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined, \
                       First_Failed_At_Ms, Last_Failed_At_Ms) \
                     VALUES ('op-x', 50, '[]', 5, 1, 1, 1);",
                )
                .await
                .unwrap();
        }

        let (_desc, _rep, borradas, aplazado) = repo
            .contrastar_claves(claves_zonas(&["z1", "z-que-no-supe-aplicar"]), 100)
            .await
            .unwrap();

        assert_eq!(borradas, 0);
        assert!(aplazado);
    }

    #[tokio::test]
    async fn un_worker_SIN_hasta_seq_no_borra_nada() {
        // Compatibilidad: un worker anterior no manda el `Seq`. Sin él no hay forma de saber si
        // esta Main está al día, así que se falla cerrado.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A');").await;
        checkpoint_en(&db, 100).await;

        let (_d, _r, borradas, aplazado) =
            repo.contrastar_claves(claves_zonas(&["z1", "z2"]), 0).await.unwrap();
        assert_eq!(borradas, 0);
        assert!(aplazado);
    }

    #[tokio::test]
    async fn una_lista_TRUNCADA_no_produce_un_borrado_masivo() {
        // Media lista de claves se leería como "te sobran 400.000 filas". Es el fallo que se lleva
        // la base entera, así que una tabla truncada se salta y se dice.
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','A'),('z2','B');").await;
        checkpoint_en(&db, 100).await;

        let respuesta = VerificacionClaves {
            tablas: vec![ClavesTabla {
                nombre: "Zonas".into(),
                columnas: vec!["ID_Zona".into()],
                claves: vec![],
                truncada: true,
            }],
        };
        let (desc, reparadas, borradas, _) = repo.contrastar_claves(respuesta, 100).await.unwrap();
        assert!(desc.is_empty(), "una tabla truncada no afirma nada");
        assert_eq!(reparadas, 0);
        assert_eq!(borradas, 0);
        assert!(repo.outbox_pending(100).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn una_clave_COMPUESTA_se_compara_entera() {
        // Con clave compuesta, comparar sólo la primera columna daría por iguales dos filas
        // distintas — y entonces "sobran" y "faltan" saldrían ambas a cero con la base descuadrada.
        let (repo, db, _dir) = repo_temporal().await;
        checkpoint_en(&db, 100).await;

        let respuesta = VerificacionClaves {
            tablas: vec![ClavesTabla {
                nombre: "Pago_Detalles".into(),
                columnas: vec!["ID_Pago".into(), "ID_Detalle".into()],
                claves: vec![
                    vec![serde_json::json!("p1"), serde_json::json!("d1")],
                    vec![serde_json::json!("p1"), serde_json::json!("d2")],
                ],
                truncada: false,
            }],
        };
        let (desc, _r, borradas, _a) = repo.contrastar_claves(respuesta, 100).await.unwrap();
        let d = desc.iter().find(|d| d.tabla == "Pago_Detalles").expect("descuadre");
        assert_eq!(d.sobran, 2, "son DOS filas distintas, no una");
        assert_eq!(borradas, 2);
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

    use libsql::Value;

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
        repo.outbox_mark_sent(&rep.op_id, 7).await.unwrap();

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

        repo.outbox_mark_sent("normal", 9).await.unwrap();

        assert_eq!(
            repo.health().await.unwrap().subida_en_cuarentena,
            1,
            "la apartada sigue ahí: nadie ha reparado nada",
        );
    }
}

#[cfg(test)]
mod tests_main_atrasada {
    #![allow(non_snake_case)] // los nombres en mayúsculas señalan qué afirma cada test

    //! SYNC-26 — una Main que va por detrás no decide nada.
    //!
    //! El job de verificación va por REST, así que corre igual con el WebSocket caído — que es
    //! justo cuando esta Main está más atrasada respecto de lo que la Handy ha ido escribiendo. Si
    //! en ese estado se "reparase" lo que ve distinto, estaría pisando con datos viejos todo lo que
    //! el camarero acaba de hacer desde la tablet. Y sin error, que es lo peor.

    use std::sync::Arc;

    use libsql::Value;
    use tpv_contracts::sync::{BootstrapTabla, VerificacionNube};

    use super::*;
    use crate::db::Db;

    async fn repo_temporal() -> (SqliteSyncRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("atrasada");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteSyncRepository::new(db.clone()), db, dir)
    }

    /// La misma foto en los dos tests: la nube dice "Salón", aquí pone "Terraza".
    fn foto(hasta_seq: i64) -> VerificacionNube {
        VerificacionNube {
            conteos: vec![],
            ventana: vec![BootstrapTabla {
                nombre: "Zonas".into(),
                columnas: vec!["ID_Zona".into(), "Nombre_Zona".into()],
                filas: vec![vec![serde_json::json!("z1"), serde_json::json!("Salón")]],
                parcial: false,
            }],
            ventana_omitida: false,
            desde: String::new(),
            hasta_seq,
        }
    }

    async fn preparar(db: &Arc<Db>, checkpoint: i64) {
        let w = db.write().await;
        w.raw()
            .execute_batch("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1','Terraza');")
            .await
            .unwrap();
        w.raw()
            .execute(
                "UPDATE _Sync_State SET Last_Seq = ?1 WHERE Id = 1;",
                vec![Value::Integer(checkpoint)],
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn al_dia_SI_repara() {
        // El control: con el marcapáginas al día, la diferencia es real y se arregla.
        let (repo, db, _dir) = repo_temporal().await;
        preparar(&db, 500).await;

        let r = repo.contrastar_con_la_nube(foto(500)).await.unwrap();
        assert_eq!(r.reparadas, 1);
        assert!(!r.aplazado);
    }

    #[tokio::test]
    async fn ATRASADA_ve_la_diferencia_pero_no_la_toca() {
        // Mismo escenario, una sola cosa cambia: el marcapáginas va por detrás de la foto. Ese
        // "Salón" de la nube puede ser un cambio de la Handy que aquí todavía no ha llegado, así
        // que mandar el "Terraza" local lo borraría del mapa.
        let (repo, db, _dir) = repo_temporal().await;
        preparar(&db, 499).await;

        let r = repo.contrastar_con_la_nube(foto(500)).await.unwrap();

        assert_eq!(
            r.descuadres.iter().map(|d| d.distintas).sum::<i64>(),
            1,
            "la diferencia se VE y se informa...",
        );
        assert_eq!(r.reparadas, 0, "...pero no se toca");
        assert!(r.aplazado, "y se dice que se ha aplazado");
        assert!(
            repo.outbox_pending(100).await.unwrap().is_empty(),
            "no puede salir nada hacia la nube",
        );
    }

    #[tokio::test]
    async fn con_la_reparacion_APAGADA_ve_la_diferencia_y_no_la_toca() {
        // PROD-06: el mismo escenario que `al_dia_SI_repara`, al día y todo, con el interruptor
        // `reparacion_nube` apagado. Se compara igual —es lo que permite ver si el problema sigue
        // ahí— pero no sale nada hacia la nube.
        let (repo, db, _dir) = repo_temporal().await;
        preparar(&db, 500).await;

        let r = repo.contrastar_con_la_nube_con(foto(500), false).await.unwrap();

        assert_eq!(r.descuadres.iter().map(|d| d.distintas).sum::<i64>(), 1);
        assert_eq!(r.reparadas, 0);
        assert!(r.aplazado);
        assert!(repo.outbox_pending(100).await.unwrap().is_empty());

        // Y al encenderse, la pasada siguiente repara lo que quedó pendiente.
        let r = repo.contrastar_con_la_nube_con(foto(500), true).await.unwrap();
        assert_eq!(r.reparadas, 1);
    }
}
