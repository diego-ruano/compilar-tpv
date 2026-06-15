//! Casos de uso de **sincronización Main → nube**. Validan/normalizan la entrada e invocan el
//! `CloudSyncService`.

use tpv_contracts::licensing::UploadInitialSetupArgs;

use crate::error::{AppError, AppResult};
use crate::ports::cloud_sync::CloudSyncService;

fn requerido(input: &str, field: &str) -> AppResult<String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(AppError::validation(format!("{field} required")));
    }
    Ok(out)
}

/// Sube el setup inicial del admin a la nube tras completarlo en local.
pub async fn upload_initial_setup(
    svc: &dyn CloudSyncService,
    args: UploadInitialSetupArgs,
) -> AppResult<()> {
    let id_usuario = requerido(&args.id_usuario, "id_usuario")?;
    let email = requerido(&args.email, "email")?;
    let pin = requerido(&args.pin, "pin")?;
    if pin.len() < 4 {
        return Err(AppError::validation("PIN demasiado corto"));
    }

    svc.upload_initial_setup(&id_usuario, &email, &pin).await
}
