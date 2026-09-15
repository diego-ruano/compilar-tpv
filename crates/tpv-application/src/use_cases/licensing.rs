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
use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::LicensingService;
use crate::ports::notificaciones::Notifier;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const HORA_MS: i64 = 60 * 60 * 1000;
/// Días de gracia tras caducar la licencia (para el texto del aviso). DEBE coincidir con
/// `GRACE_DAYS` del worker (`licensing.helpers.ts`), que es quien decide el estado real.
const GRACIA_LICENCIA_DIAS: i64 = 3;

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
            let estado = estado_inicial(concedido);
            svc.save_state(&estado)?;
            Ok(LicenseActivateOutcome {
                outcome: "activated".to_string(),
                state: Some(estado),
                email_hint: None,
            })
        }
        ResultadoActivacion::CambioDispositivoRequerido { email_hint } => {
            Ok(LicenseActivateOutcome {
                outcome: "device_change_required".to_string(),
                state: None,
                email_hint: Some(email_hint),
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
        avisar_estado_licencia(notifier, &res, now_ms()).await;
    }
    Ok(res)
}

/// Comprobación pedida por el usuario ("Reintentar"): no enmascara los fallos del servidor con la
/// gracia offline. No emite avisos (es una acción manual, no el pulso periódico).
pub async fn check_now(svc: &dyn LicensingService) -> AppResult<LicenseGateResult> {
    comprobar(svc, true).await
}

/// Emite (best-effort) avisos a los administradores según el veredicto del gate. Dedupe temporal:
/// avisos de licencia una vez al DÍA; el de gracia offline una vez cada 4 H (recordatorio insistente
/// para no jugársela a que se olvide). El estado real (permitir/bloquear) NO se toca aquí.
async fn avisar_estado_licencia(notifier: &dyn Notifier, res: &LicenseGateResult, ahora_ms: i64) {
    let Some(state) = res.state.as_ref() else {
        return;
    };
    let dia = ahora_ms / DAY_MS; // índice de día → dedupe diario sin formatear fecha

    match res.reason.as_str() {
        // Licencia por caducar (estado firmado `warn` del servidor).
        "warn" => {
            let dias = dias_ceil(state.expires_at_ms.map(|e| e - ahora_ms).unwrap_or(0));
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "licencia_por_expirar".to_string(),
                    severidad: Severidad::Aviso,
                    titulo: "Licencia por caducar".to_string(),
                    cuerpo: Some(format!(
                        "Tu licencia caduca en {dias} día(s). Renuévala para evitar el bloqueo."
                    )),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: Some("ver_licencia".to_string()),
                    payload: None,
                    clave_dedupe: Some(format!("licencia_warn:{dia}")),
                    expira_en: None,
                })
                .await;
        }
        // Caducada pero dentro de los 3 días de gracia (estado firmado `expiry_grace`): sigue funcionando.
        "expiry_grace" => {
            let bloqueo_ms = state
                .expires_at_ms
                .map(|e| e + GRACIA_LICENCIA_DIAS * DAY_MS)
                .unwrap_or(ahora_ms);
            let dias = dias_ceil(bloqueo_ms - ahora_ms);
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "licencia_caducada".to_string(),
                    severidad: Severidad::Error,
                    titulo: "Licencia caducada".to_string(),
                    cuerpo: Some(format!(
                        "Tu licencia ha caducado. Te quedan {dias} día(s) para renovar antes de que la app se bloquee."
                    )),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: Some("ver_licencia".to_string()),
                    payload: None,
                    clave_dedupe: Some(format!("licencia_gracia:{dia}")),
                    expira_en: None,
                })
                .await;
        }
        // Sin conexión con el servidor: corriendo con la gracia offline (72 h). Recordar cada 4 h.
        "offline_grace" => {
            let base = dom::base_gracia(state.last_check_ok_ms, state.activated_at_ms);
            let restante_ms = (dom::GRACIA_OFFLINE_MS - (ahora_ms - base)).max(0);
            let horas = horas_ceil(restante_ms);
            let bucket = ahora_ms / (4 * HORA_MS);
            let _ = notifier
                .emitir(NuevaNotificacion {
                    tipo: "gracia_offline".to_string(),
                    severidad: Severidad::Aviso,
                    titulo: "Sin conexión con licencias".to_string(),
                    cuerpo: Some(format!(
                        "No se ha podido verificar la licencia. Quedan ~{horas} h de funcionamiento sin conexión antes de bloquear."
                    )),
                    destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
                    accion: None,
                    payload: None,
                    clave_dedupe: Some(format!("gracia_offline:{bucket}")),
                    expira_en: None,
                })
                .await;
        }
        _ => {}
    }
}

fn dias_ceil(ms: i64) -> i64 {
    if ms <= 0 {
        0
    } else {
        (ms + DAY_MS - 1) / DAY_MS
    }
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

    #[derive(Default)]
    struct FakeNotifier {
        emitidas: Mutex<Vec<NuevaNotificacion>>,
    }
    #[async_trait]
    impl Notifier for FakeNotifier {
        async fn emitir(&self, n: NuevaNotificacion) -> AppResult<String> {
            self.emitidas.lock().unwrap().push(n);
            Ok("n".into())
        }
        async fn resolver_por_clave(&self, _: &str) -> AppResult<bool> {
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
        let n = FakeNotifier::default();

        avisar_estado_licencia(&n, &result("warn", state_con_expiry(Some(ahora + 3 * DAY_MS))), ahora).await;
        avisar_estado_licencia(&n, &result("expiry_grace", state_con_expiry(Some(ahora - DAY_MS))), ahora).await;

        let mut s = state_con_expiry(None);
        s.last_check_ok_ms = Some(ahora - HORA_MS);
        s.activated_at_ms = ahora - HORA_MS;
        avisar_estado_licencia(&n, &result("offline_grace", s), ahora).await;

        // Estado sano: no emite.
        avisar_estado_licencia(&n, &result("ok", state_con_expiry(None)), ahora).await;

        let e = n.emitidas.lock().unwrap();
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].tipo, "licencia_por_expirar");
        assert!(e[0].clave_dedupe.as_deref().unwrap().starts_with("licencia_warn:"));
        assert_eq!(e[1].tipo, "licencia_caducada");
        assert!(e[1].clave_dedupe.as_deref().unwrap().starts_with("licencia_gracia:"));
        assert_eq!(e[2].tipo, "gracia_offline");
        assert!(e[2].clave_dedupe.as_deref().unwrap().starts_with("gracia_offline:"));
        assert!(e.iter().all(|n| n.destino == Destino::Rol(ADMIN_ROL_ID.to_string())));
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
        });
        assert_eq!(estado.tenant_id, "tenant-1");
        assert_eq!(estado.device_id, "device-1");
        assert_eq!(estado.status.as_deref(), Some("active"));
        assert_eq!(estado.plan.as_deref(), Some("pro"));
        assert!(estado.last_check_ok_ms.is_none());
        assert!(estado.last_check_attempt_ms.is_none());
        assert!(estado.activated_at_ms > 0);
    }

    #[test]
    fn clean_no_altera_texto_interior() {
        assert_eq!(clean(Some("  codigo con espacios  ".into())), Some("codigo con espacios".into()));
    }
}
