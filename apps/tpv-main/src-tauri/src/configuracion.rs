// src-tauri/src/config.rs
use libsql::{Connection, Value};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{get_db, AppState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BusinessSettings {
    pub business_name: String,
    pub logo_data_url: Option<String>,
    pub direccion: String,
    pub telefono: String,
    pub cif: String,
    pub mensaje_footer: String,
    pub iva_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketSettings {
    pub show_logo: bool,
    pub show_business_name: bool,
    pub show_address: bool,
    pub show_phone: bool,
    pub show_cif: bool,
    pub show_date_time: bool,
    pub show_line_items: bool,
    pub show_base_and_iva: bool,
    pub show_total: bool,
    pub show_footer_message: bool,
    pub paper_width_mm: i64,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct ConfigPatchArgs {
    pub op_id: String,
    pub patch: JsonValue,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   Helpers básicos
========================================================= */

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

fn normalize_required(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();

    if out.is_empty() {
        return Err(format!("{field} required"));
    }

    Ok(out)
}

fn should_enqueue_outbox(v: Option<bool>) -> bool {
    v.unwrap_or(true)
}

fn stable_json_string(value: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("json serialize error: {e}"))
}

fn serialize_result_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("result_json serialize error: {e}"))
}

fn parse_result_json<T: DeserializeOwned>(raw: Option<String>) -> Result<T, String> {
    let txt = raw.ok_or_else(|| "applied_result_missing".to_string())?;
    serde_json::from_str::<T>(&txt).map_err(|e| format!("applied_result_invalid: {e}"))
}

fn sha256_hex_str(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    let out = hasher.finalize();

    out.iter().map(|b| format!("{:02x}", b)).collect::<String>()
}

fn bool_to_i64(b: bool) -> i64 {
    if b {
        1
    } else {
        0
    }
}

fn value_to_string(v: Value) -> Option<String> {
    match v {
        Value::Text(s) => Some(s),
        Value::Null => None,
        Value::Integer(n) => Some(n.to_string()),
        Value::Real(n) => Some(n.to_string()),
        _ => None,
    }
}

fn value_to_bool(v: Value) -> Option<bool> {
    match v {
        Value::Integer(n) => Some(n != 0),
        Value::Real(n) => Some(n != 0.0),
        Value::Text(s) => {
            let u = s.trim().to_lowercase();

            match u.as_str() {
                "1" | "true" | "yes" | "si" | "sí" => Some(true),
                "0" | "false" | "no" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

fn value_to_f64(v: Value) -> Option<f64> {
    match v {
        Value::Real(n) => Some(n),
        Value::Integer(n) => Some(n as f64),
        Value::Text(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

fn value_to_i64(v: Value) -> Option<i64> {
    match v {
        Value::Integer(n) => Some(n),
        Value::Real(n) => Some(n as i64),
        Value::Text(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}

fn clamp_paper_width_mm(n: i64) -> i64 {
    match n {
        58 | 80 | 112 => n,
        _ => 80,
    }
}

fn patch_get<'a>(patch: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    patch.as_object()?.get(key)
}

fn patch_has(patch: &JsonValue, key: &str) -> bool {
    patch
        .as_object()
        .map(|obj| obj.contains_key(key))
        .unwrap_or(false)
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
        JsonValue::String(s) => {
            let u = s.trim().to_lowercase();

            match u.as_str() {
                "1" | "true" | "yes" | "si" | "sí" => Some(true),
                "0" | "false" | "no" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

async fn tx_begin(db: &Connection) -> Result<(), String> {
    db.execute("BEGIN;", ()).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn tx_commit(db: &Connection) -> Result<(), String> {
    db.execute("COMMIT;", ()).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn tx_rollback(db: &Connection) {
    let _ = db.execute("ROLLBACK;", ()).await;
}

/* =========================================================
   Applied operations helpers
========================================================= */

#[derive(Debug, Clone)]
struct AppliedOperationRow {
    command_name: String,
    request_hash: String,
    status: String,
    result_json: Option<String>,
    error_text: Option<String>,
}

async fn applied_get_by_op_id(
    conn: &Connection,
    op_id: &str,
) -> Result<Option<AppliedOperationRow>, String> {
    let mut rows = conn
        .query(
            r#"
            SELECT
              Command_Name,
              Request_Hash,
              Status,
              Result_Json,
              Error_Text
            FROM Applied_Operations
            WHERE Op_Id = ?1
            LIMIT 1;
            "#,
            vec![Value::Text(op_id.to_string())],
        )
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(None);
    };

    Ok(Some(AppliedOperationRow {
        command_name: value_to_string(row.get_value(0).map_err(|e| e.to_string())?)
            .unwrap_or_default(),
        request_hash: value_to_string(row.get_value(1).map_err(|e| e.to_string())?)
            .unwrap_or_default(),
        status: value_to_string(row.get_value(2).map_err(|e| e.to_string())?)
            .unwrap_or_else(|| "PROCESSING".to_string()),
        result_json: match row.get_value(3).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => value_to_string(v),
        },
        error_text: match row.get_value(4).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => value_to_string(v),
        },
    }))
}

fn applied_assert_same_request(
    row: &AppliedOperationRow,
    command_name: &str,
    request_hash: &str,
) -> Result<(), String> {
    if row.command_name != command_name {
        return Err("applied_op_command_mismatch".into());
    }

    if row.request_hash != request_hash {
        return Err("applied_op_request_mismatch".into());
    }

    Ok(())
}

async fn applied_insert_processing(
    conn: &Connection,
    op_id: &str,
    command_name: &str,
    request_hash: &str,
) -> Result<(), String> {
    let now = now_ms();

    conn.execute(
        r#"
        INSERT INTO Applied_Operations (
          Op_Id,
          Command_Name,
          Request_Hash,
          Device_Id,
          Status,
          Result_Json,
          Error_Text,
          Created_At_Ms,
          Applied_At_Ms,
          Updated_At_Ms
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          NULL,
          'PROCESSING',
          NULL,
          NULL,
          ?4,
          NULL,
          ?5
        );
        "#,
        vec![
            Value::Text(op_id.to_string()),
            Value::Text(command_name.to_string()),
            Value::Text(request_hash.to_string()),
            Value::Integer(now),
            Value::Integer(now),
        ],
    )
    .await
    .map_err(|e| format!("DB execute error: {e}"))?;

    Ok(())
}

async fn applied_mark_applied(
    conn: &Connection,
    op_id: &str,
    result_json: &str,
) -> Result<(), String> {
    let now = now_ms();

    conn.execute(
        r#"
        UPDATE Applied_Operations
        SET
          Status = 'APPLIED',
          Result_Json = ?2,
          Error_Text = NULL,
          Applied_At_Ms = ?3,
          Updated_At_Ms = ?4
        WHERE Op_Id = ?1;
        "#,
        vec![
            Value::Text(op_id.to_string()),
            Value::Text(result_json.to_string()),
            Value::Integer(now),
            Value::Integer(now),
        ],
    )
    .await
    .map_err(|e| format!("DB execute error: {e}"))?;

    Ok(())
}

/* =========================================================
   Outbox helpers
========================================================= */

async fn outbox_existing_by_op_id(
    conn: &Connection,
    op_id: &str,
) -> Result<Option<(String, String)>, String> {
    let mut rows = conn
        .query(
            r#"
            SELECT Command_Name, Payload_Json
            FROM Outbox_Operations
            WHERE Op_Id = ?1
            LIMIT 1;
            "#,
            vec![Value::Text(op_id.to_string())],
        )
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(None);
    };

    let command_name =
        value_to_string(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();

    let payload_json = value_to_string(row.get_value(1).map_err(|e| e.to_string())?)
        .unwrap_or_else(|| "{}".to_string());

    Ok(Some((command_name, payload_json)))
}

async fn outbox_assert_replay_or_unused(
    conn: &Connection,
    op_id: &str,
    command_name: &str,
    payload_json: &str,
) -> Result<bool, String> {
    let Some((existing_command_name, existing_payload_json)) =
        outbox_existing_by_op_id(conn, op_id).await?
    else {
        return Ok(false);
    };

    if existing_command_name != command_name {
        return Err("outbox_op_command_mismatch".into());
    }

    if existing_payload_json != payload_json {
        return Err("outbox_op_payload_mismatch".into());
    }

    Ok(true)
}

async fn outbox_insert_row(
    conn: &Connection,
    op_id: &str,
    command_name: &str,
    payload_json: &str,
) -> Result<(), String> {
    let now = now_ms();

    conn.execute(
        r#"
        INSERT INTO Outbox_Operations (
          Op_Id,
          Command_Name,
          Payload_Json,
          Status,
          Attempt_Count,
          Last_Error,
          Created_At_Ms,
          Updated_At_Ms,
          Last_Attempt_At_Ms
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          'PENDING',
          0,
          NULL,
          ?4,
          ?5,
          NULL
        );
        "#,
        vec![
            Value::Text(op_id.to_string()),
            Value::Text(command_name.to_string()),
            Value::Text(payload_json.to_string()),
            Value::Integer(now),
            Value::Integer(now),
        ],
    )
    .await
    .map_err(|e| format!("DB execute error: {e}"))?;

    Ok(())
}

async fn maybe_insert_outbox(
    conn: &Connection,
    enqueue_outbox: bool,
    op_id: &str,
    command_name: &str,
    payload_json: &str,
) -> Result<(), String> {
    if enqueue_outbox {
        outbox_insert_row(conn, op_id, command_name, payload_json).await?;
    }

    Ok(())
}

/* =========================================================
   Readers internos
========================================================= */

async fn ensure_config_rows(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO Business_Settings (ID) VALUES (1);",
        (),
    )
    .await
    .map_err(|e| format!("ensure_business_settings_failed:{e}"))?;

    conn.execute("INSERT OR IGNORE INTO Ticket_Settings (ID) VALUES (1);", ())
        .await
        .map_err(|e| format!("ensure_ticket_settings_failed:{e}"))?;

    Ok(())
}

async fn read_business_settings(conn: &Connection) -> Result<BusinessSettings, String> {
    ensure_config_rows(conn).await?;

    let mut rows = conn
        .query(
            r#"
            SELECT
              Business_Name,
              Logo_DataUrl,
              Direccion,
              Telefono,
              CIF,
              Mensaje_Footer,
              IVA_Percent
            FROM Business_Settings
            WHERE ID=1
            LIMIT 1;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let row = rows
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No existe Business_Settings (ID=1)".to_string())?;

    let business_name = value_to_string(row.get_value(0).map_err(|e| e.to_string())?)
        .unwrap_or_else(|| "TPV".to_string());

    let logo_data_url = value_to_string(row.get_value(1).map_err(|e| e.to_string())?);

    let direccion =
        value_to_string(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();

    let telefono =
        value_to_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_default();

    let cif = value_to_string(row.get_value(4).map_err(|e| e.to_string())?).unwrap_or_default();

    let mensaje_footer = value_to_string(row.get_value(5).map_err(|e| e.to_string())?)
        .unwrap_or_else(|| "¡Gracias por su visita!".to_string());

    let iva_percent = value_to_f64(row.get_value(6).map_err(|e| e.to_string())?).unwrap_or(10.0);

    Ok(BusinessSettings {
        business_name,
        logo_data_url,
        direccion,
        telefono,
        cif,
        mensaje_footer,
        iva_percent,
    })
}

async fn read_ticket_settings(conn: &Connection) -> Result<TicketSettings, String> {
    ensure_config_rows(conn).await?;

    let mut rows = conn
        .query(
            r#"
            SELECT
              Show_Logo,
              Show_BusinessName,
              Show_Address,
              Show_Phone,
              Show_CIF,
              Show_DateTime,
              Show_LineItems,
              Show_BaseAndIVA,
              Show_Total,
              Show_FooterMessage,
              Paper_Width_Mm
            FROM Ticket_Settings
            WHERE ID=1
            LIMIT 1;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let row = rows
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No existe Ticket_Settings (ID=1)".to_string())?;

    let getb = |i: i32| -> Result<bool, String> {
        let v = row.get_value(i).map_err(|e| e.to_string())?;
        Ok(value_to_bool(v).unwrap_or(true))
    };

    let paper_width_mm = {
        let v = row.get_value(10).map_err(|e| e.to_string())?;
        clamp_paper_width_mm(value_to_i64(v).unwrap_or(80))
    };

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
    })
}

/* =========================================================
   Aplicadores SIN outbox
========================================================= */

async fn apply_business_patch_core(db: &Connection, patch: &JsonValue) -> Result<(), String> {
    ensure_config_rows(db).await?;

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

                let t = s.trim().to_string();
                if t.is_empty() {
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

    let sql = format!(
        r#"
        UPDATE Business_Settings
        SET {}
        WHERE ID = 1;
        "#,
        sets.join(", ")
    );

    let affected = db.execute(&sql, args).await.map_err(|e| e.to_string())?;

    if affected == 0 {
        return Err("No existe Business_Settings (ID=1)".into());
    }

    Ok(())
}

async fn apply_ticket_patch_core(db: &Connection, patch: &JsonValue) -> Result<(), String> {
    ensure_config_rows(db).await?;

    let mut sets: Vec<&str> = Vec::new();
    let mut args: Vec<Value> = Vec::new();

    if let Some(v) = patch_bool(patch, "show_logo") {
        sets.push("Show_Logo = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_business_name") {
        sets.push("Show_BusinessName = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_address") {
        sets.push("Show_Address = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_phone") {
        sets.push("Show_Phone = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_cif") {
        sets.push("Show_CIF = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_date_time") {
        sets.push("Show_DateTime = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_line_items") {
        sets.push("Show_LineItems = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_base_and_iva") {
        sets.push("Show_BaseAndIVA = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_total") {
        sets.push("Show_Total = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_bool(patch, "show_footer_message") {
        sets.push("Show_FooterMessage = ?");
        args.push(Value::Integer(bool_to_i64(v)));
    }

    if let Some(v) = patch_i64(patch, "paper_width_mm") {
        sets.push("Paper_Width_Mm = ?");
        args.push(Value::Integer(clamp_paper_width_mm(v)));
    }

    if sets.is_empty() {
        return Ok(());
    }

    sets.push("Updated_At = datetime('now','localtime')");

    let sql = format!(
        r#"
        UPDATE Ticket_Settings
        SET {}
        WHERE ID = 1;
        "#,
        sets.join(", ")
    );

    let affected = db.execute(&sql, args).await.map_err(|e| e.to_string())?;

    if affected == 0 {
        return Err("No existe Ticket_Settings (ID=1)".into());
    }

    Ok(())
}

/* =========================================================
   Runner común de writes
========================================================= */

#[derive(Debug, Clone, Copy)]
enum ConfigPatchKind {
    Business,
    Ticket,
}

fn config_command_name(kind: ConfigPatchKind) -> &'static str {
    match kind {
        ConfigPatchKind::Business => "config.patchBusinessSettings",
        ConfigPatchKind::Ticket => "config.patchTicketSettings",
    }
}

async fn run_config_patch(
    db: &Connection,
    args: ConfigPatchArgs,
    kind: ConfigPatchKind,
    force_no_outbox: bool,
) -> Result<String, String> {
    let enqueue_outbox = if force_no_outbox {
        false
    } else {
        should_enqueue_outbox(args.enqueue_outbox)
    };

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = config_command_name(kind);

    let domain_args = json!({
        "patch": args.patch.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<String>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = stable_json_string(&json!({
        "op_id": op_id.clone(),
        "command_name": command_name,
        "args": domain_args
    }))?;

    if outbox_assert_replay_or_unused(db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    tx_begin(db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(db, &op_id, command_name, &request_hash).await?;

        match kind {
            ConfigPatchKind::Business => {
                apply_business_patch_core(db, &args.patch).await?;
            }
            ConfigPatchKind::Ticket => {
                apply_ticket_patch_core(db, &args.patch).await?;
            }
        }

        maybe_insert_outbox(db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            tx_commit(db).await?;
            Ok(result)
        }
        Err(err) => {
            tx_rollback(db).await;
            Err(err)
        }
    }
}

/* =========================================================
   Commands lectura
========================================================= */

#[tauri::command]
pub async fn config_get_business_settings(
    state: State<'_, AppState>,
) -> Result<BusinessSettings, String> {
    let db = get_db(&state).await?;

    read_business_settings(&db).await
}

#[tauri::command]
pub async fn config_get_ticket_settings(
    state: State<'_, AppState>,
) -> Result<TicketSettings, String> {
    let db = get_db(&state).await?;

    read_ticket_settings(&db).await
}

/* =========================================================
   Commands write CON outbox opcional
========================================================= */

#[tauri::command]
pub async fn config_patch_business_settings(
    state: State<'_, AppState>,
    args: ConfigPatchArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    run_config_patch(&db, args, ConfigPatchKind::Business, false).await
}

#[tauri::command]
pub async fn config_patch_ticket_settings(
    state: State<'_, AppState>,
    args: ConfigPatchArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    run_config_patch(&db, args, ConfigPatchKind::Ticket, false).await
}

/* =========================================================
   Compatibilidad temporal
   La API nueva ya NO usa estos comandos.
   Se mantienen por si siguen registrados en invoke_handler.
========================================================= */

#[tauri::command]
pub async fn config_patch_business_settings_after_remote_ok(
    state: State<'_, AppState>,
    args: ConfigPatchArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    run_config_patch(&db, args, ConfigPatchKind::Business, true).await
}

#[tauri::command]
pub async fn config_patch_ticket_settings_after_remote_ok(
    state: State<'_, AppState>,
    args: ConfigPatchArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    run_config_patch(&db, args, ConfigPatchKind::Ticket, true).await
}
