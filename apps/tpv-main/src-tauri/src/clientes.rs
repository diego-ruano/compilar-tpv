// src-tauri/src/clientes.rs
use libsql::{Connection, Value};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{get_db, AppState};

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
   Tipos
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClienteRow {
    pub id_cliente: i64,
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,

    pub ultima_reserva_fecha: Option<String>,
    pub ultima_reserva_hora: Option<String>,
    pub ultima_reserva_num_personas: Option<i64>,
    pub ultima_reserva_mesa: Option<String>,

    pub total_gastado_calculado: f64,
    pub total_gastado_stored: f64,

    pub total_reservas: i64,
    pub reservas_pendientes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClienteFormRow {
    pub nombre: String,
    pub email: Option<String>,
    pub telefono: Option<String>,
    pub notas: Option<String>,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct ClientesOverviewArgs {
    pub ranking: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClienteIdArgs {
    pub id_cliente: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateClienteArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_cliente: Option<i64>,

    pub nombre: String,

    #[serde(default)]
    pub email: Option<String>,

    #[serde(default)]
    pub telefono: Option<String>,

    #[serde(default)]
    pub notas: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateClienteArgs {
    pub op_id: String,
    pub id_cliente: i64,

    pub nombre: String,

    #[serde(default)]
    pub email: Option<String>,

    #[serde(default)]
    pub telefono: Option<String>,

    #[serde(default)]
    pub notas: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   SQL base
========================================================= */

fn sql_overview_base() -> &'static str {
    r#"
    SELECT
      c.ID_Cliente,
      c.Nombre,
      c.Email,
      c.Telefono,

      (
        SELECT r.Dia_YMD
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
        ORDER BY r.Dia_YMD DESC, r.Hora DESC
        LIMIT 1
      ) AS Ultima_Reserva_Fecha,

      (
        SELECT r.Hora
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
        ORDER BY r.Dia_YMD DESC, r.Hora DESC
        LIMIT 1
      ) AS Ultima_Reserva_Hora,

      (
        SELECT r.Comensales
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
        ORDER BY r.Dia_YMD DESC, r.Hora DESC
        LIMIT 1
      ) AS Ultima_Reserva_NumPersonas,

      (
        SELECT m.Numero_Mesa
        FROM Reservas r
        JOIN Mesas m ON m.ID_Mesa = r.ID_Mesa
        WHERE r.ID_Cliente = c.ID_Cliente
        ORDER BY r.Dia_YMD DESC, r.Hora DESC
        LIMIT 1
      ) AS Ultima_Reserva_Mesa,

      (
        SELECT IFNULL(SUM(f.Total_Pagado), 0)
        FROM Facturas f
        WHERE f.ID_Cliente = c.ID_Cliente
      ) AS Total_Gastado_Calculado,

      IFNULL(c.Total_Gastado, 0) AS Total_Gastado_Stored,

      (
        SELECT COUNT(*)
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
      ) AS Total_Reservas,

      (
        SELECT COUNT(*)
        FROM Reservas r
        WHERE r.ID_Cliente = c.ID_Cliente
          AND UPPER(COALESCE(r.Estado,'')) = 'ACTIVA'
          AND date(r.Dia_YMD) >= date('now','localtime')
      ) AS Reservas_Pendientes

    FROM Clientes c
    "#
}

/* =========================================================
   Reads
========================================================= */

#[tauri::command]
pub async fn clientes_get_overview(
    state: State<'_, AppState>,
    args: ClientesOverviewArgs,
) -> Result<Vec<ClienteRow>, String> {
    let conn = get_db(&state).await?;
    let base = sql_overview_base();

    let sql = match args.ranking.as_str() {
        "reservas" => format!(
            r#"
            {base}
            ORDER BY
              Total_Reservas DESC,
              (Total_Gastado_Calculado + Total_Gastado_Stored) DESC,
              c.ID_Cliente DESC
            LIMIT 10;
            "#
        ),
        "gasto" => format!(
            r#"
            {base}
            ORDER BY
              (Total_Gastado_Calculado + Total_Gastado_Stored) DESC,
              Total_Reservas DESC,
              c.ID_Cliente DESC
            LIMIT 10;
            "#
        ),
        _ => format!(
            r#"
            {base}
            ORDER BY c.ID_Cliente DESC;
            "#
        ),
    };

    let mut rows = conn
        .query(&sql, Vec::<Value>::new())
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let mut out: Vec<ClienteRow> = Vec::new();

    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    {
        let id_cliente = row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?;
        let nombre = row.get_value(1).map_err(|e| format!("get_value(1): {e}"))?;
        let email = row.get_value(2).map_err(|e| format!("get_value(2): {e}"))?;
        let telefono = row.get_value(3).map_err(|e| format!("get_value(3): {e}"))?;
        let ur_fecha = row.get_value(4).map_err(|e| format!("get_value(4): {e}"))?;
        let ur_hora = row.get_value(5).map_err(|e| format!("get_value(5): {e}"))?;
        let ur_num = row.get_value(6).map_err(|e| format!("get_value(6): {e}"))?;
        let ur_mesa = row.get_value(7).map_err(|e| format!("get_value(7): {e}"))?;
        let tg_calc = row.get_value(8).map_err(|e| format!("get_value(8): {e}"))?;
        let tg_st = row.get_value(9).map_err(|e| format!("get_value(9): {e}"))?;
        let total_res = row
            .get_value(10)
            .map_err(|e| format!("get_value(10): {e}"))?;
        let pend = row
            .get_value(11)
            .map_err(|e| format!("get_value(11): {e}"))?;

        out.push(ClienteRow {
            id_cliente: v_i64(id_cliente).unwrap_or(0),
            nombre: v_string(nombre).unwrap_or_else(|| "".into()),
            email: norm_opt_string(email),
            telefono: norm_opt_string(telefono),

            ultima_reserva_fecha: norm_opt_string(ur_fecha),
            ultima_reserva_hora: norm_opt_string(ur_hora),
            ultima_reserva_num_personas: v_i64(ur_num),
            ultima_reserva_mesa: norm_opt_string(ur_mesa),

            total_gastado_calculado: v_f64(tg_calc).unwrap_or(0.0),
            total_gastado_stored: v_f64(tg_st).unwrap_or(0.0),

            total_reservas: v_i64(total_res).unwrap_or(0),
            reservas_pendientes: v_i64(pend).unwrap_or(0),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn clientes_get_cliente_form(
    state: State<'_, AppState>,
    args: ClienteIdArgs,
) -> Result<Option<ClienteFormRow>, String> {
    let conn = get_db(&state).await?;

    if args.id_cliente <= 0 {
        return Ok(None);
    }

    let sql = r#"
      SELECT Nombre, Email, Telefono, Notas
      FROM Clientes
      WHERE ID_Cliente = ?
      LIMIT 1;
    "#;

    let mut rows = conn
        .query(sql, vec![Value::Integer(args.id_cliente)])
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(None);
    };

    let nombre = row.get_value(0).map_err(|e| format!("get_value(0): {e}"))?;
    let email = row.get_value(1).map_err(|e| format!("get_value(1): {e}"))?;
    let telefono = row.get_value(2).map_err(|e| format!("get_value(2): {e}"))?;
    let notas = row.get_value(3).map_err(|e| format!("get_value(3): {e}"))?;

    Ok(Some(ClienteFormRow {
        nombre: v_string(nombre).unwrap_or_else(|| "".into()),
        email: norm_opt_string(email),
        telefono: norm_opt_string(telefono),
        notas: norm_opt_string(notas),
    }))
}

/* =========================================================
   Writes
========================================================= */

#[tauri::command]
pub async fn clientes_create_cliente(
    state: State<'_, AppState>,
    args: CreateClienteArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let requested_id_cliente = args.id_cliente.filter(|n| *n > 0);

    let nombre = normalize_required(&args.nombre, "nombre")?;
    let email = clean_opt_string(args.email);
    let telefono = clean_opt_string(args.telefono);
    let notas = clean_opt_string(args.notas);

    let command_name = "clients.createCliente";

    let hash_args = json!({
        "id_cliente": requested_id_cliente,
        "nombre": nombre.clone(),
        "email": email.clone(),
        "telefono": telefono.clone(),
        "notas": notas.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&hash_args)?);

    if let Some(existing) = applied_get_by_op_id(&conn, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let id_cliente = match requested_id_cliente {
        Some(id) => id,
        None => next_table_id(&conn, "Clientes", "ID_Cliente").await?,
    };

    let outbox_args = json!({
        "id_cliente": id_cliente,
        "nombre": nombre.clone(),
        "email": email.clone(),
        "telefono": telefono.clone(),
        "notas": notas.clone()
    });

    let payload_json = stable_json_string(&json!({
        "op_id": op_id.clone(),
        "command_name": command_name,
        "args": outbox_args
    }))?;

    if outbox_assert_replay_or_unused(&conn, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    conn.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&conn, &op_id, command_name, &request_hash).await?;

        conn.execute(
            r#"
            INSERT INTO Clientes (
                ID_Cliente,
                Nombre,
                Telefono,
                Email,
                Notas,
                Created_At
            )
            VALUES (
                ?1,
                ?2,
                ?3,
                ?4,
                ?5,
                datetime('now','localtime')
            )
            ON CONFLICT(ID_Cliente) DO UPDATE SET
                Nombre = excluded.Nombre,
                Telefono = excluded.Telefono,
                Email = excluded.Email,
                Notas = excluded.Notas;
            "#,
            vec![
                Value::Integer(id_cliente),
                Value::Text(nombre.clone()),
                match telefono.clone() {
                    Some(t) => Value::Text(t),
                    None => Value::Null,
                },
                match email.clone() {
                    Some(e) => Value::Text(e),
                    None => Value::Null,
                },
                match notas.clone() {
                    Some(n) => Value::Text(n),
                    None => Value::Null,
                },
            ],
        )
        .await
        .map_err(|e| format!("DB execute error: {e}"))?;

        maybe_insert_outbox(&conn, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&conn, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            conn.execute_batch("COMMIT;")
                .await
                .map_err(|e| e.to_string())?;

            Ok(result)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK;").await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn clientes_update_cliente(
    state: State<'_, AppState>,
    args: UpdateClienteArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_cliente <= 0 {
        return Err("ID_Cliente inválido.".into());
    }

    let nombre = normalize_required(&args.nombre, "nombre")?;
    let email = clean_opt_string(args.email);
    let telefono = clean_opt_string(args.telefono);
    let notas = clean_opt_string(args.notas);

    let command_name = "clients.updateCliente";

    let domain_args = json!({
        "id_cliente": args.id_cliente,
        "nombre": nombre.clone(),
        "email": email.clone(),
        "telefono": telefono.clone(),
        "notas": notas.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&conn, &op_id).await? {
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

    if outbox_assert_replay_or_unused(&conn, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    conn.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&conn, &op_id, command_name, &request_hash).await?;

        let affected = conn
            .execute(
                r#"
                UPDATE Clientes
                SET
                  Nombre = ?1,
                  Telefono = ?2,
                  Email = ?3,
                  Notas = ?4
                WHERE ID_Cliente = ?5;
                "#,
                vec![
                    Value::Text(nombre.clone()),
                    match telefono.clone() {
                        Some(t) => Value::Text(t),
                        None => Value::Null,
                    },
                    match email.clone() {
                        Some(e) => Value::Text(e),
                        None => Value::Null,
                    },
                    match notas.clone() {
                        Some(n) => Value::Text(n),
                        None => Value::Null,
                    },
                    Value::Integer(args.id_cliente),
                ],
            )
            .await
            .map_err(|e| format!("DB execute error: {e}"))?;

        let result = affected > 0;

        if result {
            maybe_insert_outbox(&conn, enqueue_outbox, &op_id, command_name, &payload_json).await?;
        }

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&conn, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            conn.execute_batch("COMMIT;")
                .await
                .map_err(|e| e.to_string())?;

            Ok(result)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK;").await;
            Err(err)
        }
    }
}
