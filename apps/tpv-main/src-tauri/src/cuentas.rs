// src-tauri/src/cuentas.rs
use libsql::{Connection, Value};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
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

fn normalize_metodo(input: &str) -> String {
    if input.trim() == "Tarjeta" {
        "Tarjeta".to_string()
    } else {
        "Efectivo".to_string()
    }
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

async fn next_table_id(conn: &Connection, table: &str, column: &str) -> Result<i64, String> {
    let sql = format!("SELECT COALESCE(MAX({column}), 0) + 1 FROM {table};");

    let mut rows = conn
        .query(&sql, ())
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(1);
    };

    let v = row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?;

    Ok(v_i64(v).unwrap_or(1).max(1))
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
   OUTPUT
========================================================= */

#[derive(Serialize)]
pub struct EntradaRow {
    pub id: String,
    pub fecha_hora: String,
    pub cliente: String,
    pub metodo: String,
    pub importe: f64,
}

#[derive(Serialize)]
pub struct SalidaRow {
    pub id: String,
    pub fecha_hora: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,
    pub proveedor_id: Option<i64>,
}

/* =========================================================
   ARGS
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct CuentasRangoArgs {
    #[serde(default)]
    pub del: Option<String>,

    #[serde(default)]
    pub al: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateGastoArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_gasto: Option<i64>,

    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,

    #[serde(default)]
    pub proveedor_id: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateGastoArgs {
    pub op_id: String,
    pub id_gasto: i64,
    pub fecha: String,
    pub tipo_gasto: String,
    pub concepto: String,
    pub importe: f64,

    #[serde(default)]
    pub proveedor_id: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteGastoArgs {
    pub op_id: String,
    pub id_gasto: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdatePagoArgs {
    pub op_id: String,
    pub id_pago: i64,
    pub fecha_hora: String,
    pub metodo: String,
    pub importe: f64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeletePagoArgs {
    pub op_id: String,
    pub id_pago: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   COMMANDS - ENTRADAS
========================================================= */

#[tauri::command]
pub async fn cuentas_get_entradas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<Vec<EntradaRow>, String> {
    let db = get_db(&state).await?;

    let mut where_parts: Vec<String> = vec![];

    let has_del = args
        .del
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .is_some();

    let has_al = args
        .al
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .is_some();

    if has_del {
        where_parts.push("date(p.Fecha_Hora) >= date(?1)".to_string());
    }

    let al_param_index = if has_del { 2 } else { 1 };

    if has_al {
        where_parts.push(format!("date(p.Fecha_Hora) <= date(?{})", al_param_index));
    }

    let where_sql = if where_parts.is_empty() {
        "".to_string()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    let sql = format!(
        r#"
        SELECT
          p.ID_Pago AS id,
          substr(p.Fecha_Hora, 1, 16) AS fechaHora,
          (
            CASE
              WHEN m.Numero_Mesa = 'BARRA' THEN 'Take away'
              WHEN m.Numero_Mesa IS NOT NULL AND m.Numero_Mesa <> '' THEN 'Mesa ' || m.Numero_Mesa
              ELSE 'Venta'
            END
            ||
            CASE
              WHEN cl.Nombre IS NOT NULL AND cl.Nombre <> '' THEN ' / ' || cl.Nombre
              ELSE ''
            END
          ) AS cliente,
          CASE
            WHEN p.Metodo_Pago = 'Tarjeta' THEN 'Tarjeta'
            ELSE 'Efectivo'
          END AS metodo,
          IFNULL(p.Importe_Total, 0) AS importe
        FROM Pagos p
        JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
        LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
        LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
        LEFT JOIN Clientes cl ON cl.ID_Cliente = r.ID_Cliente
        {where_sql}
        ORDER BY p.Fecha_Hora DESC, p.ID_Pago DESC;
        "#
    );

    let mut params: Vec<Value> = vec![];

    if let Some(d) = args.del.clone().filter(|s| !s.trim().is_empty()) {
        params.push(Value::Text(d));
    }

    if let Some(a) = args.al.clone().filter(|s| !s.trim().is_empty()) {
        params.push(Value::Text(a));
    }

    let mut rows = db
        .query(sql.as_str(), params)
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<EntradaRow> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let id = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let fecha_hora = v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();
        let cliente = v_string(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();
        let metodo = v_string(row.get_value(3).map_err(|e| e.to_string())?)
            .unwrap_or_else(|| "Efectivo".into());
        let importe = v_f64(row.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0);

        out.push(EntradaRow {
            id: id.to_string(),
            fecha_hora: fecha_hora.chars().take(16).collect(),
            cliente,
            metodo,
            importe,
        });
    }

    Ok(out)
}

/* =========================================================
   COMMANDS - SALIDAS
========================================================= */

#[tauri::command]
pub async fn cuentas_get_salidas(
    state: State<'_, AppState>,
    args: CuentasRangoArgs,
) -> Result<Vec<SalidaRow>, String> {
    let db = get_db(&state).await?;

    let mut where_parts: Vec<String> = vec![];

    let has_del = args
        .del
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .is_some();

    let has_al = args
        .al
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .is_some();

    if has_del {
        where_parts.push("date(Fecha) >= date(?1)".to_string());
    }

    let al_param_index = if has_del { 2 } else { 1 };

    if has_al {
        where_parts.push(format!("date(Fecha) <= date(?{})", al_param_index));
    }

    let where_sql = if where_parts.is_empty() {
        "".to_string()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    let sql = format!(
        r#"
        SELECT
          ID_Gasto AS id,
          substr(Fecha, 1, 10) AS fechaHora,
          Tipo_Gasto AS tipoGasto,
          Concepto AS concepto,
          Importe AS importe,
          ID_Proveedor AS proveedorId
        FROM Cuentas_Gastos
        {where_sql}
        ORDER BY date(Fecha) DESC, ID_Gasto DESC;
        "#
    );

    let mut params: Vec<Value> = vec![];

    if let Some(d) = args.del.clone().filter(|s| !s.trim().is_empty()) {
        params.push(Value::Text(d));
    }

    if let Some(a) = args.al.clone().filter(|s| !s.trim().is_empty()) {
        params.push(Value::Text(a));
    }

    let mut rows = db
        .query(sql.as_str(), params)
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<SalidaRow> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let id = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let fecha = v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();
        let tipo = v_string(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();
        let concepto = v_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_default();
        let importe = v_f64(row.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0);
        let prov = v_i64(row.get_value(5).map_err(|e| e.to_string())?);

        out.push(SalidaRow {
            id: id.to_string(),
            fecha_hora: fecha.chars().take(10).collect(),
            tipo_gasto: tipo,
            concepto,
            importe,
            proveedor_id: prov,
        });
    }

    Ok(out)
}

/* =========================================================
   COMMANDS - CRUD GASTOS
========================================================= */

#[tauri::command]
pub async fn cuentas_create_gasto(
    state: State<'_, AppState>,
    args: CreateGastoArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    let id_gasto = match args.id_gasto {
        Some(id) if id > 0 => id,
        _ => next_table_id(&db, "Cuentas_Gastos", "ID_Gasto").await?,
    };

    let fecha = normalize_required(&args.fecha, "fecha")?;
    let tipo_gasto = normalize_required(&args.tipo_gasto, "tipo_gasto")?;
    let concepto = normalize_required(&args.concepto, "concepto")?;

    if !args.importe.is_finite() || args.importe <= 0.0 {
        return Ok(false);
    }

    let proveedor_id = if tipo_gasto == "Proveedor" {
        match args.proveedor_id {
            Some(id) if id > 0 => Some(id),
            _ => None,
        }
    } else {
        None
    };

    let command_name = "cuentas.createGasto";

    let domain_args = json!({
        "id_gasto": id_gasto,
        "fecha": fecha.clone(),
        "tipo_gasto": tipo_gasto.clone(),
        "concepto": concepto.clone(),
        "importe": args.importe,
        "proveedor_id": proveedor_id
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

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            INSERT INTO Cuentas_Gastos (
                ID_Gasto,
                Fecha,
                Concepto,
                Importe,
                Tipo_Gasto,
                ID_Proveedor
            )
            VALUES (
                ?1,
                date(?2),
                ?3,
                ?4,
                ?5,
                ?6
            )
            ON CONFLICT(ID_Gasto) DO UPDATE SET
                Fecha = excluded.Fecha,
                Concepto = excluded.Concepto,
                Importe = excluded.Importe,
                Tipo_Gasto = excluded.Tipo_Gasto,
                ID_Proveedor = excluded.ID_Proveedor;
            "#,
            vec![
                Value::Integer(id_gasto),
                Value::Text(fecha.clone()),
                Value::Text(concepto.clone()),
                Value::Real(args.importe),
                Value::Text(tipo_gasto.clone()),
                match proveedor_id {
                    Some(id) => Value::Integer(id),
                    None => Value::Null,
                },
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            db.execute_batch("COMMIT;")
                .await
                .map_err(|e| e.to_string())?;

            Ok(result)
        }
        Err(err) => {
            let _ = db.execute_batch("ROLLBACK;").await;

            Err(err)
        }
    }
}

#[tauri::command]
pub async fn cuentas_update_gasto(
    state: State<'_, AppState>,
    args: UpdateGastoArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let fecha = normalize_required(&args.fecha, "fecha")?;
    let tipo_gasto = normalize_required(&args.tipo_gasto, "tipo_gasto")?;
    let concepto = normalize_required(&args.concepto, "concepto")?;

    if args.id_gasto <= 0 || !args.importe.is_finite() || args.importe <= 0.0 {
        return Ok(false);
    }

    let proveedor_id = if tipo_gasto == "Proveedor" {
        match args.proveedor_id {
            Some(id) if id > 0 => Some(id),
            _ => None,
        }
    } else {
        None
    };

    let command_name = "cuentas.updateGasto";

    let domain_args = json!({
        "id_gasto": args.id_gasto,
        "fecha": fecha.clone(),
        "tipo_gasto": tipo_gasto.clone(),
        "concepto": concepto.clone(),
        "importe": args.importe,
        "proveedor_id": proveedor_id
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

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let affected = db
            .execute(
                r#"
                UPDATE Cuentas_Gastos
                SET
                  Fecha = date(?2),
                  Tipo_Gasto = ?3,
                  Concepto = ?4,
                  Importe = ?5,
                  ID_Proveedor = ?6
                WHERE ID_Gasto = ?1;
                "#,
                vec![
                    Value::Integer(args.id_gasto),
                    Value::Text(fecha.clone()),
                    Value::Text(tipo_gasto.clone()),
                    Value::Text(concepto.clone()),
                    Value::Real(args.importe),
                    match proveedor_id {
                        Some(id) => Value::Integer(id),
                        None => Value::Null,
                    },
                ],
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
            db.execute_batch("COMMIT;")
                .await
                .map_err(|e| e.to_string())?;

            Ok(result)
        }
        Err(err) => {
            let _ = db.execute_batch("ROLLBACK;").await;

            Err(err)
        }
    }
}

#[tauri::command]
pub async fn cuentas_delete_gasto(
    state: State<'_, AppState>,
    args: DeleteGastoArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_gasto <= 0 {
        return Ok(false);
    }

    let command_name = "cuentas.deleteGasto";

    let domain_args = json!({
        "id_gasto": args.id_gasto
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

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let affected = db
            .execute(
                r#"DELETE FROM Cuentas_Gastos WHERE ID_Gasto = ?1;"#,
                vec![Value::Integer(args.id_gasto)],
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
            db.execute_batch("COMMIT;")
                .await
                .map_err(|e| e.to_string())?;

            Ok(result)
        }
        Err(err) => {
            let _ = db.execute_batch("ROLLBACK;").await;

            Err(err)
        }
    }
}

/* =========================================================
   COMMANDS - CRUD PAGOS
========================================================= */

#[tauri::command]
pub async fn cuentas_update_pago(
    state: State<'_, AppState>,
    args: UpdatePagoArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let fecha_hora = normalize_required(&args.fecha_hora, "fecha_hora")?;
    let metodo = normalize_metodo(&args.metodo);

    if args.id_pago <= 0 || !args.importe.is_finite() || args.importe <= 0.0 {
        return Ok(false);
    }

    let command_name = "cuentas.updatePago";

    let domain_args = json!({
        "id_pago": args.id_pago,
        "fecha_hora": fecha_hora.clone(),
        "metodo": metodo.clone(),
        "importe": args.importe
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

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let affected = db
            .execute(
                r#"
                UPDATE Pagos
                SET
                  Fecha_Hora = ?2,
                  Metodo_Pago = ?3,
                  Importe_Total = ?4
                WHERE ID_Pago = ?1;
                "#,
                vec![
                    Value::Integer(args.id_pago),
                    Value::Text(fecha_hora.clone()),
                    Value::Text(metodo.clone()),
                    Value::Real(args.importe),
                ],
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
            db.execute_batch("COMMIT;")
                .await
                .map_err(|e| e.to_string())?;

            Ok(result)
        }
        Err(err) => {
            let _ = db.execute_batch("ROLLBACK;").await;

            Err(err)
        }
    }
}

#[tauri::command]
pub async fn cuentas_delete_pago(
    state: State<'_, AppState>,
    args: DeletePagoArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_pago <= 0 {
        return Ok(false);
    }

    let command_name = "cuentas.deletePago";

    let domain_args = json!({
        "id_pago": args.id_pago
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

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"DELETE FROM Pago_Detalles WHERE ID_Pago = ?1;"#,
            vec![Value::Integer(args.id_pago)],
        )
        .await
        .map_err(|e| e.to_string())?;

        let affected = db
            .execute(
                r#"DELETE FROM Pagos WHERE ID_Pago = ?1;"#,
                vec![Value::Integer(args.id_pago)],
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
            db.execute_batch("COMMIT;")
                .await
                .map_err(|e| e.to_string())?;

            Ok(result)
        }
        Err(err) => {
            let _ = db.execute_batch("ROLLBACK;").await;

            Err(err)
        }
    }
}
