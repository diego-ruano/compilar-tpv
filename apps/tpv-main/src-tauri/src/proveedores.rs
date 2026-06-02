// src-tauri/src/proveedores.rs
use libsql::{Connection, Value};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{get_db, AppState};
use std::convert::TryInto;

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

fn get_i64(row: &[Value], idx: usize) -> i64 {
    row.get(idx).cloned().and_then(v_i64).unwrap_or(0)
}

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

fn opt_text(v: Option<String>) -> Value {
    match v {
        Some(s) => Value::Text(s),
        None => Value::Null,
    }
}

fn opt_real(v: Option<f64>) -> Value {
    match v {
        Some(n) => Value::Real(n),
        None => Value::Null,
    }
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
   Query helper
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
            row.get_value(0)
                .map_err(|e| format!("DB get_value(0) error: {e}"))?,
        ));
    }

    Ok(None)
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

    let v = row
        .get_value(0)
        .map_err(|e| format!("DB get_value(0) error: {e}"))?;

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
pub struct ProveedorRow {
    pub id_proveedor: i64,
    pub nombre_empresa: String,
    pub contacto: Option<String>,
    pub telefono: Option<String>,
    pub email: Option<String>,
    pub cif: Option<String>,
    pub informacion_adicional: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoriaRow {
    pub id_categoria: i64,
    pub nombre: String,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductoRow {
    pub id_producto: i64,
    pub id_categoria: Option<i64>,
    pub id_proveedor: Option<i64>,
    pub nombre: String,
    pub precio_venta: Option<f64>,
    pub stock_actual: Option<f64>,
    pub stock_minimo: Option<f64>,
    pub unidad_medida: Option<String>,
    pub nombre_imagen: Option<String>,
    pub ruta_imagen: Option<String>,

    pub cantidad_pedido_esperada: Option<f64>,
    pub ultima_entrada: Option<String>,
    pub caducidad_proxima: Option<String>,
}

/* =========================================================
   Args
========================================================= */

#[derive(Debug, Clone, Deserialize)]
pub struct ProveedoresGetProductosArgs {
    pub id_proveedor: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProveedorSaveArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_proveedor: Option<i64>,

    pub nombre_empresa: String,

    #[serde(default)]
    pub contacto: Option<String>,

    #[serde(default)]
    pub telefono: Option<String>,

    #[serde(default)]
    pub email: Option<String>,

    #[serde(default)]
    pub cif: Option<String>,

    #[serde(default)]
    pub informacion_adicional: Option<String>,

    #[serde(default)]
    pub nombre_imagen: Option<String>,

    #[serde(default)]
    pub ruta_imagen: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProveedoresDeleteArgs {
    pub op_id: String,
    pub id_proveedor: i64,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProveedoresSetVinculosArgs {
    pub op_id: String,
    pub id_proveedor: i64,
    pub producto_ids: Vec<i64>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProveedoresCreateProductoArgs {
    pub op_id: String,

    #[serde(default)]
    pub id_producto: Option<i64>,

    pub id_categoria: i64,
    pub id_proveedor: i64,
    pub nombre: String,

    #[serde(default)]
    pub precio_venta: Option<f64>,

    #[serde(default)]
    pub stock_actual: Option<f64>,

    #[serde(default)]
    pub stock_minimo: Option<f64>,

    #[serde(default)]
    pub unidad_medida: Option<String>,

    #[serde(default)]
    pub enqueue_outbox: Option<bool>,
}

/* =========================================================
   Lecturas
========================================================= */

#[tauri::command]
pub async fn proveedores_get_all(state: State<'_, AppState>) -> Result<Vec<ProveedorRow>, String> {
    let conn = get_db(&state).await?;

    let sql = r#"
      SELECT
        ID_Proveedor,
        Nombre_Empresa,
        Contacto,
        Telefono,
        Email,
        CIF,
        Informacion_adicional,
        Nombre_Imagen,
        Ruta_Imagen
      FROM Proveedores
      ORDER BY Nombre_Empresa ASC;
    "#;

    let raw = query_rows_fixed(&conn, sql, Vec::<Value>::new(), 9).await?;

    let mut out: Vec<ProveedorRow> = Vec::new();

    for r in raw {
        out.push(ProveedorRow {
            id_proveedor: get_i64(&r, 0),
            nombre_empresa: get_string(&r, 1),
            contacto: get_opt_string(&r, 2),
            telefono: get_opt_string(&r, 3),
            email: get_opt_string(&r, 4),
            cif: get_opt_string(&r, 5),
            informacion_adicional: get_opt_string(&r, 6),
            nombre_imagen: get_opt_string(&r, 7),
            ruta_imagen: get_opt_string(&r, 8),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn proveedores_get_productos(
    state: State<'_, AppState>,
    args: ProveedoresGetProductosArgs,
) -> Result<Vec<ProductoRow>, String> {
    let conn = get_db(&state).await?;

    if args.id_proveedor <= 0 {
        return Err("ID_Proveedor inválido".into());
    }

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
        p.Cantidad_Pedido_Esperada,

        (
          SELECT MAX(datetime(l.Fecha_Entrada))
          FROM Lotes_Producto l
          WHERE l.ID_Producto = p.ID_Producto
        ) AS Ultima_Entrada,

        (
          SELECT l.Caducidad
          FROM Lotes_Producto l
          WHERE l.ID_Producto = p.ID_Producto
            AND l.Stock_Disponible > 0
            AND l.Caducidad IS NOT NULL
          ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
          LIMIT 1
        ) AS Caducidad_Proxima

      FROM Productos p
      WHERE p.ID_Proveedor = ?1
      ORDER BY p.Nombre ASC;
    "#;

    let raw = query_rows_fixed(&conn, sql, vec![Value::Integer(args.id_proveedor)], 13).await?;

    let mut out: Vec<ProductoRow> = Vec::new();

    for r in raw {
        out.push(ProductoRow {
            id_producto: get_i64(&r, 0),
            id_categoria: {
                let v = get_i64(&r, 1);
                if v == 0 {
                    None
                } else {
                    Some(v)
                }
            },
            id_proveedor: {
                let v = get_i64(&r, 2);
                if v == 0 {
                    None
                } else {
                    Some(v)
                }
            },
            nombre: get_string(&r, 3),
            precio_venta: {
                let v = get_f64(&r, 4);
                if v == 0.0 {
                    None
                } else {
                    Some(v)
                }
            },
            stock_actual: Some(get_f64(&r, 5)),
            stock_minimo: {
                let v = get_f64(&r, 6);
                if v == 0.0 {
                    None
                } else {
                    Some(v)
                }
            },
            unidad_medida: get_opt_string(&r, 7),
            nombre_imagen: get_opt_string(&r, 8),
            ruta_imagen: get_opt_string(&r, 9),
            cantidad_pedido_esperada: {
                let v = get_f64(&r, 10);
                if v == 0.0 {
                    None
                } else {
                    Some(v)
                }
            },
            ultima_entrada: get_opt_string(&r, 11),
            caducidad_proxima: get_opt_string(&r, 12),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn proveedores_get_categorias(
    state: State<'_, AppState>,
) -> Result<Vec<CategoriaRow>, String> {
    let conn = get_db(&state).await?;

    let sql = r#"
      SELECT
        ID_Categoria,
        Nombre,
        Nombre_Imagen,
        Ruta_Imagen
      FROM Categorias_Producto
      ORDER BY Nombre ASC;
    "#;

    let raw = query_rows_fixed(&conn, sql, Vec::<Value>::new(), 4).await?;

    let mut out: Vec<CategoriaRow> = Vec::new();

    for r in raw {
        out.push(CategoriaRow {
            id_categoria: get_i64(&r, 0),
            nombre: get_string(&r, 1),
            nombre_imagen: get_opt_string(&r, 2),
            ruta_imagen: get_opt_string(&r, 3),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn proveedores_get_productos_all(
    state: State<'_, AppState>,
) -> Result<Vec<ProductoRow>, String> {
    let conn = get_db(&state).await?;

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
        p.Cantidad_Pedido_Esperada,

        (
          SELECT MAX(datetime(l.Fecha_Entrada))
          FROM Lotes_Producto l
          WHERE l.ID_Producto = p.ID_Producto
        ) AS Ultima_Entrada,

        (
          SELECT l.Caducidad
          FROM Lotes_Producto l
          WHERE l.ID_Producto = p.ID_Producto
            AND l.Stock_Disponible > 0
            AND l.Caducidad IS NOT NULL
          ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
          LIMIT 1
        ) AS Caducidad_Proxima

      FROM Productos p
      ORDER BY p.Nombre ASC;
    "#;

    let raw = query_rows_fixed(&conn, sql, Vec::<Value>::new(), 13).await?;

    let mut out: Vec<ProductoRow> = Vec::new();

    for r in raw {
        out.push(ProductoRow {
            id_producto: get_i64(&r, 0),
            id_categoria: {
                let v = get_i64(&r, 1);
                if v == 0 {
                    None
                } else {
                    Some(v)
                }
            },
            id_proveedor: {
                let v = get_i64(&r, 2);
                if v == 0 {
                    None
                } else {
                    Some(v)
                }
            },
            nombre: get_string(&r, 3),
            precio_venta: {
                let v = get_f64(&r, 4);
                if v == 0.0 {
                    None
                } else {
                    Some(v)
                }
            },
            stock_actual: Some(get_f64(&r, 5)),
            stock_minimo: {
                let v = get_f64(&r, 6);
                if v == 0.0 {
                    None
                } else {
                    Some(v)
                }
            },
            unidad_medida: get_opt_string(&r, 7),
            nombre_imagen: get_opt_string(&r, 8),
            ruta_imagen: get_opt_string(&r, 9),
            cantidad_pedido_esperada: {
                let v = get_f64(&r, 10);
                if v == 0.0 {
                    None
                } else {
                    Some(v)
                }
            },
            ultima_entrada: get_opt_string(&r, 11),
            caducidad_proxima: get_opt_string(&r, 12),
        });
    }

    Ok(out)
}

/* =========================================================
   Escrituras
========================================================= */

#[tauri::command]
pub async fn proveedores_save(
    state: State<'_, AppState>,
    args: ProveedorSaveArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    let requested_id_proveedor = args.id_proveedor.filter(|n| *n > 0);
    let nombre_empresa = normalize_required(&args.nombre_empresa, "nombre_empresa")?;
    let contacto = clean_opt_string(args.contacto);
    let telefono = clean_opt_string(args.telefono);
    let email = clean_opt_string(args.email);
    let cif = clean_opt_string(args.cif);
    let informacion_adicional = clean_opt_string(args.informacion_adicional);
    let nombre_imagen = clean_opt_string(args.nombre_imagen);
    let ruta_imagen = clean_opt_string(args.ruta_imagen);

    let command_name = "proveedores.save";

    let hash_args = json!({
        "id_proveedor": requested_id_proveedor,
        "nombre_empresa": nombre_empresa.clone(),
        "contacto": contacto.clone(),
        "telefono": telefono.clone(),
        "email": email.clone(),
        "cif": cif.clone(),
        "informacion_adicional": informacion_adicional.clone(),
        "nombre_imagen": nombre_imagen.clone(),
        "ruta_imagen": ruta_imagen.clone()
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

    let id_proveedor = match requested_id_proveedor {
        Some(id) => id,
        None => next_table_id(&conn, "Proveedores", "ID_Proveedor").await?,
    };

    let domain_args = json!({
        "id_proveedor": id_proveedor,
        "nombre_empresa": nombre_empresa.clone(),
        "contacto": contacto.clone(),
        "telefono": telefono.clone(),
        "email": email.clone(),
        "cif": cif.clone(),
        "informacion_adicional": informacion_adicional.clone(),
        "nombre_imagen": nombre_imagen.clone(),
        "ruta_imagen": ruta_imagen.clone()
    });

    let payload_json = stable_json_string(&json!({
        "op_id": op_id.clone(),
        "command_name": command_name,
        "args": domain_args
    }))?;

    if outbox_assert_replay_or_unused(&conn, &op_id, command_name, &payload_json).await? {
        return Ok(true);
    }

    begin(&conn).await?;

    let result: Result<bool, String> = async {
        applied_insert_processing(&conn, &op_id, command_name, &request_hash).await?;

        conn.execute(
            r#"
            INSERT INTO Proveedores (
              ID_Proveedor,
              Nombre_Empresa,
              Contacto,
              Telefono,
              Email,
              CIF,
              Informacion_adicional,
              Nombre_Imagen,
              Ruta_Imagen
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(ID_Proveedor) DO UPDATE SET
              Nombre_Empresa = excluded.Nombre_Empresa,
              Contacto = excluded.Contacto,
              Telefono = excluded.Telefono,
              Email = excluded.Email,
              CIF = excluded.CIF,
              Informacion_adicional = excluded.Informacion_adicional,
              Nombre_Imagen = excluded.Nombre_Imagen,
              Ruta_Imagen = excluded.Ruta_Imagen;
            "#,
            vec![
                Value::Integer(id_proveedor),
                Value::Text(nombre_empresa),
                opt_text(contacto),
                opt_text(telefono),
                opt_text(email),
                opt_text(cif),
                opt_text(informacion_adicional),
                opt_text(nombre_imagen),
                opt_text(ruta_imagen),
            ],
        )
        .await
        .map_err(|e| format!("UPSERT proveedor error: {e}"))?;

        maybe_insert_outbox(&conn, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&conn, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match result {
        Ok(result) => {
            commit(&conn).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&conn).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn proveedores_delete(
    state: State<'_, AppState>,
    args: ProveedoresDeleteArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_proveedor <= 0 {
        return Err("ID_Proveedor inválido".into());
    }

    let command_name = "proveedores.delete";

    let domain_args = json!({
        "id_proveedor": args.id_proveedor
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

    begin(&conn).await?;

    let result: Result<bool, String> = async {
        applied_insert_processing(&conn, &op_id, command_name, &request_hash).await?;

        conn.execute(
            r#"
            UPDATE Lotes_Producto
            SET ID_Proveedor = NULL
            WHERE ID_Proveedor = ?1;
            "#,
            vec![Value::Integer(args.id_proveedor)],
        )
        .await
        .map_err(|e| format!("UPDATE Lotes_Producto error: {e}"))?;

        conn.execute(
            r#"
            UPDATE Productos
            SET ID_Proveedor = NULL
            WHERE ID_Proveedor = ?1;
            "#,
            vec![Value::Integer(args.id_proveedor)],
        )
        .await
        .map_err(|e| format!("UPDATE Productos error: {e}"))?;

        let affected = conn
            .execute(
                r#"
                DELETE FROM Proveedores
                WHERE ID_Proveedor = ?1;
                "#,
                vec![Value::Integer(args.id_proveedor)],
            )
            .await
            .map_err(|e| format!("DELETE Proveedores error: {e}"))?;

        let result = affected > 0;

        maybe_insert_outbox(&conn, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&conn, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match result {
        Ok(result) => {
            commit(&conn).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&conn).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn proveedores_set_vinculos(
    state: State<'_, AppState>,
    args: ProveedoresSetVinculosArgs,
) -> Result<bool, String> {
    let conn = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    if args.id_proveedor <= 0 {
        return Err("ID_Proveedor inválido".into());
    }

    let mut producto_ids = args
        .producto_ids
        .into_iter()
        .filter(|n| *n > 0)
        .collect::<Vec<_>>();

    producto_ids.sort_unstable();
    producto_ids.dedup();

    let command_name = "proveedores.setVinculos";

    let domain_args = json!({
        "id_proveedor": args.id_proveedor,
        "producto_ids": producto_ids.clone()
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

    begin(&conn).await?;

    let result: Result<bool, String> = async {
        applied_insert_processing(&conn, &op_id, command_name, &request_hash).await?;

        conn.execute(
            r#"
            UPDATE Productos
            SET ID_Proveedor = NULL
            WHERE ID_Proveedor = ?1;
            "#,
            vec![Value::Integer(args.id_proveedor)],
        )
        .await
        .map_err(|e| format!("UPDATE Productos NULL error: {e}"))?;

        for pid in producto_ids.iter() {
            conn.execute(
                r#"
                UPDATE Productos
                SET ID_Proveedor = ?1
                WHERE ID_Producto = ?2;
                "#,
                vec![Value::Integer(args.id_proveedor), Value::Integer(*pid)],
            )
            .await
            .map_err(|e| format!("UPDATE Productos set proveedor error: {e}"))?;
        }

        maybe_insert_outbox(&conn, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result = true;
        let result_json = serialize_result_json(&result)?;

        applied_mark_applied(&conn, &op_id, &result_json).await?;

        Ok(result)
    }
    .await;

    match result {
        Ok(result) => {
            commit(&conn).await?;
            Ok(result)
        }
        Err(e) => {
            rollback(&conn).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn proveedores_create_producto(
    state: State<'_, AppState>,
    args: ProveedoresCreateProductoArgs,
) -> Result<i64, String> {
    let conn = get_db(&state).await?;

    let enqueue_outbox = should_enqueue_outbox(args.enqueue_outbox);

    let op_id = normalize_required(&args.op_id, "op_id")?;

    let nombre = normalize_required(&args.nombre, "nombre")?;

    if args.id_categoria <= 0 {
        return Err("ID_Categoria inválido".into());
    }

    if args.id_proveedor <= 0 {
        return Err("ID_Proveedor inválido".into());
    }

    let requested_id_producto = args.id_producto.filter(|n| *n > 0);

    if let Some(stock) = args.stock_actual {
        if !stock.is_finite() || stock < 0.0 {
            return Err("Stock_Actual inválido".into());
        }
    }

    if let Some(precio_venta) = args.precio_venta {
        if !precio_venta.is_finite() || precio_venta < 0.0 {
            return Err("Precio_Venta inválido".into());
        }
    }

    if let Some(stock_minimo) = args.stock_minimo {
        if !stock_minimo.is_finite() || stock_minimo < 0.0 {
            return Err("Stock_Minimo inválido".into());
        }
    }

    let unidad_medida = clean_opt_string(args.unidad_medida);

    let command_name = "proveedores.createProducto";

    let hash_args = json!({
        "id_producto": requested_id_producto,
        "id_categoria": args.id_categoria,
        "id_proveedor": args.id_proveedor,
        "nombre": nombre.clone(),
        "precio_venta": args.precio_venta,
        "stock_actual": args.stock_actual,
        "stock_minimo": args.stock_minimo,
        "unidad_medida": unidad_medida.clone()
    });

    let request_hash = sha256_hex_str(&stable_json_string(&hash_args)?);

    if let Some(existing) = applied_get_by_op_id(&conn, &op_id).await? {
        applied_assert_same_request(&existing, command_name, &request_hash)?;

        return match existing.status.as_str() {
            "APPLIED" => parse_result_json::<i64>(existing.result_json),
            "FAILED" => Err(existing
                .error_text
                .unwrap_or_else(|| "operation_failed".to_string())),
            _ => Err("operation_processing".into()),
        };
    }

    let id_producto = match requested_id_producto {
        Some(id) => id,
        None => next_table_id(&conn, "Productos", "ID_Producto").await?,
    };

    let domain_args = json!({
        "id_producto": id_producto,
        "id_categoria": args.id_categoria,
        "id_proveedor": args.id_proveedor,
        "nombre": nombre.clone(),
        "precio_venta": args.precio_venta,
        "stock_actual": args.stock_actual,
        "stock_minimo": args.stock_minimo,
        "unidad_medida": unidad_medida.clone()
    });

    let payload_json = stable_json_string(&json!({
        "op_id": op_id.clone(),
        "command_name": command_name,
        "args": domain_args
    }))?;

    if outbox_assert_replay_or_unused(&conn, &op_id, command_name, &payload_json).await? {
        return Ok(id_producto);
    }

    begin(&conn).await?;

    let result: Result<i64, String> = async {
        applied_insert_processing(&conn, &op_id, command_name, &request_hash).await?;

        conn.execute(
            r#"
            INSERT INTO Productos (
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
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL)
            ON CONFLICT(ID_Producto) DO UPDATE SET
              ID_Categoria = excluded.ID_Categoria,
              ID_Proveedor = excluded.ID_Proveedor,
              Nombre = excluded.Nombre,
              Precio_Venta = excluded.Precio_Venta,
              Stock_Minimo = excluded.Stock_Minimo,
              Unidad_Medida = excluded.Unidad_Medida;
            "#,
            vec![
                Value::Integer(id_producto),
                Value::Integer(args.id_categoria),
                Value::Integer(args.id_proveedor),
                Value::Text(nombre),
                opt_real(args.precio_venta),
                opt_real(args.stock_minimo),
                opt_text(unidad_medida),
            ],
        )
        .await
        .map_err(|e| format!("UPSERT Producto error: {e}"))?;

        if let Some(stock) = args.stock_actual {
            if stock > 0.0 {
                let codigo_lote = format!("INI-{}", id_producto);

                conn.execute(
                    r#"
                    INSERT OR IGNORE INTO Lotes_Producto
                      (ID_Producto, Codigo_Lote, Fecha_Entrada, Caducidad,
                       Cantidad_Inicial, Stock_Disponible, Coste_Unitario, ID_Proveedor, Notas)
                    VALUES
                      (?1, ?2, datetime('now','localtime'), NULL,
                       ?3, ?4, NULL, ?5, ?6);
                    "#,
                    vec![
                        Value::Integer(id_producto),
                        Value::Text(codigo_lote),
                        Value::Real(stock),
                        Value::Real(stock),
                        Value::Integer(args.id_proveedor),
                        Value::Text("Lote inicial creado desde Proveedores".into()),
                    ],
                )
                .await
                .map_err(|e| format!("INSERT Lote inicial error: {e}"))?;
            }
        }

        maybe_insert_outbox(&conn, enqueue_outbox, &op_id, command_name, &payload_json).await?;

        let result_json = serialize_result_json(&id_producto)?;

        applied_mark_applied(&conn, &op_id, &result_json).await?;

        Ok(id_producto)
    }
    .await;

    match result {
        Ok(id) => {
            commit(&conn).await?;
            Ok(id)
        }
        Err(e) => {
            rollback(&conn).await;
            Err(e)
        }
    }
}
