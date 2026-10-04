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
    self as dom, AccionEstado, Concesion, EstadoVerificado, Motivo, Resolucion,
    ResultadoActivacion, SolicitudActivacion, Veredicto,
};
use chrono::{Local, TimeZone};
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::LicensingService;
use crate::ports::notificaciones::Notifier;

const HORA_MS: i64 = 60 * 60 * 1000;

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

pub fn clear_state(svc: &dyn LicensingService) -> AppResult<()> {
    // Sin motivo: esto lo pide el usuario desde la pantalla de bloqueo, y no hay nada que
    // explicarle después que no sepa ya.
    svc.delete_state(None)
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
            svc.save_state(&estado)?;
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

/// Pide al servidor que mande el OTP de cambio de dispositivo al email de la licencia.
pub async fn request_device_change(
    svc: &dyn LicensingService,
    input: LicenseDeviceChangeInput,
) -> AppResult<()> {
    let clave = input.activation_key.trim();
    if clave.is_empty() {
        return Err(AppError::validation("activation_key required"));
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

/// Qué aviso corresponde a cada motivo del gate.
const AVISOS: [(&str, &str); 4] = [
    ("warn", CLAVE_POR_CADUCAR),
    ("expiry_grace", CLAVE_CADUCADA),
    ("offline_grace", CLAVE_GRACIA_OFFLINE),
    ("clock_skew_detected", CLAVE_RELOJ),
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
            let base = dom::base_gracia(state.last_check_ok_ms, state.activated_at_ms);
            let restante_ms = (dom::GRACIA_OFFLINE_MS - (ahora_ms - base)).max(0);
            let horas = horas_ceil(restante_ms);
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

fn horas_ceil(ms: i64) -> i64 {
    if ms <= 0 {
        0
    } else {
        (ms + HORA_MS - 1) / HORA_MS
    }
}

async fn comprobar(svc: &dyn LicensingService, forzar_red: bool) -> AppResult<LicenseGateResult> {
    let Some(mut estado) = svc.load_state()? else {
        return Ok(LicenseGateResult {
            allowed: false,
            reason: Motivo::NecesitaActivacion.codigo(),
            state: None,
            // Puede que este equipo no sea nuevo, sino uno al que le anularon la licencia: la
            // pantalla de activación necesita saberlo para poder decirlo.
            last_rejection: svc.last_rejection()?,
        });
    };

    let ahora = now_ms();
    estado.last_check_attempt_ms = Some(ahora);

    match svc.consultar_estado(&estado).await {
        Ok(verificado) => aplicar(
            svc,
            actualizar(estado, &verificado, ahora),
            dom::evaluar_estado(verificado.assertion.estado),
        ),

        Err(fallo) => {
            let base = dom::base_gracia(estado.last_check_ok_ms, estado.activated_at_ms);
            match dom::evaluar_fallo(&fallo, base, ahora, forzar_red) {
                Resolucion::Decidido(veredicto) => aplicar(svc, estado, veredicto),
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
    // El token renovado ya lo persistió el adaptador en el keyring; aquí no hay token que tocar.
    estado
}

/// Ejecuta la acción que dicta el veredicto y compone la respuesta para la UI.
fn aplicar(
    svc: &dyn LicensingService,
    estado: LicenseLocalState,
    veredicto: Veredicto,
) -> AppResult<LicenseGateResult> {
    let motivo = veredicto.motivo.codigo();

    let state = match veredicto.accion {
        AccionEstado::Conservar => {
            svc.save_state(&estado)?;
            Some(estado)
        }
        AccionEstado::Borrar => {
            // El motivo se anota al borrar: es lo único que quedará cuando la app vuelva a
            // arrancar y se encuentre sin licencia.
            svc.delete_state(Some(&motivo))?;
            None
        }
    };

    Ok(LicenseGateResult {
        allowed: veredicto.permitido,
        reason: motivo,
        last_rejection: if state.is_none() { svc.last_rejection()? } else { None },
        state,
    })
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

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
        assert_eq!(r, ["gracia_offline", "licencia_gracia", "licencia_warn", "reloj_desfasado"]);

        let n = FakeNotifier::default();
        avisar_estado_licencia(&n, &result("warn", state_con_expiry(Some(ahora + 3 * DAY_MS))), ahora, &zona).await;
        assert!(!n.resueltas.lock().unwrap().contains(&"licencia_warn".to_string()));
        assert_eq!(n.resueltas.lock().unwrap().len(), 3);

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
        ) -> Result<EstadoVerificado, dom::FalloConsulta> {
            unreachable!("la activación no consulta el estado")
        }
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
