//! Casos de uso de **licensing**.
//!
//! El gate se orquesta aquí: se trae el estado del servidor por el puerto, se le pide el
//! veredicto al dominio y se aplica la acción sobre `license_state.json`. Ni una decisión
//! de negocio en el adaptador, ni una línea de HTTP en el dominio.

use tpv_contracts::licensing::{LicenseActivateInput, LicenseGateResult, LicenseLocalState};
use tpv_domain::licensing::{
    self as dom, AccionEstado, Concesion, Motivo, Resolucion, SolicitudActivacion, Veredicto,
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

pub fn get_state(svc: &dyn LicensingService) -> AppResult<Option<LicenseLocalState>> {
    svc.load_state()
}

pub fn clear_state(svc: &dyn LicensingService) -> AppResult<()> {
    svc.delete_state()
}

/// Activa la licencia en este dispositivo y persiste el estado resultante.
pub async fn activate(
    svc: &dyn LicensingService,
    input: LicenseActivateInput,
) -> AppResult<LicenseLocalState> {
    let solicitud = SolicitudActivacion::validar(
        input.activation_key,
        input.business_name,
        input.legal_name,
        input.email,
        input.phone,
        input.country,
    )
    .map_err(AppError::validation)?;

    let concedido = svc.activar_remoto(&solicitud).await?;
    let estado = estado_inicial(concedido);

    svc.save_state(&estado)?;
    Ok(estado)
}

/// Gate de arranque / periódico: se apoya en la gracia offline si no hay red.
pub async fn gate(svc: &dyn LicensingService) -> AppResult<LicenseGateResult> {
    comprobar(svc, false).await
}

/// Comprobación pedida por el usuario ("Reintentar"): no enmascara los fallos del servidor
/// con la gracia offline.
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
        Ok(respuesta) => {
            // El servidor es la autoridad: su versión del estado sustituye a la cacheada.
            estado.status = Some(respuesta.estado.status.clone());
            estado.expires_at = respuesta.estado.expires_at.clone();
            estado.last_server_time_ms = Some(respuesta.server_time_ms);
            estado.last_check_ok_ms = Some(ahora);

            aplicar(svc, estado, dom::evaluar_respuesta(&respuesta))
        }

        Err(fallo) => {
            let base = dom::base_gracia(estado.last_check_ok_ms, estado.activated_at_ms);

            match dom::evaluar_fallo(&fallo, base, ahora, forzar_red) {
                Resolucion::Decidido(veredicto) => aplicar(svc, estado, veredicto),
                Resolucion::Indecidible => Err(AppError::external(fallo.to_string())),
            }
        }
    }
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
        token: concedido.token,
        status: Some(concedido.status),
        expires_at: concedido.expires_at,
        last_server_time_ms: None,
        last_check_ok_ms: None,
        last_check_attempt_ms: None,
        activated_at_ms: now_ms(),
    }
}
