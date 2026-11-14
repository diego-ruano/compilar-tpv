//! Adaptador SQLite del repositorio de pedidos a proveedores. Local-First (sin outbox).

use crate::util::now_local_datetime;
use crate::consultas::{db_err};
use std::sync::Arc;
use std::collections::HashMap;

use async_trait::async_trait;
use crate::ejecutor::Value;
use crate::ejecutor::Row;

use tpv_application::error::AppResult;
use tpv_application::ports::pedidos_proveedor::PedidoProveedorRepository;
use tpv_contracts::pedidos_proveedor::{LineaPedidoDto, PedidoProveedorDto, PedidosPageDto};
use tpv_domain::pedidos_proveedor::{LineaPedidoNueva, PedidoProveedorNuevo};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_dinero, opt_text, v_dinero, v_f64, v_string};

pub struct SqlitePedidoProveedorRepository {
    db: Arc<Db>,
}

impl SqlitePedidoProveedorRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
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
        precio_unitario: v_dinero(g(4)?),
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

        // Filtro opcional sobre proveedor, correo, notas y estado: sin acentos ni mayúsculas, con
        // la misma expresión que los demás buscadores (`busqueda.rs`), y con lo escrito tal cual
        // (RI-52: con `instr` el `%` y el `_` no son comodines). El mismo `?1` en los cuatro.
        let mut where_params: Vec<Value> = Vec::new();
        let where_sql = match search.as_deref().and_then(crate::busqueda::texto_a_buscar) {
            Some(texto) => {
                where_params.push(Value::Text(texto));
                let en = |col: &str| format!("instr({}, ?1) > 0", crate::busqueda::normalizada(col));
                format!(
                    " WHERE {} OR {} OR {} OR {}",
                    en("pr.Nombre_Empresa"),
                    en("p.Email_Destino"),
                    en("p.Notas"),
                    en("p.Estado")
                )
            }
            None => String::new(),
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
        let id = pedido.id_pedido.clone();
        conn.transaccion(async {
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
                        opt_dinero(l.precio_unitario),
                        opt_text(l.unidad.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(id.clone())
        }).await
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
        let res: AppResult<bool> = conn.transaccion(async {
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
                        opt_dinero(l.precio_unitario),
                        opt_text(l.unidad.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(true)
        }).await;

        res
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

#[cfg(test)]
mod tests_busqueda {
    //! RI-52: lo que se escribe en el buscador se busca tal cual; `%` y `_` no son comodines. Y sin
    //! acentos ni mayúsculas, como los demás buscadores (`busqueda.rs`).

    use super::*;

    async fn abrir() -> (SqlitePedidoProveedorRepository, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("pedidos_busqueda");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Pedidos_Proveedor (ID_Pedido, Estado, Fecha_Creacion, Notas) \
                       VALUES ('p-50', 'borrador', '2026-01-01 10:00:00', 'descuento 50%'); \
                     INSERT INTO Pedidos_Proveedor (ID_Pedido, Estado, Fecha_Creacion, Notas) \
                       VALUES ('p-500', 'borrador', '2026-01-02 10:00:00', 'pedir 500 cajas'); \
                     INSERT INTO Pedidos_Proveedor (ID_Pedido, Estado, Fecha_Creacion, Notas) \
                       VALUES ('p-ab', 'borrador', '2026-01-03 10:00:00', 'ref a_b'); \
                     INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa) VALUES ('pr-1', 'CAFÉS Ñandú'); \
                     INSERT INTO Pedidos_Proveedor (ID_Pedido, ID_Proveedor, Estado, Fecha_Creacion, Notas) \
                       VALUES ('p-cafe', 'pr-1', 'enviado', '2026-01-04 10:00:00', 'Crème brûlée');",
                )
                .await
                .unwrap();
        }
        (SqlitePedidoProveedorRepository::new(db), dir)
    }

    async fn ids(repo: &SqlitePedidoProveedorRepository, q: &str) -> Vec<String> {
        let page = repo.get_page(50, 0, Some(q.into())).await.unwrap();
        let mut v: Vec<String> = page.pedidos.into_iter().map(|p| p.id_pedido).collect();
        v.sort();
        v
    }

    #[tokio::test]
    async fn el_porcentaje_y_el_guion_bajo_se_buscan_tal_cual() {
        let (repo, _dir) = abrir().await;
        assert_eq!(ids(&repo, "50%").await, vec!["p-50"]);
        assert_eq!(ids(&repo, "a_b").await, vec!["p-ab"]);
        assert_eq!(ids(&repo, "_").await, vec!["p-ab"]);
        assert_eq!(ids(&repo, "50").await, vec!["p-50", "p-500"]);
    }

    #[tokio::test]
    async fn sin_acentos_ni_mayusculas_en_cada_campo() {
        let (repo, _dir) = abrir().await;
        // El proveedor por su nombre, las notas y el estado.
        assert_eq!(ids(&repo, "cafes nandu").await, vec!["p-cafe"]);
        assert_eq!(ids(&repo, "ÑANDÚ").await, vec!["p-cafe"]);
        assert_eq!(ids(&repo, "CREME BRULEE").await, vec!["p-cafe"]);
        assert_eq!(ids(&repo, "Enviado").await, vec!["p-cafe"]);
        // Un acento suelto no es buscar nada: no filtra.
        assert_eq!(ids(&repo, "\u{301}").await.len(), 4);
    }
}

