// src-tauri/src/cloud_sync.rs
use crate::{get_db, AppState};

use chrono::Datelike;
use libsql::{params, Connection, Transaction, Value};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::{fs, path::PathBuf, sync::Arc};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Deserialize)]
pub struct CloudChange {
    #[serde(alias = "idChange")]
    pub id_change: i64,

    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "commandName")]
    pub command_name: String,

    #[serde(default = "default_command_version", alias = "commandVersion")]
    pub command_version: i64,

    #[serde(default, alias = "deviceId")]
    pub device_id: Option<String>,

    #[serde(alias = "payloadJson")]
    pub payload_json: String,

    #[serde(default, alias = "resultJson")]
    pub result_json: Option<String>,

    #[serde(default, alias = "createdAtMs")]
    pub created_at_ms: i64,
}

fn default_command_version() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyCloudChangesResult {
    pub ok: bool,
    pub applied: i64,
    pub skipped: i64,
    pub last_cloud_change_id: i64,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncApplyCloudChangesArgs {
    pub changes: Vec<CloudChange>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SyncMarkLocalOperationAppliedArgs {
    pub op_id: String,
    pub command_name: String,
    pub source: String,
}

#[derive(Debug, Clone)]
struct ParsedCloudCommand {
    op_id: String,
    command_name: String,
    args: JsonValue,
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

fn clean_opt_string(input: Option<String>) -> Option<String> {
    input.and_then(|s| {
        let t = s.trim().to_string();

        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

fn normalize_source(input: &str) -> Result<String, String> {
    let source = normalize_required(input, "source")?;

    if !["afterRemoteOk", "cloudSync", "outbox"].contains(&source.as_str()) {
        return Err("bad_source".into());
    }

    Ok(source)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir_failed:{e}"))
}

fn license_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("license_state.json"))
}

fn read_own_device_id(app: &AppHandle) -> Option<String> {
    let path = license_state_path(app).ok()?;
    let txt = fs::read_to_string(path).ok()?;
    let root = serde_json::from_str::<JsonValue>(&txt).ok()?;

    let device_id = root
        .get("device_id")
        .or_else(|| root.get("deviceId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if device_id.is_empty() {
        None
    } else {
        Some(device_id)
    }
}

/* =========================================================
   Helpers Value -> Rust
========================================================= */

fn v_i64(v: Value) -> Option<i64> {
    match v {
        Value::Integer(n) => Some(n),
        Value::Real(n) => Some(n as i64),
        Value::Text(s) => s.parse::<i64>().ok(),
        _ => None,
    }
}

fn v_f64(v: Value) -> Option<f64> {
    match v {
        Value::Real(n) => Some(n),
        Value::Integer(n) => Some(n as f64),
        Value::Text(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

fn v_string(v: Value) -> Option<String> {
    match v {
        Value::Text(s) => Some(s),
        Value::Integer(n) => Some(n.to_string()),
        Value::Real(n) => Some(n.to_string()),
        Value::Null => None,
        _ => None,
    }
}

/* =========================================================
   Helpers JSON args
========================================================= */

fn json_field<'a>(obj: &'a JsonValue, names: &[&str]) -> Option<&'a JsonValue> {
    let map = obj.as_object()?;

    for name in names {
        if let Some(v) = map.get(*name) {
            return Some(v);
        }
    }

    None
}

fn json_string(v: &JsonValue) -> Option<String> {
    match v {
        JsonValue::String(s) => {
            let t = s.trim().to_string();

            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }
        JsonValue::Number(n) => Some(n.to_string()),
        JsonValue::Bool(b) => Some(if *b { "1" } else { "0" }.to_string()),
        _ => None,
    }
}

fn json_i64(v: &JsonValue) -> Option<i64> {
    match v {
        JsonValue::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        JsonValue::String(s) => s.trim().parse::<i64>().ok(),
        JsonValue::Bool(b) => Some(if *b { 1 } else { 0 }),
        _ => None,
    }
}

fn json_f64(v: &JsonValue) -> Option<f64> {
    match v {
        JsonValue::Number(n) => n.as_f64(),
        JsonValue::String(s) => s.trim().parse::<f64>().ok(),
        JsonValue::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn json_bool(v: &JsonValue) -> Option<bool> {
    match v {
        JsonValue::Bool(b) => Some(*b),
        JsonValue::Number(n) => n.as_i64().map(|x| x != 0),
        JsonValue::String(s) => {
            let t = s.trim().to_lowercase();

            match t.as_str() {
                "true" | "1" | "yes" | "y" | "si" | "sí" => Some(true),
                "false" | "0" | "no" | "n" => Some(false),
                _ => None,
            }
        }
        _ => None,
    }
}

fn arg_string(args: &JsonValue, names: &[&str]) -> Option<String> {
    json_field(args, names).and_then(json_string)
}

fn arg_required_string(args: &JsonValue, names: &[&str], field: &str) -> Result<String, String> {
    let value = arg_string(args, names).unwrap_or_default();
    normalize_required(&value, field)
}

fn arg_opt_string(args: &JsonValue, names: &[&str]) -> Option<String> {
    clean_opt_string(arg_string(args, names))
}

fn arg_i64(args: &JsonValue, names: &[&str]) -> Option<i64> {
    json_field(args, names).and_then(json_i64)
}

fn arg_required_i64(args: &JsonValue, names: &[&str], field: &str) -> Result<i64, String> {
    let n = arg_i64(args, names).unwrap_or(0);

    if n <= 0 {
        return Err(format!("{field} required"));
    }

    Ok(n)
}

fn arg_f64(args: &JsonValue, names: &[&str]) -> Option<f64> {
    json_field(args, names).and_then(json_f64)
}

fn arg_bool(args: &JsonValue, names: &[&str], fallback: bool) -> bool {
    json_field(args, names)
        .and_then(json_bool)
        .unwrap_or(fallback)
}

fn arg_ids(args: &JsonValue, names: &[&str]) -> Vec<i64> {
    let Some(raw) = json_field(args, names) else {
        return vec![];
    };

    let mut out = if let Some(arr) = raw.as_array() {
        arr.iter().filter_map(json_i64).collect::<Vec<_>>()
    } else if let Some(s) = raw.as_str() {
        s.split(',')
            .filter_map(|x| x.trim().parse::<i64>().ok())
            .collect::<Vec<_>>()
    } else {
        vec![]
    };

    out.retain(|n| *n > 0);
    out.sort_unstable();
    out.dedup();
    out
}

fn json_to_libsql_value(v: &JsonValue) -> Result<Value, String> {
    match v {
        JsonValue::Null => Ok(Value::Null),
        JsonValue::Bool(b) => Ok(Value::Integer(if *b { 1 } else { 0 })),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Value::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(Value::Real(f))
            } else {
                Err("bad_json_number".into())
            }
        }
        JsonValue::String(s) => Ok(Value::Text(s.clone())),
        _ => Err("unsupported_sql_arg_json".into()),
    }
}

fn value_text_or_null(v: Option<String>) -> Value {
    v.map(Value::Text).unwrap_or(Value::Null)
}

fn value_i64_or_null(v: Option<i64>) -> Value {
    v.filter(|n| *n > 0)
        .map(Value::Integer)
        .unwrap_or(Value::Null)
}

fn find_i64_deep(value: &JsonValue, names: &[&str]) -> Option<i64> {
    if let Some(n) = json_i64(value) {
        return Some(n);
    }

    if let Some(obj) = value.as_object() {
        for name in names {
            if let Some(v) = obj.get(*name) {
                if let Some(n) = json_i64(v) {
                    if n > 0 {
                        return Some(n);
                    }
                }
            }
        }

        for v in obj.values() {
            if let Some(n) = find_i64_deep(v, names) {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }

    if let Some(arr) = value.as_array() {
        for v in arr {
            if let Some(n) = find_i64_deep(v, names) {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }

    None
}

fn id_from_args_or_result(
    args: &JsonValue,
    result_json: Option<&str>,
    names: &[&str],
    field: &str,
) -> Result<i64, String> {
    if let Some(n) = arg_i64(args, names).filter(|n| *n > 0) {
        return Ok(n);
    }

    if let Some(raw) = result_json {
        if let Ok(parsed) = serde_json::from_str::<JsonValue>(raw) {
            if let Some(n) = find_i64_deep(&parsed, names).filter(|n| *n > 0) {
                return Ok(n);
            }
        }
    }

    Err(format!("{field} required"))
}

fn json_value_is_falsey_noop(v: &JsonValue) -> bool {
    match v {
        JsonValue::Bool(b) => !*b,
        JsonValue::Number(n) => n.as_f64().map(|x| x == 0.0).unwrap_or(false),
        JsonValue::String(s) => {
            let t = s.trim().to_lowercase();
            matches!(t.as_str(), "false" | "0" | "no" | "noop" | "none" | "null")
        }
        JsonValue::Null => true,
        _ => false,
    }
}

fn result_json_indicates_noop(result_json: Option<&str>, keys: &[&str]) -> bool {
    let Some(raw) = result_json else {
        return false;
    };

    let Ok(parsed) = serde_json::from_str::<JsonValue>(raw) else {
        return false;
    };

    if json_value_is_falsey_noop(&parsed) {
        return true;
    }

    let Some(obj) = parsed.as_object() else {
        return false;
    };

    for key in keys {
        if let Some(v) = obj.get(*key) {
            if json_value_is_falsey_noop(v) {
                return true;
            }
        }
    }

    if let Some(v) = obj.get("result") {
        if json_value_is_falsey_noop(v) {
            return true;
        }
    }

    if let Some(data) = obj.get("data") {
        if json_value_is_falsey_noop(data) {
            return true;
        }

        if let Some(data_obj) = data.as_object() {
            for key in keys {
                if let Some(v) = data_obj.get(*key) {
                    if json_value_is_falsey_noop(v) {
                        return true;
                    }
                }
            }
        }
    }

    false
}

fn parse_cloud_command(change: &CloudChange) -> Result<ParsedCloudCommand, String> {
    let change_op_id = normalize_required(&change.op_id, "op_id")?;
    let change_command_name = normalize_required(&change.command_name, "command_name")?;

    let root: JsonValue = serde_json::from_str(&change.payload_json)
        .map_err(|e| format!("invalid_payload_json:{e}"))?;

    let payload_op_id = json_field(&root, &["op_id", "opId"])
        .and_then(json_string)
        .unwrap_or_else(|| change_op_id.clone());

    let payload_command_name = json_field(&root, &["command_name", "commandName"])
        .and_then(json_string)
        .unwrap_or_else(|| change_command_name.clone());

    if payload_op_id != change_op_id {
        return Err("payload_op_id_mismatch".into());
    }

    if payload_command_name != change_command_name {
        return Err("payload_command_name_mismatch".into());
    }

    let args = if let Some(args) = json_field(&root, &["args"]) {
        args.clone()
    } else if let Some(payload) = json_field(&root, &["payload"]) {
        if let Some(args) = json_field(payload, &["args"]) {
            args.clone()
        } else {
            return Err("payload_args required".into());
        }
    } else {
        return Err("payload_args required".into());
    };

    Ok(ParsedCloudCommand {
        op_id: payload_op_id,
        command_name: payload_command_name,
        args,
    })
}

/* =========================================================
   SQL helpers
========================================================= */

async fn tx_execute(tx: &Transaction, sql: &str, args: Vec<Value>) -> Result<u64, String> {
    tx.execute(sql, args)
        .await
        .map_err(|e| format!("sql_execute_failed:{e}"))
}

async fn tx_select_one_i64(
    tx: &Transaction,
    sql: &str,
    args: Vec<Value>,
) -> Result<Option<i64>, String> {
    let mut rows = tx
        .query(sql, args)
        .await
        .map_err(|e| format!("sql_query_failed:{e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("sql_row_failed:{e}"))?
    else {
        return Ok(None);
    };

    let v = row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?;

    Ok(v_i64(v))
}

async fn tx_select_one_f64(
    tx: &Transaction,
    sql: &str,
    args: Vec<Value>,
) -> Result<Option<f64>, String> {
    let mut rows = tx
        .query(sql, args)
        .await
        .map_err(|e| format!("sql_query_failed:{e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("sql_row_failed:{e}"))?
    else {
        return Ok(None);
    };

    let v = row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?;

    Ok(v_f64(v))
}

async fn tx_exists_by_id(
    tx: &Transaction,
    table: &str,
    column: &str,
    id: i64,
) -> Result<bool, String> {
    if id <= 0 {
        return Ok(false);
    }

    let sql = format!("SELECT 1 FROM {table} WHERE {column} = ?1 LIMIT 1;");

    Ok(tx_select_one_i64(tx, &sql, vec![Value::Integer(id)])
        .await?
        .is_some())
}

fn build_in_placeholders(start: i64, count: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start + i as i64))
        .collect::<Vec<_>>()
        .join(", ")
}

/* =========================================================
   Estado de sync / deduplicación
========================================================= */

async fn already_cloud_applied(tx: &Transaction, id_change: i64) -> Result<bool, String> {
    let mut rows = tx
        .query(
            "SELECT 1 FROM Cloud_Applied_Changes WHERE ID_Change = ?1 LIMIT 1;",
            params![id_change],
        )
        .await
        .map_err(|e| format!("cloud_applied_lookup_failed:{e}"))?;

    let row = rows
        .next()
        .await
        .map_err(|e| format!("cloud_applied_row_failed:{e}"))?;

    Ok(row.is_some())
}

async fn already_local_operation_applied(
    tx: &Transaction,
    op_id: &str,
    command_name: &str,
) -> Result<bool, String> {
    let mut rows = tx
        .query(
            "
            SELECT 1
            FROM Local_Applied_Operations
            WHERE Op_Id = ?1
              AND Command_Name = ?2
            LIMIT 1;
            ",
            params![op_id, command_name],
        )
        .await
        .map_err(|e| format!("local_applied_lookup_failed:{e}"))?;

    let row = rows
        .next()
        .await
        .map_err(|e| format!("local_applied_row_failed:{e}"))?;

    Ok(row.is_some())
}

async fn mark_cloud_applied(tx: &Transaction, change: &CloudChange) -> Result<(), String> {
    tx.execute(
        "
        INSERT OR IGNORE INTO Cloud_Applied_Changes (
            ID_Change,
            Op_Id,
            Command_Name,
            Device_Id,
            Applied_At_Ms
        )
        VALUES (?1, ?2, ?3, ?4, ?5);
        ",
        params![
            change.id_change,
            change.op_id.clone(),
            change.command_name.clone(),
            change.device_id.clone(),
            now_ms()
        ],
    )
    .await
    .map_err(|e| format!("mark_cloud_applied_failed:{e}"))?;

    Ok(())
}

async fn mark_local_operation_applied(
    tx: &Transaction,
    op_id: &str,
    command_name: &str,
    source: &str,
) -> Result<(), String> {
    tx.execute(
        "
        INSERT OR IGNORE INTO Local_Applied_Operations (
            Op_Id,
            Command_Name,
            Source,
            Applied_At_Ms
        )
        VALUES (?1, ?2, ?3, ?4);
        ",
        params![op_id, command_name, source, now_ms()],
    )
    .await
    .map_err(|e| format!("mark_local_operation_failed:{e}"))?;

    Ok(())
}

async fn set_last_cloud_change_id(tx: &Transaction, id_change: i64) -> Result<(), String> {
    tx.execute(
        "
        INSERT INTO Sync_State (Key, Value, Updated_At_Ms)
        VALUES ('last_cloud_change_id', ?1, ?2)
        ON CONFLICT(Key) DO UPDATE SET
            Value = excluded.Value,
            Updated_At_Ms = excluded.Updated_At_Ms;
        ",
        params![id_change.to_string(), now_ms()],
    )
    .await
    .map_err(|e| format!("set_last_cloud_change_id_failed:{e}"))?;

    Ok(())
}

async fn get_last_cloud_change_id_from_db(conn: &Connection) -> Result<i64, String> {
    let mut rows = conn
        .query(
            "
            SELECT Value
            FROM Sync_State
            WHERE Key = 'last_cloud_change_id'
            LIMIT 1;
            ",
            params![],
        )
        .await
        .map_err(|e| format!("sync_state_query_failed:{e}"))?;

    let row = rows
        .next()
        .await
        .map_err(|e| format!("sync_state_row_failed:{e}"))?;

    let Some(row) = row else {
        return Ok(0);
    };

    let value: String = row
        .get(0)
        .map_err(|e| format!("sync_state_value_failed:{e}"))?;

    Ok(value.parse::<i64>().unwrap_or(0))
}

/* =========================================================
   Helpers dominio comunes
========================================================= */

async fn trabajador_id_from_usuario(
    tx: &Transaction,
    id_usuario: Option<i64>,
) -> Result<Option<i64>, String> {
    let Some(idu) = id_usuario.filter(|n| *n > 0) else {
        return Ok(None);
    };

    tx_select_one_i64(
        tx,
        "SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario = ?1 LIMIT 1;",
        vec![Value::Integer(idu)],
    )
    .await
}

async fn trabajador_id_from_comanda(
    tx: &Transaction,
    id_comanda: i64,
) -> Result<Option<i64>, String> {
    if id_comanda <= 0 {
        return Ok(None);
    }

    tx_select_one_i64(
        tx,
        "SELECT ID_Trabajador FROM Comandas WHERE ID_Comanda = ?1 LIMIT 1;",
        vec![Value::Integer(id_comanda)],
    )
    .await
}

async fn resolve_trabajador_id_input(
    tx: &Transaction,
    id_maybe: Option<i64>,
) -> Result<Option<i64>, String> {
    let Some(x) = id_maybe.filter(|n| *n > 0) else {
        return Ok(None);
    };

    if tx_exists_by_id(tx, "Trabajadores", "ID_Trabajador", x).await? {
        return Ok(Some(x));
    }

    trabajador_id_from_usuario(tx, Some(x)).await
}

async fn find_barra_mesa_id(tx: &Transaction) -> Result<i64, String> {
    let id = tx_select_one_i64(
        tx,
        r#"
        SELECT ID_Mesa
        FROM Mesas
        WHERE Numero_Mesa = 'BARRA'
        LIMIT 1;
        "#,
        vec![],
    )
    .await?
    .unwrap_or(0);

    if id <= 0 {
        return Err("No existe una Mesa con Numero_Mesa='BARRA'.".into());
    }

    Ok(id)
}

async fn ensure_barra_mesa_local(tx: &Transaction) -> Result<i64, String> {
    let existing = tx_select_one_i64(
        tx,
        r#"
        SELECT ID_Mesa
        FROM Mesas
        WHERE Numero_Mesa = 'BARRA'
        LIMIT 1;
        "#,
        vec![],
    )
    .await?
    .unwrap_or(0);

    if existing > 0 {
        return Ok(existing);
    }

    let first_zone = tx_select_one_i64(
        tx,
        r#"
        SELECT ID_Zona
        FROM Zonas
        ORDER BY ID_Zona ASC
        LIMIT 1;
        "#,
        vec![],
    )
    .await?
    .unwrap_or(0);

    if first_zone <= 0 {
        tx_execute(
            tx,
            r#"
            INSERT INTO Zonas (
                Nombre_Zona,
                Room_Points,
                Updated_At
            )
            VALUES (
                'Salon',
                '[]',
                datetime('now','localtime')
            );
            "#,
            vec![],
        )
        .await?;
    }

    let zone_id = tx_select_one_i64(
        tx,
        r#"
        SELECT ID_Zona
        FROM Zonas
        ORDER BY ID_Zona ASC
        LIMIT 1;
        "#,
        vec![],
    )
    .await?
    .unwrap_or(0);

    if zone_id <= 0 {
        return Err("No se pudo crear/encontrar zona para BARRA.".into());
    }

    tx_execute(
        tx,
        r#"
        INSERT INTO Mesas (
            ID_Zona,
            Numero_Mesa,
            Capacidad,
            Ubicacion_X,
            Ubicacion_Y,
            Shape,
            Width,
            Height,
            Radius,
            Updated_At,
            Es_Sistema
        )
        VALUES (
            ?1,
            'BARRA',
            0,
            0,
            0,
            'rect',
            80,
            50,
            NULL,
            datetime('now','localtime'),
            1
        );
        "#,
        vec![Value::Integer(zone_id)],
    )
    .await?;

    find_barra_mesa_id(tx).await
}

async fn update_total_comanda(tx: &Transaction, id_comanda: i64) -> Result<(), String> {
    tx_execute(
        tx,
        r#"
        UPDATE Comandas
        SET Total_Comanda = (
          SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
          FROM Detalle_Comanda
          WHERE ID_Comanda = ?1
        )
        WHERE ID_Comanda = ?1;
        "#,
        vec![Value::Integer(id_comanda)],
    )
    .await?;

    Ok(())
}

/* =========================================================
   Aplicadores: Tareas
========================================================= */

async fn apply_tareas_set_asignaciones_core(
    tx: &Transaction,
    id_tarea: i64,
    ids_trabajadores: &[i64],
) -> Result<(), String> {
    if id_tarea <= 0 {
        return Err("id_tarea required".into());
    }

    if ids_trabajadores.is_empty() {
        tx_execute(
            tx,
            "DELETE FROM Tarea_Asignaciones WHERE ID_Tarea = ?1;",
            vec![Value::Integer(id_tarea)],
        )
        .await?;
    } else {
        let placeholders = build_in_placeholders(2, ids_trabajadores.len());

        let sql = format!(
            r#"
            DELETE FROM Tarea_Asignaciones
            WHERE ID_Tarea = ?1
              AND ID_Trabajador NOT IN ({});
            "#,
            placeholders
        );

        let mut sql_args = Vec::<Value>::with_capacity(1 + ids_trabajadores.len());
        sql_args.push(Value::Integer(id_tarea));

        for id_trabajador in ids_trabajadores {
            sql_args.push(Value::Integer(*id_trabajador));
        }

        tx_execute(tx, &sql, sql_args).await?;
    }

    for id_trabajador in ids_trabajadores {
        tx_execute(
            tx,
            r#"
            INSERT OR IGNORE INTO Tarea_Asignaciones (
              ID_Tarea,
              ID_Trabajador,
              Asignada_At,
              Estado
            )
            VALUES (
              ?1,
              ?2,
              datetime('now','localtime'),
              'PENDIENTE'
            );
            "#,
            vec![Value::Integer(id_tarea), Value::Integer(*id_trabajador)],
        )
        .await?;
    }

    Ok(())
}

async fn apply_tareas_create(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_tarea = id_from_args_or_result(
        args,
        result_json,
        &[
            "id_tarea",
            "idTarea",
            "ID_Tarea",
            "remote_id_tarea",
            "remoteIdTarea",
            "id",
        ],
        "id_tarea",
    )?;

    let titulo = arg_required_string(args, &["titulo", "Titulo"], "titulo")?;
    let descripcion = arg_opt_string(args, &["descripcion", "Descripcion"]);
    let fecha_limite = arg_opt_string(args, &["fecha_limite", "fechaLimite", "Fecha_Limite"]);
    let ids_trabajadores = arg_ids(args, &["ids_trabajadores", "idsTrabajadores"]);

    tx_execute(
        tx,
        r#"
        INSERT INTO Tareas (
          ID_Tarea,
          Titulo,
          Descripcion,
          Fecha_Limite,
          Estado
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          ?4,
          'ABIERTA'
        )
        ON CONFLICT(ID_Tarea) DO UPDATE SET
          Titulo = excluded.Titulo,
          Descripcion = excluded.Descripcion,
          Fecha_Limite = excluded.Fecha_Limite,
          Estado = COALESCE(Tareas.Estado, 'ABIERTA');
        "#,
        vec![
            Value::Integer(id_tarea),
            Value::Text(titulo),
            value_text_or_null(descripcion),
            value_text_or_null(fecha_limite),
        ],
    )
    .await?;

    apply_tareas_set_asignaciones_core(tx, id_tarea, &ids_trabajadores).await?;

    Ok(())
}

async fn apply_tareas_update(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_tarea = arg_required_i64(args, &["id_tarea", "idTarea", "ID_Tarea"], "id_tarea")?;
    let titulo = arg_required_string(args, &["titulo", "Titulo"], "titulo")?;
    let descripcion = arg_opt_string(args, &["descripcion", "Descripcion"]);
    let fecha_limite = arg_opt_string(args, &["fecha_limite", "fechaLimite", "Fecha_Limite"]);

    let affected = tx_execute(
        tx,
        r#"
        UPDATE Tareas
        SET
          Titulo = ?2,
          Descripcion = ?3,
          Fecha_Limite = ?4
        WHERE ID_Tarea = ?1;
        "#,
        vec![
            Value::Integer(id_tarea),
            Value::Text(titulo),
            value_text_or_null(descripcion),
            value_text_or_null(fecha_limite),
        ],
    )
    .await?;

    if affected == 0 {
        return Err("Tarea no encontrada".into());
    }

    Ok(())
}

async fn apply_tareas_set_asignaciones(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_tarea = arg_required_i64(args, &["id_tarea", "idTarea", "ID_Tarea"], "id_tarea")?;
    let ids_trabajadores = arg_ids(args, &["ids_trabajadores", "idsTrabajadores"]);

    apply_tareas_set_asignaciones_core(tx, id_tarea, &ids_trabajadores).await
}

async fn apply_tareas_delete(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_tarea = arg_required_i64(args, &["id_tarea", "idTarea", "ID_Tarea"], "id_tarea")?;

    tx_execute(
        tx,
        "DELETE FROM Tarea_Asignaciones WHERE ID_Tarea = ?1;",
        vec![Value::Integer(id_tarea)],
    )
    .await?;

    tx_execute(
        tx,
        "DELETE FROM Tareas WHERE ID_Tarea = ?1;",
        vec![Value::Integer(id_tarea)],
    )
    .await?;

    Ok(())
}

async fn apply_tareas_finalizar(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_tarea = arg_required_i64(args, &["id_tarea", "idTarea", "ID_Tarea"], "id_tarea")?;
    let id_trabajador = arg_required_i64(
        args,
        &["id_trabajador", "idTrabajador", "ID_Trabajador"],
        "id_trabajador",
    )?;

    tx_execute(
        tx,
        r#"
        UPDATE Tarea_Asignaciones
        SET
          Estado = 'FINALIZADA',
          Finalizada_At = COALESCE(Finalizada_At, datetime('now','localtime'))
        WHERE ID_Tarea = ?1
          AND ID_Trabajador = ?2;
        "#,
        vec![Value::Integer(id_tarea), Value::Integer(id_trabajador)],
    )
    .await?;

    Ok(())
}

/* =========================================================
   Aplicadores: Horarios / trabajadores
========================================================= */

async fn apply_horarios_create_asignacion(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_asignacion = id_from_args_or_result(
        args,
        result_json,
        &[
            "id_asignacion",
            "idAsignacion",
            "ID_Asignacion",
            "remote_id_asignacion",
            "remoteIdAsignacion",
            "id",
        ],
        "id_asignacion",
    )?;

    let id_trabajador = arg_required_i64(
        args,
        &["id_trabajador", "idTrabajador", "ID_Trabajador"],
        "id_trabajador",
    )?;

    let fecha = arg_required_string(args, &["fecha", "Fecha"], "fecha")?;
    let id_turno = arg_required_i64(args, &["id_turno", "idTurno", "ID_Turno"], "id_turno")?;
    let area = arg_required_string(args, &["area", "Area"], "area")?;
    let hora_inicio = arg_opt_string(args, &["hora_inicio", "horaInicio", "Hora_Inicio"]);
    let hora_fin = arg_opt_string(args, &["hora_fin", "horaFin", "Hora_Fin"]);
    let notas = arg_opt_string(args, &["notas", "Notas"]);

    tx_execute(
        tx,
        r#"
        INSERT INTO Asignacion_Turnos (
          ID_Asignacion,
          ID_Trabajador,
          Fecha,
          ID_Turno,
          Area,
          Hora_Inicio,
          Hora_Fin,
          Notas
        )
        VALUES (
          ?1,
          ?2,
          date(?3),
          ?4,
          ?5,
          ?6,
          ?7,
          ?8
        )
        ON CONFLICT(ID_Asignacion) DO UPDATE SET
          ID_Trabajador = excluded.ID_Trabajador,
          Fecha = excluded.Fecha,
          ID_Turno = excluded.ID_Turno,
          Area = excluded.Area,
          Hora_Inicio = excluded.Hora_Inicio,
          Hora_Fin = excluded.Hora_Fin,
          Notas = excluded.Notas;
        "#,
        vec![
            Value::Integer(id_asignacion),
            Value::Integer(id_trabajador),
            Value::Text(fecha),
            Value::Integer(id_turno),
            Value::Text(area),
            value_text_or_null(hora_inicio),
            value_text_or_null(hora_fin),
            value_text_or_null(notas),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_horarios_update_asignacion(
    tx: &Transaction,
    args: &JsonValue,
) -> Result<(), String> {
    let id_asignacion = arg_required_i64(
        args,
        &["id_asignacion", "idAsignacion", "ID_Asignacion"],
        "id_asignacion",
    )?;

    let id_turno = arg_required_i64(args, &["id_turno", "idTurno", "ID_Turno"], "id_turno")?;
    let area = arg_required_string(args, &["area", "Area"], "area")?;
    let hora_inicio = arg_opt_string(args, &["hora_inicio", "horaInicio", "Hora_Inicio"]);
    let hora_fin = arg_opt_string(args, &["hora_fin", "horaFin", "Hora_Fin"]);
    let notas = arg_opt_string(args, &["notas", "Notas"]);

    tx_execute(
        tx,
        r#"
        UPDATE Asignacion_Turnos
        SET
          ID_Turno = ?2,
          Area = ?3,
          Hora_Inicio = ?4,
          Hora_Fin = ?5,
          Notas = ?6
        WHERE ID_Asignacion = ?1;
        "#,
        vec![
            Value::Integer(id_asignacion),
            Value::Integer(id_turno),
            Value::Text(area),
            value_text_or_null(hora_inicio),
            value_text_or_null(hora_fin),
            value_text_or_null(notas),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_horarios_delete_asignacion(
    tx: &Transaction,
    args: &JsonValue,
) -> Result<(), String> {
    let id_asignacion = arg_required_i64(
        args,
        &["id_asignacion", "idAsignacion", "ID_Asignacion"],
        "id_asignacion",
    )?;

    tx_execute(
        tx,
        "DELETE FROM Asignacion_Turnos WHERE ID_Asignacion = ?1;",
        vec![Value::Integer(id_asignacion)],
    )
    .await?;

    Ok(())
}

async fn apply_remote_asignaciones_core(
    tx: &Transaction,
    to_monday: &str,
    overwrite: bool,
    rows: &[JsonValue],
) -> Result<(), String> {
    if overwrite {
        tx_execute(
            tx,
            r#"
            DELETE FROM Asignacion_Turnos
            WHERE Fecha >= date(?1)
              AND Fecha < date(?1, '+7 day');
            "#,
            vec![Value::Text(to_monday.to_string())],
        )
        .await?;
    }

    for row in rows {
        let id_asignacion = arg_i64(row, &["id_asignacion", "idAsignacion", "ID_Asignacion"])
            .filter(|n| *n > 0)
            .ok_or_else(|| "remote_asignacion.id_asignacion required".to_string())?;

        let id_trabajador = arg_i64(row, &["id_trabajador", "idTrabajador", "ID_Trabajador"])
            .filter(|n| *n > 0)
            .ok_or_else(|| "remote_asignacion.id_trabajador required".to_string())?;

        let fecha = arg_required_string(row, &["fecha", "Fecha"], "remote_asignacion.fecha")?;
        let id_turno = arg_required_i64(
            row,
            &["id_turno", "idTurno", "ID_Turno"],
            "remote_asignacion.id_turno",
        )?;

        let area = arg_opt_string(row, &["area", "Area"]).unwrap_or_else(|| "Sala".to_string());
        let hora_inicio = arg_opt_string(row, &["hora_inicio", "horaInicio", "Hora_Inicio"]);
        let hora_fin = arg_opt_string(row, &["hora_fin", "horaFin", "Hora_Fin"]);
        let notas = arg_opt_string(row, &["notas", "Notas"]);

        tx_execute(
            tx,
            r#"
            INSERT INTO Asignacion_Turnos (
              ID_Asignacion,
              ID_Trabajador,
              Fecha,
              ID_Turno,
              Area,
              Hora_Inicio,
              Hora_Fin,
              Notas
            )
            VALUES (
              ?1,
              ?2,
              date(?3),
              ?4,
              ?5,
              ?6,
              ?7,
              ?8
            )
            ON CONFLICT(ID_Asignacion) DO UPDATE SET
              ID_Trabajador = excluded.ID_Trabajador,
              Fecha = excluded.Fecha,
              ID_Turno = excluded.ID_Turno,
              Area = excluded.Area,
              Hora_Inicio = excluded.Hora_Inicio,
              Hora_Fin = excluded.Hora_Fin,
              Notas = excluded.Notas;
            "#,
            vec![
                Value::Integer(id_asignacion),
                Value::Integer(id_trabajador),
                Value::Text(fecha),
                Value::Integer(id_turno),
                Value::Text(area),
                value_text_or_null(hora_inicio),
                value_text_or_null(hora_fin),
                value_text_or_null(notas),
            ],
        )
        .await?;
    }

    Ok(())
}

async fn apply_horarios_copy_semana(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let to_monday = arg_required_string(args, &["to_monday", "toMonday"], "to_monday")?;
    let overwrite = arg_bool(args, &["overwrite"], true);

    let rows = json_field(args, &["remote_asignaciones", "remoteAsignaciones"])
        .and_then(|v| v.as_array())
        .ok_or_else(|| "remote_asignaciones required for cloud sync".to_string())?;

    apply_remote_asignaciones_core(tx, &to_monday, overwrite, rows).await
}

#[derive(Debug, Clone)]
struct PredItem {
    id_turno: i64,
    area: String,
    hora_inicio: Option<String>,
    hora_fin: Option<String>,
    notas: Option<String>,
}

fn weekday_1_to_7_from_ymd(ymd: &str) -> Option<i64> {
    let d = chrono::NaiveDate::parse_from_str(ymd, "%Y-%m-%d").ok()?;
    Some(d.weekday().number_from_monday() as i64)
}

async fn apply_horarios_set_predeterminado_desde_semana(
    tx: &Transaction,
    args: &JsonValue,
) -> Result<(), String> {
    use std::collections::BTreeMap;

    let fecha_lunes = arg_required_string(args, &["fecha_lunes", "fechaLunes"], "fecha_lunes")?;

    let mut rows = tx
        .query(
            r#"
            SELECT
              ID_Trabajador,
              Fecha,
              ID_Turno,
              Area,
              Hora_Inicio,
              Hora_Fin,
              Notas
            FROM Asignacion_Turnos
            WHERE Fecha >= date(?1)
              AND Fecha < date(?1, '+7 day')
            ORDER BY ID_Trabajador ASC, Fecha ASC, Hora_Inicio ASC;
            "#,
            vec![Value::Text(fecha_lunes)],
        )
        .await
        .map_err(|e| format!("sql_query_failed:{e}"))?;

    let mut map: BTreeMap<(i64, i64), Vec<PredItem>> = BTreeMap::new();

    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("sql_row_failed:{e}"))?
    {
        let id_trabajador = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let fecha = v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();
        let id_turno = v_i64(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0);
        let area =
            v_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_else(|| "Sala".into());
        let hora_inicio = v_string(row.get_value(4).map_err(|e| e.to_string())?);
        let hora_fin = v_string(row.get_value(5).map_err(|e| e.to_string())?);
        let notas = v_string(row.get_value(6).map_err(|e| e.to_string())?);

        if id_trabajador <= 0 || id_turno <= 0 || fecha.trim().is_empty() {
            continue;
        }

        let Some(weekday) = weekday_1_to_7_from_ymd(&fecha) else {
            continue;
        };

        map.entry((id_trabajador, weekday))
            .or_default()
            .push(PredItem {
                id_turno,
                area,
                hora_inicio,
                hora_fin,
                notas,
            });
    }

    let mut trabajadores: Vec<i64> = map
        .keys()
        .map(|(id_trabajador, _)| *id_trabajador)
        .collect();
    trabajadores.sort_unstable();
    trabajadores.dedup();

    for id_trabajador in trabajadores {
        tx_execute(
            tx,
            "DELETE FROM Horario_Predeterminado WHERE ID_Trabajador = ?1;",
            vec![Value::Integer(id_trabajador)],
        )
        .await?;
    }

    for ((id_trabajador, weekday), items) in map {
        for (idx, it) in items.into_iter().enumerate() {
            tx_execute(
                tx,
                r#"
                INSERT INTO Horario_Predeterminado (
                  ID_Trabajador,
                  Weekday,
                  Orden,
                  ID_Turno,
                  Area,
                  Hora_Inicio,
                  Hora_Fin,
                  Notas
                )
                VALUES (
                  ?1,
                  ?2,
                  ?3,
                  ?4,
                  ?5,
                  ?6,
                  ?7,
                  ?8
                );
                "#,
                vec![
                    Value::Integer(id_trabajador),
                    Value::Integer(weekday),
                    Value::Integer((idx as i64) + 1),
                    Value::Integer(it.id_turno),
                    Value::Text(it.area),
                    value_text_or_null(it.hora_inicio),
                    value_text_or_null(it.hora_fin),
                    value_text_or_null(it.notas),
                ],
            )
            .await?;
        }
    }

    Ok(())
}

/* =========================================================
   Aplicadores: Venta rápida / comandas / ticket
========================================================= */

async fn apply_vr_create_comanda_barra(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_comanda = id_from_args_or_result(
        args,
        result_json,
        &["id_comanda", "idComanda", "ID_Comanda", "id"],
        "id_comanda",
    )?;

    let id_trabajador_input = arg_i64(args, &["id_trabajador", "idTrabajador", "ID_Trabajador"]);
    let id_trabajador_real = resolve_trabajador_id_input(tx, id_trabajador_input).await?;
    let id_mesa_barra = ensure_barra_mesa_local(tx).await?;

    tx_execute(
        tx,
        r#"
        INSERT INTO Comandas (
          ID_Comanda,
          Fecha_Hora_Apertura,
          Estado,
          Total_Comanda,
          ID_Trabajador,
          ID_Mesa
        )
        VALUES (
          ?1,
          datetime('now','localtime'),
          'Abierta',
          0,
          ?2,
          ?3
        )
        ON CONFLICT(ID_Comanda) DO UPDATE SET
          Estado = excluded.Estado,
          Total_Comanda = COALESCE(Comandas.Total_Comanda, excluded.Total_Comanda),
          ID_Trabajador = excluded.ID_Trabajador,
          ID_Mesa = excluded.ID_Mesa;
        "#,
        vec![
            Value::Integer(id_comanda),
            value_i64_or_null(id_trabajador_real),
            Value::Integer(id_mesa_barra),
        ],
    )
    .await?;

    Ok(())
}

async fn ensure_barra_comanda_local(
    tx: &Transaction,
    id_comanda: i64,
) -> Result<(), String> {
    if id_comanda <= 0 {
        return Err("id_comanda required".into());
    }

    let exists = tx_exists_by_id(tx, "Comandas", "ID_Comanda", id_comanda).await?;

    if exists {
        return Ok(());
    }

    let id_mesa_barra = ensure_barra_mesa_local(tx).await?;

    tx_execute(
        tx,
        r#"
        INSERT INTO Comandas (
          ID_Comanda,
          Fecha_Hora_Apertura,
          Estado,
          Total_Comanda,
          ID_Trabajador,
          ID_Mesa
        )
        VALUES (
          ?1,
          datetime('now','localtime'),
          'Abierta',
          0,
          NULL,
          ?2
        )
        ON CONFLICT(ID_Comanda) DO NOTHING;
        "#,
        vec![
            Value::Integer(id_comanda),
            Value::Integer(id_mesa_barra),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_vr_add_linea_comanda(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_detalle = id_from_args_or_result(
        args,
        result_json,
        &[
            "id_detalle",
            "idDetalle",
            "ID_Detalle",
            "remote_id_detalle",
            "remoteIdDetalle",
            "id",
        ],
        "id_detalle",
    )?;

    let id_comanda = arg_required_i64(
        args,
        &["id_comanda", "idComanda", "ID_Comanda"],
        "id_comanda",
    )?;
    let id_producto = arg_required_i64(
        args,
        &["id_producto", "idProducto", "ID_Producto"],
        "id_producto",
    )?;

    ensure_barra_comanda_local(tx, id_comanda).await?;

if !tx_exists_by_id(tx, "Productos", "ID_Producto", id_producto).await? {
    return Err(format!("dependency_missing:producto:{id_producto}"));
}

    let cantidad = arg_f64(args, &["cantidad", "Cantidad"]).unwrap_or(1.0);

    if !cantidad.is_finite() || cantidad <= 0.0 {
        return Err("cantidad invalid".into());
    }

    let precio_unitario = arg_f64(
        args,
        &["precio_unitario", "precioUnitario", "Precio_Unitario"],
    )
    .unwrap_or(0.0);

    if !precio_unitario.is_finite() {
        return Err("precio_unitario invalid".into());
    }

    let notas = arg_opt_string(args, &["notas", "nota", "Notas"]);
    let estado_cocina = arg_opt_string(args, &["estado_cocina", "estadoCocina", "Estado_Cocina"])
        .unwrap_or_else(|| "PENDIENTE".to_string());

    tx_execute(
        tx,
        r#"
        INSERT INTO Detalle_Comanda (
          ID_Detalle,
          ID_Comanda,
          ID_Producto,
          Cantidad,
          Precio_Unitario,
          Notas,
          Estado_Cocina
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          ?4,
          ?5,
          ?6,
          ?7
        )
        ON CONFLICT(ID_Detalle) DO UPDATE SET
          ID_Comanda = excluded.ID_Comanda,
          ID_Producto = excluded.ID_Producto,
          Cantidad = excluded.Cantidad,
          Precio_Unitario = excluded.Precio_Unitario,
          Notas = COALESCE(excluded.Notas, Detalle_Comanda.Notas),
          Estado_Cocina = COALESCE(Detalle_Comanda.Estado_Cocina, excluded.Estado_Cocina);
        "#,
        vec![
            Value::Integer(id_detalle),
            Value::Integer(id_comanda),
            Value::Integer(id_producto),
            Value::Real(cantidad),
            Value::Real(precio_unitario),
            value_text_or_null(notas),
            Value::Text(estado_cocina),
        ],
    )
    .await?;

    update_total_comanda(tx, id_comanda).await?;

    Ok(())
}

async fn apply_vr_remove_last_unpaid_linea(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_comanda = arg_required_i64(
        args,
        &["id_comanda", "idComanda", "ID_Comanda"],
        "id_comanda",
    )?;
    let id_producto = arg_required_i64(
        args,
        &["id_producto", "idProducto", "ID_Producto"],
        "id_producto",
    )?;

    let affected = tx_execute(
        tx,
        r#"
        DELETE FROM Detalle_Comanda
        WHERE ID_Detalle = (
          SELECT dc.ID_Detalle
          FROM Detalle_Comanda dc
          LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
          WHERE dc.ID_Comanda = ?1
            AND dc.ID_Producto = ?2
            AND pd.ID_Detalle IS NULL
          ORDER BY dc.ID_Detalle DESC
          LIMIT 1
        );
        "#,
        vec![Value::Integer(id_comanda), Value::Integer(id_producto)],
    )
    .await?;

    if affected == 0 {
        if result_json_indicates_noop(result_json, &["deleted", "removed"]) {
            return Ok(());
        }

        return Err(format!(
            "dependency_missing:detalle_unpaid:{id_comanda}:{id_producto}"
        ));
    }

    update_total_comanda(tx, id_comanda).await?;

    Ok(())
}

async fn apply_vr_delete_linea_if_unpaid(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_comanda = arg_required_i64(
        args,
        &["id_comanda", "idComanda", "ID_Comanda"],
        "id_comanda",
    )?;
    let id_detalle = arg_required_i64(
        args,
        &["id_detalle", "idDetalle", "ID_Detalle"],
        "id_detalle",
    )?;

    let affected = tx_execute(
        tx,
        r#"
        DELETE FROM Detalle_Comanda
        WHERE ID_Detalle = ?1
          AND ID_Comanda = ?2
          AND NOT EXISTS (
            SELECT 1
            FROM Pago_Detalles pd
            WHERE pd.ID_Detalle = ?1
          );
        "#,
        vec![Value::Integer(id_detalle), Value::Integer(id_comanda)],
    )
    .await?;

    if affected == 0 {
        if result_json_indicates_noop(result_json, &["deleted", "removed"]) {
            return Ok(());
        }

        let exists = tx_select_one_i64(
            tx,
            r#"
            SELECT 1
            FROM Detalle_Comanda
            WHERE ID_Detalle = ?1
              AND ID_Comanda = ?2
            LIMIT 1;
            "#,
            vec![Value::Integer(id_detalle), Value::Integer(id_comanda)],
        )
        .await?
        .is_some();

        if exists {
            return Err(format!("dependency_not_unpaid:detalle:{id_detalle}"));
        }

        return Err(format!("dependency_missing:detalle:{id_detalle}"));
    }

    update_total_comanda(tx, id_comanda).await?;

    Ok(())
}

async fn apply_vr_update_nota_detalle(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_detalle = arg_required_i64(
        args,
        &["id_detalle", "idDetalle", "ID_Detalle"],
        "id_detalle",
    )?;

    let nota = arg_opt_string(args, &["nota", "notas", "Notas"]);

    let affected = tx_execute(
        tx,
        r#"
        UPDATE Detalle_Comanda
        SET Notas = ?2
        WHERE ID_Detalle = ?1;
        "#,
        vec![Value::Integer(id_detalle), value_text_or_null(nota)],
    )
    .await?;

    if affected == 0 {
        if result_json_indicates_noop(result_json, &["updated"]) {
            return Ok(());
        }

        return Err(format!("dependency_missing:detalle:{id_detalle}"));
    }

    Ok(())
}

async fn apply_vr_cobrar_fraccionado(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
    consume_stock: bool,
) -> Result<(), String> {
    if result_json_indicates_noop(result_json, &["id_pago", "idPago", "ID_Pago"]) {
        return Ok(());
    }

    let id_pago = id_from_args_or_result(
        args,
        result_json,
        &["id_pago", "idPago", "ID_Pago", "id"],
        "id_pago",
    )?;

    let id_comanda = arg_required_i64(
        args,
        &["id_comanda", "idComanda", "ID_Comanda"],
        "id_comanda",
    )?;

    let metodo_raw = arg_string(args, &["metodo", "Metodo_Pago", "metodo_pago"])
        .unwrap_or_else(|| "Efectivo".to_string());

    let metodo = if metodo_raw.trim().eq_ignore_ascii_case("tarjeta") {
        "Tarjeta".to_string()
    } else {
        "Efectivo".to_string()
    };

    let detalles = arg_ids(args, &["detalles", "ids_detalle", "idsDetalle"]);

    if detalles.is_empty() {
        return Err("detalles required".into());
    }

    let id_usuario_cobrador = arg_i64(
        args,
        &[
            "id_usuario_cobrador",
            "idUsuarioCobrador",
            "ID_Usuario_Cobrador",
        ],
    );

    let id_trabajador_from_user = trabajador_id_from_usuario(tx, id_usuario_cobrador).await?;
    let id_trabajador_comanda = trabajador_id_from_comanda(tx, id_comanda).await?;

    let id_trabajador_cobrador = arg_i64(
        args,
        &[
            "id_trabajador_cobrador",
            "idTrabajadorCobrador",
            "ID_Trabajador_Cobrador",
        ],
    )
    .filter(|n| *n > 0)
    .or(id_trabajador_from_user)
    .or(id_trabajador_comanda);

    let placeholders = build_in_placeholders(2, detalles.len());

    let sql = format!(
        r#"
        SELECT
          IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0) AS Importe,
          COUNT(*) AS NumValid
        FROM Detalle_Comanda dc
        WHERE dc.ID_Comanda = ?1
          AND dc.ID_Detalle IN ({})
          AND NOT EXISTS (
            SELECT 1
            FROM Pago_Detalles pd
            WHERE pd.ID_Detalle = dc.ID_Detalle
          );
        "#,
        placeholders
    );

    let mut params_sum = Vec::<Value>::with_capacity(1 + detalles.len());
    params_sum.push(Value::Integer(id_comanda));

    for id_detalle in &detalles {
        params_sum.push(Value::Integer(*id_detalle));
    }

    let mut rows = tx
        .query(&sql, params_sum)
        .await
        .map_err(|e| format!("sql_query_failed:{e}"))?;

    let (importe_total_db, num_valid) = match rows
        .next()
        .await
        .map_err(|e| format!("sql_row_failed:{e}"))?
    {
        Some(row) => {
            let importe = v_f64(row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?)
                .unwrap_or(0.0);
            let count = v_i64(row.get_value(1).map_err(|e| format!("get_value(1): {e}"))?)
                .unwrap_or(0);
            (importe, count)
        }
        None => (0.0, 0),
    };

    if num_valid != detalles.len() as i64 {
        for id_detalle in &detalles {
            let exists = tx_select_one_i64(
                tx,
                r#"
                SELECT 1
                FROM Detalle_Comanda
                WHERE ID_Comanda = ?1
                  AND ID_Detalle = ?2
                LIMIT 1;
                "#,
                vec![Value::Integer(id_comanda), Value::Integer(*id_detalle)],
            )
            .await?
            .is_some();

            if !exists {
                return Err(format!("dependency_missing:detalle_pago:{id_detalle}"));
            }

            let unpaid = tx_select_one_i64(
                tx,
                r#"
                SELECT 1
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?1
                  AND dc.ID_Detalle = ?2
                  AND NOT EXISTS (
                    SELECT 1
                    FROM Pago_Detalles pd
                    WHERE pd.ID_Detalle = dc.ID_Detalle
                  )
                LIMIT 1;
                "#,
                vec![Value::Integer(id_comanda), Value::Integer(*id_detalle)],
            )
            .await?
            .is_some();

            if !unpaid {
                return Err(format!("dependency_not_unpaid:detalle_pago:{id_detalle}"));
            }
        }

        return Err("detalles_valid_count_mismatch".into());
    }

    /*
      VR-01/VR-05 (replicación): si esta operación consume stock (solo la ruta
      vr.cobrarFraccionado, no ticket.cobrarDetalles), capturamos aquí los
      detalles a cobrar con su producto y cantidad, ANTES de insertar
      Pago_Detalles, para luego descontar lotes FEFO e insertar Lote_Consumos
      por ID_Detalle.
    */
    let charged: Vec<(i64, i64, f64)> = if consume_stock {
        let mut out: Vec<(i64, i64, f64)> = Vec::new();

        let mut params_charged = Vec::<Value>::with_capacity(1 + detalles.len());
        params_charged.push(Value::Integer(id_comanda));
        for id_detalle in &detalles {
            params_charged.push(Value::Integer(*id_detalle));
        }

        let charged_sql = format!(
            r#"
            SELECT dc.ID_Detalle, dc.ID_Producto, CAST(COALESCE(dc.Cantidad,1) AS REAL)
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = ?1
              AND dc.ID_Detalle IN ({})
              AND NOT EXISTS (
                SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
              )
            ORDER BY dc.ID_Detalle;
            "#,
            build_in_placeholders(2, detalles.len())
        );

        let mut rows = tx
            .query(&charged_sql, params_charged)
            .await
            .map_err(|e| format!("sql_query_failed:{e}"))?;

        while let Some(row) = rows.next().await.map_err(|e| format!("sql_row_failed:{e}"))? {
            let id_det = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
            let id_prod = v_i64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);
            let qty = v_f64(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0.0);

            if id_det > 0 && id_prod > 0 && qty > 0.0 {
                out.push((id_det, id_prod, qty));
            }
        }

        out
    } else {
        Vec::new()
    };

    tx_execute(
        tx,
        r#"
        INSERT INTO Pagos (
          ID_Pago,
          ID_Comanda,
          Fecha_Hora,
          Metodo_Pago,
          Importe_Total,
          Tipo,
          ID_Usuario_Cobrador,
          ID_Trabajador_Cobrador
        )
        VALUES (
          ?1,
          ?2,
          datetime('now','localtime'),
          ?3,
          ?4,
          'FRACCIONADO',
          ?5,
          ?6
        )
        ON CONFLICT(ID_Pago) DO UPDATE SET
          ID_Comanda = excluded.ID_Comanda,
          Metodo_Pago = excluded.Metodo_Pago,
          Importe_Total = excluded.Importe_Total,
          Tipo = excluded.Tipo,
          ID_Usuario_Cobrador = excluded.ID_Usuario_Cobrador,
          ID_Trabajador_Cobrador = excluded.ID_Trabajador_Cobrador;
        "#,
        vec![
            Value::Integer(id_pago),
            Value::Integer(id_comanda),
            Value::Text(metodo),
            Value::Real(importe_total_db),
            value_i64_or_null(id_usuario_cobrador),
            value_i64_or_null(id_trabajador_cobrador),
        ],
    )
    .await?;

    for id_detalle in &detalles {
        let affected = tx_execute(
            tx,
            r#"
            INSERT OR IGNORE INTO Pago_Detalles (
              ID_Pago,
              ID_Detalle
            )
            SELECT ?1, dc.ID_Detalle
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = ?2
              AND dc.ID_Detalle = ?3
              AND NOT EXISTS (
                SELECT 1
                FROM Pago_Detalles pd
                WHERE pd.ID_Detalle = dc.ID_Detalle
              );
            "#,
            vec![
                Value::Integer(id_pago),
                Value::Integer(id_comanda),
                Value::Integer(*id_detalle),
            ],
        )
        .await?;

        if affected == 0 {
            return Err(format!("dependency_not_unpaid:detalle_pago:{id_detalle}"));
        }
    }

    /*
      Consumo de stock FEFO + Lote_Consumos (replicación).

      A diferencia del endpoint/comando en vivo (que validan suficiencia y
      fallan con insufficient_stock), aquí somos best-effort: la suficiencia ya
      se validó en el dispositivo origen y en la nube (fuente de verdad). Si el
      stock local divergiera, descontamos hasta lo disponible (sin negativos) y
      registramos lo consumido, en lugar de romper la sincronización. Solo se
      ejecuta en la ruta vr.cobrarFraccionado (consume_stock=true); el cobro de
      mesas (ticket.cobrarDetalles) no toca stock.
    */
    if consume_stock {
        for (id_detalle, producto_id, cantidad) in &charged {
            let lot_rows: Vec<(i64, f64)> = {
                let mut lots = tx
                    .query(
                        r#"
                        SELECT ID_Lote, COALESCE(Stock_Disponible,0) AS Stock
                        FROM Lotes_Producto
                        WHERE ID_Producto = ?1
                          AND COALESCE(Stock_Disponible,0) > 0
                        ORDER BY
                          CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
                          date(Caducidad) ASC,
                          datetime(Fecha_Entrada) ASC,
                          ID_Lote ASC;
                        "#,
                        vec![Value::Integer(*producto_id)],
                    )
                    .await
                    .map_err(|e| format!("sql_query_failed:{e}"))?;

                let mut out: Vec<(i64, f64)> = Vec::new();

                while let Some(row) =
                    lots.next().await.map_err(|e| format!("sql_row_failed:{e}"))?
                {
                    let id_lote = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
                    let stock = v_f64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);

                    if id_lote > 0 && stock > 0.0 {
                        out.push((id_lote, stock));
                    }
                }

                out
            };

            let mut remaining = *cantidad;

            for (id_lote, stock) in lot_rows {
                if remaining <= 0.0 {
                    break;
                }

                let take = if remaining < stock { remaining } else { stock };

                if take <= 0.0 {
                    continue;
                }

                tx_execute(
                    tx,
                    r#"
                    UPDATE Lotes_Producto
                    SET Stock_Disponible = COALESCE(Stock_Disponible,0) - ?2
                    WHERE ID_Lote = ?1;
                    "#,
                    vec![Value::Integer(id_lote), Value::Real(take)],
                )
                .await?;

                tx_execute(
                    tx,
                    r#"
                    INSERT INTO Lote_Consumos (ID_Detalle, ID_Lote, Cantidad)
                    VALUES (?1, ?2, ?3)
                    ON CONFLICT(ID_Detalle, ID_Lote) DO NOTHING;
                    "#,
                    vec![
                        Value::Integer(*id_detalle),
                        Value::Integer(id_lote),
                        Value::Real(take),
                    ],
                )
                .await?;

                remaining -= take;
            }
        }
    }

    update_total_comanda(tx, id_comanda).await?;

    let pending_left = tx_select_one_i64(
        tx,
        r#"
        SELECT COUNT(*)
        FROM Detalle_Comanda dc
        LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
        WHERE dc.ID_Comanda = ?1
          AND pd.ID_Detalle IS NULL;
        "#,
        vec![Value::Integer(id_comanda)],
    )
    .await?
    .unwrap_or(0);

    if pending_left == 0 {
        tx_execute(
            tx,
            r#"
            UPDATE Comandas
            SET
              Estado = 'Pagada',
              Total_Comanda = (
                SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
                FROM Detalle_Comanda
                WHERE ID_Comanda = ?1
              ),
              Fecha_Hora_Cierre = datetime('now','localtime')
            WHERE ID_Comanda = ?1;
            "#,
            vec![Value::Integer(id_comanda)],
        )
        .await?;
    }

    Ok(())
}

async fn apply_vr_restar_stock(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let raw_lineas = json_field(args, &["lineas", "items"])
        .and_then(|v| v.as_array())
        .ok_or_else(|| "lineas required".to_string())?;

    let mut lineas = Vec::<(i64, f64)>::new();

    for item in raw_lineas {
        let producto_id = arg_i64(item, &["producto_id", "productoId", "ID_Producto"]).unwrap_or(0);
        let cantidad = arg_f64(item, &["cantidad", "Cantidad"]).unwrap_or(0.0);

        if producto_id > 0 && cantidad.is_finite() && cantidad > 0.0 {
            lineas.push((producto_id, cantidad));
        }
    }

    lineas.sort_by(|a, b| a.0.cmp(&b.0));

    let mut merged = Vec::<(i64, f64)>::new();

    for (producto_id, cantidad) in lineas {
        if let Some(last) = merged.last_mut() {
            if last.0 == producto_id {
                last.1 += cantidad;
                continue;
            }
        }

        merged.push((producto_id, cantidad));
    }

    for (producto_id, cantidad) in merged {
        let mut remaining = cantidad;

        let mut lots = tx
            .query(
                r#"
                SELECT ID_Lote, COALESCE(Stock_Disponible,0) AS Stock
                FROM Lotes_Producto
                WHERE ID_Producto = ?1
                  AND COALESCE(Stock_Disponible,0) > 0
                ORDER BY
                  CASE WHEN Caducidad IS NULL THEN 1 ELSE 0 END,
                  date(Caducidad) ASC,
                  datetime(Fecha_Entrada) ASC,
                  ID_Lote ASC;
                "#,
                vec![Value::Integer(producto_id)],
            )
            .await
            .map_err(|e| format!("sql_query_failed:{e}"))?;

        while remaining > 0.0 {
            let Some(row) = lots
                .next()
                .await
                .map_err(|e| format!("sql_row_failed:{e}"))?
            else {
                break;
            };

            let id_lote = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
            let stock = v_f64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);

            if id_lote <= 0 || stock <= 0.0 {
                continue;
            }

            let take = if remaining < stock { remaining } else { stock };

            tx_execute(
                tx,
                r#"
                UPDATE Lotes_Producto
                SET Stock_Disponible = CASE
                  WHEN COALESCE(Stock_Disponible,0) - ?2 < 0 THEN 0
                  ELSE COALESCE(Stock_Disponible,0) - ?2
                END
                WHERE ID_Lote = ?1;
                "#,
                vec![Value::Integer(id_lote), Value::Real(take)],
            )
            .await?;

            remaining -= take;
        }
    }

    Ok(())
}

async fn apply_vr_delete_comanda_if_safe(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_comanda = arg_required_i64(
        args,
        &["id_comanda", "idComanda", "ID_Comanda"],
        "id_comanda",
    )?;

    let has_paid = tx_select_one_i64(
        tx,
        r#"
        SELECT EXISTS(
          SELECT 1
          FROM Detalle_Comanda dc
          JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
          WHERE dc.ID_Comanda = ?1
        );
        "#,
        vec![Value::Integer(id_comanda)],
    )
    .await?
    .unwrap_or(0);

    if has_paid == 1 {
        if result_json_indicates_noop(result_json, &["deleted"]) {
            return Ok(());
        }

        return Err("La comanda tiene líneas pagadas y no se puede borrar".into());
    }

    tx_execute(
        tx,
        "DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1;",
        vec![Value::Integer(id_comanda)],
    )
    .await?;

    tx_execute(
        tx,
        "DELETE FROM Comandas WHERE ID_Comanda = ?1;",
        vec![Value::Integer(id_comanda)],
    )
    .await?;

    Ok(())
}

async fn apply_kitchen_set_line_state(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_detalle = arg_required_i64(
        args,
        &["id_detalle", "idDetalle", "ID_Detalle"],
        "id_detalle",
    )?;

    let estado = arg_required_string(
        args,
        &["estado", "estado_cocina", "estadoCocina", "Estado_Cocina"],
        "estado",
    )?;

    let affected = tx_execute(
        tx,
        r#"
        UPDATE Detalle_Comanda
        SET Estado_Cocina = ?2
        WHERE ID_Detalle = ?1;
        "#,
        vec![Value::Integer(id_detalle), Value::Text(estado)],
    )
    .await?;

    if affected == 0 {
        return Err(format!("dependency_missing:detalle:{id_detalle}"));
    }

    Ok(())
}

async fn apply_comandas_abrir(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_comanda = id_from_args_or_result(
        args,
        result_json,
        &["id_comanda", "idComanda", "ID_Comanda", "id"],
        "id_comanda",
    )?;

    let id_mesa = arg_required_i64(args, &["id_mesa", "idMesa", "ID_Mesa"], "id_mesa")?;
    let id_trabajador_input = arg_i64(args, &["id_trabajador", "idTrabajador", "ID_Trabajador"]);
    let id_trabajador = resolve_trabajador_id_input(tx, id_trabajador_input).await?;

    tx_execute(
        tx,
        r#"
        INSERT INTO Comandas (
          ID_Comanda,
          ID_Mesa,
          ID_Trabajador,
          Fecha_Hora_Apertura,
          Estado,
          Total_Comanda
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          datetime('now','localtime'),
          'Abierta',
          0
        )
        ON CONFLICT(ID_Comanda) DO UPDATE SET
          ID_Mesa = excluded.ID_Mesa,
          ID_Trabajador = COALESCE(excluded.ID_Trabajador, Comandas.ID_Trabajador),
          Estado = excluded.Estado;
        "#,
        vec![
            Value::Integer(id_comanda),
            Value::Integer(id_mesa),
            value_i64_or_null(id_trabajador),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_comandas_set_trabajador_if_null(
    tx: &Transaction,
    args: &JsonValue,
) -> Result<(), String> {
    let id_comanda = arg_required_i64(
        args,
        &["id_comanda", "idComanda", "ID_Comanda"],
        "id_comanda",
    )?;
    let id_trabajador_input = arg_required_i64(
        args,
        &["id_trabajador", "idTrabajador", "ID_Trabajador"],
        "id_trabajador",
    )?;

    let id_trabajador = resolve_trabajador_id_input(tx, Some(id_trabajador_input)).await?;

    tx_execute(
        tx,
        r#"
        UPDATE Comandas
        SET ID_Trabajador = ?2
        WHERE ID_Comanda = ?1
          AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0);
        "#,
        vec![Value::Integer(id_comanda), value_i64_or_null(id_trabajador)],
    )
    .await?;

    Ok(())
}

async fn apply_comandas_cerrar(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_comanda = arg_required_i64(
        args,
        &["id_comanda", "idComanda", "ID_Comanda"],
        "id_comanda",
    )?;

    tx_execute(
        tx,
        r#"
        UPDATE Comandas
        SET
          Estado = 'Pagada',
          Fecha_Hora_Cierre = COALESCE(Fecha_Hora_Cierre, datetime('now','localtime'))
        WHERE ID_Comanda = ?1;
        "#,
        vec![Value::Integer(id_comanda)],
    )
    .await?;

    Ok(())
}

/* =========================================================
   Aplicadores: Config
========================================================= */

async fn apply_config_patch_business_settings(
    tx: &Transaction,
    args: &JsonValue,
) -> Result<(), String> {
    tx_execute(
        tx,
        r#"
        INSERT OR IGNORE INTO Business_Settings (
          ID,
          business_name,
          logo_data_url,
          direccion,
          telefono,
          cif,
          mensaje_footer,
          iva_percent
        )
        VALUES (
          1,
          '',
          NULL,
          '',
          '',
          '',
          '',
          10
        );
        "#,
        vec![],
    )
    .await?;

    let mut sets = Vec::<String>::new();
    let mut values = Vec::<Value>::new();

    let fields = [
        ("business_name", ["business_name", "businessName"]),
        ("logo_data_url", ["logo_data_url", "logoDataUrl"]),
        ("direccion", ["direccion", "address"]),
        ("telefono", ["telefono", "phone"]),
        ("cif", ["cif", "CIF"]),
        ("mensaje_footer", ["mensaje_footer", "mensajeFooter"]),
    ];

    for (col, names) in fields {
        if let Some(v) = json_field(args, &names) {
            sets.push(format!("{col} = ?{}", values.len() + 1));
            values.push(json_to_libsql_value(v)?);
        }
    }

    if let Some(v) = json_field(args, &["iva_percent", "ivaPercent"]) {
        sets.push(format!("iva_percent = ?{}", values.len() + 1));
        values.push(json_to_libsql_value(v)?);
    }

    if sets.is_empty() {
        return Ok(());
    }

    let sql = format!(
        "UPDATE Business_Settings SET {} WHERE ID = 1;",
        sets.join(", ")
    );

    tx_execute(tx, &sql, values).await?;

    Ok(())
}

async fn apply_config_patch_ticket_settings(
    tx: &Transaction,
    args: &JsonValue,
) -> Result<(), String> {
    tx_execute(
        tx,
        r#"
        INSERT OR IGNORE INTO Ticket_Settings (
          ID,
          show_logo,
          show_business_name,
          show_address,
          show_phone,
          show_cif,
          show_date_time,
          show_line_items,
          show_base_and_iva,
          show_total,
          show_footer_message,
          paper_width_mm
        )
        VALUES (
          1,
          1,
          1,
          1,
          1,
          1,
          1,
          1,
          1,
          1,
          1,
          80
        );
        "#,
        vec![],
    )
    .await?;

    let fields: Vec<(&str, Vec<&str>)> = vec![
        ("show_logo", vec!["show_logo", "showLogo"]),
        (
            "show_business_name",
            vec!["show_business_name", "showBusinessName"],
        ),
        ("show_address", vec!["show_address", "showAddress"]),
        ("show_phone", vec!["show_phone", "showPhone"]),
        ("show_cif", vec!["show_cif", "showCif"]),
        ("show_date_time", vec!["show_date_time", "showDateTime"]),
        ("show_line_items", vec!["show_line_items", "showLineItems"]),
        (
            "show_base_and_iva",
            vec!["show_base_and_iva", "showBaseAndIva"],
        ),
        ("show_total", vec!["show_total", "showTotal"]),
        (
            "show_footer_message",
            vec!["show_footer_message", "showFooterMessage"],
        ),
        ("paper_width_mm", vec!["paper_width_mm", "paperWidthMm"]),
    ];

    let mut sets = Vec::<String>::new();
    let mut values = Vec::<Value>::new();

    for (col, names) in fields {
        if let Some(v) = json_field(args, &names) {
            sets.push(format!("{col} = ?{}", values.len() + 1));
            values.push(json_to_libsql_value(v)?);
        }
    }

    if sets.is_empty() {
        return Ok(());
    }

    let sql = format!(
        "UPDATE Ticket_Settings SET {} WHERE ID = 1;",
        sets.join(", ")
    );

    tx_execute(tx, &sql, values).await?;

    Ok(())
}

/* =========================================================
   Aplicadores: Inventario básico
========================================================= */

async fn apply_inventario_create_categoria(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_categoria = id_from_args_or_result(
        args,
        result_json,
        &["id_categoria", "idCategoria", "ID_Categoria", "id"],
        "id_categoria",
    )?;

    let nombre = arg_required_string(args, &["nombre", "Nombre"], "nombre");
    let nombre = nombre.unwrap_or_else(|_| format!("Categoría {id_categoria}"));

    let nombre_imagen = arg_opt_string(args, &["nombre_imagen", "nombreImagen", "Nombre_Imagen"]);
    let ruta_imagen = arg_opt_string(args, &["ruta_imagen", "rutaImagen", "Ruta_Imagen"]);
    let vendible = arg_i64(args, &["vendible", "Vendible"]).unwrap_or(1);

    tx_execute(
        tx,
        r#"
        INSERT INTO Categorias_Producto (
          ID_Categoria,
          Nombre,
          Nombre_Imagen,
          Ruta_Imagen,
          Vendible
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          ?4,
          ?5
        )
        ON CONFLICT(ID_Categoria) DO UPDATE SET
          Nombre = excluded.Nombre,
          Nombre_Imagen = excluded.Nombre_Imagen,
          Ruta_Imagen = excluded.Ruta_Imagen,
          Vendible = excluded.Vendible;
        "#,
        vec![
            Value::Integer(id_categoria),
            Value::Text(nombre),
            value_text_or_null(nombre_imagen),
            value_text_or_null(ruta_imagen),
            Value::Integer(vendible),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_inventario_upsert_producto(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_producto = id_from_args_or_result(
        args,
        result_json,
        &["id_producto", "idProducto", "ID_Producto", "id"],
        "id_producto",
    )?;

    let id_categoria = arg_required_i64(
        args,
        &["id_categoria", "idCategoria", "ID_Categoria"],
        "id_categoria",
    )?;

    let nombre = arg_required_string(args, &["nombre", "Nombre"], "nombre")?;
    let precio_venta =
        arg_f64(args, &["precio_venta", "precioVenta", "Precio_Venta"]).unwrap_or(0.0);
    let stock_minimo =
        arg_f64(args, &["stock_minimo", "stockMinimo", "Stock_Minimo"]).unwrap_or(0.0);
    let unidad_medida = arg_opt_string(args, &["unidad_medida", "unidadMedida", "Unidad_Medida"]);
    let nombre_imagen = arg_opt_string(args, &["nombre_imagen", "nombreImagen", "Nombre_Imagen"]);
    let ruta_imagen = arg_opt_string(args, &["ruta_imagen", "rutaImagen", "Ruta_Imagen"]);

    tx_execute(
        tx,
        r#"
        INSERT INTO Productos (
          ID_Producto,
          ID_Categoria,
          Nombre,
          Precio_Venta,
          Stock_Minimo,
          Unidad_Medida,
          Nombre_Imagen,
          Ruta_Imagen
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          ?4,
          ?5,
          ?6,
          ?7,
          ?8
        )
        ON CONFLICT(ID_Producto) DO UPDATE SET
          ID_Categoria = excluded.ID_Categoria,
          Nombre = excluded.Nombre,
          Precio_Venta = excluded.Precio_Venta,
          Stock_Minimo = excluded.Stock_Minimo,
          Unidad_Medida = excluded.Unidad_Medida,
          Nombre_Imagen = excluded.Nombre_Imagen,
          Ruta_Imagen = excluded.Ruta_Imagen;
        "#,
        vec![
            Value::Integer(id_producto),
            Value::Integer(id_categoria),
            Value::Text(nombre),
            Value::Real(precio_venta),
            Value::Real(stock_minimo),
            value_text_or_null(unidad_medida),
            value_text_or_null(nombre_imagen),
            value_text_or_null(ruta_imagen),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_inventario_delete_producto(
    tx: &Transaction,
    args: &JsonValue,
) -> Result<(), String> {
    let id_producto = arg_required_i64(
        args,
        &["id_producto", "idProducto", "ID_Producto"],
        "id_producto",
    )?;

    let _ = tx_execute(
        tx,
        "DELETE FROM Producto_Alergenos WHERE ID_Producto = ?1;",
        vec![Value::Integer(id_producto)],
    )
    .await;

    let _ = tx_execute(
        tx,
        "DELETE FROM Lotes_Producto WHERE ID_Producto = ?1;",
        vec![Value::Integer(id_producto)],
    )
    .await;

    tx_execute(
        tx,
        "DELETE FROM Productos WHERE ID_Producto = ?1;",
        vec![Value::Integer(id_producto)],
    )
    .await?;

    Ok(())
}

async fn apply_inventario_create_lote(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_lote = id_from_args_or_result(
        args,
        result_json,
        &["id_lote", "idLote", "ID_Lote", "id"],
        "id_lote",
    )?;

    let id_producto = arg_required_i64(
        args,
        &["id_producto", "idProducto", "ID_Producto"],
        "id_producto",
    )?;

    let cantidad = arg_f64(args, &["cantidad", "Cantidad"]).unwrap_or(0.0);
    let stock_disponible = arg_f64(
        args,
        &["stock_disponible", "stockDisponible", "Stock_Disponible"],
    )
    .unwrap_or(cantidad);

    let fecha_entrada = arg_opt_string(args, &["fecha_entrada", "fechaEntrada", "Fecha_Entrada"]);
    let caducidad = arg_opt_string(args, &["caducidad", "Caducidad"]);
    let precio_compra =
        arg_f64(args, &["precio_compra", "precioCompra", "Precio_Compra"]).unwrap_or(0.0);

    tx_execute(
        tx,
        r#"
        INSERT INTO Lotes_Producto (
          ID_Lote,
          ID_Producto,
          Cantidad,
          Stock_Disponible,
          Fecha_Entrada,
          Caducidad,
          Precio_Compra
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          ?4,
          COALESCE(?5, datetime('now','localtime')),
          ?6,
          ?7
        )
        ON CONFLICT(ID_Lote) DO UPDATE SET
          ID_Producto = excluded.ID_Producto,
          Cantidad = excluded.Cantidad,
          Stock_Disponible = excluded.Stock_Disponible,
          Fecha_Entrada = excluded.Fecha_Entrada,
          Caducidad = excluded.Caducidad,
          Precio_Compra = excluded.Precio_Compra;
        "#,
        vec![
            Value::Integer(id_lote),
            Value::Integer(id_producto),
            Value::Real(cantidad),
            Value::Real(stock_disponible),
            value_text_or_null(fecha_entrada),
            value_text_or_null(caducidad),
            Value::Real(precio_compra),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_inventario_ajustar_lote(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_lote = arg_required_i64(args, &["id_lote", "idLote", "ID_Lote"], "id_lote")?;

    let delta = arg_f64(args, &["delta", "ajuste", "cantidad"]).unwrap_or(0.0);

    tx_execute(
        tx,
        r#"
        UPDATE Lotes_Producto
        SET Stock_Disponible = CASE
          WHEN COALESCE(Stock_Disponible,0) + ?2 < 0 THEN 0
          ELSE COALESCE(Stock_Disponible,0) + ?2
        END
        WHERE ID_Lote = ?1;
        "#,
        vec![Value::Integer(id_lote), Value::Real(delta)],
    )
    .await?;

    Ok(())
}

async fn apply_inventario_set_alergenos_producto(
    tx: &Transaction,
    args: &JsonValue,
) -> Result<(), String> {
    let id_producto = arg_required_i64(
        args,
        &["id_producto", "idProducto", "ID_Producto"],
        "id_producto",
    )?;

    let ids_alergenos = arg_ids(args, &["ids_alergenos", "idsAlergenos", "alergenos"]);

    tx_execute(
        tx,
        "DELETE FROM Producto_Alergenos WHERE ID_Producto = ?1;",
        vec![Value::Integer(id_producto)],
    )
    .await?;

    for id_alergeno in ids_alergenos {
        tx_execute(
            tx,
            r#"
            INSERT OR IGNORE INTO Producto_Alergenos (
              ID_Producto,
              ID_Alergeno
            )
            VALUES (
              ?1,
              ?2
            );
            "#,
            vec![Value::Integer(id_producto), Value::Integer(id_alergeno)],
        )
        .await?;
    }

    Ok(())
}

/* =========================================================
   Aplicadores: Reservas básico
========================================================= */

async fn apply_reservas_save(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_reserva = id_from_args_or_result(
        args,
        result_json,
        &["id_reserva", "idReserva", "ID_Reserva", "id"],
        "id_reserva",
    )?;

    let nombre = arg_opt_string(args, &["nombre", "Nombre"]).unwrap_or_else(|| "Reserva".into());
    let telefono = arg_opt_string(args, &["telefono", "Telefono"]);
    let fecha = arg_required_string(args, &["fecha", "Fecha"], "fecha")?;
    let hora = arg_opt_string(args, &["hora", "Hora"]);
    let personas = arg_i64(args, &["personas", "Personas"]).unwrap_or(1);
    let estado = arg_opt_string(args, &["estado", "Estado"]).unwrap_or_else(|| "PENDIENTE".into());
    let notas = arg_opt_string(args, &["notas", "Notas"]);
    let id_mesa = arg_i64(args, &["id_mesa", "idMesa", "ID_Mesa"]);

    tx_execute(
        tx,
        r#"
        INSERT INTO Reservas (
          ID_Reserva,
          Nombre,
          Telefono,
          Fecha,
          Hora,
          Personas,
          Estado,
          Notas,
          ID_Mesa
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          date(?4),
          ?5,
          ?6,
          ?7,
          ?8,
          ?9
        )
        ON CONFLICT(ID_Reserva) DO UPDATE SET
          Nombre = excluded.Nombre,
          Telefono = excluded.Telefono,
          Fecha = excluded.Fecha,
          Hora = excluded.Hora,
          Personas = excluded.Personas,
          Estado = excluded.Estado,
          Notas = excluded.Notas,
          ID_Mesa = excluded.ID_Mesa;
        "#,
        vec![
            Value::Integer(id_reserva),
            Value::Text(nombre),
            value_text_or_null(telefono),
            Value::Text(fecha),
            value_text_or_null(hora),
            Value::Integer(personas),
            Value::Text(estado),
            value_text_or_null(notas),
            value_i64_or_null(id_mesa),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_reservas_delete(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_reserva = arg_required_i64(
        args,
        &["id_reserva", "idReserva", "ID_Reserva"],
        "id_reserva",
    )?;

    tx_execute(
        tx,
        "DELETE FROM Reservas WHERE ID_Reserva = ?1;",
        vec![Value::Integer(id_reserva)],
    )
    .await?;

    Ok(())
}

async fn apply_reservas_set_estado(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_reserva = arg_required_i64(
        args,
        &["id_reserva", "idReserva", "ID_Reserva"],
        "id_reserva",
    )?;

    let estado = arg_required_string(args, &["estado", "Estado"], "estado")?;

    tx_execute(
        tx,
        r#"
        UPDATE Reservas
        SET Estado = ?2
        WHERE ID_Reserva = ?1;
        "#,
        vec![Value::Integer(id_reserva), Value::Text(estado)],
    )
    .await?;

    Ok(())
}

/* =========================================================
   Aplicadores: Clientes básico
========================================================= */

async fn apply_clientes_create_or_update(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_cliente = id_from_args_or_result(
        args,
        result_json,
        &["id_cliente", "idCliente", "ID_Cliente", "id"],
        "id_cliente",
    )?;

    let nombre = arg_required_string(args, &["nombre", "Nombre"], "nombre")?;
    let apellido = arg_opt_string(args, &["apellido", "Apellido"]);
    let telefono = arg_opt_string(args, &["telefono", "Telefono"]);
    let email = arg_opt_string(args, &["email", "Email"]);
    let notas = arg_opt_string(args, &["notas", "Notas"]);

    tx_execute(
        tx,
        r#"
        INSERT INTO Clientes (
          ID_Cliente,
          Nombre,
          Apellido,
          Telefono,
          Email,
          Notas
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          ?4,
          ?5,
          ?6
        )
        ON CONFLICT(ID_Cliente) DO UPDATE SET
          Nombre = excluded.Nombre,
          Apellido = excluded.Apellido,
          Telefono = excluded.Telefono,
          Email = excluded.Email,
          Notas = excluded.Notas;
        "#,
        vec![
            Value::Integer(id_cliente),
            Value::Text(nombre),
            value_text_or_null(apellido),
            value_text_or_null(telefono),
            value_text_or_null(email),
            value_text_or_null(notas),
        ],
    )
    .await?;

    Ok(())
}

/* =========================================================
   Aplicadores: Proveedores básico
========================================================= */

async fn apply_proveedores_save(
    tx: &Transaction,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    let id_proveedor = id_from_args_or_result(
        args,
        result_json,
        &["id_proveedor", "idProveedor", "ID_Proveedor", "id"],
        "id_proveedor",
    )?;

    let nombre_empresa = arg_required_string(
        args,
        &[
            "nombre_empresa",
            "nombreEmpresa",
            "Nombre_Empresa",
            "nombre",
            "Nombre",
        ],
        "nombre_empresa",
    )?;

    let contacto = arg_opt_string(args, &["contacto", "Contacto"]);
    let telefono = arg_opt_string(args, &["telefono", "Telefono"]);
    let email = arg_opt_string(args, &["email", "Email"]);
    let direccion = arg_opt_string(args, &["direccion", "Direccion"]);

    tx_execute(
        tx,
        r#"
        INSERT INTO Proveedores (
          ID_Proveedor,
          Nombre_Empresa,
          Contacto,
          Telefono,
          Email,
          Direccion
        )
        VALUES (
          ?1,
          ?2,
          ?3,
          ?4,
          ?5,
          ?6
        )
        ON CONFLICT(ID_Proveedor) DO UPDATE SET
          Nombre_Empresa = excluded.Nombre_Empresa,
          Contacto = excluded.Contacto,
          Telefono = excluded.Telefono,
          Email = excluded.Email,
          Direccion = excluded.Direccion;
        "#,
        vec![
            Value::Integer(id_proveedor),
            Value::Text(nombre_empresa),
            value_text_or_null(contacto),
            value_text_or_null(telefono),
            value_text_or_null(email),
            value_text_or_null(direccion),
        ],
    )
    .await?;

    Ok(())
}

async fn apply_proveedores_delete(tx: &Transaction, args: &JsonValue) -> Result<(), String> {
    let id_proveedor = arg_required_i64(
        args,
        &["id_proveedor", "idProveedor", "ID_Proveedor"],
        "id_proveedor",
    )?;

    tx_execute(
        tx,
        "DELETE FROM Proveedores WHERE ID_Proveedor = ?1;",
        vec![Value::Integer(id_proveedor)],
    )
    .await?;

    Ok(())
}

/* =========================================================
   Dispatcher comandos
========================================================= */

async fn apply_command_by_name(
    tx: &Transaction,
    command_name: &str,
    args: &JsonValue,
    result_json: Option<&str>,
) -> Result<(), String> {
    match command_name {
        /* Tareas */
        "tareas.createTarea" => apply_tareas_create(tx, args, result_json).await,
        "tareas.updateTarea" => apply_tareas_update(tx, args).await,
        "tareas.setAsignacionesTarea" => apply_tareas_set_asignaciones(tx, args).await,
        "tareas.deleteTarea" => apply_tareas_delete(tx, args).await,
        "tareas.marcarTareaFinalizada" => apply_tareas_finalizar(tx, args).await,

        /* Horarios */
        "horarios.createAsignacion" => {
            apply_horarios_create_asignacion(tx, args, result_json).await
        }
        "horarios.updateAsignacion" => apply_horarios_update_asignacion(tx, args).await,
        "horarios.deleteAsignacion" => apply_horarios_delete_asignacion(tx, args).await,
        "horarios.copySemanaAsignaciones" => apply_horarios_copy_semana(tx, args).await,
        "horarios.setPredeterminadoDesdeSemana" => {
            apply_horarios_set_predeterminado_desde_semana(tx, args).await
        }

        /* Venta rápida */
        "vr.createComandaBarra" => apply_vr_create_comanda_barra(tx, args, result_json).await,
        "vr.addLineaComanda" => apply_vr_add_linea_comanda(tx, args, result_json).await,
        "vr.removeLastUnpaidLinea" => apply_vr_remove_last_unpaid_linea(tx, args, result_json).await,
        "vr.deleteLineaIfUnpaid" => apply_vr_delete_linea_if_unpaid(tx, args, result_json).await,
        "vr.updateNotaDetalle" => apply_vr_update_nota_detalle(tx, args, result_json).await,
        "vr.cobrarFraccionado" => apply_vr_cobrar_fraccionado(tx, args, result_json, true).await,
        "vr.restarStock" => apply_vr_restar_stock(tx, args).await,
        "vr.deleteComandaIfSafe" => apply_vr_delete_comanda_if_safe(tx, args, result_json).await,

        /* Comandas / ticket / cocina */
        "comandas.abrir" => apply_comandas_abrir(tx, args, result_json).await,
        "comandas.addLinea" => apply_vr_add_linea_comanda(tx, args, result_json).await,
        "comandas.setTrabajadorIfNull" => apply_comandas_set_trabajador_if_null(tx, args).await,
        "comandas.cerrar" => apply_comandas_cerrar(tx, args).await,
        "comandas.createBarra" | "comandas.getOrCreateBarra" => {
            apply_vr_create_comanda_barra(tx, args, result_json).await
        }
        "comandas.deleteBarraIfSafe" => apply_vr_delete_comanda_if_safe(tx, args, result_json).await,
        "mesas.getOrCreateMesaBarra" => {
            let _ = ensure_barra_mesa_local(tx).await?;
            Ok(())
        }
        "ticket.removeOnePending" => apply_vr_remove_last_unpaid_linea(tx, args, result_json).await,
        "ticket.deleteDetalle" => apply_vr_delete_linea_if_unpaid(tx, args, result_json).await,
        "ticket.updateDetalleNota" => apply_vr_update_nota_detalle(tx, args, result_json).await,
        "ticket.cobrarDetalles" => apply_vr_cobrar_fraccionado(tx, args, result_json, false).await,
        "kitchen.setLineaEstado" => apply_kitchen_set_line_state(tx, args).await,
        "ventaRapida.cobrar" => Ok(()),

        /* Config */
        "config.patchBusinessSettings" => apply_config_patch_business_settings(tx, args).await,
        "config.patchTicketSettings" => apply_config_patch_ticket_settings(tx, args).await,

        /* Inventario */
        "inventario.createCategoria" => {
            apply_inventario_create_categoria(tx, args, result_json).await
        }
        "inventario.upsertProducto" => {
            apply_inventario_upsert_producto(tx, args, result_json).await
        }
        "inventario.deleteProducto" => apply_inventario_delete_producto(tx, args).await,
        "inventario.createLote" => apply_inventario_create_lote(tx, args, result_json).await,
        "inventario.ajustarLote" => apply_inventario_ajustar_lote(tx, args).await,
        "inventario.setAlergenosProducto" => {
            apply_inventario_set_alergenos_producto(tx, args).await
        }

        /* Reservas */
        "reservas.save" => apply_reservas_save(tx, args, result_json).await,
        "reservas.delete" => apply_reservas_delete(tx, args).await,
        "reservas.setEstado" => apply_reservas_set_estado(tx, args).await,

        /* Clientes */
        "clientes.createCliente" | "clients.createCliente" => {
            apply_clientes_create_or_update(tx, args, result_json).await
        }
        "clientes.updateCliente" | "clients.updateCliente" => {
            apply_clientes_create_or_update(tx, args, result_json).await
        }

        /* Proveedores */
        "proveedores.save" => apply_proveedores_save(tx, args, result_json).await,
        "proveedores.delete" => apply_proveedores_delete(tx, args).await,

        /* Login: de momento no se aplica por background local */
        "login.punch" | "login.setTurnoPartidoHoy" | "login.completeInitialSetup" => Ok(()),

        other => Err(format!("sync_handler_not_found:{other}")),
    }
}

async fn apply_one_cloud_change(
    tx: &Transaction,
    change: &CloudChange,
    own_device_id: Option<&str>,
) -> Result<&'static str, String> {
    let parsed = parse_cloud_command(change)?;

    if already_cloud_applied(tx, change.id_change).await? {
        mark_cloud_applied(tx, change).await?;
        set_last_cloud_change_id(tx, change.id_change).await?;

        return Ok("skipped");
    }

    if already_local_operation_applied(tx, &parsed.op_id, &parsed.command_name).await? {
        mark_cloud_applied(tx, change).await?;
        set_last_cloud_change_id(tx, change.id_change).await?;

        return Ok("skipped");
    }

    if let (Some(own), Some(device)) = (own_device_id, change.device_id.as_deref()) {
        if !own.is_empty() && own == device {
            mark_cloud_applied(tx, change).await?;
            set_last_cloud_change_id(tx, change.id_change).await?;

            return Ok("skipped");
        }
    }

    apply_command_by_name(
        tx,
        &parsed.command_name,
        &parsed.args,
        change.result_json.as_deref(),
    )
    .await?;

    mark_local_operation_applied(tx, &parsed.op_id, &parsed.command_name, "cloudSync").await?;
    mark_cloud_applied(tx, change).await?;
    set_last_cloud_change_id(tx, change.id_change).await?;

    Ok("applied")
}


/* =========================================================
   Aplicación local reutilizable desde SyncManager
========================================================= */

pub(crate) async fn apply_local_command_from_payload(
    db: Arc<Connection>,
    op_id: &str,
    command_name: &str,
    payload_json: &str,
    result_json: Option<&str>,
    source: &str,
) -> Result<(), String> {
    let op_id = normalize_required(op_id, "op_id")?;
    let command_name = normalize_required(command_name, "command_name")?;
    let source = normalize_source(source)?;

    let change = CloudChange {
        id_change: 0,
        op_id,
        command_name,
        command_version: 1,
        device_id: None,
        payload_json: payload_json.to_string(),
        result_json: result_json.map(|s| s.to_string()),
        created_at_ms: now_ms(),
    };

    let parsed = parse_cloud_command(&change)?;

    let tx = db
        .transaction()
        .await
        .map_err(|e| format!("pending_local_apply_tx_start_failed:{e}"))?;

    if already_local_operation_applied(&tx, &parsed.op_id, &parsed.command_name).await? {
        tx.commit()
            .await
            .map_err(|e| format!("pending_local_apply_tx_commit_failed:{e}"))?;

        return Ok(());
    }

    apply_command_by_name(
        &tx,
        &parsed.command_name,
        &parsed.args,
        change.result_json.as_deref(),
    )
    .await?;

    mark_local_operation_applied(&tx, &parsed.op_id, &parsed.command_name, &source).await?;

    tx.commit()
        .await
        .map_err(|e| format!("pending_local_apply_tx_commit_failed:{e}"))?;

    Ok(())
}

/* =========================================================
   Commands
========================================================= */

#[tauri::command]
pub async fn sync_get_last_cloud_change_id(state: State<'_, AppState>) -> Result<i64, String> {
    let db = get_db(&state).await?;

    get_last_cloud_change_id_from_db(&db).await
}

#[tauri::command]
pub async fn sync_apply_cloud_changes(
    app: AppHandle,
    state: State<'_, AppState>,
    args: SyncApplyCloudChangesArgs,
) -> Result<ApplyCloudChangesResult, String> {
    if args.changes.is_empty() {
        let db = get_db(&state).await?;
        let last = get_last_cloud_change_id_from_db(&db).await?;

        return Ok(ApplyCloudChangesResult {
            ok: true,
            applied: 0,
            skipped: 0,
            last_cloud_change_id: last,
            errors: vec![],
        });
    }

    let own_device_id = read_own_device_id(&app);

    let db = get_db(&state).await?;
    let tx = db
        .transaction()
        .await
        .map_err(|e| format!("sync_transaction_start_failed:{e}"))?;

    let mut applied = 0_i64;
    let mut skipped = 0_i64;
    let mut errors = Vec::<String>::new();
    let mut last_cloud_change_id = 0_i64;

    let mut sorted = args.changes;
    sorted.sort_by_key(|c| c.id_change);

    for change in sorted.iter() {
        last_cloud_change_id = last_cloud_change_id.max(change.id_change);

        match apply_one_cloud_change(&tx, change, own_device_id.as_deref()).await {
            Ok("applied") => applied += 1,
            Ok("skipped") => skipped += 1,
            Ok(_) => skipped += 1,
            Err(e) => {
                errors.push(format!(
                    "change:{} op:{} command:{} error:{}",
                    change.id_change, change.op_id, change.command_name, e
                ));
                break;
            }
        }
    }

    if !errors.is_empty() {
        let _ = tx.rollback().await;

        return Ok(ApplyCloudChangesResult {
            ok: false,
            applied,
            skipped,
            last_cloud_change_id,
            errors,
        });
    }

    tx.commit()
        .await
        .map_err(|e| format!("sync_transaction_commit_failed:{e}"))?;

    Ok(ApplyCloudChangesResult {
        ok: true,
        applied,
        skipped,
        last_cloud_change_id,
        errors,
    })
}

#[tauri::command]
pub async fn sync_mark_local_operation_applied(
    state: State<'_, AppState>,
    args: SyncMarkLocalOperationAppliedArgs,
) -> Result<(), String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = normalize_required(&args.command_name, "command_name")?;
    let source = normalize_source(&args.source)?;

    let db = get_db(&state).await?;

    db.execute(
        "
        INSERT OR IGNORE INTO Local_Applied_Operations (
            Op_Id,
            Command_Name,
            Source,
            Applied_At_Ms
        )
        VALUES (?1, ?2, ?3, ?4);
        ",
        params![op_id, command_name, source, now_ms()],
    )
    .await
    .map_err(|e| format!("sync_mark_local_operation_applied_failed:{e}"))?;

    Ok(())
}
