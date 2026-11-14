//! Replicación nativa Main ↔ nube (RI-31/RI-57). Orden, confirmaciones y recuperación.
//! El canal sólo procede del transporte TLS autenticado. Ningún llamante de IPC aporta SQL/acks.
use std::{collections::HashMap, time::{Duration, Instant}};
use serde_json::{json, Value};
use tpv_contracts::{licensing::FirmaDispositivo, sync::{OutboxEntry, SyncChange}};
use crate::{error::{AppError, AppResult}, ports::{licensing::PairingService, replicacion::{CanalReplicacion, ContextoReplicacion, RitmoDeSubida}, sync::{BajadaAplicada, CambioDetenido}}};

const MAX_PAGINAS: usize = 2000;
/// Lo que ocupan como mucho las sentencias de un lote (`apply_lote`). Una operación que pase de
/// aquí ella sola va en un lote para ella. El `TenantHub` aplica hasta 512 KB de una vez.
const LOTE_MAX_BYTES: usize = 256 * 1024;
/// Lo que se espera el acuse de un lote. Sin acuse no hay veredicto: es el transporte, y no cuenta
/// como intento de ninguna de sus operaciones.
const ESPERA_DEL_LOTE: Duration = Duration::from_secs(30);
/// Lo que se anota en una operación que la nube rechaza. Sin su SQL ni sus datos (OBS-02).
const RECHAZO_DE_LA_NUBE: &str = "Rechazo de aplicación recibido de la nube";

/// Cambios que se piden por página de `/v1/sync/changes`: los que admite el worker (`changesSchema`,
/// 1.000). Lo que cuesta una página en el DO es leer el log por su clave y escribirla; el worker la
/// corta además por bytes (`CAMBIOS_MAX_BYTES`), así que pedir más sólo ahorra viajes.
pub(crate) const CAMBIOS_POR_PAGINA: i64 = 1_000;

/// Lo más a menudo que se mira, con la sesión abierta, si este equipo sigue siendo la Main con la
/// réplica encendida (`ContextoReplicacion::sigue_disponible`, que lee `device_config.json`, mira si
/// hay un traslado y hace dos consultas). Se mira al volver de cada espera del socket, como antes:
/// en reposo, cuando vence (hasta 30 s). Antes se miraba en cada vuelta del bucle, que es cada
/// mensaje del socket: con las Handy trabajando, varias veces por segundo. Lo que cambia el modo
/// (`contexto_cambiado`) o la palanca (`set_connection_mode`) despierta al motor (`despertar`), y
/// entonces se mira en el momento.
pub const COMPROBAR_DISPONIBLE_CADA: Duration = Duration::from_secs(10);

/// AUD-18 · Cuánto se espera antes de volver a intentar un cambio de la nube que ha fallado al
/// aplicarse, según los intentos que lleva: 1, 2, 4 y 8 s. Son cinco intentos
/// (`MAX_APPLY_ATTEMPTS`, en el repositorio) y cuatro esperas, unos 15 s antes de la cuarentena.
///
/// Lo que falla de forma pasajera al escribir en el SQLite local (un bloqueo del fichero, un
/// error de E/S momentáneo) se resuelve en milisegundos o en pocos segundos, y eso cabe de sobra.
/// Lo que falla siempre (una columna que esta versión no tiene, una restricción, una clave
/// foránea) da lo mismo al primer intento que al décimo: esperar más sólo alargaría la pausa de la
/// bajada. Y la pausa es pequeña: las Handy sólo escriben con una Main conectada, así que lo que
/// se acumula detrás son unos pocos cambios en vivo.
fn espera_para_reintentar(intentos: i64) -> Duration {
    Duration::from_secs(1 << (intentos.clamp(1, 4) - 1))
}

/// AUD-18 · La bajada de esta sesión. Un cambio de la nube que falla al aplicarse la detiene: hasta
/// que entra o pasa a cuarentena no se aplica nada posterior ni se mueve el checkpoint, y lo que
/// llega en vivo mientras tanto no se aplica: lo trae después el catch-up desde el checkpoint, que
/// es la fuente de verdad.
#[derive(Debug, Default)]
pub struct Bajada {
    /// Detenida: no se vuelve a intentar antes de este instante.
    detenida_hasta: Option<Instant>,
}

impl Bajada {
    fn detener(&mut self, cambio: &CambioDetenido) {
        self.detenida_hasta = Some(Instant::now() + espera_para_reintentar(cambio.intentos));
    }
    pub fn detenida(&self) -> bool {
        self.detenida_hasta.is_some()
    }
}

/// Una sesión del motor: su bajada (AUD-18) y lo que lleva subido.
#[derive(Debug, Default)]
pub struct Sesion {
    bajada: Bajada,
    /// Los lotes que ha mandado esta sesión: con él se nombra cada uno.
    lotes: u64,
}

/// Lo que deja un catch-up: el final del log que ha visto, si se ha detenido, en qué cambio, y si a
/// esta base le falta un tramo que la nube ya purgó (AUD-19, sólo fuera del modo recuperación).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PuestaAlDia {
    pub high_water: i64,
    pub detenida: Option<CambioDetenido>,
    pub anterior_al_log: bool,
}

/// Cómo acaba una sesión del motor que no ha fallado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinDeSesion {
    /// Este equipo ha dejado de replicar (el modo, la palanca o el estado de la base): el bucle del
    /// motor vuelve a mirar.
    NoDisponible,
    /// AUD-19 · A esta base le falta un tramo que la nube ya purgó. Con la purga actual, una Main que
    /// sólo ha estado sin conexión no llega aquí: el suelo de la purga no pasa de su propio
    /// checkpoint mientras lo reporta, y si lleva más de 7 días sin hacerlo no se purga nada. Llega
    /// una base cambiada por fuera de la aplicación (una imagen de disco, una `data.db` copiada a
    /// mano). Se para antes de aplicar, de subir y de mover el checkpoint, así que `verificar_nube`
    /// tampoco toca la nube; los datos y el outbox se quedan como están y se sigue vendiendo.
    /// Reconectar no lo arregla: el motor espera a que se pida reintentar o al siguiente arranque, y
    /// Conectividad enseña `MOTIVO_ANTERIOR_AL_LOG`.
    AnteriorAlLog,
}

/// AUD-19 · Lo que enseña Conectividad cuando la sesión normal acaba en `FinDeSesion::AnteriorAlLog`.
pub const MOTIVO_ANTERIOR_AL_LOG: &str = "Los datos de este equipo son anteriores a lo que guarda la nube: no se sincronizan para no mezclarlos, y lo que se venda se sigue guardando aquí. Contacta con soporte para recuperar el estado actual de la nube.";

pub fn cambio(m: Value) -> AppResult<SyncChange> {
    let op_id = m.get("opId").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| AppError::external("Cambio sin operación"))?.to_string();
    let seq = m.get("seq").and_then(Value::as_i64).filter(|s| *s > 0).ok_or_else(|| AppError::external("Cambio sin secuencia válida"))?;
    let statements = serde_json::from_value(m.get("statements").cloned().ok_or_else(|| AppError::external("Cambio sin sentencias"))?).map_err(|_| AppError::external("Sentencias de réplica inválidas"))?;
    Ok(SyncChange { op_id, seq, statements })
}

async fn aplicar(ctx: &dyn ContextoReplicacion, cambios: Vec<SyncChange>) -> AppResult<BajadaAplicada> {
    let copia = cambios.clone();
    let resultado = ctx.repositorio().await?.apply_changes(cambios).await?;
    let sentencias = copia.into_iter().filter(|c| resultado.aplicadas.contains(&c.op_id)).flat_map(|c| c.statements).collect::<Vec<_>>();
    if !sentencias.is_empty() { ctx.cambios(&sentencias); }
    Ok(resultado)
}

/// AUD-19 · ¿Le falta a esta base algo que la nube ya purgó? La purga anota, en la misma
/// transacción que borra, el mayor `Seq` que se ha llevado, y `/v1/sync/changes` lo devuelve con cada
/// página, leído con ella (`purgadoHasta`): si pasa del checkpoint, lo de en medio ya no está y el
/// catch-up no lo puede traer. Es exacto: no depende de que los `Seq` sean contiguos ni de que la
/// purga quite un prefijo (combina `Seq` y antigüedad, y la antigüedad se fija antes de numerar).
///
/// Sin `purgadoHasta` (un worker anterior), la recuperación no puede comprobar la copia y falla
/// cerrada, como sin `highWater`; la sesión normal sigue como antes: el worker se despliega antes.
fn falta_un_tramo(respuesta: &Value, since: i64, estricto: bool) -> AppResult<bool> {
    match respuesta.get("purgadoHasta").and_then(Value::as_i64) {
        Some(purgado) => Ok(purgado > since),
        None if estricto => Err(AppError::external("La nube no dice hasta dónde ha purgado sus cambios, así que esta copia no se puede comprobar: recupera el estado actual de la nube.")),
        None => Ok(false),
    }
}

/// Una pasada de catch-up desde el checkpoint, en orden de `Seq`.
///
/// AUD-18: empieza por el cambio en el que se detuvo la bajada, con las sentencias que se
/// guardaron al fallar; mientras no entre (o pase a cuarentena) no se pide nada a la nube. Y dentro
/// de cada página rige la misma regla: si un cambio la detiene, la siguiente no se pide.
pub async fn catch_up(ctx: &dyn ContextoReplicacion, nube: &dyn PairingService, estricto: bool) -> AppResult<PuestaAlDia> {
    if let Some(detenido) = ctx.repositorio().await?.cambio_detenido().await? {
        let r = aplicar(ctx, vec![detenido]).await?;
        if r.detenida.is_some() { return Ok(PuestaAlDia { high_water: 0, detenida: r.detenida, anterior_al_log: false }); }
    }
    let mut since = ctx.repositorio().await?.get_checkpoint().await?;
    let mut high_water = 0;
    for _ in 0..MAX_PAGINAS {
        let respuesta = nube.tpv_server_post_json("tpv", "/v1/sync/changes", json!({"since":since,"limit":CAMBIOS_POR_PAGINA})).await?;
        match respuesta.get("highWater").and_then(Value::as_i64) {
            Some(hw) if hw >= 0 => high_water = hw,
            _ if estricto => return Err(AppError::external("La nube no informa del punto de sincronización")),
            _ => {}
        }
        // AUD-19: en cada página, porque la purga puede correr entre una y otra. Antes de aplicar
        // nada: lo conservado encima de un hueco daría por buena una base sin ese tramo.
        if falta_un_tramo(&respuesta, since, estricto)? {
            if estricto { return Err(AppError::conflict("Esta copia es anterior a lo que guarda la nube: recupera el estado actual de la nube.")); }
            return Ok(PuestaAlDia { high_water, detenida: None, anterior_al_log: true });
        }
        let items = respuesta.get("items").and_then(Value::as_array).ok_or_else(|| AppError::external("Catch-up sin lista de cambios"))?;
        if items.is_empty() { return Ok(PuestaAlDia { high_water, detenida: None, anterior_al_log: false }); }
        let cambios = items.iter().cloned().map(cambio).collect::<AppResult<Vec<_>>>()?;
        if cambios.windows(2).any(|p| p[0].seq >= p[1].seq) { return Err(AppError::external("Catch-up desordenado")); }
        let r = aplicar(ctx, cambios).await?;
        if r.detenida.is_some() { return Ok(PuestaAlDia { high_water, detenida: r.detenida, anterior_al_log: false }); }
        let next = respuesta.get("nextSince").and_then(Value::as_i64).ok_or_else(|| AppError::external("Catch-up sin cursor"))?;
        if next <= since { return Err(AppError::external("El cursor de sincronización no avanza")); }
        // AUD-18: la página siguiente sólo se pide si el checkpoint ha llegado al final de ésta.
        if r.last_seq < next { return Err(AppError::external("El checkpoint no llegó al final de la página")); }
        since = next;
    }
    Err(AppError::external("sync_catchup_cap_reached"))
}

/// AUD-18 · El catch-up con la regla de orden. Si se detiene en un cambio que falla, se espera lo
/// que toque atendiendo el socket (sin aplicar lo que llega en vivo) y se vuelve a intentar desde
/// el checkpoint, hasta que el cambio entra o pasa a cuarentena y el catch-up llega al final del
/// log. Termina siempre: cada cambio tiene cinco intentos. Devuelve el final del log visto, o que a
/// esta base le falta un tramo (AUD-19), sin haber aplicado nada.
async fn ponerse_al_dia(ctx: &dyn ContextoReplicacion, nube: &dyn PairingService, canal: &mut dyn CanalReplicacion, sesion: &mut Sesion, estricto: bool) -> AppResult<PuestaAlDia> {
    loop {
        if let Some(hasta) = sesion.bajada.detenida_hasta {
            esperar_atendiendo(ctx, canal, sesion, hasta).await?;
        }
        let r = catch_up(ctx, nube, estricto).await?;
        match r.detenida {
            None => {
                sesion.bajada.detenida_hasta = None;
                return Ok(r);
            }
            Some(d) => sesion.bajada.detener(&d),
        }
    }
}

/// AUD-18 · Atiende el socket hasta `hasta` con la bajada detenida: lo que no es un cambio se
/// atiende como siempre, y los cambios no se aplican.
async fn esperar_atendiendo(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, sesion: &mut Sesion, hasta: Instant) -> AppResult<()> {
    loop {
        let falta = hasta.saturating_duration_since(Instant::now());
        if falta.is_zero() { return Ok(()); }
        match canal.recibir(falta).await? {
            // `None` es que ha vencido la espera (`CanalNube::recibir`).
            None => return Ok(()),
            Some(m) => atender(ctx, sesion, m).await?,
        }
    }
}

pub fn operacion(entry: &OutboxEntry) -> Value {
    json!({"opId":entry.op_id,"commandName":entry.command_name,"command":{"type":"tenantDb.transaction","payload":{"steps":entry.statements.iter().map(|s| json!({"kind":"execute","sql":s.sql,"args":s.args})).collect::<Vec<_>>()}}})
}

async fn atender(ctx: &dyn ContextoReplicacion, sesion: &mut Sesion, mensaje: Value) -> AppResult<()> {
    match mensaje.get("type").and_then(Value::as_str) {
        Some("change") => {
            // AUD-18: con la bajada detenida no se aplica nada posterior; lo trae el catch-up.
            if sesion.bajada.detenida() { return Ok(()); }
            if let Some(d) = aplicar(ctx, vec![cambio(mensaje)?]).await?.detenida { sesion.bajada.detener(&d); }
        }
        Some("pair_request") => ctx.solicitud_emparejamiento(),
        Some("reservas_web") => ctx.reservas_web(),
        _ => {}
    }
    Ok(())
}

fn cierto(v: &Value, campo: &str) -> bool {
    v.get(campo) == Some(&Value::Bool(true))
}

/// Lo que la nube contesta a un lote.
enum RespuestaAlLote {
    /// Su `apply_lote_ack`.
    Acuse(Value),
    /// El mensaje no le cabe y no lo ha leído (`payload_too_large`).
    NoCabe,
}

/// Espera el acuse del lote `lote_id` atendiendo entretanto lo demás que llegue. Sólo hay un lote en
/// vuelo, y de lo que manda la Main sólo él puede provocar un `payload_too_large`: ese error suelto
/// es también su respuesta. Cualquier otro mensaje se atiende como siempre y no responde al lote.
async fn esperar_acuse_del_lote(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, sesion: &mut Sesion, lote_id: &str) -> AppResult<RespuestaAlLote> {
    let fin = Instant::now() + ESPERA_DEL_LOTE;
    while Instant::now() < fin {
        let restante = fin.saturating_duration_since(Instant::now());
        let Some(m) = canal.recibir(restante).await? else { continue };
        match (m.get("type").and_then(Value::as_str), m.get("error").and_then(Value::as_str)) {
            (Some("apply_lote_ack"), _) if m.get("loteId").and_then(Value::as_str) == Some(lote_id) => return Ok(RespuestaAlLote::Acuse(m)),
            (Some("error"), Some("payload_too_large")) => return Ok(RespuestaAlLote::NoCabe),
            _ => atender(ctx, sesion, m).await?,
        }
    }
    Err(AppError::external("No llegó la confirmación de la nube"))
}

/// El principio de lo pendiente que cabe en un lote: hasta `LOTE_MAX_BYTES` de sentencias, y una
/// operación al menos.
fn cortar(pendientes: Vec<OutboxEntry>) -> AppResult<Vec<OutboxEntry>> {
    let mut bytes = 0;
    let mut lote = Vec::new();
    for entry in pendientes {
        let n = serde_json::to_vec(&entry.statements).map_err(|_| AppError::external("Outbox inválido"))?.len();
        if !lote.is_empty() && bytes + n > LOTE_MAX_BYTES { break; }
        bytes += n;
        lote.push(entry);
    }
    Ok(lote)
}

/// Sube lo pendiente del outbox, en orden, hasta vaciarlo. Devuelve si lo ha dejado vacío.
///
/// Es el único camino de subida, con atraso o sin él: se lee el principio de lo pendiente (hasta 200
/// operaciones y 256 KB de sentencias), se manda en un `apply_lote` y se espera su acuse, que trae el
/// veredicto de cada operación. **Sólo hay un lote en vuelo**: el siguiente no se lee del outbox
/// hasta que lo aplicado del anterior está confirmado aquí.
///
/// - Sin acuse (30 s, o el socket se cae) no hay veredicto: es el transporte, no cuenta como intento
///   de nadie y la sesión acaba ahí. El lote volverá a salir, y lo que ya estuviera aplicado
///   contesta «ya estaba» con su `Seq`.
/// - Con acuse, `tras_el_acuse`.
/// - `estricto` (la recuperación): cualquier rechazo es un error.
pub async fn subir_pendientes(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, sesion: &mut Sesion, estricto: bool) -> AppResult<bool> {
    let ritmo = ctx.ritmo_de_subida();
    // Finito para no dejar al receptor sin turno ante una importación continua.
    for _ in 0..10000 {
        let pendientes = ctx.repositorio().await?.outbox_pending(ritmo.tamano_del_lote() as i64).await?;
        if pendientes.is_empty() { return Ok(true); }
        let lote = cortar(pendientes)?;
        sesion.lotes += 1;
        let lote_id = format!("{}-{}", sesion.lotes, lote[0].op_id);
        ritmo.lote_enviado();
        canal.enviar(json!({"type":"apply_lote","loteId":lote_id,"ops":lote.iter().map(operacion).collect::<Vec<_>>()})).await?;
        let respuesta = esperar_acuse_del_lote(ctx, canal, sesion, &lote_id).await?;
        ritmo.lote_respondido();
        let seguir = match respuesta {
            RespuestaAlLote::Acuse(acuse) => tras_el_acuse(ctx, &ritmo, &lote, &acuse, estricto).await?,
            RespuestaAlLote::NoCabe => no_cabe(ctx, &ritmo, &lote, estricto).await?,
        };
        if !seguir { return Ok(false); }
    }
    Ok(false)
}

/// Lo que se hace con el acuse de un lote. Devuelve si la subida sigue ahora con el lote siguiente o
/// espera a la vuelta siguiente del motor.
///
/// Los veredictos se leen en el orden del lote, por `opId`:
/// - **aplicada** (o «ya estaba»): se confirma con su `Seq`;
/// - **sin intentar** (`noIntentada`, o la nube no dice nada de ella): no se le cuenta nada y se
///   deja de leer; lo que queda sale en el lote siguiente;
/// - **rechazo pasajero** (`transitorio`): tampoco se le cuenta, y la subida espera;
/// - **rechazo permanente**: se aparta, se encola su reparación por estado (SYNC-22) y se sigue
///   leyendo: la nube ha seguido aplicando lo de detrás;
/// - **cualquier otro rechazo**: se le cuenta un intento. Lo de detrás no se ha intentado.
///
/// Lo aplicado se confirma en UNA transacción (`outbox_confirmar_lote`) antes que nada más: un
/// corte a mitad deja el lote confirmado entero o sin confirmar, y sin confirmar vuelve a subir.
///
/// Si la nube rechaza el lote entero (`ok: false`) no ha aplicado nada. Lo que habla de cómo está
/// ella (`transitorio`: la sesión, la base) no le cuenta nada a nadie. Lo demás es de alguna
/// operación del lote y no dice de cuál: se repite de una en una, y a la que va sola se le cuenta.
async fn tras_el_acuse(ctx: &dyn ContextoReplicacion, ritmo: &RitmoDeSubida, lote: &[OutboxEntry], acuse: &Value, estricto: bool) -> AppResult<bool> {
    if !cierto(acuse, "ok") {
        if estricto { return Err(AppError::external("La nube rechazó el lote")); }
        if !cierto(acuse, "transitorio") {
            match lote {
                [sola] => {
                    let fallo = ctx.repositorio().await?.outbox_mark_failed(&sola.op_id, RECHAZO_DE_LA_NUBE, cierto(acuse, "permanente")).await?;
                    ctx.fallo_subida(&sola.op_id, &fallo);
                }
                _ => ritmo.de_una_en_una(),
            }
        }
        return Ok(false);
    }
    let resultados = acuse.get("resultados").and_then(Value::as_array).ok_or_else(|| AppError::external("Acuse de lote sin veredictos"))?;
    let veredictos: HashMap<&str, &Value> = resultados.iter().filter_map(|r| Some((r.get("opId").and_then(Value::as_str)?, r))).collect();

    let mut aplicadas: Vec<(String, i64)> = Vec::new();
    let mut rechazadas: Vec<(&OutboxEntry, bool)> = Vec::new();
    let mut rechazo_estricto = None;
    let mut espera = false;
    for entry in lote {
        let Some(v) = veredictos.get(entry.op_id.as_str()) else { break };
        if cierto(v, "ok") {
            aplicadas.push((entry.op_id.clone(), v.get("seq").and_then(Value::as_i64).unwrap_or(0)));
            continue;
        }
        if cierto(v, "noIntentada") { break; }
        if estricto { rechazo_estricto = Some(entry.op_id.clone()); break; }
        if cierto(v, "transitorio") { espera = true; break; }
        let permanente = cierto(v, "permanente");
        rechazadas.push((entry, permanente));
        if !permanente { break; }
    }

    let repo = ctx.repositorio().await?;
    let mut avance = aplicadas.len();
    if !aplicadas.is_empty() { repo.outbox_confirmar_lote(&aplicadas).await?; }
    if let Some(op_id) = rechazo_estricto { return Err(AppError::external(format!("La nube rechazó la operación {op_id}"))); }
    for (entry, permanente) in rechazadas {
        let fallo = repo.outbox_mark_failed(&entry.op_id, RECHAZO_DE_LA_NUBE, permanente).await?;
        ctx.fallo_subida(&entry.op_id, &fallo);
        // Apartada, deja de estar pendiente y la subida sigue. Si no, espera con ella delante.
        if fallo.apartada { avance += 1; } else { espera = true; }
    }
    ritmo.crecer();
    // Un lote que no ha movido nada no se repite en caliente.
    Ok(!espera && avance > 0)
}

/// La nube no ha podido ni leer el lote: el mensaje no le cabe. Las sentencias de un lote ocupan
/// 256 KB como mucho, así que sólo puede pasar con una operación enorme. Sola en su lote, no va a
/// caber nunca: se aparta y se repara por estado, como un rechazo permanente.
async fn no_cabe(ctx: &dyn ContextoReplicacion, ritmo: &RitmoDeSubida, lote: &[OutboxEntry], estricto: bool) -> AppResult<bool> {
    if estricto { return Err(AppError::external("La nube no admite un lote de ese tamaño")); }
    let [sola] = lote else {
        ritmo.de_una_en_una();
        return Ok(true);
    };
    let fallo = ctx.repositorio().await?.outbox_mark_failed(&sola.op_id, "La operación no cabe en un mensaje de la nube", true).await?;
    ctx.fallo_subida(&sola.op_id, &fallo);
    Ok(fallo.apartada)
}

/// AUD-15 · El saludo de la Main, siempre con `recovering`: el DO congela a las Handy
/// (`main_volcando`) y deja pasar lo que suba la Main, y `ejecutar` las suelta con `recovery_ready`
/// cuando se ha puesto al día: con el outbox vacío. Mirar antes si hay atraso no sirve: lo que se confirme entre mirarlo y
/// autenticarse subiría con las Handy ya sueltas.
///
/// En el DO, `recovering` sólo congela a las Handy; el modo recuperación de la Main (estricto, con
/// sus fases y `completar_recuperacion`) sigue siendo `recuperando`, que no tiene que ver con esto.
pub async fn saludar<F>(canal: &mut dyn CanalReplicacion, firmar: F) -> AppResult<()>
where F: FnMut(&str) -> AppResult<FirmaDispositivo> + Send {
    crate::use_cases::saludo_socket::saludar(canal, firmar, "tpv", true).await
}

pub async fn ejecutar(ctx: &dyn ContextoReplicacion, nube: &dyn PairingService, canal: &mut dyn CanalReplicacion, recuperando: bool) -> AppResult<FinDeSesion> {
    ctx.fase_recuperacion(if recuperando {"descargando"} else {"inactiva"});
    let mut sesion = Sesion::default();
    if ponerse_al_dia(ctx, nube, canal, &mut sesion, recuperando).await?.anterior_al_log { return Ok(FinDeSesion::AnteriorAlLog); }
    let mut vacio = true;
    if recuperando {
        ctx.fase_recuperacion("subiendo");
        subir_pendientes(ctx, canal, &mut sesion, true).await?;
        let mut completada = false;
        for _ in 0..180 {
            ctx.fase_recuperacion("verificando");
            let high_water = ponerse_al_dia(ctx, nube, canal, &mut sesion, true).await?.high_water;
            let salud = ctx.repositorio().await?.health().await?;
            if salud.outbox_pending == 0 && salud.last_seq >= high_water && salud.failing == 0 && salud.quarantined == 0 && salud.subida_en_cuarentena == 0 {
                ctx.completar_recuperacion(high_water).await?;
                canal.enviar(json!({"type":"recovery_ready"})).await?;
                ctx.fase_recuperacion("completada");
                // Lo que se reservó en la web mientras tanto.
                ctx.reservas_web();
                completada = true;
                break;
            }
            if let Some(m) = canal.recibir(Duration::from_secs(1)).await? { atender(ctx, &mut sesion, m).await?; }
            ctx.fase_recuperacion("subiendo");
            subir_pendientes(ctx, canal, &mut sesion, true).await?;
        }
        if !completada { return Err(AppError::external("La nube no confirmó la convergencia")); }
    } else {
        vacio = subir_pendientes(ctx, canal, &mut sesion, false).await?;
        // Al conectar, lo que se haya reservado en la web mientras esta Main no estaba.
        ctx.reservas_web();
    }
    // AUD-15: las Handy que congeló el saludo se sueltan una vez por sesión, cuando no queda nada
    // que deba llegar antes a la nube: `subir_pendientes` encuentra el outbox vacío, con las
    // reparaciones de lo apartado ya subidas. Una reparación que la nube tampoco acepta queda en
    // cuarentena, fuera de lo pendiente, y no las retiene: su rastro es el de cualquier apartada.
    // Esa última subida es la frontera: lo que se confirme aquí después es trabajo en vivo, como
    // con la sesión ya abierta. En la recuperación las suelta su desbloqueo.
    let mut handy_por_soltar = !recuperando;
    let mut ultimo_sondeo = Instant::now();
    // `None`: toca mirar si sigue disponible. La primera vuelta mira siempre.
    let mut disponible_comprobado: Option<Instant> = None;
    loop {
        if handy_por_soltar && vacio {
            vacio = subir_pendientes(ctx, canal, &mut sesion, false).await?;
            if vacio {
                canal.enviar(json!({"type":"recovery_ready"})).await?;
                handy_por_soltar = false;
            }
            ultimo_sondeo = Instant::now();
        }
        if disponible_comprobado.is_none_or(|t| t.elapsed() >= COMPROBAR_DISPONIBLE_CADA) {
            if !ctx.sigue_disponible(false).await? { return Ok(FinDeSesion::NoDisponible); }
            disponible_comprobado = Some(Instant::now());
        }
        // AUD-18: un cambio en vivo ha fallado. Se reintenta con su espera y la bajada se pone al
        // día por catch-up antes de volver a escuchar; después, una vuelta de subida.
        if sesion.bajada.detenida() {
            if ponerse_al_dia(ctx, nube, canal, &mut sesion, false).await?.anterior_al_log { return Ok(FinDeSesion::AnteriorAlLog); }
            vacio = subir_pendientes(ctx, canal, &mut sesion, false).await?;
            ultimo_sondeo = Instant::now();
            continue;
        }
        let msg = canal.recibir(Duration::from_secs(if vacio {30} else {3})).await?;
        let despertar = msg.as_ref().and_then(|m| m.get("type")).and_then(Value::as_str) == Some("despertar");
        // Un cambio de modo o de la palanca despierta al motor (`contexto_cambiado`): se mira ya.
        if despertar { disponible_comprobado = None; }
        if let Some(m) = msg { atender(ctx, &mut sesion, m).await?; }
        if despertar || ultimo_sondeo.elapsed() >= Duration::from_secs(if vacio {30} else {3}) {
            vacio = subir_pendientes(ctx, canal, &mut sesion, false).await?;
            ultimo_sondeo = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn un_cambio_mal_formado_no_avanza_el_cursor() {
        for m in [json!({}), json!({"opId":"x","seq":-1,"statements":[]}), json!({"opId":"x","seq":1,"statements":"SQL"})] { assert!(cambio(m).is_err()); }
        assert_eq!(cambio(json!({"opId":"x","seq":2,"statements":[]})).unwrap().seq, 2);
    }
    // AUD-18: cuatro esperas crecientes y cortas entre los cinco intentos de un cambio.
    #[test]
    fn las_esperas_entre_intentos_son_cortas_y_crecen() {
        let esperas = (1..=4).map(espera_para_reintentar).map(|d| d.as_secs()).collect::<Vec<_>>();
        assert_eq!(esperas, vec![1, 2, 4, 8]);
        assert_eq!(espera_para_reintentar(0).as_secs(), 1);
        assert_eq!(espera_para_reintentar(9).as_secs(), 8);
    }
}

#[cfg(test)]
#[path = "replicacion_tests.rs"]
mod scenarios;
