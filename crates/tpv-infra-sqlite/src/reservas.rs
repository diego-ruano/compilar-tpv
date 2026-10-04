//! Adaptador SQLite del repositorio de reservas. Local-First puro (sin outbox/applied).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::{Row, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reservas::ReservasRepository;
use tpv_contracts::reservas::{ClienteCoincidente, MesaDto, ReservaDto, ReservasMetaDto, ZonaDto};
use tpv_contracts::errors::ErrorCode;
use tpv_domain::reservas::{ClienteReserva, ModoSolape, ReservaValidada, DURACION_POR_DEFECTO_MIN};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_text, v_i64, v_string};
use crate::util::new_id;

pub struct SqliteReservasRepository {
    db: Arc<Db>,
}

impl SqliteReservasRepository {
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

fn i(v: Value) -> i64 {
    v_i64(v).unwrap_or(0)
}

fn opt_int(o: Option<i64>) -> Value {
    o.map(Value::Integer).unwrap_or(Value::Null)
}

async fn select_one_i64<C: Reader>(
    conn: &C,
    sql: &str,
    args: Vec<Value>,
) -> AppResult<Option<i64>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    Ok(v_i64(row.get_value(0).map_err(db_err)?))
}

/// Un cliente tal y como está guardado (para el merge «sólo rellenar huecos» y para la búsqueda).
struct ClienteExistente {
    id: String,
    nombre: Option<String>,
    email: Option<String>,
    telefono: Option<String>,
    notas: Option<String>,
}

fn cliente_existente(row: &Row) -> AppResult<ClienteExistente> {
    Ok(ClienteExistente {
        id: s(row.get_value(0).map_err(db_err)?),
        nombre: norm_opt_string(row.get_value(1).map_err(db_err)?),
        email: norm_opt_string(row.get_value(2).map_err(db_err)?),
        telefono: norm_opt_string(row.get_value(3).map_err(db_err)?),
        notas: norm_opt_string(row.get_value(4).map_err(db_err)?),
    })
}

/// Por email, sin distinguir mayúsculas: es el criterio del índice único `ux_clientes_email` (sobre
/// `lower(Email)`), así que se busca por lo mismo por lo que luego rechazaría el INSERT. El
/// `Email IS NOT NULL AND Email <> ''` replica el predicado del índice parcial para que pueda usarlo.
const POR_EMAIL: &str = "Email IS NOT NULL AND Email <> '' AND lower(Email) = ?1";
const POR_TELEFONO: &str = "Telefono = ?1";
const POR_ID: &str = "ID_Cliente = ?1";

/// El cliente más reciente que cumple `filtro` (uno de los de arriba, con `?1`).
async fn cliente_por<C: Reader>(
    conn: &C,
    filtro: &str,
    valor: &str,
) -> AppResult<Option<ClienteExistente>> {
    let mut rows = conn
        .query(
            &format!(
                "SELECT ID_Cliente, Nombre, Email, Telefono, Notas FROM Clientes \
                 WHERE {filtro} ORDER BY Created_At DESC, ID_Cliente DESC LIMIT 1;"
            ),
            vec![Value::Text(valor.to_string())],
        )
        .await
        .map_err(db_err)?;
    match rows.next().await.map_err(db_err)? {
        Some(row) => Ok(Some(cliente_existente(&row)?)),
        None => Ok(None),
    }
}

/// Mismo texto que `email_duplicado` en el worker (`lib/errorCodes.ts`).
const MSG_EMAIL_DE_OTRO: &str = "Ya hay un cliente con ese correo.";

/// El `ID_Cliente` que lleva la reserva (RI-61). Antes esto buscaba por email y por teléfono y, si
/// encontraba a alguien, le asignaba la reserva sin preguntar. Ahora la decisión llega tomada:
///
/// - **Ninguno**: la reserva va sin cliente.
/// - **Existente**: se le asigna ése. Lo escrito sólo rellena sus huecos (RES-01): no se le cambia
///   un dato que ya tenga, y un email que ya es de otro cliente no se le pone (chocaría con el
///   índice único).
/// - **Nuevo**: una ficha nueva, aunque otra comparta el teléfono. Un email que ya es de otro
///   cliente se rechaza: la pantalla ya lo había preguntado, así que llegar aquí es una carrera.
///
/// Espejo de `resolverCliente` en el worker (`reservas.queries.ts`).
async fn resolver_cliente<C: Writer>(conn: &C, c: &ClienteReserva) -> AppResult<Option<String>> {
    match c {
        ClienteReserva::Ninguno => Ok(None),

        ClienteReserva::Existente { id, telefono, email, notas } => {
            let Some(ex) = cliente_por(conn, POR_ID, id).await? else {
                return Err(AppError::not_found(
                    "Ese cliente ya no existe. Vuelve a buscarlo o guarda la reserva sin cliente.",
                ));
            };

            let email_libre = match email {
                Some(e) => match cliente_por(conn, POR_EMAIL, e).await? {
                    Some(otro) if otro.id != ex.id => None,
                    _ => Some(e.clone()),
                },
                None => None,
            };
            let email_final = ex.email.clone().or(email_libre);
            let telefono_final = ex.telefono.clone().or_else(|| telefono.clone());
            let notas_final = ex.notas.clone().or_else(|| notas.clone());

            // Sin nada que rellenar no se escribe: cada escritura sube a la nube.
            if (&email_final, &telefono_final, &notas_final) != (&ex.email, &ex.telefono, &ex.notas)
            {
                conn.execute(
                    "UPDATE Clientes SET Email = ?1, Telefono = ?2, Notas = ?3 WHERE ID_Cliente = ?4;",
                    vec![
                        opt_text(email_final),
                        opt_text(telefono_final),
                        opt_text(notas_final),
                        Value::Text(ex.id.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(Some(ex.id))
        }

        ClienteReserva::Nuevo { nombre, telefono, email, notas } => {
            if let Some(e) = email {
                if cliente_por(conn, POR_EMAIL, e).await?.is_some() {
                    return Err(AppError::conflict(MSG_EMAIL_DE_OTRO));
                }
            }
            let id_cliente = new_id();
            conn.execute(
                "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Notas, Created_At) \
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now','localtime'));",
                vec![
                    Value::Text(id_cliente.clone()),
                    Value::Text(nombre.clone()),
                    opt_text(telefono.clone()),
                    opt_text(email.clone()),
                    opt_text(notas.clone()),
                ],
            )
            .await
            .map_err(db_err)?;
            Ok(Some(id_cliente))
        }
    }
}

/// RI-61: la duración por defecto y el modo de solape del negocio.
async fn ajustes_de_reserva<C: Reader>(conn: &C) -> AppResult<(i64, ModoSolape)> {
    let mut rows = conn
        .query(
            "SELECT Reserva_Duracion_Min, Reserva_Solape FROM Business_Settings WHERE ID = 1;",
            (),
        )
        .await
        .map_err(db_err)?;
    Ok(match rows.next().await.map_err(db_err)? {
        Some(row) => (
            v_i64(row.get_value(0).map_err(db_err)?)
                .filter(|m| *m > 0)
                .unwrap_or(DURACION_POR_DEFECTO_MIN),
            ModoSolape::desde(&s(row.get_value(1).map_err(db_err)?)),
        ),
        None => (DURACION_POR_DEFECTO_MIN, ModoSolape::Avisar),
    })
}

/// RI-61: otra reserva de la misma mesa que se cruza con ésta. Una reserva ocupa
/// `[Dia_YMD Hora, + Duracion_Min)`, con la duración del negocio si no eligió la suya, y con fechas
/// completas, así que una de las 23:00 llega al día siguiente. Cuentan las que ocupan la mesa (no
/// canceladas, no presentadas ni finalizadas) salvo ella misma. Antes sólo chocaba la misma hora
/// exacta: las 21:00 y las 21:15 de la misma mesa entraban las dos.
///
/// ?1 = mesa, ?2 = día, ?3 = hora, ?4 = minutos de ésta, ?5 = minutos por defecto, ?6 = su id.
/// Mismo SQL en el worker (`choqueEnLaMesa`).
const SQL_CHOQUE_RESERVA: &str = r#"
    SELECT R.Hora,
           strftime('%H:%M', datetime(R.Dia_YMD || ' ' || R.Hora,
                                      '+' || COALESCE(R.Duracion_Min, ?5) || ' minutes'))
    FROM Reservas R
    WHERE R.ID_Mesa = ?1
      AND R.ID_Reserva <> ?6
      AND R.Estado NOT IN ('CANCELADA','NO_SHOW','FINALIZADA')
      AND datetime(R.Dia_YMD || ' ' || R.Hora) < datetime(?2 || ' ' || ?3, '+' || ?4 || ' minutes')
      AND datetime(R.Dia_YMD || ' ' || R.Hora, '+' || COALESCE(R.Duracion_Min, ?5) || ' minutes')
          > datetime(?2 || ' ' || ?3)
    ORDER BY R.Dia_YMD, R.Hora, R.ID_Reserva
    LIMIT 1;
"#;

/// RI-61: una comanda abierta en la mesa que se cruza con la reserva. Quien está sentado ocupa la
/// mesa desde que se abrió la comanda y, como no se sabe cuándo se irá, durante la duración por
/// defecto o hasta ahora, lo que sea más tarde. Así, reservar para ya una mesa con gente avisa, y
/// reservarla para mañana no.
///
/// ?1 = mesa, ?2 = día, ?3 = hora, ?4 = minutos de la reserva, ?5 = minutos por defecto.
/// Mismo SQL en el worker (`choqueEnLaMesa`).
const SQL_CHOQUE_COMANDA: &str = r#"
    SELECT strftime('%H:%M', C.Fecha_Hora_Apertura)
    FROM Comandas C
    WHERE C.ID_Mesa = ?1
      AND C.Estado = 'Abierta'
      AND datetime(C.Fecha_Hora_Apertura) < datetime(?2 || ' ' || ?3, '+' || ?4 || ' minutes')
      AND MAX(datetime(C.Fecha_Hora_Apertura, '+' || ?5 || ' minutes'), datetime('now','localtime'))
          > datetime(?2 || ' ' || ?3)
    ORDER BY C.Fecha_Hora_Apertura, C.ID_Comanda
    LIMIT 1;
"#;

/// Mismo texto en el worker (`MSG_SOLAPE_PROHIBIDO`).
const MSG_SOLAPE_PROHIBIDO: &str =
    "En este negocio no se pueden solapar reservas (Configuración → Reservas).";

/// RI-61: con qué choca la reserva en su mesa, como frase para quien reserva, o `None`. Sin nombres
/// de cliente: un mensaje de error puede acabar en la telemetría.
async fn choque_en_la_mesa<C: Reader>(
    conn: &C,
    id_mesa: &str,
    r: &ReservaValidada,
    id_reserva: &str,
    duracion_def: i64,
) -> AppResult<Option<String>> {
    let duracion = r.duracion_min.unwrap_or(duracion_def);
    let base = vec![
        Value::Text(id_mesa.to_string()),
        Value::Text(r.dia_ymd.clone()),
        Value::Text(r.hora.clone()),
        Value::Integer(duracion),
        Value::Integer(duracion_def),
    ];

    let mut args = base.clone();
    args.push(Value::Text(id_reserva.to_string()));
    let mut rows = conn.query(SQL_CHOQUE_RESERVA, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        let desde = s(row.get_value(0).map_err(db_err)?);
        let hasta = s(row.get_value(1).map_err(db_err)?);
        return Ok(Some(format!("Esa mesa ya tiene una reserva de {desde} a {hasta}.")));
    }

    let mut rows = conn.query(SQL_CHOQUE_COMANDA, base).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        let desde = s(row.get_value(0).map_err(db_err)?);
        return Ok(Some(format!(
            "Esa mesa está ocupada: tiene una comanda abierta desde las {desde}."
        )));
    }
    Ok(None)
}

#[async_trait]
impl ReservasRepository for SqliteReservasRepository {
    async fn meta(&self) -> AppResult<ReservasMetaDto> {
        let g = self.db.read().await;
        let conn = &g;

        // Zonas
        let mut zrows = conn
            .query("SELECT ID_Zona, Nombre_Zona FROM Zonas WHERE Archivada_En IS NULL ORDER BY ID_Zona ASC;", ())
            .await
            .map_err(db_err)?;
        let mut zonas: Vec<ZonaDto> = Vec::new();
        while let Some(row) = zrows.next().await.map_err(db_err)? {
            zonas.push(ZonaDto {
                id_zona: s(row.get_value(0).map_err(db_err)?),
                nombre_zona: s(row.get_value(1).map_err(db_err)?),
            });
        }

        // Son reservables todas las mesas del plano: ya no existen "mesas de sistema" (la venta
        // rápida no usa mesa, ver `Comandas.Canal`). Lo archivado (RI-54) ya no está en el plano.
        let msql = "SELECT ID_Mesa, ID_Zona, Numero_Mesa, Capacidad FROM Mesas WHERE Archivada_En IS NULL ORDER BY ID_Zona ASC, ID_Mesa ASC;";
        let mut mrows = conn.query(msql, ()).await.map_err(db_err)?;
        let mut mesas: Vec<MesaDto> = Vec::new();
        while let Some(row) = mrows.next().await.map_err(db_err)? {
            mesas.push(MesaDto {
                id_mesa: s(row.get_value(0).map_err(db_err)?),
                id_zona: s(row.get_value(1).map_err(db_err)?),
                numero_mesa: s(row.get_value(2).map_err(db_err)?),
                capacidad: i(row.get_value(3).map_err(db_err)?),
            });
        }

        Ok(ReservasMetaDto { zonas, mesas })
    }

    async fn mes(&self, desde: &str, hasta: &str) -> AppResult<Vec<ReservaDto>> {
        let sql = r#"
          SELECT
            R.ID_Reserva, R.ID_Mesa, R.Dia_YMD, R.Hora, R.Turno, R.Comensales, R.Nota, R.Estado,
            C.Nombre AS Nombre_Cliente, C.Telefono AS Telefono_Cliente, C.Email AS Email_Cliente,
            M.ID_Zona, M.Numero_Mesa, M.Capacidad,
            Z.Nombre_Zona,
            C.ID_Cliente,
            R.Duracion_Min
          -- RES-04: LEFT JOIN (no INNER). Una reserva cuyo cliente/mesa/zona ya no exista (borrado
          -- de layout, divergencia de sync) NO debe desaparecer del calendario: se muestra aunque
          -- falten esos datos (columnas quedan NULL → "" / 0 en el mapper) en vez de ocultarse.
          FROM Reservas R
          LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
          LEFT JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa
          LEFT JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona
          WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2
          ORDER BY R.Dia_YMD ASC, R.Hora ASC, R.ID_Reserva ASC;
        "#;

        let db = self.db.read().await;
        let mut rows = db
            .query(sql, vec![Value::Text(desde.to_string()), Value::Text(hasta.to_string())])
            .await
            .map_err(db_err)?;

        let mut out: Vec<ReservaDto> = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |idx: i32| row.get_value(idx).map_err(db_err);
            out.push(ReservaDto {
                id_reserva: s(g(0)?),
                id_mesa: s(g(1)?),
                dia_ymd: s(g(2)?),
                hora: s(g(3)?),
                turno: norm_opt_string(g(4)?),
                comensales: i(g(5)?),
                nota: norm_opt_string(g(6)?),
                estado: s(g(7)?),
                // Del cliente que existe, no de la columna de la reserva: una reserva cuyo cliente
                // se borró sale sin cliente, igual que su nombre (RES-04).
                id_cliente: norm_opt_string(g(15)?),
                duracion_min: v_i64(g(16)?),
                nombre_cliente: s(g(8)?),
                telefono_cliente: norm_opt_string(g(9)?),
                email_cliente: norm_opt_string(g(10)?),
                id_zona: s(g(11)?),
                numero_mesa: s(g(12)?),
                capacidad: i(g(13)?),
                nombre_zona: s(g(14)?),
            });
        }
        Ok(out)
    }

    async fn guardar(&self, r: ReservaValidada, forzar_solape: bool) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;

        let res: AppResult<bool> = async {
            // UUIDv7 explícito: si no viene id (alta), lo generamos. Upsert por id.
            let id_reserva = r.id.clone().unwrap_or_else(new_id);

            // RI-61: ¿se pisa con lo que ya ocupa la mesa? Sin mesa no ocupa nada. Dentro de la
            // transacción, así que dos reservas a la vez no se cuelan la una a la otra.
            if let Some(ref id_mesa) = r.id_mesa {
                let (duracion_def, modo) = ajustes_de_reserva(conn).await?;
                let choque = choque_en_la_mesa(conn, id_mesa, &r, &id_reserva, duracion_def).await?;
                if let Some(choque) = choque {
                    match modo {
                        ModoSolape::Prohibir => {
                            return Err(AppError::conflict(format!("{choque} {MSG_SOLAPE_PROHIBIDO}")))
                        }
                        ModoSolape::Avisar if !forzar_solape => {
                            return Err(AppError::Coded(ErrorCode::ReservaSolapada, choque))
                        }
                        ModoSolape::Avisar => {}
                    }
                }
            }

            let id_cliente = resolver_cliente(conn, &r.cliente).await?;

            let exists = select_one_i64(
                conn,
                "SELECT 1 FROM Reservas WHERE ID_Reserva = ?1 LIMIT 1;",
                vec![Value::Text(id_reserva.clone())],
            )
            .await?
            .is_some();

            if exists {
                conn.execute(
                    r#"UPDATE Reservas SET ID_Cliente = ?1, ID_Mesa = ?2, Dia_YMD = ?3, Hora = ?4, Turno = ?5, Comensales = ?6, Nota = ?7, Estado = ?8, Duracion_Min = ?10 WHERE ID_Reserva = ?9;"#,
                    vec![
                        opt_text(id_cliente.clone()),
                        opt_text(r.id_mesa.clone()),
                        Value::Text(r.dia_ymd.clone()),
                        Value::Text(r.hora.clone()),
                        Value::Text(r.turno.clone()),
                        Value::Integer(r.comensales),
                        opt_text(r.nota.clone()),
                        Value::Text(r.estado.clone()),
                        Value::Text(id_reserva.clone()),
                        opt_int(r.duracion_min),
                    ],
                )
                .await
                .map_err(db_err)?;
            } else {
                conn.execute(
                    r#"INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Nota, Estado, Duracion_Min, Created_At) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now','localtime'));"#,
                    vec![
                        Value::Text(id_reserva.clone()),
                        opt_text(id_cliente.clone()),
                        opt_text(r.id_mesa.clone()),
                        Value::Text(r.dia_ymd.clone()),
                        Value::Text(r.hora.clone()),
                        Value::Text(r.turno.clone()),
                        Value::Integer(r.comensales),
                        opt_text(r.nota.clone()),
                        Value::Text(r.estado.clone()),
                        opt_int(r.duracion_min),
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

    /// RI-61: primero por email, que identifica; luego por teléfono. Espejo de `buscarCliente` en el
    /// worker.
    async fn buscar_cliente(
        &self,
        telefono: Option<&str>,
        email: Option<&str>,
    ) -> AppResult<Option<ClienteCoincidente>> {
        let db = self.db.read().await;
        let busquedas = [(email, POR_EMAIL, "email"), (telefono, POR_TELEFONO, "telefono")];
        for (valor, filtro, por) in busquedas {
            let Some(valor) = valor else { continue };
            if let Some(c) = cliente_por(&db, filtro, valor).await? {
                return Ok(Some(ClienteCoincidente {
                    id_cliente: c.id,
                    nombre: c.nombre.unwrap_or_default(),
                    telefono: c.telefono,
                    email: c.email,
                    coincide_por: por.to_string(),
                }));
            }
        }
        Ok(None)
    }

    async fn eliminar(&self, id_reserva: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;
        conn.execute_batch("BEGIN;").await.map_err(db_err)?;

        let res: AppResult<bool> = async {
            conn.execute(
                "UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;",
                vec![Value::Text(id_reserva.to_string())],
            )
            .await
            .map_err(db_err)?;

            let affected = conn
                .execute(
                    "DELETE FROM Reservas WHERE ID_Reserva = ?1;",
                    vec![Value::Text(id_reserva.to_string())],
                )
                .await
                .map_err(db_err)?;

            Ok(affected > 0)
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
}

#[cfg(test)]
mod tests_cliente {
    //! RI-61: el cliente de una reserva es opcional y explícito. Los casos de siempre (sin cliente,
    //! existente, nuevo, otra persona con el mismo teléfono) los fijan los contratos; aquí van los
    //! bordes que sólo tiene la Main.

    use super::*;

    async fn abrir() -> (Arc<Db>, SqliteReservasRepository, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("reservas_cliente");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Created_At) \
                       VALUES ('ana', 'Ana', '600', 'ana@x.com', '2026-01-01 00:00:00'); \
                     INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Created_At) \
                       VALUES ('bea', 'Bea', '700', '2026-01-01 00:00:00');",
                )
                .await
                .unwrap();
        }
        let repo = SqliteReservasRepository::new(db.clone());
        (db, repo, dir)
    }

    fn reserva(cliente: ClienteReserva) -> ReservaValidada {
        ReservaValidada {
            id: None,
            id_mesa: None,
            dia_ymd: "2026-05-10".into(),
            hora: "21:00".into(),
            turno: "CENA".into(),
            comensales: 2,
            duracion_min: None,
            nota: None,
            estado: "PROXIMA".into(),
            cliente,
        }
    }

    async fn texto(db: &Db, sql: &str) -> Option<String> {
        let g = db.read().await;
        let mut rows = g.query(sql, ()).await.unwrap();
        rows.next().await.unwrap().and_then(|r| v_string(r.get_value(0).unwrap()))
    }

    #[tokio::test]
    async fn asignar_un_cliente_que_ya_no_existe_es_un_error() {
        let (_db, repo, _dir) = abrir().await;
        let r = repo
            .guardar(reserva(ClienteReserva::Existente {
                id: "borrado".into(),
                telefono: None,
                email: None,
                notas: None,
            }), false)
            .await;
        assert!(matches!(r, Err(AppError::NotFound(_))), "{r:?}");
    }

    #[tokio::test]
    async fn un_cliente_nuevo_con_el_email_de_otro_se_rechaza() {
        let (_db, repo, _dir) = abrir().await;
        let r = repo
            .guardar(reserva(ClienteReserva::Nuevo {
                nombre: "Luis".into(),
                telefono: None,
                email: Some("ana@x.com".into()),
                notas: None,
            }), false)
            .await;
        assert!(matches!(r, Err(AppError::Conflict(_))), "{r:?}");
    }

    #[tokio::test]
    async fn al_rellenar_huecos_no_se_le_pone_el_email_de_otro() {
        // Bea no tiene email; se le asigna la reserva escribiendo el de Ana. Ponérselo chocaría con
        // el índice único y tumbaría la reserva; se queda sin él.
        let (db, repo, _dir) = abrir().await;
        assert!(repo
            .guardar(reserva(ClienteReserva::Existente {
                id: "bea".into(),
                telefono: None,
                email: Some("ana@x.com".into()),
                notas: None,
            }), false)
            .await
            .unwrap());
        assert_eq!(texto(&db, "SELECT Email FROM Clientes WHERE ID_Cliente = 'bea';").await, None);
        assert_eq!(
            texto(&db, "SELECT ID_Cliente FROM Reservas;").await.as_deref(),
            Some("bea")
        );
    }

    #[tokio::test]
    async fn una_reserva_sin_cliente_no_crea_ninguna_ficha() {
        let (db, repo, _dir) = abrir().await;
        assert!(repo.guardar(reserva(ClienteReserva::Ninguno), false).await.unwrap());
        assert_eq!(texto(&db, "SELECT ID_Cliente FROM Reservas;").await, None);
        assert_eq!(texto(&db, "SELECT CAST(COUNT(*) AS TEXT) FROM Clientes;").await.as_deref(), Some("2"));
    }
}

#[cfg(test)]
mod tests_solape {
    //! RI-61: una reserva ocupa su mesa durante su duración (la suya o la del negocio), y lo que se
    //! pisa con ella se avisa o se prohíbe según el negocio. Antes sólo chocaba la misma hora exacta.

    use chrono::Local;

    use super::*;

    async fn abrir() -> (Arc<Db>, SqliteReservasRepository, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("reservas_solape");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salon'); \
                     INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, \
                       Ubicacion_Y, Shape, Width, Height) \
                       VALUES ('m1', 'z1', '1', 4, 0, 0, 'rect', 80, 80);",
                )
                .await
                .unwrap();
        }
        let repo = SqliteReservasRepository::new(db.clone());
        (db, repo, dir)
    }

    fn reserva(dia: &str, hora: &str, duracion: Option<i64>) -> ReservaValidada {
        ReservaValidada {
            id: None,
            id_mesa: Some("m1".into()),
            dia_ymd: dia.into(),
            hora: hora.into(),
            turno: "CENA".into(),
            comensales: 2,
            duracion_min: duracion,
            nota: None,
            estado: "PROXIMA".into(),
            cliente: ClienteReserva::Ninguno,
        }
    }

    async fn sql(db: &Db, sql: &str) {
        db.write().await.raw().execute_batch(sql).await.unwrap();
    }

    fn es_aviso(r: &AppResult<bool>) -> bool {
        matches!(r, Err(AppError::Coded(ErrorCode::ReservaSolapada, _)))
    }

    #[tokio::test]
    async fn las_21_00_y_las_21_15_de_la_misma_mesa_se_pisan() {
        let (_db, repo, _dir) = abrir().await;
        repo.guardar(reserva("2026-05-10", "21:00", None), false).await.unwrap();

        let r = repo.guardar(reserva("2026-05-10", "21:15", None), false).await;
        assert!(es_aviso(&r), "{r:?}");
        if let Err(AppError::Coded(_, msg)) = &r {
            assert_eq!(msg, "Esa mesa ya tiene una reserva de 21:00 a 23:00.");
        }
        // Con «permitir con aviso», confirmarlo la guarda.
        assert!(repo.guardar(reserva("2026-05-10", "21:15", None), true).await.unwrap());
    }

    #[tokio::test]
    async fn la_hora_de_fin_no_cuenta_y_la_duracion_propia_manda() {
        let (_db, repo, _dir) = abrir().await;
        repo.guardar(reserva("2026-05-10", "21:00", None), false).await.unwrap();
        // 21:00 + 2 h por defecto: las 23:00 ya están libres.
        assert!(repo.guardar(reserva("2026-05-10", "23:00", None), false).await.unwrap());
        // Una de una hora a las 13:00 deja libre las 14:00.
        repo.guardar(reserva("2026-05-10", "13:00", Some(60)), false).await.unwrap();
        assert!(repo.guardar(reserva("2026-05-10", "14:00", None), false).await.unwrap());
    }

    #[tokio::test]
    async fn una_reserva_de_noche_ocupa_tambien_el_dia_siguiente() {
        let (_db, repo, _dir) = abrir().await;
        repo.guardar(reserva("2026-05-10", "23:30", None), false).await.unwrap();
        let r = repo.guardar(reserva("2026-05-11", "00:30", None), false).await;
        assert!(es_aviso(&r), "{r:?}");
    }

    #[tokio::test]
    async fn con_los_solapes_prohibidos_no_se_guarda_ni_confirmandolo() {
        let (db, repo, _dir) = abrir().await;
        sql(&db, "UPDATE Business_Settings SET Reserva_Solape = 'prohibir' WHERE ID = 1;").await;
        repo.guardar(reserva("2026-05-10", "21:00", None), false).await.unwrap();
        let r = repo.guardar(reserva("2026-05-10", "21:15", None), true).await;
        assert!(matches!(r, Err(AppError::Conflict(_))), "{r:?}");
    }

    #[tokio::test]
    async fn la_duracion_por_defecto_es_la_del_negocio() {
        let (db, repo, _dir) = abrir().await;
        sql(&db, "UPDATE Business_Settings SET Reserva_Duracion_Min = 30 WHERE ID = 1;").await;
        repo.guardar(reserva("2026-05-10", "21:00", None), false).await.unwrap();
        assert!(repo.guardar(reserva("2026-05-10", "21:30", None), false).await.unwrap());
    }

    #[tokio::test]
    async fn una_reserva_cancelada_no_ocupa_la_mesa() {
        let (db, repo, _dir) = abrir().await;
        repo.guardar(reserva("2026-05-10", "21:00", None), false).await.unwrap();
        sql(&db, "UPDATE Reservas SET Estado = 'CANCELADA';").await;
        assert!(repo.guardar(reserva("2026-05-10", "21:15", None), false).await.unwrap());
    }

    #[tokio::test]
    async fn una_comanda_abierta_ocupa_la_mesa_ahora_pero_no_manana() {
        let (db, repo, _dir) = abrir().await;
        sql(
            &db,
            "INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado) \
             VALUES ('c1', 'm1', 'MESA', datetime('now','localtime','-10 minutes'), 'Abierta');",
        )
        .await;
        let ahora = Local::now();
        let hoy = ahora.format("%Y-%m-%d").to_string();
        let hora = ahora.format("%H:%M").to_string();
        let manana = (ahora + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();

        let r = repo.guardar(reserva(&hoy, &hora, None), false).await;
        assert!(es_aviso(&r), "{r:?}");
        assert!(repo.guardar(reserva(&manana, &hora, None), false).await.unwrap());
    }

    #[tokio::test]
    async fn sin_mesa_no_choca_con_nada() {
        let (_db, repo, _dir) = abrir().await;
        repo.guardar(reserva("2026-05-10", "21:00", None), false).await.unwrap();
        let mut sin_mesa = reserva("2026-05-10", "21:00", None);
        sin_mesa.id_mesa = None;
        assert!(repo.guardar(sin_mesa, false).await.unwrap());
    }
}
