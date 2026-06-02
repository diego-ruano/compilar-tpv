// src-tauri/src/tareas.rs
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

fn normalize_ids(mut ids: Vec<i64>) -> Vec<i64> {
    ids.retain(|n| *n > 0);
    ids.sort_unstable();
    ids.dedup();
    ids
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

fn build_in_placeholders(start: i64, count: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start + i as i64))
        .collect::<Vec<_>>()
        .join(", ")
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
   Tipos OUTPUT
========================================================= */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrabajadorUI {
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: i64,
    #[serde(rename = "ID_Usuario")]
    pub id_usuario: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Apellido")]
    pub apellido: Option<String>,
    #[serde(rename = "Puesto")]
    pub puesto: Option<String>,
    #[serde(rename = "Email")]
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TareaAdminRow {
    #[serde(rename = "ID_Tarea")]
    pub id_tarea: i64,
    #[serde(rename = "Titulo")]
    pub titulo: String,
    #[serde(rename = "Descripcion")]
    pub descripcion: Option<String>,
    #[serde(rename = "Fecha_Creacion")]
    pub fecha_creacion: String,
    #[serde(rename = "Fecha_Limite")]
    pub fecha_limite: Option<String>,
    #[serde(rename = "Total_Asignados")]
    pub total_asignados: i64,
    #[serde(rename = "Total_Finalizadas")]
    pub total_finalizadas: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TareaRow {
    #[serde(rename = "ID_Tarea")]
    pub id_tarea: i64,
    #[serde(rename = "Titulo")]
    pub titulo: String,
    #[serde(rename = "Descripcion")]
    pub descripcion: Option<String>,
    #[serde(rename = "Fecha_Creacion")]
    pub fecha_creacion: String,
    #[serde(rename = "Fecha_Limite")]
    pub fecha_limite: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TareaAsignadoRow {
    #[serde(rename = "ID_Trabajador")]
    pub id_trabajador: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Apellido")]
    pub apellido: Option<String>,
    #[serde(rename = "Puesto")]
    pub puesto: Option<String>,
    #[serde(rename = "Asignada_At")]
    pub asignada_at: String,
    #[serde(rename = "Estado")]
    pub estado: String,
    #[serde(rename = "Finalizada_At")]
    pub finalizada_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MisTareasRow {
    #[serde(rename = "ID_Tarea")]
    pub id_tarea: i64,
    #[serde(rename = "Titulo")]
    pub titulo: String,
    #[serde(rename = "Descripcion")]
    pub descripcion: Option<String>,
    #[serde(rename = "Fecha_Limite")]
    pub fecha_limite: Option<String>,
    #[serde(rename = "Asignada_At")]
    pub asignada_at: String,
    #[serde(rename = "Estado")]
    pub estado: String,
    #[serde(rename = "Finalizada_At")]
    pub finalizada_at: Option<String>,
}

/* =========================================================
   Tipos INPUT
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct CreateTareaArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    pub titulo: String,

    #[serde(default)]
    pub descripcion: Option<String>,

    #[serde(default, alias = "fechaLimite")]
    pub fecha_limite: Option<String>,

    #[serde(default, alias = "idsTrabajadores")]
    pub ids_trabajadores: Vec<i64>,

    #[serde(
        default,
        alias = "idTarea",
        alias = "id_tarea",
        alias = "remoteIdTarea",
        alias = "remote_id_tarea"
    )]
    pub remote_id_tarea: Option<i64>,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateTareaArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "idTarea")]
    pub id_tarea: i64,

    pub titulo: String,

    #[serde(default)]
    pub descripcion: Option<String>,

    #[serde(default, alias = "fechaLimite")]
    pub fecha_limite: Option<String>,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetAsignacionesTareaArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "idTarea")]
    pub id_tarea: i64,

    #[serde(default, alias = "idsTrabajadores")]
    pub ids_trabajadores: Vec<i64>,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteTareaArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "idTarea")]
    pub id_tarea: i64,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FinalizarTareaArgs {
    #[serde(alias = "opId")]
    pub op_id: String,

    #[serde(alias = "idTarea")]
    pub id_tarea: i64,

    #[serde(alias = "idTrabajador")]
    pub id_trabajador: i64,

    #[serde(default, alias = "enqueueOutbox")]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   Normalizados internos
========================================================= */

#[derive(Debug, Clone)]
struct CreateTareaNorm {
    op_id: String,
    titulo: String,
    descripcion: Option<String>,
    fecha_limite: Option<String>,
    ids_trabajadores: Vec<i64>,
    remote_id_tarea: Option<i64>,
    enqueue_outbox: bool,
}

#[derive(Debug, Clone)]
struct UpdateTareaNorm {
    op_id: String,
    id_tarea: i64,
    titulo: String,
    descripcion: Option<String>,
    fecha_limite: Option<String>,
    enqueue_outbox: bool,
}

#[derive(Debug, Clone)]
struct SetAsignacionesNorm {
    op_id: String,
    id_tarea: i64,
    ids_trabajadores: Vec<i64>,
    enqueue_outbox: bool,
}

#[derive(Debug, Clone)]
struct DeleteTareaNorm {
    op_id: String,
    id_tarea: i64,
    enqueue_outbox: bool,
}

#[derive(Debug, Clone)]
struct FinalizarNorm {
    op_id: String,
    id_tarea: i64,
    id_trabajador: i64,
    enqueue_outbox: bool,
}

fn normalize_create_tarea_args(args: CreateTareaArgs) -> Result<CreateTareaNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;
    let titulo = normalize_required(&args.titulo, "titulo")?;
    let descripcion = clean_opt_string(args.descripcion);
    let fecha_limite = clean_opt_string(args.fecha_limite);
    let ids_trabajadores = normalize_ids(args.ids_trabajadores);

    if ids_trabajadores.is_empty() {
        return Err("ids_trabajadores required".into());
    }

    Ok(CreateTareaNorm {
        op_id,
        titulo,
        descripcion,
        fecha_limite,
        ids_trabajadores,
        remote_id_tarea: args.remote_id_tarea.filter(|n| *n > 0),
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

fn normalize_update_tarea_args(args: UpdateTareaArgs) -> Result<UpdateTareaNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_tarea <= 0 {
        return Err("id_tarea required".into());
    }

    let titulo = normalize_required(&args.titulo, "titulo")?;

    Ok(UpdateTareaNorm {
        op_id,
        id_tarea: args.id_tarea,
        titulo,
        descripcion: clean_opt_string(args.descripcion),
        fecha_limite: clean_opt_string(args.fecha_limite),
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

fn normalize_set_asignaciones_args(
    args: SetAsignacionesTareaArgs,
) -> Result<SetAsignacionesNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_tarea <= 0 {
        return Err("id_tarea required".into());
    }

    Ok(SetAsignacionesNorm {
        op_id,
        id_tarea: args.id_tarea,
        ids_trabajadores: normalize_ids(args.ids_trabajadores),
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

fn normalize_delete_tarea_args(args: DeleteTareaArgs) -> Result<DeleteTareaNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_tarea <= 0 {
        return Err("id_tarea required".into());
    }

    Ok(DeleteTareaNorm {
        op_id,
        id_tarea: args.id_tarea,
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

fn normalize_finalizar_args(args: FinalizarTareaArgs) -> Result<FinalizarNorm, String> {
    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_tarea <= 0 || args.id_trabajador <= 0 {
        return Err("id_tarea/id_trabajador required".into());
    }

    Ok(FinalizarNorm {
        op_id,
        id_tarea: args.id_tarea,
        id_trabajador: args.id_trabajador,
        enqueue_outbox: should_enqueue_outbox(args.enqueue_outbox),
    })
}

/* =========================================================
   Domain args / payload
========================================================= */

fn create_tarea_domain_args(n: &CreateTareaNorm) -> serde_json::Value {
    json!({
        "titulo": n.titulo,
        "descripcion": n.descripcion,
        "fecha_limite": n.fecha_limite,
        "ids_trabajadores": n.ids_trabajadores,
        "remote_id_tarea": n.remote_id_tarea
    })
}

fn update_tarea_domain_args(n: &UpdateTareaNorm) -> serde_json::Value {
    json!({
        "id_tarea": n.id_tarea,
        "titulo": n.titulo,
        "descripcion": n.descripcion,
        "fecha_limite": n.fecha_limite
    })
}

fn set_asignaciones_domain_args(n: &SetAsignacionesNorm) -> serde_json::Value {
    json!({
        "id_tarea": n.id_tarea,
        "ids_trabajadores": n.ids_trabajadores
    })
}

fn delete_tarea_domain_args(n: &DeleteTareaNorm) -> serde_json::Value {
    json!({
        "id_tarea": n.id_tarea
    })
}

fn finalizar_domain_args(n: &FinalizarNorm) -> serde_json::Value {
    json!({
        "id_tarea": n.id_tarea,
        "id_trabajador": n.id_trabajador
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

async fn apply_set_asignaciones_core(
    db: &Connection,
    id_tarea: i64,
    ids_trabajadores: &[i64],
) -> Result<(), String> {
    if id_tarea <= 0 {
        return Err("id_tarea required".into());
    }

    if ids_trabajadores.is_empty() {
        db.execute(
            r#"
            DELETE FROM Tarea_Asignaciones
            WHERE ID_Tarea = ?1;
            "#,
            vec![Value::Integer(id_tarea)],
        )
        .await
        .map_err(|e| e.to_string())?;
    } else {
        let placeholders = build_in_placeholders(2, ids_trabajadores.len());

        let mut sql_args: Vec<Value> = Vec::with_capacity(1 + ids_trabajadores.len());
        sql_args.push(Value::Integer(id_tarea));

        for id_trab in ids_trabajadores.iter() {
            sql_args.push(Value::Integer(*id_trab));
        }

        let sql = format!(
            r#"
            DELETE FROM Tarea_Asignaciones
            WHERE ID_Tarea = ?1
              AND ID_Trabajador NOT IN ({});
            "#,
            placeholders
        );

        db.execute(&sql, sql_args)
            .await
            .map_err(|e| e.to_string())?;
    }

    for id_trab in ids_trabajadores.iter() {
        db.execute(
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
            vec![Value::Integer(id_tarea), Value::Integer(*id_trab)],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn apply_create_tarea_core(db: &Connection, n: &CreateTareaNorm) -> Result<i64, String> {
    let id_tarea = if let Some(remote_id) = n.remote_id_tarea {
        db.execute(
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
                Value::Integer(remote_id),
                Value::Text(n.titulo.clone()),
                n.descripcion
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
                n.fecha_limite
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        remote_id
    } else {
        db.execute(
            r#"
            INSERT INTO Tareas (
              Titulo,
              Descripcion,
              Fecha_Limite
            )
            VALUES (
              ?1,
              ?2,
              ?3
            );
            "#,
            vec![
                Value::Text(n.titulo.clone()),
                n.descripcion
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
                n.fecha_limite
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        select_one_i64(db, "SELECT last_insert_rowid();", vec![])
            .await?
            .ok_or_else(|| "No se pudo obtener last_insert_rowid()".to_string())?
    };

    if id_tarea <= 0 {
        return Err("ID_Tarea inválido al crear".into());
    }

    apply_set_asignaciones_core(db, id_tarea, &n.ids_trabajadores).await?;

    Ok(id_tarea)
}

async fn apply_update_tarea_core(db: &Connection, n: &UpdateTareaNorm) -> Result<bool, String> {
    let affected = db
        .execute(
            r#"
            UPDATE Tareas
            SET
              Titulo = ?2,
              Descripcion = ?3,
              Fecha_Limite = ?4
            WHERE ID_Tarea = ?1;
            "#,
            vec![
                Value::Integer(n.id_tarea),
                Value::Text(n.titulo.clone()),
                n.descripcion
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
                n.fecha_limite
                    .clone()
                    .map(Value::Text)
                    .unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

    if affected == 0 {
        return Err("Tarea no encontrada".into());
    }

    Ok(true)
}

async fn apply_delete_tarea_core(
    db: &Connection,
    id_tarea: i64,
    missing_ok: bool,
) -> Result<bool, String> {
    db.execute(
        r#"
        DELETE FROM Tarea_Asignaciones
        WHERE ID_Tarea = ?1;
        "#,
        vec![Value::Integer(id_tarea)],
    )
    .await
    .map_err(|e| e.to_string())?;

    let affected = db
        .execute(
            r#"
            DELETE FROM Tareas
            WHERE ID_Tarea = ?1;
            "#,
            vec![Value::Integer(id_tarea)],
        )
        .await
        .map_err(|e| e.to_string())?;

    if affected == 0 && !missing_ok {
        return Err("Tarea no encontrada".into());
    }

    Ok(affected > 0 || missing_ok)
}

async fn apply_finalizar_tarea_core(
    db: &Connection,
    n: &FinalizarNorm,
    missing_ok: bool,
) -> Result<bool, String> {
    let affected = db
        .execute(
            r#"
            UPDATE Tarea_Asignaciones
            SET
              Estado = 'FINALIZADA',
              Finalizada_At = COALESCE(Finalizada_At, datetime('now','localtime'))
            WHERE ID_Tarea = ?1
              AND ID_Trabajador = ?2;
            "#,
            vec![Value::Integer(n.id_tarea), Value::Integer(n.id_trabajador)],
        )
        .await
        .map_err(|e| e.to_string())?;

    if affected == 0 && !missing_ok {
        return Err("Asignación no encontrada".into());
    }

    Ok(affected > 0 || missing_ok)
}

/* =========================================================
   COMMANDS LECTURA
========================================================= */

#[tauri::command]
pub async fn tareas_get_trabajadores(
    state: State<'_, AppState>,
) -> Result<Vec<TrabajadorUI>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
        SELECT
          t.ID_Trabajador,
          t.ID_Usuario,
          u.Nombre,
          u.Apellido,
          t.Puesto,
          u.Email
        FROM Trabajadores t
        JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
        WHERE u.Estado = 'Activo'
        ORDER BY u.Nombre ASC;
    "#;

    let mut rows = db.query(sql, ()).await.map_err(|e| e.to_string())?;
    let mut out: Vec<TrabajadorUI> = vec![];

    while let Ok(Some(row)) = rows.next().await {
        let id_trabajador = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let id_usuario = v_i64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);
        let nombre = v_string(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default();
        let apellido = v_string(row.get_value(3).map_err(|e| e.to_string())?);
        let puesto = v_string(row.get_value(4).map_err(|e| e.to_string())?);
        let email = v_string(row.get_value(5).map_err(|e| e.to_string())?).unwrap_or_default();

        out.push(TrabajadorUI {
            id_trabajador,
            id_usuario,
            nombre,
            apellido,
            puesto,
            email,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn tareas_get_tareas_admin(
    state: State<'_, AppState>,
) -> Result<Vec<TareaAdminRow>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
        SELECT
          t.ID_Tarea,
          t.Titulo,
          t.Descripcion,
          t.Fecha_Creacion,
          t.Fecha_Limite,
          (
            SELECT COUNT(*)
            FROM Tarea_Asignaciones a
            WHERE a.ID_Tarea = t.ID_Tarea
          ) AS Total_Asignados,
          (
            SELECT COUNT(*)
            FROM Tarea_Asignaciones a
            WHERE a.ID_Tarea = t.ID_Tarea
              AND a.Estado = 'FINALIZADA'
          ) AS Total_Finalizadas
        FROM Tareas t
        WHERE COALESCE(t.Estado, 'ABIERTA') = 'ABIERTA'
        ORDER BY t.ID_Tarea DESC;
    "#;

    let mut rows = db.query(sql, ()).await.map_err(|e| e.to_string())?;
    let mut out: Vec<TareaAdminRow> = vec![];

    while let Ok(Some(row)) = rows.next().await {
        out.push(TareaAdminRow {
            id_tarea: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            titulo: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            descripcion: v_string(row.get_value(2).map_err(|e| e.to_string())?),
            fecha_creacion: v_string(row.get_value(3).map_err(|e| e.to_string())?)
                .unwrap_or_default(),
            fecha_limite: v_string(row.get_value(4).map_err(|e| e.to_string())?),
            total_asignados: v_i64(row.get_value(5).map_err(|e| e.to_string())?).unwrap_or(0),
            total_finalizadas: v_i64(row.get_value(6).map_err(|e| e.to_string())?).unwrap_or(0),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn tareas_get_tarea_by_id(
    state: State<'_, AppState>,
    id_tarea: i64,
) -> Result<Option<TareaRow>, String> {
    let db = get_db(&state).await?;

    if id_tarea <= 0 {
        return Ok(None);
    }

    let mut rows = db
        .query(
            r#"
            SELECT ID_Tarea, Titulo, Descripcion, Fecha_Creacion, Fecha_Limite
            FROM Tareas
            WHERE ID_Tarea = ?1
            LIMIT 1;
            "#,
            vec![Value::Integer(id_tarea)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let Some(row) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    Ok(Some(TareaRow {
        id_tarea: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
        titulo: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
        descripcion: v_string(row.get_value(2).map_err(|e| e.to_string())?),
        fecha_creacion: v_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_default(),
        fecha_limite: v_string(row.get_value(4).map_err(|e| e.to_string())?),
    }))
}

#[tauri::command]
pub async fn tareas_get_tarea_asignados(
    state: State<'_, AppState>,
    id_tarea: i64,
) -> Result<Vec<TareaAsignadoRow>, String> {
    let db = get_db(&state).await?;

    if id_tarea <= 0 {
        return Ok(vec![]);
    }

    let sql = r#"
        SELECT
          a.ID_Trabajador,
          u.Nombre,
          u.Apellido,
          t.Puesto,
          a.Asignada_At,
          a.Estado,
          a.Finalizada_At
        FROM Tarea_Asignaciones a
        JOIN Trabajadores t ON t.ID_Trabajador = a.ID_Trabajador
        JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
        WHERE a.ID_Tarea = ?1
        ORDER BY u.Nombre ASC;
    "#;

    let mut rows = db
        .query(sql, vec![Value::Integer(id_tarea)])
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<TareaAsignadoRow> = vec![];

    while let Ok(Some(row)) = rows.next().await {
        out.push(TareaAsignadoRow {
            id_trabajador: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            nombre: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            apellido: v_string(row.get_value(2).map_err(|e| e.to_string())?),
            puesto: v_string(row.get_value(3).map_err(|e| e.to_string())?),
            asignada_at: v_string(row.get_value(4).map_err(|e| e.to_string())?).unwrap_or_default(),
            estado: v_string(row.get_value(5).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "PENDIENTE".into()),
            finalizada_at: v_string(row.get_value(6).map_err(|e| e.to_string())?),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn tareas_get_mis_tareas(
    state: State<'_, AppState>,
    id_trabajador: i64,
) -> Result<Vec<MisTareasRow>, String> {
    let db = get_db(&state).await?;

    if id_trabajador <= 0 {
        return Ok(vec![]);
    }

    let sql = r#"
        SELECT
          t.ID_Tarea,
          t.Titulo,
          t.Descripcion,
          t.Fecha_Limite,
          a.Asignada_At,
          a.Estado,
          a.Finalizada_At
        FROM Tarea_Asignaciones a
        JOIN Tareas t ON t.ID_Tarea = a.ID_Tarea
        WHERE a.ID_Trabajador = ?1
          AND COALESCE(t.Estado, 'ABIERTA') = 'ABIERTA'
          AND (
            a.Estado <> 'FINALIZADA'
            OR date(a.Finalizada_At) = date('now','localtime')
          )
        ORDER BY
          CASE WHEN a.Estado='PENDIENTE' THEN 0 ELSE 1 END,
          t.Fecha_Limite ASC,
          t.ID_Tarea DESC;
    "#;

    let mut rows = db
        .query(sql, vec![Value::Integer(id_trabajador)])
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<MisTareasRow> = vec![];

    while let Ok(Some(row)) = rows.next().await {
        out.push(MisTareasRow {
            id_tarea: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            titulo: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            descripcion: v_string(row.get_value(2).map_err(|e| e.to_string())?),
            fecha_limite: v_string(row.get_value(3).map_err(|e| e.to_string())?),
            asignada_at: v_string(row.get_value(4).map_err(|e| e.to_string())?).unwrap_or_default(),
            estado: v_string(row.get_value(5).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "PENDIENTE".into()),
            finalizada_at: v_string(row.get_value(6).map_err(|e| e.to_string())?),
        });
    }

    Ok(out)
}

/* =========================================================
   COMMANDS WRITE CON OUTBOX
========================================================= */

#[tauri::command]
pub async fn tareas_create_tarea(
    state: State<'_, AppState>,
    args: CreateTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_create_tarea_args(args)?;

    let command_name = "tareas.createTarea";
    let domain_args = create_tarea_domain_args(&n);
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

        apply_create_tarea_core(&db, &n).await?;

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
pub async fn tareas_update_tarea(
    state: State<'_, AppState>,
    args: UpdateTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_update_tarea_args(args)?;

    let command_name = "tareas.updateTarea";
    let domain_args = update_tarea_domain_args(&n);
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

        let result = apply_update_tarea_core(&db, &n).await?;

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
pub async fn tareas_set_asignaciones_tarea(
    state: State<'_, AppState>,
    args: SetAsignacionesTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_set_asignaciones_args(args)?;

    let command_name = "tareas.setAsignacionesTarea";
    let domain_args = set_asignaciones_domain_args(&n);
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

        if !exists_by_id(&db, "Tareas", "ID_Tarea", n.id_tarea).await? {
            return Err("Tarea no encontrada".into());
        }

        apply_set_asignaciones_core(&db, n.id_tarea, &n.ids_trabajadores).await?;

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
pub async fn tareas_delete_tarea(
    state: State<'_, AppState>,
    args: DeleteTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_delete_tarea_args(args)?;

    let command_name = "tareas.deleteTarea";
    let domain_args = delete_tarea_domain_args(&n);
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

        let result = apply_delete_tarea_core(&db, n.id_tarea, false).await?;

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
pub async fn tareas_marcar_tarea_finalizada(
    state: State<'_, AppState>,
    args: FinalizarTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let n = normalize_finalizar_args(args)?;

    let command_name = "tareas.marcarTareaFinalizada";
    let domain_args = finalizar_domain_args(&n);
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

        let result = apply_finalizar_tarea_core(&db, &n, false).await?;

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

/* =========================================================
   COMMANDS WRITE SIN OUTBOX
   Para afterRemoteOk y futura nube -> local
========================================================= */

#[tauri::command]
pub async fn tareas_create_tarea_after_remote_ok(
    state: State<'_, AppState>,
    args: CreateTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_create_tarea_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "tareas.createTarea";
    let domain_args = create_tarea_domain_args(&n);
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

        apply_create_tarea_core(&db, &n).await?;

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
pub async fn tareas_update_tarea_after_remote_ok(
    state: State<'_, AppState>,
    args: UpdateTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_update_tarea_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "tareas.updateTarea";
    let domain_args = update_tarea_domain_args(&n);
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

        let result = apply_update_tarea_core(&db, &n).await?;

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
pub async fn tareas_set_asignaciones_tarea_after_remote_ok(
    state: State<'_, AppState>,
    args: SetAsignacionesTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_set_asignaciones_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "tareas.setAsignacionesTarea";
    let domain_args = set_asignaciones_domain_args(&n);
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

        apply_set_asignaciones_core(&db, n.id_tarea, &n.ids_trabajadores).await?;

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
pub async fn tareas_delete_tarea_after_remote_ok(
    state: State<'_, AppState>,
    args: DeleteTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_delete_tarea_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "tareas.deleteTarea";
    let domain_args = delete_tarea_domain_args(&n);
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

        let result = apply_delete_tarea_core(&db, n.id_tarea, true).await?;

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
pub async fn tareas_marcar_tarea_finalizada_after_remote_ok(
    state: State<'_, AppState>,
    args: FinalizarTareaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;
    let mut n = normalize_finalizar_args(args)?;
    n.enqueue_outbox = false;

    let command_name = "tareas.marcarTareaFinalizada";
    let domain_args = finalizar_domain_args(&n);
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

        let result = apply_finalizar_tarea_core(&db, &n, true).await?;

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
