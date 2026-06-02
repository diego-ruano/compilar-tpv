// src-tauri/src/fallback_local.rs
use libsql::{Connection, Value};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::State;

use crate::{get_db, AppState};

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

fn v_i64(v: Value) -> Option<i64> {
    match v {
        Value::Integer(n) => Some(n),
        Value::Real(n) => Some(n as i64),
        Value::Text(s) => s.parse::<i64>().ok(),
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

fn norm_opt_string(v: Value) -> Option<String> {
    v_string(v).and_then(|s| {
        let t = s.trim().to_string();

        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
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

fn stable_json_string(value: &JsonValue) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("json serialize error: {e}"))
}

fn validate_outbox_payload_envelope(
    payload: &JsonValue,
    op_id: &str,
    command_name: &str,
) -> Result<(), String> {
    let payload_op_id = payload
        .get("op_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if payload_op_id.is_empty() {
        return Err("payload_op_id required".into());
    }

    if payload_op_id != op_id {
        return Err("payload_op_id_mismatch".into());
    }

    let payload_command_name = payload
        .get("command_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if payload_command_name.is_empty() {
        return Err("payload_command_name required".into());
    }

    if payload_command_name != command_name {
        return Err("payload_command_name_mismatch".into());
    }

    if payload.get("args").is_none() {
        return Err("payload_args required".into());
    }

    Ok(())
}

fn normalize_json_payload(input: &str, op_id: &str, command_name: &str) -> Result<String, String> {
    let raw = input.trim();

    if raw.is_empty() {
        return Err("payload_json required".into());
    }

    let parsed: JsonValue =
        serde_json::from_str(raw).map_err(|e| format!("payload_json invalid json: {e}"))?;

    validate_outbox_payload_envelope(&parsed, op_id, command_name)?;
    stable_json_string(&parsed)
}

/* =========================================================
   Tipos salida
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxOperationRow {
    pub id_outbox: i64,
    pub op_id: String,
    pub command_name: String,
    pub payload_json: String,
    pub status: String,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub last_attempt_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxEnqueueResult {
    pub inserted: bool,
    pub already_present: bool,
    pub row: OutboxOperationRow,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct OutboxEnqueueArgs {
    pub op_id: String,
    pub command_name: String,
    pub payload_json: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OutboxLimitArgs {
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OutboxOpIdArgs {
    pub op_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OutboxMarkFailedArgs {
    pub op_id: String,

    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OutboxDeleteAppliedArgs {
    #[serde(default)]
    pub older_than_ms: Option<i64>,
}

/* =========================================================
   Row mapper
========================================================= */

fn row_to_outbox_operation(row: &libsql::Row) -> Result<OutboxOperationRow, String> {
    let id_outbox = row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?;
    let op_id_v = row.get_value(1).map_err(|e| format!("get_value(1): {e}"))?;
    let command_name = row.get_value(2).map_err(|e| format!("get_value(2): {e}"))?;
    let payload_json = row.get_value(3).map_err(|e| format!("get_value(3): {e}"))?;
    let status = row.get_value(4).map_err(|e| format!("get_value(4): {e}"))?;
    let attempt_count = row.get_value(5).map_err(|e| format!("get_value(5): {e}"))?;
    let last_error = row.get_value(6).map_err(|e| format!("get_value(6): {e}"))?;
    let created_at_ms = row.get_value(7).map_err(|e| format!("get_value(7): {e}"))?;
    let updated_at_ms = row.get_value(8).map_err(|e| format!("get_value(8): {e}"))?;
    let last_attempt_at_ms = row.get_value(9).map_err(|e| format!("get_value(9): {e}"))?;

    Ok(OutboxOperationRow {
        id_outbox: v_i64(id_outbox).unwrap_or(0),
        op_id: v_string(op_id_v).unwrap_or_default(),
        command_name: v_string(command_name).unwrap_or_default(),
        payload_json: v_string(payload_json).unwrap_or_else(|| "{}".to_string()),
        status: v_string(status).unwrap_or_else(|| "PENDING".to_string()),
        attempt_count: v_i64(attempt_count).unwrap_or(0),
        last_error: norm_opt_string(last_error),
        created_at_ms: v_i64(created_at_ms).unwrap_or(0),
        updated_at_ms: v_i64(updated_at_ms).unwrap_or(0),
        last_attempt_at_ms: v_i64(last_attempt_at_ms),
    })
}

/* =========================================================
   SQL helpers
========================================================= */

async fn outbox_get_by_op_id(
    conn: &Connection,
    op_id: &str,
) -> Result<Option<OutboxOperationRow>, String> {
    let sql = r#"
      SELECT
        ID_Outbox,
        Op_Id,
        Command_Name,
        Payload_Json,
        Status,
        Attempt_Count,
        Last_Error,
        Created_At_Ms,
        Updated_At_Ms,
        Last_Attempt_At_Ms
      FROM Outbox_Operations
      WHERE Op_Id = ?
      LIMIT 1;
    "#;

    let mut rows = conn
        .query(sql, vec![Value::Text(op_id.to_string())])
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(None);
    };

    Ok(Some(row_to_outbox_operation(&row)?))
}

async fn outbox_get_by_id_outbox(
    conn: &Connection,
    id_outbox: i64,
) -> Result<Option<OutboxOperationRow>, String> {
    let sql = r#"
      SELECT
        ID_Outbox,
        Op_Id,
        Command_Name,
        Payload_Json,
        Status,
        Attempt_Count,
        Last_Error,
        Created_At_Ms,
        Updated_At_Ms,
        Last_Attempt_At_Ms
      FROM Outbox_Operations
      WHERE ID_Outbox = ?
      LIMIT 1;
    "#;

    let mut rows = conn
        .query(sql, vec![Value::Integer(id_outbox)])
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(None);
    };

    Ok(Some(row_to_outbox_operation(&row)?))
}

async fn outbox_list_by_statuses(
    conn: &Connection,
    statuses: &[&str],
    limit: i64,
) -> Result<Vec<OutboxOperationRow>, String> {
    let sql = format!(
        r#"
        SELECT
          ID_Outbox,
          Op_Id,
          Command_Name,
          Payload_Json,
          Status,
          Attempt_Count,
          Last_Error,
          Created_At_Ms,
          Updated_At_Ms,
          Last_Attempt_At_Ms
        FROM Outbox_Operations
        WHERE Status IN ({})
        ORDER BY
          CASE WHEN Status = 'PENDING' THEN 0 ELSE 1 END,
          Created_At_Ms ASC,
          ID_Outbox ASC
        LIMIT ?;
        "#,
        statuses.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
    );

    let mut args: Vec<Value> = statuses
        .iter()
        .map(|s| Value::Text((*s).to_string()))
        .collect();

    args.push(Value::Integer(limit));

    let mut rows = conn
        .query(&sql, args)
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let mut out = Vec::new();

    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    {
        out.push(row_to_outbox_operation(&row)?);
    }

    Ok(out)
}

async fn outbox_select_next_candidate(
    conn: &Connection,
) -> Result<Option<OutboxOperationRow>, String> {
    let sql = r#"
      SELECT
        ID_Outbox,
        Op_Id,
        Command_Name,
        Payload_Json,
        Status,
        Attempt_Count,
        Last_Error,
        Created_At_Ms,
        Updated_At_Ms,
        Last_Attempt_At_Ms
      FROM Outbox_Operations
      WHERE Status IN ('PENDING', 'FAILED')
      ORDER BY
        CASE WHEN Status = 'PENDING' THEN 0 ELSE 1 END,
        Created_At_Ms ASC,
        ID_Outbox ASC
      LIMIT 1;
    "#;

    let mut rows = conn
        .query(sql, Vec::<Value>::new())
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(None);
    };

    Ok(Some(row_to_outbox_operation(&row)?))
}

/* =========================================================
   Commands
========================================================= */

#[tauri::command]
pub async fn fallback_local_outbox_enqueue(
    state: State<'_, AppState>,
    args: OutboxEnqueueArgs,
) -> Result<OutboxEnqueueResult, String> {
    let conn = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = normalize_required(&args.command_name, "command_name")?;
    let payload_json = normalize_json_payload(&args.payload_json, &op_id, &command_name)?;

    if let Some(existing) = outbox_get_by_op_id(&conn, &op_id).await? {
        if existing.command_name != command_name {
            return Err("outbox_op_command_mismatch".into());
        }

        if existing.payload_json != payload_json {
            return Err("outbox_op_payload_mismatch".into());
        }

        return Ok(OutboxEnqueueResult {
            inserted: false,
            already_present: true,
            row: existing,
        });
    }

    let now = now_ms();

    let sql = r#"
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
      VALUES (?, ?, ?, 'PENDING', 0, NULL, ?, ?, NULL);
    "#;

    conn.execute(
        sql,
        vec![
            Value::Text(op_id.clone()),
            Value::Text(command_name.clone()),
            Value::Text(payload_json.clone()),
            Value::Integer(now),
            Value::Integer(now),
        ],
    )
    .await
    .map_err(|e| format!("DB execute error: {e}"))?;

    let row = outbox_get_by_op_id(&conn, &op_id)
        .await?
        .ok_or_else(|| "outbox_insert_readback_failed".to_string())?;

    Ok(OutboxEnqueueResult {
        inserted: true,
        already_present: false,
        row,
    })
}

#[tauri::command]
pub async fn fallback_local_outbox_get_pending(
    state: State<'_, AppState>,
    args: OutboxLimitArgs,
) -> Result<Vec<OutboxOperationRow>, String> {
    let conn = get_db(&state).await?;
    let limit = args.limit.unwrap_or(500).clamp(1, 5000);

    outbox_list_by_statuses(&conn, &["PENDING", "FAILED"], limit).await
}

#[tauri::command]
pub async fn fallback_local_outbox_pending_count(
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let conn = get_db(&state).await?;

    let sql = r#"
      SELECT COUNT(*)
      FROM Outbox_Operations
      WHERE Status IN ('PENDING', 'FAILED', 'SYNCING');
    "#;

    let mut rows = conn
        .query(sql, Vec::<Value>::new())
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(0);
    };

    let count = row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?;

    Ok(v_i64(count).unwrap_or(0))
}

#[tauri::command]
pub async fn fallback_local_outbox_claim_next(
    state: State<'_, AppState>,
) -> Result<Option<OutboxOperationRow>, String> {
    let conn = get_db(&state).await?;
    let now = now_ms();

    conn.execute_batch("BEGIN IMMEDIATE;")
        .await
        .map_err(|e| format!("DB begin error: {e}"))?;

    let res: Result<Option<OutboxOperationRow>, String> = async {
        let Some(candidate) = outbox_select_next_candidate(&conn).await? else {
            return Ok(None);
        };

        let affected = conn
            .execute(
                r#"
                UPDATE Outbox_Operations
                SET
                  Status = 'SYNCING',
                  Attempt_Count = Attempt_Count + 1,
                  Last_Error = NULL,
                  Last_Attempt_At_Ms = ?1,
                  Updated_At_Ms = ?2
                WHERE ID_Outbox = ?3
                  AND Status IN ('PENDING', 'FAILED');
                "#,
                vec![
                    Value::Integer(now),
                    Value::Integer(now),
                    Value::Integer(candidate.id_outbox),
                ],
            )
            .await
            .map_err(|e| format!("DB execute error: {e}"))?;

        if affected == 0 {
            return Ok(None);
        }

        let claimed = outbox_get_by_id_outbox(&conn, candidate.id_outbox)
            .await?
            .ok_or_else(|| "outbox_claim_readback_failed".to_string())?;

        Ok(Some(claimed))
    }
    .await;

    match res {
        Ok(row) => {
            conn.execute_batch("COMMIT;")
                .await
                .map_err(|e| format!("DB commit error: {e}"))?;

            Ok(row)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK;").await;

            Err(err)
        }
    }
}

#[tauri::command]
pub async fn fallback_local_outbox_mark_syncing(
    state: State<'_, AppState>,
    args: OutboxOpIdArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let now = now_ms();

    let sql = r#"
      UPDATE Outbox_Operations
      SET
        Status = 'SYNCING',
        Attempt_Count = Attempt_Count + 1,
        Last_Error = NULL,
        Last_Attempt_At_Ms = ?,
        Updated_At_Ms = ?
      WHERE Op_Id = ?
        AND Status IN ('PENDING', 'FAILED');
    "#;

    let affected = conn
        .execute(
            sql,
            vec![Value::Integer(now), Value::Integer(now), Value::Text(op_id)],
        )
        .await
        .map_err(|e| format!("DB execute error: {e}"))?;

    Ok(affected > 0)
}

#[tauri::command]
pub async fn fallback_local_outbox_mark_applied(
    state: State<'_, AppState>,
    args: OutboxOpIdArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let now = now_ms();

    let sql = r#"
      UPDATE Outbox_Operations
      SET
        Status = 'APPLIED',
        Last_Error = NULL,
        Updated_At_Ms = ?
      WHERE Op_Id = ?
        AND Status = 'SYNCING';
    "#;

    let affected = conn
        .execute(sql, vec![Value::Integer(now), Value::Text(op_id)])
        .await
        .map_err(|e| format!("DB execute error: {e}"))?;

    Ok(affected > 0)
}

#[tauri::command]
pub async fn fallback_local_outbox_mark_failed(
    state: State<'_, AppState>,
    args: OutboxMarkFailedArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let now = now_ms();

    let err = clean_opt_string(args.last_error).unwrap_or_else(|| "sync_failed".to_string());

    let sql = r#"
      UPDATE Outbox_Operations
      SET
        Status = 'FAILED',
        Last_Error = ?,
        Updated_At_Ms = ?
      WHERE Op_Id = ?
        AND Status = 'SYNCING';
    "#;

    let affected = conn
        .execute(
            sql,
            vec![Value::Text(err), Value::Integer(now), Value::Text(op_id)],
        )
        .await
        .map_err(|e| format!("DB execute error: {e}"))?;

    Ok(affected > 0)
}

#[tauri::command]
pub async fn fallback_local_outbox_requeue_syncing(
    state: State<'_, AppState>,
) -> Result<i64, String> {
    let conn = get_db(&state).await?;
    let now = now_ms();

    let sql = r#"
      UPDATE Outbox_Operations
      SET
        Status = 'PENDING',
        Updated_At_Ms = ?
      WHERE Status = 'SYNCING';
    "#;

    let affected = conn
        .execute(sql, vec![Value::Integer(now)])
        .await
        .map_err(|e| format!("DB execute error: {e}"))?;

    Ok(affected as i64)
}

#[tauri::command]
pub async fn fallback_local_outbox_get_by_op_id(
    state: State<'_, AppState>,
    args: OutboxOpIdArgs,
) -> Result<Option<OutboxOperationRow>, String> {
    let conn = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;

    outbox_get_by_op_id(&conn, &op_id).await
}

#[tauri::command]
pub async fn fallback_local_outbox_delete_applied(
    state: State<'_, AppState>,
    args: OutboxDeleteAppliedArgs,
) -> Result<i64, String> {
    let conn = get_db(&state).await?;
    let now = now_ms();
    let cutoff = args.older_than_ms.unwrap_or(now);

    let sql = r#"
      DELETE FROM Outbox_Operations
      WHERE Status = 'APPLIED'
        AND Updated_At_Ms <= ?;
    "#;

    let affected = conn
        .execute(sql, vec![Value::Integer(cutoff)])
        .await
        .map_err(|e| format!("DB execute error: {e}"))?;

    Ok(affected as i64)
}
