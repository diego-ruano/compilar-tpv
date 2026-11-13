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
use tauri::{AppHandle, Manager, State};

use tpv_application::use_cases::pairing as uc_pairing;
use tpv_contracts::email_config::EnviarPedidoEmailInput;
use tpv_infra_licensing::PairingAdapter;
use tpv_contracts::errors::AppErrorDto;

use crate::AppState;

/* ── Helpers ─────────────────────────────────────────────────────────── */

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

/* ── Comando ─────────────────────────────────────────────────────────── */

/// SEC-01: exige Administrador. Mandar un pedido compromete dinero con un proveedor y sale
/// firmado con el correo del negocio; «Proveedores y Pedidos» ya era una sección suya en el
/// menú, y esto es el candado que le faltaba detrás.
#[tauri::command]
#[specta::specta]
pub async fn email_enviar_pedido(
    app: AppHandle,
    state: State<'_, AppState>,
    args: EnviarPedidoEmailInput,
) -> Result<(), AppErrorDto> {
    state.exigir_permiso("pedidos.gestionar").await?;

    let app_data_dir = app_data(&app)?;
    let svc = PairingAdapter::new(app_data_dir);

    let body = json!({
        "email_destino": args.email_destino,
        "nombre_proveedor": args.nombre_proveedor,
        "notas": args.notas,
        // Idempotencia del envío: un reintento con la misma clave no manda otro correo.
        "id_envio": args.id_envio,
        "lineas": args.lineas.iter().map(|l| json!({
            "nombre_producto": l.nombre_producto,
            "cantidad": l.cantidad,
            "precio_unitario": l.precio_unitario,
            "unidad": l.unidad,
        })).collect::<Vec<_>>(),
    });

    // El fallo sale con su código (`From<AppError> for AppErrorDto`). Convertido en texto llegaba
    // a la interfaz como `internal`, y lo que falla aquí casi nunca es el programa: no hay red, el
    // worker rechaza al destinatario, o el objeto del negocio no puede atender (`hub_overloaded`,
    // `hub_unavailable`: la ruta se ejecuta dentro del TenantHub, DO-04). Su frase ya viene escrita
    // para la persona; la pantalla le pone delante «No se pudo enviar el pedido».
    uc_pairing::tpv_server_post_json(
        &svc,
        tpv_contracts::licensing::TpvServerPostJsonArgs {
            mode: "tpv".into(),
            path: "/v1/email/enviar-pedido".into(),
            body,
        },
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    /// El envío es una petición a la nube: su fallo es de la red, de la nube o un rechazo con su
    /// código, y la gravedad con que se registra sale de él (`fallosDeComandos.ts`). Un `String`
    /// se convierte en `internal` (`From<String> for AppErrorDto`), que es un fallo del programa.
    #[test]
    fn el_fallo_del_envio_llega_con_su_codigo_no_como_texto() {
        let fuente = include_str!("email_config.rs");
        let envio = fuente
            .split("uc_pairing::tpv_server_post_json(")
            .nth(1)
            .and_then(|resto| resto.split("Ok(())").next())
            .expect("el comando llama a tpv_server_post_json");
        assert!(envio.contains(".await?"), "el error del envío se propaga tal cual: {envio}");
        assert!(!envio.contains("map_err") && !envio.contains("format!"), "sin convertirlo en texto: {envio}");
    }
}
