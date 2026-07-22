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

use crate::error::{AppError, AppResult};
use crate::ports::licensing::LicensingService;

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
    svc.delete_state()
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
        input.email,
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

/// Gate de arranque / periódico: se apoya en la gracia offline si no hay red.
pub async fn gate(svc: &dyn LicensingService) -> AppResult<LicenseGateResult> {
    comprobar(svc, false).await
}

/// Comprobación pedida por el usuario ("Reintentar"): no enmascara los fallos del servidor con la
/// gracia offline.
pub async fn check_now(svc: &dyn LicensingService) -> AppResult<LicenseGateResult> {
    comprobar(svc, true).await
}

async fn comprobar(svc: &dyn LicensingService, forzar_red: bool) -> AppResult<LicenseGateResult> {
    let Some(mut estado) = svc.load_state()? else {
        return Ok(LicenseGateResult {
            allowed: false,
            reason: Motivo::NecesitaActivacion.codigo(),
            state: None,
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
    let state = match veredicto.accion {
        AccionEstado::Conservar => {
            svc.save_state(&estado)?;
            Some(estado)
        }
        AccionEstado::Borrar => {
            svc.delete_state()?;
            None
        }
    };

    Ok(LicenseGateResult {
        allowed: veredicto.permitido,
        reason: veredicto.motivo.codigo(),
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
