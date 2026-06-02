// src-tauri/src/trabajadores.rs
use libsql::{Connection, Value};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{get_db, AppState};

use chrono::{Datelike, Duration, Local, NaiveDate, Weekday};
use std::collections::{BTreeMap, HashSet};

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
   Helpers fecha/hora
========================================================= */

fn weekday_1_to_7_from_ymd(ymd: &str) -> Option<i64> {
    let d = NaiveDate::parse_from_str(ymd, "%Y-%m-%d").ok()?;
    let wd = d.weekday();

    let n = match wd {
        Weekday::Mon => 1,
        Weekday::Tue => 2,
        Weekday::Wed => 3,
        Weekday::Thu => 4,
        Weekday::Fri => 5,
        Weekday::Sat => 6,
        Weekday::Sun => 7,
    };

    Some(n)
}

fn hhmm_opt(t: &Option<String>) -> String {
    t.as_deref().unwrap_or("").chars().take(5).collect()
}

/* =========================================================
   OUTPUT
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RolRow {
    #[serde(rename = "ID_Rol")]
    pub id_rol: i64,
    #[serde(rename = "Nombre_Rol")]
    pub nombre_rol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrabajadorRow {
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: i64,
    #[serde(rename = "ID_Usuario")]
    pub id_usuario: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Apellido")]
    pub apellido: Option<String>,
    #[serde(rename = "Email")]
    pub email: String,
    #[serde(rename = "Estado")]
    pub estado: String,
    #[serde(rename = "Nombre_Rol")]
    pub nombre_rol: String,
    #[serde(rename = "Telefono")]
    pub telefono: Option<String>,
    #[serde(rename = "Puesto")]
    pub puesto: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrabajadorDetailRow {
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: i64,
    #[serde(rename = "ID_Usuario")]
    pub id_usuario: i64,
    #[serde(rename = "ID_Rol")]
    pub id_rol: i64,
    #[serde(rename = "Email")]
    pub email: String,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Apellido")]
    pub apellido: Option<String>,
    #[serde(rename = "Estado")]
    pub estado: String,
    #[serde(rename = "DNI")]
    pub dni: Option<String>,
    #[serde(rename = "Telefono")]
    pub telefono: Option<String>,
    #[serde(rename = "Puesto")]
    pub puesto: Option<String>,
    #[serde(rename = "IBAN")]
    pub iban: Option<String>,
    #[serde(rename = "Numero_Seguridad_Social")]
    pub numero_seguridad_social: Option<String>,
    #[serde(rename = "Fecha_Inicio_Contrato")]
    pub fecha_inicio_contrato: Option<String>,
    #[serde(rename = "Fecha_Fin_Contrato")]
    pub fecha_fin_contrato: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnoRow {
    #[serde(rename = "ID_Turno")]
    pub id_turno: i64,
    #[serde(rename = "Nombre_Turno")]
    pub nombre_turno: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsignacionRow {
    #[serde(rename = "ID_Asignacion")]
    pub id_asignacion: i64,
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: i64,
    #[serde(rename = "Fecha")]
    pub fecha: String,
    #[serde(rename = "ID_Turno")]
    pub id_turno: i64,
    #[serde(rename = "Area")]
    pub area: String,
    #[serde(rename = "Hora_Inicio")]
    pub hora_inicio: Option<String>,
    #[serde(rename = "Hora_Fin")]
    pub hora_fin: Option<String>,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
    #[serde(rename = "Nombre_Turno")]
    pub nombre_turno: String,
}

/* =========================================================
   INPUT
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrabajadorDetailArgs {
    #[serde(alias = "idTrabajador")]
    pub id_trabajador: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrabajadorIdByUsuarioArgs {
    #[serde(alias = "idUsuario")]
    pub id_usuario: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HorariosSemanaArgs {
    #[serde(alias = "fechaLunes")]
    pub fecha_lunes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsignacionCreateArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "idTrabajador")]
    pub id_trabajador: i64,

    pub fecha: String,

    #[serde(alias = "idTurno")]
    pub id_turno: i64,

    pub area: String,

    #[serde(default, alias = "horaInicio")]
    pub hora_inicio: Option<String>,

    #[serde(default, alias = "horaFin")]
    pub hora_fin: Option<String>,

    #[serde(default)]
    pub notas: Option<String>,

    #[serde(
        default,
        alias = "remoteIdAsignacion",
        alias = "remote_id_asignacion",
        alias = "idAsignacion",
        alias = "id_asignacion"
    )]
    pub remote_id_asignacion: Option<i64>,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsignacionUpdateArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "idAsignacion")]
    pub id_asignacion: i64,

    #[serde(alias = "idTurno")]
    pub id_turno: i64,

    pub area: String,

    #[serde(default, alias = "horaInicio")]
    pub hora_inicio: Option<String>,

    #[serde(default, alias = "horaFin")]
    pub hora_fin: Option<String>,

    #[serde(default)]
    pub notas: Option<String>,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsignacionDeleteArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "idAsignacion")]
    pub id_asignacion: i64,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteAsignacionInput {
    #[serde(default, alias = "ID_Asignacion", alias = "id_asignacion")]
    pub id_asignacion: Option<i64>,

    #[serde(default, alias = "ID_Trabajador", alias = "id_trabajador")]
    pub id_trabajador: Option<i64>,

    #[serde(default, alias = "Fecha")]
    pub fecha: Option<String>,

    #[serde(default, alias = "ID_Turno", alias = "id_turno")]
    pub id_turno: Option<i64>,

    #[serde(default, alias = "Area")]
    pub area: Option<String>,

    #[serde(default, alias = "Hora_Inicio", alias = "hora_inicio")]
    pub hora_inicio: Option<String>,

    #[serde(default, alias = "Hora_Fin", alias = "hora_fin")]
    pub hora_fin: Option<String>,

    #[serde(default, alias = "Notas")]
    pub notas: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopySemanaArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "fromMonday")]
    pub from_monday: String,

    #[serde(alias = "toMonday")]
    pub to_monday: String,

    #[serde(default)]
    pub overwrite: Option<bool>,

    #[serde(default, alias = "remoteAsignaciones")]
    pub remote_asignaciones: Vec<RemoteAsignacionInput>,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetPredeterminadoDesdeSemanaArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "fechaLunes")]
    pub fecha_lunes: String,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   Normalizados internos
========================================================= */

#[derive(Debug, Clone)]
struct AsignacionCreateNorm {
    op_id: String,
    id_trabajador: i64,
    fecha: String,
    id_turno: i64,
    area: String,
    hora_inicio: Option<String>,
    hora_fin: Option<String>,
    notas: Option<String>,
    remote_id_asignacion: Option<i64>,
    enqueue_outbox: bool,
}

#[derive(Debug, Clone)]
struct AsignacionUpdateNorm {
    op_id: String,
    id_asignacion: i64,
    id_turno: i64,
    area: String,
    hora_inicio: Option<String>,
    hora_fin: Option<String>,
    notas: Option<String>,
    enqueue_outbox: bool,
}

#[derive(Debug, Clone)]
struct AsignacionDeleteNorm {
    op_id: String,
    id_asignacion: i64,
    enqueue_outbox: bool,
}

#[derive(Debug, Clone)]
struct CopySemanaNorm {
    op_id: String,
    from_monday: String,
    to_monday: String,
    overwrite: bool,
    remote_asignaciones: Vec<RemoteAsignacionInput>,
    enqueue_outbox: bool,
}

#[derive(Debug, Clone)]
struct SetPredeterminadoDesdeSemanaNorm {
    op_id: String,
    fecha_lunes: String,
    enqueue_outbox: bool,
}

fn normalize_create_args(args: AsignacionCreateArgs) -> Result<AsignacionCreateNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_trabajador <= 0 || args.id_turno <= 0 {
        return Err("id_trabajador/id_turno required".into());
    }

    let fecha = normalize_required(&args.fecha, "fecha")?;
    let area = normalize_required(&args.area, "area")?;

    Ok(AsignacionCreateNorm {
        op_id,
        id_trabajador: args.id_trabajador,
        fecha,
        id_turno: args.id_turno,
        area,
        hora_inicio: clean_opt_string(args.hora_inicio),
        hora_fin: clean_opt_string(args.hora_fin),
        notas: clean_opt_string(args.notas),
        remote_id_asignacion: args.remote_id_asignacion.filter(|n| *n > 0),
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

fn normalize_update_args(args: AsignacionUpdateArgs) -> Result<AsignacionUpdateNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_asignacion <= 0 || args.id_turno <= 0 {
        return Err("id_asignacion/id_turno required".into());
    }

    let area = normalize_required(&args.area, "area")?;

    Ok(AsignacionUpdateNorm {
        op_id,
        id_asignacion: args.id_asignacion,
        id_turno: args.id_turno,
        area,
        hora_inicio: clean_opt_string(args.hora_inicio),
        hora_fin: clean_opt_string(args.hora_fin),
        notas: clean_opt_string(args.notas),
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

fn normalize_delete_args(args: AsignacionDeleteArgs) -> Result<AsignacionDeleteNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_asignacion <= 0 {
        return Err("id_asignacion required".into());
    }

    Ok(AsignacionDeleteNorm {
        op_id,
        id_asignacion: args.id_asignacion,
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

fn normalize_copy_args(args: CopySemanaArgs) -> Result<CopySemanaNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;
    let from_monday = normalize_required(&args.from_monday, "from_monday")?;
    let to_monday = normalize_required(&args.to_monday, "to_monday")?;

    Ok(CopySemanaNorm {
        op_id,
        from_monday,
        to_monday,
        overwrite: args.overwrite.unwrap_or(true),
        remote_asignaciones: args.remote_asignaciones,
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

fn normalize_set_pred_args(
    args: SetPredeterminadoDesdeSemanaArgs,
) -> Result<SetPredeterminadoDesdeSemanaNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;
    let fecha_lunes = normalize_required(&args.fecha_lunes, "fecha_lunes")?;

    Ok(SetPredeterminadoDesdeSemanaNorm {
        op_id,
        fecha_lunes,
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

/* =========================================================
   Domain args / payload
========================================================= */

fn create_domain_args(n: &AsignacionCreateNorm) -> serde_json::Value {
    json!({
        "id_trabajador": n.id_trabajador,
        "fecha": n.fecha,
        "id_turno": n.id_turno,
        "area": n.area,
        "hora_inicio": n.hora_inicio,
        "hora_fin": n.hora_fin,
        "notas": n.notas,
        "remote_id_asignacion": n.remote_id_asignacion
    })
}

fn update_domain_args(n: &AsignacionUpdateNorm) -> serde_json::Value {
    json!({
        "id_asignacion": n.id_asignacion,
        "id_turno": n.id_turno,
        "area": n.area,
        "hora_inicio": n.hora_inicio,
        "hora_fin": n.hora_fin,
        "notas": n.notas
    })
}

fn delete_domain_args(n: &AsignacionDeleteNorm) -> serde_json::Value {
    json!({
        "id_asignacion": n.id_asignacion
    })
}

fn copy_domain_args(n: &CopySemanaNorm) -> serde_json::Value {
    json!({
        "from_monday": n.from_monday,
        "to_monday": n.to_monday,
        "overwrite": n.overwrite,
        "remote_asignaciones": n.remote_asignaciones
    })
}

fn set_pred_domain_args(n: &SetPredeterminadoDesdeSemanaNorm) -> serde_json::Value {
    json!({
        "fecha_lunes": n.fecha_lunes
    })
}

fn command_payload_json(
    op_id: &str,
    command_name: &str,
    domain_args: &serde_json::Value,
) -> Result<String, String> {
    stable_json_string(&json!({
        "op_id": op_id,
        "command_name": command_name,
        "args": domain_args
    }))
}

/* =========================================================
   Aplicadores locales
========================================================= */

async fn apply_create_asignacion_core(
    db: &Connection,
    n: &AsignacionCreateNorm,
) -> Result<i64, String> {
    if let Some(remote_id) = n.remote_id_asignacion {
        db.execute(
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
                Value::Integer(remote_id),
                Value::Integer(n.id_trabajador),
                Value::Text(n.fecha.clone()),
                Value::Integer(n.id_turno),
                Value::Text(n.area.clone()),
                n.hora_inicio
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
                n.hora_fin.clone().map(Value::Text).unwrap_or(Value::Null),
                n.notas.clone().map(Value::Text).unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        return Ok(remote_id);
    }

    db.execute(
        r#"
        INSERT INTO Asignacion_Turnos (
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
          date(?2),
          ?3,
          ?4,
          ?5,
          ?6,
          ?7
        );
        "#,
        vec![
            Value::Integer(n.id_trabajador),
            Value::Text(n.fecha.clone()),
            Value::Integer(n.id_turno),
            Value::Text(n.area.clone()),
            n.hora_inicio
                .clone()
                .map(Value::Text)
                .unwrap_or(Value::Null),
            n.hora_fin.clone().map(Value::Text).unwrap_or(Value::Null),
            n.notas.clone().map(Value::Text).unwrap_or(Value::Null),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;

    let mut rows = db
        .query("SELECT last_insert_rowid();", ())
        .await
        .map_err(|e| e.to_string())?;

    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Err("No se pudo obtener last_insert_rowid()".into());
    };

    let id = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);

    if id <= 0 {
        return Err("ID_Asignacion inválido al crear".into());
    }

    Ok(id)
}

async fn apply_update_asignacion_core(
    db: &Connection,
    n: &AsignacionUpdateNorm,
    missing_ok: bool,
) -> Result<bool, String> {
    let affected = db
        .execute(
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
                Value::Integer(n.id_asignacion),
                Value::Integer(n.id_turno),
                Value::Text(n.area.clone()),
                n.hora_inicio
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
                n.hora_fin.clone().map(Value::Text).unwrap_or(Value::Null),
                n.notas.clone().map(Value::Text).unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

    if affected == 0 && !missing_ok {
        return Err("Asignación no encontrada".into());
    }

    Ok(affected > 0 || missing_ok)
}

async fn apply_delete_asignacion_core(
    db: &Connection,
    id_asignacion: i64,
    missing_ok: bool,
) -> Result<bool, String> {
    let affected = db
        .execute(
            r#"
            DELETE FROM Asignacion_Turnos
            WHERE ID_Asignacion = ?1;
            "#,
            vec![Value::Integer(id_asignacion)],
        )
        .await
        .map_err(|e| e.to_string())?;

    if affected == 0 && !missing_ok {
        return Err("Asignación no encontrada".into());
    }

    Ok(affected > 0 || missing_ok)
}

async fn apply_remote_asignaciones_core(
    db: &Connection,
    to_monday: &str,
    overwrite: bool,
    rows: &[RemoteAsignacionInput],
) -> Result<bool, String> {
    if rows.is_empty() {
        return Ok(false);
    }

    if overwrite {
        db.execute(
            r#"
            DELETE FROM Asignacion_Turnos
            WHERE Fecha >= date(?1)
              AND Fecha < date(?1, '+7 day');
            "#,
            vec![Value::Text(to_monday.to_string())],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    let mut inserted = 0;

    for r in rows.iter() {
        let Some(id_asignacion) = r.id_asignacion.filter(|n| *n > 0) else {
            continue;
        };

        let Some(id_trabajador) = r.id_trabajador.filter(|n| *n > 0) else {
            continue;
        };

        let Some(id_turno) = r.id_turno.filter(|n| *n > 0) else {
            continue;
        };

        let Some(fecha) = r.fecha.clone().and_then(|s| {
            let t = s.trim().to_string();

            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }) else {
            continue;
        };

        let area = r
            .area
            .clone()
            .and_then(|s| {
                let t = s.trim().to_string();

                if t.is_empty() {
                    None
                } else {
                    Some(t)
                }
            })
            .unwrap_or_else(|| "Sala".to_string());

        let hora_inicio = clean_opt_string(r.hora_inicio.clone());
        let hora_fin = clean_opt_string(r.hora_fin.clone());
        let notas = clean_opt_string(r.notas.clone());

        db.execute(
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
                hora_inicio.map(Value::Text).unwrap_or(Value::Null),
                hora_fin.map(Value::Text).unwrap_or(Value::Null),
                notas.map(Value::Text).unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        inserted += 1;
    }

    Ok(inserted > 0)
}

async fn apply_copy_semana_core(db: &Connection, n: &CopySemanaNorm) -> Result<bool, String> {
    if !n.remote_asignaciones.is_empty() {
        return apply_remote_asignaciones_core(
            db,
            &n.to_monday,
            n.overwrite,
            &n.remote_asignaciones,
        )
        .await;
    }

    if n.overwrite {
        db.execute(
            r#"
            DELETE FROM Asignacion_Turnos
            WHERE Fecha >= date(?1)
              AND Fecha < date(?1, '+7 day');
            "#,
            vec![Value::Text(n.to_monday.clone())],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    let affected = db
        .execute(
            r#"
            INSERT INTO Asignacion_Turnos (
              ID_Trabajador,
              Fecha,
              ID_Turno,
              Area,
              Hora_Inicio,
              Hora_Fin,
              Notas
            )
            SELECT
              a.ID_Trabajador,
              date(a.Fecha, printf('%+d day',
                CAST((julianday(date(?2)) - julianday(date(?1))) AS INTEGER)
              )),
              a.ID_Turno,
              a.Area,
              a.Hora_Inicio,
              a.Hora_Fin,
              a.Notas
            FROM Asignacion_Turnos a
            WHERE a.Fecha >= date(?1)
              AND a.Fecha < date(?1, '+7 day');
            "#,
            vec![
                Value::Text(n.from_monday.clone()),
                Value::Text(n.to_monday.clone()),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(affected > 0 || n.overwrite)
}

#[derive(Debug, Clone)]
struct PredItem {
    id_turno: i64,
    area: String,
    hora_inicio: Option<String>,
    hora_fin: Option<String>,
    notas: Option<String>,
}

async fn collect_predeterminado_map(
    db: &Connection,
    lunes: &str,
) -> Result<BTreeMap<(i64, i64), Vec<PredItem>>, String> {
    let sql = r#"
      SELECT
        a.ID_Trabajador,
        a.Fecha,
        a.ID_Turno,
        a.Area,
        a.Hora_Inicio,
        a.Hora_Fin,
        a.Notas
      FROM Asignacion_Turnos a
      WHERE a.Fecha >= date(?1)
        AND a.Fecha < date(?1, '+7 day')
      ORDER BY a.ID_Trabajador ASC, a.Fecha ASC, a.Hora_Inicio ASC;
    "#;

    let mut rows = db
        .query(sql, vec![Value::Text(lunes.to_string())])
        .await
        .map_err(|e| e.to_string())?;

    let mut map: BTreeMap<(i64, i64), Vec<PredItem>> = BTreeMap::new();

    while let Ok(Some(row)) = rows.next().await {
        let id_trab = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let fecha = v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();
        let id_turno = v_i64(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0);
        let area =
            v_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_else(|| "Sala".into());
        let hora_inicio = v_string(row.get_value(4).map_err(|e| e.to_string())?);
        let hora_fin = v_string(row.get_value(5).map_err(|e| e.to_string())?);
        let notas = v_string(row.get_value(6).map_err(|e| e.to_string())?);

        if id_trab <= 0 || id_turno <= 0 || fecha.trim().is_empty() {
            continue;
        }

        let Some(weekday) = weekday_1_to_7_from_ymd(&fecha) else {
            continue;
        };

        map.entry((id_trab, weekday)).or_default().push(PredItem {
            id_turno,
            area,
            hora_inicio,
            hora_fin,
            notas,
        });
    }

    Ok(map)
}

async fn apply_predeterminado_map_core(
    db: &Connection,
    map: BTreeMap<(i64, i64), Vec<PredItem>>,
) -> Result<bool, String> {
    if map.is_empty() {
        return Ok(false);
    }

    let mut trabajadores: Vec<i64> = map.keys().map(|(t, _)| *t).collect();
    trabajadores.sort_unstable();
    trabajadores.dedup();

    for id_trab in trabajadores.iter() {
        db.execute(
            r#"
            DELETE FROM Horario_Predeterminado
            WHERE ID_Trabajador = ?1;
            "#,
            vec![Value::Integer(*id_trab)],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    for ((id_trab, weekday), list) in map.into_iter() {
        for (idx, it) in list.into_iter().enumerate() {
            let orden = (idx as i64) + 1;

            db.execute(
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
                    Value::Integer(id_trab),
                    Value::Integer(weekday),
                    Value::Integer(orden),
                    Value::Integer(it.id_turno),
                    Value::Text(it.area),
                    clean_opt_string(it.hora_inicio)
                        .map(Value::Text)
                        .unwrap_or(Value::Null),
                    clean_opt_string(it.hora_fin)
                        .map(Value::Text)
                        .unwrap_or(Value::Null),
                    clean_opt_string(it.notas)
                        .map(Value::Text)
                        .unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(true)
}

/* =========================================================
   READS
========================================================= */

#[tauri::command]
pub async fn trabajadores_get_roles(state: State<'_, AppState>) -> Result<Vec<RolRow>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
      SELECT ID_Rol, Nombre_Rol
      FROM Roles
      ORDER BY Nombre_Rol ASC;
    "#;

    let mut rows = db.query(sql, ()).await.map_err(|e| e.to_string())?;
    let mut out: Vec<RolRow> = vec![];

    while let Ok(Some(row)) = rows.next().await {
        out.push(RolRow {
            id_rol: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            nombre_rol: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn trabajadores_get_all(
    state: State<'_, AppState>,
) -> Result<Vec<TrabajadorRow>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
      SELECT
        t.ID_Trabajador,
        t.ID_Usuario,
        t.Telefono,
        t.Puesto,
        u.Nombre,
        u.Apellido,
        u.Email,
        u.Estado,
        r.Nombre_Rol
      FROM Trabajadores t
      JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
      JOIN Roles r ON r.ID_Rol = u.ID_Rol
      ORDER BY u.Nombre ASC;
    "#;

    let mut rows = db.query(sql, ()).await.map_err(|e| e.to_string())?;
    let mut out: Vec<TrabajadorRow> = vec![];

    while let Ok(Some(row)) = rows.next().await {
        out.push(TrabajadorRow {
            id_trabajador: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            id_usuario: v_i64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            telefono: v_string(row.get_value(2).map_err(|e| e.to_string())?),
            puesto: v_string(row.get_value(3).map_err(|e| e.to_string())?),
            nombre: v_string(row.get_value(4).map_err(|e| e.to_string())?).unwrap_or_default(),
            apellido: v_string(row.get_value(5).map_err(|e| e.to_string())?),
            email: v_string(row.get_value(6).map_err(|e| e.to_string())?).unwrap_or_default(),
            estado: v_string(row.get_value(7).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "Activo".into()),
            nombre_rol: v_string(row.get_value(8).map_err(|e| e.to_string())?).unwrap_or_default(),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn trabajadores_get_detail(
    state: State<'_, AppState>,
    args: TrabajadorDetailArgs,
) -> Result<Option<TrabajadorDetailRow>, String> {
    let db = get_db(&state).await?;

    if args.id_trabajador <= 0 {
        return Err("id_trabajador required".into());
    }

    let mut rows = db
        .query(
            r#"
            SELECT
              t.ID_Trabajador,
              t.ID_Usuario,
              u.ID_Rol,
              u.Email,
              u.Nombre,
              u.Apellido,
              u.Estado,
              t.DNI,
              t.Telefono,
              t.Puesto,
              t.IBAN,
              t.Numero_Seguridad_Social,
              t.Fecha_Inicio_Contrato,
              t.Fecha_Fin_Contrato
            FROM Trabajadores t
            JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
            WHERE t.ID_Trabajador = ?1
            LIMIT 1;
            "#,
            vec![Value::Integer(args.id_trabajador)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    Ok(Some(TrabajadorDetailRow {
        id_trabajador: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
        id_usuario: v_i64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
        id_rol: v_i64(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0),
        email: v_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_default(),
        nombre: v_string(row.get_value(4).map_err(|e| e.to_string())?).unwrap_or_default(),
        apellido: v_string(row.get_value(5).map_err(|e| e.to_string())?),
        estado: v_string(row.get_value(6).map_err(|e| e.to_string())?)
            .unwrap_or_else(|| "Activo".into()),
        dni: v_string(row.get_value(7).map_err(|e| e.to_string())?),
        telefono: v_string(row.get_value(8).map_err(|e| e.to_string())?),
        puesto: v_string(row.get_value(9).map_err(|e| e.to_string())?),
        iban: v_string(row.get_value(10).map_err(|e| e.to_string())?),
        numero_seguridad_social: v_string(row.get_value(11).map_err(|e| e.to_string())?),
        fecha_inicio_contrato: v_string(row.get_value(12).map_err(|e| e.to_string())?),
        fecha_fin_contrato: v_string(row.get_value(13).map_err(|e| e.to_string())?),
    }))
}

#[tauri::command]
pub async fn trabajadores_get_trabajador_id_by_usuario(
    state: State<'_, AppState>,
    args: TrabajadorIdByUsuarioArgs,
) -> Result<Option<i64>, String> {
    let db = get_db(&state).await?;

    if args.id_usuario <= 0 {
        return Ok(None);
    }

    let mut rows = db
        .query(
            r#"
            SELECT ID_Trabajador
            FROM Trabajadores
            WHERE ID_Usuario = ?1
            LIMIT 1;
            "#,
            vec![Value::Integer(args.id_usuario)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    let id_trab = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);

    if id_trab > 0 {
        Ok(Some(id_trab))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn turnos_get_all(state: State<'_, AppState>) -> Result<Vec<TurnoRow>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
      SELECT ID_Turno, Nombre_Turno
      FROM Turnos
      ORDER BY
        CASE WHEN Nombre_Turno='LIBRE' THEN 0 ELSE 1 END,
        Nombre_Turno ASC;
    "#;

    let mut rows = db.query(sql, ()).await.map_err(|e| e.to_string())?;
    let mut out: Vec<TurnoRow> = vec![];

    while let Ok(Some(row)) = rows.next().await {
        out.push(TurnoRow {
            id_turno: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            nombre_turno: v_string(row.get_value(1).map_err(|e| e.to_string())?)
                .unwrap_or_default(),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn horarios_get_asignaciones_semana(
    state: State<'_, AppState>,
    args: HorariosSemanaArgs,
) -> Result<Vec<AsignacionRow>, String> {
    let db = get_db(&state).await?;
    let fecha_lunes = normalize_required(&args.fecha_lunes, "fecha_lunes")?;

    let sql = r#"
      SELECT
        a.ID_Asignacion,
        a.ID_Trabajador,
        a.Fecha,
        a.ID_Turno,
        a.Area,
        a.Hora_Inicio,
        a.Hora_Fin,
        a.Notas,
        t.Nombre_Turno
      FROM Asignacion_Turnos a
      JOIN Turnos t ON t.ID_Turno = a.ID_Turno
      WHERE a.Fecha >= date(?1)
        AND a.Fecha < date(?1, '+7 day')
      ORDER BY a.Fecha ASC, a.ID_Trabajador ASC, a.Hora_Inicio ASC;
    "#;

    let mut rows = db
        .query(sql, vec![Value::Text(fecha_lunes.clone())])
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<AsignacionRow> = vec![];

    while let Ok(Some(row)) = rows.next().await {
        out.push(AsignacionRow {
            id_asignacion: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            id_trabajador: v_i64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            fecha: v_string(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default(),
            id_turno: v_i64(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0),
            area: v_string(row.get_value(4).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "Sala".into()),
            hora_inicio: v_string(row.get_value(5).map_err(|e| e.to_string())?),
            hora_fin: v_string(row.get_value(6).map_err(|e| e.to_string())?),
            notas: v_string(row.get_value(7).map_err(|e| e.to_string())?),
            nombre_turno: v_string(row.get_value(8).map_err(|e| e.to_string())?)
                .unwrap_or_default(),
        });
    }

    let req_monday = NaiveDate::parse_from_str(&fecha_lunes, "%Y-%m-%d")
        .map_err(|_| "fecha_lunes invalida (esperado YYYY-MM-DD)".to_string())?;

    let today = Local::now().date_naive();
    let weekday_today = today.weekday().number_from_monday() as i64;
    let current_monday = today - Duration::days((weekday_today - 1) as i64);

    let should_fill_defaults = req_monday >= current_monday;

    if should_fill_defaults {
        let mut real_cells: HashSet<(i64, String)> = HashSet::new();

        for a in out.iter() {
            real_cells.insert((a.id_trabajador, a.fecha.clone()));
        }

        let mut drows = db
            .query(
                r#"
                SELECT
                  h.ID_Trabajador,
                  h.Weekday,
                  h.Orden,
                  h.ID_Turno,
                  h.Area,
                  h.Hora_Inicio,
                  h.Hora_Fin,
                  h.Notas,
                  t.Nombre_Turno
                FROM Horario_Predeterminado h
                JOIN Turnos t ON t.ID_Turno = h.ID_Turno
                ORDER BY h.ID_Trabajador, h.Weekday, h.Orden;
                "#,
                (),
            )
            .await
            .map_err(|e| e.to_string())?;

        #[derive(Clone)]
        struct DefItem {
            id_turno: i64,
            area: String,
            hora_inicio: Option<String>,
            hora_fin: Option<String>,
            notas: Option<String>,
            nombre_turno: String,
        }

        let mut defs: BTreeMap<(i64, i64), Vec<DefItem>> = BTreeMap::new();

        while let Ok(Some(r)) = drows.next().await {
            let id_trab = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
            let weekday = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);

            let id_turno = v_i64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0);
            let area = v_string(r.get_value(4).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "Sala".into());
            let hora_inicio = v_string(r.get_value(5).map_err(|e| e.to_string())?);
            let hora_fin = v_string(r.get_value(6).map_err(|e| e.to_string())?);
            let notas = v_string(r.get_value(7).map_err(|e| e.to_string())?);
            let nombre_turno =
                v_string(r.get_value(8).map_err(|e| e.to_string())?).unwrap_or_default();

            if id_trab <= 0 || weekday < 1 || weekday > 7 || id_turno <= 0 {
                continue;
            }

            defs.entry((id_trab, weekday)).or_default().push(DefItem {
                id_turno,
                area,
                hora_inicio,
                hora_fin,
                notas,
                nombre_turno,
            });
        }

        for day_offset in 0..7 {
            let date = req_monday + Duration::days(day_offset);
            let ymd = date.format("%Y-%m-%d").to_string();
            let wd = (day_offset + 1) as i64;

            for ((id_trab, weekday), list) in defs.iter() {
                if *weekday != wd {
                    continue;
                }

                if real_cells.contains(&(*id_trab, ymd.clone())) {
                    continue;
                }

                for it in list.iter() {
                    out.push(AsignacionRow {
                        id_asignacion: 0,
                        id_trabajador: *id_trab,
                        fecha: ymd.clone(),
                        id_turno: it.id_turno,
                        area: it.area.clone(),
                        hora_inicio: it.hora_inicio.clone(),
                        hora_fin: it.hora_fin.clone(),
                        notas: it.notas.clone(),
                        nombre_turno: it.nombre_turno.clone(),
                    });
                }
            }
        }

        out.sort_by(|a, b| {
            a.fecha
                .cmp(&b.fecha)
                .then(a.id_trabajador.cmp(&b.id_trabajador))
                .then(hhmm_opt(&a.hora_inicio).cmp(&hhmm_opt(&b.hora_inicio)))
        });
    }

    Ok(out)
}

/* =========================================================
   WRITES CON OUTBOX
========================================================= */

#[tauri::command]
pub async fn horarios_create_asignacion(
    state: State<'_, AppState>,
    args: AsignacionCreateArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_create_args(args)?;

    let command_name = "horarios.createAsignacion";
    let domain_args = create_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        apply_create_asignacion_core(&db, &n).await?;

        maybe_insert_outbox(&db, n.enqueue_outbox, &n.op_id, command_name, &payload_json).await?;

        let result = true;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn horarios_update_asignacion(
    state: State<'_, AppState>,
    args: AsignacionUpdateArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_update_args(args)?;

    let command_name = "horarios.updateAsignacion";
    let domain_args = update_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        let result = apply_update_asignacion_core(&db, &n, false).await?;

        maybe_insert_outbox(&db, n.enqueue_outbox, &n.op_id, command_name, &payload_json).await?;

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn horarios_delete_asignacion(
    state: State<'_, AppState>,
    args: AsignacionDeleteArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_delete_args(args)?;

    let command_name = "horarios.deleteAsignacion";
    let domain_args = delete_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        let result = apply_delete_asignacion_core(&db, n.id_asignacion, false).await?;

        maybe_insert_outbox(&db, n.enqueue_outbox, &n.op_id, command_name, &payload_json).await?;

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn horarios_copy_semana_asignaciones(
    state: State<'_, AppState>,
    args: CopySemanaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_copy_args(args)?;

    let command_name = "horarios.copySemanaAsignaciones";
    let domain_args = copy_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        let result = apply_copy_semana_core(&db, &n).await?;

        if result {
            maybe_insert_outbox(&db, n.enqueue_outbox, &n.op_id, command_name, &payload_json)
                .await?;
        }

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn horarios_set_predeterminado_desde_semana(
    state: State<'_, AppState>,
    args: SetPredeterminadoDesdeSemanaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_set_pred_args(args)?;

    let command_name = "horarios.setPredeterminadoDesdeSemana";
    let domain_args = set_pred_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        let map = collect_predeterminado_map(&db, &n.fecha_lunes).await?;
        let result = apply_predeterminado_map_core(&db, map).await?;

        if result {
            maybe_insert_outbox(&db, n.enqueue_outbox, &n.op_id, command_name, &payload_json)
                .await?;
        }

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

/* =========================================================
   WRITES SIN OUTBOX
   Para afterRemoteOk y futura nube -> local
========================================================= */

#[tauri::command]
pub async fn horarios_create_asignacion_after_remote_ok(
    state: State<'_, AppState>,
    args: AsignacionCreateArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_create_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "horarios.createAsignacion";
    let domain_args = create_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        apply_create_asignacion_core(&db, &n).await?;

        let result = true;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn horarios_update_asignacion_after_remote_ok(
    state: State<'_, AppState>,
    args: AsignacionUpdateArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_update_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "horarios.updateAsignacion";
    let domain_args = update_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        let result = apply_update_asignacion_core(&db, &n, true).await?;

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn horarios_delete_asignacion_after_remote_ok(
    state: State<'_, AppState>,
    args: AsignacionDeleteArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_delete_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "horarios.deleteAsignacion";
    let domain_args = delete_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        let result = apply_delete_asignacion_core(&db, n.id_asignacion, true).await?;

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn horarios_copy_semana_asignaciones_after_remote_ok(
    state: State<'_, AppState>,
    args: CopySemanaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_copy_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "horarios.copySemanaAsignaciones";
    let domain_args = copy_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        let result = apply_copy_semana_core(&db, &n).await?;

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn horarios_set_predeterminado_desde_semana_after_remote_ok(
    state: State<'_, AppState>,
    args: SetPredeterminadoDesdeSemanaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_set_pred_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "horarios.setPredeterminadoDesdeSemana";
    let domain_args = set_pred_domain_args(&n);
    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &n.op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<bool>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let payload_json = command_payload_json(&n.op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &n.op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &n.op_id, command_name, &request_hash).await?;

        let map = collect_predeterminado_map(&db, &n.fecha_lunes).await?;
        let result = apply_predeterminado_map_core(&db, map).await?;

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&db, &n.op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(result) => {
            commit(&db).await?;
            Ok(result)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}
