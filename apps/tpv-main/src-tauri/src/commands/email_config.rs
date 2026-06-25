//! Comandos Tauri para configuración de correo y envío de pedidos.
//!
//! Dos rutas de envío:
//!   · "managed": llama a nuestro worker (/v1/email/enviar-pedido) que usa Resend.
//!   · "smtp":    usa `lettre` para enviar directamente con las creds SMTP del usuario.

use std::path::PathBuf;

use lettre::message::{header::ContentType, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde_json::json;
use tauri::{AppHandle, Manager, State};

use tpv_application::ports::email_config::EmailConfigRepository;
use tpv_application::use_cases::email_config as uc;
use tpv_application::use_cases::pairing as uc_pairing;
use tpv_contracts::email_config::{EmailConfigDto, EmailConfigPatchInput, EnviarPedidoEmailInput};
use tpv_domain::email_config::EmailConfig;
use tpv_infra_licensing::PairingAdapter;
use tpv_infra_sqlite::email_config::SqliteEmailConfigRepository;

use crate::AppState;

/* ── Helpers ─────────────────────────────────────────────────────────── */

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))
}

fn to_dto(c: EmailConfig) -> EmailConfigDto {
    EmailConfigDto {
        modo: c.modo,
        smtp_host: c.smtp_host,
        smtp_port: c.smtp_port,
        smtp_user: c.smtp_user,
        smtp_password: c.smtp_password,
        smtp_from_email: c.smtp_from_email,
        smtp_from_name: c.smtp_from_name,
        smtp_use_tls: c.smtp_use_tls,
    }
}

fn from_input(i: EmailConfigPatchInput) -> EmailConfig {
    EmailConfig {
        modo: i.modo,
        smtp_host: i.smtp_host,
        smtp_port: i.smtp_port,
        smtp_user: i.smtp_user,
        smtp_password: i.smtp_password,
        smtp_from_email: i.smtp_from_email,
        smtp_from_name: i.smtp_from_name,
        smtp_use_tls: i.smtp_use_tls,
    }
}

/* ── Comandos ─────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn email_config_get(state: State<'_, AppState>) -> Result<EmailConfigDto, String> {
    let db = state
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "DB no inicializada".to_string())?;
    let repo = SqliteEmailConfigRepository::new(db);
    let config = uc::get_config(&repo).await.map_err(|e| e.to_string())?;
    Ok(to_dto(config))
}

#[tauri::command]
pub async fn email_config_patch(
    state: State<'_, AppState>,
    args: EmailConfigPatchInput,
) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "DB no inicializada".to_string())?;
    let repo = SqliteEmailConfigRepository::new(db);
    uc::patch_config(&repo, from_input(args))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn email_enviar_pedido(
    app: AppHandle,
    state: State<'_, AppState>,
    args: EnviarPedidoEmailInput,
) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "DB no inicializada".to_string())?;
    let repo = SqliteEmailConfigRepository::new(db);
    let config = uc::get_config(&repo).await.map_err(|e| e.to_string())?;

    match config.modo.as_str() {
        "smtp" => enviar_smtp(config, args).await,
        _ => enviar_managed(&app, args).await,
    }
}

/* ── Envío vía SMTP propio del usuario ─────────────────────────────────── */

async fn enviar_smtp(config: EmailConfig, args: EnviarPedidoEmailInput) -> Result<(), String> {
    if config.smtp_host.trim().is_empty() {
        return Err("SMTP no configurado: rellena el host, usuario y contraseña en Configuración → Correos automatizados.".into());
    }

    let from_display = if config.smtp_from_name.trim().is_empty() {
        config.smtp_from_email.clone()
    } else {
        format!("{} <{}>", config.smtp_from_name.trim(), config.smtp_from_email.trim())
    };

    let from: Mailbox = from_display
        .parse()
        .map_err(|e| format!("Dirección 'De' inválida: {e}"))?;
    let to: Mailbox = args
        .email_destino
        .parse()
        .map_err(|e| format!("Dirección 'Para' inválida: {e}"))?;

    let subject = format!("Pedido a {}", args.nombre_proveedor);
    let html = build_html(&args);
    let text = build_text(&args);

    let email = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .multipart(
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .body(text),
                )
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_HTML)
                        .body(html),
                ),
        )
        .map_err(|e| format!("Error construyendo email: {e}"))?;

    let creds = Credentials::new(config.smtp_user.clone(), config.smtp_password.clone());
    let host = config.smtp_host.trim();
    let port = config.smtp_port as u16;

    let mailer: AsyncSmtpTransport<Tokio1Executor> = if config.smtp_use_tls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
            .map_err(|e| format!("Error conectando SMTP: {e}"))?
            .credentials(creds)
            .port(port)
            .build()
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
            .credentials(creds)
            .port(port)
            .build()
    };

    mailer
        .send(email)
        .await
        .map_err(|e| format!("Error enviando correo: {e}"))?;

    Ok(())
}

/* ── Envío vía nuestro servicio (Resend a través del worker) ─────────────── */

async fn enviar_managed(app: &AppHandle, args: EnviarPedidoEmailInput) -> Result<(), String> {
    let app_data_dir = app_data(app)?;
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
    .map_err(|e| format!("Error enviando correo (servicio gestionado): {e}"))?;

    Ok(())
}

/* ── Constructores de cuerpo del email ──────────────────────────────────── */

fn build_text(args: &EnviarPedidoEmailInput) -> String {
    let mut s = format!("Pedido a {}\n\n", args.nombre_proveedor);
    s.push_str("Producto                   Cantidad   Precio     Unidad\n");
    s.push_str("------------------------------------------------------\n");
    for l in &args.lineas {
        let precio = l
            .precio_unitario
            .map(|p| format!("{:.2} €", p))
            .unwrap_or_else(|| "-".into());
        let unidad = l.unidad.as_deref().unwrap_or("-");
        s.push_str(&format!(
            "{:<26} {:<10} {:<10} {}\n",
            truncate(&l.nombre_producto, 26),
            l.cantidad,
            precio,
            unidad,
        ));
    }
    if let Some(n) = &args.notas {
        if !n.trim().is_empty() {
            s.push_str(&format!("\nNotas: {}\n", n.trim()));
        }
    }
    s
}

fn build_html(args: &EnviarPedidoEmailInput) -> String {
    let mut rows = String::new();
    for l in &args.lineas {
        let precio = l
            .precio_unitario
            .map(|p| format!("{:.2} €", p))
            .unwrap_or_else(|| "—".into());
        let unidad = l.unidad.as_deref().unwrap_or("—");
        rows.push_str(&format!(
            "<tr><td style='padding:6px 12px;border-bottom:1px solid #e5e7eb'>{}</td>\
             <td style='padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right'>{}</td>\
             <td style='padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right'>{}</td>\
             <td style='padding:6px 12px;border-bottom:1px solid #e5e7eb'>{}</td></tr>",
            html_escape(&l.nombre_producto),
            l.cantidad,
            precio,
            unidad,
        ));
    }

    let notas_html = args.notas.as_deref().map(|n| {
        if n.trim().is_empty() { String::new() }
        else { format!("<p style='margin-top:16px;color:#6b7280;font-size:14px'><strong>Notas:</strong> {}</p>", html_escape(n.trim())) }
    }).unwrap_or_default();

    format!(
        r#"<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Pedido</title></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="color:#111827;margin-bottom:4px">Pedido a {proveedor}</h2>
  <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px">
    <thead>
      <tr style="background:#f9fafb">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Producto</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Cantidad</th>
        <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #e5e7eb">Precio</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e5e7eb">Unidad</th>
      </tr>
    </thead>
    <tbody>{rows}</tbody>
  </table>
  {notas}
  <p style="margin-top:24px;font-size:12px;color:#9ca3af">Enviado desde TPV · Altaria Lights</p>
</body>
</html>"#,
        proveedor = html_escape(&args.nombre_proveedor),
        rows = rows,
        notas = notas_html,
    )
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        s
    } else {
        &s[..max]
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
