//! Adaptador SQLite del repositorio de **mesas / salón / comandas / cocina**. Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id ni ramas remote_id.
//! Todo el SQL del antiguo `mesas.rs` se reubica aquí; las creaciones usan autoincrement
//! local (last_insert_rowid) en lugar de ids forzados desde remoto.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{Local, NaiveDate, NaiveTime, TimeZone};
use libsql::Value;

use crate::db::{Db, Reader, Writer};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::mesas::MesasRepository;
use tpv_contracts::mesas::{
    CategoriaVendibleOut, ComandaBarraListItem, ComandaRow, KitchenRow, MesaLineaComandaRow,
    MesaMetaOut, ProductoVendibleOut, ReservaMesaOut, RoomPoly, SalonInput, SalonOut, TableOut,
};
use tpv_domain::mesas::{AbrirComandaData, CobroDetalles, CobroVentaRapida};

use crate::mapping::{norm_opt_string, v_f64, v_i64, v_string};
use crate::util::{new_id, BARRA_MESA_ID};

/// Secuencia para generar etiquetas de lote VR únicas (sustituye al batch derivado de op_id).
static VR_BATCH_SEQ: AtomicU64 = AtomicU64::new(0);

pub struct SqliteMesasRepository {
    db: Arc<Db>,
}

impl SqliteMesasRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => i64::MAX,
    }
}

/// Extrae el id (UUID) embebido en un id de UI con prefijo (`db-mesa-<uuid>`).
fn parse_db_id(id: &str, prefix: &str) -> Option<String> {
    let s = id.trim();
    let rest = s.strip_prefix(prefix)?.trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

fn build_in_placeholders(start: i64, count: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start + i as i64))
        .collect::<Vec<_>>()
        .join(", ")
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

async fn select_one_i64<C: Reader>(conn: &C, sql: &str, args: Vec<Value>) -> AppResult<Option<i64>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        return Ok(v_i64(row.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

/// Igual que `select_one_i64` pero para columnas de id (TEXT/UUID).
async fn select_one_string<C: Reader>(
    conn: &C,
    sql: &str,
    args: Vec<Value>,
) -> AppResult<Option<String>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        return Ok(norm_opt_string(row.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

async fn select_one_f64<C: Reader>(conn: &C, sql: &str, args: Vec<Value>) -> AppResult<Option<f64>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        return Ok(v_f64(row.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

/// Ejecuta tolerando columnas/tablas inexistentes (devuelve false en ese caso).
async fn try_exec<C: Writer>(db: &C, sql: &str, args: Vec<Value>) -> AppResult<bool> {
    match db.execute(sql, args).await {
        Ok(_) => Ok(true),
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            if msg.contains("no such column") || msg.contains("no such table") {
                Ok(false)
            } else {
                Err(db_err(e))
            }
        }
    }
}

async fn exists_by_id<C: Reader>(conn: &C, table: &str, id_col: &str, id: &str) -> AppResult<bool> {
    if id.trim().is_empty() {
        return Ok(false);
    }
    let sql = format!("SELECT 1 FROM {table} WHERE {id_col}=?1 LIMIT 1;");
    Ok(select_one_i64(conn, &sql, vec![Value::Text(id.to_string())])
        .await?
        .is_some())
}

async fn trabajador_id_from_usuario<C: Reader>(
    db: &C,
    id_usuario: Option<String>,
) -> AppResult<Option<String>> {
    let Some(idu) = id_usuario.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    select_one_string(
        db,
        "SELECT ID_Trabajador FROM Trabajadores WHERE ID_Usuario=?1 LIMIT 1;",
        vec![Value::Text(idu)],
    )
    .await
}

async fn resolve_trabajador_id_input<C: Reader>(
    db: &C,
    id_maybe: Option<String>,
) -> AppResult<Option<String>> {
    let Some(x) = id_maybe.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    if exists_by_id(db, "Trabajadores", "ID_Trabajador", &x).await? {
        return Ok(Some(x));
    }
    trabajador_id_from_usuario(db, Some(x)).await
}

async fn sumar_gasto_cliente_por_comanda<C: Writer>(
    db: &C,
    id_comanda: &str,
    importe: f64,
) -> AppResult<()> {
    if !importe.is_finite() || importe <= 0.0 {
        return Ok(());
    }
    let importe = (importe * 100.0).round() / 100.0;

    let mut id_reserva = select_one_string(
        db,
        "SELECT ID_Reserva FROM Comandas WHERE ID_Comanda=?1 LIMIT 1;",
        vec![Value::Text(id_comanda.to_string())],
    )
    .await?;

    if id_reserva.is_none() {
        id_reserva = select_one_string(
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
            vec![Value::Text(id_comanda.to_string())],
        )
        .await?;

        if let Some(rid) = id_reserva.clone() {
            let _ = db
                .execute(
                    "UPDATE Comandas SET ID_Reserva=?2 WHERE ID_Comanda=?1;",
                    vec![Value::Text(id_comanda.to_string()), Value::Text(rid)],
                )
                .await;
        }
    }

    let Some(id_reserva) = id_reserva else {
        return Ok(());
    };

    let Some(id_cliente) = select_one_string(
        db,
        "SELECT ID_Cliente FROM Reservas WHERE ID_Reserva=?1 LIMIT 1;",
        vec![Value::Text(id_reserva)],
    )
    .await?
    else {
        return Ok(());
    };

    let _ = try_exec(
        db,
        r#"
        UPDATE Clientes
        SET Total_Gastado = COALESCE(Total_Gastado,0) + ?2
        WHERE ID_Cliente = ?1;
        "#,
        vec![Value::Text(id_cliente), Value::Real(importe)],
    )
    .await?;

    Ok(())
}

/// La mesa BARRA se siembra con un id fijo (idéntico en local y nube), así que basta devolverlo.
async fn get_or_create_mesa_barra_inner<C>(_db: &C) -> AppResult<String> {
    Ok(BARRA_MESA_ID.to_string())
}

/// Get-or-create de la comanda de barra abierta (Local-First: id UUIDv7 explícito).
async fn get_or_create_comanda_barra_inner<C: Writer>(
    db: &C,
    id_trabajador: Option<String>,
) -> AppResult<String> {
    let id_mesa_barra = get_or_create_mesa_barra_inner(db).await?;

    if let Some(idc) = select_one_string(
        db,
        r#"
        SELECT ID_Comanda
        FROM Comandas
        WHERE ID_Mesa=?1 AND Estado='Abierta'
        ORDER BY datetime(Fecha_Hora_Apertura) DESC
        LIMIT 1;
        "#,
        vec![Value::Text(id_mesa_barra.clone())],
    )
    .await?
    {
        return Ok(idc);
    }

    let id_comanda = new_id();
    db.execute(
        r#"
        INSERT INTO Comandas (
          ID_Comanda, ID_Mesa, ID_Trabajador, Fecha_Hora_Apertura, Total_Comanda, Estado
        )
        VALUES (?1, ?2, ?3, datetime('now','localtime'), 0, 'Abierta');
        "#,
        vec![
            Value::Text(id_comanda.clone()),
            Value::Text(id_mesa_barra),
            id_trabajador.map(Value::Text).unwrap_or(Value::Null),
        ],
    )
    .await
    .map_err(db_err)?;

    Ok(id_comanda)
}

async fn read_comanda_by_id<C: Reader>(db: &C, id_comanda: &str) -> AppResult<Option<ComandaRow>> {
    if id_comanda.trim().is_empty() {
        return Ok(None);
    }
    let mut rows = db
        .query(
            r#"
            SELECT
              ID_Comanda, ID_Mesa, ID_Trabajador, ID_Reserva,
              Fecha_Hora_Apertura, Fecha_Hora_Cierre, Total_Comanda, Estado
            FROM Comandas
            WHERE ID_Comanda = ?1
            LIMIT 1;
            "#,
            vec![Value::Text(id_comanda.to_string())],
        )
        .await
        .map_err(db_err)?;

    let Some(r) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };

    Ok(Some(ComandaRow {
        id_comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
        id_mesa: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
        id_trabajador: norm_opt_string(r.get_value(2).map_err(db_err)?),
        id_reserva: norm_opt_string(r.get_value(3).map_err(db_err)?),
        fecha_hora_apertura: v_string(r.get_value(4).map_err(db_err)?).unwrap_or_default(),
        fecha_hora_cierre: v_string(r.get_value(5).map_err(db_err)?),
        total_comanda: v_f64(r.get_value(6).map_err(db_err)?).unwrap_or(0.0),
        estado: v_string(r.get_value(7).map_err(db_err)?).unwrap_or_else(|| "Abierta".into()),
    }))
}

#[async_trait]
impl MesasRepository for SqliteMesasRepository {
    /* ===== LAYOUT ===== */

    async fn save_layout(&self, salons: Vec<SalonInput>) -> AppResult<()> {
        // Validación: nombres de zona no vacíos y únicos en el lote (la BD impone UNIQUE).
        {
            let mut seen = std::collections::HashSet::new();
            for z in salons.iter() {
                let name = z.name.trim();
                if name.is_empty() {
                    return Err(AppError::validation("zone_name required"));
                }
                if !seen.insert(name.to_string()) {
                    return Err(AppError::validation(format!(
                        "Nombre de zona duplicado: «{name}»"
                    )));
                }
            }
        }

        // IDs de zonas existentes que el editor conserva (llegan con prefijo "db-zona-").
        let kept_zone_ids: Vec<String> = salons
            .iter()
            .filter_map(|z| parse_db_id(&z.id, "db-zona-"))
            .collect();

        // Cláusula reutilizable "... AND ID_Zona NOT IN (?1, ?2, …)" + sus argumentos.
        let not_in_clause = if kept_zone_ids.is_empty() {
            String::new()
        } else {
            format!(
                " AND ID_Zona NOT IN ({})",
                build_in_placeholders(1, kept_zone_ids.len())
            )
        };
        let kept_args: Vec<Value> = kept_zone_ids.iter().cloned().map(Value::Text).collect();

        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            // ── 1. Eliminar las zonas borradas en el editor (las que ya no llegan) ──────
            // Primero sus mesas libres; las de sistema y las con comanda/reserva quedan, y
            // esas mesas residuales impiden borrar su zona (así BARRA queda protegida).
            db.execute(
                &format!(
                    r#"DELETE FROM Mesas
                       WHERE Es_Sistema = 0{not_in_clause}
                         AND NOT EXISTS (SELECT 1 FROM Comandas C WHERE C.ID_Mesa = Mesas.ID_Mesa)
                         AND NOT EXISTS (SELECT 1 FROM Reservas R WHERE R.ID_Mesa = Mesas.ID_Mesa);"#
                ),
                kept_args.clone(),
            )
            .await
            .map_err(db_err)?;

            db.execute(
                &format!(
                    r#"DELETE FROM Zonas
                       WHERE 1 = 1{not_in_clause}
                         AND NOT EXISTS (SELECT 1 FROM Mesas M WHERE M.ID_Zona = Zonas.ID_Zona);"#
                ),
                kept_args.clone(),
            )
            .await
            .map_err(db_err)?;

            // ── 2. Aparcar los nombres de las zonas conservadas a un valor temporal único ──
            // Libera los nombres reales para que los UPDATE de la fase 3 no choquen de forma
            // transitoria con el UNIQUE(Nombre_Zona) al renombrar/intercambiar zonas existentes.
            if !kept_zone_ids.is_empty() {
                let in_sql = build_in_placeholders(1, kept_zone_ids.len());
                db.execute(
                    &format!(
                        "UPDATE Zonas SET Nombre_Zona = '__tmp_zona_' || ID_Zona WHERE ID_Zona IN ({in_sql});"
                    ),
                    kept_args.clone(),
                )
                .await
                .map_err(db_err)?;
            }

            // ── 3. Upsert de cada zona del editor + reconciliación de sus mesas ──────────
            for z in salons.iter() {
                let zone_name = z.name.trim().to_string();
                let points_json = serde_json::to_string(&z.room.points).map_err(db_err)?;

                let zone_id: String = if let Some(id_zona) = parse_db_id(&z.id, "db-zona-") {
                    // Zona existente (aparcada en la fase 2): fija su nombre real y los puntos.
                    db.execute(
                        r#"
                        UPDATE Zonas
                        SET Nombre_Zona = ?2, Room_Points = ?3, Updated_At = datetime('now','localtime')
                        WHERE ID_Zona = ?1;
                        "#,
                        vec![
                            Value::Text(id_zona.clone()),
                            Value::Text(zone_name.clone()),
                            Value::Text(points_json.clone()),
                        ],
                    )
                    .await
                    .map_err(db_err)?;
                    id_zona
                } else {
                    // Zona nueva: upsert por NOMBRE. Si el nombre ya existe (p. ej. una zona
                    // que sobrevivió a un borrado por tener mesas), NO choca con el UNIQUE:
                    // reutiliza esa zona en vez de crashear ("no pasa nada"). Mismo criterio
                    // que la nube (mesas.commands.ts).
                    let new_zone_id = new_id();
                    db.execute(
                        r#"
                        INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points, Updated_At)
                        VALUES (?1, ?2, ?3, datetime('now','localtime'))
                        ON CONFLICT(Nombre_Zona) DO UPDATE SET
                          Room_Points = excluded.Room_Points,
                          Updated_At = excluded.Updated_At;
                        "#,
                        vec![
                            Value::Text(new_zone_id.clone()),
                            Value::Text(zone_name.clone()),
                            Value::Text(points_json.clone()),
                        ],
                    )
                    .await
                    .map_err(db_err)?;

                    // Resolver el ID real por nombre: si hubo conflicto es el de la zona
                    // existente (así las mesas se cuelgan de un ID_Zona que sí existe → sin FK rota).
                    let mut rows = db
                        .query(
                            "SELECT ID_Zona FROM Zonas WHERE Nombre_Zona = ?1 LIMIT 1;",
                            vec![Value::Text(zone_name.clone())],
                        )
                        .await
                        .map_err(db_err)?;
                    match rows.next().await.map_err(db_err)? {
                        Some(r) => match r.get_value(0).map_err(db_err)? {
                            Value::Text(s) => s,
                            _ => new_zone_id,
                        },
                        None => new_zone_id,
                    }
                };

                let mut kept: Vec<String> = vec![];
                for t in z.tables.iter() {
                    if let Some(idm) = parse_db_id(&t.id, "db-mesa-") {
                        if !idm.trim().is_empty() {
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
                let mut sql_args: Vec<Value> = vec![Value::Text(zone_id.clone())];

                if !kept.is_empty() {
                    sql.push_str(" AND ID_Mesa NOT IN (");
                    for (i, idm) in kept.iter().enumerate() {
                        let idx = (i + 2) as i64;
                        if i > 0 {
                            sql.push_str(", ");
                        }
                        sql.push_str(&format!("?{idx}"));
                        sql_args.push(Value::Text(idm.clone()));
                    }
                    sql.push(')');
                }

                sql.push_str(
                    r#"
                      AND NOT EXISTS (SELECT 1 FROM Comandas C WHERE C.ID_Mesa = Mesas.ID_Mesa)
                      AND NOT EXISTS (SELECT 1 FROM Reservas R WHERE R.ID_Mesa = Mesas.ID_Mesa);
                    "#,
                );

                db.execute(&sql, sql_args).await.map_err(db_err)?;

                for t in z.tables.iter() {
                    let id_mesa_opt = parse_db_id(&t.id, "db-mesa-");
                    let numero_mesa = t.name.trim().to_string();
                    if numero_mesa.is_empty() {
                        return Err(AppError::validation("numero_mesa required"));
                    }
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
                              ID_Zona = ?1, Numero_Mesa = ?2, Capacidad = ?3,
                              Ubicacion_X = ?4, Ubicacion_Y = ?5,
                              Shape = ?6, Width = ?7, Height = ?8, Radius = ?9,
                              Updated_At = datetime('now','localtime')
                            WHERE ID_Mesa = ?10;
                            "#,
                            vec![
                                Value::Text(zone_id.clone()),
                                Value::Text(numero_mesa),
                                Value::Integer(capacidad),
                                Value::Integer(x),
                                Value::Integer(y),
                                Value::Text(shape),
                                Value::Integer(width),
                                Value::Integer(height),
                                radius.map(Value::Integer).unwrap_or(Value::Null),
                                Value::Text(id_mesa),
                            ],
                        )
                        .await
                        .map_err(db_err)?;
                    } else {
                        db.execute(
                            r#"
                            INSERT INTO Mesas (
                              ID_Mesa, ID_Zona, Numero_Mesa, Capacidad,
                              Ubicacion_X, Ubicacion_Y,
                              Shape, Width, Height, Radius,
                              Updated_At, Es_Sistema
                            )
                            VALUES (
                              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                              datetime('now','localtime'), 0
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
                                Value::Text(new_id()),
                                Value::Text(zone_id.clone()),
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
                        .map_err(db_err)?;
                    }
                }
            }
            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(())
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn load_layout(&self) -> AppResult<Vec<SalonOut>> {
        let g = self.db.read().await;
        let db = &g;

        let mut zonas = db
            .query(
                "SELECT ID_Zona, Nombre_Zona, Room_Points FROM Zonas ORDER BY ID_Zona ASC;",
                (),
            )
            .await
            .map_err(db_err)?;

        let mut mesas_rows = db
            .query(
                r#"
                SELECT ID_Mesa, ID_Zona, Numero_Mesa, Capacidad,
                       Ubicacion_X, Ubicacion_Y, Shape, Width, Height, Radius
                FROM Mesas
                WHERE Es_Sistema = 0
                ORDER BY ID_Zona ASC, ID_Mesa ASC;
                "#,
                (),
            )
            .await
            .map_err(db_err)?;

        let mut by_zona: HashMap<String, Vec<TableOut>> = HashMap::new();

        while let Some(r) = mesas_rows.next().await.map_err(db_err)? {
            let id_mesa = match r.get_value(0).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let id_zona = match r.get_value(1).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let numero = match r.get_value(2).map_err(db_err)? {
                Value::Text(s) => s,
                _ => format!("Mesa {id_mesa}"),
            };
            let cap = match r.get_value(3).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 4,
            };
            let x = match r.get_value(4).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 0,
            };
            let y = match r.get_value(5).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 0,
            };
            let shape = match r.get_value(6).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "rounded".into(),
            };
            let w = match r.get_value(7).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 120,
            };
            let h = match r.get_value(8).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 70,
            };
            let radius = match r.get_value(9).map_err(db_err)? {
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

        while let Some(z) = zonas.next().await.map_err(db_err)? {
            let id_zona = match z.get_value(0).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let nombre = match z.get_value(1).map_err(db_err)? {
                Value::Text(s) => s,
                _ => format!("Zona {id_zona}"),
            };
            let room_points_raw = match z.get_value(2).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "[]".into(),
            };
            let points: Vec<f64> = serde_json::from_str(&room_points_raw).unwrap_or_default();

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

    async fn get_mesas_ocupadas(&self) -> AppResult<HashMap<String, bool>> {
        let g = self.db.read().await;
        let db = &g;
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
            .map_err(db_err)?;

        let mut map: HashMap<String, bool> = HashMap::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let id_zona = match r.get_value(0).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let id_mesa = match r.get_value(1).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            map.insert(format!("db-zona-{id_zona}:db-mesa-{id_mesa}"), true);
        }
        Ok(map)
    }

    /* ===== RESERVAS ===== */

    async fn set_reserva_estado(&self, id_reserva: &str, estado: String) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            db.execute(
                "UPDATE Reservas SET Estado=?2 WHERE ID_Reserva=?1;",
                vec![Value::Text(id_reserva.to_string()), Value::Text(estado.clone())],
            )
            .await
            .map_err(db_err)?;

            if estado == "FINALIZADA" || estado == "CANCELADA" || estado == "NO_SHOW" {
                db.execute(
                    "UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
                    vec![Value::Text(id_reserva.to_string())],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(())
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    /* ===== COMANDAS (mesa) ===== */

    async fn get_comanda_abierta_by_mesa(&self, id_mesa: &str) -> AppResult<Option<ComandaRow>> {
        let g = self.db.read().await;
        let db = &g;
        if id_mesa.trim().is_empty() {
            return Ok(None);
        }
        let bare_id = parse_db_id(id_mesa, "db-mesa-").unwrap_or_else(|| id_mesa.to_string());
        let id = select_one_string(
            db,
            r#"
            SELECT ID_Comanda FROM Comandas
            WHERE ID_Mesa = ?1 AND Estado = 'Abierta'
            ORDER BY datetime(Fecha_Hora_Apertura) DESC LIMIT 1;
            "#,
            vec![Value::Text(bare_id)],
        )
        .await?;
        match id {
            Some(id_comanda) => read_comanda_by_id(db, &id_comanda).await,
            None => Ok(None),
        }
    }

    async fn abrir_comanda(&self, data: AbrirComandaData) -> AppResult<Option<ComandaRow>> {
        let g = self.db.write().await;
        let db = &g;
        let id_trabajador_real =
            resolve_trabajador_id_input(db, data.id_trabajador_o_usuario).await?;
        let id_reserva = data.id_reserva.filter(|s| !s.trim().is_empty());
        let bare_id_mesa =
            parse_db_id(&data.id_mesa, "db-mesa-").unwrap_or_else(|| data.id_mesa.clone());

        let id_reserva_final = match id_reserva {
            Some(rid) => Some(rid),
            None => {
                select_one_string(
                    db,
                    r#"
                    SELECT ID_Reserva FROM Reservas
                    WHERE ID_Mesa = ?1 AND Estado='ACTIVA'
                    ORDER BY datetime(Created_At) DESC LIMIT 1;
                    "#,
                    vec![Value::Text(bare_id_mesa.clone())],
                )
                .await?
            }
        };

        let id_comanda_new = new_id();
        db.execute(
            r#"
            INSERT INTO Comandas (
              ID_Comanda, ID_Mesa, ID_Trabajador, ID_Reserva, Fecha_Hora_Apertura, Total_Comanda, Estado
            )
            VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'), 0, 'Abierta');
            "#,
            vec![
                Value::Text(id_comanda_new.clone()),
                Value::Text(bare_id_mesa),
                id_trabajador_real.map(Value::Text).unwrap_or(Value::Null),
                id_reserva_final.map(Value::Text).unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(db_err)?;

        read_comanda_by_id(db, &id_comanda_new).await
    }

    async fn comanda_set_trabajador_if_null(
        &self,
        id_comanda: &str,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;
        let Some(idt) = resolve_trabajador_id_input(db, id_trab_o_usuario).await? else {
            return Ok(false);
        };

        let changed = db
            .execute(
                r#"
                UPDATE Comandas
                SET ID_Trabajador = ?2
                WHERE ID_Comanda = ?1
                  AND Estado = 'Abierta'
                  AND ID_Trabajador IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = ?1
                  );
                "#,
                vec![Value::Text(id_comanda.to_string()), Value::Text(idt)],
            )
            .await
            .map_err(db_err)?;

        Ok(changed > 0)
    }

    async fn cerrar_comanda(&self, id_comanda: &str, total: f64) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;
        db.execute(
            r#"
            UPDATE Comandas
            SET Estado = 'Pagada', Total_Comanda = ?2, Fecha_Hora_Cierre = datetime('now','localtime')
            WHERE ID_Comanda = ?1;
            "#,
            vec![Value::Text(id_comanda.to_string()), Value::Real(total)],
        )
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn get_lineas_comanda(&self, id_comanda: &str) -> AppResult<Vec<MesaLineaComandaRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT
                  D.ID_Detalle, D.ID_Comanda, D.ID_Producto,
                  COALESCE(D.Cantidad, 1) AS Cantidad,
                  COALESCE(D.Precio_Unitario, 0) AS Precio_Unitario,
                  D.Notas, D.Estado_Cocina, P.Nombre,
                  COALESCE(cat.Pasa_Cocina, 0) AS Pasa_Cocina,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = D.ID_Detalle
                  ) THEN 1 ELSE 0 END AS Pagado
                FROM Detalle_Comanda D
                JOIN Productos P ON P.ID_Producto = D.ID_Producto
                JOIN Categorias_Producto cat ON cat.ID_Categoria = P.ID_Categoria
                WHERE D.ID_Comanda = ?1
                ORDER BY D.ID_Detalle ASC;
                "#,
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

        let mut out: Vec<MesaLineaComandaRow> = vec![];
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let id_detalle = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
            if id_detalle.is_empty() {
                continue;
            }
            out.push(MesaLineaComandaRow {
                id_detalle,
                id_comanda: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                id_producto: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                cantidad: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(1.0),
                precio_unitario: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                notas: v_string(r.get_value(5).map_err(db_err)?),
                estado_cocina: v_string(r.get_value(6).map_err(db_err)?),
                nombre: v_string(r.get_value(7).map_err(db_err)?).unwrap_or_default(),
                pasa_cocina: v_i64(r.get_value(8).map_err(db_err)?).unwrap_or(0),
                pagado: v_i64(r.get_value(9).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn add_linea_comanda(
        &self,
        id_comanda: &str,
        id_producto: &str,
        cantidad: f64,
        precio: f64,
        id_trab_o_usuario: Option<String>,
    ) -> AppResult<Vec<MesaLineaComandaRow>> {
        {
        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            let id_trabajador_real = resolve_trabajador_id_input(db, id_trab_o_usuario).await?;
            if let Some(idt) = id_trabajador_real {
                db.execute(
                    r#"
                    UPDATE Comandas
                    SET ID_Trabajador = ?2
                    WHERE ID_Comanda = ?1
                      AND Estado = 'Abierta'
                      AND ID_Trabajador IS NULL;
                    "#,
                    vec![Value::Text(id_comanda.to_string()), Value::Text(idt)],
                )
                .await
                .map_err(db_err)?;
            }

            let pasa = select_one_i64(
                db,
                r#"
                SELECT COALESCE(cat.Pasa_Cocina, 0)
                FROM Productos p
                JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                WHERE p.ID_Producto = ?1 LIMIT 1;
                "#,
                vec![Value::Text(id_producto.to_string())],
            )
            .await?
            .unwrap_or(0)
                == 1;

            let estado_cocina = if pasa {
                Value::Text("PENDIENTE".into())
            } else {
                Value::Null
            };

            db.execute(
                r#"
                INSERT INTO Detalle_Comanda (
                  ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, Estado_Cocina
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6);
                "#,
                vec![
                    Value::Text(new_id()),
                    Value::Text(id_comanda.to_string()),
                    Value::Text(id_producto.to_string()),
                    Value::Real(cantidad),
                    Value::Real(precio),
                    estado_cocina,
                ],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;
            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                return Err(e);
            }
        }
        } // WriteGuard se suelta aquí → la pool de lectura puede actuar
        self.get_lineas_comanda(id_comanda).await
    }

    /* ===== BARRA ===== */

    async fn get_or_create_mesa_barra(&self) -> AppResult<String> {
        let db = self.db.read().await;
        get_or_create_mesa_barra_inner(&db).await
    }

    async fn get_or_create_comanda_barra(&self, id_trabajador: Option<String>) -> AppResult<String> {
        let db = self.db.write().await;
        get_or_create_comanda_barra_inner(
            &db,
            id_trabajador.filter(|s| !s.trim().is_empty()),
        )
        .await
    }

    async fn cobrar_venta_rapida(&self, data: CobroVentaRapida) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        if data.items.is_empty() {
            return Ok(());
        }

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            let id_trabajador_cobrador = match data.id_trabajador_cobrador.clone() {
                Some(s) if !s.trim().is_empty() => Some(s),
                _ => trabajador_id_from_usuario(db, data.id_usuario_cobrador.clone()).await?,
            };

            let id_comanda = match data.id_comanda.clone() {
                Some(idc) if exists_by_id(db, "Comandas", "ID_Comanda", &idc).await? => idc,
                _ => get_or_create_comanda_barra_inner(db, id_trabajador_cobrador.clone()).await?,
            };

            let seq = VR_BATCH_SEQ.fetch_add(1, Ordering::Relaxed);
            let batch = format!("VR:{}-{}", now_ms(), seq);

            let sum = data.items.iter().fold(0.0, |acc, (_p, precio)| acc + *precio);
            let importe_total = (sum * 100.0).round() / 100.0;

            for (producto_id, precio) in data.items.iter() {
                db.execute(
                    r#"
                    INSERT INTO Detalle_Comanda (
                      ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario, Notas, Estado_Cocina
                    )
                    SELECT
                      ?1, ?2, ?3, 1, ?4, ?5,
                      CASE WHEN COALESCE(cat.Pasa_Cocina, 0) = 1 THEN 'PENDIENTE' ELSE NULL END
                    FROM Productos p
                    JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                    WHERE p.ID_Producto = ?3
                    LIMIT 1;
                    "#,
                    vec![
                        Value::Text(new_id()),
                        Value::Text(id_comanda.to_string()),
                        Value::Text(producto_id.clone()),
                        Value::Real(*precio),
                        Value::Text(batch.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;

            let id_pago = new_id();
            let ok = try_exec(
                db,
                r#"
                INSERT INTO Pagos (
                  ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
                  ID_Usuario_Cobrador, ID_Trabajador_Cobrador
                )
                VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, 'FRACCIONADO', ?5, ?6);
                "#,
                vec![
                    Value::Text(id_pago.clone()),
                    Value::Text(id_comanda.to_string()),
                    Value::Text(data.metodo.clone()),
                    Value::Real(importe_total),
                    data.id_usuario_cobrador.clone().map(Value::Text).unwrap_or(Value::Null),
                    id_trabajador_cobrador.map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await?;

            if !ok {
                db.execute(
                    r#"
                    INSERT INTO Pagos (
                      ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, ID_Usuario_Cobrador
                    )
                    VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, 'FRACCIONADO', ?5);
                    "#,
                    vec![
                        Value::Text(id_pago.clone()),
                        Value::Text(id_comanda.to_string()),
                        Value::Text(data.metodo.clone()),
                        Value::Real(importe_total),
                        data.id_usuario_cobrador.clone().map(Value::Text).unwrap_or(Value::Null),
                    ],
                )
                .await
                .map_err(db_err)?;
            }

            db.execute(
                r#"
                INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
                SELECT ?1, dc.ID_Detalle
                FROM Detalle_Comanda dc
                WHERE dc.ID_Comanda = ?2 AND dc.Notas = ?3;
                "#,
                vec![
                    Value::Text(id_pago),
                    Value::Text(id_comanda.to_string()),
                    Value::Text(batch),
                ],
            )
            .await
            .map_err(db_err)?;

            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(())
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn create_comanda_barra(&self, id_trabajador: Option<String>) -> AppResult<String> {
        let g = self.db.write().await;
        let db = &g;
        let id_trabajador = id_trabajador.filter(|s| !s.trim().is_empty());

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<String> = async {
            let id_mesa_barra = get_or_create_mesa_barra_inner(db).await?;
            let id_comanda = new_id();

            db.execute(
                r#"
                INSERT INTO Comandas (
                  ID_Comanda, ID_Mesa, ID_Trabajador, Fecha_Hora_Apertura, Total_Comanda, Estado
                )
                VALUES (?1, ?2, ?3, datetime('now','localtime'), 0, 'Abierta');
                "#,
                vec![
                    Value::Text(id_comanda.clone()),
                    Value::Text(id_mesa_barra),
                    id_trabajador.map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(db_err)?;

            Ok(id_comanda)
        }
        .await;

        match res {
            Ok(id) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(id)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn list_comandas_barra(
        &self,
        include_pagadas: bool,
        limit: i64,
    ) -> AppResult<Vec<ComandaBarraListItem>> {
        let g = self.db.read().await;
        let db = &g;
        let id_mesa_barra = get_or_create_mesa_barra_inner(db).await?;

        let sql = format!(
            r#"
            SELECT
              c.ID_Comanda, c.Fecha_Hora_Apertura, c.Estado,
              (
                SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
                FROM Detalle_Comanda dc
                LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                WHERE dc.ID_Comanda = c.ID_Comanda AND pd.ID_Detalle IS NULL
              ) AS Total_Pendiente,
              (
                SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
                FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda
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
                WHERE dc.ID_Comanda = c.ID_Comanda AND pd.ID_Detalle IS NULL
              ) AS Pendientes_Pago
            FROM Comandas c
            WHERE c.ID_Mesa = ?1
              {estado_filter}
              AND EXISTS (
                SELECT 1 FROM Detalle_Comanda dc WHERE dc.ID_Comanda = c.ID_Comanda
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
            .query(&sql, vec![Value::Text(id_mesa_barra)])
            .await
            .map_err(db_err)?;

        let mut out = vec![];
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(ComandaBarraListItem {
                id_comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                fecha_hora_apertura: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                estado: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                total_pendiente: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(0.0),
                total_comanda: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(0.0),
                pendientes_cocina: v_i64(r.get_value(5).map_err(db_err)?).unwrap_or(0),
                pendientes_pago: v_i64(r.get_value(6).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn delete_comanda_barra_if_safe(&self, id_comanda: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let db = &g;

        let paid = select_one_i64(
            db,
            r#"
            SELECT 1
            FROM Detalle_Comanda dc
            JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
            WHERE dc.ID_Comanda = ?1 LIMIT 1;
            "#,
            vec![Value::Text(id_comanda.to_string())],
        )
        .await?
        .is_some();

        if paid {
            return Ok(false);
        }

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            db.execute(
                "DELETE FROM Detalle_Comanda WHERE ID_Comanda = ?1;",
                vec![Value::Text(id_comanda.to_string())],
            )
            .await
            .map_err(db_err)?;

            let affected = db
                .execute(
                    "DELETE FROM Comandas WHERE ID_Comanda = ?1;",
                    vec![Value::Text(id_comanda.to_string())],
                )
                .await
                .map_err(db_err)?;

            Ok(affected > 0)
        }
        .await;

        match res {
            Ok(v) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    /* ===== META + CATÁLOGO ===== */

    async fn mesas_meta_all(&self) -> AppResult<HashMap<String, MesaMetaOut>> {
        let g = self.db.read().await;
        let db = &g;

        let mut rows = db
            .query(
                r#"
                SELECT
                  c.ID_Mesa, c.ID_Comanda,
                  (
                    SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
                    FROM Detalle_Comanda dc
                    LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                    WHERE dc.ID_Comanda = c.ID_Comanda AND pd.ID_Detalle IS NULL
                  ) AS Total_Pendiente,
                  (
                    SELECT COUNT(*)
                    FROM Detalle_Comanda dc
                    LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                    WHERE dc.ID_Comanda = c.ID_Comanda AND pd.ID_Detalle IS NULL
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
            .map_err(db_err)?;

        let mut map: HashMap<String, MesaMetaOut> = HashMap::new();
        while let Some(r) = rows.next().await.map_err(db_err)? {
            let id_mesa = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
            let id_comanda = v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default();
            if id_mesa.is_empty() || id_comanda.is_empty() {
                continue;
            }
            let total_pendiente = v_f64(r.get_value(2).map_err(db_err)?).unwrap_or(0.0);
            let pendientes_pago = v_i64(r.get_value(3).map_err(db_err)?).unwrap_or(0);
            let pendientes_cocina = v_i64(r.get_value(4).map_err(db_err)?).unwrap_or(0);

            let estado = if pendientes_pago > 0 || total_pendiente > 0.0 {
                "PENDIENTE".to_string()
            } else {
                "LIBRE".to_string()
            };

            map.insert(
                id_mesa,
                MesaMetaOut {
                    ocupada: true,
                    idComanda: id_comanda.clone(),
                    id_comanda,
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
                  R.ID_Mesa, R.ID_Reserva, R.Dia_YMD, R.Hora, R.Estado, C.Nombre AS Cliente_Nombre
                FROM Reservas R
                JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
                WHERE R.ID_Mesa IS NOT NULL AND R.Estado IN ('PROXIMA','ACTIVA');
                "#,
                (),
            )
            .await
            .map_err(db_err)?;

        let now = Local::now();
        let mut best: HashMap<String, ReservaMesaOut> = HashMap::new();

        while let Some(r) = rrows.next().await.map_err(db_err)? {
            let id_mesa = v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default();
            let id_reserva = v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default();
            let dia_ymd = v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default();
            let hora = v_string(r.get_value(3).map_err(db_err)?).unwrap_or_default();
            let estado_db =
                v_string(r.get_value(4).map_err(db_err)?).unwrap_or_else(|| "PROXIMA".into());
            let cliente = v_string(r.get_value(5).map_err(db_err)?).unwrap_or_default();

            if id_mesa.is_empty() || id_reserva.is_empty() {
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
            let estado_ui =
                if estado_db.trim().eq_ignore_ascii_case("ACTIVA") || minutos_para <= 0 {
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

            let replace = match best.get(id_mesa.as_str()) {
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
                    id_comanda: String::new(),
                    idComanda: String::new(),
                    totalPendiente: 0.0,
                    pendientesPago: 0,
                    pendientesCocina: 0,
                    estado: "LIBRE".into(),
                    reserva: Some(reserva),
                });
        }

        Ok(map)
    }

    async fn list_categorias_vendibles(&self) -> AppResult<Vec<CategoriaVendibleOut>> {
        let g = self.db.read().await;
        let db = &g;

        let sql1 = r#"
            SELECT ID_Categoria, Nombre, Ruta_Imagen, COALESCE(Pasa_Cocina,0)
            FROM Categorias_Producto ORDER BY Nombre ASC;
        "#;
        let sql2 = r#"
            SELECT ID_Categoria, Nombre, NULL as Ruta_Imagen, 0 as Pasa_Cocina
            FROM Categorias_Producto ORDER BY Nombre ASC;
        "#;

        let mut rows = match db.query(sql1, ()).await {
            Ok(r) => r,
            Err(_) => db.query(sql2, ()).await.map_err(db_err)?,
        };

        let mut out = vec![];
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(CategoriaVendibleOut {
                id_categoria: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                ruta_imagen: v_string(r.get_value(2).map_err(db_err)?),
                pasa_cocina: v_i64(r.get_value(3).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn list_productos_by_categoria(
        &self,
        id_categoria: &str,
    ) -> AppResult<Vec<ProductoVendibleOut>> {
        let g = self.db.read().await;
        let db = &g;
        let sql1 = r#"
            SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), Ruta_Imagen
            FROM Productos WHERE ID_Categoria = ?1 ORDER BY Nombre ASC;
        "#;
        let sql2 = r#"
            SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), NULL as Ruta_Imagen
            FROM Productos WHERE ID_Categoria = ?1 ORDER BY Nombre ASC;
        "#;
        productos_query(db, sql1, sql2, vec![Value::Text(id_categoria.to_string())]).await
    }

    async fn search_productos_by_nombre(&self, q: String) -> AppResult<Vec<ProductoVendibleOut>> {
        let g = self.db.read().await;
        let db = &g;
        let needle = format!("%{}%", q.trim().to_lowercase());
        let sql1 = r#"
            SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), Ruta_Imagen
            FROM Productos WHERE LOWER(Nombre) LIKE ?1 ORDER BY Nombre ASC LIMIT 200;
        "#;
        let sql2 = r#"
            SELECT ID_Producto, ID_Categoria, Nombre, COALESCE(Precio_Venta,0), NULL as Ruta_Imagen
            FROM Productos WHERE LOWER(Nombre) LIKE ?1 ORDER BY Nombre ASC LIMIT 200;
        "#;
        productos_query(db, sql1, sql2, vec![Value::Text(needle)]).await
    }

    /* ===== TICKET (detalles) ===== */

    async fn remove_one_pending_detalle(
        &self,
        id_comanda: &str,
        id_producto: &str,
    ) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            db.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle = (
                  SELECT dc.ID_Detalle
                  FROM Detalle_Comanda dc
                  WHERE dc.ID_Comanda = ?1
                    AND dc.ID_Producto = ?2
                    AND NOT EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
                  ORDER BY dc.ID_Detalle DESC LIMIT 1
                );
                "#,
                vec![Value::Text(id_comanda.to_string()), Value::Text(id_producto.to_string())],
            )
            .await
            .map_err(db_err)?;

            db.execute(update_total_comanda_sql(), vec![Value::Text(id_comanda.to_string())])
                .await
                .map_err(db_err)?;
            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(())
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn delete_detalle(&self, id_detalle: &str) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            let id_comanda = select_one_i64(
                db,
                "SELECT ID_Comanda FROM Detalle_Comanda WHERE ID_Detalle=?1 LIMIT 1;",
                vec![Value::Text(id_detalle.to_string())],
            )
            .await?;

            db.execute(
                r#"
                DELETE FROM Detalle_Comanda
                WHERE ID_Detalle = ?1
                  AND NOT EXISTS (
                    SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
                  );
                "#,
                vec![Value::Text(id_detalle.to_string())],
            )
            .await
            .map_err(db_err)?;

            if let Some(idc) = id_comanda {
                db.execute(update_total_comanda_sql(), vec![Value::Integer(idc)])
                    .await
                    .map_err(db_err)?;
            }
            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(())
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn update_detalle_nota(&self, id_detalle: &str, nota: Option<String>) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;
        db.execute(
            r#"
            UPDATE Detalle_Comanda
            SET Notas = ?2
            WHERE ID_Detalle = ?1
              AND NOT EXISTS (
                SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = Detalle_Comanda.ID_Detalle
              );
            "#,
            vec![
                Value::Text(id_detalle.to_string()),
                nota.map(Value::Text).unwrap_or(Value::Null),
            ],
        )
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn cobrar_detalles(&self, data: CobroDetalles) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;
        let ids = data.detalle_ids.clone();

        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<()> = async {
            let id_trabajador_cobrador = resolve_trabajador_id_input(db, data.id_usuario.clone()).await?;

            let in_sql = build_in_placeholders(2, ids.len());
            let mut count_args: Vec<Value> = Vec::with_capacity(1 + ids.len());
            count_args.push(Value::Text(data.id_comanda.clone()));
            for id in ids.iter() {
                count_args.push(Value::Text(id.clone()));
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
            let count = select_one_i64(db, &sql_count, count_args.clone())
                .await?
                .unwrap_or(0);

            if count as usize != ids.len() {
                return Err(AppError::conflict(
                    "Algunos detalles no existen, no pertenecen a la comanda o ya están pagados.",
                ));
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
            let total = select_one_f64(db, &sql_sum, count_args.clone())
                .await?
                .unwrap_or(0.0);
            let total = (total * 100.0).round() / 100.0;

            let id_pago = new_id();
            let ok = try_exec(
                db,
                r#"
                INSERT INTO Pagos (
                  ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo,
                  ID_Usuario_Cobrador, ID_Trabajador_Cobrador
                )
                VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, ?5, ?6, ?7);
                "#,
                vec![
                    Value::Text(id_pago.clone()),
                    Value::Text(data.id_comanda.clone()),
                    Value::Text(data.metodo.clone()),
                    Value::Real(total),
                    Value::Text(data.tipo.clone()),
                    data.id_usuario.clone().map(Value::Text).unwrap_or(Value::Null),
                    id_trabajador_cobrador.map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await?;

            if !ok {
                db.execute(
                    r#"
                    INSERT INTO Pagos (
                      ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo, ID_Usuario_Cobrador
                    )
                    VALUES (?1, ?2, datetime('now','localtime'), ?3, ?4, ?5, ?6);
                    "#,
                    vec![
                        Value::Text(id_pago.clone()),
                        Value::Text(data.id_comanda.clone()),
                        Value::Text(data.metodo.clone()),
                        Value::Real(total),
                        Value::Text(data.tipo.clone()),
                        data.id_usuario.clone().map(Value::Text).unwrap_or(Value::Null),
                    ],
                )
                .await
                .map_err(db_err)?;
            }

            if let Err(e) = sumar_gasto_cliente_por_comanda(db, &data.id_comanda, total).await {
                eprintln!("[WARN] sumar_gasto_cliente_por_comanda error: {}", e);
            }

            let mut insert_args: Vec<Value> = Vec::with_capacity(2 + ids.len());
            insert_args.push(Value::Text(id_pago));
            insert_args.push(Value::Text(data.id_comanda.clone()));
            for id in ids.iter() {
                insert_args.push(Value::Text(id.clone()));
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
            db.execute(&sql_insert, insert_args).await.map_err(db_err)?;

            let pending_left = select_one_i64(
                db,
                r#"
                SELECT COUNT(*)
                FROM Detalle_Comanda dc
                LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                WHERE dc.ID_Comanda = ?1 AND pd.ID_Detalle IS NULL;
                "#,
                vec![Value::Text(data.id_comanda.clone())],
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
                        FROM Detalle_Comanda WHERE ID_Comanda = ?1
                      ),
                      Fecha_Hora_Cierre = datetime('now','localtime')
                    WHERE ID_Comanda = ?1;
                    "#,
                    vec![Value::Text(data.id_comanda.clone())],
                )
                .await
                .map_err(db_err)?;
            } else {
                db.execute(update_total_comanda_sql(), vec![Value::Text(data.id_comanda.clone())])
                    .await
                    .map_err(db_err)?;
            }
            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(())
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    /* ===== COCINA ===== */

    async fn kitchen_list_today_pending(&self) -> AppResult<Vec<KitchenRow>> {
        let g = self.db.read().await;
        let db = &g;
        let mut rows = db
            .query(
                r#"
                SELECT
                  c.ID_Comanda, m.Numero_Mesa, c.Fecha_Hora_Apertura,
                  dc.ID_Detalle, COALESCE(dc.Cantidad,1) AS Cantidad,
                  p.Nombre AS Nombre_Producto, dc.Notas,
                  COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle
                  ) THEN 1 ELSE 0 END AS Pagado
                FROM Detalle_Comanda dc
                JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda
                JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
                JOIN Productos p ON p.ID_Producto = dc.ID_Producto
                JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                WHERE COALESCE(cat.Pasa_Cocina, 0) = 1
                  AND datetime(c.Fecha_Hora_Apertura) >= datetime('now','localtime','-2 days')
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
            .map_err(db_err)?;

        let mut out: Vec<KitchenRow> = vec![];
        while let Some(r) = rows.next().await.map_err(db_err)? {
            out.push(KitchenRow {
                id_comanda: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
                numero_mesa: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
                fecha_hora_apertura: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
                id_detalle: v_string(r.get_value(3).map_err(db_err)?).unwrap_or_default(),
                cantidad: v_f64(r.get_value(4).map_err(db_err)?).unwrap_or(1.0),
                nombre_producto: v_string(r.get_value(5).map_err(db_err)?).unwrap_or_default(),
                notas: v_string(r.get_value(6).map_err(db_err)?),
                estado_cocina: v_string(r.get_value(7).map_err(db_err)?),
                pagado: v_i64(r.get_value(8).map_err(db_err)?).unwrap_or(0),
            });
        }
        Ok(out)
    }

    async fn kitchen_set_line_state(
        &self,
        id_detalle: &str,
        id_usuario_cocinero: &str,
        estado: String,
    ) -> AppResult<()> {
        let g = self.db.write().await;
        let db = &g;

        if estado == "PREPARADO" {
            let ok = try_exec(
                db,
                r#"
                UPDATE Detalle_Comanda
                SET
                  Estado_Cocina = 'PREPARADO',
                  ID_Usuario_Cocinero = COALESCE(ID_Usuario_Cocinero, ?2),
                  Fecha_Hora_Cocina   = COALESCE(Fecha_Hora_Cocina, datetime('now','localtime'))
                WHERE ID_Detalle = ?1;
                "#,
                vec![Value::Text(id_detalle.to_string()), Value::Text(id_usuario_cocinero.to_string())],
            )
            .await?;

            if !ok {
                db.execute(
                    "UPDATE Detalle_Comanda SET Estado_Cocina = 'PREPARADO' WHERE ID_Detalle = ?1;",
                    vec![Value::Text(id_detalle.to_string())],
                )
                .await
                .map_err(db_err)?;
            }
        } else {
            let ok = try_exec(
                db,
                r#"
                UPDATE Detalle_Comanda
                SET Estado_Cocina = 'PENDIENTE', ID_Usuario_Cocinero = NULL, Fecha_Hora_Cocina = NULL
                WHERE ID_Detalle = ?1;
                "#,
                vec![Value::Text(id_detalle.to_string())],
            )
            .await?;

            if !ok {
                db.execute(
                    "UPDATE Detalle_Comanda SET Estado_Cocina = 'PENDIENTE' WHERE ID_Detalle = ?1;",
                    vec![Value::Text(id_detalle.to_string())],
                )
                .await
                .map_err(db_err)?;
            }
        }
        Ok(())
    }
}

/// Helper de catálogo con fallback de columna `Ruta_Imagen` inexistente.
async fn productos_query<C: Reader>(
    db: &C,
    sql1: &str,
    sql2: &str,
    args: Vec<Value>,
) -> AppResult<Vec<ProductoVendibleOut>> {
    let mut rows = match db.query(sql1, args.clone()).await {
        Ok(r) => r,
        Err(_) => db.query(sql2, args).await.map_err(db_err)?,
    };

    let mut out = vec![];
    while let Some(r) = rows.next().await.map_err(db_err)? {
        out.push(ProductoVendibleOut {
            id_producto: v_string(r.get_value(0).map_err(db_err)?).unwrap_or_default(),
            id_categoria: v_string(r.get_value(1).map_err(db_err)?).unwrap_or_default(),
            nombre: v_string(r.get_value(2).map_err(db_err)?).unwrap_or_default(),
            precio_venta: v_f64(r.get_value(3).map_err(db_err)?).unwrap_or(0.0),
            ruta_imagen: v_string(r.get_value(4).map_err(db_err)?),
        });
    }
    Ok(out)
}
