//! Casos de uso de **sincronización Main → nube**. Validan/normalizan la entrada e invocan el
//! `CloudSyncService`.

use tpv_contracts::licensing::UploadInitialSetupArgs;

use crate::error::{AppError, AppResult};
use crate::ports::cloud_sync::CloudSyncService;

fn requerido(input: &str, mensaje: &str) -> AppResult<String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(AppError::validation(mensaje));
    }
    Ok(out)
}

/// Sube el setup inicial del admin a la nube tras completarlo en local.
pub async fn upload_initial_setup(
    svc: &dyn CloudSyncService,
    args: UploadInitialSetupArgs,
) -> AppResult<()> {
    let id_usuario = requerido(&args.id_usuario, "Falta el usuario.")?;
    let email = requerido(&args.email, "Escribe el correo.")?;
    let pin = requerido(&args.pin, "Escribe el PIN.")?;
    if pin.len() < 4 {
        return Err(AppError::validation("PIN demasiado corto"));
    }

    svc.upload_initial_setup(&id_usuario, &email, &pin).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requerido_recorta_y_rechaza_vacio() {
        assert_eq!(requerido("  valor  ", "campo").unwrap(), "valor");
        assert!(matches!(
            requerido("   ", "campo"),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn requerido_dice_que_falta() {
        let error = requerido("\t\n", "Escribe el correo.").unwrap_err().to_string();
        assert_eq!(error, "Escribe el correo.");
    }
}
