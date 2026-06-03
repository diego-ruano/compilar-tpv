//! Casos de uso de **licensing**. Validan la entrada e invocan el `LicensingService`.

use tpv_contracts::licensing::{
    ApiAuthHeaders, ApiGetAuthHeadersArgs, LicenseActivateInput, LicenseGateResult,
    LicenseLocalState,
};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::LicensingService;

fn requerido(input: &str, field: &str) -> AppResult<String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(AppError::validation(format!("{field} required")));
    }
    Ok(out)
}

pub fn get_state(svc: &dyn LicensingService) -> AppResult<Option<LicenseLocalState>> {
    svc.get_state()
}

pub fn clear_state(svc: &dyn LicensingService) -> AppResult<()> {
    svc.clear_state()
}

pub fn auth_headers(
    svc: &dyn LicensingService,
    args: ApiGetAuthHeadersArgs,
) -> AppResult<ApiAuthHeaders> {
    let method = requerido(&args.method, "method")?;
    let path = requerido(&args.path, "path")?;
    svc.auth_headers(&method, &path)
}

pub async fn activate(
    svc: &dyn LicensingService,
    input: LicenseActivateInput,
) -> AppResult<LicenseLocalState> {
    requerido(&input.activation_key, "activation_key")?;
    svc.activate(input).await
}

pub async fn gate(svc: &dyn LicensingService) -> AppResult<LicenseGateResult> {
    svc.gate(false).await
}

pub async fn check_now(svc: &dyn LicensingService) -> AppResult<LicenseGateResult> {
    svc.gate(true).await
}
