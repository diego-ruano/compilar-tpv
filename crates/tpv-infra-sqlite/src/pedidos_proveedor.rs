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

/// El nombre del proveedor de un pedido: el actual si el proveedor sigue, y si se borró
/// (`ID_Proveedor` a NULL por su `ON DELETE SET NULL`), el que tenía al guardar o enviar el pedido.
const NOMBRE_DEL_PROVEEDOR: &str = "COALESCE(pr.Nombre_Empresa, p.Nombre_Proveedor)";

/// La copia del nombre del proveedor `param`, sacada de la propia base en la sentencia (en la nube,
/// de la suya): un pedido guardado o enviado conserva a quién se le hizo aunque el proveedor se borre.
fn nombre_de(param: &str) -> String {
    format!("(SELECT Nombre_Empresa FROM Proveedores WHERE ID_Proveedor = {param})")
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
                    en(NOMBRE_DEL_PROVEEDOR),
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
            "SELECT p.ID_Pedido, p.ID_Proveedor, {NOMBRE_DEL_PROVEEDOR}, \
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
                &format!(
                    "INSERT INTO Pedidos_Proveedor \
                       (ID_Pedido, ID_Proveedor, Email_Destino, Estado, Fecha_Creacion, Notas, Nombre_Proveedor) \
                     VALUES (?1, ?2, ?3, 'borrador', ?4, ?5, {});",
                    nombre_de("?2")
                ),
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
                    &format!(
                        "UPDATE Pedidos_Proveedor \
                            SET ID_Proveedor = ?1, Email_Destino = ?2, Notas = ?3, Nombre_Proveedor = {} \
                          WHERE ID_Pedido = ?4 AND Estado = 'borrador';",
                        nombre_de("?1")
                    ),
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
                // Al enviarlo (o cancelarlo) se vuelve a copiar el nombre del proveedor, si sigue.
                &format!(
                    "UPDATE Pedidos_Proveedor \
                        SET Estado = ?1, Fecha_Envio = ?2, Nombre_Proveedor = COALESCE({}, Nombre_Proveedor) \
                      WHERE ID_Pedido = ?3 AND Estado = 'borrador';",
                    nombre_de("Pedidos_Proveedor.ID_Proveedor")
                ),
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


#[cfg(test)]
mod tests_nombre_del_proveedor {
    //! Al borrar un proveedor, sus pedidos se quedan sin él (`ON DELETE SET NULL`) y el nombre salía
    //! de un JOIN: un pedido ya enviado pasaba a «Sin proveedor». Ahora el pedido guarda una copia
    //! del nombre al guardarlo y al enviarlo, y se lee la del proveedor si sigue.

    use super::*;

    async fn abrir() -> (SqlitePedidoProveedorRepository, Arc<Db>) {
        let dir = crate::test_temp::dir_temporal("pedidos_nombre");
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        db.write()
            .await
            .raw()
            .execute_batch(
                "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa) VALUES ('pr-1', 'Bebidas Sur'), ('pr-2', 'Cafés Ñandú');",
            )
            .await
            .unwrap();
        (SqlitePedidoProveedorRepository::new(db.clone()), db)
    }

    async fn nombre(repo: &SqlitePedidoProveedorRepository, id: &str) -> Option<String> {
        let page = repo.get_page(50, 0, None).await.unwrap();
        page.pedidos.into_iter().find(|p| p.id_pedido == id).and_then(|p| p.nombre_proveedor)
    }

    fn nuevo(id: &str, proveedor: &str) -> PedidoProveedorNuevo {
        PedidoProveedorNuevo { id_pedido: id.into(), id_proveedor: Some(proveedor.into()), email_destino: None, notas: None }
    }

    #[tokio::test]
    async fn un_pedido_enviado_sigue_diciendo_a_quien_se_le_pidio_aunque_se_borre_el_proveedor() {
        let (repo, db) = abrir().await;
        repo.crear(nuevo("p-1", "pr-2"), vec![]).await.unwrap();
        // Se cambia de proveedor al editarlo, y se envía.
        assert!(repo.actualizar("p-1", Some("pr-1".into()), None, None, vec![]).await.unwrap());
        assert!(repo.cambiar_estado("p-1", "enviado", Some("15/1/27 10:00".into())).await.unwrap());
        assert_eq!(nombre(&repo, "p-1").await.as_deref(), Some("Bebidas Sur"));

        // Se renombra: sale el nombre de ahora.
        db.write().await.raw().execute_batch("UPDATE Proveedores SET Nombre_Empresa = 'Bebidas del Sur SL' WHERE ID_Proveedor = 'pr-1';").await.unwrap();
        assert_eq!(nombre(&repo, "p-1").await.as_deref(), Some("Bebidas del Sur SL"));

        // Se borra (como hace la Main: el pedido se queda sin proveedor): sale la copia, y se busca
        // por ella.
        db.write()
            .await
            .raw()
            .execute_batch("UPDATE Pedidos_Proveedor SET ID_Proveedor = NULL WHERE ID_Proveedor = 'pr-1'; DELETE FROM Proveedores WHERE ID_Proveedor = 'pr-1';")
            .await
            .unwrap();
        assert_eq!(nombre(&repo, "p-1").await.as_deref(), Some("Bebidas Sur"));
        let buscado = repo.get_page(50, 0, Some("bebidas sur".into())).await.unwrap();
        assert_eq!(buscado.pedidos.len(), 1);
    }

    #[tokio::test]
    async fn la_copia_sube_en_la_misma_sentencia_y_no_como_un_literal() {
        // En la nube la copia sale de su base al aplicar la sentencia, como aquí.
        let (repo, db) = abrir().await;
        repo.crear(nuevo("p-2", "pr-2"), vec![]).await.unwrap();
        let r = db.read().await;
        let mut f = r.conn().query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;", ()).await.unwrap();
        let Value::Text(json) = f.next().await.unwrap().unwrap().get_value(0).unwrap() else { panic!() };
        assert!(json.contains("Nombre_Proveedor") && json.contains("SELECT Nombre_Empresa FROM Proveedores"), "{json}");
        assert!(!json.contains("Ñandú"), "{json}");
    }
}
