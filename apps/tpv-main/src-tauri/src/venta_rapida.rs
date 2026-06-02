use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;

use libsql::{Connection, Value};

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

fn is_get_or_create_barra_op_id(op_id: &str) -> bool {
    let op = op_id.trim().to_lowercase();

    op.starts_with("comandas_get_or_create_barra")
        || op.starts_with("comandas.get_or_create_barra")
        || op.starts_with("comandas.getorcreatebarra")
        || op.contains("get_or_create_barra")
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
   SQL helpers
========================================================= */

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

async fn exists_by_id(
    conn: &Connection,
    table: &str,
    column: &str,
    id: i64,
) -> Result<bool, String> {
    if id <= 0 {
        return Ok(false);
    }

    let sql = format!("SELECT 1 FROM {table} WHERE {column} = ?1 LIMIT 1;");

    let mut rows = conn
        .query(&sql, vec![Value::Integer(id)])
        .await
        .map_err(|e| format!("DB query error: {e}"))?;

    Ok(rows
        .next()
        .await
        .map_err(|e| format!("DB row error: {e}"))?
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

fn applied_assert_same_command(
    row: &AppliedOperationRow,
    command_name: &str,
) -> Result<(), String> {
    if row.command_name != command_name {
        return Err("applied_op_command_mismatch".into());
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

fn replay_applied_bool(
    existing: AppliedOperationRow,
    command_name: &str,
    request_hash: Option<&str>,
) -> Result<bool, String> {
    if let Some(hash) = request_hash {
        applied_assert_same_request(&existing, command_name, hash)?;
    } else {
        applied_assert_same_command(&existing, command_name)?;
    }

    match existing.status.as_str() {
        "APPLIED" => parse_result_json::<bool>(existing.result_json),
        "FAILED" => Err(existing
            .error_text
            .unwrap_or_else(|| "operation_failed".to_string())),
        _ => Err("operation_processing".into()),
    }
}

fn replay_applied_i64(
    existing: AppliedOperationRow,
    command_name: &str,
    request_hash: Option<&str>,
) -> Result<i64, String> {
    if let Some(hash) = request_hash {
        applied_assert_same_request(&existing, command_name, hash)?;
    } else {
        applied_assert_same_command(&existing, command_name)?;
    }

    match existing.status.as_str() {
        "APPLIED" => parse_result_json::<i64>(existing.result_json),
        "FAILED" => Err(existing
            .error_text
            .unwrap_or_else(|| "operation_failed".to_string())),
        _ => Err("operation_processing".into()),
    }
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
   Domain helpers
========================================================= */

async fn trabajador_id_from_usuario(
    db: &Connection,
    id_usuario: Option<i64>,
) -> Result<Option<i64>, String> {
    let Some(idu) = id_usuario.filter(|n| *n > 0) else {
        return Ok(None);
    };

    let mut rows = db
        .query(
            "SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario=?1 LIMIT 1;",
            vec![Value::Integer(idu)],
        )
        .await
        .map_err(|e| e.to_string())?;

    if let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        return Ok(v_i64(r.get_value(0).map_err(|e| e.to_string())?).filter(|n| *n > 0));
    }

    Ok(None)
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

async fn trabajador_id_from_comanda(
    db: &Connection,
    id_comanda: i64,
) -> Result<Option<i64>, String> {
    if id_comanda <= 0 {
        return Ok(None);
    }

    let mut rows = db
        .query(
            "SELECT ID_Trabajador FROM Comandas WHERE ID_Comanda=?1 LIMIT 1;",
            vec![Value::Integer(id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

    if let Some(r) = rows.next().await.map_err(|e| e.to_string())? {
        let v = r.get_value(0).map_err(|e| e.to_string())?;
        return Ok(v_i64(v).filter(|n| *n > 0));
    }

    Ok(None)
}

async fn first_zone_id(db: &Connection) -> Result<i64, String> {
    let mut rows = db
        .query(
            r#"
            SELECT ID_Zona
            FROM Zonas
            ORDER BY ID_Zona ASC
            LIMIT 1;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let Some(r) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(0);
    };

    Ok(v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0))
}

async fn ensure_default_zone_id(db: &Connection) -> Result<i64, String> {
    let existing = first_zone_id(db).await?;
    if existing > 0 {
        return Ok(existing);
    }

    let insert_full = db
        .execute(
            r#"
            INSERT INTO Zonas (Nombre_Zona, Room_Points, Updated_At)
            VALUES ('Salon', '[]', datetime('now','localtime'));
            "#,
            (),
        )
        .await;

    if insert_full.is_err() {
        db.execute(
            r#"
            INSERT INTO Zonas (Nombre_Zona)
            VALUES ('Salon');
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    let final_id = first_zone_id(db).await?;
    if final_id <= 0 {
        return Err("No se pudo crear/encontrar zona por defecto.".into());
    }

    Ok(final_id)
}

async fn find_barra_mesa_id_raw(db: &Connection) -> Result<i64, String> {
    let mut rows = db
        .query(
            r#"
            SELECT ID_Mesa
            FROM Mesas
            WHERE Numero_Mesa = 'BARRA'
            LIMIT 1;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let id_mesa_barra: i64 = match rows.next().await.map_err(|e| e.to_string())? {
        Some(r) => match r.get_value(0).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            Value::Real(n) => n as i64,
            Value::Text(s) => s.parse::<i64>().unwrap_or(0),
            _ => 0,
        },
        None => 0,
    };

    Ok(id_mesa_barra)
}

async fn ensure_barra_mesa_id(db: &Connection) -> Result<i64, String> {
    let existing = find_barra_mesa_id_raw(db).await?;
    if existing > 0 {
        return Ok(existing);
    }

    let id_zona = ensure_default_zone_id(db).await?;

    let insert_with_es_sistema = db
        .execute(
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
            vec![Value::Integer(id_zona)],
        )
        .await;

    if insert_with_es_sistema.is_err() {
        db.execute(
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
              Updated_At
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
              datetime('now','localtime')
            );
            "#,
            vec![Value::Integer(id_zona)],
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    let final_id = find_barra_mesa_id_raw(db).await?;
    if final_id <= 0 {
        return Err("No se pudo crear/encontrar la mesa BARRA.".into());
    }

    Ok(final_id)
}

async fn find_barra_mesa_id(db: &Connection) -> Result<i64, String> {
    ensure_barra_mesa_id(db).await
}

async fn find_open_barra_comanda_id(db: &Connection, id_mesa_barra: i64) -> Result<i64, String> {
    if id_mesa_barra <= 0 {
        return Ok(0);
    }

    let mut rows = db
        .query(
            r#"
            SELECT ID_Comanda
            FROM Comandas
            WHERE ID_Mesa = ?1
              AND Estado = 'Abierta'
            ORDER BY ID_Comanda DESC
            LIMIT 1;
            "#,
            vec![Value::Integer(id_mesa_barra)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let Some(r) = rows.next().await.map_err(|e| e.to_string())? else {
        return Ok(0);
    };

    Ok(v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0))
}

fn clamp_pending_sql(expr: &str) -> String {
    format!("CASE WHEN ({e}) < 0 THEN 0 ELSE ({e}) END", e = expr)
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
   Tipos FRONT
========================================================= */

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct CategoriaRow {
    pub ID_Categoria: i64,
    pub Nombre: String,
    pub Nombre_Imagen: Option<String>,
    pub Ruta_Imagen: Option<String>,
    pub Vendible: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct ProductoRow {
    pub ID_Producto: i64,
    pub ID_Categoria: i64,
    pub Nombre: String,
    pub Precio_Venta: f64,
    pub Stock_Actual: f64,
    pub Stock_Minimo: f64,
    pub Unidad_Medida: Option<String>,
    pub Nombre_Imagen: Option<String>,
    pub Ruta_Imagen: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct ComandaBarraRow {
    pub ID_Comanda: i64,
    pub Fecha_Hora_Apertura: String,
    pub Estado: String,
    pub Total_Pendiente: f64,
    pub Total_Comanda: f64,
    pub Pendientes_Cocina: i64,
    pub Pendientes_Pago: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct LineaComandaRow {
    pub ID_Detalle: i64,
    pub ID_Comanda: i64,
    pub ID_Producto: i64,
    pub Cantidad: f64,
    pub Precio_Unitario: f64,
    pub Notas: Option<String>,
    pub Estado_Cocina: Option<String>,
    pub Pagado: i64,
    pub Nombre: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct VerTicketsDetalleRow {
    pub ID_Detalle: i64,
    pub ID_Producto: i64,
    pub Nombre: String,
    pub Cantidad: f64,
    pub Precio_Unitario: f64,
    pub Estado_Cocina: String,
    pub Pagado: i64,
    pub Notas: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct IndexRow {
    pub ID_Comanda: i64,
    pub Productos: Option<String>,
    pub NumLineas: i64,
    pub Unidades: f64,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ArgsListComandas {
    pub include_pagadas: bool,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VrCreateComandaBarraArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_comanda: Option<i64>,

    #[serde(default)]
    pub id_trabajador: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VrAddLineaComandaArgs {
    pub op_id: String,
    pub id_comanda: i64,
    pub id_producto: i64,
    pub cantidad: f64,
    pub precio_unitario: f64,

    #[serde(default)]
    pub id_detalle: Option<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VrRemoveLastUnpaidLineaArgs {
    pub op_id: String,
    pub id_comanda: i64,
    pub id_producto: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VrDeleteLineaIfUnpaidArgs {
    pub op_id: String,
    pub id_comanda: i64,
    pub id_detalle: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VrUpdateNotaDetalleArgs {
    pub op_id: String,
    pub id_detalle: i64,

    #[serde(default)]
    pub nota: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CobrarFraccionadoArgs {
    pub op_id: String,
    pub id_comanda: i64,

    #[serde(default)]
    pub id_pago: Option<i64>,

    pub metodo: String,
    pub importe_total: f64,

    #[serde(default)]
    pub id_usuario_cobrador: Option<i64>,

    #[serde(default)]
    pub id_trabajador_cobrador: Option<i64>,

    pub detalles: Vec<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StockLinea {
    pub producto_id: i64,
    pub cantidad: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VrRestarStockArgs {
    pub op_id: String,
    pub lineas: Vec<StockLinea>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VrDeleteComandaIfSafeArgs {
    pub op_id: String,
    pub id_comanda: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   READS
========================================================= */

#[tauri::command]
pub async fn vr_list_categorias_vendibles(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaRow>, String> {
    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT
              ID_Categoria,
              Nombre,
              Nombre_Imagen,
              Ruta_Imagen,
              Vendible
            FROM Categorias_Producto
            WHERE COALESCE(Vendible,1)=1
            ORDER BY Nombre ASC;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();

    while let Ok(Some(r)) = rows.next().await {
        out.push(CategoriaRow {
            ID_Categoria: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            Nombre: v_string(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            Nombre_Imagen: match r.get_value(2).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            Ruta_Imagen: match r.get_value(3).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            Vendible: match r.get_value(4).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_i64(v),
            },
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn vr_list_productos_by_categoria(
    state: State<'_, AppState>,
    id_categoria: i64,
) -> Result<Vec<ProductoRow>, String> {
    if id_categoria <= 0 {
        return Ok(vec![]);
    }

    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT
              p.ID_Producto,
              p.ID_Categoria,
              p.Nombre,
              COALESCE(p.Precio_Venta,0) AS Precio_Venta,
              COALESCE(v.Stock_Actual,0) AS Stock_Actual,
              COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
              p.Unidad_Medida,
              p.Nombre_Imagen,
              p.Ruta_Imagen
            FROM Productos p
            JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
            LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
            WHERE p.ID_Categoria = ?1
              AND COALESCE(c.Vendible,1)=1
            ORDER BY p.Nombre ASC;
            "#,
            vec![Value::Integer(id_categoria)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();

    while let Ok(Some(r)) = rows.next().await {
        out.push(ProductoRow {
            ID_Producto: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            ID_Categoria: v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            Nombre: v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default(),
            Precio_Venta: v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Stock_Actual: v_f64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Stock_Minimo: v_f64(r.get_value(5).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Unidad_Medida: match r.get_value(6).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            Nombre_Imagen: match r.get_value(7).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            Ruta_Imagen: match r.get_value(8).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn vr_search_productos(
    state: State<'_, AppState>,
    query: String,
    limit: i64,
) -> Result<Vec<ProductoRow>, String> {
    let q = query.trim().to_string();

    if q.is_empty() {
        return Ok(vec![]);
    }

    let lim = if limit <= 0 { 60 } else { limit };
    let like = format!("%{}%", q);

    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT
              p.ID_Producto,
              p.ID_Categoria,
              p.Nombre,
              COALESCE(p.Precio_Venta,0) AS Precio_Venta,
              COALESCE(v.Stock_Actual,0) AS Stock_Actual,
              COALESCE(p.Stock_Minimo,0) AS Stock_Minimo,
              p.Unidad_Medida,
              p.Nombre_Imagen,
              p.Ruta_Imagen
            FROM Productos p
            JOIN Categorias_Producto c ON c.ID_Categoria = p.ID_Categoria
            LEFT JOIN v_inventario_producto_stock v ON v.ID_Producto = p.ID_Producto
            WHERE p.Nombre LIKE ?1
              AND COALESCE(c.Vendible,1)=1
            ORDER BY p.Nombre ASC
            LIMIT ?2;
            "#,
            vec![Value::Text(like), Value::Integer(lim)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();

    while let Ok(Some(r)) = rows.next().await {
        out.push(ProductoRow {
            ID_Producto: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            ID_Categoria: v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            Nombre: v_string(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default(),
            Precio_Venta: v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Stock_Actual: v_f64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Stock_Minimo: v_f64(r.get_value(5).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Unidad_Medida: match r.get_value(6).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            Nombre_Imagen: match r.get_value(7).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            Ruta_Imagen: match r.get_value(8).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn vr_list_comandas_barra(
    state: State<'_, AppState>,
    args: ArgsListComandas,
) -> Result<Vec<ComandaBarraRow>, String> {
    let lim = args.limit.unwrap_or(60).clamp(1, 200);

    let pending_expr = clamp_pending_sql(
        "COALESCE(c.Total_Comanda,0) - COALESCE((SELECT SUM(p.Importe_Total) FROM Pagos p WHERE p.ID_Comanda = c.ID_Comanda), 0)",
    );

    let where_clause = if args.include_pagadas {
        "EXISTS (SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda)".to_string()
    } else {
        format!(
            "({}) > 0 AND EXISTS (SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda)",
            pending_expr
        )
    };

    let sql = format!(
        r#"
        SELECT
          c.ID_Comanda,
          c.Fecha_Hora_Apertura,
          c.Estado,

          ROUND({pending_expr}, 2) AS Total_Pendiente,
          ROUND(COALESCE(c.Total_Comanda,0), 2) AS Total_Comanda,

          COALESCE((
            SELECT COUNT(*)
            FROM Detalle_Comanda dc
            LEFT JOIN Productos pr ON pr.ID_Producto = dc.ID_Producto
            LEFT JOIN Categorias_Producto cat ON cat.ID_Categoria = pr.ID_Categoria
            WHERE dc.ID_Comanda = c.ID_Comanda
              AND COALESCE(cat.Pasa_Cocina,0)=1
              AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
          ),0) AS Pendientes_Cocina,

          COALESCE((
            SELECT COUNT(*)
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = c.ID_Comanda
              AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
          ),0) AS Pendientes_Pago

        FROM Comandas c
        WHERE c.ID_Mesa = ?2
          AND ({where_clause})
        ORDER BY c.ID_Comanda DESC
        LIMIT ?1;
        "#,
        pending_expr = pending_expr,
        where_clause = where_clause
    );

    let db = get_db(&state).await?;
    let id_mesa_barra = ensure_barra_mesa_id(&db).await?;

    let mut rows = db
        .query(&sql, vec![Value::Integer(lim), Value::Integer(id_mesa_barra)])
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();

    while let Ok(Some(r)) = rows.next().await {
        out.push(ComandaBarraRow {
            ID_Comanda: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            Fecha_Hora_Apertura: v_string(r.get_value(1).map_err(|e| e.to_string())?)
                .unwrap_or_default(),
            Estado: v_string(r.get_value(2).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "Abierta".into()),
            Total_Pendiente: v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Total_Comanda: v_f64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Pendientes_Cocina: v_i64(r.get_value(5).map_err(|e| e.to_string())?).unwrap_or(0),
            Pendientes_Pago: v_i64(r.get_value(6).map_err(|e| e.to_string())?).unwrap_or(0),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn vr_get_lineas_comanda(
    state: State<'_, AppState>,
    id_comanda: i64,
) -> Result<Vec<LineaComandaRow>, String> {
    if id_comanda <= 0 {
        return Ok(vec![]);
    }

    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT
              dc.ID_Detalle,
              dc.ID_Comanda,
              dc.ID_Producto,
              COALESCE(dc.Cantidad,1) AS Cantidad,
              COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
              dc.Notas,
              dc.Estado_Cocina,
              CASE WHEN EXISTS (
                SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
              ) THEN 1 ELSE 0 END AS Pagado,
              COALESCE(p.Nombre, 'Producto') AS Nombre
            FROM Detalle_Comanda dc
            LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
            WHERE dc.ID_Comanda = ?1
            ORDER BY dc.ID_Detalle ASC;
            "#,
            vec![Value::Integer(id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();

    while let Ok(Some(r)) = rows.next().await {
        out.push(LineaComandaRow {
            ID_Detalle: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            ID_Comanda: v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            ID_Producto: v_i64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0),
            Cantidad: v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(1.0),
            Precio_Unitario: v_f64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Notas: match r.get_value(5).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            Estado_Cocina: match r.get_value(6).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            Pagado: v_i64(r.get_value(7).map_err(|e| e.to_string())?).unwrap_or(0),
            Nombre: v_string(r.get_value(8).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "Producto".into()),
        });
    }

    Ok(out)
}

/* =========================================================
   WRITES
========================================================= */

#[tauri::command]
pub async fn vr_create_comanda_barra(
    state: State<'_, AppState>,
    args: VrCreateComandaBarraArgs,
) -> Result<i64, String> {
    let db = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let command_name = "vr.createComandaBarra";

    let is_get_or_create = is_get_or_create_barra_op_id(&op_id);
    let forced_id_comanda = args.id_comanda.filter(|n| *n > 0);

    let id_mesa_barra = ensure_barra_mesa_id(&db).await?;

    if is_get_or_create && forced_id_comanda.is_none() {
        let existing_open = find_open_barra_comanda_id(&db, id_mesa_barra).await?;
        if existing_open > 0 {
            return Ok(existing_open);
        }
    }

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        if existing.status == "APPLIED" {
            let id = parse_result_json::<i64>(existing.result_json.clone())?;
            let id_trabajador_input = args.id_trabajador.filter(|n| *n > 0);

            let domain_args = json!({
                "id_comanda": args.id_comanda.filter(|n| *n > 0).unwrap_or(id),
                "id_trabajador": id_trabajador_input
            });

            let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);
            return Ok(replay_applied_i64(
                existing,
                command_name,
                Some(&request_hash),
            )?);
        }

        return replay_applied_i64(existing, command_name, None);
    }

    let id_trabajador_input = args.id_trabajador.filter(|n| *n > 0);
    let id_trabajador_real = resolve_trabajador_id_input(&db, id_trabajador_input).await?;

    let id_comanda_final = match forced_id_comanda {
        Some(id) if id > 0 => id,
        _ => next_table_id(&db, "Comandas", "ID_Comanda").await?,
    };

    let domain_args = json!({
        "id_comanda": id_comanda_final,
        "id_trabajador": id_trabajador_input
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);
    let payload_json = command_payload_json(&op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(id_comanda_final);
    }

    begin(&db).await?;

    let res: Result<i64, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
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
                Value::Integer(id_comanda_final),
                id_trabajador_real
                    .map(Value::Integer)
                    .unwrap_or(Value::Null),
                Value::Integer(id_mesa_barra),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        db.execute(
            r#"
            DELETE FROM Comandas
            WHERE ID_Mesa = ?1
              AND ID_Comanda <> ?2
              AND COALESCE(Total_Comanda,0) <= 0
              AND NOT EXISTS (
                SELECT 1 FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = Comandas.ID_Comanda
              )
              AND NOT EXISTS (
                SELECT 1 FROM Pagos p
                WHERE p.ID_Comanda = Comandas.ID_Comanda
              );
            "#,
            vec![
                Value::Integer(id_mesa_barra),
                Value::Integer(id_comanda_final),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = id_comanda_final;
        let result_json = serialize_result_json(&result)?;
        applied_mark_applied(&db, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match res {
        Ok(id) => {
            commit(&db).await?;
            Ok(id)
        }
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn vr_add_linea_comanda(
    state: State<'_, AppState>,
    args: VrAddLineaComandaArgs,
) -> Result<i64, String> {
    let db = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let command_name = "vr.addLineaComanda";

    if args.id_comanda <= 0
        || args.id_producto <= 0
        || !args.cantidad.is_finite()
        || args.cantidad <= 0.0
    {
        return Err("id_comanda/id_producto/cantidad invalid".into());
    }

    if !args.precio_unitario.is_finite() {
        return Err("precio_unitario invalid".into());
    }

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        let request_hash = if let Some(id_detalle) = args.id_detalle.filter(|n| *n > 0) {
            let domain_args = json!({
                "id_detalle": id_detalle,
                "id_comanda": args.id_comanda,
                "id_producto": args.id_producto,
                "cantidad": args.cantidad,
                "precio_unitario": args.precio_unitario
            });

            Some(sha256_hex_str(&stable_json_string(&domain_args)?))
        } else {
            None
        };

        return replay_applied_i64(existing, command_name, request_hash.as_deref());
    }

    let id_detalle_final = match args.id_detalle {
        Some(id) if id > 0 => id,
        _ => next_table_id(&db, "Detalle_Comanda", "ID_Detalle").await?,
    };

    let domain_args = json!({
        "id_detalle": id_detalle_final,
        "id_comanda": args.id_comanda,
        "id_producto": args.id_producto,
        "cantidad": args.cantidad,
        "precio_unitario": args.precio_unitario
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);
    let payload_json = command_payload_json(&op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(id_detalle_final);
    }

    begin(&db).await?;

    let res: Result<i64, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            INSERT INTO Detalle_Comanda
              (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, Notas, Estado_Cocina)
            VALUES
              (?1, ?2, ?3, ?4, ?5, NULL, 'PENDIENTE')
            ON CONFLICT(ID_Detalle) DO UPDATE SET
              ID_Comanda = excluded.ID_Comanda,
              ID_Producto = excluded.ID_Producto,
              Cantidad = excluded.Cantidad,
              Precio_Unitario = excluded.Precio_Unitario,
              Estado_Cocina = COALESCE(Detalle_Comanda.Estado_Cocina, excluded.Estado_Cocina);
            "#,
            vec![
                Value::Integer(id_detalle_final),
                Value::Integer(args.id_comanda),
                Value::Integer(args.id_producto),
                Value::Real(args.cantidad),
                Value::Real(args.precio_unitario),
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

        let result = id_detalle_final;
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
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn vr_remove_last_unpaid_linea(
    state: State<'_, AppState>,
    args: VrRemoveLastUnpaidLineaArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let command_name = "vr.removeLastUnpaidLinea";

    if args.id_comanda <= 0 || args.id_producto <= 0 {
        return Err("id_comanda/id_producto invalid".into());
    }

    let domain_args = json!({
        "id_comanda": args.id_comanda,
        "id_producto": args.id_producto
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        return replay_applied_bool(existing, command_name, Some(&request_hash));
    }

    let payload_json = command_payload_json(&op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
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

        let result = true;
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
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn vr_delete_linea_if_unpaid(
    state: State<'_, AppState>,
    args: VrDeleteLineaIfUnpaidArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let command_name = "vr.deleteLineaIfUnpaid";

    if args.id_comanda <= 0 || args.id_detalle <= 0 {
        return Err("id_comanda/id_detalle invalid".into());
    }

    let domain_args = json!({
        "id_comanda": args.id_comanda,
        "id_detalle": args.id_detalle
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        return replay_applied_bool(existing, command_name, Some(&request_hash));
    }

    let payload_json = command_payload_json(&op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            DELETE FROM Detalle_Comanda
            WHERE ID_Detalle = ?1
              AND ID_Comanda = ?2
              AND NOT EXISTS (
                SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = ?1
              );
            "#,
            vec![
                Value::Integer(args.id_detalle),
                Value::Integer(args.id_comanda),
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

        let result = true;
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
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn vr_update_nota_detalle(
    state: State<'_, AppState>,
    args: VrUpdateNotaDetalleArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let command_name = "vr.updateNotaDetalle";

    if args.id_detalle <= 0 {
        return Err("id_detalle invalid".into());
    }

    let nota = clean_opt_string(args.nota);

    let domain_args = json!({
        "id_detalle": args.id_detalle,
        "nota": nota
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        return replay_applied_bool(existing, command_name, Some(&request_hash));
    }

    let payload_json = command_payload_json(&op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let affected = db
            .execute(
                r#"
                UPDATE Detalle_Comanda
                SET Notas = ?2
                WHERE ID_Detalle = ?1;
                "#,
                vec![
                    Value::Integer(args.id_detalle),
                    nota.clone().map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;

        if affected == 0 {
            return Err("Detalle no encontrado".into());
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
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
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn vr_cobrar_fraccionado(
    state: State<'_, AppState>,
    args: CobrarFraccionadoArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let command_name = "vr.cobrarFraccionado";

    if args.id_comanda <= 0 {
        return Err("id_comanda invalid".into());
    }

    if !args.importe_total.is_finite() || args.importe_total < 0.0 {
        return Err("importe_total invalid".into());
    }

    let metodo = if args.metodo.trim().eq_ignore_ascii_case("tarjeta") {
        "Tarjeta".to_string()
    } else {
        "Efectivo".to_string()
    };

    let mut detalles: Vec<i64> = args.detalles.iter().copied().filter(|d| *d > 0).collect();
    detalles.sort_unstable();
    detalles.dedup();

    if detalles.is_empty() {
        return Err("detalles required".into());
    }

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        let request_hash = if let Some(id_pago) = args.id_pago.filter(|n| *n > 0) {
            let id_usuario = args.id_usuario_cobrador.filter(|n| *n > 0);
            let id_trabajador_from_user = trabajador_id_from_usuario(&db, id_usuario).await?;
            let id_trabajador_comanda = trabajador_id_from_comanda(&db, args.id_comanda).await?;

            let id_trabajador_cobrador = args
                .id_trabajador_cobrador
                .filter(|n| *n > 0)
                .or(id_trabajador_from_user)
                .or(id_trabajador_comanda);

            let domain_args = json!({
                "id_pago": id_pago,
                "id_comanda": args.id_comanda,
                "metodo": &metodo,
                "importe_total": args.importe_total,
                "id_usuario_cobrador": id_usuario,
                "id_trabajador_cobrador": id_trabajador_cobrador,
                "detalles": &detalles
            });

            Some(sha256_hex_str(&stable_json_string(&domain_args)?))
        } else {
            None
        };

        return replay_applied_bool(existing, command_name, request_hash.as_deref());
    }

    let id_pago_final = match args.id_pago {
        Some(id) if id > 0 => id,
        _ => next_table_id(&db, "Pagos", "ID_Pago").await?,
    };

    if !enqueue_outbox
        && args.id_pago.unwrap_or(0) > 0
        && exists_by_id(&db, "Pagos", "ID_Pago", id_pago_final).await?
    {
        return Ok(true);
    }

    let id_usuario = args.id_usuario_cobrador.filter(|n| *n > 0);
    let id_trabajador_from_user = trabajador_id_from_usuario(&db, id_usuario).await?;
    let id_trabajador_comanda = trabajador_id_from_comanda(&db, args.id_comanda).await?;

    let id_trabajador_cobrador = args
        .id_trabajador_cobrador
        .filter(|n| *n > 0)
        .or(id_trabajador_from_user)
        .or(id_trabajador_comanda);

    let domain_args = json!({
        "id_pago": id_pago_final,
        "id_comanda": args.id_comanda,
        "metodo": &metodo,
        "importe_total": args.importe_total,
        "id_usuario_cobrador": id_usuario,
        "id_trabajador_cobrador": id_trabajador_cobrador,
        "detalles": &detalles
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);
    let payload_json = command_payload_json(&op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        if let Some(idt) = id_trabajador_cobrador {
            db.execute(
                r#"
                UPDATE Comandas
                SET ID_Trabajador = ?2
                WHERE ID_Comanda = ?1
                  AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0);
                "#,
                vec![Value::Integer(args.id_comanda), Value::Integer(idt)],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        let placeholders = detalles.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            r#"
            SELECT
              IFNULL(SUM(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)), 0) AS Importe,
              COUNT(*) AS NumValid
            FROM Detalle_Comanda dc
            WHERE dc.ID_Comanda = ?1
              AND dc.ID_Detalle IN ({})
              AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle);
            "#,
            placeholders
        );

        let mut params: Vec<Value> = Vec::with_capacity(1 + detalles.len());
        params.push(Value::Integer(args.id_comanda));

        for d in &detalles {
            params.push(Value::Integer(*d));
        }

        let mut rows = db.query(&sql, params).await.map_err(|e| e.to_string())?;
        let (importe_total_db, num_valid) = match rows.next().await.map_err(|e| e.to_string())? {
            Some(r) => {
                let imp = v_f64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0.0);
                let n = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);
                (imp, n)
            }
            None => (0.0, 0),
        };

        if num_valid <= 0 {
            return Err("No hay detalles válidos pendientes de pago".into());
        }

        /*
          VR-01/VR-05: el descuento de stock y la trazabilidad FEFO van en la
          MISMA transacción que el cobro. Capturamos aquí (antes de insertar
          Pago_Detalles) los detalles a cobrar con su producto y cantidad, para
          poder validar stock y luego escribir Lote_Consumos por ID_Detalle.
        */
        let mut charged: Vec<(i64, i64, f64)> = Vec::new();
        {
            let mut crows = db
                .query(
                    &format!(
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
                        placeholders
                    ),
                    {
                        let mut p: Vec<Value> = Vec::with_capacity(1 + detalles.len());
                        p.push(Value::Integer(args.id_comanda));
                        for d in &detalles {
                            p.push(Value::Integer(*d));
                        }
                        p
                    },
                )
                .await
                .map_err(|e| e.to_string())?;

            while let Some(r) = crows.next().await.map_err(|e| e.to_string())? {
                let id_det = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
                let id_prod = v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0);
                let qty = v_f64(r.get_value(2).map_err(|e| e.to_string())?).unwrap_or(0.0);

                if id_det > 0 && id_prod > 0 && qty > 0.0 {
                    charged.push((id_det, id_prod, qty));
                }
            }
        }

        /*
          Validación de suficiencia (todo-o-nada). Un producto controla stock si
          tiene alguna fila en Lotes_Producto. Para esos, la suma de lo solicitado
          no puede superar el stock disponible total; si lo supera, abortamos el
          cobro completo (rollback) y no se escribe nada.
        */
        {
            let mut requested_by_product: std::collections::BTreeMap<i64, f64> =
                std::collections::BTreeMap::new();

            for (_d, p, q) in &charged {
                *requested_by_product.entry(*p).or_insert(0.0) += *q;
            }

            for (producto_id, requested) in &requested_by_product {
                let mut rows = db
                    .query(
                        r#"
                        SELECT
                          COUNT(*),
                          COALESCE(SUM(CAST(COALESCE(Stock_Disponible,0) AS REAL)), 0)
                        FROM Lotes_Producto
                        WHERE ID_Producto = ?1;
                        "#,
                        vec![Value::Integer(*producto_id)],
                    )
                    .await
                    .map_err(|e| e.to_string())?;

                let (n_lots, available) = match rows.next().await.map_err(|e| e.to_string())? {
                    Some(r) => {
                        let n = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
                        let a = v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);
                        (n, a)
                    }
                    None => (0, 0.0),
                };

                if n_lots > 0 && *requested > available {
                    return Err(format!(
                        "insufficient_stock:{}:{}:{}",
                        producto_id, requested, available
                    ));
                }
            }
        }

        db.execute(
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
                Value::Integer(id_pago_final),
                Value::Integer(args.id_comanda),
                Value::Text(metodo.clone()),
                Value::Real(importe_total_db),
                id_usuario.map(Value::Integer).unwrap_or(Value::Null),
                id_trabajador_cobrador
                    .map(Value::Integer)
                    .unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        for det in &detalles {
            db.execute(
                r#"
                INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
                SELECT ?1, dc.ID_Detalle
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?2
                  AND dc.ID_Detalle = ?3
                  AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle);
                "#,
                vec![
                    Value::Integer(id_pago_final),
                    Value::Integer(args.id_comanda),
                    Value::Integer(*det),
                ],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        /*
          Consumo de stock FEFO + trazabilidad. La suficiencia ya quedó validada
          arriba (todo-o-nada), así que aquí siempre cabe. Para cada detalle a
          cobrar consumimos de los lotes en orden FEFO (caducidad, fecha de
          entrada, ID de lote), decrementamos Stock_Disponible e insertamos
          Lote_Consumos(ID_Detalle, ID_Lote, Cantidad). Los productos sin lotes
          (no inventariados) se ignoran.
        */
        for (id_detalle, producto_id, cantidad) in &charged {
            let lot_rows: Vec<(i64, f64)> = {
                let mut lots = db
                    .query(
                        r#"
                        SELECT ID_Lote, COALESCE(Stock_Disponible,0)
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
                    .map_err(|e| e.to_string())?;

                let mut out: Vec<(i64, f64)> = Vec::new();

                while let Some(r) = lots.next().await.map_err(|e| e.to_string())? {
                    let id_lote = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
                    let stock = v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);

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

                db.execute(
                    r#"
                    UPDATE Lotes_Producto
                    SET Stock_Disponible = COALESCE(Stock_Disponible,0) - ?2
                    WHERE ID_Lote = ?1;
                    "#,
                    vec![Value::Integer(id_lote), Value::Real(take)],
                )
                .await
                .map_err(|e| e.to_string())?;

                db.execute(
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
                .await
                .map_err(|e| e.to_string())?;

                remaining -= take;
            }
        }

        db.execute(update_total_comanda_sql(), vec![Value::Integer(args.id_comanda)])
            .await
            .map_err(|e| e.to_string())?;

        let mut left = db
            .query(
                r#"
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                WHERE dc.ID_Comanda = ?1
                  AND pd.ID_Detalle IS NULL;
                "#,
                vec![Value::Integer(args.id_comanda)],
            )
            .await
            .map_err(|e| e.to_string())?;

        let pending_left = match left.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

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
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
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
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn vr_restar_stock(
    state: State<'_, AppState>,
    args: VrRestarStockArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let command_name = "vr.restarStock";

    let mut norm_lineas: Vec<StockLinea> = args
        .lineas
        .into_iter()
        .filter(|it| it.producto_id > 0 && it.cantidad.is_finite() && it.cantidad > 0.0)
        .collect();

    norm_lineas.sort_by(|a, b| a.producto_id.cmp(&b.producto_id));

    let mut merged: Vec<StockLinea> = Vec::new();

    for item in norm_lineas {
        if let Some(last) = merged.last_mut() {
            if last.producto_id == item.producto_id {
                last.cantidad += item.cantidad;
                continue;
            }
        }

        merged.push(item);
    }

    if merged.is_empty() {
        return Ok(true);
    }

    let domain_args = json!({
        "lineas": &merged
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        return replay_applied_bool(existing, command_name, Some(&request_hash));
    }

    let payload_json = command_payload_json(&op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        /*
          Endurecido (VR-01/VR-05): valida suficiencia antes de descontar y no
          permite consumo parcial silencioso. Un producto controla stock si tiene
          lotes; si lo solicitado supera el disponible total, aborta (rollback) y
          devuelve insufficient_stock. Este endpoint no recibe ID_Detalle, así que
          NO escribe Lote_Consumos (la trazabilidad de VR vive en el cobro).
        */
        for it in merged.iter() {
            let mut rows = db
                .query(
                    r#"
                    SELECT
                      COUNT(*),
                      COALESCE(SUM(CAST(COALESCE(Stock_Disponible,0) AS REAL)), 0)
                    FROM Lotes_Producto
                    WHERE ID_Producto = ?1;
                    "#,
                    vec![Value::Integer(it.producto_id)],
                )
                .await
                .map_err(|e| e.to_string())?;

            let (n_lots, available) = match rows.next().await.map_err(|e| e.to_string())? {
                Some(r) => {
                    let n = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
                    let a = v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);
                    (n, a)
                }
                None => (0, 0.0),
            };

            if n_lots > 0 && it.cantidad > available {
                return Err(format!(
                    "insufficient_stock:{}:{}:{}",
                    it.producto_id, it.cantidad, available
                ));
            }
        }

        for it in merged.iter() {
            let mut remaining = it.cantidad;

            let mut lots = db
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
                    vec![Value::Integer(it.producto_id)],
                )
                .await
                .map_err(|e| e.to_string())?;

            while remaining > 0.0 {
                let row = lots.next().await.map_err(|e| e.to_string())?;
                let Some(r) = row else { break };

                let id_lote = v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
                let stock = v_f64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0.0);

                if id_lote <= 0 || stock <= 0.0 {
                    continue;
                }

                let take = if remaining < stock { remaining } else { stock };

                db.execute(
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
                .await
                .map_err(|e| e.to_string())?;

                remaining -= take;
            }
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
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
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn vr_delete_comanda_if_safe(
    state: State<'_, AppState>,
    args: VrDeleteComandaIfSafeArgs,
) -> Result<bool, String> {
    let db = get_db(&state).await?;

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);
    let command_name = "vr.deleteComandaIfSafe";

    if args.id_comanda <= 0 {
        return Err("id_comanda invalid".into());
    }

    let domain_args = json!({
        "id_comanda": args.id_comanda
    });

    let request_hash = sha256_hex_str(&stable_json_string(&domain_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        return replay_applied_bool(existing, command_name, Some(&request_hash));
    }

    let payload_json = command_payload_json(&op_id, command_name, &domain_args)?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&db).await?;

    let res: Result<bool, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        let mut rows = db
            .query(
                r#"
                SELECT EXISTS(
                  SELECT 1
                  FROM Detalle_Comanda dc
                  JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                  WHERE dc.ID_Comanda = ?1
                ) AS HasPaid;
                "#,
                vec![Value::Integer(args.id_comanda)],
            )
            .await
            .map_err(|e| e.to_string())?;

        let has_paid: i64 = match rows.next().await.map_err(|e| e.to_string())? {
            Some(r) => v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            None => 0,
        };

        if has_paid == 1 {
            return Err("La comanda tiene líneas pagadas y no se puede borrar".into());
        }

        db.execute(
            r#"
            DELETE FROM Detalle_Comanda
            WHERE ID_Comanda = ?1;
            "#,
            vec![Value::Integer(args.id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

        let changed = db
            .execute(
                r#"
                DELETE FROM Comandas
                WHERE ID_Comanda = ?1;
                "#,
                vec![Value::Integer(args.id_comanda)],
            )
            .await
            .map_err(|e| e.to_string())?;

        if changed == 0 {
            return Err("Comanda no encontrada".into());
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
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
        Err(err) => {
            rollback(&db).await;
            Err(err)
        }
    }
}

/* =========================================================
   ENDPOINTS VerTicketsModal
========================================================= */

#[tauri::command]
pub async fn vr_get_index_rows(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<Vec<IndexRow>, String> {
    let ids: Vec<i64> = ids.into_iter().filter(|n| *n > 0).collect();

    if ids.is_empty() {
        return Ok(vec![]);
    }

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let params: Vec<Value> = ids.into_iter().map(Value::Integer).collect();

    let sql = format!(
        r#"
        SELECT
          x.ID_Comanda AS ID_Comanda,

          (
            SELECT GROUP_CONCAT(nn.Nombre, ' · ')
            FROM (
              SELECT DISTINCT COALESCE(p2.Nombre,'') AS Nombre
              FROM Detalle_Comanda dc2
              LEFT JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
              WHERE dc2.ID_Comanda = x.ID_Comanda
              ORDER BY COALESCE(p2.Nombre,'')
            ) nn
            WHERE nn.Nombre <> ''
          ) AS Productos,

          x.NumLineas AS NumLineas,
          x.Unidades AS Unidades
        FROM (
          SELECT
            dc.ID_Comanda AS ID_Comanda,
            COUNT(*) AS NumLineas,
            COALESCE(SUM(COALESCE(dc.Cantidad,1)),0) AS Unidades
          FROM Detalle_Comanda dc
          WHERE dc.ID_Comanda IN ({})
          GROUP BY dc.ID_Comanda
        ) x;
        "#,
        placeholders
    );

    let db = get_db(&state).await?;
    let mut rows = db.query(&sql, params).await.map_err(|e| e.to_string())?;

    let mut out = Vec::new();

    while let Ok(Some(r)) = rows.next().await {
        let id_comanda = match r.get_value(0).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            _ => 0,
        };

        let productos = match r.get_value(1).map_err(|e| e.to_string())? {
            Value::Null => None,
            Value::Text(s) => {
                let t = s.trim().to_string();

                if t.is_empty() {
                    None
                } else {
                    Some(t)
                }
            }
            _ => None,
        };

        let num_lineas = match r.get_value(2).map_err(|e| e.to_string())? {
            Value::Integer(n) => n,
            Value::Real(n) => n as i64,
            _ => 0,
        };

        let unidades = match r.get_value(3).map_err(|e| e.to_string())? {
            Value::Real(n) => n,
            Value::Integer(n) => n as f64,
            _ => 0.0,
        };

        out.push(IndexRow {
            ID_Comanda: id_comanda,
            Productos: productos,
            NumLineas: num_lineas,
            Unidades: unidades,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn vr_get_detalles_ver_ticket(
    state: State<'_, AppState>,
    id_comanda: i64,
) -> Result<Vec<VerTicketsDetalleRow>, String> {
    if id_comanda <= 0 {
        return Ok(vec![]);
    }

    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT
              dc.ID_Detalle,
              dc.ID_Producto,
              COALESCE(p.Nombre,'Producto') AS Nombre,
              COALESCE(dc.Cantidad,1) AS Cantidad,
              COALESCE(dc.Precio_Unitario,0) AS Precio_Unitario,
              COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
              CASE WHEN EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                   THEN 1 ELSE 0 END AS Pagado,
              dc.Notas
            FROM Detalle_Comanda dc
            LEFT JOIN Productos p ON p.ID_Producto = dc.ID_Producto
            WHERE dc.ID_Comanda = ?1
            ORDER BY dc.ID_Detalle ASC;
            "#,
            vec![Value::Integer(id_comanda)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();

    while let Ok(Some(r)) = rows.next().await {
        out.push(VerTicketsDetalleRow {
            ID_Detalle: v_i64(r.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            ID_Producto: v_i64(r.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
            Nombre: v_string(r.get_value(2).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "Producto".into()),
            Cantidad: v_f64(r.get_value(3).map_err(|e| e.to_string())?).unwrap_or(1.0),
            Precio_Unitario: v_f64(r.get_value(4).map_err(|e| e.to_string())?).unwrap_or(0.0),
            Estado_Cocina: v_string(r.get_value(5).map_err(|e| e.to_string())?)
                .unwrap_or_else(|| "PENDIENTE".into()),
            Pagado: v_i64(r.get_value(6).map_err(|e| e.to_string())?).unwrap_or(0),
            Notas: match r.get_value(7).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
        });
    }

    Ok(out)
}
