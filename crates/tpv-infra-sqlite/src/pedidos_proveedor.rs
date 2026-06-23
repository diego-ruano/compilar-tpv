//! Adaptador SQLite del repositorio de pedidos a proveedores. Local-First (sin outbox).

use std::sync::Arc;
use std::collections::HashMap;

use async_trait::async_trait;
use libsql::{Row, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::pedidos_proveedor::PedidoProveedorRepository;
use tpv_contracts::pedidos_proveedor::{LineaPedidoDto, PedidoProveedorDto};
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
    async fn get_all(&self) -> AppResult<Vec<PedidoProveedorDto>> {
        let db = self.db.read().await;

        // 1) Pedidos con nombre de proveedor
        let sql_pedidos = r#"
            SELECT p.ID_Pedido, p.ID_Proveedor, pr.Nombre_Empresa,
                   p.Email_Destino, p.Estado, p.Fecha_Creacion, p.Fecha_Envio, p.Notas
            FROM Pedidos_Proveedor p
            LEFT JOIN Proveedores pr ON pr.ID_Proveedor = p.ID_Proveedor
            ORDER BY p.Fecha_Creacion DESC;
        "#;
        let mut rows = db.query(sql_pedidos, ()).await.map_err(db_err)?;
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
            return Ok(pedidos);
        }

        // 2) Todas las líneas en una sola query
        let sql_lineas = r#"
            SELECT ID_Pedido, ID_Linea, Nombre_Producto, Cantidad, Precio_Unitario, Unidad
            FROM Lineas_Pedido_Proveedor
            ORDER BY rowid ASC;
        "#;
        let mut lrows = db.query(sql_lineas, ()).await.map_err(db_err)?;
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

        Ok(pedidos)
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
            conn.execute(
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
        let db = self.db.write().await;
        let affected = db
            .execute(
                "UPDATE Pedidos_Proveedor SET Estado = ?1, Fecha_Envio = ?2 WHERE ID_Pedido = ?3;",
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
