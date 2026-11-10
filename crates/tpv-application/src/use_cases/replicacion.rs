//! Replicación nativa Main ↔ nube (RI-31/RI-57). Orden, confirmaciones y recuperación.
//! El canal sólo procede del transporte TLS autenticado. Ningún llamante de IPC aporta SQL/acks.
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use tpv_contracts::{licensing::FirmaDispositivo, sync::{OutboxEntry, SyncChange}};
use crate::{error::{AppError, AppResult}, ports::{licensing::PairingService, replicacion::{CanalReplicacion, ContextoReplicacion}, sync::{BajadaAplicada, CambioDetenido}}};

const MAX_PAGINAS: usize = 2000;
const TTL_ENCOLADA: i64 = 60 * 60 * 1000;

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

/// AUD-15 · Lo que la nube ha dicho en esta sesión de su cola de entrada (SYNC-18). Las Handy no se
/// sueltan mientras pueda llegar algo que la Main tenga que reparar: lo que el DO apartó de la cola
/// (`cola_apartada`) llega en el saludo, antes de `main_status`, o al drenarla, antes del aviso de
/// que se ha vaciado.
#[derive(Debug, Default)]
pub struct ColaDeLaNube {
    /// Ha llegado `main_status`, lo último del saludo.
    saludo_cerrado: bool,
    /// Lo que hay en la cola del DO según su último aviso (`cola` en `main_status` y
    /// `main_volcando`). `None`: el DO no lo dice (un worker anterior), y no se espera por ella.
    en_cola: Option<i64>,
}

impl ColaDeLaNube {
    fn anotar(&mut self, mensaje: &Value) {
        if let Some(n) = mensaje.get("cola").and_then(Value::as_i64) { self.en_cola = Some(n.max(0)); }
        if mensaje.get("type").and_then(Value::as_str) == Some("main_status") { self.saludo_cerrado = true; }
    }
    /// La Main acaba de dejar algo en la cola del DO: hasta que avise de que se ha vaciado, puede
    /// volver apartado.
    fn encolado(&mut self) {
        if let Some(n) = self.en_cola { self.en_cola = Some(n.max(1)); }
    }
    fn nada_por_llegar(&self) -> bool {
        self.saludo_cerrado && self.en_cola.unwrap_or(0) == 0
    }
}

/// Una sesión del motor: su bajada (AUD-18) y lo que se sabe de la cola de la nube (AUD-15).
#[derive(Debug, Default)]
pub struct Sesion {
    bajada: Bajada,
    cola: ColaDeLaNube,
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
    let op_id = m.get("opId").or_else(|| m.get("op_id")).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| AppError::external("Cambio sin operación"))?.to_string();
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
        let respuesta = nube.tpv_server_post_json("tpv", "/v1/sync/changes", json!({"since":since})).await?;
        match respuesta.get("highWater").or_else(|| respuesta.get("high_water")).and_then(Value::as_i64) {
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
            Some(m) => atender(ctx, canal, sesion, m).await?,
        }
    }
}

pub fn operacion(entry: &OutboxEntry) -> Value {
    json!({"opId":entry.op_id,"commandName":entry.command_name,"command":{"type":"tenantDb.transaction","payload":{"steps":entry.statements.iter().map(|s| json!({"kind":"execute","sql":s.sql,"args":s.args})).collect::<Vec<_>>()}}})
}

/// Los fallos de red nunca consumen intentos; sólo cuenta un rechazo recibido de la nube.
pub fn rechazo_contabilizable(ack: &Value) -> bool {
    ack.get("ok") == Some(&Value::Bool(false)) && ack.get("transitorio") != Some(&Value::Bool(true))
}

async fn atender(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, sesion: &mut Sesion, mensaje: Value) -> AppResult<()> {
    match mensaje.get("type").and_then(Value::as_str) {
        Some("change") => {
            // AUD-18: con la bajada detenida no se aplica nada posterior; lo trae el catch-up.
            if sesion.bajada.detenida() { return Ok(()); }
            if let Some(d) = aplicar(ctx, vec![cambio(mensaje)?]).await?.detenida { sesion.bajada.detener(&d); }
        }
        Some("main_status" | "main_volcando") => sesion.cola.anotar(&mensaje),
        Some("pair_request") => ctx.solicitud_emparejamiento(),
        Some("reservas_web") => ctx.reservas_web(),
        Some("cola_apartada") => {
            let ops = mensaje.get("ops").and_then(Value::as_array).ok_or_else(|| AppError::external("Cola apartada inválida"))?;
            let mut acusadas = Vec::new();
            for op in ops {
                let id = op.get("opId").or_else(|| op.get("op_id")).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| AppError::external("Operación apartada sin identidad"))?;
                // No guardar SQL ni datos de entrada en el diagnóstico (OBS-02).
                let fallo = ctx.repositorio().await?.outbox_mark_failed(id, "Operación apartada por la nube", true).await?;
                ctx.fallo_subida(id, &fallo);
                acusadas.push(id);
            }
            canal.enviar(json!({"type":"cola_apartada_ack","opIds":acusadas})).await?;
        }
        _ => {}
    }
    Ok(())
}

async fn esperar_ack(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, sesion: &mut Sesion, tipo: &str, op_id: Option<&str>, espera: Duration) -> AppResult<Value> {
    let fin = Instant::now() + espera;
    while Instant::now() < fin {
        let restante = fin.saturating_duration_since(Instant::now());
        if let Some(m) = canal.recibir(restante).await? {
            if m.get("type").and_then(Value::as_str) == Some(tipo) && op_id.is_none_or(|id| m.get("opId").or_else(|| m.get("op_id")).and_then(Value::as_str) == Some(id)) { return Ok(m); }
            atender(ctx, canal, sesion, m).await?;
        }
    }
    Err(AppError::external("No llegó la confirmación de la nube"))
}

pub async fn subir_pendientes(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, sesion: &mut Sesion, volcado: bool, estricto: bool) -> AppResult<bool> {
    // Finito para no dejar al receptor sin turno ante una importación continua.
    for _ in 0..10000 {
        let pendientes = ctx.repositorio().await?.outbox_pending(if volcado {200} else {50}).await?;
        if pendientes.is_empty() { return Ok(true); }
        if volcado {
            let mut bytes = 0;
            let mut trozo = Vec::new();
            for entry in pendientes {
                bytes += serde_json::to_vec(&entry.statements).map_err(|_| AppError::external("Outbox inválido"))?.len();
                trozo.push(entry);
                if bytes >= 256 * 1024 { break; }
            }
            canal.enviar(json!({"type":"bulk_apply","ops":trozo.iter().map(operacion).collect::<Vec<_>>()})).await?;
            let ack = esperar_ack(ctx, canal, sesion, "bulk_ack", None, Duration::from_secs(30)).await?;
            if ack.get("ok") != Some(&Value::Bool(true)) { return Err(AppError::external("La nube no aceptó el volcado")); }
            let ids = trozo.iter().map(|e| e.op_id.clone()).collect::<Vec<_>>();
            ctx.repositorio().await?.outbox_mark_encolada(&ids).await?;
            sesion.cola.encolado();
        } else {
            for entry in pendientes {
                let mut msg = operacion(&entry);
                msg["type"] = json!("apply");
                canal.enviar(msg).await?;
                let ack = esperar_ack(ctx, canal, sesion, "apply_ack", Some(&entry.op_id), Duration::from_secs(10)).await?;
                if ack.get("ok") != Some(&Value::Bool(true)) {
                    if estricto { return Err(AppError::external(format!("La nube rechazó la operación {}", entry.op_id))); }
                    if rechazo_contabilizable(&ack) {
                        let permanente = ack.get("permanente") == Some(&Value::Bool(true));
                        let fallo = ctx.repositorio().await?.outbox_mark_failed(&entry.op_id, "Rechazo de aplicación recibido de la nube", permanente).await?;
                        ctx.fallo_subida(&entry.op_id, &fallo);
                        if fallo.apartada { continue; }
                    }
                    return Ok(false);
                }
                if ack.get("encolada") == Some(&Value::Bool(true)) {
                    ctx.repositorio().await?.outbox_mark_encolada(&[entry.op_id]).await?;
                    sesion.cola.encolado();
                } else {
                    ctx.repositorio().await?.outbox_mark_sent(&entry.op_id, ack.get("seq").and_then(Value::as_i64).unwrap_or(0)).await?;
                }
            }
        }
    }
    Ok(false)
}

/// AUD-15 · El saludo de la Main, siempre con `recovering`: el DO congela a las Handy
/// (`main_volcando`) y deja pasar lo que suba la Main, y `ejecutar` las suelta con `recovery_ready`
/// cuando se ha puesto al día. Mirar antes si hay atraso no sirve: lo que se confirme entre mirarlo y
/// autenticarse subiría con las Handy ya sueltas.
///
/// En el DO, `recovering` sólo congela a las Handy; el modo recuperación de la Main (estricto, con
/// sus fases y `completar_recuperacion`) sigue siendo `recuperando`, que no tiene que ver con esto.
pub async fn saludar<F>(canal: &mut dyn CanalReplicacion, firmar: F) -> AppResult<()>
where F: FnMut(&str) -> AppResult<FirmaDispositivo> + Send {
    crate::use_cases::saludo_socket::saludar(canal, firmar, "tpv", true).await
}

pub async fn ejecutar(ctx: &dyn ContextoReplicacion, nube: &dyn PairingService, canal: &mut dyn CanalReplicacion, recuperando: bool) -> AppResult<FinDeSesion> {
    ctx.repositorio().await?.liberar_encoladas_caducadas(if recuperando {0} else {TTL_ENCOLADA}).await?;
    ctx.fase_recuperacion(if recuperando {"descargando"} else {"inactiva"});
    let mut sesion = Sesion::default();
    if ponerse_al_dia(ctx, nube, canal, &mut sesion, recuperando).await?.anterior_al_log { return Ok(FinDeSesion::AnteriorAlLog); }
    let volcado = !recuperando && ctx.volcado_permitido() && ctx.repositorio().await?.outbox_pending(101).await?.len() > 100;
    let mut vacio = true;
    if recuperando {
        ctx.fase_recuperacion("subiendo");
        subir_pendientes(ctx, canal, &mut sesion, false, true).await?;
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
            if let Some(m) = canal.recibir(Duration::from_secs(1)).await? { atender(ctx, canal, &mut sesion, m).await?; }
            ctx.fase_recuperacion("subiendo");
            subir_pendientes(ctx, canal, &mut sesion, false, true).await?;
        }
        if !completada { return Err(AppError::external("La nube no confirmó la convergencia")); }
    } else {
        vacio = subir_pendientes(ctx, canal, &mut sesion, volcado, false).await?;
        // Al conectar, lo que se haya reservado en la web mientras esta Main no estaba.
        ctx.reservas_web();
    }
    // AUD-15: las Handy que congeló el saludo se sueltan una vez por sesión, cuando no queda nada
    // que deba llegar antes a la nube: el saludo cerrado (lo apartado para esta Main ya ha
    // llegado), la cola del DO vacía (lo que apartó al drenarla, también) y `subir_pendientes`
    // encuentra el outbox vacío, reparaciones de lo apartado incluidas. Una reparación que la nube
    // tampoco acepta queda en cuarentena, fuera de lo pendiente, y no las retiene: su rastro es el
    // de cualquier apartada. Esa última subida es la frontera: lo que se confirme aquí después es
    // trabajo en vivo, como con la sesión ya abierta. En la recuperación las suelta su desbloqueo.
    let mut handy_por_soltar = !recuperando;
    let mut ultimo_sondeo = Instant::now();
    loop {
        if handy_por_soltar && vacio && sesion.cola.nada_por_llegar() {
            vacio = subir_pendientes(ctx, canal, &mut sesion, false, false).await?;
            if vacio && sesion.cola.nada_por_llegar() {
                canal.enviar(json!({"type":"recovery_ready"})).await?;
                handy_por_soltar = false;
            }
            ultimo_sondeo = Instant::now();
        }
        if !ctx.sigue_disponible(false).await? { return Ok(FinDeSesion::NoDisponible); }
        // AUD-18: un cambio en vivo ha fallado. Se reintenta con su espera y la bajada se pone al
        // día por catch-up antes de volver a escuchar; después, una vuelta de subida.
        if sesion.bajada.detenida() {
            if ponerse_al_dia(ctx, nube, canal, &mut sesion, false).await?.anterior_al_log { return Ok(FinDeSesion::AnteriorAlLog); }
            vacio = subir_pendientes(ctx, canal, &mut sesion, false, false).await?;
            ultimo_sondeo = Instant::now();
            continue;
        }
        let msg = canal.recibir(Duration::from_secs(if vacio {30} else {3})).await?;
        let despertar = msg.as_ref().and_then(|m| m.get("type")).and_then(Value::as_str) == Some("despertar");
        if let Some(m) = msg { atender(ctx, canal, &mut sesion, m).await?; }
        if despertar || ultimo_sondeo.elapsed() >= Duration::from_secs(if vacio {30} else {3}) {
            vacio = subir_pendientes(ctx, canal, &mut sesion, false, false).await?;
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
    #[test]
    fn un_rechazo_transitorio_no_gasta_intentos() {
        assert!(!rechazo_contabilizable(&json!({"ok":false,"transitorio":true})));
        assert!(!rechazo_contabilizable(&json!({"ok":true})));
        assert!(rechazo_contabilizable(&json!({"ok":false,"permanente":true})));
        assert!(rechazo_contabilizable(&json!({"ok":false})));
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
