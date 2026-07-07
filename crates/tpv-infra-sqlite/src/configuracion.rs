//! Adaptador SQLite del repositorio de configuración. Local-First (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;
use serde_json::Value as JsonValue;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::configuracion::ConfiguracionRepository;
use tpv_contracts::configuracion::{BusinessSettings, ContactSettings, TicketSettings};
use tpv_domain::configuracion::{
    clamp_chars_per_line, clamp_font_scale, clamp_margin_mm, clamp_paper_dpi, clamp_paper_width_mm,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{v_f64, v_i64, v_string};

pub struct SqliteConfiguracionRepository {
    db: Arc<Db>,
}

impl SqliteConfiguracionRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn bool_to_i64(b: bool) -> i64 {
    if b {
        1
    } else {
        0
    }
}

fn value_to_bool(v: Value) -> Option<bool> {
    match v {
        Value::Integer(n) => Some(n != 0),
        Value::Real(n) => Some(n != 0.0),
        Value::Text(s) => match s.trim().to_lowercase().as_str() {
            "1" | "true" | "yes" | "si" | "sí" => Some(true),
            "0" | "false" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/* ── Helpers de patch (JSON parcial) ── */

fn patch_get<'a>(patch: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    patch.as_object()?.get(key)
}
fn patch_has(patch: &JsonValue, key: &str) -> bool {
    patch.as_object().map(|o| o.contains_key(key)).unwrap_or(false)
}
fn patch_string(patch: &JsonValue, key: &str) -> Option<String> {
    match patch_get(patch, key)? {
        JsonValue::Null => None,
        JsonValue::String(s) => Some(s.clone()),
        JsonValue::Number(n) => Some(n.to_string()),
        JsonValue::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
        _ => None,
    }
}
fn patch_f64(patch: &JsonValue, key: &str) -> Option<f64> {
    match patch_get(patch, key)? {
        JsonValue::Number(n) => n.as_f64(),
        JsonValue::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}
fn patch_i64(patch: &JsonValue, key: &str) -> Option<i64> {
    match patch_get(patch, key)? {
        JsonValue::Number(n) => n.as_i64(),
        JsonValue::String(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}
fn patch_bool(patch: &JsonValue, key: &str) -> Option<bool> {
    match patch_get(patch, key)? {
        JsonValue::Bool(b) => Some(*b),
        JsonValue::Number(n) => n.as_i64().map(|x| x != 0),
        JsonValue::String(s) => match s.trim().to_lowercase().as_str() {
            "1" | "true" | "yes" | "si" | "sí" => Some(true),
            "0" | "false" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

async fn ensure_config_rows<C: Writer>(conn: &C) -> AppResult<()> {
    conn.execute("INSERT OR IGNORE INTO Business_Settings (ID) VALUES (1);", ())
        .await
        .map_err(db_err)?;
    conn.execute("INSERT OR IGNORE INTO Ticket_Settings (ID) VALUES (1);", ())
        .await
        .map_err(db_err)?;
    conn.execute("INSERT OR IGNORE INTO Contact_Settings (ID) VALUES (1);", ())
        .await
        .map_err(db_err)?;
    Ok(())
}

#[async_trait]
impl ConfiguracionRepository for SqliteConfiguracionRepository {
    async fn get_business(&self) -> AppResult<BusinessSettings> {
        let g = self.db.write().await;
        let conn = &g;
        ensure_config_rows(conn).await?;
        let mut rows = conn
            .query(
                "SELECT Business_Name, Logo_DataUrl, Direccion, Telefono, CIF, Mensaje_Footer, IVA_Percent FROM Business_Settings WHERE ID=1 LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Business_Settings (ID=1)"))?;
        let g = |idx: i32| row.get_value(idx).map_err(db_err);
        Ok(BusinessSettings {
            business_name: v_string(g(0)?).unwrap_or_else(|| "TPV".to_string()),
            logo_data_url: v_string(g(1)?),
            direccion: v_string(g(2)?).unwrap_or_default(),
            telefono: v_string(g(3)?).unwrap_or_default(),
            cif: v_string(g(4)?).unwrap_or_default(),
            mensaje_footer: v_string(g(5)?).unwrap_or_else(|| "¡Gracias por su visita!".to_string()),
            iva_percent: v_f64(g(6)?).unwrap_or(10.0),
        })
    }

    async fn get_ticket(&self) -> AppResult<TicketSettings> {
        let g = self.db.write().await;
        let conn = &g;
        ensure_config_rows(conn).await?;
        let mut rows = conn
            .query(
                "SELECT Show_Logo, Show_BusinessName, Show_Address, Show_Phone, Show_CIF, Show_DateTime, Show_LineItems, Show_BaseAndIVA, Show_Total, Show_FooterMessage, Paper_Width_Mm, Paper_Dpi, Chars_Per_Line, Margin_Top_Mm, Margin_Bottom_Mm, Margin_Left_Mm, Margin_Right_Mm, Font_Scale FROM Ticket_Settings WHERE ID=1 LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Ticket_Settings (ID=1)"))?;
        let getb = |idx: i32| -> AppResult<bool> {
            Ok(value_to_bool(row.get_value(idx).map_err(db_err)?).unwrap_or(true))
        };
        let paper_width_mm =
            clamp_paper_width_mm(v_i64(row.get_value(10).map_err(db_err)?).unwrap_or(80));
        let paper_dpi = clamp_paper_dpi(v_i64(row.get_value(11).map_err(db_err)?).unwrap_or(203));
        let chars_per_line =
            clamp_chars_per_line(v_i64(row.get_value(12).map_err(db_err)?).unwrap_or(42));
        let margin_top_mm = clamp_margin_mm(v_f64(row.get_value(13).map_err(db_err)?).unwrap_or(0.0));
        let margin_bottom_mm =
            clamp_margin_mm(v_f64(row.get_value(14).map_err(db_err)?).unwrap_or(0.0));
        let margin_left_mm =
            clamp_margin_mm(v_f64(row.get_value(15).map_err(db_err)?).unwrap_or(0.0));
        let margin_right_mm =
            clamp_margin_mm(v_f64(row.get_value(16).map_err(db_err)?).unwrap_or(0.0));
        let font_scale = clamp_font_scale(v_f64(row.get_value(17).map_err(db_err)?).unwrap_or(1.0));
        Ok(TicketSettings {
            show_logo: getb(0)?,
            show_business_name: getb(1)?,
            show_address: getb(2)?,
            show_phone: getb(3)?,
            show_cif: getb(4)?,
            show_date_time: getb(5)?,
            show_line_items: getb(6)?,
            show_base_and_iva: getb(7)?,
            show_total: getb(8)?,
            show_footer_message: getb(9)?,
            paper_width_mm,
            paper_dpi,
            chars_per_line,
            margin_top_mm,
            margin_bottom_mm,
            margin_left_mm,
            margin_right_mm,
            font_scale,
        })
    }

    async fn patch_business(&self, patch: &JsonValue) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;
        ensure_config_rows(conn).await?;

        let mut sets: Vec<&str> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        if patch_has(patch, "business_name") {
            if let Some(v) = patch_string(patch, "business_name") {
                sets.push("Business_Name = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "logo_data_url") {
            match patch_get(patch, "logo_data_url") {
                Some(JsonValue::Null) => {
                    sets.push("Logo_DataUrl = ?");
                    args.push(Value::Null);
                }
                Some(JsonValue::String(s)) => {
                    sets.push("Logo_DataUrl = ?");
                    if s.trim().is_empty() {
                        args.push(Value::Null);
                    } else {
                        args.push(Value::Text(s.clone()));
                    }
                }
                _ => {}
            }
        }
        if patch_has(patch, "direccion") {
            if let Some(v) = patch_string(patch, "direccion") {
                sets.push("Direccion = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "telefono") {
            if let Some(v) = patch_string(patch, "telefono") {
                sets.push("Telefono = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "cif") {
            if let Some(v) = patch_string(patch, "cif") {
                sets.push("CIF = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "mensaje_footer") {
            if let Some(v) = patch_string(patch, "mensaje_footer") {
                sets.push("Mensaje_Footer = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "iva_percent") {
            if let Some(v) = patch_f64(patch, "iva_percent") {
                sets.push("IVA_Percent = ?");
                args.push(Value::Real(v));
            }
        }

        if sets.is_empty() {
            return Ok(());
        }
        sets.push("Updated_At = datetime('now','localtime')");
        let sql = format!("UPDATE Business_Settings SET {} WHERE ID = 1;", sets.join(", "));

        let affected = conn.execute(&sql, args).await.map_err(db_err)?;
        if affected == 0 {
            return Err(AppError::not_found("No existe Business_Settings (ID=1)"));
        }
        Ok(())
    }

    async fn get_contact(&self) -> AppResult<ContactSettings> {
        let g = self.db.write().await;
        let conn = &g;
        ensure_config_rows(conn).await?;
        let mut rows = conn
            .query(
                "SELECT Recovery_Email, Contact_Email, Contact_Phone FROM Contact_Settings WHERE ID=1 LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Contact_Settings (ID=1)"))?;
        let g = |idx: i32| row.get_value(idx).map_err(db_err);
        Ok(ContactSettings {
            recovery_email: v_string(g(0)?).unwrap_or_default(),
            contact_email: v_string(g(1)?).unwrap_or_default(),
            contact_phone: v_string(g(2)?).unwrap_or_default(),
        })
    }

    async fn patch_contact(&self, patch: &JsonValue) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;
        ensure_config_rows(conn).await?;

        let mut sets: Vec<&str> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        if patch_has(patch, "recovery_email") {
            if let Some(v) = patch_string(patch, "recovery_email") {
                sets.push("Recovery_Email = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "contact_email") {
            if let Some(v) = patch_string(patch, "contact_email") {
                sets.push("Contact_Email = ?");
                args.push(Value::Text(v));
            }
        }
        if patch_has(patch, "contact_phone") {
            if let Some(v) = patch_string(patch, "contact_phone") {
                sets.push("Contact_Phone = ?");
                args.push(Value::Text(v));
            }
        }

        if sets.is_empty() {
            return Ok(());
        }
        sets.push("Updated_At = datetime('now','localtime')");
        let sql = format!("UPDATE Contact_Settings SET {} WHERE ID = 1;", sets.join(", "));

        let affected = conn.execute(&sql, args).await.map_err(db_err)?;
        if affected == 0 {
            return Err(AppError::not_found("No existe Contact_Settings (ID=1)"));
        }
        Ok(())
    }

    async fn patch_ticket(&self, patch: &JsonValue) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;
        ensure_config_rows(conn).await?;

        let mut sets: Vec<&str> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        for (key, col) in [
            ("show_logo", "Show_Logo = ?"),
            ("show_business_name", "Show_BusinessName = ?"),
            ("show_address", "Show_Address = ?"),
            ("show_phone", "Show_Phone = ?"),
            ("show_cif", "Show_CIF = ?"),
            ("show_date_time", "Show_DateTime = ?"),
            ("show_line_items", "Show_LineItems = ?"),
            ("show_base_and_iva", "Show_BaseAndIVA = ?"),
            ("show_total", "Show_Total = ?"),
            ("show_footer_message", "Show_FooterMessage = ?"),
        ] {
            if let Some(v) = patch_bool(patch, key) {
                sets.push(col);
                args.push(Value::Integer(bool_to_i64(v)));
            }
        }

        if let Some(v) = patch_i64(patch, "paper_width_mm") {
            sets.push("Paper_Width_Mm = ?");
            args.push(Value::Integer(clamp_paper_width_mm(v)));
        }
        if let Some(v) = patch_i64(patch, "paper_dpi") {
            sets.push("Paper_Dpi = ?");
            args.push(Value::Integer(clamp_paper_dpi(v)));
        }
        if let Some(v) = patch_i64(patch, "chars_per_line") {
            sets.push("Chars_Per_Line = ?");
            args.push(Value::Integer(clamp_chars_per_line(v)));
        }
        for (key, col) in [
            ("margin_top_mm", "Margin_Top_Mm = ?"),
            ("margin_bottom_mm", "Margin_Bottom_Mm = ?"),
            ("margin_left_mm", "Margin_Left_Mm = ?"),
            ("margin_right_mm", "Margin_Right_Mm = ?"),
        ] {
            if let Some(v) = patch_f64(patch, key) {
                sets.push(col);
                args.push(Value::Real(clamp_margin_mm(v)));
            }
        }
        if let Some(v) = patch_f64(patch, "font_scale") {
            sets.push("Font_Scale = ?");
            args.push(Value::Real(clamp_font_scale(v)));
        }

        if sets.is_empty() {
            return Ok(());
        }
        sets.push("Updated_At = datetime('now','localtime')");
        let sql = format!("UPDATE Ticket_Settings SET {} WHERE ID = 1;", sets.join(", "));

        let affected = conn.execute(&sql, args).await.map_err(db_err)?;
        if affected == 0 {
            return Err(AppError::not_found("No existe Ticket_Settings (ID=1)"));
        }
        Ok(())
    }
}
