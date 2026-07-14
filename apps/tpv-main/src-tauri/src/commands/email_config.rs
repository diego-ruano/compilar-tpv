//! Comando Tauri para el envío de pedidos por correo.
//!
//! Todo el correo se envía SIEMPRE a través del worker (`/v1/email/enviar-pedido`), que es quien
//! usa el servicio de envío (Cloudflare Email Service). La Main (y la Handy) solo
//! construyen la petición y la mandan al worker. Consecuencias de diseño (DB-04):
//!   · No hay "SMTP propio del negocio": se retiró el modo SMTP y la tabla `Email_Settings`, así
//!     que ya NO se guarda ninguna credencial SMTP en la BD ni se replica a la nube.
//!   · En offline no se puede enviar (hace falta el worker); es el comportamiento esperado.

use std::path::PathBuf;

use serde_json::json;
use tauri::{AppHandle, Manager};

use tpv_application::use_cases::pairing as uc_pairing;
use tpv_contracts::email_config::EnviarPedidoEmailInput;
use tpv_infra_licensing::PairingAdapter;

/* ── Helpers ─────────────────────────────────────────────────────────── */

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

/* ── Comando ─────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn email_enviar_pedido(
    app: AppHandle,
    args: EnviarPedidoEmailInput,
) -> Result<(), String> {
    let app_data_dir = app_data(&app)?;
    let svc = PairingAdapter::new(app_data_dir);

    let body = json!({
        "email_destino": args.email_destino,
        "nombre_proveedor": args.nombre_proveedor,
        "notas": args.notas,
        "lineas": args.lineas.iter().map(|l| json!({
            "nombre_producto": l.nombre_producto,
            "cantidad": l.cantidad,
            "precio_unitario": l.precio_unitario,
            "unidad": l.unidad,
        })).collect::<Vec<_>>(),
    });

    uc_pairing::tpv_server_post_json(
        &svc,
        tpv_contracts::licensing::TpvServerPostJsonArgs {
            mode: "tpv".into(),
            path: "/v1/email/enviar-pedido".into(),
            body,
        },
    )
    .await
    .map_err(|e| format!("Error enviando correo: {e}"))?;

    Ok(())
}
