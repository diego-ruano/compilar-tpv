//! Casos de uso de **licensing**.
//!
//! El gate se orquesta aquí: se trae el estado verificado del servidor por el puerto, se le pide
//! el veredicto al dominio y se aplica la acción sobre `license_state.json`. Ni una decisión de
//! negocio en el adaptador, ni una línea de HTTP/cripto en el dominio.

use tpv_contracts::licensing::{
    LicenseActivateInput, LicenseActivateOutcome, LicenseDeviceChangeInput, LicenseGateResult,
    LicenseLocalState,
};
use tpv_domain::licensing::{
    self as dom, Concesion, EstadoLicencia, EstadoVerificado, Motivo, Resolucion,
    ResultadoActivacion, SolicitudActivacion, Veredicto,
};
use chrono::{Local, TimeZone};
use std::sync::{Mutex, MutexGuard};
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::LicensingService;
use crate::ports::notificaciones::Notifier;

const HORA_MS: i64 = 60 * 60 * 1000;

/// LIC-08 · Cuántas veces se ha reescrito a mano la licencia de este equipo (borrarla, activarla,
/// sumarle una clave), con el cerrojo bajo el que se escribe su estado.
///
/// Una comprobación lee el estado, espera a la nube y guarda lo que contesta. Si mientras esperaba
/// se pulsaba «Borrar y volver a activar», lo que guardaba al volver era la licencia anulada que se
/// acababa de borrar, y su token: la pantalla volvía a «Licencia anulada». Ahora la comprobación
/// apunta este número al leer y sólo guarda si no ha cambiado; si cambió, vuelve a comprobar la
/// licencia que haya entonces.
static REESCRITURAS: Mutex<u64> = Mutex::new(0);

fn cerrojo() -> MutexGuard<'static, u64> {
    REESCRITURAS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Reescribe la licencia a mano: lo que se estuviera comprobando desde antes ya no se guarda.
fn reescribir<T>(f: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    let mut n = cerrojo();
    *n += 1;
    f()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

pub fn get_state(svc: &dyn LicensingService) -> AppResult<Option<LicenseLocalState>> {
    svc.load_state()
}

/// «Borrar y volver a activar», desde la pantalla de bloqueo. Es el ÚNICO camino por el que se borra
/// la licencia local: el gate ya no lo hace nunca por su cuenta (RI-09).
///
/// Si el servidor la había dado por anulada o trasladada (estado firmado que guardó el gate), el
/// motivo se anota: la pantalla de activación lo explica, y lo que dice —que la misma clave vuelve a
/// activar sin perder nada si se deshace— es justo lo que nadie adivina delante de un formulario vacío.
pub fn clear_state(svc: &dyn LicensingService) -> AppResult<()> {
    reescribir(|| {
        let motivo = svc
            .load_state()?
            .and_then(|s| s.status)
            .and_then(|s| EstadoLicencia::from_code(&s))
            .filter(|e| matches!(e, EstadoLicencia::Revoked | EstadoLicencia::DeviceReplaced))
            .map(|e| e.codigo());
        svc.delete_state(motivo)
    })
}

/// Activa la licencia en este dispositivo. Si el servidor exige el código de cambio de equipo,
/// no falla: devuelve `outcome = "device_change_required"` para que la UI pida el OTP.
pub async fn activate(
    svc: &dyn LicensingService,
    input: LicenseActivateInput,
) -> AppResult<LicenseActivateOutcome> {
    let solicitud = SolicitudActivacion::validar(
        input.activation_key,
        input.business_name,
        input.legal_name,
        input.phone,
        input.country,
    )
    .map_err(AppError::validation)?;

    let code = clean(input.device_change_code);

    match svc.activar_remoto(&solicitud, code.as_deref()).await? {
        ResultadoActivacion::Activada(concedido) => {
            let cambio_de_equipo = concedido.cambio_de_equipo;
            let tiempo_sumado = concedido.tiempo_sumado;
            let estado = estado_inicial(concedido);
            reescribir(|| svc.save_state(&estado))?;
            Ok(LicenseActivateOutcome {
                outcome: "activated".to_string(),
                state: Some(estado),
                email_hint: None,
                cambio_de_equipo,
                tiempo_sumado,
            })
        }
        ResultadoActivacion::CambioDispositivoRequerido { email_hint } => {
            Ok(LicenseActivateOutcome {
                outcome: "device_change_required".to_string(),
                state: None,
                email_hint: Some(email_hint),
                cambio_de_equipo: false,
                tiempo_sumado: false,
            })
        }
    }
}

/// RI-52: suma el tiempo de otra clave a la licencia de este equipo, que ya está en marcha. Es el
/// canje de REV-13 desde Configuración: quien compra varias licencias y quiere todo el tiempo en
/// un local las va tecleando aquí.
///
/// La petición lleva `solo_sumar`, y con ella el servidor rechaza todo lo que no sea sumar (la
/// clave de otro local ya activada, o este equipo sin licencia viva) sin tocar nada. Si aun así no
/// volviera `tiempo_sumado`, es un error: nunca se da por bueno otro resultado.
pub async fn sumar_clave(svc: &dyn LicensingService, clave: String) -> AppResult<LicenseActivateOutcome> {
    let solicitud = SolicitudActivacion::para_sumar(clave).map_err(AppError::validation)?;

    match svc.activar_remoto(&solicitud, None).await? {
        ResultadoActivacion::Activada(concedido) if concedido.tiempo_sumado => {
            let estado = estado_inicial(concedido);
            reescribir(|| svc.save_state(&estado))?;
            Ok(LicenseActivateOutcome {
                outcome: "activated".to_string(),
                state: Some(estado),
                email_hint: None,
                cambio_de_equipo: false,
                tiempo_sumado: true,
            })
        }
        _ => Err(AppError::conflict("Esa clave no se ha podido añadir a este equipo.")),
    }
}

/// Pide al servidor que mande el OTP de cambio de dispositivo al email de la licencia.
pub async fn request_device_change(
    svc: &dyn LicensingService,
    input: LicenseDeviceChangeInput,
) -> AppResult<()> {
    let clave = input.activation_key.trim();
    if clave.is_empty() {
        return Err(AppError::validation("Escribe la clave de activación."));
    }
    svc.solicitar_cambio_dispositivo(clave).await
}

/// Gate de arranque / periódico: se apoya en la gracia offline si no hay red. Además, avisa a los
/// administradores cuando la licencia está por caducar, caducada-en-gracia, o corriendo sin conexión.
pub async fn gate(
    svc: &dyn LicensingService,
    notifier: Option<&dyn Notifier>,
) -> AppResult<LicenseGateResult> {
    let res = comprobar(svc, false).await?;
    if let Some(notifier) = notifier {
        avisar_estado_licencia(notifier, &res, now_ms(), &Local).await;
    }
    Ok(res)
}

/// Comprobación pedida por el usuario ("Reintentar"): no enmascara los fallos del servidor con la
/// gracia offline. No emite avisos (es una acción manual, no el pulso periódico).
pub async fn check_now(svc: &dyn LicensingService) -> AppResult<LicenseGateResult> {
    comprobar(svc, true).await
}

/// Claves de los avisos de licencia, una por concepto (RI-12). Antes llevaban el día o una franja
/// de 4 h (`licencia_warn:{día}`, `gracia_offline:{franja}`): cada franja abría un aviso nuevo sin
/// cerrar el anterior, hasta 18 de «sin conexión» en las 72 h de gracia, y nadie los resolvía.
/// Ahora hay uno por concepto, que se actualiza al volver a emitirlo y se resuelve cuando deja de
/// aplicar. Lo que cuenta hacia atrás (los días hasta caducar, las horas de gracia) va en el TÍTULO:
/// es lo que hace que vuelva a salir como no leído en cada pulso, el recordatorio que antes daba
/// abrir uno nuevo cada día o cada franja.
const CLAVE_POR_CADUCAR: &str = "licencia_warn";
const CLAVE_CADUCADA: &str = "licencia_gracia";
const CLAVE_GRACIA_OFFLINE: &str = "gracia_offline";
const CLAVE_RELOJ: &str = "reloj_desfasado";
const CLAVE_RECHAZO: &str = "rechazo_sin_verificar";

/// Qué aviso corresponde a cada motivo del gate.
const AVISOS: [(&str, &str); 5] = [
    ("warn", CLAVE_POR_CADUCAR),
    ("expiry_grace", CLAVE_CADUCADA),
    ("offline_grace", CLAVE_GRACIA_OFFLINE),
    ("clock_skew_detected", CLAVE_RELOJ),
    ("rejection_unverified", CLAVE_RECHAZO),
];

/// Emite (best-effort) avisos a los administradores según el veredicto del gate, y cierra los que
/// ya no aplican. El estado real (permitir/bloquear) NO se toca aquí.
///
/// Sólo se cierra lo demás cuando el servidor ha contestado (`ok`, `warn`, `expiry_grace`): sin
/// conexión o con el reloj rechazado no se sabe cómo está la licencia, y en la Handy cada cierre
/// sería una llamada más a una nube que no responde.
///
/// `zona` es la del equipo (`Local`): «hoy» y «mañana» son fechas de quien lee el aviso.
async fn avisar_estado_licencia<Tz: TimeZone + Sync>(
    notifier: &dyn Notifier,
    res: &LicenseGateResult,
    ahora_ms: i64,
    zona: &Tz,
) {
    let Some(state) = res.state.as_ref() else {
        return;
    };

    let motivo = res.reason.as_str();
    if matches!(motivo, "ok" | "warn" | "expiry_grace") {
        for (otro, clave) in AVISOS {
            if otro != motivo {
                let _ = notifier.resolver_por_clave(clave).await;
            }
        }
    }

    match motivo {
        // Licencia por caducar (estado firmado `warn` del servidor).
        "warn" => {
            let cuando = match state
                .expires_at_ms
                .and_then(|e| dias_naturales_hasta(zona, e, ahora_ms))
            {
                Some(d) if d <= 0 => "hoy".to_string(),
                Some(1) => "mañana".to_string(),
                Some(d) => format!("en {d} días"),
                None => "pronto".to_string(),
            };
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "licencia_por_expirar".to_string(),
                    severidad: Severidad::Aviso,
                    titulo: format!("Tu licencia caduca {cuando}"),
                    cuerpo: Some("Renuévala para evitar el bloqueo.".to_string()),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: Some("ver_licencia".to_string()),
                    payload: None,
                    clave_dedupe: Some(CLAVE_POR_CADUCAR.to_string()),
                    expira_en: None,
                })
                .await;
        }
        // Caducada, pero el servidor todavía la deja funcionar (estado firmado `expiry_grace`). Ese
        // margen es un por si acaso, no un plazo con el que contar: el aviso no dice cuánto queda.
        "expiry_grace" => {
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "licencia_caducada".to_string(),
                    severidad: Severidad::Error,
                    titulo: "Licencia caducada".to_string(),
                    cuerpo: Some(
                        "Tu licencia ha caducado. Renuévala cuanto antes: la aplicación puede bloquearse en cualquier momento."
                            .to_string(),
                    ),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: Some("ver_licencia".to_string()),
                    payload: None,
                    clave_dedupe: Some(CLAVE_CADUCADA.to_string()),
                    expira_en: None,
                })
                .await;
        }
        // Sin conexión con el servidor: corriendo con la gracia offline (72 h). Las horas que
        // quedan van en el título y cambian en cada pulso: cada uno lo vuelve a poner como no leído.
        "offline_grace" => {
            let horas = horas_de_gracia(state, ahora_ms);
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "gracia_offline".to_string(),
                    severidad: Severidad::Aviso,
                    titulo: format!("Sin conexión con licencias: quedan ~{horas} h"),
                    cuerpo: Some(
                        "No se ha podido verificar la licencia. Cuando se acabe ese tiempo sin conexión, la aplicación se bloqueará."
                            .to_string(),
                    ),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: None,
                    payload: None,
                    clave_dedupe: Some(CLAVE_GRACIA_OFFLINE.to_string()),
                    expira_en: None,
                })
                .await;
        }
        // REV-10: el reloj, que es lo único de esta lista que puede arreglar quien está delante.
        // Va aparte de `offline_grace` a propósito: decirle «no hay conexión» a alguien cuyo
        // problema es la hora le manda a mirar el router.
        "clock_skew_detected" => {
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "reloj_desfasado".to_string(),
                    severidad: Severidad::Aviso,
                    titulo: "La hora de este equipo no es correcta".to_string(),
                    cuerpo: Some(
                        "El servidor de licencias rechaza las peticiones de este equipo porque su fecha y hora van desfasadas más de 2 minutos. Ajústalas (mejor con hora automática) o dejará de funcionar."
                            .to_string(),
                    ),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: None,
                    payload: None,
                    clave_dedupe: Some(CLAVE_RELOJ.to_string()),
                    expira_en: None,
                })
                .await;
        }
        // RI-09: el servidor ha dicho que no, sin firmar. Se sigue trabajando con la gracia offline
        // porque no se puede comprobar que lo diga él —y lo esperable es un fallo nuestro—, pero
        // quien lleva el negocio tiene que saberlo HOY: es una llamada a soporte, no a su router.
        "rejection_unverified" => {
            let horas = horas_de_gracia(state, ahora_ms);
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "rechazo_sin_verificar".to_string(),
                    severidad: Severidad::Error,
                    titulo: format!("El servidor de licencias no reconoce este equipo: quedan ~{horas} h"),
                    cuerpo: Some(
                        "La respuesta no se ha podido verificar, así que de momento sigues trabajando. Contacta con soporte: si no se resuelve antes de que se acabe ese tiempo, la aplicación se bloqueará."
                            .to_string(),
                    ),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: None,
                    payload: None,
                    clave_dedupe: Some(CLAVE_RECHAZO.to_string()),
                    expira_en: None,
                })
                .await;
        }
        _ => {}
    }
}

/// Días de CALENDARIO entre hoy y la fecha de `fecha_ms` en `zona`: 0 es hoy, negativo ya pasó.
///
/// No es la diferencia en milisegundos redondeada hacia arriba. Con esa cuenta, una licencia que
/// caducaba a las 23:00 decía a las 08:00 que caducaba «mañana»: quince horas redondeadas son un
/// día. «Hoy» y «mañana» son fechas, no horas que faltan. Gemela de `diasNaturalesHasta` en el
/// frontend (`shared/lib/diasNaturales.ts`), que pinta el mismo aviso en el banner.
fn dias_naturales_hasta<Tz: TimeZone>(zona: &Tz, fecha_ms: i64, ahora_ms: i64) -> Option<i64> {
    let fecha = zona.timestamp_millis_opt(fecha_ms).single()?.date_naive();
    let hoy = zona.timestamp_millis_opt(ahora_ms).single()?.date_naive();
    Some((fecha - hoy).num_days())
}

/// Las horas de gracia offline que quedan, con lo contado por RI-36: el aviso no puede prometer más
/// tiempo del que el gate va a dar.
fn horas_de_gracia(state: &LicenseLocalState, ahora_ms: i64) -> i64 {
    let base = dom::base_gracia(state.last_check_ok_ms, state.activated_at_ms);
    let gastado = dom::gracia_gastada(base, ahora_ms, state.offline_consumido_ms.unwrap_or(0));
    horas_ceil((dom::GRACIA_OFFLINE_MS - gastado).max(0))
}

fn horas_ceil(ms: i64) -> i64 {
    if ms <= 0 {
        0
    } else {
        (ms + HORA_MS - 1) / HORA_MS
    }
}

/// LIC-08: si la licencia se reescribe mientras se espera a la nube, se comprueba la que haya
/// entonces. Que vuelva a pasar en cada vuelta ya no es casualidad, y se deja de insistir.
async fn comprobar(svc: &dyn LicensingService, forzar_red: bool) -> AppResult<LicenseGateResult> {
    for _ in 0..3 {
        if let Some(res) = comprobar_una_vez(svc, forzar_red).await? {
            return Ok(res);
        }
    }
    Err(AppError::conflict(
        "La licencia ha cambiado mientras se comprobaba. Vuelve a intentarlo.",
    ))
}

/// `None` si la licencia se reescribió a mano mientras se consultaba (LIC-08).
async fn comprobar_una_vez(
    svc: &dyn LicensingService,
    forzar_red: bool,
) -> AppResult<Option<LicenseGateResult>> {
    let (leida, guardado) = {
        let n = cerrojo();
        (*n, svc.load_state()?)
    };
    let Some(mut estado) = guardado else {
        return Ok(Some(LicenseGateResult {
            allowed: false,
            reason: Motivo::NecesitaActivacion.codigo(),
            state: None,
            // Puede que este equipo no sea nuevo, sino uno al que le anularon la licencia: la
            // pantalla de activación necesita saberlo para poder decirlo.
            last_rejection: svc.last_rejection()?,
        }));
    };

    let ahora = now_ms();
    estado.last_check_attempt_ms = Some(ahora);
    contar_tiempo(svc, &mut estado, ahora);

    match svc.consultar_estado(&estado).await {
        Ok(consultado) => aplicar(
            svc,
            leida,
            actualizar(estado, &consultado.verificado, ahora),
            consultado.token.as_deref(),
            dom::evaluar_estado(consultado.verificado.assertion.estado),
        ),

        Err(fallo) => {
            let base = dom::base_gracia(estado.last_check_ok_ms, estado.activated_at_ms);
            let consumido = estado.offline_consumido_ms.unwrap_or(0);
            match dom::evaluar_fallo(&fallo, base, ahora, consumido, forzar_red) {
                Resolucion::Decidido(veredicto) => aplicar(svc, leida, estado, None, veredicto),
                Resolucion::Indecidible => Err(AppError::external(fallo.to_string())),
            }
        }
    }
}

/// Vuelca en el estado local lo que dijo el servidor (es la autoridad): estado, caducidad, plan,
/// y el token renovado si lo hubo.
fn actualizar(
    mut estado: LicenseLocalState,
    verificado: &EstadoVerificado,
    ahora: i64,
) -> LicenseLocalState {
    let a = &verificado.assertion;
    estado.status = Some(a.estado.codigo().to_string());
    estado.expires_at_ms = a.expires_at_ms;
    estado.plan = Some(a.plan.clone());
    estado.last_server_time_ms = Some(verificado.server_time_ms);
    estado.last_check_ok_ms = Some(ahora);
    // RI-36: con la licencia comprobada, la gracia offline vuelve a empezar.
    estado.offline_consumido_ms = Some(0);
    estado.marca_tiempo_ms = Some(ahora);
    // El token renovado no va en el estado: lo guarda `aplicar` en el keyring.
    estado
}

/// RI-36 · Suma al estado el tiempo pasado desde la última vez que se contó, con el reloj monótono
/// del proceso cuando lo hay (`dom::sumar_tiempo_sin_conexion`). Lo llaman cada comprobación y el
/// pulso `licencia_reloj`, que es lo que hace que lo contado no dependa de que haya red.
fn contar_tiempo(svc: &dyn LicensingService, estado: &mut LicenseLocalState, ahora: i64) {
    let monotono = svc.transcurrido_monotono();
    let pared = estado.marca_tiempo_ms.map_or(0, |m| ahora - m);
    estado.offline_consumido_ms = Some(dom::sumar_tiempo_sin_conexion(
        estado.offline_consumido_ms.unwrap_or(0),
        monotono,
        pared,
    ));
    estado.marca_tiempo_ms = Some(ahora);
}

/// RI-36 · El pulso del reloj de la gracia offline: cuenta el tiempo y lo guarda, sin red. Va cada
/// pocos minutos (job `licencia_reloj`) para que lo que se pueda esconder cerrando la app y atrasando
/// el reloj sean minutos, no las 6 h que separan dos comprobaciones.
pub fn contar_tiempo_sin_conexion(svc: &dyn LicensingService) -> AppResult<()> {
    // LIC-08: leer y guardar con el cerrojo cogido, o lo leído se escribiría encima de un borrado.
    let _cerrojo = cerrojo();
    let Some(mut estado) = svc.load_state()? else {
        return Ok(());
    };
    contar_tiempo(svc, &mut estado, now_ms());
    svc.save_state(&estado)
}

/// Guarda el estado y el token que trajo la consulta, y compone la respuesta para la UI. Nunca
/// borra (RI-09, ver `Veredicto`).
///
/// LIC-08: si la licencia se ha reescrito a mano desde que se leyó (`leida`), no guarda nada y
/// devuelve `None`: lo comprobado ya no es la licencia que hay.
fn aplicar(
    svc: &dyn LicensingService,
    leida: u64,
    estado: LicenseLocalState,
    token: Option<&str>,
    veredicto: Veredicto,
) -> AppResult<Option<LicenseGateResult>> {
    let n = cerrojo();
    if *n != leida {
        return Ok(None);
    }
    // El token primero: es la credencial de la siguiente petición, y guardarlo no depende de que
    // se pueda escribir el fichero.
    if let Some(token) = token {
        svc.guardar_token(token);
    }
    svc.save_state(&estado)?;
    drop(n);
    Ok(Some(LicenseGateResult {
        allowed: veredicto.permitido,
        reason: veredicto.motivo.codigo(),
        last_rejection: None,
        state: Some(estado),
    }))
}

fn estado_inicial(concedido: Concesion) -> LicenseLocalState {
    LicenseLocalState {
        tenant_id: concedido.tenant_id,
        device_id: concedido.device_id,
        status: Some(concedido.status),
        expires_at: concedido.expires_at,
        expires_at_ms: concedido.expires_at_ms,
        plan: concedido.plan,
        last_server_time_ms: None,
        last_check_ok_ms: None,
        last_check_attempt_ms: None,
        activated_at_ms: now_ms(),
        offline_consumido_ms: Some(0),
        marca_tiempo_ms: Some(now_ms()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::licensing::EstadoConsultado;
    use async_trait::async_trait;

    const DAY_MS: i64 = 24 * 60 * 60 * 1000;

    #[derive(Default)]
    struct FakeNotifier {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
        resueltas: Mutex<Vec<String>>,
    }
    #[async_trait]
    impl Notifier for FakeNotifier {
        async fn emitir(&self, n: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(n);
            Ok("n".into())
        }
        async fn resolver_por_clave(&self, clave: &str) -> AppResult<bool> {
            self.resueltas.lock().unwrap().push(clave.to_string());
            Ok(false)
        }
    }

    fn state_con_expiry(expires_at_ms: Option<i64>) -> LicenseLocalState {
        LicenseLocalState {
            tenant_id: "t1".into(),
            device_id: "d1".into(),
            status: None,
            expires_at: None,
            expires_at_ms,
            plan: None,
            last_server_time_ms: None,
            last_check_ok_ms: None,
            last_check_attempt_ms: None,
            activated_at_ms: 0,
            offline_consumido_ms: None,
            marca_tiempo_ms: None,
        }
    }

    fn result(reason: &str, state: LicenseLocalState) -> LicenseGateResult {
        LicenseGateResult {
            allowed: true,
            reason: reason.into(),
            state: Some(state),
            last_rejection: None,
        }
    }

    #[tokio::test]
    async fn avisa_segun_el_motivo_del_gate() {
        let ahora = 1_000 * DAY_MS;
        let zona = chrono::Utc;
        let n = FakeNotifier::default();

        avisar_estado_licencia(&n, &result("warn", state_con_expiry(Some(ahora + 3 * DAY_MS))), ahora, &zona).await;
        avisar_estado_licencia(&n, &result("expiry_grace", state_con_expiry(Some(ahora - DAY_MS))), ahora, &zona).await;

        let mut s = state_con_expiry(None);
        s.last_check_ok_ms = Some(ahora - HORA_MS);
        s.activated_at_ms = ahora - HORA_MS;
        avisar_estado_licencia(&n, &result("offline_grace", s), ahora, &zona).await;

        // Estado sano: no emite.
        avisar_estado_licencia(&n, &result("ok", state_con_expiry(None)), ahora, &zona).await;

        let e = n.emitidas.lock().unwrap();
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].tipo, "licencia_por_expirar");
        assert_eq!(e[0].clave_dedupe.as_deref(), Some("licencia_warn"));
        assert_eq!(e[1].tipo, "licencia_caducada");
        assert_eq!(e[1].clave_dedupe.as_deref(), Some("licencia_gracia"));
        assert_eq!(e[2].tipo, "gracia_offline");
        assert_eq!(e[2].clave_dedupe.as_deref(), Some("gracia_offline"));
        assert!(e.iter().all(|n| n.destino == Destino::Rol(ADMIN_ROL_ID.to_string())));
    }

    /// RI-12: una clave por concepto, que no cambia con el día ni con la franja: si cambiara, cada
    /// pulso abriría un aviso nuevo en vez de actualizar el que hay.
    #[tokio::test]
    async fn la_clave_no_cambia_con_el_tiempo() {
        let zona = chrono::Utc;
        let n = FakeNotifier::default();
        for ahora in [1_000 * DAY_MS, 1_000 * DAY_MS + 5 * HORA_MS, 1_002 * DAY_MS] {
            let mut s = state_con_expiry(None);
            s.last_check_ok_ms = Some(1_000 * DAY_MS);
            s.activated_at_ms = 1_000 * DAY_MS;
            avisar_estado_licencia(&n, &result("offline_grace", s), ahora, &zona).await;
        }
        let e = n.emitidas.lock().unwrap();
        assert!(e.iter().all(|n| n.clave_dedupe.as_deref() == Some("gracia_offline")));
    }

    /// RI-12: cuando el servidor contesta, se cierran los avisos que ya no aplican. Sin conexión no
    /// se sabe cómo está la licencia, así que no se cierra nada.
    #[tokio::test]
    async fn cierra_los_avisos_que_ya_no_aplican() {
        let ahora = 1_000 * DAY_MS;
        let zona = chrono::Utc;

        let n = FakeNotifier::default();
        avisar_estado_licencia(&n, &result("ok", state_con_expiry(None)), ahora, &zona).await;
        let mut r = n.resueltas.lock().unwrap().clone();
        r.sort();
        assert_eq!(
            r,
            ["gracia_offline", "licencia_gracia", "licencia_warn", "rechazo_sin_verificar", "reloj_desfasado"]
        );

        let n = FakeNotifier::default();
        avisar_estado_licencia(&n, &result("warn", state_con_expiry(Some(ahora + 3 * DAY_MS))), ahora, &zona).await;
        assert!(!n.resueltas.lock().unwrap().contains(&"licencia_warn".to_string()));
        assert_eq!(n.resueltas.lock().unwrap().len(), 4);

        let n = FakeNotifier::default();
        avisar_estado_licencia(&n, &result("offline_grace", state_con_expiry(None)), ahora, &zona).await;
        assert!(n.resueltas.lock().unwrap().is_empty());
    }

    /// El título del aviso de una licencia que caduca en `caducidad`, visto en `ahora`. Las dos
    /// son (día de septiembre de 2026, hora, minuto) en `zona`.
    async fn aviso_por_caducar(
        zona: &chrono::FixedOffset,
        ahora: (u32, u32, u32),
        caducidad: (u32, u32, u32),
    ) -> String {
        let ms = |(dia, h, m): (u32, u32, u32)| {
            zona.with_ymd_and_hms(2026, 9, dia, h, m, 0).unwrap().timestamp_millis()
        };
        let n = FakeNotifier::default();
        let res = result("warn", state_con_expiry(Some(ms(caducidad))));
        avisar_estado_licencia(&n, &res, ms(ahora), zona).await;
        let titulo = n.emitidas.lock().unwrap()[0].titulo.clone();
        titulo
    }

    #[tokio::test]
    async fn el_aviso_de_caducidad_cuenta_dias_de_calendario_y_no_horas() {
        // Madrid en verano.
        let zona = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        for (ahora, caducidad, esperado) in [
            // Quince horas: redondeadas hacia arriba eran «mañana», y es hoy.
            ((15, 8, 0), (15, 23, 0), "Tu licencia caduca hoy"),
            ((15, 0, 5), (15, 23, 59), "Tu licencia caduca hoy"),
            // Cuarenta y cinco minutos, pero pasada la medianoche: es mañana.
            ((15, 23, 45), (16, 0, 30), "Tu licencia caduca mañana"),
            ((15, 8, 0), (16, 23, 59), "Tu licencia caduca mañana"),
            ((15, 23, 0), (18, 1, 0), "Tu licencia caduca en 3 días"),
        ] {
            let titulo = aviso_por_caducar(&zona, ahora, caducidad).await;
            assert_eq!(titulo, esperado, "{ahora:?} → {caducidad:?}");
        }
    }

    #[tokio::test]
    async fn la_fecha_es_la_de_la_zona_del_equipo_y_no_la_utc() {
        // A las 00:30 del 16 en Madrid todavía es el 15 en UTC. Una caducidad a las 23:00 del 16
        // es «hoy» para quien lo lee; contando en UTC saldría «mañana».
        let zona = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        let titulo = aviso_por_caducar(&zona, (16, 0, 30), (16, 23, 0)).await;
        assert_eq!(titulo, "Tu licencia caduca hoy");
    }

    #[tokio::test]
    async fn caducada_no_anuncia_cuanto_margen_queda() {
        let ahora = 1_000 * DAY_MS;
        let n = FakeNotifier::default();
        let res = result("expiry_grace", state_con_expiry(Some(ahora - DAY_MS)));
        avisar_estado_licencia(&n, &res, ahora, &chrono::Utc).await;
        let cuerpo = n.emitidas.lock().unwrap()[0].cuerpo.clone().unwrap();
        assert!(!cuerpo.chars().any(|c| c.is_ascii_digit()), "{cuerpo}");
        assert!(!cuerpo.contains("día"), "{cuerpo}");
    }

    #[test]
    fn clean_recorta_y_descarta_cadenas_vacias() {
        assert_eq!(clean(Some("  otp  ".into())), Some("otp".into()));
        assert_eq!(clean(Some("   ".into())), None);
        assert_eq!(clean(None), None);
    }

    #[test]
    fn reloj_en_milisegundos_es_positivo() {
        assert!(now_ms() > 0);
    }

    #[test]
    fn estado_inicial_copia_la_concesion_y_arranca_sin_checks() {
        let estado = estado_inicial(Concesion {
            tenant_id: "tenant-1".into(), device_id: "device-1".into(),
            status: "active".into(), expires_at: Some("2027-01-01".into()),
            expires_at_ms: Some(1_798_761_600_000), plan: Some("pro".into()),
            cambio_de_equipo: false, tiempo_sumado: false,
        });
        assert_eq!(estado.tenant_id, "tenant-1");
        assert_eq!(estado.device_id, "device-1");
        assert_eq!(estado.status.as_deref(), Some("active"));
        assert_eq!(estado.plan.as_deref(), Some("pro"));
        assert!(estado.last_check_ok_ms.is_none());
        assert!(estado.last_check_attempt_ms.is_none());
        assert!(estado.activated_at_ms > 0);
    }

    /// Un servicio de licencias que contesta a la activación con lo que se le diga.
    struct ServicioQueActiva {
        respuesta: Mutex<Option<ResultadoActivacion>>,
        guardado: Mutex<Option<LicenseLocalState>>,
    }

    #[async_trait]
    impl LicensingService for ServicioQueActiva {
        fn load_state(&self) -> AppResult<Option<LicenseLocalState>> {
            Ok(None)
        }
        fn save_state(&self, state: &LicenseLocalState) -> AppResult<()> {
            *self.guardado.lock().unwrap() = Some(state.clone());
            Ok(())
        }
        fn delete_state(&self, _: Option<&str>) -> AppResult<()> {
            Ok(())
        }
        fn last_rejection(&self) -> AppResult<Option<String>> {
            Ok(None)
        }
        async fn activar_remoto(
            &self,
            _: &SolicitudActivacion,
            _: Option<&str>,
        ) -> AppResult<ResultadoActivacion> {
            Ok(self.respuesta.lock().unwrap().take().expect("una sola activación por test"))
        }
        async fn solicitar_cambio_dispositivo(&self, _: &str) -> AppResult<()> {
            Ok(())
        }
        async fn consultar_estado(
            &self,
            _: &LicenseLocalState,
        ) -> Result<EstadoConsultado, dom::FalloConsulta> {
            unreachable!("la activación no consulta el estado")
        }
        fn guardar_token(&self, _: &str) {
            unreachable!("la activación no guarda el token de una consulta")
        }
    }

    /// Lo que pasa en el equipo mientras la consulta espera a la nube.
    type MientrasConsulta = Box<dyn FnOnce(&ServicioDeGate) + Send>;

    /// Un servicio con una licencia guardada al que se le dice qué contesta el servidor.
    struct ServicioDeGate {
        guardado: Mutex<Option<LicenseLocalState>>,
        borrado_con: Mutex<Option<Option<String>>>,
        /// Lo que contesta el servidor, una respuesta por consulta. Cada respuesta buena trae el
        /// token `token-<n>`, con `n` el número de la consulta.
        respuestas: Mutex<std::collections::VecDeque<Result<EstadoVerificado, dom::FalloConsulta>>>,
        consultas: Mutex<u32>,
        tokens: Mutex<Vec<String>>,
        mientras_consulta: Mutex<Option<MientrasConsulta>>,
        /// Lo que contesta el reloj monótono (RI-36).
        monotono: Mutex<Option<i64>>,
    }

    impl ServicioDeGate {
        fn con(respuesta: Result<EstadoVerificado, dom::FalloConsulta>) -> Self {
            let mut s = state_con_expiry(None);
            s.activated_at_ms = now_ms();
            ServicioDeGate {
                guardado: Mutex::new(Some(s)),
                borrado_con: Mutex::new(None),
                respuestas: Mutex::new([respuesta].into()),
                consultas: Mutex::new(0),
                tokens: Mutex::new(Vec::new()),
                mientras_consulta: Mutex::new(None),
                monotono: Mutex::new(None),
            }
        }
    }

    #[async_trait]
    impl LicensingService for ServicioDeGate {
        fn load_state(&self) -> AppResult<Option<LicenseLocalState>> {
            Ok(self.guardado.lock().unwrap().clone())
        }
        fn save_state(&self, state: &LicenseLocalState) -> AppResult<()> {
            *self.guardado.lock().unwrap() = Some(state.clone());
            Ok(())
        }
        fn delete_state(&self, motivo: Option<&str>) -> AppResult<()> {
            *self.guardado.lock().unwrap() = None;
            *self.borrado_con.lock().unwrap() = Some(motivo.map(str::to_string));
            Ok(())
        }
        fn last_rejection(&self) -> AppResult<Option<String>> {
            Ok(None)
        }
        async fn activar_remoto(
            &self,
            _: &SolicitudActivacion,
            _: Option<&str>,
        ) -> AppResult<ResultadoActivacion> {
            unreachable!("el gate no activa")
        }
        async fn solicitar_cambio_dispositivo(&self, _: &str) -> AppResult<()> {
            Ok(())
        }
        async fn consultar_estado(
            &self,
            _: &LicenseLocalState,
        ) -> Result<EstadoConsultado, dom::FalloConsulta> {
            let n = {
                let mut c = self.consultas.lock().unwrap();
                *c += 1;
                *c
            };
            let mientras = self.mientras_consulta.lock().unwrap().take();
            if let Some(f) = mientras {
                f(self);
            }
            let respuesta = self.respuestas.lock().unwrap().pop_front().expect("una respuesta por consulta");
            respuesta.map(|verificado| EstadoConsultado { verificado, token: Some(format!("token-{n}")) })
        }
        fn guardar_token(&self, token: &str) {
            self.tokens.lock().unwrap().push(token.to_string());
        }
        fn transcurrido_monotono(&self) -> Option<i64> {
            *self.monotono.lock().unwrap()
        }
    }

    fn firmado(estado: EstadoLicencia) -> EstadoVerificado {
        EstadoVerificado {
            assertion: dom::AssertionVerificada {
                version: 1,
                tenant_id: "t".into(),
                device_id: "d".into(),
                license_id: "l".into(),
                estado,
                plan: "standard".into(),
                expires_at_ms: None,
                issued_at_ms: 0,
                assertion_expires_at_ms: 0,
                client_ts: 0,
            },
            server_time_ms: 0,
        }
    }

    /// RI-09: ni siquiera una anulación firmada borra la licencia local. Bloquea con su motivo y la
    /// conserva, para que el día que se deshaga —o que se vea que fue un error nuestro— el equipo
    /// vuelva solo.
    #[tokio::test]
    async fn el_gate_nunca_borra_la_licencia() {
        for estado in [EstadoLicencia::Revoked, EstadoLicencia::DeviceReplaced] {
            let svc = ServicioDeGate::con(Ok(firmado(estado)));
            let res = gate(&svc, None).await.unwrap();
            assert!(!res.allowed);
            assert_eq!(res.reason, estado.codigo());
            assert!(res.state.is_some(), "{estado:?}");
            assert!(svc.borrado_con.lock().unwrap().is_none(), "{estado:?}");
            assert_eq!(
                svc.guardado.lock().unwrap().as_ref().and_then(|s| s.status.clone()).as_deref(),
                Some(estado.codigo())
            );
        }
    }

    #[tokio::test]
    async fn un_rechazo_sin_firmar_deja_trabajar_con_la_gracia_y_lo_dice() {
        let svc = ServicioDeGate::con(Err(dom::FalloConsulta::RechazoSinFirmar {
            code: "license_not_found".into(),
        }));
        let res = gate(&svc, None).await.unwrap();
        assert!(res.allowed);
        assert_eq!(res.reason, "rejection_unverified");
        assert!(svc.borrado_con.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn el_aviso_del_rechazo_sin_verificar_va_a_los_administradores() {
        let ahora = 1_000 * DAY_MS;
        let n = FakeNotifier::default();
        let mut s = state_con_expiry(None);
        s.last_check_ok_ms = Some(ahora - HORA_MS);
        avisar_estado_licencia(&n, &result("rejection_unverified", s), ahora, &chrono::Utc).await;
        let e = n.emitidas.lock().unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].clave_dedupe.as_deref(), Some("rechazo_sin_verificar"));
        assert!(e[0].titulo.contains("~71 h"), "{}", e[0].titulo);
    }

    /// RI-36. El reloj de pared dice que la última comprobación buena fue hace una hora, pero ya se
    /// han contado 80 h sin conexión: alguien ha ido atrasando el reloj. Manda lo contado.
    #[tokio::test]
    async fn atrasar_el_reloj_no_estira_la_gracia_offline() {
        let svc = ServicioDeGate::con(Err(dom::FalloConsulta::Inalcanzable));
        {
            let mut g = svc.guardado.lock().unwrap();
            let s = g.as_mut().unwrap();
            s.last_check_ok_ms = Some(now_ms() - HORA_MS);
            s.offline_consumido_ms = Some(80 * HORA_MS);
            s.marca_tiempo_ms = Some(now_ms());
        }
        let res = gate(&svc, None).await.unwrap();
        assert!(!res.allowed);
        assert_eq!(res.reason, "offline_expired");
    }

    /// Con la app abierta, atrasar el reloj no resta: el pulso suma lo que dice el monótono.
    #[tokio::test]
    async fn el_pulso_cuenta_con_el_monotono_aunque_el_reloj_vaya_hacia_atras() {
        let svc = ServicioDeGate::con(Err(dom::FalloConsulta::Inalcanzable));
        {
            let mut g = svc.guardado.lock().unwrap();
            let s = g.as_mut().unwrap();
            s.offline_consumido_ms = Some(10 * HORA_MS);
            // La última marca está tres horas «en el futuro»: el reloj se ha atrasado.
            s.marca_tiempo_ms = Some(now_ms() + 3 * HORA_MS);
        }
        *svc.monotono.lock().unwrap() = Some(HORA_MS);
        contar_tiempo_sin_conexion(&svc).unwrap();
        let s = svc.guardado.lock().unwrap().clone().unwrap();
        assert_eq!(s.offline_consumido_ms, Some(11 * HORA_MS));
    }

    #[tokio::test]
    async fn una_comprobacion_buena_vuelve_a_empezar_la_cuenta() {
        let svc = ServicioDeGate::con(Ok(firmado(EstadoLicencia::Active)));
        svc.guardado.lock().unwrap().as_mut().unwrap().offline_consumido_ms = Some(50 * HORA_MS);
        let res = gate(&svc, None).await.unwrap();
        assert!(res.allowed);
        assert_eq!(res.state.unwrap().offline_consumido_ms, Some(0));
    }

    /// Borrar a mano después de una anulación deja anotado el motivo, que es lo que la pantalla de
    /// activación explica. Sin anulación de por medio, no se anota nada.
    #[tokio::test]
    async fn borrar_a_mano_anota_la_anulacion_que_habia() {
        let svc = ServicioDeGate::con(Ok(firmado(EstadoLicencia::Revoked)));
        gate(&svc, None).await.unwrap();
        clear_state(&svc).unwrap();
        assert_eq!(*svc.borrado_con.lock().unwrap(), Some(Some("revoked".to_string())));

        let svc = ServicioDeGate::con(Ok(firmado(EstadoLicencia::Expired)));
        gate(&svc, None).await.unwrap();
        clear_state(&svc).unwrap();
        assert_eq!(*svc.borrado_con.lock().unwrap(), Some(None));
    }

    /// LIC-08: la comprobación salió con la licencia anulada y, mientras esperaba a la nube, se
    /// pulsó «Borrar y volver a activar». Al volver no puede guardar la anulada ni su token: el
    /// equipo se queda sin licencia, en la pantalla de activar.
    #[tokio::test]
    async fn una_comprobacion_que_llega_tarde_no_resucita_la_licencia_borrada() {
        let svc = ServicioDeGate::con(Ok(firmado(EstadoLicencia::Revoked)));
        svc.guardado.lock().unwrap().as_mut().unwrap().status = Some("revoked".into());
        *svc.mientras_consulta.lock().unwrap() = Some(Box::new(|s| clear_state(s).unwrap()));

        let res = check_now(&svc).await.unwrap();

        assert!(!res.allowed);
        assert_eq!(res.reason, Motivo::NecesitaActivacion.codigo());
        assert!(res.state.is_none());
        assert!(svc.guardado.lock().unwrap().is_none(), "la licencia borrada ha vuelto");
        assert!(svc.tokens.lock().unwrap().is_empty(), "ha guardado el token de la borrada");
        assert_eq!(*svc.consultas.lock().unwrap(), 1);
    }

    /// LIC-08: si lo que pasó mientras tanto fue que se activó otra licencia, se comprueba esa, y
    /// lo que queda es lo que contestó la nube sobre ella, con su token.
    #[tokio::test]
    async fn una_comprobacion_que_llega_tarde_comprueba_la_licencia_que_hay_ahora() {
        let svc = ServicioDeGate::con(Ok(firmado(EstadoLicencia::Revoked)));
        svc.respuestas.lock().unwrap().push_back(Ok(firmado(EstadoLicencia::Active)));
        *svc.mientras_consulta.lock().unwrap() = Some(Box::new(|s| {
            let mut nueva = state_con_expiry(None);
            nueva.tenant_id = "t2".into();
            nueva.activated_at_ms = now_ms();
            reescribir(|| s.save_state(&nueva)).unwrap();
        }));

        let res = gate(&svc, None).await.unwrap();

        assert!(res.allowed);
        assert_eq!(res.reason, "ok");
        let guardado = svc.guardado.lock().unwrap().clone().unwrap();
        assert_eq!(guardado.tenant_id, "t2");
        assert_eq!(guardado.status.as_deref(), Some("active"));
        assert_eq!(*svc.tokens.lock().unwrap(), ["token-2"]);
    }

    /// LIC-08: sin nada de por medio, la comprobación guarda el token que trajo.
    #[tokio::test]
    async fn la_comprobacion_guarda_el_token_que_trae() {
        let svc = ServicioDeGate::con(Ok(firmado(EstadoLicencia::Active)));
        gate(&svc, None).await.unwrap();
        assert_eq!(*svc.tokens.lock().unwrap(), ["token-1"]);
    }

    fn activacion(respuesta: ResultadoActivacion) -> (ServicioQueActiva, LicenseActivateInput) {
        let svc = ServicioQueActiva {
            respuesta: Mutex::new(Some(respuesta)),
            guardado: Mutex::new(None),
        };
        let input = LicenseActivateInput {
            activation_key: "TPV-AAAA-BBBB-CCCC".into(),
            business_name: "Bar de Pruebas".into(),
            legal_name: None,
            phone: None,
            country: None,
            device_change_code: Some("123456".into()),
        };
        (svc, input)
    }

    fn concesion(cambio_de_equipo: bool) -> Concesion {
        Concesion {
            tenant_id: "tenant-1".into(),
            device_id: "device-1".into(),
            status: "active".into(),
            expires_at: None,
            expires_at_ms: None,
            plan: None,
            cambio_de_equipo,
            tiempo_sumado: false,
        }
    }

    /// Lo que decide si la base de este equipo se reconstruye desde la nube es lo que diga el
    /// servidor, no que se haya escrito un código: con el código puesto, una activación en el
    /// mismo equipo no es un traslado y no puede llevarse por delante sus datos.
    #[tokio::test]
    async fn la_activacion_dice_si_ha_sido_un_traslado_segun_el_servidor() {
        let (svc, input) = activacion(ResultadoActivacion::Activada(concesion(true)));
        let outcome = activate(&svc, input).await.unwrap();
        assert_eq!(outcome.outcome, "activated");
        assert!(outcome.cambio_de_equipo);
        assert!(svc.guardado.lock().unwrap().is_some(), "la licencia queda guardada igual");

        let (svc, input) = activacion(ResultadoActivacion::Activada(concesion(false)));
        assert!(!activate(&svc, input).await.unwrap().cambio_de_equipo);
    }

    #[tokio::test]
    async fn pedir_el_codigo_no_es_todavia_un_traslado() {
        let (svc, input) = activacion(ResultadoActivacion::CambioDispositivoRequerido {
            email_hint: "b***@bar.test".into(),
        });
        let outcome = activate(&svc, input).await.unwrap();
        assert_eq!(outcome.outcome, "device_change_required");
        assert!(!outcome.cambio_de_equipo);
        assert!(svc.guardado.lock().unwrap().is_none());
    }

    #[test]
    fn clean_no_altera_texto_interior() {
        assert_eq!(clean(Some("  codigo con espacios  ".into())), Some("codigo con espacios".into()));
    }
}
