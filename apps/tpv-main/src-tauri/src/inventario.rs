// src-tauri/src/inventario.rs
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
   Tipos lectura
========================================================= */

#[derive(Debug, Serialize)]
pub struct CategoriaRow {
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Nombre_Imagen")]
    pub nombre_imagen: Option<String>,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
    #[serde(rename = "Vendible")]
    pub vendible: Option<i64>,
    #[serde(rename = "Pasa_Cocina")]
    pub pasa_cocina: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ProveedorMiniRow {
    #[serde(rename = "ID_Proveedor")]
    pub id_proveedor: i64,
    #[serde(rename = "Nombre_Empresa")]
    pub nombre_empresa: String,
    #[serde(rename = "Email")]
    pub email: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProductoRow {
    #[serde(rename = "ID_Producto")]
    pub id_producto: i64,
    #[serde(rename = "ID_Categoria")]
    pub id_categoria: i64,
    #[serde(rename = "ID_Proveedor")]
    pub id_proveedor: Option<i64>,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Precio_Venta")]
    pub precio_venta: Option<f64>,
    #[serde(rename = "Stock_Minimo")]
    pub stock_minimo: Option<f64>,
    #[serde(rename = "Unidad_Medida")]
    pub unidad_medida: Option<String>,
    #[serde(rename = "Nombre_Imagen")]
    pub nombre_imagen: Option<String>,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
    #[serde(rename = "Cantidad_Pedido_Esperada")]
    pub cantidad_pedido_esperada: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct ProductoListRow {
    #[serde(flatten)]
    pub base: ProductoRow,
    #[serde(rename = "Stock_Actual")]
    pub stock_actual: Option<f64>,
    #[serde(rename = "Caducidad_Proxima")]
    pub caducidad_proxima: Option<String>,
    #[serde(rename = "Lote_Proximo")]
    pub lote_proximo: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProductoResumenRow {
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Stock_Actual")]
    pub stock_actual: Option<f64>,
    #[serde(rename = "Unidad_Medida")]
    pub unidad_medida: Option<String>,
    #[serde(rename = "Caducidad_Proxima")]
    pub caducidad_proxima: Option<String>,
    #[serde(rename = "Lote")]
    pub lote: Option<String>,
    #[serde(rename = "Precio_Venta")]
    pub precio_venta: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct AlergenoRow {
    #[serde(rename = "ID_Alergeno")]
    pub id_alergeno: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Nombre_Imagen")]
    pub nombre_imagen: Option<String>,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AlergenoMini {
    #[serde(rename = "ID_Alergeno")]
    pub id_alergeno: i64,
    #[serde(rename = "Nombre")]
    pub nombre: String,
    #[serde(rename = "Ruta_Imagen")]
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProductoDetalleRow {
    #[serde(flatten)]
    pub producto: ProductoRow,
    #[serde(rename = "alergs")]
    pub alergs: Vec<AlergenoMini>,
}

#[derive(Debug, Serialize)]
pub struct ProductDetailResponse {
    #[serde(rename = "producto")]
    pub producto: Option<ProductoRow>,
    #[serde(rename = "alergenos")]
    pub alergenos: Vec<AlergenoRow>,
}

#[derive(Debug, Serialize)]
pub struct LoteRow {
    #[serde(rename = "ID_Lote")]
    pub id_lote: i64,
    #[serde(rename = "ID_Producto")]
    pub id_producto: i64,
    #[serde(rename = "Codigo_Lote")]
    pub codigo_lote: String,
    #[serde(rename = "Fecha_Entrada")]
    pub fecha_entrada: String,
    #[serde(rename = "Caducidad")]
    pub caducidad: Option<String>,
    #[serde(rename = "Cantidad_Inicial")]
    pub cantidad_inicial: f64,
    #[serde(rename = "Stock_Disponible")]
    pub stock_disponible: f64,
    #[serde(rename = "Coste_Unitario")]
    pub coste_unitario: Option<f64>,
    #[serde(rename = "ID_Proveedor")]
    pub id_proveedor: Option<i64>,
    #[serde(rename = "Notas")]
    pub notas: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InventarioResumenResponse {
    #[serde(rename = "proximosCaducar")]
    pub proximos_caducar: Vec<ProductoResumenRow>,
    #[serde(rename = "menosCantidad")]
    pub menos_cantidad: Vec<ProductoResumenRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertProductoResult {
    pub id_producto: i64,
}

/* =========================================================
   Args lectura
========================================================= */

#[derive(Debug, Deserialize)]
pub struct IdCategoriaArgs {
    pub id_categoria: i64,
}

#[derive(Debug, Deserialize)]
pub struct IdProductoArgs {
    pub id_producto: i64,
}

#[derive(Debug, Deserialize)]
pub struct SummaryArgs {
    #[serde(default)]
    pub limit: Option<i64>,
}

/* =========================================================
   Args write offline-capable
========================================================= */

#[derive(Debug, Deserialize, Serialize)]
pub struct DeleteProductoArgs {
    pub op_id: String,
    pub id_producto: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SetProductoAlergenosArgs {
    pub op_id: String,
    pub id_producto: i64,
    pub ids_alergenos: Vec<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct UpsertCategoriaArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_categoria: Option<i64>,

    pub nombre: String,
    pub nombre_imagen: String,
    pub ruta_imagen: String,
    pub vendible: bool,
    pub pasa_cocina: bool,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct UpsertProductoArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_producto: Option<i64>,

    pub id_categoria: i64,

    #[serde(default)]
    pub id_proveedor: Option<i64>,

    pub nombre: String,

    #[serde(default)]
    pub precio_venta: Option<f64>,

    #[serde(default)]
    pub stock_minimo: Option<f64>,

    #[serde(default)]
    pub unidad_medida: Option<String>,

    #[serde(default)]
    pub nombre_imagen: Option<String>,

    #[serde(default)]
    pub ruta_imagen: Option<String>,

    #[serde(default)]
    pub cantidad_pedido_esperada: Option<f64>,

    #[serde(default)]
    pub ids_alergenos: Vec<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CreateLoteArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_lote: Option<i64>,

    pub id_producto: i64,
    pub codigo_lote: String,

    #[serde(default)]
    pub caducidad: Option<String>,

    pub cantidad_inicial: f64,

    #[serde(default)]
    pub stock_disponible: Option<f64>,

    #[serde(default)]
    pub fecha_entrada: Option<String>,

    #[serde(default)]
    pub coste_unitario: Option<f64>,

    #[serde(default)]
    pub id_proveedor: Option<i64>,

    #[serde(default)]
    pub notas: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct AjusteLoteArgs {
    pub op_id: String,
    pub id_lote: i64,
    pub stock_disponible: f64,

    #[serde(default)]
    pub notas: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   Builders internos
========================================================= */

fn row_to_producto_base(row: &libsql::Row) -> Result<ProductoRow, String> {
    Ok(ProductoRow {
        id_producto: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
        id_categoria: v_i64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
        id_proveedor: match row.get_value(2).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_i64(v),
        },
        nombre: v_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_default(),
        precio_venta: match row.get_value(4).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_f64(v),
        },
        stock_minimo: match row.get_value(5).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_f64(v),
        },
        unidad_medida: match row.get_value(6).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        nombre_imagen: match row.get_value(7).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        ruta_imagen: match row.get_value(8).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        cantidad_pedido_esperada: match row.get_value(9).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_f64(v),
        },
    })
}

fn row_to_producto_list(row: &libsql::Row) -> Result<ProductoListRow, String> {
    let base = ProductoRow {
        id_producto: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
        id_categoria: v_i64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
        id_proveedor: match row.get_value(2).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_i64(v),
        },
        nombre: v_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_default(),
        precio_venta: match row.get_value(4).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_f64(v),
        },
        stock_minimo: match row.get_value(6).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_f64(v),
        },
        unidad_medida: match row.get_value(7).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        nombre_imagen: match row.get_value(8).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        ruta_imagen: match row.get_value(9).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        cantidad_pedido_esperada: match row.get_value(12).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_f64(v),
        },
    };

    Ok(ProductoListRow {
        base,
        stock_actual: match row.get_value(5).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_f64(v),
        },
        caducidad_proxima: match row.get_value(10).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        lote_proximo: match row.get_value(11).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
    })
}

fn row_to_lote(row: &libsql::Row) -> Result<LoteRow, String> {
    Ok(LoteRow {
        id_lote: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
        id_producto: v_i64(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or(0),
        codigo_lote: v_string(row.get_value(2).map_err(|e| e.to_string())?).unwrap_or_default(),
        fecha_entrada: v_string(row.get_value(3).map_err(|e| e.to_string())?).unwrap_or_default(),
        caducidad: match row.get_value(4).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
        cantidad_inicial: v_f64(row.get_value(5).map_err(|e| e.to_string())?).unwrap_or(0.0),
        stock_disponible: v_f64(row.get_value(6).map_err(|e| e.to_string())?).unwrap_or(0.0),
        coste_unitario: match row.get_value(7).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_f64(v),
        },
        id_proveedor: match row.get_value(8).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_i64(v),
        },
        notas: match row.get_value(9).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        },
    })
}

async fn fetch_producto_by_id(
    db: &Connection,
    id_producto: i64,
) -> Result<Option<ProductoRow>, String> {
    let sql = r#"
      SELECT
        ID_Producto,
        ID_Categoria,
        ID_Proveedor,
        Nombre,
        Precio_Venta,
        Stock_Minimo,
        Unidad_Medida,
        Nombre_Imagen,
        Ruta_Imagen,
        Cantidad_Pedido_Esperada
      FROM Productos
      WHERE ID_Producto=?1
      LIMIT 1;
    "#;

    let mut rows = db
        .query(sql, vec![Value::Integer(id_producto)])
        .await
        .map_err(|e| e.to_string())?;

    if let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        Ok(Some(row_to_producto_base(&row)?))
    } else {
        Ok(None)
    }
}

/* =========================================================
   1) Categorías
========================================================= */

#[tauri::command]
pub async fn inventario_list_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaRow>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
      SELECT
        ID_Categoria,
        Nombre,
        Nombre_Imagen,
        Ruta_Imagen,
        Vendible,
        Pasa_Cocina
      FROM Categorias_Producto
      ORDER BY Nombre ASC;
    "#;

    let mut rows = db.query(sql, ()).await.map_err(|e| e.to_string())?;
    let mut out: Vec<CategoriaRow> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let id_categoria = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let nombre = v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();

        let nombre_imagen = match row.get_value(2).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        };

        let ruta_imagen = match row.get_value(3).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        };

        let vendible = match row.get_value(4).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_i64(v),
        };

        let pasa_cocina = match row.get_value(5).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_i64(v),
        };

        out.push(CategoriaRow {
            id_categoria,
            nombre,
            nombre_imagen,
            ruta_imagen,
            vendible,
            pasa_cocina,
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn inventario_create_categoria(
    state: State<'_, AppState>,
    args: UpsertCategoriaArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = "inventario.createCategoria";

    let requested_id_categoria = args.id_categoria.filter(|id| *id > 0);

    let nombre = normalize_required(&args.nombre, "nombre")?;
    let nombre_imagen = args.nombre_imagen.trim().to_string();
    let ruta_imagen = args.ruta_imagen.trim().to_string();

    let hash_args = json!({
        "id_categoria": requested_id_categoria,
        "nombre": nombre.clone(),
        "nombre_imagen": nombre_imagen.clone(),
        "ruta_imagen": ruta_imagen.clone(),
        "vendible": args.vendible,
        "pasa_cocina": args.pasa_cocina
    });

    let request_hash = sha256_hex_str(&stable_json_string(&hash_args)?);

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

    let id_categoria = match requested_id_categoria {
        Some(id) => id,
        None => next_table_id(&db, "Categorias_Producto", "ID_Categoria").await?,
    };

    let domain_args = json!({
        "id_categoria": id_categoria,
        "nombre": nombre.clone(),
        "nombre_imagen": nombre_imagen.clone(),
        "ruta_imagen": ruta_imagen.clone(),
        "vendible": args.vendible,
        "pasa_cocina": args.pasa_cocina
    });

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
            INSERT INTO Categorias_Producto
              (ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible, Pasa_Cocina)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(ID_Categoria) DO UPDATE SET
              Nombre = excluded.Nombre,
              Nombre_Imagen = excluded.Nombre_Imagen,
              Ruta_Imagen = excluded.Ruta_Imagen,
              Vendible = excluded.Vendible,
              Pasa_Cocina = excluded.Pasa_Cocina;
            "#,
            vec![
                Value::Integer(id_categoria),
                Value::Text(nombre),
                Value::Text(nombre_imagen),
                Value::Text(ruta_imagen),
                Value::Integer(if args.vendible { 1 } else { 0 }),
                Value::Integer(if args.pasa_cocina { 1 } else { 0 }),
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

/* =========================================================
   2) Proveedores mini
========================================================= */

#[tauri::command]
pub async fn inventario_list_proveedores_mini(
    state: State<'_, AppState>,
) -> Result<Vec<ProveedorMiniRow>, String> {
    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            "SELECT ID_Proveedor, Nombre_Empresa, Email FROM Proveedores ORDER BY Nombre_Empresa ASC;",
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let id_proveedor = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);
        let nombre_empresa =
            v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default();

        let email = match row.get_value(2).map_err(|e| e.to_string())? {
            Value::Null => None,
            v => v_string(v),
        };

        out.push(ProveedorMiniRow {
            id_proveedor,
            nombre_empresa,
            email,
        });
    }

    Ok(out)
}

/* =========================================================
   3) Productos por categoría
========================================================= */

#[tauri::command]
pub async fn inventario_list_productos_by_categoria(
    state: State<'_, AppState>,
    args: IdCategoriaArgs,
) -> Result<Vec<ProductoListRow>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
      SELECT
        p.ID_Producto,
        p.ID_Categoria,
        p.ID_Proveedor,
        p.Nombre,
        p.Precio_Venta,

        (
          SELECT COALESCE(SUM(l.Stock_Disponible), 0)
          FROM Lotes_Producto l
          WHERE l.ID_Producto = p.ID_Producto
        ) AS Stock_Actual,

        p.Stock_Minimo,
        p.Unidad_Medida,
        p.Nombre_Imagen,
        p.Ruta_Imagen,

        (
          SELECT l.Caducidad
          FROM Lotes_Producto l
          WHERE l.ID_Producto = p.ID_Producto
            AND l.Stock_Disponible > 0
            AND l.Caducidad IS NOT NULL
          ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
          LIMIT 1
        ) AS Caducidad_Proxima,

        (
          SELECT l.Codigo_Lote
          FROM Lotes_Producto l
          WHERE l.ID_Producto = p.ID_Producto
            AND l.Stock_Disponible > 0
            AND l.Caducidad IS NOT NULL
          ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
          LIMIT 1
        ) AS Lote_Proximo,

        p.Cantidad_Pedido_Esperada

      FROM Productos p
      WHERE p.ID_Categoria = ?1
      ORDER BY p.Nombre ASC;
    "#;

    let mut rows = db
        .query(sql, vec![Value::Integer(args.id_categoria)])
        .await
        .map_err(|e| e.to_string())?;

    let mut out = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(row_to_producto_list(&row)?);
    }

    Ok(out)
}

/* =========================================================
   4) Resumen inventario
========================================================= */

#[tauri::command]
pub async fn inventario_get_resumen(
    state: State<'_, AppState>,
    args: SummaryArgs,
) -> Result<InventarioResumenResponse, String> {
    let db = get_db(&state).await?;
    let limit = args.limit.unwrap_or(12);

    let mut cad_rows = db
        .query(
            r#"
            SELECT
              p.Nombre,
              l.Stock_Disponible AS Stock_Actual,
              p.Unidad_Medida,
              l.Caducidad AS Caducidad_Proxima,
              l.Codigo_Lote AS Lote,
              p.Precio_Venta
            FROM Lotes_Producto l
            JOIN Productos p ON p.ID_Producto = l.ID_Producto
            WHERE l.Stock_Disponible > 0
              AND l.Caducidad IS NOT NULL
            ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
            LIMIT ?1;
            "#,
            vec![Value::Integer(limit)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut proximos: Vec<ProductoResumenRow> = vec![];

    while let Some(row) = cad_rows.next().await.map_err(|e| e.to_string())? {
        proximos.push(ProductoResumenRow {
            nombre: v_string(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default(),
            stock_actual: match row.get_value(1).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_f64(v),
            },
            unidad_medida: match row.get_value(2).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            caducidad_proxima: match row.get_value(3).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            lote: match row.get_value(4).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            precio_venta: match row.get_value(5).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_f64(v),
            },
        });
    }

    let mut low_rows = db
        .query(
            r#"
            WITH base AS (
              SELECT
                p.ID_Producto,
                p.Nombre,
                p.Unidad_Medida,
                p.Precio_Venta,

                (
                  SELECT COALESCE(SUM(l.Stock_Disponible), 0)
                  FROM Lotes_Producto l
                  WHERE l.ID_Producto = p.ID_Producto
                ) AS Stock_Actual,

                (
                  SELECT l.Caducidad
                  FROM Lotes_Producto l
                  WHERE l.ID_Producto = p.ID_Producto
                    AND l.Stock_Disponible > 0
                    AND l.Caducidad IS NOT NULL
                  ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
                  LIMIT 1
                ) AS Caducidad_Proxima,

                (
                  SELECT l.Codigo_Lote
                  FROM Lotes_Producto l
                  WHERE l.ID_Producto = p.ID_Producto
                    AND l.Stock_Disponible > 0
                    AND l.Caducidad IS NOT NULL
                  ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
                  LIMIT 1
                ) AS Lote

              FROM Productos p
            )
            SELECT
              Nombre,
              Stock_Actual,
              Unidad_Medida,
              Caducidad_Proxima,
              Lote,
              Precio_Venta
            FROM base
            ORDER BY Stock_Actual ASC, Nombre ASC
            LIMIT ?1;
            "#,
            vec![Value::Integer(limit)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut menos: Vec<ProductoResumenRow> = vec![];

    while let Some(row) = low_rows.next().await.map_err(|e| e.to_string())? {
        menos.push(ProductoResumenRow {
            nombre: v_string(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or_default(),
            stock_actual: match row.get_value(1).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_f64(v),
            },
            unidad_medida: match row.get_value(2).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            caducidad_proxima: match row.get_value(3).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            lote: match row.get_value(4).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            precio_venta: match row.get_value(5).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_f64(v),
            },
        });
    }

    Ok(InventarioResumenResponse {
        proximos_caducar: proximos,
        menos_cantidad: menos,
    })
}

/* =========================================================
   5) Alérgenos
========================================================= */

#[tauri::command]
pub async fn inventario_list_alergenos(
    state: State<'_, AppState>,
) -> Result<Vec<AlergenoRow>, String> {
    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT ID_Alergeno, Nombre, Nombre_Imagen, Ruta_Imagen
            FROM Alergenos
            ORDER BY Nombre ASC;
            "#,
            (),
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<AlergenoRow> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(AlergenoRow {
            id_alergeno: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            nombre: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            nombre_imagen: match row.get_value(2).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            ruta_imagen: match row.get_value(3).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn inventario_get_alergenos_producto(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<Vec<i64>, String> {
    let db = get_db(&state).await?;

    let mut rows = db
        .query(
            r#"
            SELECT ID_Alergeno
            FROM Producto_Alergenos
            WHERE ID_Producto=?1
            ORDER BY ID_Alergeno ASC;
            "#,
            vec![Value::Integer(args.id_producto)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<i64> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        let id_a = v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0);

        if id_a > 0 {
            out.push(id_a);
        }
    }

    Ok(out)
}

#[tauri::command]
pub async fn inventario_set_alergenos_producto(
    state: State<'_, AppState>,
    args: SetProductoAlergenosArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = "inventario.setAlergenosProducto";

    if args.id_producto <= 0 {
        return Err("id_producto inválido".into());
    }

    let ids = normalize_ids(args.ids_alergenos);

    let domain_args = json!({
        "id_producto": args.id_producto,
        "ids_alergenos": ids.clone()
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
            "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
            vec![Value::Integer(args.id_producto)],
        )
        .await
        .map_err(|e| e.to_string())?;

        for id_a in ids {
            db.execute(
                r#"
                INSERT OR IGNORE INTO Producto_Alergenos (ID_Producto, ID_Alergeno)
                VALUES (?1, ?2);
                "#,
                vec![Value::Integer(args.id_producto), Value::Integer(id_a)],
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
   6) Producto
========================================================= */

#[tauri::command]
pub async fn inventario_get_producto(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<Option<ProductoRow>, String> {
    let db = get_db(&state).await?;

    fetch_producto_by_id(&db, args.id_producto).await
}

/* =========================================================
   7) Detalle producto + alérgenos
========================================================= */

#[tauri::command]
pub async fn inventario_get_product_detail(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<ProductDetailResponse, String> {
    let db = get_db(&state).await?;
    let producto = fetch_producto_by_id(&db, args.id_producto).await?;

    let mut arows = db
        .query(
            r#"
            SELECT a.ID_Alergeno, a.Nombre, a.Nombre_Imagen, a.Ruta_Imagen
            FROM Producto_Alergenos pa
            JOIN Alergenos a ON a.ID_Alergeno = pa.ID_Alergeno
            WHERE pa.ID_Producto = ?1
            ORDER BY a.Nombre ASC;
            "#,
            vec![Value::Integer(args.id_producto)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut alergenos: Vec<AlergenoRow> = vec![];

    while let Some(row) = arows.next().await.map_err(|e| e.to_string())? {
        alergenos.push(AlergenoRow {
            id_alergeno: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            nombre: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            nombre_imagen: match row.get_value(2).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
            ruta_imagen: match row.get_value(3).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
        });
    }

    Ok(ProductDetailResponse {
        producto,
        alergenos,
    })
}

#[tauri::command]
pub async fn inventario_get_producto_detalle(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<Option<ProductoDetalleRow>, String> {
    let db = get_db(&state).await?;

    let Some(producto) = fetch_producto_by_id(&db, args.id_producto).await? else {
        return Ok(None);
    };

    let mut rows = db
        .query(
            r#"
            SELECT a.ID_Alergeno, a.Nombre, a.Ruta_Imagen
            FROM Producto_Alergenos pa
            JOIN Alergenos a ON a.ID_Alergeno = pa.ID_Alergeno
            WHERE pa.ID_Producto=?1
            ORDER BY a.Nombre ASC;
            "#,
            vec![Value::Integer(args.id_producto)],
        )
        .await
        .map_err(|e| e.to_string())?;

    let mut alergs: Vec<AlergenoMini> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        alergs.push(AlergenoMini {
            id_alergeno: v_i64(row.get_value(0).map_err(|e| e.to_string())?).unwrap_or(0),
            nombre: v_string(row.get_value(1).map_err(|e| e.to_string())?).unwrap_or_default(),
            ruta_imagen: match row.get_value(2).map_err(|e| e.to_string())? {
                Value::Null => None,
                v => v_string(v),
            },
        });
    }

    Ok(Some(ProductoDetalleRow { producto, alergs }))
}

/* =========================================================
   8) Lotes
========================================================= */

#[tauri::command]
pub async fn inventario_list_lotes_by_producto(
    state: State<'_, AppState>,
    args: IdProductoArgs,
) -> Result<Vec<LoteRow>, String> {
    let db = get_db(&state).await?;

    let sql = r#"
      SELECT
        ID_Lote,
        ID_Producto,
        Codigo_Lote,
        Fecha_Entrada,
        Caducidad,
        Cantidad_Inicial,
        Stock_Disponible,
        Coste_Unitario,
        ID_Proveedor,
        Notas
      FROM Lotes_Producto
      WHERE ID_Producto=?1
      ORDER BY
        (Caducidad IS NULL) ASC,
        date(Caducidad) ASC,
        datetime(Fecha_Entrada) DESC,
        ID_Lote DESC;
    "#;

    let mut rows = db
        .query(sql, vec![Value::Integer(args.id_producto)])
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<LoteRow> = vec![];

    while let Some(row) = rows.next().await.map_err(|e| e.to_string())? {
        out.push(row_to_lote(&row)?);
    }

    Ok(out)
}

#[tauri::command]
pub async fn inventario_create_lote(
    state: State<'_, AppState>,
    args: CreateLoteArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = "inventario.createLote";

    let requested_id_lote = args.id_lote.filter(|id| *id > 0);

    if args.id_producto <= 0 {
        return Err("id_producto inválido".into());
    }

    let codigo_lote = normalize_required(&args.codigo_lote, "codigo_lote")?;

    if !args.cantidad_inicial.is_finite() || args.cantidad_inicial < 0.0 {
        return Err("Cantidad_Inicial inválida".into());
    }

    let stock = args.stock_disponible.unwrap_or(args.cantidad_inicial);

    if !stock.is_finite() || stock < 0.0 {
        return Err("Stock_Disponible inválido".into());
    }

    let fecha_entrada = clean_opt_string(args.fecha_entrada);
    let caducidad = clean_opt_string(args.caducidad);
    let notas = clean_opt_string(args.notas);

    let hash_args = json!({
        "id_lote": requested_id_lote,
        "id_producto": args.id_producto,
        "codigo_lote": codigo_lote.clone(),
        "caducidad": caducidad.clone(),
        "cantidad_inicial": args.cantidad_inicial,
        "stock_disponible": stock,
        "fecha_entrada": fecha_entrada.clone(),
        "coste_unitario": args.coste_unitario,
        "id_proveedor": args.id_proveedor,
        "notas": notas.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&hash_args)?);

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

    let id_lote = match requested_id_lote {
        Some(id) => id,
        None => next_table_id(&db, "Lotes_Producto", "ID_Lote").await?,
    };

    let domain_args = json!({
        "id_lote": id_lote,
        "id_producto": args.id_producto,
        "codigo_lote": codigo_lote.clone(),
        "caducidad": caducidad.clone(),
        "cantidad_inicial": args.cantidad_inicial,
        "stock_disponible": stock,
        "fecha_entrada": fecha_entrada.clone(),
        "coste_unitario": args.coste_unitario,
        "id_proveedor": args.id_proveedor,
        "notas": notas.clone()
    });

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
            INSERT INTO Lotes_Producto
              (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad,
               Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas)
            VALUES
              (?1, ?2, ?3,
               COALESCE(NULLIF(?4, ''), datetime('now','localtime')),
               NULLIF(?5, ''),
               ?6, ?7, ?8, ?9, ?10
              )
            ON CONFLICT(ID_Lote) DO UPDATE SET
              ID_Producto = excluded.ID_Producto,
              Codigo_Lote = excluded.Codigo_Lote,
              Fecha_Entrada = excluded.Fecha_Entrada,
              Caducidad = excluded.Caducidad,
              Cantidad_Inicial = excluded.Cantidad_Inicial,
              Stock_Disponible = excluded.Stock_Disponible,
              Coste_Unitario = excluded.Coste_Unitario,
              ID_Proveedor = excluded.ID_Proveedor,
              Notas = excluded.Notas;
            "#,
            vec![
                Value::Integer(id_lote),
                Value::Integer(args.id_producto),
                Value::Text(codigo_lote),
                match fecha_entrada {
                    Some(v) => Value::Text(v),
                    None => Value::Null,
                },
                match caducidad {
                    Some(v) => Value::Text(v),
                    None => Value::Null,
                },
                Value::Real(args.cantidad_inicial),
                Value::Real(stock),
                match args.coste_unitario {
                    Some(v) => Value::Real(v),
                    None => Value::Null,
                },
                match args.id_proveedor {
                    Some(v) => Value::Integer(v),
                    None => Value::Null,
                },
                match notas {
                    Some(v) => Value::Text(v),
                    None => Value::Null,
                },
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
pub async fn inventario_ajustar_lote(
    state: State<'_, AppState>,
    args: AjusteLoteArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = "inventario.ajustarLote";

    if args.id_lote <= 0 {
        return Err("id_lote inválido".into());
    }

    if !args.stock_disponible.is_finite() || args.stock_disponible < 0.0 {
        return Err("Stock_Disponible inválido".into());
    }

    let notas = clean_opt_string(args.notas);

    let domain_args = json!({
        "id_lote": args.id_lote,
        "stock_disponible": args.stock_disponible,
        "notas": notas.clone()
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
            UPDATE Lotes_Producto
            SET
              Stock_Disponible = ?1,
              Notas = COALESCE(NULLIF(?2, ''), Notas)
            WHERE ID_Lote = ?3;
            "#,
            vec![
                Value::Real(args.stock_disponible),
                match notas {
                    Some(v) => Value::Text(v),
                    None => Value::Null,
                },
                Value::Integer(args.id_lote),
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

/* =========================================================
   9) Borrar producto
========================================================= */

#[tauri::command]
pub async fn inventario_delete_producto(
    state: State<'_, AppState>,
    args: DeleteProductoArgs,
) -> Result<String, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = "inventario.deleteProducto";

    if args.id_producto <= 0 {
        return Err("id_producto inválido".into());
    }

    let domain_args = json!({
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

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<String, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            "DELETE FROM Lotes_Producto WHERE ID_Producto=?1;",
            vec![Value::Integer(args.id_producto)],
        )
        .await
        .map_err(|e| e.to_string())?;

        db.execute(
            "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
            vec![Value::Integer(args.id_producto)],
        )
        .await
        .map_err(|e| e.to_string())?;

        db.execute(
            "DELETE FROM Productos WHERE ID_Producto=?1;",
            vec![Value::Integer(args.id_producto)],
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

/* =========================================================
   10) Upsert producto + alérgenos
========================================================= */

#[tauri::command]
pub async fn inventario_upsert_producto(
    state: State<'_, AppState>,
    args: UpsertProductoArgs,
) -> Result<UpsertProductoResult, String> {
    let db = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;
    let command_name = "inventario.upsertProducto";

    let nombre = normalize_required(&args.nombre, "nombre")?;
    let unidad_medida = clean_opt_string(args.unidad_medida);
    let nombre_imagen = clean_opt_string(args.nombre_imagen);
    let ruta_imagen = clean_opt_string(args.ruta_imagen);
    let ids_alergenos = normalize_ids(args.ids_alergenos);

    if args.id_categoria <= 0 {
        return Err("id_categoria inválido".into());
    }

    let requested_id_producto = args.id_producto.filter(|id| *id > 0);

    let hash_args = json!({
        "id_producto": requested_id_producto,
        "id_categoria": args.id_categoria,
        "id_proveedor": args.id_proveedor,
        "nombre": nombre.clone(),
        "precio_venta": args.precio_venta,
        "stock_minimo": args.stock_minimo,
        "unidad_medida": unidad_medida.clone(),
        "nombre_imagen": nombre_imagen.clone(),
        "ruta_imagen": ruta_imagen.clone(),
        "cantidad_pedido_esperada": args.cantidad_pedido_esperada,
        "ids_alergenos": ids_alergenos.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&hash_args)?);

    if let Some(existing) = applied_get_by_op_id(&db, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<UpsertProductoResult>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let id_producto = match requested_id_producto {
        Some(id) => id,
        None => next_table_id(&db, "Productos", "ID_Producto").await?,
    };

    let domain_args = json!({
        "id_producto": id_producto,
        "id_categoria": args.id_categoria,
        "id_proveedor": args.id_proveedor,
        "nombre": nombre.clone(),
        "precio_venta": args.precio_venta,
        "stock_minimo": args.stock_minimo,
        "unidad_medida": unidad_medida.clone(),
        "nombre_imagen": nombre_imagen.clone(),
        "ruta_imagen": ruta_imagen.clone(),
        "cantidad_pedido_esperada": args.cantidad_pedido_esperada,
        "ids_alergenos": ids_alergenos.clone()
    });

    let payload_json = stable_json_string(&json!({
        "op_id": op_id.clone(),
        "command_name": command_name,
        "args": domain_args
    }))?;

    if outbox_assert_replay_or_unused(&db, &op_id, command_name, &payload_json).await? {
        return Ok(UpsertProductoResult { id_producto });
    }

    db.execute_batch("BEGIN;")
        .await
        .map_err(|e| e.to_string())?;

    let res: Result<UpsertProductoResult, String> = async {
        applied_insert_processing(&db, &op_id, command_name, &request_hash).await?;

        db.execute(
            r#"
            INSERT INTO Productos
              (ID_Producto, ID_Categoria, ID_Proveedor, Nombre, Precio_Venta,
               Stock_Minimo, Unidad_Medida,
               Nombre_Imagen, Ruta_Imagen,
               Cantidad_Pedido_Esperada)
            VALUES
              (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(ID_Producto) DO UPDATE SET
              ID_Categoria = excluded.ID_Categoria,
              ID_Proveedor = excluded.ID_Proveedor,
              Nombre = excluded.Nombre,
              Precio_Venta = excluded.Precio_Venta,
              Stock_Minimo = excluded.Stock_Minimo,
              Unidad_Medida = excluded.Unidad_Medida,
              Nombre_Imagen = COALESCE(excluded.Nombre_Imagen, Productos.Nombre_Imagen),
              Ruta_Imagen = COALESCE(excluded.Ruta_Imagen, Productos.Ruta_Imagen),
              Cantidad_Pedido_Esperada = excluded.Cantidad_Pedido_Esperada;
            "#,
            vec![
                Value::Integer(id_producto),
                Value::Integer(args.id_categoria),
                match args.id_proveedor {
                    Some(v) => Value::Integer(v),
                    None => Value::Null,
                },
                Value::Text(nombre.clone()),
                match args.precio_venta {
                    Some(v) => Value::Real(v),
                    None => Value::Null,
                },
                match args.stock_minimo {
                    Some(v) => Value::Real(v),
                    None => Value::Null,
                },
                match unidad_medida.clone() {
                    Some(v) => Value::Text(v),
                    None => Value::Null,
                },
                match nombre_imagen.clone() {
                    Some(v) => Value::Text(v),
                    None => Value::Null,
                },
                match ruta_imagen.clone() {
                    Some(v) => Value::Text(v),
                    None => Value::Null,
                },
                match args.cantidad_pedido_esperada {
                    Some(v) => Value::Real(v),
                    None => Value::Null,
                },
            ],
        )
        .await
        .map_err(|e| e.to_string())?;

        db.execute(
            "DELETE FROM Producto_Alergenos WHERE ID_Producto=?1;",
            vec![Value::Integer(id_producto)],
        )
        .await
        .map_err(|e| e.to_string())?;

        for id_a in ids_alergenos {
            db.execute(
                r#"
                INSERT OR IGNORE INTO Producto_Alergenos (ID_Producto, ID_Alergeno)
                VALUES (?1, ?2);
                "#,
                vec![Value::Integer(id_producto), Value::Integer(id_a)],
            )
            .await
            .map_err(|e| e.to_string())?;
        }

        maybe_insert_outbox(&db, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = UpsertProductoResult { id_producto };
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
