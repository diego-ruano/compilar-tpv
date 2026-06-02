// src-tauri/src/reservas.rs
use libsql::{Connection, Value};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{get_db, AppState};
use std::convert::TryInto;

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

fn get_i64(row: &[Value], idx: usize) -> i64 {
    row.get(idx).cloned().and_then(v_i64).unwrap_or(0)
}

#[allow(dead_code)]
fn get_opt_i64(row: &[Value], idx: usize) -> Option<i64> {
    row.get(idx).cloned().and_then(v_i64)
}

#[allow(dead_code)]
fn get_f64(row: &[Value], idx: usize) -> f64 {
    row.get(idx).cloned().and_then(v_f64).unwrap_or(0.0)
}

fn get_string(row: &[Value], idx: usize) -> String {
    row.get(idx)
        .cloned()
        .and_then(v_string)
        .unwrap_or_else(|| "".to_string())
}

fn get_opt_string(row: &[Value], idx: usize) -> Option<String> {
    row.get(idx)
        .cloned()
        .and_then(v_string)
        .map(|s| s.trim().to_string())
        .and_then(|s| if s.is_empty() { None } else { Some(s) })
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

async fn begin(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("BEGIN;")
        .await
        .map_err(|e| format!("BEGIN error: {e}"))?;

    Ok(())
}

async fn commit(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("COMMIT;")
        .await
        .map_err(|e| format!("COMMIT error: {e}"))?;

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

    let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    else {
        return Ok(None);
    };

    Ok(v_i64(
        row.get_value(0)
            .map_err(|e| format!("DB get_value(0) error: {e}"))?,
    ))
}

async fn exists_i64(conn: &Connection, sql: &str, args: Vec<Value>) -> Result<bool, String> {
    Ok(select_one_i64(conn, sql, args).await?.is_some())
}

/* =========================================================
   Query helper: SELECT -> Vec<Vec<Value>>
========================================================= */

async fn query_rows_fixed(
    conn: &Connection,
    sql: &str,
    params: Vec<Value>,
    col_count: usize,
) -> Result<Vec<Vec<Value>>, String> {
    let mut rows = conn
        .query(sql, params)
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    let mut out: Vec<Vec<Value>> = Vec::new();

    while let Some(row) = rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
    {
        let mut vals: Vec<Value> = Vec::with_capacity(col_count);

        for i in 0..col_count {
            let idx: i32 = i
                .try_into()
                .map_err(|_| format!("DB get_value index overflow (usize->i32): {i}"))?;

            let v = row
                .get_value(idx)
                .map_err(|e| format!("DB get_value({i}) error: {e}"))?;

            vals.push(v);
        }

        out.push(vals);
    }

    Ok(out)
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
   Normalización estricta de fecha/hora/estado
========================================================= */

fn is_ymd10(s: &str) -> bool {
    if s.len() != 10 {
        return false;
    }

    let b = s.as_bytes();

    if b[4] != b'-' || b[7] != b'-' {
        return false;
    }

    b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[8..10].iter().all(|c| c.is_ascii_digit())
}

fn normalize_dia_ymd(raw: &str) -> Result<String, String> {
    let s = raw.trim();

    if s.len() >= 10 {
        let candidate = &s[..10];

        if is_ymd10(candidate) {
            return Ok(candidate.to_string());
        }
    }

    if let Some(pos) = s.find('T').or_else(|| s.find(' ')) {
        if pos >= 10 {
            let candidate = &s[..10];

            if is_ymd10(candidate) {
                return Ok(candidate.to_string());
            }
        }
    }

    Err(format!(
        "Formato de día inválido: '{s}'. Esperado YYYY-MM-DD."
    ))
}

fn normalize_hora_hhmm(raw: &str) -> Result<String, String> {
    let s = raw.trim();

    if s.len() >= 5 {
        let hhmm = &s[..5];
        let b = hhmm.as_bytes();

        if b[2] != b':' {
            return Err(format!("Formato de hora inválido: '{s}'. Esperado HH:MM."));
        }

        if !b[0].is_ascii_digit()
            || !b[1].is_ascii_digit()
            || !b[3].is_ascii_digit()
            || !b[4].is_ascii_digit()
        {
            return Err(format!("Formato de hora inválido: '{s}'. Esperado HH:MM."));
        }

        let hh: i64 = hhmm[0..2].parse().unwrap_or(-1);
        let mm: i64 = hhmm[3..5].parse().unwrap_or(-1);

        if !(0..=23).contains(&hh) || !(0..=59).contains(&mm) {
            return Err(format!(
                "Hora fuera de rango: '{s}'. Esperado 00:00..23:59."
            ));
        }

        return Ok(hhmm.to_string());
    }

    Err(format!("Formato de hora inválido: '{s}'. Esperado HH:MM."))
}

fn normalize_estado(raw: Option<String>) -> String {
    let s = raw.unwrap_or_else(|| "PROXIMA".to_string());
    let u = s.trim().to_uppercase();

    match u.as_str() {
        "PROXIMA" => "PROXIMA".to_string(),
        "ACTIVA" => "ACTIVA".to_string(),
        "FINALIZADA" => "FINALIZADA".to_string(),
        "CANCELADA" => "CANCELADA".to_string(),
        "NO_SHOW" => "NO_SHOW".to_string(),
        _ => "PROXIMA".to_string(),
    }
}

fn turno_por_hora(hhmm: &str) -> String {
    let s = hhmm.trim();
    let parts: Vec<&str> = s.split(':').collect();
    let hh: i64 = parts.get(0).and_then(|v| v.parse().ok()).unwrap_or(0);
    let mm: i64 = parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    let mins = hh * 60 + mm;

    if mins < 13 * 60 {
        "DESAYUNO".to_string()
    } else if mins < 16 * 60 {
        "COMIDA".to_string()
    } else if mins < 19 * 60 {
        "CAFE".to_string()
    } else {
        "CENA".to_string()
    }
}

fn normalize_turno(raw: Option<String>, hora_hhmm: &str) -> String {
    let maybe = raw
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty());

    match maybe.as_deref() {
        Some("DESAYUNO") => "DESAYUNO".to_string(),
        Some("COMIDA") => "COMIDA".to_string(),
        Some("CAFE") => "CAFE".to_string(),
        Some("CENA") => "CENA".to_string(),
        _ => turno_por_hora(hora_hhmm),
    }
}

/* =========================================================
   Tipos output
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZonaRow {
    pub id_zona: i64,
    pub nombre_zona: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MesaRow {
    pub id_mesa: i64,
    pub id_zona: i64,
    pub numero_mesa: String,
    pub capacidad: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReservasMeta {
    pub zonas: Vec<ZonaRow>,
    pub mesas: Vec<MesaRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReservaRow {
    pub id_reserva: i64,
    pub id_mesa: i64,
    pub dia_ymd: String,
    pub hora: String,
    pub turno: Option<String>,
    pub comensales: i64,
    pub nota: Option<String>,
    pub estado: String,

    pub nombre_cliente: String,
    pub telefono_cliente: Option<String>,
    pub email_cliente: Option<String>,

    pub id_zona: i64,
    pub numero_mesa: String,
    pub capacidad: i64,
    pub nombre_zona: String,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct ReservasGetMesArgs {
    pub desde: String,
    pub hasta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReservaSaveArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_reserva: Option<i64>,

    #[serde(default)]
    pub remote_id_reserva: Option<i64>,

    pub dia_ymd: String,
    pub hora: String,

    #[serde(default)]
    pub turno: Option<String>,

    pub comensales: i64,

    #[serde(default)]
    pub nota: Option<String>,

    #[serde(default)]
    pub estado: Option<String>,

    pub id_mesa: i64,
    pub nombre_cliente: String,

    #[serde(default)]
    pub telefono: Option<String>,

    #[serde(default)]
    pub email: Option<String>,

    #[serde(default)]
    pub notas_cliente: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReservaDeleteArgs {
    pub op_id: String,
    pub id_reserva: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   Upsert Cliente
========================================================= */

async fn upsert_cliente_desde_reserva(
    conn: &Connection,
    nombre: String,
    email: Option<String>,
    telefono: Option<String>,
    notas: Option<String>,
) -> Result<i64, String> {
    let nombre = normalize_required(&nombre, "nombre_cliente")?;
    let email = clean_opt_string(email);
    let telefono = clean_opt_string(telefono);
    let notas = clean_opt_string(notas);

    let mut existing_id: Option<i64> = None;
    let mut existing_email: Option<String> = None;

    if let Some(ref e) = email {
        let sql = r#"
          SELECT ID_Cliente, Email
          FROM Clientes
          WHERE Email = ?1
          ORDER BY ID_Cliente DESC
          LIMIT 1;
        "#;

        let raw = query_rows_fixed(conn, sql, vec![Value::Text(e.clone())], 2).await?;

        if let Some(r) = raw.into_iter().next() {
            existing_id = Some(get_i64(&r, 0));
            existing_email = get_opt_string(&r, 1);
        }
    }

    if existing_id.is_none() {
        if let Some(ref t) = telefono {
            let sql = r#"
              SELECT ID_Cliente, Email
              FROM Clientes
              WHERE Telefono = ?1
              ORDER BY ID_Cliente DESC
              LIMIT 1;
            "#;

            let raw = query_rows_fixed(conn, sql, vec![Value::Text(t.clone())], 2).await?;

            if let Some(r) = raw.into_iter().next() {
                existing_id = Some(get_i64(&r, 0));
                existing_email = get_opt_string(&r, 1);
            }
        }
    }

    if let Some(id_cliente) = existing_id {
        let should_set_email = email.is_some()
            && (existing_email.is_none()
                || existing_email.as_deref().unwrap_or("").trim().is_empty());

        if should_set_email {
            conn.execute(
                r#"
                UPDATE Clientes
                SET
                  Nombre = ?1,
                  Email = ?2,
                  Telefono = ?3,
                  Notas = ?4
                WHERE ID_Cliente = ?5;
                "#,
                vec![
                    Value::Text(nombre),
                    Value::Text(email.clone().unwrap()),
                    match telefono {
                        Some(t) => Value::Text(t),
                        None => Value::Null,
                    },
                    match notas {
                        Some(n) => Value::Text(n),
                        None => Value::Null,
                    },
                    Value::Integer(id_cliente),
                ],
            )
            .await
            .map_err(|e| format!("DB execute error: {e}"))?;
        } else {
            conn.execute(
                r#"
                UPDATE Clientes
                SET
                  Nombre = ?1,
                  Telefono = ?2,
                  Notas = ?3
                WHERE ID_Cliente = ?4;
                "#,
                vec![
                    Value::Text(nombre),
                    match telefono {
                        Some(t) => Value::Text(t),
                        None => Value::Null,
                    },
                    match notas {
                        Some(n) => Value::Text(n),
                        None => Value::Null,
                    },
                    Value::Integer(id_cliente),
                ],
            )
            .await
            .map_err(|e| format!("DB execute error: {e}"))?;
        }

        return Ok(id_cliente);
    }

    conn.execute(
        r#"
        INSERT INTO Clientes (Nombre, Telefono, Email, Notas, Created_At)
        VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'));
        "#,
        vec![
            Value::Text(nombre),
            match telefono {
                Some(t) => Value::Text(t),
                None => Value::Null,
            },
            match email {
                Some(e) => Value::Text(e),
                None => Value::Null,
            },
            match notas {
                Some(n) => Value::Text(n),
                None => Value::Null,
            },
        ],
    )
    .await
    .map_err(|e| format!("DB execute error: {e}"))?;

    let id = select_one_i64(conn, "SELECT last_insert_rowid();", vec![])
        .await?
        .unwrap_or(0);

    if id <= 0 {
        return Err("No se pudo obtener last_insert_rowid() de Cliente".into());
    }

    Ok(id)
}

/* =========================================================
   Core save/delete
========================================================= */

async fn reservas_save_core(
    conn: &Connection,
    args: ReservaSaveArgs,
    force_enqueue_outbox: bool,
) -> Result<bool, String> {
    let enqueue_outbox = if force_enqueue_outbox {
        should_enqueue_outbox(args.enqueue_outbox)
    } else {
        false
    };

    let op_id = normalize_required(&args.op_id, "op_id")?;

    let dia = normalize_dia_ymd(&args.dia_ymd)?;
    let hora = normalize_hora_hhmm(&args.hora)?;
    let nombre_cliente = normalize_required(&args.nombre_cliente, "nombre_cliente")?;

    if args.comensales <= 0 {
        return Err("Comensales inválidos".into());
    }

    if args.id_mesa <= 0 {
        return Err("ID_Mesa inválido".into());
    }

    let id_reserva = args.id_reserva.filter(|n| *n > 0);
    let remote_id_reserva = args.remote_id_reserva.filter(|n| *n > 0);
    let target_id = id_reserva.or(remote_id_reserva);

    let nota = clean_opt_string(args.nota);
    let telefono = clean_opt_string(args.telefono);
    let email = clean_opt_string(args.email);
    let notas_cliente = clean_opt_string(args.notas_cliente);

    let estado_final = if target_id.is_none() {
        "PROXIMA".to_string()
    } else {
        normalize_estado(args.estado)
    };

    let turno_final = normalize_turno(args.turno, &hora);

    let command_name = "reservas.save";

    let domain_args = json!({
        "id_reserva": id_reserva,
        "remote_id_reserva": remote_id_reserva,
        "dia_ymd": dia,
        "hora": hora,
        "turno": turno_final,
        "comensales": args.comensales,
        "nota": nota,
        "estado": estado_final,
        "id_mesa": args.id_mesa,
        "nombre_cliente": nombre_cliente,
        "telefono": telefono,
        "email": email,
        "notas_cliente": notas_cliente
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(conn, &op_id).await? {
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

    if outbox_assert_replay_or_unused(conn, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(conn).await?;

    let result: Result<bool, String> = async {
        applied_insert_processing(conn, &op_id, command_name, &request_hash).await?;

        let id_cliente =
            upsert_cliente_desde_reserva(conn, nombre_cliente, email, telefono, notas_cliente)
                .await?;

        if let Some(id) = target_id {
            let exists = exists_i64(
                conn,
                "SELECT 1 FROM Reservas WHERE ID_Reserva = ?1 LIMIT 1;",
                vec![Value::Integer(id)],
            )
            .await?;

            if exists {
                conn.execute(
                    r#"
                    UPDATE Reservas
                    SET
                      ID_Cliente = ?1,
                      ID_Mesa = ?2,
                      Dia_YMD = ?3,
                      Hora = ?4,
                      Turno = ?5,
                      Comensales = ?6,
                      Nota = ?7,
                      Estado = ?8
                    WHERE ID_Reserva = ?9;
                    "#,
                    vec![
                        Value::Integer(id_cliente),
                        Value::Integer(args.id_mesa),
                        Value::Text(dia.clone()),
                        Value::Text(hora.clone()),
                        Value::Text(turno_final.clone()),
                        Value::Integer(args.comensales),
                        match nota.clone() {
                            Some(n) => Value::Text(n),
                            None => Value::Null,
                        },
                        Value::Text(estado_final.clone()),
                        Value::Integer(id),
                    ],
                )
                .await
                .map_err(|e| format!("UPDATE reserva error: {e}"))?;
            } else {
                conn.execute(
                    r#"
                    INSERT INTO Reservas (
                      ID_Reserva,
                      ID_Cliente,
                      ID_Mesa,
                      Dia_YMD,
                      Hora,
                      Turno,
                      Comensales,
                      Nota,
                      Estado
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9);
                    "#,
                    vec![
                        Value::Integer(id),
                        Value::Integer(id_cliente),
                        Value::Integer(args.id_mesa),
                        Value::Text(dia.clone()),
                        Value::Text(hora.clone()),
                        Value::Text(turno_final.clone()),
                        Value::Integer(args.comensales),
                        match nota.clone() {
                            Some(n) => Value::Text(n),
                            None => Value::Null,
                        },
                        Value::Text(estado_final.clone()),
                    ],
                )
                .await
                .map_err(|e| format!("INSERT reserva explicit ID error: {e}"))?;
            }
        } else {
            conn.execute(
                r#"
                INSERT INTO Reservas (
                  ID_Cliente,
                  ID_Mesa,
                  Dia_YMD,
                  Hora,
                  Turno,
                  Comensales,
                  Nota,
                  Estado
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);
                "#,
                vec![
                    Value::Integer(id_cliente),
                    Value::Integer(args.id_mesa),
                    Value::Text(dia.clone()),
                    Value::Text(hora.clone()),
                    Value::Text(turno_final.clone()),
                    Value::Integer(args.comensales),
                    match nota.clone() {
                        Some(n) => Value::Text(n),
                        None => Value::Null,
                    },
                    Value::Text(estado_final.clone()),
                ],
            )
            .await
            .map_err(|e| format!("INSERT reserva error: {e}"))?;

            let new_id = select_one_i64(conn, "SELECT last_insert_rowid();", vec![])
                .await?
                .unwrap_or(0);

            if new_id <= 0 {
                return Err("No se pudo obtener last_insert_rowid() de Reserva".into());
            }
        }

        maybe_insert_outbox(conn, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(conn, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match result {
        Ok(result) => {
            commit(conn).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(conn).await;
            Err(e)
        }
    }
}

async fn reservas_delete_core(
    conn: &Connection,
    args: ReservaDeleteArgs,
    force_enqueue_outbox: bool,
) -> Result<bool, String> {
    let enqueue_outbox = if force_enqueue_outbox {
        should_enqueue_outbox(args.enqueue_outbox)
    } else {
        false
    };

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_reserva <= 0 {
        return Err("ID_Reserva inválido".into());
    }

    let command_name = "reservas.delete";

    let domain_args = json!({
        "id_reserva": args.id_reserva
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(conn, &op_id).await? {
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

    if outbox_assert_replay_or_unused(conn, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(conn).await?;

    let result: Result<bool, String> = async {
        applied_insert_processing(conn, &op_id, command_name, &request_hash).await?;

        conn.execute(
            r#"
            UPDATE Comandas
            SET ID_Reserva = NULL
            WHERE ID_Reserva = ?1;
            "#,
            vec![Value::Integer(args.id_reserva)],
        )
        .await
        .map_err(|e| format!("UPDATE Comandas error: {e}"))?;

        let affected = conn
            .execute(
                r#"
                DELETE FROM Reservas
                WHERE ID_Reserva = ?1;
                "#,
                vec![Value::Integer(args.id_reserva)],
            )
            .await
            .map_err(|e| format!("DELETE Reservas error: {e}"))?;

        let result = affected > 0;

        maybe_insert_outbox(conn, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(conn, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match result {
        Ok(result) => {
            commit(conn).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(conn).await;
            Err(e)
        }
    }
}

/* =========================================================
   Commands lectura
========================================================= */

#[tauri::command]
pub async fn reservas_get_meta(state: State<'_, AppState>) -> Result<ReservasMeta, String> {
    let conn = get_db(&state).await?;

    let zsql = r#"
      SELECT ID_Zona, Nombre_Zona
      FROM Zonas
      ORDER BY ID_Zona ASC;
    "#;

    let zraw = query_rows_fixed(&conn, zsql, Vec::<Value>::new(), 2).await?;

    let zonas = zraw
        .into_iter()
        .map(|r| ZonaRow {
            id_zona: get_i64(&r, 0),
            nombre_zona: get_string(&r, 1),
        })
        .collect::<Vec<_>>();

    let msql1 = r#"
      SELECT ID_Mesa, ID_Zona, Numero_Mesa, Capacidad
      FROM Mesas
      WHERE COALESCE(Es_Sistema, 0) = 0
      ORDER BY ID_Zona ASC, ID_Mesa ASC;
    "#;

    let msql2 = r#"
      SELECT ID_Mesa, ID_Zona, Numero_Mesa, Capacidad
      FROM Mesas
      ORDER BY ID_Zona ASC, ID_Mesa ASC;
    "#;

    let mraw = match query_rows_fixed(&conn, msql1, Vec::<Value>::new(), 4).await {
        Ok(rows) => rows,
        Err(_) => query_rows_fixed(&conn, msql2, Vec::<Value>::new(), 4).await?,
    };

    let mesas = mraw
        .into_iter()
        .map(|r| MesaRow {
            id_mesa: get_i64(&r, 0),
            id_zona: get_i64(&r, 1),
            numero_mesa: get_string(&r, 2),
            capacidad: get_i64(&r, 3),
        })
        .collect::<Vec<_>>();

    Ok(ReservasMeta { zonas, mesas })
}

#[tauri::command]
pub async fn reservas_get_mes(
    state: State<'_, AppState>,
    args: ReservasGetMesArgs,
) -> Result<Vec<ReservaRow>, String> {
    let conn = get_db(&state).await?;

    let desde = normalize_dia_ymd(&args.desde)?;
    let hasta = normalize_dia_ymd(&args.hasta)?;

    let sql = r#"
      SELECT
        R.ID_Reserva,
        R.ID_Mesa,
        R.Dia_YMD,
        R.Hora,
        R.Turno,
        R.Comensales,
        R.Nota,
        R.Estado,

        C.Nombre AS Nombre_Cliente,
        C.Telefono AS Telefono_Cliente,
        C.Email AS Email_Cliente,

        M.ID_Zona,
        M.Numero_Mesa,
        M.Capacidad,

        Z.Nombre_Zona

      FROM Reservas R
      JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
      JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa
      JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona

      WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2
      ORDER BY R.Dia_YMD ASC, R.Hora ASC, R.ID_Reserva ASC;
    "#;

    let raw =
        query_rows_fixed(&conn, sql, vec![Value::Text(desde), Value::Text(hasta)], 15).await?;

    let mut out: Vec<ReservaRow> = Vec::new();

    for r in raw {
        out.push(ReservaRow {
            id_reserva: get_i64(&r, 0),
            id_mesa: get_i64(&r, 1),
            dia_ymd: get_string(&r, 2),
            hora: get_string(&r, 3),
            turno: get_opt_string(&r, 4),
            comensales: get_i64(&r, 5),
            nota: get_opt_string(&r, 6),
            estado: get_string(&r, 7),

            nombre_cliente: get_string(&r, 8),
            telefono_cliente: get_opt_string(&r, 9),
            email_cliente: get_opt_string(&r, 10),

            id_zona: get_i64(&r, 11),
            numero_mesa: get_string(&r, 12),
            capacidad: get_i64(&r, 13),
            nombre_zona: get_string(&r, 14),
        });
    }

    Ok(out)
}

/* =========================================================
   Commands escritura con outbox
========================================================= */

#[tauri::command]
pub async fn reservas_save(
    state: State<'_, AppState>,
    args: ReservaSaveArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    reservas_save_core(&conn, args, true).await
}

#[tauri::command]
pub async fn reservas_delete(
    state: State<'_, AppState>,
    args: ReservaDeleteArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    reservas_delete_core(&conn, args, true).await
}

/* =========================================================
   Commands escritura SIN outbox
   Para afterRemoteOk / sincronización nube -> local
========================================================= */

#[tauri::command]
pub async fn reservas_apply_remote_ok(
    state: State<'_, AppState>,
    args: ReservaSaveArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    reservas_save_core(&conn, args, false).await
}

#[tauri::command]
pub async fn reservas_save_after_remote_ok(
    state: State<'_, AppState>,
    args: ReservaSaveArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    reservas_save_core(&conn, args, false).await
}

#[tauri::command]
pub async fn reservas_delete_after_remote_ok(
    state: State<'_, AppState>,
    args: ReservaDeleteArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;
    reservas_delete_core(&conn, args, false).await
}
