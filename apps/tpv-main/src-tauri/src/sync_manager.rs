// src-tauri/src/sync_manager.rs
use crate::{cloud_sync, get_db, AppState};

use libsql::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex;

static RUN_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Clone, Deserialize)]
pub struct SyncEnqueuePendingLocalApplyArgs {
    pub op_id: String,
    pub command_name: String,
    pub payload_json: String,

    #[serde(default)]
    pub result_json: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncPendingCountResult {
    pub pending: i64,
    pub failed: i64,
    pub processing: i64,
}

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

fn next_retry_ms(attempt_count: i64) -> i64 {
    let delay_ms = match attempt_count {
        0 | 1 => 2_000,
        2 => 5_000,
        3 => 15_000,
        4 => 60_000,
        _ => 300_000,
    };

    now_ms() + delay_ms
}

async fn recover_stale_processing_rows(db: &Connection) -> Result<(), String> {
    let now = now_ms();
    let stale_before = now - 60_000;

    db.execute(
        "
        UPDATE Pending_Local_Applies
        SET
            Status = 'FAILED',
            Last_Error = COALESCE(Last_Error, 'recovered_stale_processing'),
            Updated_At_Ms = ?1,
            Next_Retry_At_Ms = ?2
        WHERE Status = 'PROCESSING'
          AND COALESCE(Last_Attempt_At_Ms, Updated_At_Ms, Created_At_Ms) <= ?3;
        ",
        params![now, now, stale_before],
    )
    .await
    .map_err(|e| format!("recover_stale_processing_failed:{e}"))?;

    Ok(())
}

async fn pending_count(db: &Connection, status: &str) -> Result<i64, String> {
    let mut rows = db
        .query(
            "
            SELECT COUNT(*)
            FROM Pending_Local_Applies
            WHERE Status = ?1;
            ",
            params![status],
        )
        .await
        .map_err(|e| format!("pending_count_query_failed:{e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("pending_count_row_failed:{e}"))?
    else {
        return Ok(0);
    };

    let n: i64 = row
        .get(0)
        .map_err(|e| format!("pending_count_get_failed:{e}"))?;

    Ok(n)
}

#[derive(Debug, Clone)]
struct PendingLocalApplyRow {
    id_pending: i64,
    op_id: String,
    command_name: String,
    payload_json: String,
    result_json: Option<String>,
    attempt_count: i64,
}

async fn claim_next_pending_local_apply(
    db: &Connection,
) -> Result<Option<PendingLocalApplyRow>, String> {
    let now = now_ms();

    let mut rows = db
        .query(
            "
            SELECT
                ID_Pending,
                Op_Id,
                Command_Name,
                Payload_Json,
                Result_Json,
                Attempt_Count,
                Status,
                Next_Retry_At_Ms
            FROM Pending_Local_Applies
            WHERE Status IN ('PENDING', 'FAILED', 'PROCESSING')
            ORDER BY
              Created_At_Ms ASC,
              ID_Pending ASC
            LIMIT 1;
            ",
            params![],
        )
        .await
        .map_err(|e| format!("claim_pending_query_failed:{e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("claim_pending_row_failed:{e}"))?
    else {
        return Ok(None);
    };

    let id_pending: i64 = row
        .get(0)
        .map_err(|e| format!("claim_id_pending_failed:{e}"))?;

    let op_id: String = row
        .get(1)
        .map_err(|e| format!("claim_op_id_failed:{e}"))?;

    let command_name: String = row
        .get(2)
        .map_err(|e| format!("claim_command_name_failed:{e}"))?;

    let payload_json: String = row
        .get(3)
        .map_err(|e| format!("claim_payload_json_failed:{e}"))?;

    let result_json: Option<String> = row
        .get(4)
        .map_err(|e| format!("claim_result_json_failed:{e}"))?;

    let attempt_count: i64 = row
        .get(5)
        .map_err(|e| format!("claim_attempt_count_failed:{e}"))?;

    let status: String = row
        .get(6)
        .map_err(|e| format!("claim_status_failed:{e}"))?;

    let next_retry_at_ms: Option<i64> = row
        .get(7)
        .map_err(|e| format!("claim_next_retry_failed:{e}"))?;

    if status == "PROCESSING" {
        return Ok(None);
    }

    if status == "FAILED" {
        if let Some(ts) = next_retry_at_ms {
            if ts > now {
                return Ok(None);
            }
        }
    }

    let changed = db
        .execute(
            "
            UPDATE Pending_Local_Applies
            SET
                Status = 'PROCESSING',
                Updated_At_Ms = ?2,
                Last_Attempt_At_Ms = ?3
            WHERE ID_Pending = ?1
              AND Status IN ('PENDING', 'FAILED');
            ",
            params![id_pending, now, now],
        )
        .await
        .map_err(|e| format!("claim_pending_update_failed:{e}"))?;

    if changed == 0 {
        return Ok(None);
    }

    Ok(Some(PendingLocalApplyRow {
        id_pending,
        op_id,
        command_name,
        payload_json,
        result_json,
        attempt_count,
    }))
}

async fn mark_pending_applied(db: &Connection, id_pending: i64) -> Result<(), String> {
    let now = now_ms();

    db.execute(
        "
        UPDATE Pending_Local_Applies
        SET
            Status = 'APPLIED',
            Last_Error = NULL,
            Updated_At_Ms = ?2,
            Next_Retry_At_Ms = NULL
        WHERE ID_Pending = ?1;
        ",
        params![id_pending, now],
    )
    .await
    .map_err(|e| format!("mark_pending_applied_failed:{e}"))?;

    Ok(())
}

async fn mark_pending_failed(
    db: &Connection,
    id_pending: i64,
    current_attempt_count: i64,
    error: &str,
) -> Result<(), String> {
    let now = now_ms();
    let next_attempt = current_attempt_count + 1;
    let next_retry_at = next_retry_ms(next_attempt);

    db.execute(
        "
        UPDATE Pending_Local_Applies
        SET
            Status = 'FAILED',
            Attempt_Count = ?2,
            Last_Error = ?3,
            Updated_At_Ms = ?4,
            Next_Retry_At_Ms = ?5
        WHERE ID_Pending = ?1;
        ",
        params![id_pending, next_attempt, error, now, next_retry_at],
    )
    .await
    .map_err(|e| format!("mark_pending_failed_failed:{e}"))?;

    Ok(())
}

pub async fn run_sync_manager_once(db: Arc<Connection>) -> Result<(), String> {
    let _guard = match RUN_LOCK.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Ok(()),
    };

    recover_stale_processing_rows(&db).await?;

    loop {
        let Some(row) = claim_next_pending_local_apply(&db).await? else {
            break;
        };

        let apply_res = cloud_sync::apply_local_command_from_payload(
            db.clone(),
            &row.op_id,
            &row.command_name,
            &row.payload_json,
            row.result_json.as_deref(),
            "afterRemoteOk",
        )
        .await;

        match apply_res {
            Ok(()) => {
                mark_pending_applied(&db, row.id_pending).await?;
            }
            Err(err) => {
                mark_pending_failed(&db, row.id_pending, row.attempt_count, &err).await?;
                break;
            }
        }
    }

    Ok(())
}

pub fn spawn_sync_manager_once(db: Arc<Connection>) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_sync_manager_once(db).await {
            eprintln!("[sync_manager] run failed: {err}");
        }
    });
}

pub fn start_sync_manager_loop(db: Arc<Connection>) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(err) = run_sync_manager_once(db.clone()).await {
                eprintln!("[sync_manager] periodic run failed: {err}");
            }

            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });
}

#[tauri::command]
pub async fn sync_enqueue_pending_local_apply(
    state: State<'_, AppState>,
    args: SyncEnqueuePendingLocalApplyArgs,
) -> Result<(), String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = normalize_required(&args.command_name, "command_name")?;
    let payload_json = normalize_required(&args.payload_json, "payload_json")?;

    let db = get_db(&state).await?;
    let now = now_ms();

    db.execute(
        "
        INSERT INTO Pending_Local_Applies (
            Op_Id,
            Command_Name,
            Payload_Json,
            Result_Json,
            Status,
            Attempt_Count,
            Last_Error,
            Created_At_Ms,
            Updated_At_Ms,
            Last_Attempt_At_Ms,
            Next_Retry_At_Ms
        )
        VALUES (
            ?1,
            ?2,
            ?3,
            ?4,
            'PENDING',
            0,
            NULL,
            ?5,
            ?6,
            NULL,
            NULL
        )
        ON CONFLICT(Op_Id) DO UPDATE SET
            Command_Name = excluded.Command_Name,
            Payload_Json = excluded.Payload_Json,
            Result_Json = excluded.Result_Json,
            Status = CASE
                WHEN Pending_Local_Applies.Status = 'APPLIED' THEN 'APPLIED'
                ELSE 'PENDING'
            END,
            Last_Error = NULL,
            Updated_At_Ms = excluded.Updated_At_Ms,
            Next_Retry_At_Ms = NULL;
        ",
        params![
            op_id,
            command_name,
            payload_json,
            args.result_json,
            now,
            now
        ],
    )
    .await
    .map_err(|e| format!("enqueue_pending_local_apply_failed:{e}"))?;

    spawn_sync_manager_once(db);

    Ok(())
}

#[tauri::command]
pub async fn sync_manager_kick(state: State<'_, AppState>) -> Result<(), String> {
    let db = get_db(&state).await?;
    spawn_sync_manager_once(db);
    Ok(())
}

#[tauri::command]
pub async fn sync_pending_local_apply_count(
    state: State<'_, AppState>,
) -> Result<SyncPendingCountResult, String> {
    let db = get_db(&state).await?;

    Ok(SyncPendingCountResult {
        pending: pending_count(&db, "PENDING").await?,
        failed: pending_count(&db, "FAILED").await?,
        processing: pending_count(&db, "PROCESSING").await?,
    })
}