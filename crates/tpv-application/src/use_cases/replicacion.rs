//! Replicación nativa Main ↔ nube (RI-31/RI-57). Orden, confirmaciones y recuperación.
//! El canal sólo procede del transporte TLS autenticado. Ningún llamante de IPC aporta SQL/acks.
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use tpv_contracts::sync::{OutboxEntry, SyncChange};
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

/// Lo que deja un catch-up: el final del log que ha visto y, si se ha detenido, en qué cambio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PuestaAlDia {
    pub high_water: i64,
    pub detenida: Option<CambioDetenido>,
}

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

/// Una pasada de catch-up desde el checkpoint, en orden de `Seq`.
///
/// AUD-18: empieza por el cambio en el que se detuvo la bajada, con las sentencias que se
/// guardaron al fallar; mientras no entre (o pase a cuarentena) no se pide nada a la nube. Y dentro
/// de cada página rige la misma regla: si un cambio la detiene, la siguiente no se pide.
pub async fn catch_up(ctx: &dyn ContextoReplicacion, nube: &dyn PairingService, estricto: bool) -> AppResult<PuestaAlDia> {
    if let Some(detenido) = ctx.repositorio().await?.cambio_detenido().await? {
        let r = aplicar(ctx, vec![detenido]).await?;
        if r.detenida.is_some() { return Ok(PuestaAlDia { high_water: 0, detenida: r.detenida }); }
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
        let items = respuesta.get("items").and_then(Value::as_array).ok_or_else(|| AppError::external("Catch-up sin lista de cambios"))?;
        if items.is_empty() { return Ok(PuestaAlDia { high_water, detenida: None }); }
        let cambios = items.iter().cloned().map(cambio).collect::<AppResult<Vec<_>>>()?;
        if cambios.windows(2).any(|p| p[0].seq >= p[1].seq) { return Err(AppError::external("Catch-up desordenado")); }
        let r = aplicar(ctx, cambios).await?;
        if r.detenida.is_some() { return Ok(PuestaAlDia { high_water, detenida: r.detenida }); }
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
/// log. Termina siempre: cada cambio tiene cinco intentos. Devuelve el final del log visto.
async fn ponerse_al_dia(ctx: &dyn ContextoReplicacion, nube: &dyn PairingService, canal: &mut dyn CanalReplicacion, bajada: &mut Bajada, estricto: bool) -> AppResult<i64> {
    loop {
        if let Some(hasta) = bajada.detenida_hasta {
            esperar_atendiendo(ctx, canal, bajada, hasta).await?;
        }
        let r = catch_up(ctx, nube, estricto).await?;
        match r.detenida {
            None => {
                bajada.detenida_hasta = None;
                return Ok(r.high_water);
            }
            Some(d) => bajada.detener(&d),
        }
    }
}

/// AUD-18 · Atiende el socket hasta `hasta` con la bajada detenida: lo que no es un cambio se
/// atiende como siempre, y los cambios no se aplican.
async fn esperar_atendiendo(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, bajada: &mut Bajada, hasta: Instant) -> AppResult<()> {
    loop {
        let falta = hasta.saturating_duration_since(Instant::now());
        if falta.is_zero() { return Ok(()); }
        match canal.recibir(falta).await? {
            // `None` es que ha vencido la espera (`CanalNube::recibir`).
            None => return Ok(()),
            Some(m) => atender(ctx, canal, bajada, m).await?,
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

async fn atender(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, bajada: &mut Bajada, mensaje: Value) -> AppResult<()> {
    match mensaje.get("type").and_then(Value::as_str) {
        Some("change") => {
            // AUD-18: con la bajada detenida no se aplica nada posterior; lo trae el catch-up.
            if bajada.detenida() { return Ok(()); }
            if let Some(d) = aplicar(ctx, vec![cambio(mensaje)?]).await?.detenida { bajada.detener(&d); }
        }
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

async fn esperar_ack(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, bajada: &mut Bajada, tipo: &str, op_id: Option<&str>, espera: Duration) -> AppResult<Value> {
    let fin = Instant::now() + espera;
    while Instant::now() < fin {
        let restante = fin.saturating_duration_since(Instant::now());
        if let Some(m) = canal.recibir(restante).await? {
            if m.get("type").and_then(Value::as_str) == Some(tipo) && op_id.is_none_or(|id| m.get("opId").or_else(|| m.get("op_id")).and_then(Value::as_str) == Some(id)) { return Ok(m); }
            atender(ctx, canal, bajada, m).await?;
        }
    }
    Err(AppError::external("No llegó la confirmación de la nube"))
}

pub async fn subir_pendientes(ctx: &dyn ContextoReplicacion, canal: &mut dyn CanalReplicacion, bajada: &mut Bajada, volcado: bool, estricto: bool) -> AppResult<bool> {
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
            let ack = esperar_ack(ctx, canal, bajada, "bulk_ack", None, Duration::from_secs(30)).await?;
            if ack.get("ok") != Some(&Value::Bool(true)) { return Err(AppError::external("La nube no aceptó el volcado")); }
            let ids = trozo.iter().map(|e| e.op_id.clone()).collect::<Vec<_>>();
            ctx.repositorio().await?.outbox_mark_encolada(&ids).await?;
        } else {
            for entry in pendientes {
                let mut msg = operacion(&entry);
                msg["type"] = json!("apply");
                canal.enviar(msg).await?;
                let ack = esperar_ack(ctx, canal, bajada, "apply_ack", Some(&entry.op_id), Duration::from_secs(10)).await?;
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
                } else {
                    ctx.repositorio().await?.outbox_mark_sent(&entry.op_id, ack.get("seq").and_then(Value::as_i64).unwrap_or(0)).await?;
                }
            }
        }
    }
    Ok(false)
}

pub async fn ejecutar(ctx: &dyn ContextoReplicacion, nube: &dyn PairingService, canal: &mut dyn CanalReplicacion, recuperando: bool) -> AppResult<()> {
    ctx.repositorio().await?.liberar_encoladas_caducadas(if recuperando {0} else {TTL_ENCOLADA}).await?;
    ctx.fase_recuperacion(if recuperando {"descargando"} else {"inactiva"});
    let mut bajada = Bajada::default();
    ponerse_al_dia(ctx, nube, canal, &mut bajada, recuperando).await?;
    let volcado = !recuperando && ctx.volcado_permitido() && ctx.repositorio().await?.outbox_pending(101).await?.len() > 100;
    let mut vacio = true;
    if recuperando {
        ctx.fase_recuperacion("subiendo");
        subir_pendientes(ctx, canal, &mut bajada, false, true).await?;
        let mut completada = false;
        for _ in 0..180 {
            ctx.fase_recuperacion("verificando");
            let high_water = ponerse_al_dia(ctx, nube, canal, &mut bajada, true).await?;
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
            if let Some(m) = canal.recibir(Duration::from_secs(1)).await? { atender(ctx, canal, &mut bajada, m).await?; }
            ctx.fase_recuperacion("subiendo");
            subir_pendientes(ctx, canal, &mut bajada, false, true).await?;
        }
        if !completada { return Err(AppError::external("La nube no confirmó la convergencia")); }
    } else {
        vacio = subir_pendientes(ctx, canal, &mut bajada, volcado, false).await?;
        // Al conectar, lo que se haya reservado en la web mientras esta Main no estaba.
        ctx.reservas_web();
    }
    let mut ultimo_sondeo = Instant::now();
    loop {
        if !ctx.sigue_disponible(false).await? { return Ok(()); }
        // AUD-18: un cambio en vivo ha fallado. Se reintenta con su espera y la bajada se pone al
        // día por catch-up antes de volver a escuchar; después, una vuelta de subida.
        if bajada.detenida() {
            ponerse_al_dia(ctx, nube, canal, &mut bajada, false).await?;
            vacio = subir_pendientes(ctx, canal, &mut bajada, false, false).await?;
            ultimo_sondeo = Instant::now();
            continue;
        }
        let msg = canal.recibir(Duration::from_secs(if vacio {30} else {3})).await?;
        let despertar = msg.as_ref().and_then(|m| m.get("type")).and_then(Value::as_str) == Some("despertar");
        if let Some(m) = msg { atender(ctx, canal, &mut bajada, m).await?; }
        if despertar || ultimo_sondeo.elapsed() >= Duration::from_secs(if vacio {30} else {3}) {
            vacio = subir_pendientes(ctx, canal, &mut bajada, false, false).await?;
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
