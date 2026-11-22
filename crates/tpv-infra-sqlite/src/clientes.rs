//! Adaptador SQLite del repositorio de clientes (implementa `ClientesRepository`).
//!
//! Local-First puro: las escrituras son INSERT/UPDATE directos contra la BD local.
//! NO hay outbox ni Applied_Operations (eso era de la antigua sincronización dual).

use crate::util::new_id;
use crate::consultas::{db_err, lista_json};
use tpv_domain::dinero::Dinero;
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::clientes::{ClientesFacturaRepository, ClientesRepository};
use tpv_contracts::clientes::{ClienteForm, ClienteOverview, ClienteParaFactura, ClientesParaFactura};
use tpv_domain::clientes::{Cliente, ClienteRanking, DatosFiscales, NuevoCliente};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_text, v_dinero, v_i64, v_string};

pub struct SqliteClientesRepository {
    db: Arc<Db>,
}

impl SqliteClientesRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

/// Traduce errores de las escrituras de cliente. Una violación del índice único de email
/// (`ux_clientes_email`, sobre `lower(Email)`) es un conflicto con el mismo texto que el worker
/// (`email_duplicado`) y que la reserva que da de alta a un cliente (CLI-04, SYN-INC-07); el resto se
/// propaga como error de repositorio.
fn write_err(e: impl std::fmt::Display) -> AppError {
    let msg = e.to_string();
    if msg.contains("ux_clientes_email") {
        AppError::conflict(crate::reservas::MSG_EMAIL_DE_OTRO)
    } else {
        AppError::repository(msg)
    }
}

// Base del overview. En vez de ~6 subconsultas correlacionadas por cliente (coste
// O(clientes x reservas), CLI-02), se precalcula la última reserva y los agregados en
// dos CTEs que recorren `Reservas` una sola vez (mismo patrón que DB-12 en inventario).
// La salida y el orden de columnas son IDÉNTICOS a la versión anterior. No se limita
// el número de filas: el ranking "Reciente" es la lista completa que el frontend usa
// para buscar/contar (añadir LIMIT rompería esa búsqueda).
fn sql_overview_base() -> &'static str {
    r#"
    WITH ult_reserva AS (
      SELECT
        r.ID_Cliente,
        r.Dia_YMD,
        r.Hora,
        r.Comensales,
        r.ID_Mesa,
        ROW_NUMBER() OVER (
          PARTITION BY r.ID_Cliente
          ORDER BY r.Dia_YMD DESC, r.Hora DESC
        ) AS rn
      FROM Reservas r
    ),
    agg_reservas AS (
      SELECT
        r.ID_Cliente,
        COUNT(*) AS Total_Reservas,
        -- Pendientes: las vivas (por llegar o con el cliente sentado) de hoy en adelante. Antes
        -- contaba sólo ACTIVA, y toda reserva nace PROXIMA: casi siempre salía 0.
        SUM(
          CASE
            WHEN r.Estado IN ('PROXIMA','ACTIVA')
             AND date(r.Dia_YMD) >= date('now','localtime')
            THEN 1 ELSE 0
          END
        ) AS Reservas_Pendientes
      FROM Reservas r
      GROUP BY r.ID_Cliente
    )
    SELECT
      c.ID_Cliente,
      c.Nombre,
      c.Email,
      c.Telefono,

      ur.Dia_YMD    AS Ultima_Reserva_Fecha,
      ur.Hora       AS Ultima_Reserva_Hora,
      ur.Comensales AS Ultima_Reserva_NumPersonas,
      m.Numero_Mesa AS Ultima_Reserva_Mesa,

      IFNULL(c.Total_Gastado, 0) AS Total_Gastado_Stored,

      COALESCE(ar.Total_Reservas, 0)      AS Total_Reservas,
      COALESCE(ar.Reservas_Pendientes, 0) AS Reservas_Pendientes

    FROM Clientes c
    LEFT JOIN ult_reserva ur ON ur.ID_Cliente = c.ID_Cliente AND ur.rn = 1
    LEFT JOIN Mesas m        ON m.ID_Mesa = ur.ID_Mesa
    LEFT JOIN agg_reservas ar ON ar.ID_Cliente = c.ID_Cliente
    "#
}

#[async_trait]
impl ClientesRepository for SqliteClientesRepository {
    async fn overview(&self, ranking: ClienteRanking) -> AppResult<Vec<ClienteOverview>> {
        let base = sql_overview_base();

        let sql = match ranking {
            ClienteRanking::PorReservas => format!(
                "{base}\nORDER BY Total_Reservas DESC, Total_Gastado_Stored DESC, c.ID_Cliente DESC\nLIMIT 10;"
            ),
            ClienteRanking::PorGasto => format!(
                "{base}\nORDER BY Total_Gastado_Stored DESC, Total_Reservas DESC, c.ID_Cliente DESC\nLIMIT 10;"
            ),
            // RI-59: «reciente» es la fecha de alta; la clave sólo desempata.
            ClienteRanking::Reciente => {
                format!("{base}\nORDER BY c.Created_At DESC, c.ID_Cliente DESC;")
            }
        };

        let db = self.db.read().await;
        let mut rows = db.query(&sql, ()).await.map_err(db_err)?;
        let mut out: Vec<ClienteOverview> = Vec::new();

        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id_cliente = row.get_value(0).map_err(db_err)?;
            let nombre = row.get_value(1).map_err(db_err)?;
            let email = row.get_value(2).map_err(db_err)?;
            let telefono = row.get_value(3).map_err(db_err)?;
            let ur_fecha = row.get_value(4).map_err(db_err)?;
            let ur_hora = row.get_value(5).map_err(db_err)?;
            let ur_num = row.get_value(6).map_err(db_err)?;
            let ur_mesa = row.get_value(7).map_err(db_err)?;
            let tg_st = row.get_value(8).map_err(db_err)?;
            let total_res = row.get_value(9).map_err(db_err)?;
            let pend = row.get_value(10).map_err(db_err)?;

            out.push(ClienteOverview {
                id_cliente: v_string(id_cliente).unwrap_or_default(),
                nombre: v_string(nombre).unwrap_or_default(),
                email: norm_opt_string(email),
                telefono: norm_opt_string(telefono),

                ultima_reserva_fecha: norm_opt_string(ur_fecha),
                ultima_reserva_hora: norm_opt_string(ur_hora),
                ultima_reserva_num_personas: v_i64(ur_num),
                ultima_reserva_mesa: norm_opt_string(ur_mesa),

                total_gastado_stored: v_dinero(tg_st).unwrap_or(Dinero::CERO),

                total_reservas: v_i64(total_res).unwrap_or(0),
                reservas_pendientes: v_i64(pend).unwrap_or(0),
            });
        }

        Ok(out)
    }

    async fn form(&self, id_cliente: &str) -> AppResult<Option<ClienteForm>> {
        let sql = r#"
          SELECT Nombre, Email, Telefono, Notas, NIF, Razon_Social, Direccion_Fiscal
          FROM Clientes
          WHERE ID_Cliente = ?
          LIMIT 1;
        "#;

        let db = self.db.read().await;
        let mut rows = db
            .query(sql, vec![Value::Text(id_cliente.to_string())])
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };

        let nombre = row.get_value(0).map_err(db_err)?;
        let email = row.get_value(1).map_err(db_err)?;
        let telefono = row.get_value(2).map_err(db_err)?;
        let notas = row.get_value(3).map_err(db_err)?;
        let nif = row.get_value(4).map_err(db_err)?;
        let razon_social = row.get_value(5).map_err(db_err)?;
        let direccion_fiscal = row.get_value(6).map_err(db_err)?;

        Ok(Some(ClienteForm {
            nombre: v_string(nombre).unwrap_or_default(),
            email: norm_opt_string(email),
            telefono: norm_opt_string(telefono),
            notas: norm_opt_string(notas),
            nif: norm_opt_string(nif),
            razon_social: norm_opt_string(razon_social),
            direccion_fiscal: norm_opt_string(direccion_fiscal),
        }))
    }

    // NOTA (CLI-06): `create` es un UPSERT por `ID_Cliente` (INSERT ... ON CONFLICT DO
    // UPDATE), no un alta estricta. Es intencional: hace la operación idempotente si el
    // mismo id se reaplica (p. ej. reintentos o catch-up de sync), en vez de reventar con
    // un conflicto de PK. Los conflictos de OTRO cliente con el mismo email sí se rechazan
    // (índice ux_clientes_email → `write_err`). El alta de UI normal llega sin id y genera
    // uno nuevo, así que el camino de conflicto por id sólo ocurre en reaplicaciones.
    async fn create(&self, nuevo: NuevoCliente) -> AppResult<bool> {
        let id_cliente = nuevo.id.unwrap_or_else(new_id);

        let db = self.db.write().await;
        db.execute(
            r#"
                INSERT INTO Clientes (
                    ID_Cliente,
                    Nombre,
                    Telefono,
                    Email,
                    Notas,
                    NIF,
                    Razon_Social,
                    Direccion_Fiscal,
                    Created_At
                )
                VALUES (
                    ?1,
                    ?2,
                    ?3,
                    ?4,
                    ?5,
                    ?6,
                    ?7,
                    ?8,
                    datetime('now','localtime')
                )
                ON CONFLICT(ID_Cliente) DO UPDATE SET
                    Nombre = excluded.Nombre,
                    Telefono = excluded.Telefono,
                    Email = excluded.Email,
                    Notas = excluded.Notas,
                    NIF = excluded.NIF,
                    Razon_Social = excluded.Razon_Social,
                    Direccion_Fiscal = excluded.Direccion_Fiscal;
                "#,
            vec![
                Value::Text(id_cliente),
                Value::Text(nuevo.nombre),
                opt_text(nuevo.telefono),
                opt_text(nuevo.email),
                opt_text(nuevo.notas),
                opt_text(nuevo.fiscal.nif),
                opt_text(nuevo.fiscal.razon_social),
                opt_text(nuevo.fiscal.direccion_fiscal),
            ],
        )
        .await
        .map_err(write_err)?;

        Ok(true)
    }

    async fn update(&self, cliente: Cliente) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                r#"
                UPDATE Clientes
                SET
                  Nombre = ?1,
                  Telefono = ?2,
                  Email = ?3,
                  Notas = ?4,
                  NIF = ?5,
                  Razon_Social = ?6,
                  Direccion_Fiscal = ?7
                WHERE ID_Cliente = ?8;
                "#,
                vec![
                    Value::Text(cliente.nombre),
                    opt_text(cliente.telefono),
                    opt_text(cliente.email),
                    opt_text(cliente.notas),
                    opt_text(cliente.fiscal.nif),
                    opt_text(cliente.fiscal.razon_social),
                    opt_text(cliente.fiscal.direccion_fiscal),
                    Value::Text(cliente.id),
                ],
            )
            .await
            .map_err(write_err)?;

        Ok(affected > 0)
    }
}

/// FISCAL-03 · Los clientes que tenían el gasto de las comandas de estos cobros (`?1`, lista JSON),
/// salvo el que lo va a recibir (`?2`): el de la comanda o, si no lo tiene, el de su reserva, que es
/// el criterio del gasto acreditado (`mesas.rs`, `reconciliacion.rs`).
const SQL_QUIEN_TENIA_EL_GASTO: &str = "SELECT DISTINCT COALESCE(co.ID_Cliente, r.ID_Cliente)      FROM Pagos p JOIN Comandas co ON co.ID_Comanda = p.ID_Comanda      LEFT JOIN Reservas r ON r.ID_Reserva = co.ID_Reserva      WHERE p.ID_Pago IN (SELECT value FROM json_each(?1))        AND COALESCE(co.ID_Cliente, r.ID_Cliente) IS NOT NULL        AND COALESCE(co.ID_Cliente, r.ID_Cliente) <> ?2;";

/// FISCAL-03 · Las comandas de estos cobros (`?2`) pasan a nombre del cliente `?1`.
const SQL_APUNTAR_GASTO: &str = "UPDATE Comandas SET ID_Cliente = ?1      WHERE ID_Comanda IN (SELECT ID_Comanda FROM Pagos WHERE ID_Pago IN (SELECT value FROM json_each(?2)))        AND (ID_Cliente IS NULL OR ID_Cliente <> ?1);";

/// FISCAL-02 · Las fichas desde el formulario de la factura completa. Sólo en la Main; las
/// escrituras van por el `WriteGuard` como las de la ficha, así que se replican.
#[async_trait]
impl ClientesFacturaRepository for SqliteClientesRepository {
    async fn para_factura(&self, id_comanda: Option<&str>) -> AppResult<ClientesParaFactura> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                "SELECT ID_Cliente, Nombre, NIF, Razon_Social, Direccion_Fiscal FROM Clientes \
                 ORDER BY Nombre, ID_Cliente;",
                (),
            )
            .await
            .map_err(db_err)?;
        let mut clientes = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            clientes.push(ClienteParaFactura {
                id_cliente: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                nif: norm_opt_string(row.get_value(2).map_err(db_err)?),
                razon_social: norm_opt_string(row.get_value(3).map_err(db_err)?),
                direccion_fiscal: norm_opt_string(row.get_value(4).map_err(db_err)?),
            });
        }

        // El cliente de la comanda: el que ya tiene o, si no, el de su reserva. Es el criterio del gasto
        // acreditado (`mesas.rs`, `cuentas.rs`).
        let mut id_cliente_de_la_comanda = None;
        if let Some(id_comanda) = id_comanda {
            let mut rows = db
                .query(
                    "SELECT COALESCE(c.ID_Cliente, r.ID_Cliente) FROM Comandas c \
                     LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva \
                     WHERE c.ID_Comanda = ?1 AND COALESCE(c.ID_Cliente, r.ID_Cliente) IS NOT NULL LIMIT 1;",
                    vec![Value::Text(id_comanda.to_string())],
                )
                .await
                .map_err(db_err)?;
            if let Some(row) = rows.next().await.map_err(db_err)? {
                id_cliente_de_la_comanda = v_string(row.get_value(0).map_err(db_err)?);
            }
        }
        Ok(ClientesParaFactura { clientes, id_cliente_de_la_comanda })
    }

    async fn id_por_nif(&self, nif: &str) -> AppResult<Option<String>> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                // «La más reciente» por su fecha de alta; la clave sólo desempata.
                "SELECT ID_Cliente FROM Clientes WHERE NIF = ?1 ORDER BY Created_At DESC, ID_Cliente DESC LIMIT 1;",
                vec![Value::Text(nif.to_string())],
            )
            .await
            .map_err(db_err)?;
        match rows.next().await.map_err(db_err)? {
            Some(row) => Ok(v_string(row.get_value(0).map_err(db_err)?)),
            None => Ok(None),
        }
    }

    async fn actualizar_datos_fiscales(&self, id_cliente: &str, datos: &DatosFiscales) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                "UPDATE Clientes SET NIF = ?1, Razon_Social = ?2, Direccion_Fiscal = ?3 WHERE ID_Cliente = ?4;",
                vec![
                    opt_text(datos.nif.clone()),
                    opt_text(datos.razon_social.clone()),
                    opt_text(datos.direccion_fiscal.clone()),
                    Value::Text(id_cliente.to_string()),
                ],
            )
            .await
            .map_err(write_err)?;
        Ok(affected > 0)
    }

    async fn alta_con_datos_fiscales(&self, nombre: &str, datos: &DatosFiscales) -> AppResult<String> {
        let id_cliente = new_id();
        let db = self.db.write().await;
        db.execute(
            "INSERT INTO Clientes (ID_Cliente, Nombre, NIF, Razon_Social, Direccion_Fiscal, Created_At) \
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now','localtime'));",
            vec![
                Value::Text(id_cliente.clone()),
                Value::Text(nombre.to_string()),
                opt_text(datos.nif.clone()),
                opt_text(datos.razon_social.clone()),
                opt_text(datos.direccion_fiscal.clone()),
            ],
        )
        .await
        .map_err(write_err)?;
        Ok(id_cliente)
    }

    async fn apuntar_gasto(&self, id_cliente: &str, ids_pago: &[String]) -> AppResult<u64> {
        if ids_pago.is_empty() {
            return Ok(0);
        }
        let ids = lista_json(ids_pago);
        let cliente = Value::Text(id_cliente.to_string());
        let g = self.db.write().await;
        g.transaccion(async {
            // Quién tenía hasta ahora el gasto de esas comandas: el de la comanda o el de su reserva.
            let mut anteriores = Vec::new();
            let mut rows = g
                .query(SQL_QUIEN_TENIA_EL_GASTO, vec![ids.clone(), cliente.clone()])
                .await
                .map_err(db_err)?;
            while let Some(row) = rows.next().await.map_err(db_err)? {
                if let Some(id) = v_string(row.get_value(0).map_err(db_err)?) {
                    anteriores.push(id);
                }
            }
            drop(rows);
            let cambiadas = g
                .execute(SQL_APUNTAR_GASTO, vec![cliente.clone(), ids.clone()])
                .await
                .map_err(write_err)?;
            if cambiadas > 0 {
                // El gasto se re-deriva de los cobros, no se suma ni se resta: así coincide con la
                // reconciliación (`SQL_REDERIVAR_GASTO`) aunque el cobro se anule después.
                for id in anteriores.iter().map(String::as_str).chain(std::iter::once(id_cliente)) {
                    g.execute(crate::reconciliacion::SQL_REDERIVAR_GASTO, vec![Value::Text(id.to_string())])
                        .await
                        .map_err(write_err)?;
                }
            }
            Ok(cambiadas)
        })
        .await
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use tpv_contracts::errors::ErrorCode;

    #[tokio::test]
    async fn un_correo_de_otro_cliente_se_rechaza_con_el_mismo_texto_que_el_worker() {
        // SYN-INC-07: la Main decía «Ya existe un cliente con ese email.» y el worker y las reservas
        // «Ya hay un cliente con ese correo.». Uno solo, y un conflicto como el 409 del worker.
        let dir = crate::test_temp::dir_temporal("clientes-correo");
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let repo = SqliteClientesRepository::new(db.clone());
        let ana = |id: &str, email: &str| NuevoCliente {
            id: Some(id.into()),
            nombre: "Ana".into(),
            email: Some(email.into()),
            telefono: None,
            notas: None,
            fiscal: DatosFiscales::default(),
        };
        repo.create(ana("c1", "ana@bar.test")).await.unwrap();

        let e = repo.create(ana("c2", "ANA@bar.test")).await.unwrap_err();
        assert_eq!((e.code(), e.to_string()), (ErrorCode::Conflict, "Ya hay un cliente con ese correo.".to_string()));

        repo.create(ana("c3", "bea@bar.test")).await.unwrap();
        let e = repo
            .update(Cliente { id: "c3".into(), nombre: "Bea".into(), email: Some("ana@bar.test".into()), telefono: None, notas: None, fiscal: DatosFiscales::default() })
            .await
            .unwrap_err();
        assert_eq!(e.to_string(), "Ya hay un cliente con ese correo.");
    }

    #[tokio::test]
    async fn el_gasto_de_un_cobro_facturado_pasa_a_la_ficha_de_la_factura() {
        // FISCAL-03: la mesa es de la reserva de Ana, pero la factura sale a nombre de la empresa: el
        // gasto de ese cobro deja de ser de Ana y pasa a la empresa, re-derivado de los cobros.
        let dir = crate::test_temp::dir_temporal("clientes-gasto-factura");
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let repo = SqliteClientesRepository::new(db.clone());
        {
            let w = db.write().await;
            for sql in [
                "INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('ana', 'Ana', 2550), ('emp', 'Comidas SL', 0);",
                "INSERT INTO Reservas (ID_Reserva, ID_Cliente, Dia_YMD, Hora, Turno, Comensales, Estado, Created_At, Origen) VALUES ('r1', 'ana', '2026-01-02', '13:00', 'COMIDA', 2, 'ACTIVA', '2026-01-01 10:00:00', 'TPV');",
                "INSERT INTO Comandas (ID_Comanda, ID_Reserva, Canal, Fecha_Hora_Apertura, Estado) VALUES ('k1', 'r1', 'BARRA', '2026-01-02 13:00:00', 'Pagada');",
                "INSERT INTO Pagos (ID_Pago, ID_Comanda, Fecha_Hora, Metodo_Pago, Importe_Total, Tipo) VALUES ('p1', 'k1', '2026-01-02 14:00:00', 'Efectivo', 2550, 'TOTAL');",
            ] {
                w.execute(sql, ()).await.unwrap();
            }
        }
        let gasto = |id: &'static str| {
            let db = db.clone();
            async move {
                let r = db.read().await;
                let mut rows = r
                    .query("SELECT Total_Gastado FROM Clientes WHERE ID_Cliente = ?1;", vec![Value::Text(id.into())])
                    .await
                    .unwrap();
                v_dinero(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap()
            }
        };

        assert_eq!(repo.apuntar_gasto("emp", &[]).await.unwrap(), 0);
        assert_eq!(repo.apuntar_gasto("emp", &["p1".to_string()]).await.unwrap(), 1);
        assert_eq!(gasto("ana").await, Dinero::CERO);
        assert_eq!(gasto("emp").await, Dinero::de_centimos(2550));
        // Repetirlo no cambia nada: la comanda ya es de la empresa.
        assert_eq!(repo.apuntar_gasto("emp", &["p1".to_string()]).await.unwrap(), 0);
        assert_eq!(gasto("emp").await, Dinero::de_centimos(2550));
    }

    #[tokio::test]
    async fn la_factura_lee_las_fichas_y_el_cliente_de_la_reserva_y_guarda_solo_los_datos_fiscales() {
        // FISCAL-02: lo que lee el formulario de la factura y lo que escribe al guardar en la ficha.
        let dir = crate::test_temp::dir_temporal("clientes-factura");
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let repo = SqliteClientesRepository::new(db.clone());
        repo.create(NuevoCliente {
            id: Some("c1".into()),
            nombre: "Ana".into(),
            email: Some("ana@bar.test".into()),
            telefono: Some("600".into()),
            notas: Some("VIP".into()),
            fiscal: DatosFiscales::default(),
        })
        .await
        .unwrap();
        {
            let w = db.write().await;
            w.execute(
                "INSERT INTO Reservas (ID_Reserva, ID_Cliente, Dia_YMD, Hora, Turno, Comensales, Estado, Created_At, Origen) \
                 VALUES ('r1', 'c1', '2099-01-01', '21:00', 'CENA', 2, 'ACTIVA', '2026-01-01 10:00:00', 'TPV');",
                (),
            )
            .await
            .unwrap();
            w.execute(
                "INSERT INTO Comandas (ID_Comanda, ID_Reserva, Canal, Fecha_Hora_Apertura, Estado) VALUES ('k1', 'r1', 'BARRA', '2026-01-01 21:00:00', 'Abierta');",
                (),
            )
            .await
            .unwrap();
        }

        let datos = DatosFiscales {
            nif: Some("B12345674".into()),
            razon_social: Some("Comidas SL".into()),
            direccion_fiscal: None,
        };
        assert!(repo.actualizar_datos_fiscales("c1", &datos).await.unwrap());
        assert!(!repo.actualizar_datos_fiscales("no-existe", &datos).await.unwrap());
        assert_eq!(repo.id_por_nif("B12345674").await.unwrap().as_deref(), Some("c1"));
        assert_eq!(repo.id_por_nif("A58818501").await.unwrap(), None);

        // Guardar los datos fiscales no toca el resto de la ficha.
        let form = repo.form("c1").await.unwrap().unwrap();
        assert_eq!((form.email.as_deref(), form.telefono.as_deref(), form.notas.as_deref()), (Some("ana@bar.test"), Some("600"), Some("VIP")));
        assert_eq!((form.nif.as_deref(), form.razon_social.as_deref()), (Some("B12345674"), Some("Comidas SL")));

        let nueva = repo
            .alta_con_datos_fiscales("Otra SA", &DatosFiscales { nif: Some("A58818501".into()), razon_social: Some("Otra SA".into()), direccion_fiscal: Some("Gran Vía 1".into()) })
            .await
            .unwrap();
        let lista = repo.para_factura(Some("k1")).await.unwrap();
        assert_eq!(lista.id_cliente_de_la_comanda.as_deref(), Some("c1"));
        assert_eq!(lista.clientes.iter().map(|c| c.nombre.as_str()).collect::<Vec<_>>(), ["Ana", "Otra SA"]);
        assert_eq!(lista.clientes[1].id_cliente, nueva);
        assert_eq!(lista.clientes[1].direccion_fiscal.as_deref(), Some("Gran Vía 1"));
        assert_eq!(repo.para_factura(None).await.unwrap().id_cliente_de_la_comanda, None);
    }
}
