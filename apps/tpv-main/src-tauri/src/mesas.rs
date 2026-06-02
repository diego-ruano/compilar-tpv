// src-tauri/src/mesas.rs
use crate::{get_db, AppState};

use chrono::{Local, NaiveDate, NaiveTime, TimeZone};
use libsql::{Connection, Value};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri::State;

/* =========================================================
   Helpers Value -> Rust
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

fn parse_db_id(id: &str, prefix: &str) -> Option<i64> {
    let s = id.trim();
    let rest = s.strip_prefix(prefix)?;

    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    rest.parse::<i64>().ok()
}

fn build_in_placeholders(start: i64, count: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start + i as i64))
        .collect::<Vec<_>>()
        .join(", ")
}

fn deterministic_batch_from_op_id(op_id: &str) -> String {
    let hash = sha256_hex_str(op_id);
    format!("VR:{}", &hash[..16])
}

async fn begin(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

async fn commit(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("COMMIT;")
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

async fn rollback(conn: &Connection) {
    let _ = conn.execute_batch("ROLLBACK;").await;
}

async fn select_one_i64(
    conn: &Connection,
    sql: &str,
    args: Vec<Value>,
) -> Result<Option<i64>, String> {
    let mut rows = conn
        .query(sql, args)
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    if let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    {
        return Ok(v_i64(
            row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?,
        ));
    }

    Ok(None)
}

async fn select_one_f64(
    conn: &Connection,
    sql: &str,
    args: Vec<Value>,
) -> Result<Option<f64>, String> {
    let mut rows = conn
        .query(sql, args)
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    if let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    {
        return Ok(v_f64(
            row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?,
        ));
    }

    Ok(None)
}

async fn try_exec(db: &Connection, sql: &str, args: Vec<Value>) -> Result<bool, String> {
    match db.execute(sql, args).await {
        Ok(_) => Ok(true),
        Err(e) => {
            let msg = e.to_string().to_lowercase();

            if msg.contains("no such column") || msg.contains("no such table") {
                Ok(false)
            } else {
                Err(e.to_string())
            }
        }
    }
}

async fn exists_by_id(
    conn: &Connection,
    table: &str,
    id_col: &str,
    id: i64,
) -> Result<bool, String> {
    if id <= 0 {
        return Ok(false);
    }

    let sql = format!("SELECT 1 FROM {table} WHERE {id_col}=?1 LIMIT 1;");

    Ok(select_one_i64(conn, &sql, vec![Value::Integer(id)])
        .await?
        .is_some())
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
        command_name: v_string(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default(),
        request_hash: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
        status: v_string(row.get_value(2).map_err(|e| e.to_string())?)
            .unwrap_or_else(|| "PROCESSING".to_string()),
        result_json: match row.get_value(3).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        error_text: match row.get_value(4).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
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

    let command_name = v_string(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default();

    let payload_json =
        v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_else(|| "{}".to_string());

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
   Tipos layout
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomPoly {
    #[serde(rename = "type")]
    pub kind: String,
    pub points: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInput {
    pub id: String,
    pub name: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub radius: Option<i64>,
    pub seats: i64,
    pub shape: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalonInput {
    pub id: String,
    pub name: String,
    pub room: RoomPoly,
    pub tables: Vec<TableInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableOut {
    pub id: String,
    pub name: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub radius: Option<i64>,
    pub seats: i64,
    pub shape: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SalonOut {
    pub id: String,
    pub name: String,
    pub room: RoomPoly,
    pub tables: Vec<TableOut>,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct SaveLayoutArgs {
    pub op_id: String,
    pub salons: Vec<SalonInput>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetReservaEstadoArgs {
    pub op_id: String,
    pub id_reserva: i64,
    pub estado: String,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IdMesaArgs {
    pub id_mesa: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IdComandaArgs {
    pub id_comanda: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AbrirComandaArgs {
    pub op_id: String,
    pub id_mesa: i64,

    #[serde(default)]
    pub id_trabajador: Option<i64>,

    #[serde(default)]
    pub id_usuario: Option<i64>,

    #[serde(default)]
    pub id_reserva: Option<i64>,

    #[serde(default)]
    pub id_comanda: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComandaSetTrabajadorIfNullArgs {
    pub op_id: String,
    pub id_comanda: i64,

    #[serde(default)]
    pub id_usuario: Option<i64>,

    #[serde(default)]
    pub id_trabajador: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CerrarComandaArgs {
    pub op_id: String,
    pub id_comanda: i64,
    pub total: f64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AddLineaComandaArgs {
    pub op_id: String,
    pub id_comanda: i64,
    pub id_producto: i64,
    pub cantidad: f64,
    pub precio: f64,

    #[serde(default)]
    pub id_usuario: Option<i64>,

    #[serde(default)]
    pub id_trabajador: Option<i64>,

    #[serde(default)]
    pub id_detalle: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetOrCreateMesaBarraArgs {
    pub op_id: String,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GetOrCreateComandaBarraArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_trabajador: Option<i64>,

    #[serde(default)]
    pub id_comanda: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CobroVRItem {
    pub producto_id: i64,
    pub precio: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CobrarVentaRapidaArgs {
    pub op_id: String,
    pub metodo: String,
    pub items: Vec<CobroVRItem>,

    #[serde(default)]
    pub id_usuario_cobrador: Option<i64>,

    #[serde(default)]
    pub id_trabajador_cobrador: Option<i64>,

    #[serde(default)]
    pub id_comanda: Option<i64>,

    #[serde(default)]
    pub id_pago: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateComandaBarraArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_trabajador: Option<i64>,

    #[serde(default)]
    pub id_comanda: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ListComandasBarraArgs {
    #[serde(default)]
    pub include_pagadas: Option<bool>,

    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteComandaBarraIfSafeArgs {
    pub op_id: String,
    pub id_comanda: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IdCategoriaArgs {
    pub id_categoria: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SearchProductosArgs {
    #[serde(default)]
    pub q: Option<String>,

    #[serde(default)]
    pub query: Option<String>,

    #[serde(default)]
    pub texto: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoveOnePendingDetalleArgs {
    pub op_id: String,
    pub id_comanda: i64,
    pub id_producto: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteDetalleArgs {
    pub op_id: String,
    pub id_detalle: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateDetalleNotaArgs {
    pub op_id: String,
    pub id_detalle: i64,

    #[serde(default)]
    pub nota: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CobrarDetallesArgs {
    pub op_id: String,
    pub id_comanda: i64,
    pub metodo: String,
    pub tipo: String,
    pub detalle_ids: Vec<i64>,

    #[serde(default)]
    pub id_usuario: Option<i64>,

    #[serde(default)]
    pub id_pago: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KitchenSetLineStateArgs {
    pub op_id: String,
    pub id_detalle: i64,
    pub id_usuario_cocinero: i64,
    pub estado: String,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   Helpers dominio
========================================================= */

async fn trabajador_id_from_usuario(
    db: &Connection,
    id_usuario: Option<i64>,
) -> Result<Option<i64>, String> {
    let Some(idu) = id_usuario.filter(|n| *n > 0) else {
        return Ok(None);
    };

    select_one_i64(
        db,
        "SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario=?1 LIMIT 1;",
        vec![Value::Integer(idu)],
    )
    .await
}

async fn resolve_trabajador_id_input(
    db: &Connection,
    id_maybe: Option<i64>,
) -> Result<Option<i64>, String> {
    let Some(x) = id_maybe.filter(|n| *n > 0) else {
        return Ok(None);
    };

    let mut rows = db
        .query(
            "SELECT 1 FROM Trabajadores WHERE ID_Trabajador=?1 LIMIT 1;",
            vec![Value::Integer(x)],
        )
        .await
        .map_err(|e| e.to_string())?;

    if rows.next().await.map_err(|e| e.to_string())?.is_some() {
        return Ok(Some(x));
    }

    trabajador_id_from_usuario(db, Some(x)).await
}

fn update_total_comanda_sql() -> &'static str {
    r#"
    UPDATE Comandas
    SET Total_Comanda = (
      SELECT IFNULL(SUM(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)), 0)
      FROM Detalle_Comanda
      WHERE ID_Comanda = ?1
    )
    WHERE ID_Comanda = ?1;
    "#
}

async fn sumar_gasto_cliente_por_comanda(
    db: &Connection,
    id_comanda: i64,
    importe: f64,
) -> Result<(), String> {
    if !importe.is_finite() || importe <= 0.0 {
        return Ok(());
    }

    let importe = (importe * 100.0).round() / 100.0;

    let mut id_reserva = select_one_i64(
        db,
        "SELECT ID_Reserva FROM Comandas WHERE ID_Comanda=?1 LIMIT 1;",
        vec![Value::Integer(id_comanda)],
    )
    .await?;

    if id_reserva.is_none() {
        id_reserva = select_one_i64(
            db,
            r#"
            SELECT r.ID_Reserva
            FROM Reservas r
            JOIN Comandas c ON c.ID_Mesa = r.ID_Mesa
            WHERE c.ID_Comanda = ?1
              AND r.Estado = 'ACTIVA'
            ORDER BY r.ID_Reserva DESC
            LIMIT 1;
            "#,
            vec![Value::Integer(id_comanda)],
        )
        .await?;

        if let Some(rid) = id_reserva {
            let _ = db
                .execute(
                    "UPDATE Comandas SET ID_Reserva=?2 WHERE ID_Comanda=?1;",
                    vec![Value::Integer(id_comanda), Value::Integer(rid)],
                )
                .await;
        }
    }

    let Some(id_reserva) = id_reserva else {
        return Ok(());
    };

    let Some(id_cliente) = select_one_i64(
        db,
        "SELECT ID_Cliente FROM Reservas WHERE ID_Reserva=?1 LIMIT 1;",
        vec![Value::Integer(id_reserva)],
    )
    .await?
    else {
        return Ok(());
    };

    let ok = try_exec(
        db,
        r#"
        UPDATE Clientes
        SET Total_Gastado = COALESCE(Total_Gastado,0) + ?2
        WHERE ID_Cliente = ?1;
        "#,
        vec![Value::Integer(id_cliente), Value::Real(importe)],
    )
    .await?;

    if !ok {
        eprintln!(
            "[WARN] No se pudo actualizar Clientes.Total_Gastado (ID_Cliente={}).",
            id_cliente
        );
    }

    Ok(())
}

/* =========================================================
   1) LAYOUT
========================================================= */

#[tauri::command]
pub async fn save_layout(
    state: State<'_, AppState>,
    args: SaveLayoutArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = "mesas.saveLayout";

    let domain_args = json!({
        "salons": args.salons.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        for z in args.salons.iter() {
            let zone_name = normalize_required(&z.name, "zone_name")?;
            let points_json = serde_json::to_string(&z.room.points).map_err(|e| e.to_string())?;

            let id_zona_opt = parse_db_id(&z.id, "db-zona-");

            let zone_id: i64 = if let Some(id_zona) = id_zona_opt {
                db.execute(
                    r#"
                    INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points, Updated_At)
                    VALUES (?1, ?2, ?3, datetime('now','localtime'))
                    ON CONFLICT(ID_Zona) DO UPDATE SET
                      Nombre_Zona = excluded.Nombre_Zona,
                      Room_Points = excluded.Room_Points,
                      Updated_At  = excluded.Updated_At;
                    "#,
                    vec![
                        Value::Integer(id_zona),
                        Value::Text(zone_name.clone()),
                        Value::Text(points_json.clone()),
                    ],
                )
                .await
                .map_err(|e| e.to_string())?;

                id_zona
            } else {
                db.execute(
                    r#"
                    INSERT INTO Zonas (Nombre_Zona, Room_Points, Updated_At)
                    VALUES (?1, ?2, datetime('now','localtime'))
                    ON CONFLICT(Nombre_Zona) DO UPDATE SET
                      Room_Points = excluded.Room_Points,
                      Updated_At  = excluded.Updated_At;
                    "#,
                    vec![
                        Value::Text(zone_name.clone()),
                        Value::Text(points_json.clone()),
                    ],
                )
                .await
                .map_err(|e| e.to_string())?;

                select_one_i64(
                    &db,
                    "SELECT ID_Zona FROM Zonas WHERE Nombre_Zona=?1 LIMIT 1;",
                    vec![Value::Text(zone_name.clone())],
                )
                .await?
                .ok_or_else(|| "No se pudo resolver ID_Zona".to_string())?
            };

            let mut kept: Vec<i64> = vec![];

            for t in z.tables.iter() {
                if let Some(idm) = parse_db_id(&t.id, "db-mesa-") {
                    if idm > 0 {
                        kept.push(idm);
                    }
                }
            }

            let mut sql = String::from(
                r#"
                DELETE FROM Mesas
                WHERE ID_Zona = ?1
                  AND Es_Sistema = 0
                "#,
            );

            let mut sql_args: Vec<Value> = vec![Value::Integer(zone_id)];

            if !kept.is_empty() {
                sql.push_str(" AND ID_Mesa NOT IN (");

                for (i, idm) in kept.iter().enumerate() {
                    let idx = (i + 2) as i64;

                    if i > 0 {
                        sql.push_str(", ");
                    }

                    sql.push_str(&format!("?{idx}"));
                    sql_args.push(Value::Integer(*idm));
                }

                sql.push(')');
            }

            sql.push_str(
                r#"
                  AND NOT EXISTS (SELECT 1 FROM Comandas C WHERE C.ID_Mesa = Mesas.ID_Mesa)
                  AND NOT EXISTS (SELECT 1 FROM Reservas R WHERE R.ID_Mesa = Mesas.ID_Mesa);
                "#,
            );

            db.execute(&sql, sql_args)
                .await
                .map_err(|e| e.to_string())?;

            for t in z.tables.iter() {
                let id_mesa_opt = parse_db_id(&t.id, "db-mesa-");

                let numero_mesa = normalize_required(&t.name, "numero_mesa")?;
                let capacidad = if t.seats > 0 { t.seats } else { 4 };
                let x = t.x;
                let y = t.y;

                let shape = if t.shape.trim().is_empty() {
                    "rounded".to_string()
                } else {
                    t.shape.trim().to_string()
                };

                let width = if t.width > 0 { t.width } else { 120 };
                let height = if t.height > 0 { t.height } else { 70 };
                let radius = t.radius;

                if let Some(id_mesa) = id_mesa_opt {
                    db.execute(
                        r#"
                        UPDATE Mesas
                        SET
                          ID_Zona = ?1,
                          Numero_Mesa = ?2,
                          Capacidad = ?3,
                          Ubicacion_X = ?4,
                          Ubicacion_Y = ?5,
                          Shape = ?6,
                          Width = ?7,
                          Height = ?8,
                          Radius = ?9,
                          Updated_At = datetime('now','localtime')
                        WHERE ID_Mesa = ?10;
                        "#,
                        vec![
                            Value::Integer(zone_id),
                            Value::Text(numero_mesa),
                            Value::Integer(capacidad),
                            Value::Integer(x),
                            Value::Integer(y),
                            Value::Text(shape),
                            Value::Integer(width),
                            Value::Integer(height),
                            radius.map(Value::Integer).unwrap_or(Value::Null),
                            Value::Integer(id_mesa),
                        ],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                } else {
                    db.execute(
                        r#"
                        INSERT INTO Mesas (
                          ID_Zona, Numero_Mesa, Capacidad,
                          Ubicacion_X, Ubicacion_Y,
                          Shape, Width, Height, Radius,
                          Updated_At, Es_Sistema
                        )
                        VALUES (
                          ?1, ?2, ?3,
                          ?4, ?5,
                          ?6, ?7, ?8, ?9,
                          datetime('now','localtime'),
                          0
                        )
                        ON CONFLICT(ID_Zona, Numero_Mesa) DO UPDATE SET
                          Capacidad   = excluded.Capacidad,
                          Ubicacion_X = excluded.Ubicacion_X,
                          Ubicacion_Y = excluded.Ubicacion_Y,
                          Shape       = excluded.Shape,
                          Width       = excluded.Width,
                          Height      = excluded.Height,
                          Radius      = excluded.Radius,
                          Updated_At  = excluded.Updated_At;
                        "#,
                        vec![
                            Value::Integer(zone_id),
                            Value::Text(numero_mesa),
                            Value::Integer(capacidad),
                            Value::Integer(x),
                            Value::Integer(y),
                            Value::Text(shape),
                            Value::Integer(width),
                            Value::Integer(height),
                            radius.map(Value::Integer).unwrap_or(Value::Null),
                        ],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                }
            }
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn load_layout(state: State<'_, AppState>) -> Result<Vec<SalonOut>, String> {
    let db = get_db(&state).await?;

    let mut zonas = db
        .query(
            r#"
            SELECT ID_Zona, Nombre_Zona, Room_Points
            FROM Zonas
            ORDER BY ID_Zona ASC;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut mesas_rows = db
        .query(
            r#"
            SELECT ID_Mesa, ID_Zona, Numero_Mesa, Capacidad,
                   Ubicacion_X, Ubicacion_Y,
                   Shape, Width, Height, Radius
            FROM Mesas
            WHERE Es_Sistema = 0
            ORDER BY ID_Zona ASC, ID_Mesa ASC;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut by_zona: HashMap<i64, Vec<TableOut>> = HashMap::new();

    while let Some(r) = mesas_rows.next().await.map_err(|e| e.to_string())? {
        let id_mesa = match r.get_value(0).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => continue,
        };

        let id_zona = match r.get_value(1).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => continue,
        };

        let numero = match r.get_value(2).map_err(|e| e.to_string())? {
            Value::Text(s) => s,
            _ => format!("Mesa {id_mesa}"),
        };

        let cap = match r.get_value(3).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => 4,
        };

        let x = match r.get_value(4).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => 0,
        };

        let y = match r.get_value(5).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => 0,
        };

        let shape = match r.get_value(6).map_err(|e| e.to_string())? {
            Value::Text(s) => s,
            _ => "rounded".into(),
        };

        let w = match r.get_value(7).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => 120,
        };

        let h = match r.get_value(8).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => 70,
        };

        let radius = match r.get_value(9).map_err(|e| e.to_string())? {
            Value::Null => None,
            Value::Integer(n) => Some(n),
            _ => None,
        };

        by_zona.entry(id_zona).or_default().push(TableOut {
            id: format!("db-mesa-{id_mesa}"),
            name: numero,
            x,
            y,
            width: w,
            height: h,
            radius,
            seats: cap,
            shape,
        });
    }

    let mut out: Vec<SalonOut> = vec![];

    while let Some(z) = zonas.next().await.map_err(|e| e.to_string())? {
        let id_zona = match z.get_value(0).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => continue,
        };

        let nombre = match z.get_value(1).map_err(|e| e.to_string())? {
            Value::Text(s) => s,
            _ => format!("Zona {id_zona}"),
        };

        let room_points_raw = match z.get_value(2).map_err(|e| e.to_string())? {
            Value::Text(s) => s,
            _ => "[]".into(),
        };

        let points: Vec<f64> = match serde_json::from_str(&room_points_raw) {
            Ok(v) => v,
            Err(e) => {
                eprintln!(
                    "Room_Points parse error (ID_Zona={}) => {} RAW={}",
                    id_zona, e, room_points_raw
                );
                vec![]
            }
        };

        out.push(SalonOut {
            id: format!("db-zona-{id_zona}"),
            name: nombre,
            room: RoomPoly {
                kind: "poly".into(),
                points,
            },
            tables: by_zona.remove(&id_zona).unwrap_or_default(),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn get_mesas_ocupadas(
    state: State<'_, AppState>,
) -> Result<HashMap<String, bool>, String> {
    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT M.ID_Zona, C.ID_Mesa
            FROM Comandas C
            JOIN Mesas M ON M.ID_Mesa = C.ID_Mesa
            WHERE C.Estado = 'Abierta';
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut map: HashMap<String, bool> = HashMap::new();

    while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        let id_zona = match r.get_value(0).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => continue,
        };

        let id_mesa = match r.get_value(1).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => continue,
        };

        map.insert(format!("db-zona-{id_zona}:db-mesa-{id_mesa}"), true);
    }

    Ok(map)
}

/* =========================================================
   RESERVAS
========================================================= */

#[tauri::command]
pub async fn set_reserva_estado(
    state: State<'_, AppState>,
    args: SetReservaEstadoArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let estado = normalize_required(&args.estado, "estado")?.to_uppercase();

    if args.id_reserva <= 0 {
        return Err("ID_Reserva inválido".into());
    }

    let command_name = "reservas.setEstado";

    let domain_args = json!({
        "id_reserva": args.id_reserva,
        "estado": estado.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            UPDATE Reservas
            SET Estado=?2
            WHERE ID_Reserva=?1;
            "#,
            vec![Value::Integer(args.id_reserva), Value::Text(estado.clone())],
        )
        .await
        .map_err(|e| e.to_string())?;

        if estado == "FINALIZADA" || estado == "CANCELADA" || estado == "NO_SHOW" {
            db.execute(
                r#"
                UPDATE Comandas
                SET ID_Reserva = NULL
                WHERE ID_Reserva = ?1;
                "#,
                vec![Value::Integer(args.id_reserva)],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

/* =========================================================
   COMANDAS
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComandaRow {
    pub id_comanda: i64,
    pub id_mesa: i64,
    pub id_trabajador: Option<i64>,
    pub id_reserva: Option<i64>,
    pub fecha_hora_apertura: String,
    pub fecha_hora_cierre: Option<String>,
    pub total_comanda: f64,
    pub estado: String,
}

async fn read_comanda_by_id(
    db: &Connection,
    id_comanda: i64,
) -> Result<Option<ComandaRow>, String> {
    if id_comanda <= 0 {
        return Ok(None);
    }

    let mut rows = db
        .query(
            r#"
            SELECT
              ID_Comanda,
              ID_Mesa,
              ID_Trabajador,
              ID_Reserva,
              Fecha_Hora_Apertura,
              Fecha_Hora_Cierre,
              Total_Comanda,
              Estado
            FROM Comandas
            WHERE ID_Comanda = ?1
            LIMIT 1;
            "#,
            vec![Value::Integer(id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let Some(r) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    Ok(Some(ComandaRow {
        id_comanda: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
        id_mesa: v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
        id_trabajador: v_i64(r.get_value(2).map_err(|e| e.to_string())?),
        id_reserva: v_i64(r.get_value(3).map_err(|e| e.to_string())?),
        fecha_hora_apertura: v_string(r.get_value(4).map_err(|e| e.to_string())?)
            .unwrap_or_default(),
        fecha_hora_cierre: v_string(r.get_value(5).map_err(|e| e.to_string())?),
        total_comanda: v_f64(r.get_value(6).map_err(|e| e.to_string())?).unwrap_or(0.0),
        estado: v_string(r.get_value(7).map_err(|e| e.to_string())?)
            .unwrap_or_else(|| "Abierta".into()),
    }))
}

#[tauri::command]
pub async fn get_comanda_abierta_by_mesa(
    state: State<'_, AppState>,
    args: IdMesaArgs,
) -> Result<Option<ComandaRow>, String> {
    let db = get_db(&state).await?;

    if args.id_mesa <= 0 {
        return Ok(None);
    }

    let id = select_one_i64(
        &db,
        r#"
        SELECT ID_Comanda
        FROM Comandas
        WHERE ID_Mesa = ?1
          AND Estado = 'Abierta'
        ORDER BY ID_Comanda DESC
        LIMIT 1;
        "#,
        vec![Value::Integer(args.id_mesa)],
    )
    .await?;

    match id {
        Some(id_comanda) => read_comanda_by_id(&db, id_comanda).await,
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn abrir_comanda(
    state: State<'_, AppState>,
    args: AbrirComandaArgs,
) -> Result<Option<ComandaRow>, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_mesa <= 0 {
        return Err("id_mesa inválido".into());
    }

    let id_usuario_or_trabajador = args.id_usuario.or(args.id_trabajador).filter(|n| *n > 0);
    let id_reserva = args.id_reserva.filter(|n| *n > 0);
    let id_comanda_forced = args.id_comanda.filter(|n| *n > 0);

    let command_name = "comandas.abrir";

    let domain_args = json!({
        "id_mesa": args.id_mesa,
        "id_trabajador": args.id_trabajador,
        "id_usuario": args.id_usuario,
        "id_reserva": id_reserva,
        "id_comanda": id_comanda_forced
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<Option<ComandaRow>>(existing.result_json),
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        if let Some(idc) = id_comanda_forced {
            return read_comanda_by_id(&db, idc).await;
        }

        let existing = select_one_i64(
            &db,
            r#"
            SELECT ID_Comanda
            FROM Comandas
            WHERE ID_Mesa = ?1 AND Estado = 'Abierta'
            ORDER BY ID_Comanda DESC
            LIMIT 1;
            "#,
            vec![Value::Integer(args.id_mesa)],
        )
        .await?;

        return match existing {
            Some(idc) => read_comanda_by_id(&db, idc).await,
            None => Ok(None),
        };
    }

    let id_trabajador_real = resolve_trabajador_id_input(&db, id_usuario_or_trabajador).await?;

    begin(&db).await?;

    let res: Result<Option<ComandaRow>, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let id_reserva_final = match id_reserva {
            Some(rid) => Some(rid),
            None => {
                select_one_i64(
                    &db,
                    r#"
                    SELECT ID_Reserva
                    FROM Reservas
                    WHERE ID_Mesa = ?1 AND Estado='ACTIVA'
                    ORDER BY ID_Reserva DESC
                    LIMIT 1;
                    "#,
                    vec![Value::Integer(args.id_mesa)],
                )
                .await?
            }
        };

        let id_comanda_new = if let Some(idc) = id_comanda_forced {
            db.execute(
                r#"
                INSERT OR IGNORE INTO Comandas (
                  ID_Comanda,
                  ID_Mesa,
                  ID_Trabajador,
                  ID_Reserva,
                  Fecha_Hora_Apertura,
                  Total_Comanda,
                  Estado
                )
                VALUES (
                  ?1,
                  ?2,
                  ?3,
                  ?4,
                  datetime('now','localtime'),
                  0,
                  'Abierta'
                );
                "#,
                vec![
                    Value::Integer(idc),
                    Value::Integer(args.id_mesa),
                    id_trabajador_real
                        .map(Value::Integer)
                        .unwrap_or(Value::Null),
                    id_reserva_final.map(Value::Integer).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;

            idc
        } else {
            db.execute(
                r#"
                INSERT INTO Comandas (
                  ID_Mesa,
                  ID_Trabajador,
                  ID_Reserva,
                  Fecha_Hora_Apertura,
                  Total_Comanda,
                  Estado
                )
                VALUES (
                  ?1,
                  ?2,
                  ?3,
                  datetime('now','localtime'),
                  0,
                  'Abierta'
                );
                "#,
                vec![
                    Value::Integer(args.id_mesa),
                    id_trabajador_real
                        .map(Value::Integer)
                        .unwrap_or(Value::Null),
                    id_reserva_final.map(Value::Integer).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;

            select_one_i64(&db, "SELECT last_insert_rowid();", vec![])
                .await?
                .ok_or_else(|| "No se pudo obtener ID_Comanda".to_string())?
        };

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = read_comanda_by_id(&db, id_comanda_new).await?;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn comanda_set_trabajador_if_null(
    state: State<'_, AppState>,
    args: ComandaSetTrabajadorIfNullArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_comanda <= 0 {
        return Ok(false);
    }

    let id_usuario_or_trabajador = args.id_usuario.or(args.id_trabajador).filter(|n| *n > 0);

    let Some(idt) = resolve_trabajador_id_input(&db, id_usuario_or_trabajador).await? else {
        return Ok(false);
    };

    let command_name = "comandas.setTrabajadorIfNull";

    let domain_args = json!({
        "id_comanda": args.id_comanda,
        "id_usuario": args.id_usuario,
        "id_trabajador": args.id_trabajador
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let changed = db
            .execute(
                r#"
                UPDATE Comandas
                SET ID_Trabajador = ?2
                WHERE ID_Comanda = ?1
                  AND Estado = 'Abierta'
                  AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0)
                  AND NOT EXISTS (
                    SELECT 1 FROM Detalle_Comanda dc
                    WHERE dc.ID_Comanda = ?1
                  );
                "#,
                vec![Value::Integer(args.id_comanda), Value::Integer(idt)],
            )
            .await
            .map_err(|e| e.to_string())?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = changed > 0;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn cerrar_comanda(
    state: State<'_, AppState>,
    args: CerrarComandaArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_comanda <= 0 {
        return Err("id_comanda inválido".into());
    }

    if !args.total.is_finite() || args.total < 0.0 {
        return Err("total inválido".into());
    }

    let command_name = "comandas.cerrar";

    let domain_args = json!({
        "id_comanda": args.id_comanda,
        "total": args.total
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            UPDATE Comandas
            SET
              Estado = 'Pagada',
              Total_Comanda = ?2,
              Fecha_Hora_Cierre = datetime('now','localtime')
            WHERE ID_Comanda = ?1;
            "#,
            vec![Value::Integer(args.id_comanda), Value::Real(args.total)],
        )
        .await
        .map_err(|e| e.to_string())?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LineaComandaRow {
    #[serde(rename = "ID_Detalle")]
    pub id_detalle: i64,
    #[serde(rename = "ID_Comanda")]
    pub id_comanda: i64,
    #[serde(rename = "ID_Producto")]
    pub id_producto: i64,
    #[serde(rename = "Cantidad")]
    pub cantidad: f64,
    #[serde(rename = "Precio_Unitario")]
    pub precio_unitario: f64,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
    #[serde(rename = "Estado_Cocina")]
    pub estado_cocina: Option<String>,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Pasa_Cocina")]
    pub pasa_cocina: i64,
    #[serde(rename = "Pagado")]
    pub pagado: i64,
}

#[tauri::command]
pub async fn get_lineas_comanda(
    state: State<'_, AppState>,
    args: IdComandaArgs,
) -> Result<Vec<LineaComandaRow>, String> {
    let db = get_db(&state).await?;

    if args.id_comanda <= 0 {
        return Ok(vec![]);
    }

    let mut rows = db
        .query(
            r#"
            SELECT
              D.ID_Detalle,
              D.ID_Comanda,
              D.ID_Producto,
              COALESCE(D.Cantidad, 1) AS Cantidad,
              COALESCE(D.Precio_Unitario, 0) AS Precio_Unitario,
              D.Notas,
              D.Estado_Cocina,
              P.Nombre,
              COALESCE(cat.Pasa_Cocina, 0) AS Pasa_Cocina,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = D.ID_Detalle
                ) THEN 1 ELSE 0
              END AS Pagado
            FROM Detalle_Comanda D
            JOIN Productos P ON P.ID_Producto = D.ID_Producto
            JOIN Categorias_Producto cat ON cat.ID_Categoria = P.ID_Categoria
            WHERE D.ID_Comanda = ?1
            ORDER BY D.ID_Detalle ASC;
            "#,
            vec![Value::Integer(args.id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<LineaComandaRow> = vec![];

    while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        let id_detalle = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);

        if id_detalle <= 0 {
            continue;
        }

        out.push(LineaComandaRow {
            id_detalle,
            id_comanda: v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            id_producto: v_i64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0),
            cantidad: v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(1.0),
            precio_unitario: v_f64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0),
            notas: v_string(r.get_value(5).map_err(|e| e.to_string())?),
            estado_cocina: v_string(r.get_value(6).map_err(|e| e.to_string())?),
            nombre: v_string(r.get_value(7).map_err(|e| e.to_string())?).unwrap_or_default(),
            pasa_cocina: v_i64(r.get_value(8).map_err(|e| e.to_string())?).unwrap_or(0),
            pagado: v_i64(r.get_value(9).map_err(|e| e.to_string())?).unwrap_or(0),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn add_linea_comanda(
    state: State<'_, AppState>,
    args: AddLineaComandaArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_comanda <= 0 || args.id_producto <= 0 {
        return Err("id_comanda/id_producto inválidos".into());
    }

    if !args.cantidad.is_finite() || args.cantidad <= 0.0 {
        return Err("cantidad inválida".into());
    }

    if !args.precio.is_finite() {
        return Err("precio inválido".into());
    }

    let id_detalle = args.id_detalle.filter(|n| *n > 0);
    let id_usuario_or_trabajador = args.id_usuario.or(args.id_trabajador).filter(|n| *n > 0);

    let command_name = "comandas.addLinea";

    let domain_args = json!({
        "id_comanda": args.id_comanda,
        "id_producto": args.id_producto,
        "cantidad": args.cantidad,
        "precio": args.precio,
        "id_usuario": args.id_usuario,
        "id_trabajador": args.id_trabajador,
        "id_detalle": id_detalle
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        if let Some(id_detalle) = id_detalle {
            if exists_by_id(&db, "Detalle_Comanda", "ID_Detalle", id_detalle).await? {
                maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json)
                    .await?;

                let result = "OK".to_string();
                let result_json = serialize_result_json(&result)?;

                applied_mark_applied(&db, &op_id, &result_json).await?;

                return Ok(result);
            }
        }

        let id_trabajador_real = resolve_trabajador_id_input(&db, id_usuario_or_trabajador).await?;

        if let Some(idt) = id_trabajador_real {
            db.execute(
                r#"
                UPDATE Comandas
                SET ID_Trabajador = ?2
                WHERE ID_Comanda = ?1
                  AND Estado = 'Abierta'
                  AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0);
                "#,
                vec![Value::Integer(args.id_comanda), Value::Integer(idt)],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        let pasa = select_one_i64(
            &db,
            r#"
            SELECT COALESCE(cat.Pasa_Cocina, 0) AS Pasa_Cocina
            FROM Productos p
            JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
            WHERE p.ID_Producto = ?1
            LIMIT 1;
            "#,
            vec![Value::Integer(args.id_producto)],
        )
        .await?
        .unwrap_or(0)
            == 1;

        let estado_cocina = if pasa {
            Value::Text("PENDIENTE".into())
        } else {
            Value::Null
        };

        if let Some(id_detalle) = id_detalle {
            db.execute(
                r#"
                INSERT OR IGNORE INTO Detalle_Comanda (
                  ID_Detalle,
                  ID_Comanda,
                  ID_Producto,
                  Cantidad,
                  Precio_Unitario,
                  Estado_Cocina
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6);
                "#,
                vec![
                    Value::Integer(id_detalle),
                    Value::Integer(args.id_comanda),
                    Value::Integer(args.id_producto),
                    Value::Real(args.cantidad),
                    Value::Real(args.precio),
                    estado_cocina,
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        } else {
            db.execute(
                r#"
                INSERT INTO Detalle_Comanda (
                  ID_Comanda,
                  ID_Producto,
                  Cantidad,
                  Precio_Unitario,
                  Estado_Cocina
                )
                VALUES (?1, ?2, ?3, ?4, ?5);
                "#,
                vec![
                    Value::Integer(args.id_comanda),
                    Value::Integer(args.id_producto),
                    Value::Real(args.cantidad),
                    Value::Real(args.precio),
                    estado_cocina,
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        db.execute(
            update_total_comanda_sql(),
            vec![Value::Integer(args.id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}
/* =========================================================
   VENTA RÁPIDA legacy/compat
========================================================= */

async fn get_or_create_mesa_barra_inner(db: &Connection) -> Result<i64, String> {
    if let Some(id) = select_one_i64(
        db,
        "SELECT ID_Mesa FROM Mesas WHERE Numero_Mesa='BARRA' LIMIT 1;",
        vec![],
    )
    .await?
    {
        return Ok(id);
    }

    let mut id_zona = select_one_i64(
        db,
        "SELECT ID_Zona FROM Zonas ORDER BY ID_Zona ASC LIMIT 1;",
        vec![],
    )
    .await?;

    if id_zona.is_none() {
        db.execute(
            "INSERT INTO Zonas (Nombre_Zona, Room_Points, Updated_At) VALUES ('Salon','[]', datetime('now','localtime'));",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

        id_zona = select_one_i64(
            db,
            "SELECT ID_Zona FROM Zonas ORDER BY ID_Zona ASC LIMIT 1;",
            vec![],
        )
        .await?;
    }

    let id_zona =
        id_zona.ok_or_else(|| "No se pudo resolver ID_Zona para crear BARRA.".to_string())?;

    db.execute(
        r#"
        INSERT INTO Mesas (
          ID_Zona, Numero_Mesa, Capacidad,
          Ubicacion_X, Ubicacion_Y,
          Shape, Width, Height, Radius,
          Updated_At, Es_Sistema
        )
        VALUES (
          ?1,
          'BARRA',
          0,
          0, 0,
          'rect', 80, 50, NULL,
          datetime('now','localtime'),
          1
        )
        ON CONFLICT(ID_Zona, Numero_Mesa) DO UPDATE SET
          Es_Sistema = 1,
          Updated_At = excluded.Updated_At;
        "#,
        vec![Value::Integer(id_zona)],
    )
    .await
    .map_err(|e| e.to_string())?;

    select_one_i64(
        db,
        "SELECT ID_Mesa FROM Mesas WHERE Numero_Mesa='BARRA' LIMIT 1;",
        vec![],
    )
    .await?
    .ok_or_else(|| "No se pudo crear/encontrar la mesa BARRA.".to_string())
}

async fn get_or_create_comanda_barra_inner(
    db: &Connection,
    id_trabajador: Option<i64>,
    id_comanda_forced: Option<i64>,
) -> Result<i64, String> {
    let id_mesa_barra = get_or_create_mesa_barra_inner(db).await?;

    if let Some(idc) = select_one_i64(
        db,
        r#"
        SELECT ID_Comanda
        FROM Comandas
        WHERE ID_Mesa=?1 AND Estado='Abierta'
        ORDER BY ID_Comanda DESC
        LIMIT 1;
        "#,
        vec![Value::Integer(id_mesa_barra)],
    )
    .await?
    {
        return Ok(idc);
    }

    if let Some(id_comanda) = id_comanda_forced {
        db.execute(
            r#"
            INSERT OR IGNORE INTO Comandas (
              ID_Comanda,
              ID_Mesa,
              ID_Trabajador,
              Fecha_Hora_Apertura,
              Total_Comanda,
              Estado
            )
            VALUES (
              ?1,
              ?2,
              ?3,
              datetime('now','localtime'),
              0,
              'Abierta'
            );
            "#,
            vec![
                Value::Integer(id_comanda),
                Value::Integer(id_mesa_barra),
                id_trabajador.map(Value::Integer).unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        return Ok(id_comanda);
    }

    db.execute(
        r#"
        INSERT INTO Comandas (
          ID_Mesa,
          ID_Trabajador,
          Fecha_Hora_Apertura,
          Total_Comanda,
          Estado
        )
        VALUES (
          ?1,
          ?2,
          datetime('now','localtime'),
          0,
          'Abierta'
        );
        "#,
        vec![
            Value::Integer(id_mesa_barra),
            id_trabajador.map(Value::Integer).unwrap_or(Value::Null),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    select_one_i64(db, "SELECT last_insert_rowid();", vec![])
        .await?
        .ok_or_else(|| "No se pudo abrir comanda para BARRA.".to_string())
}

#[tauri::command]
pub async fn get_or_create_mesa_barra(
    state: State<'_, AppState>,
    args: GetOrCreateMesaBarraArgs,
) -> Result<i64, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    let command_name = "mesas.getOrCreateMesaBarra";

    let domain_args = json!({});
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<i64>(existing.result_json),
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return get_or_create_mesa_barra_inner(&db).await;
    }

    begin(&db).await?;

    let res: Result<i64, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let result = get_or_create_mesa_barra_inner(&db).await?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result_json = serialize_result_json(&result)?;
        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn get_or_create_comanda_barra(
    state: State<'_, AppState>,
    args: GetOrCreateComandaBarraArgs,
) -> Result<i64, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    let id_trabajador = args.id_trabajador.filter(|n| *n > 0);
    let id_comanda = args.id_comanda.filter(|n| *n > 0);

    let command_name = "comandas.getOrCreateBarra";

    let domain_args = json!({
        "id_trabajador": id_trabajador,
        "id_comanda": id_comanda
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<i64>(existing.result_json),
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return get_or_create_comanda_barra_inner(&db, id_trabajador, id_comanda).await;
    }

    begin(&db).await?;

    let res: Result<i64, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let result = get_or_create_comanda_barra_inner(&db, id_trabajador, id_comanda).await?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result_json = serialize_result_json(&result)?;
        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn cobrar_venta_rapida(
    state: State<'_, AppState>,
    args: CobrarVentaRapidaArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    let id_usuario = args.id_usuario_cobrador.filter(|n| *n > 0);
    let id_trabajador_cobrador_input = args.id_trabajador_cobrador.filter(|n| *n > 0);
    let id_comanda_forced = args.id_comanda.filter(|n| *n > 0);
    let id_pago_forced = args.id_pago.filter(|n| *n > 0);

    let mut items = args.items.clone();
    items.retain(|it| it.producto_id > 0 && it.precio.is_finite());

    let metodo_db = if args.metodo.trim().eq_ignore_ascii_case("tarjeta") {
        "Tarjeta".to_string()
    } else {
        "Efectivo".to_string()
    };

    let command_name = "ventaRapida.cobrar";

    let domain_args = json!({
        "metodo": metodo_db,
        "id_usuario_cobrador": id_usuario,
        "id_trabajador_cobrador": id_trabajador_cobrador_input,
        "id_comanda": id_comanda_forced,
        "id_pago": id_pago_forced,
        "items": items
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        if !items.is_empty() {
            let id_trabajador_cobrador = match id_trabajador_cobrador_input {
                Some(n) if n > 0 => Some(n),
                _ => trabajador_id_from_usuario(&db, id_usuario).await?,
            };

            let id_comanda = if let Some(id_comanda) = id_comanda_forced {
                if exists_by_id(&db, "Comandas", "ID_Comanda", id_comanda).await? {
                    id_comanda
                } else {
                    get_or_create_comanda_barra_inner(&db, id_trabajador_cobrador, Some(id_comanda))
                        .await?
                }
            } else {
                get_or_create_comanda_barra_inner(&db, id_trabajador_cobrador, None).await?
            };

            let batch = deterministic_batch_from_op_id(&op_id);

            let sum = items.iter().fold(0.0, |acc, it| acc + it.precio);
            let importe_total = (sum * 100.0).round() / 100.0;

            if let Some(id_pago) = id_pago_forced {
                if exists_by_id(&db, "Pagos", "ID_Pago", id_pago).await? {
                    maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json)
                        .await?;

                    let result = "OK".to_string();
                    let result_json = serialize_result_json(&result)?;

                    applied_mark_applied(&db, &op_id, &result_json).await?;

                    return Ok(result);
                }
            }

            for it in items.iter() {
                db.execute(
                    r#"
                    INSERT INTO Detalle_Comanda (
                      ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, Notas, Estado_Cocina
                    )
                    SELECT
                      ?1 AS ID_Comanda,
                      ?2 AS ID_Producto,
                      1 AS Cantidad,
                      ?3 AS Precio_Unitario,
                      ?4 AS Notas,
                      CASE
                        WHEN COALESCE(cat.Pasa_Cocina, 0) = 1 THEN 'PENDIENTE'
                        ELSE NULL
                      END AS Estado_Cocina
                    FROM Productos p
                    JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                    WHERE p.ID_Producto = ?2
                    LIMIT 1;
                    "#,
                    vec![
                        Value::Integer(id_comanda),
                        Value::Integer(it.producto_id),
                        Value::Real(it.precio),
                        Value::Text(batch.clone()),
                    ],
                )
                .await
                .map_err(|e| e.to_string())?;
            }

            db.execute(update_total_comanda_sql(), vec![Value::Integer(id_comanda)])
                .await
                .map_err(|e| e.to_string())?;

            if let Some(id_pago) = id_pago_forced {
                let ok = try_exec(
                    &db,
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
                    );
                    "#,
                    vec![
                        Value::Integer(id_pago),
                        Value::Integer(id_comanda),
                        Value::Text(metodo_db.clone()),
                        Value::Real(importe_total),
                        id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                        id_trabajador_cobrador
                            .map(Value::Integer)
                            .unwrap_or(Value::Null),
                    ],
                )
                .await?;

                if !ok {
                    db.execute(
                        r#"
                        INSERT INTO Pagos (
                          ID_Pago,
                          ID_Comanda,
                          Fecha_Hora,
                          Metodo_Pago,
                          Importe_Total,
                          Tipo,
                          ID_Usuario_Cobrador
                        )
                        VALUES (
                          ?1,
                          ?2,
                          datetime('now','localtime'),
                          ?3,
                          ?4,
                          'FRACCIONADO',
                          ?5
                        );
                        "#,
                        vec![
                            Value::Integer(id_pago),
                            Value::Integer(id_comanda),
                            Value::Text(metodo_db.clone()),
                            Value::Real(importe_total),
                            id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                        ],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                }
            } else {
                let ok = try_exec(
                    &db,
                    r#"
                    INSERT INTO Pagos (
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
                      datetime('now','localtime'),
                      ?2,
                      ?3,
                      'FRACCIONADO',
                      ?4,
                      ?5
                    );
                    "#,
                    vec![
                        Value::Integer(id_comanda),
                        Value::Text(metodo_db.clone()),
                        Value::Real(importe_total),
                        id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                        id_trabajador_cobrador
                            .map(Value::Integer)
                            .unwrap_or(Value::Null),
                    ],
                )
                .await?;

                if !ok {
                    db.execute(
                        r#"
                        INSERT INTO Pagos (
                          ID_Comanda,
                          Fecha_Hora,
                          Metodo_Pago,
                          Importe_Total,
                          Tipo,
                          ID_Usuario_Cobrador
                        )
                        VALUES (
                          ?1,
                          datetime('now','localtime'),
                          ?2,
                          ?3,
                          'FRACCIONADO',
                          ?4
                        );
                        "#,
                        vec![
                            Value::Integer(id_comanda),
                            Value::Text(metodo_db.clone()),
                            Value::Real(importe_total),
                            id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                        ],
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                }
            }

            let id_pago = match id_pago_forced {
                Some(id) => id,
                None => select_one_i64(&db, "SELECT last_insert_rowid();", vec![])
                    .await?
                    .ok_or_else(|| "No se pudo obtener ID_Pago".to_string())?,
            };

            db.execute(
                r#"
                INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
                SELECT ?1, dc.ID_Detalle
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?2
                  AND dc.Notas = ?3;
                "#,
                vec![
                    Value::Integer(id_pago),
                    Value::Integer(id_comanda),
                    Value::Text(batch),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn create_comanda_barra(
    state: State<'_, AppState>,
    args: CreateComandaBarraArgs,
) -> Result<i64, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    let id_trabajador = args.id_trabajador.filter(|n| *n > 0);
    let id_comanda = args.id_comanda.filter(|n| *n > 0);

    let command_name = "comandas.createBarra";

    let domain_args = json!({
        "id_trabajador": id_trabajador,
        "id_comanda": id_comanda
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<i64>(existing.result_json),
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        if let Some(idc) = id_comanda {
            return Ok(idc);
        }

        return select_one_i64(&db, "SELECT last_insert_rowid();", vec![])
            .await?
            .ok_or_else(|| "No se pudo crear comanda BARRA.".to_string());
    }

    begin(&db).await?;

    let res: Result<i64, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let id_mesa_barra = get_or_create_mesa_barra_inner(&db).await?;

        let result = if let Some(idc) = id_comanda {
            db.execute(
                r#"
                INSERT OR IGNORE INTO Comandas (
                  ID_Comanda,
                  ID_Mesa,
                  ID_Trabajador,
                  Fecha_Hora_Apertura,
                  Total_Comanda,
                  Estado
                )
                VALUES (
                  ?1,
                  ?2,
                  ?3,
                  datetime('now','localtime'),
                  0,
                  'Abierta'
                );
                "#,
                vec![
                    Value::Integer(idc),
                    Value::Integer(id_mesa_barra),
                    id_trabajador.map(Value::Integer).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;

            idc
        } else {
            db.execute(
                r#"
                INSERT INTO Comandas (
                  ID_Mesa,
                  ID_Trabajador,
                  Fecha_Hora_Apertura,
                  Total_Comanda,
                  Estado
                )
                VALUES (
                  ?1,
                  ?2,
                  datetime('now','localtime'),
                  0,
                  'Abierta'
                );
                "#,
                vec![
                    Value::Integer(id_mesa_barra),
                    id_trabajador.map(Value::Integer).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;

            select_one_i64(&db, "SELECT last_insert_rowid();", vec![])
                .await?
                .ok_or_else(|| "No se pudo crear comanda BARRA.".to_string())?
        };

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result_json = serialize_result_json(&result)?;
        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ComandaBarraListItem {
    pub id_comanda: i64,
    pub fecha_hora_apertura: String,
    pub estado: String,
    pub total_pendiente: f64,
    pub total_comanda: f64,
    pub pendientes_cocina: i64,
    pub pendientes_pago: i64,
}

#[tauri::command]
pub async fn list_comandas_barra(
    state: State<'_, AppState>,
    args: ListComandasBarraArgs,
) -> Result<Vec<ComandaBarraListItem>, String> {
    let db = get_db(&state).await?;
    let id_mesa_barra = get_or_create_mesa_barra_inner(&db).await?;

    let include_pagadas = args.include_pagadas.unwrap_or(false);
    let limit = args.limit.unwrap_or(50).clamp(1, 200);

    let sql = format!(
        r#"
        SELECT
          c.ID_Comanda,
          c.Fecha_Hora_Apertura,
          c.Estado,

          (
            SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
            FROM Detalle_Comanda dc
            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
            WHERE dc.ID_Comanda = c.ID_Comanda
              AND pd.ID_Detalle IS NULL
          ) AS Total_Pendiente,

          (
            SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = c.ID_Comanda
          ) AS Total_Comanda,

          (
            SELECT COUNT(*)
            FROM Detalle_Comanda dc
            JOIN Productos p ON p.ID_Producto = dc.ID_Producto
            JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
            WHERE dc.ID_Comanda = c.ID_Comanda
              AND pd.ID_Detalle IS NULL
              AND COALESCE(cat.Pasa_Cocina, 0) = 1
              AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
          ) AS Pendientes_Cocina,

          (
            SELECT COUNT(*)
            FROM Detalle_Comanda dc
            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
            WHERE dc.ID_Comanda = c.ID_Comanda
              AND pd.ID_Detalle IS NULL
          ) AS Pendientes_Pago

        FROM Comandas c
        WHERE c.ID_Mesa = ?1
          {estado_filter}
          AND EXISTS (
            SELECT 1 FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = c.ID_Comanda
          )
        ORDER BY datetime(c.Fecha_Hora_Apertura) DESC, c.ID_Comanda DESC
        LIMIT {limit};
        "#,
        estado_filter = if include_pagadas {
            ""
        } else {
            "AND c.Estado = 'Abierta'"
        },
        limit = limit
    );

    let mut rows = db
        .query(&sql, vec![Value::Integer(id_mesa_barra)])
        .await
        .map_err(|e| e.to_string())?;

    let mut out = vec![];

    while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(ComandaBarraListItem {
            id_comanda: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            fecha_hora_apertura: v_string(r.get_value(1).map_err(|e| e.to_string())?)
                .unwrap_or_default(),
            estado: v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default(),
            total_pendiente: v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0.0),
            total_comanda: v_f64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0),
            pendientes_cocina: v_i64(r.get_value(5).map_err(|e| e.to_string())?).unwrap_or(0),
            pendientes_pago: v_i64(r.get_value(6).map_err(|e| e.to_string())?).unwrap_or(0),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn delete_comanda_barra_if_safe(
    state: State<'_, AppState>,
    args: DeleteComandaBarraIfSafeArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_comanda <= 0 {
        return Ok(false);
    }

    let command_name = "comandas.deleteBarraIfSafe";

    let domain_args = json!({
        "id_comanda": args.id_comanda
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    let paid = select_one_i64(
        &db,
        r#"
        SELECT 1
        FROM Detalle_Comanda dc
        JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
        WHERE dc.ID_Comanda = ?1
        LIMIT 1;
        "#,
        vec![Value::Integer(args.id_comanda)],
    )
    .await?
    .is_some();

    if paid {
        return Ok(false);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            "DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1;",
            vec![Value::Integer(args.id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

        let affected = db
            .execute(
                "DELETE FROM Comandas WHERE ID_Comanda = ?1;",
                vec![Value::Integer(args.id_comanda)],
            )
            .await
            .map_err(|e| e.to_string())?;

        let result = affected > 0;

        if result {
            maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;
        }

        let result_json = serialize_result_json(&result)?;
        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

/* =========================================================
   META MESAS + CATÁLOGO
========================================================= */

#[derive(Debug, Clone, Serialize)]
pub struct ReservaMesaOut {
    #[serde(rename = "idReserva")]
    pub id_reserva: i64,
    #[serde(rename = "clienteNombre")]
    pub cliente_nombre: String,
    #[serde(rename = "diaYMD")]
    pub dia_ymd: String,
    pub hora: String,
    pub estado: String,
    #[serde(rename = "minutosPara")]
    pub minutos_para: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MesaMetaOut {
    pub ocupada: bool,
    pub id_comanda: i64,
    pub idComanda: i64,
    pub totalPendiente: f64,
    pub pendientesPago: i64,
    pub pendientesCocina: i64,
    pub estado: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserva: Option<ReservaMesaOut>,
}

#[tauri::command]
pub async fn mesas_meta_all(
    state: State<'_, AppState>,
) -> Result<HashMap<i64, MesaMetaOut>, String> {
    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT
              c.ID_Mesa,
              c.ID_Comanda,

              (
                SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
                FROM Detalle_Comanda dc
                LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND pd.ID_Detalle IS NULL
              ) AS Total_Pendiente,

              (
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND pd.ID_Detalle IS NULL
              ) AS Pendientes_Pago,

              (
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                WHERE dc.ID_Comanda = c.ID_Comanda
                  AND pd.ID_Detalle IS NULL
                  AND COALESCE(cat.Pasa_Cocina, 0) = 1
                  AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
              ) AS Pendientes_Cocina

            FROM Comandas c
            WHERE c.Estado = 'Abierta';
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut map: HashMap<i64, MesaMetaOut> = HashMap::new();

    while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        let id_mesa = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let id_comanda = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

        if id_mesa <= 0 || id_comanda <= 0 {
            continue;
        }

        let total_pendiente = v_f64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0.0);
        let pendientes_pago = v_i64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0);
        let pendientes_cocina = v_i64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0);

        let estado = if pendientes_pago > 0 || total_pendiente > 0.0 {
            "PENDIENTE".to_string()
        } else {
            "LIBRE".to_string()
        };

        map.insert(
            id_mesa,
            MesaMetaOut {
                ocupada: true,
                id_comanda,
                idComanda: id_comanda,
                totalPendiente: total_pendiente,
                pendientesPago: pendientes_pago,
                pendientesCocina: pendientes_cocina,
                estado,
                reserva: None,
            },
        );
    }

    let mut rrows = db
        .query(
            r#"
            SELECT
              R.ID_Mesa,
              R.ID_Reserva,
              R.Dia_YMD,
              R.Hora,
              R.Estado,
              C.Nombre AS Cliente_Nombre
            FROM Reservas R
            JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
            WHERE R.ID_Mesa IS NOT NULL
              AND R.Estado IN ('PROXIMA','ACTIVA');
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let now = Local::now();
    let mut best: HashMap<i64, ReservaMesaOut> = HashMap::new();

    while let Some(r) = rrows.next().await.map_err(|e| e.to_string())? {
        let id_mesa = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let id_reserva = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);
        let dia_ymd = v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();
        let hora = v_string(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or_default();
        let estado_db = v_string(r.get_value(4).map_err(|e| e.to_string())?)
            .unwrap_or_else(|| "PROXIMA".into());
        let cliente = v_string(r.get_value(5).map_err(|e| e.to_string())?).unwrap_or_default();

        if id_mesa <= 0 || id_reserva <= 0 {
            continue;
        }

        let date = match NaiveDate::parse_from_str(dia_ymd.trim(), "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => continue,
        };

        let hora_trim = hora.trim();

        let time = NaiveTime::parse_from_str(hora_trim, "%H:%M")
            .or_else(|_| NaiveTime::parse_from_str(hora_trim, "%H:%M:%S"));

        let time = match time {
            Ok(t) => t,
            Err(_) => continue,
        };

        let ndt = date.and_time(time);

        let dt_local = match Local.from_local_datetime(&ndt).single() {
            Some(dt) => dt,
            None => match Local.from_local_datetime(&ndt).earliest() {
                Some(dt) => dt,
                None => continue,
            },
        };

        let minutos_para = (dt_local - now).num_minutes();

        let estado_ui = if estado_db.trim().eq_ignore_ascii_case("ACTIVA") || minutos_para <= 0 {
            "ACTIVA"
        } else {
            "PROXIMA"
        };

        let keep = if estado_ui == "ACTIVA" {
            true
        } else {
            minutos_para > 0 && minutos_para <= 60
        };

        if !keep {
            continue;
        }

        let item = ReservaMesaOut {
            id_reserva,
            cliente_nombre: cliente,
            dia_ymd,
            hora,
            estado: estado_ui.to_string(),
            minutos_para,
        };

        let replace = match best.get(&id_mesa) {
            None => true,
            Some(prev) => {
                if item.estado == "ACTIVA" && prev.estado != "ACTIVA" {
                    true
                } else if item.estado != "ACTIVA" && prev.estado == "ACTIVA" {
                    false
                } else if item.estado == "PROXIMA" && prev.estado == "PROXIMA" {
                    item.minutos_para < prev.minutos_para
                } else {
                    item.minutos_para.abs() < prev.minutos_para.abs()
                }
            }
        };

        if replace {
            best.insert(id_mesa, item);
        }
    }

    for (id_mesa, reserva) in best {
        map.entry(id_mesa)
            .and_modify(|m| m.reserva = Some(reserva.clone()))
            .or_insert_with(|| MesaMetaOut {
                ocupada: false,
                id_comanda: 0,
                idComanda: 0,
                totalPendiente: 0.0,
                pendientesPago: 0,
                pendientesCocina: 0,
                estado: "LIBRE".into(),
                reserva: Some(reserva),
            });
    }

    Ok(map)
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoriaVendibleOut {
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
    #[serde(rename = "Pasa_Cocina")]
    pub pasa_cocina: i64,
}

#[tauri::command]
pub async fn list_categorias_vendibles(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaVendibleOut>, String> {
    let db = get_db(&state).await?;

    let sql1 = r#"
        SELECT ID_Categoria, Nombre, Ruta_Imagen, COALESCE(Pasa_Cocina,0)
        FROM Categorias_Producto
        ORDER BY Nombre ASC;
    "#;

    let sql2 = r#"
        SELECT ID_Categoria, Nombre, NULL as Ruta_Imagen, 0 as Pasa_Cocina
        FROM Categorias_Producto
        ORDER BY Nombre ASC;
    "#;

    let mut rows = match db.query(sql1, ()).await {
        Ok(r) => r,
        Err(_) => db.query(sql2, ()).await.map_err(|e| e.to_string())?,
    };

    let mut out = vec![];

    while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(CategoriaVendibleOut {
            id_categoria: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            nombre: v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            ruta_imagen: v_string(r.get_value(2).map_err(|e| e.to_string())?),
            pasa_cocina: v_i64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0),
        });
    }

    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct ProductoVendibleOut {
    #[serde(rename = "ID_Producto")]
    pub id_producto: i64,
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Precio_Venta")]
    pub precio_venta: f64,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

async fn productos_query(
    db: &Connection,
    sql1: &str,
    sql2: &str,
    args: Vec<Value>,
) -> Result<Vec<ProductoVendibleOut>, String> {
    let mut rows = match db.query(sql1, args.clone()).await {
        Ok(r) => r,
        Err(_) => db.query(sql2, args).await.map_err(|e| e.to_string())?,
    };

    let mut out = vec![];

    while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(ProductoVendibleOut {
            id_producto: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            id_categoria: v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            nombre: v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default(),
            precio_venta: v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0.0),
            ruta_imagen: v_string(r.get_value(4).map_err(|e| e.to_string())?),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn list_productos_by_categoria(
    state: State<'_, AppState>,
    args: IdCategoriaArgs,
) -> Result<Vec<ProductoVendibleOut>, String> {
    let db = get_db(&state).await?;

    let sql1 = r#"
        SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), Ruta_Imagen
        FROM Productos
        WHERE ID_Categoria = ?1
        ORDER BY Nombre ASC;
    "#;

    let sql2 = r#"
        SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), NULL as Ruta_Imagen
        FROM Productos
        WHERE ID_Categoria = ?1
        ORDER BY Nombre ASC;
    "#;

    productos_query(&db, sql1, sql2, vec![Value::Integer(args.id_categoria)]).await
}

#[tauri::command]
pub async fn search_productos_by_nombre(
    state: State<'_, AppState>,
    args: SearchProductosArgs,
) -> Result<Vec<ProductoVendibleOut>, String> {
    let db = get_db(&state).await?;

    let q = args.q.or(args.query).or(args.texto).unwrap_or_default();
    let needle = format!("%{}%", q.trim().to_lowercase());

    let sql1 = r#"
        SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), Ruta_Imagen
        FROM Productos
        WHERE LOWER(Nombre) LIKE ?1
        ORDER BY Nombre ASC
        LIMIT 200;
    "#;

    let sql2 = r#"
        SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), NULL as Ruta_Imagen
        FROM Productos
        WHERE LOWER(Nombre) LIKE ?1
        ORDER BY Nombre ASC
        LIMIT 200;
    "#;

    productos_query(&db, sql1, sql2, vec![Value::Text(needle)]).await
}

/* =========================================================
   TICKET
========================================================= */

#[tauri::command]
pub async fn remove_one_pending_detalle(
    state: State<'_, AppState>,
    args: RemoveOnePendingDetalleArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_comanda <= 0 || args.id_producto <= 0 {
        return Ok("OK".into());
    }

    let command_name = "ticket.removeOnePending";

    let domain_args = json!({
        "id_comanda": args.id_comanda,
        "id_producto": args.id_producto
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            DELETE FROM Detalle_Comanda
            WHERE ID_Detalle = (
              SELECT dc.ID_Detalle
              FROM Detalle_Comanda dc
              WHERE dc.ID_Comanda = ?1
                AND dc.ID_Producto = ?2
                AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
              ORDER BY dc.ID_Detalle DESC
              LIMIT 1
            );
            "#,
            vec![
                Value::Integer(args.id_comanda),
                Value::Integer(args.id_producto),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        db.execute(
            update_total_comanda_sql(),
            vec![Value::Integer(args.id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn delete_detalle(
    state: State<'_, AppState>,
    args: DeleteDetalleArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_detalle <= 0 {
        return Ok("OK".into());
    }

    let command_name = "ticket.deleteDetalle";

    let domain_args = json!({
        "id_detalle": args.id_detalle
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let id_comanda = select_one_i64(
            &db,
            "SELECT ID_Comanda FROM Detalle_Comanda WHERE ID_Detalle=?1 LIMIT 1;",
            vec![Value::Integer(args.id_detalle)],
        )
        .await?;

        db.execute(
            r#"
            DELETE FROM Detalle_Comanda
            WHERE ID_Detalle = ?1
              AND NOT EXISTS (
                SELECT 1
                FROM Pago_Detalles pd
                WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
              );
            "#,
            vec![Value::Integer(args.id_detalle)],
        )
        .await
        .map_err(|e| e.to_string())?;

        if let Some(idc) = id_comanda {
            db.execute(update_total_comanda_sql(), vec![Value::Integer(idc)])
                .await
                .map_err(|e| e.to_string())?;
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn update_detalle_nota(
    state: State<'_, AppState>,
    args: UpdateDetalleNotaArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_detalle <= 0 {
        return Ok("OK".into());
    }

    let nota = clean_opt_string(args.nota);

    let command_name = "ticket.updateDetalleNota";

    let domain_args = json!({
        "id_detalle": args.id_detalle,
        "nota": nota
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            UPDATE Detalle_Comanda
            SET Notas = ?2
            WHERE ID_Detalle = ?1
              AND NOT EXISTS (
                SELECT 1
                FROM Pago_Detalles pd
                WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
              );
            "#,
            vec![
                Value::Integer(args.id_detalle),
                nota.map(Value::Text).unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn cobrar_detalles(
    state: State<'_, AppState>,
    args: CobrarDetallesArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    let mut ids = args.detalle_ids.clone();
    ids.sort_unstable();
    ids.dedup();
    ids.retain(|n| *n > 0);

    if args.id_comanda <= 0 || ids.is_empty() {
        return Ok("OK".into());
    }

    let metodo = normalize_required(&args.metodo, "metodo")?;
    let tipo = normalize_required(&args.tipo, "tipo")?;
    let id_usuario = args.id_usuario.filter(|n| *n > 0);
    let id_pago_forced = args.id_pago.filter(|n| *n > 0);

    let command_name = "ticket.cobrarDetalles";

    let domain_args = json!({
        "id_comanda": args.id_comanda,
        "metodo": metodo,
        "tipo": tipo,
        "detalle_ids": ids,
        "id_usuario": id_usuario,
        "id_pago": id_pago_forced
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        if let Some(id_pago) = id_pago_forced {
            if exists_by_id(&db, "Pagos", "ID_Pago", id_pago).await? {
                maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json)
                    .await?;

                let result = "OK".to_string();
                let result_json = serialize_result_json(&result)?;

                applied_mark_applied(&db, &op_id, &result_json).await?;

                return Ok(result);
            }
        }

        let id_trabajador_cobrador = resolve_trabajador_id_input(&db, id_usuario).await?;

        let in_sql = build_in_placeholders(2, ids.len());
        let mut count_args: Vec<Value> = Vec::with_capacity(1 + ids.len());

        count_args.push(Value::Integer(args.id_comanda));

        for id in ids.iter() {
            count_args.push(Value::Integer(*id));
        }

        let sql_count = format!(
            r#"
            SELECT COUNT(*)
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = ?1
              AND dc.ID_Detalle IN ({})
              AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle);
            "#,
            in_sql
        );

        let count = select_one_i64(&db, &sql_count, count_args.clone())
            .await?
            .unwrap_or(0);

        if count as usize != ids.len() {
            return Err(
                "Algunos detalles no existen, no pertenecen a la comanda o ya están pagados."
                    .into(),
            );
        }

        let sql_sum = format!(
            r#"
            SELECT IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0)
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = ?1
              AND dc.ID_Detalle IN ({})
              AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle);
            "#,
            in_sql
        );

        let total = select_one_f64(&db, &sql_sum, count_args.clone())
            .await?
            .unwrap_or(0.0);

        let total = (total * 100.0).round() / 100.0;

        let id_pago = if let Some(id_pago) = id_pago_forced {
            let ok = try_exec(
                &db,
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
                  ?5,
                  ?6,
                  ?7
                );
                "#,
                vec![
                    Value::Integer(id_pago),
                    Value::Integer(args.id_comanda),
                    Value::Text(metodo.clone()),
                    Value::Real(total),
                    Value::Text(tipo.clone()),
                    id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                    id_trabajador_cobrador
                        .map(Value::Integer)
                        .unwrap_or(Value::Null),
                ],
            )
            .await?;

            if !ok {
                db.execute(
                    r#"
                    INSERT INTO Pagos (
                      ID_Pago,
                      ID_Comanda,
                      Fecha_Hora,
                      Metodo_Pago,
                      Importe_Total,
                      Tipo,
                      ID_Usuario_Cobrador
                    )
                    VALUES (
                      ?1,
                      ?2,
                      datetime('now','localtime'),
                      ?3,
                      ?4,
                      ?5,
                      ?6
                    );
                    "#,
                    vec![
                        Value::Integer(id_pago),
                        Value::Integer(args.id_comanda),
                        Value::Text(metodo.clone()),
                        Value::Real(total),
                        Value::Text(tipo.clone()),
                        id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                    ],
                )
                .await
                .map_err(|e| e.to_string())?;
            }

            id_pago
        } else {
            let ok = try_exec(
                &db,
                r#"
                INSERT INTO Pagos (
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
                  datetime('now','localtime'),
                  ?2,
                  ?3,
                  ?4,
                  ?5,
                  ?6
                );
                "#,
                vec![
                    Value::Integer(args.id_comanda),
                    Value::Text(metodo.clone()),
                    Value::Real(total),
                    Value::Text(tipo.clone()),
                    id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                    id_trabajador_cobrador
                        .map(Value::Integer)
                        .unwrap_or(Value::Null),
                ],
            )
            .await?;

            if !ok {
                db.execute(
                    r#"
                    INSERT INTO Pagos (
                      ID_Comanda,
                      Fecha_Hora,
                      Metodo_Pago,
                      Importe_Total,
                      Tipo,
                      ID_Usuario_Cobrador
                    )
                    VALUES (
                      ?1,
                      datetime('now','localtime'),
                      ?2,
                      ?3,
                      ?4,
                      ?5
                    );
                    "#,
                    vec![
                        Value::Integer(args.id_comanda),
                        Value::Text(metodo.clone()),
                        Value::Real(total),
                        Value::Text(tipo.clone()),
                        id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                    ],
                )
                .await
                .map_err(|e| e.to_string())?;
            }

            select_one_i64(&db, "SELECT last_insert_rowid();", vec![])
                .await?
                .ok_or_else(|| "No se pudo obtener ID_Pago".to_string())?
        };

        if let Err(e) = sumar_gasto_cliente_por_comanda(&db, args.id_comanda, total).await {
            eprintln!("[WARN] sumar_gasto_cliente_por_comanda error: {}", e);
        }

        let mut insert_args: Vec<Value> = Vec::with_capacity(2 + ids.len());

        insert_args.push(Value::Integer(id_pago));
        insert_args.push(Value::Integer(args.id_comanda));

        for id in ids.iter() {
            insert_args.push(Value::Integer(*id));
        }

        let in_sql2 = build_in_placeholders(3, ids.len());

        let sql_insert = format!(
            r#"
            INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
            SELECT ?1, dc.ID_Detalle
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = ?2
              AND dc.ID_Detalle IN ({})
              AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle);
            "#,
            in_sql2
        );

        db.execute(&sql_insert, insert_args)
            .await
            .map_err(|e| e.to_string())?;

        let pending_left = select_one_i64(
            &db,
            r#"
            SELECT COUNT(*)
            FROM Detalle_Comanda dc
            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
            WHERE dc.ID_Comanda = ?1
              AND pd.ID_Detalle IS NULL;
            "#,
            vec![Value::Integer(args.id_comanda)],
        )
        .await?
        .unwrap_or(0);

        if pending_left == 0 {
            db.execute(
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
                vec![Value::Integer(args.id_comanda)],
            )
            .await
            .map_err(|e| e.to_string())?;
        } else {
            db.execute(
                update_total_comanda_sql(),
                vec![Value::Integer(args.id_comanda)],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}

/* =========================================================
   COCINA
========================================================= */

#[derive(Debug, Clone, Serialize)]
pub struct KitchenRow {
    #[serde(rename = "ID_Comanda")]
    pub id_comanda: i64,
    #[serde(rename = "Numero_Mesa")]
    pub numero_mesa: String,
    #[serde(rename = "Fecha_Hora_Apertura")]
    pub fecha_hora_apertura: String,
    #[serde(rename = "ID_Detalle")]
    pub id_detalle: i64,
    #[serde(rename = "Cantidad")]
    pub cantidad: f64,
    #[serde(rename = "Nombre_Producto")]
    pub nombre_producto: String,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
    #[serde(rename = "Estado_Cocina")]
    pub estado_cocina: Option<String>,
    #[serde(rename = "Pagado")]
    pub pagado: i64,
}

#[tauri::command]
pub async fn kitchen_list_today_pending(
    state: State<'_, AppState>,
) -> Result<Vec<KitchenRow>, String> {
    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT
              c.ID_Comanda,
              m.Numero_Mesa,
              c.Fecha_Hora_Apertura,

              dc.ID_Detalle,
              COALESCE(dc.Cantidad,1) AS Cantidad,
              p.Nombre AS Nombre_Producto,
              dc.Notas,
              COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,

              CASE
                WHEN EXISTS (
                  SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
                ) THEN 1 ELSE 0
              END AS Pagado

            FROM Detalle_Comanda dc
            JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda
            JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
            JOIN Productos p ON p.ID_Producto = dc.ID_Producto
            JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria

            WHERE COALESCE(cat.Pasa_Cocina, 0) = 1
              AND datetime(c.Fecha_Hora_Apertura,'localtime') >= datetime('now','localtime','-2 days')
              AND EXISTS (
                SELECT 1
                FROM Detalle_Comanda dc2
                JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
                JOIN Categorias_Producto cat2 ON cat2.ID_Categoria = p2.ID_Categoria
                WHERE dc2.ID_Comanda = c.ID_Comanda
                  AND COALESCE(cat2.Pasa_Cocina, 0) = 1
                  AND COALESCE(dc2.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
              )

            ORDER BY datetime(c.Fecha_Hora_Apertura) ASC, c.ID_Comanda ASC, dc.ID_Detalle ASC;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<KitchenRow> = vec![];

    while let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(KitchenRow {
            id_comanda: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            numero_mesa: v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            fecha_hora_apertura: v_string(r.get_value(2).map_err(|e| e.to_string())?)
                .unwrap_or_default(),
            id_detalle: v_i64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0),
            cantidad: v_f64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(1.0),
            nombre_producto: v_string(r.get_value(5).map_err(|e| e.to_string())?)
                .unwrap_or_default(),
            notas: v_string(r.get_value(6).map_err(|e| e.to_string())?),
            estado_cocina: v_string(r.get_value(7).map_err(|e| e.to_string())?),
            pagado: v_i64(r.get_value(8).map_err(|e| e.to_string())?).unwrap_or(0),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn kitchen_set_line_state(
    state: State<'_, AppState>,
    args: KitchenSetLineStateArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_detalle <= 0 {
        return Err("ID_Detalle inválido".into());
    }

    if args.id_usuario_cocinero <= 0 {
        return Err("ID_Usuario_Cocinero inválido".into());
    }

    let estado_raw = normalize_required(&args.estado, "estado")?.to_uppercase();

    let estado = if estado_raw == "PREPARADO" {
        "PREPARADO".to_string()
    } else {
        "PENDIENTE".to_string()
    };

    let command_name = "kitchen.setLineaEstado";

    let domain_args = json!({
        "id_detalle": args.id_detalle,
        "id_usuario_cocinero": args.id_usuario_cocinero,
        "estado": estado
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok("OK".into());
    }

    begin(&db).await?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        if estado == "PREPARADO" {
            let ok = try_exec(
                &db,
                r#"
                UPDATE Detalle_Comanda
                SET
                  Estado_Cocina = 'PREPARADO',
                  ID_Usuario_Cocinero = COALESCE(ID_Usuario_Cocinero, ?2),
                  Fecha_Hora_Cocina   = COALESCE(Fecha_Hora_Cocina, datetime('now','localtime'))
                WHERE ID_Detalle = ?1;
                "#,
                vec![
                    Value::Integer(args.id_detalle),
                    Value::Integer(args.id_usuario_cocinero),
                ],
            )
            .await?;

            if !ok {
                db.execute(
                    r#"
                    UPDATE Detalle_Comanda
                    SET Estado_Cocina = 'PREPARADO'
                    WHERE ID_Detalle = ?1;
                    "#,
                    vec![Value::Integer(args.id_detalle)],
                )
                .await
                .map_err(|e| e.to_string())?;
            }
        } else {
            let ok = try_exec(
                &db,
                r#"
                UPDATE Detalle_Comanda
                SET
                  Estado_Cocina = 'PENDIENTE',
                  ID_Usuario_Cocinero = NULL,
                  Fecha_Hora_Cocina   = NULL
                WHERE ID_Detalle = ?1;
                "#,
                vec![Value::Integer(args.id_detalle)],
            )
            .await?;

            if !ok {
                db.execute(
                    r#"
                    UPDATE Detalle_Comanda
                    SET Estado_Cocina = 'PENDIENTE'
                    WHERE ID_Detalle = ?1;
                    "#,
                    vec![Value::Integer(args.id_detalle)],
                )
                .await
                .map_err(|e| e.to_string())?;
            }
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = "OK".to_string();
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&db).await;
            Err(e)
        }
    }
}
