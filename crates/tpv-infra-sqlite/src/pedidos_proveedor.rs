//! Adaptador SQLite del repositorio de pedidos a proveedores. Local-First (sin outbox).

use std::sync::Arc;
use std::collections::HashMap;

use async_trait::async_trait;
use libsql::{Row, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::pedidos_proveedor::PedidoProveedorRepository;
use tpv_contracts::pedidos_proveedor::{LineaPedidoDto, PedidoProveedorDto, PedidosPageDto};
use tpv_domain::pedidos_proveedor::{LineaPedidoNueva, PedidoProveedorNuevo};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_real, opt_text, v_f64, v_string};
use crate::util::now_local_datetime;

pub struct SqlitePedidoProveedorRepository {
    db: Arc<Db>,
}

impl SqlitePedidoProveedorRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn s(v: Value) -> String {
    v_string(v).unwrap_or_default()
}
fn f(v: Value) -> f64 {
    v_f64(v).unwrap_or(0.0)
}

fn map_linea(row: &Row) -> AppResult<(String, LineaPedidoDto)> {
    let g = |idx: i32| row.get_value(idx).map_err(db_err);
    let id_pedido = s(g(0)?);
    let linea = LineaPedidoDto {
        id_linea: s(g(1)?),
        nombre_producto: s(g(2)?),
        cantidad: f(g(3)?),
        precio_unitario: norm_opt_string(g(4)?).and_then(|v| v.parse::<f64>().ok()),
        unidad: norm_opt_string(g(5)?),
    };
    Ok((id_pedido, linea))
}

#[async_trait]
impl PedidoProveedorRepository for SqlitePedidoProveedorRepository {
    async fn get_page(
        &self,
        limit: i64,
        offset: i64,
        search: Option<String>,
    ) -> AppResult<PedidosPageDto> {
        let db = self.db.read().await;

        // Filtro opcional: LIKE case-insensitive sobre proveedor/email/notas/estado. El mismo
        // patrón `?1` se reutiliza en los cuatro campos.
        let mut where_params: Vec<Value> = Vec::new();
        let where_sql = if let Some(term) = &search {
            where_params.push(Value::Text(format!("%{term}%")));
            " WHERE pr.Nombre_Empresa LIKE ?1 OR p.Email_Destino LIKE ?1 \
              OR p.Notas LIKE ?1 OR p.Estado LIKE ?1"
                .to_string()
        } else {
            String::new()
        };

        // 1) Total de coincidencias (para paginación en la UI).
        let count_sql = format!(
            "SELECT COUNT(*) FROM Pedidos_Proveedor p \
             LEFT JOIN Proveedores pr ON pr.ID_Proveedor = p.ID_Proveedor{where_sql};"
        );
        let mut crows = db.query(&count_sql, where_params.clone()).await.map_err(db_err)?;
        let total = match crows.next().await.map_err(db_err)? {
            Some(row) => match row.get_value(0).map_err(db_err)? {
                Value::Integer(n) => n,
                _ => 0,
            },
            None => 0,
        };

        // 2) Página de pedidos (LIMIT/OFFSET van tras los parámetros del WHERE).
        let base = where_params.len();
        let sql_pedidos = format!(
            "SELECT p.ID_Pedido, p.ID_Proveedor, pr.Nombre_Empresa, \
                    p.Email_Destino, p.Estado, p.Fecha_Creacion, p.Fecha_Envio, p.Notas \
             FROM Pedidos_Proveedor p \
             LEFT JOIN Proveedores pr ON pr.ID_Proveedor = p.ID_Proveedor{where_sql} \
             ORDER BY p.Fecha_Creacion DESC LIMIT ?{} OFFSET ?{};",
            base + 1,
            base + 2
        );
        let mut page_params = where_params;
        page_params.push(Value::Integer(limit));
        page_params.push(Value::Integer(offset));

        let mut rows = db.query(&sql_pedidos, page_params).await.map_err(db_err)?;
        let mut pedidos: Vec<PedidoProveedorDto> = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            pedidos.push(PedidoProveedorDto {
                id_pedido: s(g(0)?),
                id_proveedor: norm_opt_string(g(1)?),
                nombre_proveedor: norm_opt_string(g(2)?),
                email_destino: norm_opt_string(g(3)?),
                estado: s(g(4)?),
                fecha_creacion: s(g(5)?),
                fecha_envio: norm_opt_string(g(6)?),
                notas: norm_opt_string(g(7)?),
                lineas: Vec::new(),
            });
        }

        if pedidos.is_empty() {
            return Ok(PedidosPageDto { pedidos, total });
        }

        // 3) Líneas SOLO de los pedidos de esta página (IN con placeholders dinámicos), en vez
        //    de recorrer toda la tabla Lineas_Pedido_Proveedor.
        let ids: Vec<String> = pedidos.iter().map(|p| p.id_pedido.clone()).collect();
        let placeholders = (1..=ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let sql_lineas = format!(
            "SELECT ID_Pedido, ID_Linea, Nombre_Producto, Cantidad, Precio_Unitario, Unidad \
             FROM Lineas_Pedido_Proveedor WHERE ID_Pedido IN ({placeholders}) ORDER BY rowid ASC;"
        );
        let lparams: Vec<Value> = ids.into_iter().map(Value::Text).collect();
        let mut lrows = db.query(&sql_lineas, lparams).await.map_err(db_err)?;
        let mut lineas_map: HashMap<String, Vec<LineaPedidoDto>> = HashMap::new();
        while let Some(row) = lrows.next().await.map_err(db_err)? {
            let (id_pedido, linea) = map_linea(&row)?;
            lineas_map.entry(id_pedido).or_default().push(linea);
        }

        for p in &mut pedidos {
            if let Some(ls) = lineas_map.remove(&p.id_pedido) {
                p.lineas = ls;
            }
        }

        Ok(PedidosPageDto { pedidos, total })
    }

    async fn crear(
        &self,
        pedido: PedidoProveedorNuevo,
        lineas: Vec<LineaPedidoNueva>,
    ) -> AppResult<String> {
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let id = pedido.id_pedido.clone();
        let res: AppResult<String> = async {
            let fecha = now_local_datetime();
            conn.execute(
                r#"INSERT INTO Pedidos_Proveedor
                   (ID_Pedido, ID_Proveedor, Email_Destino, Estado, Fecha_Creacion, Notas)
                   VALUES (?1, ?2, ?3, 'borrador', ?4, ?5);"#,
                vec![
                    Value::Text(id.clone()),
                    opt_text(pedido.id_proveedor),
                    opt_text(pedido.email_destino),
                    Value::Text(fecha),
                    opt_text(pedido.notas),
                ],
            )
            .await
            .map_err(db_err)?;

            for l in &lineas {
                conn.execute(
                    r#"INSERT INTO Lineas_Pedido_Proveedor
                       (ID_Linea, ID_Pedido, Nombre_Producto, Cantidad, Precio_Unitario, Unidad)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6);"#,
                    vec![
                        Value::Text(l.id_linea.clone()),
                        Value::Text(id.clone()),
                        Value::Text(l.nombre_producto.clone()),
                        Value::Real(l.cantidad),
                        opt_real(l.precio_unitario),
                        opt_text(l.unidad.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(id.clone())
        }
        .await;
        match res {
            Ok(v) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn actualizar(
        &self,
        id_pedido: &str,
        id_proveedor: Option<String>,
        email_destino: Option<String>,
        notas: Option<String>,
        lineas: Vec<LineaPedidoNueva>,
    ) -> AppResult<bool> {
        let id = id_pedido.to_string();
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            // PROV-01: el guard `Estado='borrador'` debe cubrir TODA la operación, no solo el
            // header. Si el UPDATE no afecta filas, el pedido no existe o ya no es borrador
            // (enviado/cancelado = inmutable): abortamos sin tocar las líneas y devolvemos un
            // resultado veraz (Ok(false)) en vez del engañoso Ok(true).
            let affected = conn
                .execute(
                    r#"UPDATE Pedidos_Proveedor
                       SET ID_Proveedor = ?1, Email_Destino = ?2, Notas = ?3
                       WHERE ID_Pedido = ?4 AND Estado = 'borrador';"#,
                    vec![
                        opt_text(id_proveedor),
                        opt_text(email_destino),
                        opt_text(notas),
                        Value::Text(id.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;

            if affected == 0 {
                return Ok(false);
            }

            conn.execute(
                "DELETE FROM Lineas_Pedido_Proveedor WHERE ID_Pedido = ?1;",
                vec![Value::Text(id.clone())],
            )
            .await
            .map_err(db_err)?;

            for l in &lineas {
                conn.execute(
                    r#"INSERT INTO Lineas_Pedido_Proveedor
                       (ID_Linea, ID_Pedido, Nombre_Producto, Cantidad, Precio_Unitario, Unidad)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6);"#,
                    vec![
                        Value::Text(l.id_linea.clone()),
                        Value::Text(id.clone()),
                        Value::Text(l.nombre_producto.clone()),
                        Value::Real(l.cantidad),
                        opt_real(l.precio_unitario),
                        opt_text(l.unidad.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(true)
        }
        .await;
        match res {
            Ok(v) => {
                conn.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }

    async fn cambiar_estado(
        &self,
        id_pedido: &str,
        estado: &str,
        fecha_envio: Option<String>,
    ) -> AppResult<bool> {
        // PROV-02: un pedido solo transita desde 'borrador' (a 'enviado' o 'cancelado'). El
        // guard `AND Estado='borrador'` hace inmutables los pedidos ya enviados/cancelados:
        // evita re-enviar, re-cancelar o marcar 'enviado' un pedido ya cancelado. Si no hay
        // fila en 'borrador' con ese id, el UPDATE no afecta nada y se devuelve false.
        let db = self.db.write().await;
        let affected = db
            .execute(
                "UPDATE Pedidos_Proveedor SET Estado = ?1, Fecha_Envio = ?2 WHERE ID_Pedido = ?3 AND Estado = 'borrador';",
                vec![
                    Value::Text(estado.to_string()),
                    opt_text(fecha_envio),
                    Value::Text(id_pedido.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }
}
