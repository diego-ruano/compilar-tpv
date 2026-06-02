use crate::{get_db, AppState};

use chrono::Local;
use libsql::{Connection, Value};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};

const PBKDF2_PREFIX: &str = "$pbkdf2-sha256$";
const PBKDF2_ITERS: u32 = 100_000;
const SALT_LEN: usize = 16;
const DK_LEN: usize = 32;

/* =========================================================
   Helpers genéricos
========================================================= */

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

fn today_ymd() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn now_iso() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn timing_safe_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }

    let mut diff: u8 = 0;

    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }

    diff == 0
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

fn validate_email_basic(email: &str) -> bool {
    let e = email.trim();
    e.len() >= 6 && e.contains('@') && e.contains('.') && !e.contains(' ')
}

/* =========================================================
   PBKDF2 helpers
========================================================= */

fn parse_pbkdf2_phc(phc: &str) -> Result<(u32, Vec<u8>, Vec<u8>), String> {
    let h = phc.trim();

    if h.starts_with("$argon2") || h.starts_with("argon2") {
        return Err("HASH_ARGON2_NO_SOPORTADO: rehash Password_Hash a pbkdf2-sha256".into());
    }

    if !h.starts_with(PBKDF2_PREFIX) {
        return Err("HASH_DESCONOCIDO: Password_Hash no es pbkdf2-sha256".into());
    }

    let parts: Vec<&str> = h.split('$').collect();

    if parts.len() < 5 {
        return Err("Hash almacenado mal formado".into());
    }

    let iter_part = parts[2].trim();
    let iters = iter_part
        .strip_prefix("i=")
        .ok_or_else(|| "Hash params i inválido".to_string())?
        .parse::<u32>()
        .map_err(|_| "Hash params i inválido".to_string())?;

    if iters == 0 {
        return Err("Hash params i inválido".into());
    }

    let salt_b64 = parts[3].trim();
    let dk_b64 = parts[4].trim();

    let salt = B64
        .decode(salt_b64)
        .map_err(|_| "Hash almacenado mal formado".to_string())?;

    let dk = B64
        .decode(dk_b64)
        .map_err(|_| "Hash almacenado mal formado".to_string())?;

    if salt.is_empty() || dk.is_empty() {
        return Err("Hash almacenado mal formado".into());
    }

    Ok((iters, salt, dk))
}

fn hash_pin(pin: &str) -> Result<String, String> {
    let p = pin.trim();

    if p.len() < 4 {
        return Err("PIN demasiado corto".into());
    }

    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);

    let mut dk = [0u8; DK_LEN];
    pbkdf2_hmac::<Sha256>(p.as_bytes(), &salt, PBKDF2_ITERS, &mut dk);

    let salt_b64 = B64.encode(salt);
    let dk_b64 = B64.encode(dk);

    Ok(format!(
        "{}i={}${}${}",
        PBKDF2_PREFIX, PBKDF2_ITERS, salt_b64, dk_b64
    ))
}

fn verify_pin(pin: &str, stored_hash: &str) -> Result<(), String> {
    let p = pin.trim();

    if p.len() < 4 {
        return Err("PIN incorrecto".into());
    }

    let (iters, salt, expected_dk) = parse_pbkdf2_phc(stored_hash)?;

    let mut actual = vec![0u8; expected_dk.len()];
    pbkdf2_hmac::<Sha256>(p.as_bytes(), &salt, iters, &mut actual);

    if !timing_safe_eq(&actual, &expected_dk) {
        return Err("PIN incorrecto".into());
    }

    Ok(())
}

/* =========================================================
   Tipos frontend
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserListItem {
    pub id_usuario: i64,
    pub nombre: String,
    pub apellido: Option<String>,
    pub nombre_rol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginOk {
    pub id_usuario: i64,
    pub id_trabajador: Option<i64>,
    pub nombre: String,
    pub apellido: Option<String>,
    pub rol: String,
    pub email: String,
    pub requiere_setup: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PunchParte {
    pub parte: i64,
    pub entrada: Option<String>,
    pub salida: Option<String>,
    pub estado: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PunchStatus {
    pub fecha: String,
    pub turno_partido: i64,
    pub partes: Vec<PunchParte>,
}

/* =========================================================
   Args commands
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct LoginUserArgs {
    pub id_usuario: i64,
    pub pin: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PunchStatusArgs {
    pub id_usuario: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetTurnoPartidoArgs {
    pub op_id: String,
    pub id_usuario: i64,
    pub turno_partido: bool,

    #[serde(default)]
    pub fecha: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompleteInitialSetupArgs {
    pub op_id: String,
    pub id_usuario: i64,
    pub pin_actual: String,
    pub pin_nuevo: String,
    pub email_nuevo: String,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PunchArgs {
    pub op_id: String,
    pub id_usuario: i64,
    pub pin: String,
    pub tipo: String,

    #[serde(default)]
    pub fecha: Option<String>,

    #[serde(default)]
    pub hora_evento: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
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
   Helpers turno partido / fichajes
========================================================= */

async fn get_turno_partido_for(
    conn: &Connection,
    id_usuario: i64,
    fecha: &str,
) -> Result<i64, String> {
    let mut rows = conn
        .query(
            r#"
            SELECT Turno_Partido
            FROM Fichaje_Dia
            WHERE ID_Usuario=?1 AND Fecha=?2
            LIMIT 1;
            "#,
            vec![Value::Integer(id_usuario), Value::Text(fecha.to_string())],
        )
        .await
        .map_err(|e| e.to_string())?;

    if let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let v = match row.get_value(0).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => 0,
        };

        return Ok(v);
    }

    Ok(0)
}

async fn build_punch_status(
    conn: &Connection,
    id_usuario: i64,
    fecha: &str,
) -> Result<PunchStatus, String> {
    let turno_partido = get_turno_partido_for(conn, id_usuario, fecha).await?;

    let mut rows = conn
        .query(
            r#"
            SELECT Parte, Hora_Entrada, Hora_Salida, Estado
            FROM Fichajes
            WHERE ID_Usuario=?1 AND Fecha=?2
            ORDER BY Parte ASC;
            "#,
            vec![Value::Integer(id_usuario), Value::Text(fecha.to_string())],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut partes: Vec<PunchParte> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let parte = match row.get_value(0).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => 1,
        };

        let entrada = match row.get_value(1).map_err(|e| e.to_string())? {
            Value::Null => None,
            Value::Text(s) => Some(s),
            _ => None,
        };

        let salida = match row.get_value(2).map_err(|e| e.to_string())? {
            Value::Null => None,
            Value::Text(s) => Some(s),
            _ => None,
        };

        let estado = match row.get_value(3).map_err(|e| e.to_string())? {
            Value::Text(s) => s,
            _ => "ABIERTO".into(),
        };

        partes.push(PunchParte {
            parte,
            entrada,
            salida,
            estado,
        });
    }

    Ok(PunchStatus {
        fecha: fecha.to_string(),
        turno_partido,
        partes,
    })
}

/* =========================================================
   Lecturas
========================================================= */

#[tauri::command]
pub fn hash_password(pin: String) -> Result<String, String> {
    hash_pin(&pin)
}

#[tauri::command]
pub async fn list_login_users(state: State<'_, AppState>) -> Result<Vec<UserListItem>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
        SELECT u.ID_Usuario,
               u.Nombre,
               u.Apellido,
               r.Nombre_Rol
        FROM Usuarios u
        JOIN Roles r ON r.ID_Rol = u.ID_Rol
        WHERE u.Estado = 'Activo'
        ORDER BY u.Nombre ASC;
    "#;

    let mut rows = db.query(sql, ()).await.map_err(|e| e.to_string())?;
    let mut out: Vec<UserListItem> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let id_usuario = match row.get_value(0).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => continue,
        };

        let nombre = match row.get_value(1).map_err(|e| e.to_string())? {
            Value::Text(s) => s,
            _ => "".into(),
        };

        let apellido = match row.get_value(2).map_err(|e| e.to_string())? {
            Value::Null => None,
            Value::Text(s) => Some(s),
            _ => None,
        };

        let nombre_rol = match row.get_value(3).map_err(|e| e.to_string())? {
            Value::Text(s) => s,
            _ => "Sin rol".into(),
        };

        out.push(UserListItem {
            id_usuario,
            nombre,
            apellido,
            nombre_rol,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn login_user(
    state: State<'_, AppState>,
    args: LoginUserArgs,
) -> Result<LoginOk, String> {
    let db = get_db(&state).await?;

    let sql = r#"
        SELECT u.ID_Usuario,
               t.ID_Trabajador,
               u.Nombre,
               u.Apellido,
               u.Email,
               u.Password_Hash,
               u.Requiere_Setup,
               r.Nombre_Rol
        FROM Usuarios u
        JOIN Roles r ON r.ID_Rol = u.ID_Rol
        LEFT JOIN Trabajadores t ON t.ID_Usuario = u.ID_Usuario
        WHERE u.ID_Usuario = ?1 AND u.Estado = 'Activo'
        LIMIT 1;
    "#;

    let mut rows = db
        .query(sql, vec![Value::Integer(args.id_usuario)])
        .await
        .map_err(|e| e.to_string())?;

    let row = rows
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Usuario no encontrado o inactivo".to_string())?;

    let id = match row.get_value(0).map_err(|e| e.to_string())? {
        Value::Integer(n) => n,
        _ => return Err("ID_Usuario inválido".into()),
    };

    let id_trabajador = match row.get_value(1).map_err(|e| e.to_string())? {
        Value::Null => None,
        Value::Integer(n) => Some(n),
        _ => None,
    };

    let nombre = match row.get_value(2).map_err(|e| e.to_string())? {
        Value::Text(s) => s,
        _ => "".into(),
    };

    let apellido = match row.get_value(3).map_err(|e| e.to_string())? {
        Value::Null => None,
        Value::Text(s) => Some(s),
        _ => None,
    };

    let email = match row.get_value(4).map_err(|e| e.to_string())? {
        Value::Text(s) => s,
        _ => "admin@local".into(),
    };

    let password_hash = match row.get_value(5).map_err(|e| e.to_string())? {
        Value::Text(s) => s,
        _ => return Err("Password_Hash inválido".into()),
    };

    let requiere_setup = match row.get_value(6).map_err(|e| e.to_string())? {
        Value::Integer(n) => n,
        _ => 0,
    };

    let rol = match row.get_value(7).map_err(|e| e.to_string())? {
        Value::Text(s) => s,
        _ => "Sin rol".into(),
    };

    verify_pin(&args.pin, &password_hash)?;

    Ok(LoginOk {
        id_usuario: id,
        id_trabajador,
        nombre,
        apellido,
        rol,
        email,
        requiere_setup,
    })
}

#[tauri::command]
pub async fn get_today_punch_status(
    state: State<'_, AppState>,
    args: PunchStatusArgs,
) -> Result<PunchStatus, String> {
    let db = get_db(&state).await?;
    let fecha = today_ymd();

    build_punch_status(&db, args.id_usuario, &fecha).await
}

/* =========================================================
   Writes con idempotencia + outbox opcional
========================================================= */

#[tauri::command]
pub async fn set_turno_partido_hoy(
    state: State<'_, AppState>,
    args: SetTurnoPartidoArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let fecha = clean_opt_string(args.fecha).unwrap_or_else(today_ymd);

    if args.id_usuario <= 0 {
        return Err("id_usuario inválido".into());
    }

    let command_name = "login.setTurnoPartidoHoy";

    let domain_args = json!({
        "id_usuario": args.id_usuario,
        "fecha": fecha.clone(),
        "turno_partido": args.turno_partido
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

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            INSERT INTO Fichaje_Dia (ID_Usuario, Fecha, Turno_Partido)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(ID_Usuario, Fecha) DO UPDATE SET
              Turno_Partido = excluded.Turno_Partido;
            "#,
            vec![
                Value::Integer(args.id_usuario),
                Value::Text(fecha.clone()),
                Value::Integer(if args.turno_partido { 1 } else { 0 }),
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
pub async fn complete_initial_setup(
    state: State<'_, AppState>,
    args: CompleteInitialSetupArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let email_nuevo = normalize_required(&args.email_nuevo, "email_nuevo")?;
    let pin_actual = normalize_required(&args.pin_actual, "pin_actual")?;
    let pin_nuevo = normalize_required(&args.pin_nuevo, "pin_nuevo")?;

    if args.id_usuario <= 0 {
        return Err("id_usuario inválido".into());
    }

    if pin_nuevo.trim().len() < 4 {
        return Err("El PIN nuevo debe tener al menos 4 dígitos".into());
    }

    if !validate_email_basic(&email_nuevo) {
        return Err("Email inválido".into());
    }

    let command_name = "login.completeInitialSetup";

    let domain_args = json!({
        "id_usuario": args.id_usuario,
        "pin_actual": pin_actual.clone(),
        "pin_nuevo": pin_nuevo.clone(),
        "email_nuevo": email_nuevo.trim()
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

    let mut rows = db
        .query(
            r#"
            SELECT Password_Hash, Requiere_Setup
            FROM Usuarios
            WHERE ID_Usuario = ?1 AND Estado='Activo'
            LIMIT 1;
            "#,
            vec![Value::Integer(args.id_usuario)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let row = rows
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Usuario no encontrado".to_string())?;

    let stored_hash = match row.get_value(0).map_err(|e| e.to_string())? {
        Value::Text(s) => s,
        _ => return Err("Password_Hash inválido".into()),
    };

    let requiere_setup = match row.get_value(1).map_err(|e| e.to_string())? {
        Value::Integer(n) => n,
        _ => 0,
    };

    if requiere_setup == 0 {
        return Err("Este usuario ya completó el setup inicial".into());
    }

    verify_pin(&pin_actual, &stored_hash)?;

    let mut chk = db
        .query(
            r#"
            SELECT COUNT(*)
            FROM Usuarios
            WHERE Email = ?1 AND ID_Usuario <> ?2;
            "#,
            vec![
                Value::Text(email_nuevo.trim().to_string()),
                Value::Integer(args.id_usuario),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

    let r = chk
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Error validando email".to_string())?;

    let count = match r.get_value(0).map_err(|e| e.to_string())? {
        Value::Integer(n) => n,
        _ => 0,
    };

    if count > 0 {
        return Err("Ese email ya está en uso".into());
    }

    let new_hash = hash_pin(pin_nuevo.trim())?;

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            UPDATE Usuarios
            SET Email = ?2,
                Password_Hash = ?3,
                Requiere_Setup = 0
            WHERE ID_Usuario = ?1;
            "#,
            vec![
                Value::Integer(args.id_usuario),
                Value::Text(email_nuevo.trim().to_string()),
                Value::Text(new_hash.clone()),
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
pub async fn punch(state: State<'_, AppState>, args: PunchArgs) -> Result<PunchStatus, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let tipo = normalize_required(&args.tipo, "tipo")?.to_lowercase();
    let fecha = clean_opt_string(args.fecha).unwrap_or_else(today_ymd);
    let hora_evento = clean_opt_string(args.hora_evento).unwrap_or_else(now_iso);

    if args.id_usuario <= 0 {
        return Err("id_usuario inválido".into());
    }

    if tipo != "entrada" && tipo != "salida" {
        return Err("Tipo inválido (usa 'entrada' o 'salida')".into());
    }

    let command_name = "login.punch";

    let domain_args = json!({
        "id_usuario": args.id_usuario,
        "pin": args.pin.trim(),
        "tipo": tipo.clone(),
        "fecha": fecha.clone(),
        "hora_evento": hora_evento.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<PunchStatus>(existing.result_json),
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
        return build_punch_status(&db, args.id_usuario, &fecha).await;
    }

    let mut rows = db
        .query(
            r#"
            SELECT Password_Hash
            FROM Usuarios
            WHERE ID_Usuario = ?1 AND Estado = 'Activo'
            LIMIT 1;
            "#,
            vec![Value::Integer(args.id_usuario)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let row = rows
        .next()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Usuario no encontrado o inactivo".to_string())?;

    let stored_hash = match row.get_value(0).map_err(|e| e.to_string())? {
        Value::Text(s) => s,
        _ => return Err("Password_Hash inválido".into()),
    };

    verify_pin(&args.pin, &stored_hash)?;

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<PunchStatus, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        if tipo == "entrada" {
            let mut o = db
                .query(
                    r#"
                    SELECT ID_Fichaje
                    FROM Fichajes
                    WHERE ID_Usuario=?1 AND Fecha=?2
                      AND Estado='ABIERTO'
                      AND Hora_Entrada IS NOT NULL
                      AND Hora_Salida IS NULL
                    LIMIT 1;
                    "#,
                    vec![Value::Integer(args.id_usuario), Value::Text(fecha.clone())],
                )
                .await
                .map_err(|e| e.to_string())?;

            if o.next().await.map_err(|e| e.to_string())?.is_some() {
                return Err(
                    "Tienes un fichaje abierto. Ficha salida antes de fichar entrada.".into(),
                );
            }

            let turno_partido = get_turno_partido_for(&db, args.id_usuario, &fecha).await?;

            let mut p1 = db
                .query(
                    r#"
                    SELECT Hora_Entrada, Hora_Salida
                    FROM Fichajes
                    WHERE ID_Usuario=?1 AND Fecha=?2 AND Parte=1
                    LIMIT 1;
                    "#,
                    vec![Value::Integer(args.id_usuario), Value::Text(fecha.clone())],
                )
                .await
                .map_err(|e| e.to_string())?;

            let parte_a_abrir: i64 =
                if let Some(row) = p1.next().await.map_err(|e| e.to_string())? {
                    let salida = match row.get_value(1).map_err(|e| e.to_string())? {
                        Value::Null => None,
                        Value::Text(s) => Some(s),
                        _ => None,
                    };

                    if salida.is_none() {
                        return Err("La Parte 1 no está cerrada. Ficha salida primero.".into());
                    }

                    if turno_partido == 1 {
                        let mut p2 = db
                            .query(
                                r#"
                                SELECT COUNT(*)
                                FROM Fichajes
                                WHERE ID_Usuario=?1 AND Fecha=?2 AND Parte=2;
                                "#,
                                vec![Value::Integer(args.id_usuario), Value::Text(fecha.clone())],
                            )
                            .await
                            .map_err(|e| e.to_string())?;

                        let r2 = p2
                            .next()
                            .await
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| "No se pudo validar Parte 2".to_string())?;

                        let c2 = match r2.get_value(0).map_err(|e| e.to_string())? {
                            Value::Integer(n) => n,
                            _ => 0,
                        };

                        if c2 > 0 {
                            return Err("Ya has completado el turno partido hoy.".into());
                        }

                        2
                    } else {
                        return Err("Hoy no tienes turno partido. Ya has fichado el día.".into());
                    }
                } else {
                    1
                };

            db.execute(
                r#"
                INSERT INTO Fichajes (
                  ID_Usuario,
                  Fecha,
                  Parte,
                  Hora_Entrada,
                  Hora_Salida,
                  Estado,
                  Cerrado_Automatico
                )
                VALUES (?1, ?2, ?3, ?4, NULL, 'ABIERTO', 0);
                "#,
                vec![
                    Value::Integer(args.id_usuario),
                    Value::Text(fecha.clone()),
                    Value::Integer(parte_a_abrir),
                    Value::Text(hora_evento.clone()),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        } else {
            let mut o = db
                .query(
                    r#"
                    SELECT ID_Fichaje, Parte
                    FROM Fichajes
                    WHERE ID_Usuario=?1 AND Fecha=?2
                      AND Estado='ABIERTO'
                      AND Hora_Entrada IS NOT NULL
                      AND Hora_Salida IS NULL
                    ORDER BY Parte DESC
                    LIMIT 1;
                    "#,
                    vec![Value::Integer(args.id_usuario), Value::Text(fecha.clone())],
                )
                .await
                .map_err(|e| e.to_string())?;

            let Some(row) = o.next().await.map_err(|e| e.to_string())? else {
                return Err("No hay fichaje abierto para cerrar (primero ficha entrada).".into());
            };

            let id_f = match row.get_value(0).map_err(|e| e.to_string())? {
                Value::Integer(n) => n,
                _ => return Err("ID_Fichaje inválido".into()),
            };

            db.execute(
                r#"
                UPDATE Fichajes
                SET Hora_Salida = ?2,
                    Estado = 'CERRADO',
                    Cerrado_Automatico = 0,
                    Cierre_Motivo = NULL,
                    Incidencia = NULL
                WHERE ID_Fichaje = ?1;
                "#,
                vec![Value::Integer(id_f), Value::Text(hora_evento.clone())],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = build_punch_status(&db, args.id_usuario, &fecha).await?;
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
