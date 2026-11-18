//! Adaptador SQLite del repositorio de reservas. Local-First puro (sin outbox/applied).

use crate::util::new_id;
use crate::consultas::{db_err, select_one_i64, select_one_string};
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;
use crate::ejecutor::Row;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reservas::{NoVinoReservas, ReservasRepository};
use tpv_contracts::reservas::{ClienteCoincidente, MesaDto, ReservaDto, ReservasMetaDto, ZonaDto};
use tpv_contracts::errors::ErrorCode;
use tpv_domain::reservas::{ClienteReserva, ModoSolape, ReservaValidada, ReservaVista, DURACION_POR_DEFECTO_MIN};

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_text, v_i64, v_string};

pub struct SqliteReservasRepository {
    db: Arc<Db>,
}

impl SqliteReservasRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
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

/// Un cliente tal y como está guardado (para el merge «sólo rellenar huecos» y para la búsqueda).
pub(crate) struct ClienteExistente {
    pub(crate) id: String,
    nombre: Option<String>,
    email: Option<String>,
    pub(crate) telefono: Option<String>,
}

fn cliente_existente(row: &Row) -> AppResult<ClienteExistente> {
    Ok(ClienteExistente {
        id: s(row.get_value(0).map_err(db_err)?),
        nombre: norm_opt_string(row.get_value(1).map_err(db_err)?),
        email: norm_opt_string(row.get_value(2).map_err(db_err)?),
        telefono: norm_opt_string(row.get_value(3).map_err(db_err)?),
    })
}

/// Por email, sin distinguir mayúsculas: es el criterio del índice único `ux_clientes_email` (sobre
/// `lower(Email)`), así que se busca por lo mismo por lo que luego rechazaría el INSERT. El
/// `Email IS NOT NULL AND Email <> ''` replica el predicado del índice parcial para que pueda usarlo.
pub(crate) const POR_EMAIL: &str = "Email IS NOT NULL AND Email <> '' AND lower(Email) = ?1";
const POR_TELEFONO: &str = "Telefono = ?1";
const POR_ID: &str = "ID_Cliente = ?1";

/// El cliente más reciente que cumple `filtro` (uno de los de arriba, con `?1`).
pub(crate) async fn cliente_por<C: Reader>(
    conn: &C,
    filtro: &str,
    valor: &str,
) -> AppResult<Option<ClienteExistente>> {
    let mut rows = conn
        .query(
            &format!(
                "SELECT ID_Cliente, Nombre, Email, Telefono FROM Clientes \
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
pub(crate) const MSG_EMAIL_DE_OTRO: &str = "Ya hay un cliente con ese correo.";

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

        ClienteReserva::Existente { id, telefono, email } => {
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

            // Sin nada que rellenar no se escribe: cada escritura sube a la nube.
            if (&email_final, &telefono_final) != (&ex.email, &ex.telefono) {
                conn.execute(
                    "UPDATE Clientes SET Email = ?1, Telefono = ?2 WHERE ID_Cliente = ?3;",
                    vec![
                        opt_text(email_final),
                        opt_text(telefono_final),
                        Value::Text(ex.id.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            }
            Ok(Some(ex.id))
        }

        ClienteReserva::Nuevo { nombre, telefono, email } => {
            if let Some(e) = email {
                if cliente_por(conn, POR_EMAIL, e).await?.is_some() {
                    return Err(AppError::conflict(MSG_EMAIL_DE_OTRO));
                }
            }
            let id_cliente = new_id();
            conn.execute(
                "INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Created_At) \
                 VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'));",
                vec![
                    Value::Text(id_cliente.clone()),
                    Value::Text(nombre.clone()),
                    opt_text(telefono.clone()),
                    opt_text(email.clone()),
                ],
            )
            .await
            .map_err(db_err)?;
            Ok(Some(id_cliente))
        }
    }
}

/// RI-61: la duración por defecto y el modo de solape del negocio.
pub(crate) async fn ajustes_de_reserva<C: Reader>(conn: &C) -> AppResult<(i64, ModoSolape)> {
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

/// RI-61 / RES-04: una comanda abierta en la mesa ocupa la mesa **todo el día**: no se sabe cuándo
/// se irá quien está sentado, así que no se puede reservar para hoy, a ninguna hora, y para mañana
/// sí. Al cerrarse la comanda se puede reservar. No cuenta la comanda de la propia reserva (sus
/// clientes ya están sentados), ni la de una reserva que ya era de esa mesa ese día: cambiarle la
/// nota o la hora no crea el choque.
///
/// ?1 = mesa, ?2 = día, ?3 = la reserva. Mismo SQL en el worker (`choqueEnLaMesa`).
const SQL_CHOQUE_COMANDA: &str = r#"
    SELECT strftime('%H:%M', C.Fecha_Hora_Apertura)
    FROM Comandas C
    WHERE C.ID_Mesa = ?1
      AND C.Estado = 'Abierta'
      AND ?2 <= date('now','localtime')
      AND C.ID_Reserva IS NOT ?3
      AND NOT EXISTS (SELECT 1 FROM Reservas R0 WHERE R0.ID_Reserva = ?3 AND R0.ID_Mesa = ?1 AND R0.Dia_YMD = ?2)
    ORDER BY C.Fecha_Hora_Apertura, C.ID_Comanda
    LIMIT 1;
"#;

/// Con qué choca una reserva en su mesa. Una reserva que se cruza depende de lo que diga el negocio
/// (avisar o prohibir); una comanda abierta hoy no se salta nunca (RES-04).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Choque {
    Reserva(String),
    Comanda(String),
}


/// Los estados en los que una reserva todavía se cambia: la que no ha llegado y la que está en la
/// mesa. Es lo que enseña «Modificar» en la pantalla (`ocupaMesa`).
const RESERVA_VIVA: [&str; 2] = ["PROXIMA", "ACTIVA"];

/// RES-INC-03: ¿la reserva sigue como la vio el formulario? Compara lo que da su lectura
/// (`SQL_SELECT_RESERVA`: la mesa vacía si no tiene, la nota recortada, el cliente que existe).
/// Mismo SQL en el worker (`SQL_SIGUE_COMO_LA_VIO`).
const SQL_SIGUE_COMO_LA_VIO: &str = r#"
    SELECT 1 FROM Reservas R
    WHERE R.ID_Reserva = ?1
      AND COALESCE(R.ID_Mesa, '') = ?2
      AND R.Dia_YMD = ?3
      AND R.Hora = ?4
      AND R.Comensales = ?5
      AND R.Duracion_Min IS ?6
      AND trim(COALESCE(R.Nota, '')) = ?7
      AND COALESCE((SELECT C.ID_Cliente FROM Clientes C WHERE C.ID_Cliente = R.ID_Cliente), '') = ?8
    LIMIT 1;
"#;

async fn sigue_como_la_vio<C: Reader>(conn: &C, id_reserva: &str, v: &ReservaVista) -> AppResult<bool> {
    Ok(select_one_i64(
        conn,
        SQL_SIGUE_COMO_LA_VIO,
        vec![
            Value::Text(id_reserva.to_string()),
            Value::Text(v.id_mesa.clone()),
            Value::Text(v.dia_ymd.clone()),
            Value::Text(v.hora.clone()),
            Value::Integer(v.comensales),
            opt_int(v.duracion_min),
            Value::Text(v.nota.as_deref().unwrap_or("").trim().to_string()),
            Value::Text(v.id_cliente.clone().unwrap_or_default()),
        ],
    )
    .await?
    .is_some())
}

/// RES-INC-03. Mismo texto en el worker (`reserva_cambiada_al_editar`).
pub const MSG_RESERVA_CAMBIADA_AL_EDITAR: &str =
    "Esta reserva ha cambiado en otro equipo mientras la editabas. Cierra el formulario y vuelve a abrirla.";

/// SYN-INC-04. Mismo texto en el worker (`reserva_cerrada`).
pub const MSG_RESERVA_CERRADA: &str =
    "Esa reserva ya está cerrada (cancelada, terminada o no vino): ya no se puede cambiar. Cierra el formulario.";

/// Mismo texto en el worker (`MSG_SOLAPE_PROHIBIDO`).
const MSG_SOLAPE_PROHIBIDO: &str =
    "En este negocio no se pueden solapar reservas (Configuración → Reservas).";

/// RI-61: con qué choca la reserva en su mesa, como frase para quien reserva, o `None`. Sin nombres
/// de cliente: un mensaje de error puede acabar en la telemetría.
/// También lo usa el alta desde la web (`reservas_web.rs`), que se guarda aunque choque.
pub(crate) async fn choque_en_la_mesa<C: Reader>(
    conn: &C,
    id_mesa: &str,
    (dia_ymd, hora, duracion_min): (&str, &str, Option<i64>),
    id_reserva: &str,
    duracion_def: i64,
) -> AppResult<Option<Choque>> {
    let duracion = duracion_min.unwrap_or(duracion_def);
    let base = vec![
        Value::Text(id_mesa.to_string()),
        Value::Text(dia_ymd.to_string()),
        Value::Text(hora.to_string()),
        Value::Integer(duracion),
        Value::Integer(duracion_def),
    ];

    let mut args = base;
    args.push(Value::Text(id_reserva.to_string()));
    let mut rows = conn.query(SQL_CHOQUE_RESERVA, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        let desde = s(row.get_value(0).map_err(db_err)?);
        let hasta = s(row.get_value(1).map_err(db_err)?);
        return Ok(Some(Choque::Reserva(format!("Esa mesa ya tiene una reserva de {desde} a {hasta}."))));
    }

    let args = vec![
        Value::Text(id_mesa.to_string()),
        Value::Text(dia_ymd.to_string()),
        Value::Text(id_reserva.to_string()),
    ];
    let mut rows = conn.query(SQL_CHOQUE_COMANDA, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        let desde = s(row.get_value(0).map_err(db_err)?);
        return Ok(Some(Choque::Comanda(format!(
            "Esa mesa tiene una comanda abierta desde las {desde}: hoy no se puede reservar. Elige otra mesa u otro día."
        ))));
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
        let sql = format!(
            "{SQL_SELECT_RESERVA} WHERE R.Dia_YMD >= ?1 AND R.Dia_YMD <= ?2 \
             ORDER BY R.Dia_YMD ASC, R.Hora ASC, R.ID_Reserva ASC;"
        );
        let db = self.db.read().await;
        let mut rows = db
            .query(&sql, vec![Value::Text(desde.to_string()), Value::Text(hasta.to_string())])
            .await
            .map_err(db_err)?;

        let mut out: Vec<ReservaDto> = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(fila_de_reserva(&row)?);
        }
        Ok(out)
    }

    async fn reserva(&self, id_reserva: &str) -> AppResult<Option<ReservaDto>> {
        let sql = format!("{SQL_SELECT_RESERVA} WHERE R.ID_Reserva = ?1;");
        let db = self.db.read().await;
        let mut rows = db.query(&sql, vec![Value::Text(id_reserva.to_string())]).await.map_err(db_err)?;
        match rows.next().await.map_err(db_err)? {
            Some(row) => Ok(Some(fila_de_reserva(&row)?)),
            None => Ok(None),
        }
    }

    async fn guardar(&self, r: ReservaValidada, forzar_solape: bool) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;
        let res: AppResult<bool> = conn.transaccion(async {
            // UUIDv7 explícito: si no viene id (alta), lo generamos. Upsert por id.
            let id_reserva = r.id.clone().unwrap_or_else(new_id);

            // SYN-INC-04: sólo se cambia una reserva viva. Un formulario abierto mientras otro equipo
            // la cancelaba (o la terminaba, o la marcaba «No vino») la cambiaba igual: el estado no
            // se toca al editar, pero sí los comensales, la hora o la mesa de una reserva cerrada.
            let estado = select_one_string(
                conn,
                "SELECT Estado FROM Reservas WHERE ID_Reserva = ?1 LIMIT 1;",
                vec![Value::Text(id_reserva.clone())],
            )
            .await?;
            if estado.as_deref().is_some_and(|e| !RESERVA_VIVA.contains(&e)) {
                return Err(AppError::conflict(MSG_RESERVA_CERRADA));
            }
            // RES-INC-03: la edición trae la reserva como la vio el formulario. Si otro equipo la ha
            // cambiado (o borrado) entretanto, escribirla pisaría lo suyo con lo que tenía éste.
            if let (Some(_), Some(v)) = (&r.id, &r.visto) {
                if !sigue_como_la_vio(conn, &id_reserva, v).await? {
                    return Err(AppError::conflict(MSG_RESERVA_CAMBIADA_AL_EDITAR));
                }
            }

            // RI-61: ¿se pisa con lo que ya ocupa la mesa? Sin mesa no ocupa nada. Dentro de la
            // transacción, así que dos reservas a la vez no se cuelan la una a la otra.
            if let Some(ref id_mesa) = r.id_mesa {
                let (duracion_def, modo) = ajustes_de_reserva(conn).await?;
                let choque = choque_en_la_mesa(
                    conn,
                    id_mesa,
                    (&r.dia_ymd, &r.hora, r.duracion_min),
                    &id_reserva,
                    duracion_def,
                )
                .await?;
                if let Some(Choque::Comanda(texto)) = choque {
                    return Err(AppError::conflict(texto));
                }
                if let Some(Choque::Reserva(choque)) = choque {
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

            let exists = estado.is_some();

            // El estado no se toca al editar: lo cambian sólo sus acciones. Una nueva nace PROXIMA.
            if exists {
                conn.execute(
                    r#"UPDATE Reservas SET ID_Cliente = ?1, ID_Mesa = ?2, Dia_YMD = ?3, Hora = ?4, Turno = ?5, Comensales = ?6, Nota = ?7, Duracion_Min = ?9 WHERE ID_Reserva = ?8;"#,
                    vec![
                        opt_text(id_cliente.clone()),
                        opt_text(r.id_mesa.clone()),
                        Value::Text(r.dia_ymd.clone()),
                        Value::Text(r.hora.clone()),
                        Value::Text(r.turno.clone()),
                        Value::Integer(r.comensales),
                        opt_text(r.nota.clone()),
                        Value::Text(id_reserva.clone()),
                        opt_int(r.duracion_min),
                    ],
                )
                .await
                .map_err(db_err)?;
            } else {
                conn.execute(
                    r#"INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Nota, Estado, Duracion_Min, Created_At) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'PROXIMA', ?9, datetime('now','localtime'));"#,
                    vec![
                        Value::Text(id_reserva.clone()),
                        opt_text(id_cliente.clone()),
                        opt_text(r.id_mesa.clone()),
                        Value::Text(r.dia_ymd.clone()),
                        Value::Text(r.hora.clone()),
                        Value::Text(r.turno.clone()),
                        Value::Integer(r.comensales),
                        opt_text(r.nota.clone()),
                        opt_int(r.duracion_min),
                    ],
                )
                .await
                .map_err(db_err)?;
            }

            Ok(true)
        }).await;

        res
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
        let res: AppResult<bool> = conn.transaccion(async {
            let id = || vec![Value::Text(id_reserva.to_string())];
            if select_one_i64(conn, SQL_ES_WEB, id()).await?.is_some() {
                return Err(AppError::conflict(MSG_WEB_NO_SE_BORRA));
            }
            // La comanda pierde la reserva pero conserva su cliente (`ID_Cliente`, fijado al
            // cobrar): el gasto del cliente no se descuadra por borrar la reserva (RI-61).
            conn.execute(SQL_DESVINCULAR_COMANDAS, id()).await.map_err(db_err)?;
            let borradas = conn.execute(SQL_BORRAR, id()).await.map_err(db_err)?;
            Ok(borradas > 0)
        }).await;

        res
    }

    async fn cancelar(&self, id_reserva: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;
        let res: AppResult<bool> = conn.transaccion(async {
            let id = || vec![Value::Text(id_reserva.to_string())];
            // Se decide aquí, al escribir, y se replica sólo la sentencia, sin condición: la otra
            // copia la vuelve a evaluar y puede tener la reserva en otro estado.
            let estado = select_one_string(conn, "SELECT Estado FROM Reservas WHERE ID_Reserva = ?1;", id()).await?;
            match estado.as_deref() {
                None => Ok(false),
                Some("CANCELADA") => Ok(true),
                Some("PROXIMA") => {
                    conn.execute(SQL_CANCELAR, id()).await.map_err(db_err)?;
                    Ok(true)
                }
                Some(_) => Err(AppError::conflict(MSG_NO_PENDIENTE)),
            }
        }).await;

        res
    }
}

/// Las reservas a las que no ha llegado nadie y ya llevan `?1` minutos desde su hora a `?2` (la hora
/// del negocio, «YYYY-MM-DD HH:MM»), como mucho `?3`. Las más recientes primero: al encender el
/// ajuste con muchas viejas pendientes, las de hoy (las que se ven en el plano) no esperan a que se
/// vacíe el histórico, que va saliendo en las pasadas siguientes.
const SQL_NO_VINO_PENDIENTES: &str = "SELECT ID_Reserva FROM Reservas \
     WHERE Estado = 'PROXIMA' \
       AND datetime(Dia_YMD || ' ' || Hora, '+' || ?1 || ' minutes') <= datetime(?2) \
     ORDER BY Dia_YMD DESC, Hora DESC, ID_Reserva DESC LIMIT ?3;";
const SQL_NO_VINO: &str = "UPDATE Reservas SET Estado = 'NO_SHOW' WHERE ID_Reserva = ?1;";

#[async_trait]
impl NoVinoReservas for SqliteReservasRepository {
    async fn marcar_no_vino(&self, ahora_local: &str, max: i64) -> AppResult<usize> {
        let g = self.db.write().await;
        let conn = &g;
        let res: AppResult<usize> = conn.transaccion(async {
            let minutos = select_one_i64(conn, "SELECT Reserva_No_Vino_Min FROM Business_Settings WHERE ID = 1;", vec![])
                .await?
                .unwrap_or(0);
            if minutos <= 0 {
                return Ok(0);
            }
            // Se decide aquí, al escribir, y se replica una sentencia por reserva, sin condición: con
            // la de la hora, la otra copia la volvería a evaluar con su propio «ahora».
            let mut rows = conn
                .query(
                    SQL_NO_VINO_PENDIENTES,
                    vec![Value::Integer(minutos), Value::Text(ahora_local.to_string()), Value::Integer(max)],
                )
                .await
                .map_err(db_err)?;
            let mut ids = Vec::new();
            while let Some(r) = rows.next().await.map_err(db_err)? {
                ids.push(s(r.get_value(0).map_err(db_err)?));
            }
            drop(rows);
            for id in &ids {
                conn.execute(SQL_NO_VINO, vec![Value::Text(id.clone())]).await.map_err(db_err)?;
            }
            Ok(ids.len())
        }).await;

        res
    }
}

/// Una reserva como la pinta el calendario (`mes` y `reserva`). Espejo de `SELECT_RESERVA` en el
/// worker (`reservas.queries.ts`).
///
/// RES-04: LEFT JOIN (no INNER). Una reserva cuyo cliente/mesa/zona ya no exista (borrado de
/// layout, divergencia de sync) NO debe desaparecer del calendario: se muestra aunque falten esos
/// datos (columnas quedan NULL → "" / 0 en el mapper) en vez de ocultarse.
const SQL_SELECT_RESERVA: &str = "SELECT \
       R.ID_Reserva, R.ID_Mesa, R.Dia_YMD, R.Hora, R.Turno, R.Comensales, R.Nota, R.Estado, \
       C.Nombre AS Nombre_Cliente, C.Telefono AS Telefono_Cliente, C.Email AS Email_Cliente, \
       M.ID_Zona, M.Numero_Mesa, M.Capacidad, \
       Z.Nombre_Zona, \
       C.ID_Cliente, \
       R.Duracion_Min, \
       R.Origen \
     FROM Reservas R \
     LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente \
     LEFT JOIN Mesas M ON M.ID_Mesa = R.ID_Mesa \
     LEFT JOIN Zonas Z ON Z.ID_Zona = M.ID_Zona";

/// Una fila de `SQL_SELECT_RESERVA`.
fn fila_de_reserva(row: &Row) -> AppResult<ReservaDto> {
    let g = |idx: i32| row.get_value(idx).map_err(db_err);
    Ok(ReservaDto {
        id_reserva: s(g(0)?),
        id_mesa: s(g(1)?),
        dia_ymd: s(g(2)?),
        hora: s(g(3)?),
        turno: norm_opt_string(g(4)?),
        comensales: i(g(5)?),
        nota: norm_opt_string(g(6)?),
        estado: s(g(7)?),
        origen: s(g(17)?),
        // Del cliente que existe, no de la columna de la reserva: una reserva cuyo cliente se borró
        // sale sin cliente, igual que su nombre (RES-04).
        id_cliente: norm_opt_string(g(15)?),
        duracion_min: v_i64(g(16)?),
        nombre_cliente: s(g(8)?),
        telefono_cliente: norm_opt_string(g(9)?),
        email_cliente: norm_opt_string(g(10)?),
        id_zona: s(g(11)?),
        numero_mesa: s(g(12)?),
        capacidad: i(g(13)?),
        nombre_zona: s(g(14)?),
    })
}

// Borrar y cancelar (docs/estudios/reservas-web.md §5.6). Borrar quita la reserva; cancelar la deja,
// cancelada, y sólo se cancela una que aún no ha llegado. Una reserva web no se borra nunca: queda
// constancia, la agenda libera la mesa al verla cancelada y el correo al cliente se puede leer de
// ella. Lo mismo hace el worker (`reservas.routes.ts`). Las escrituras no llevan condición: se
// decide antes, al escribir, y se replica sólo lo elegido.
const SQL_ES_WEB: &str = "SELECT 1 FROM Reservas WHERE ID_Reserva = ?1 AND Origen = 'WEB';";
const SQL_CANCELAR: &str = "UPDATE Reservas SET Estado = 'CANCELADA' WHERE ID_Reserva = ?1;";
const SQL_DESVINCULAR_COMANDAS: &str = "UPDATE Comandas SET ID_Reserva = NULL WHERE ID_Reserva = ?1;";
const SQL_BORRAR: &str = "DELETE FROM Reservas WHERE ID_Reserva = ?1;";

/// Mismo texto en el worker (`reserva_web_no_se_borra`, `lib/errorCodes.ts`).
const MSG_WEB_NO_SE_BORRA: &str =
    "Una reserva hecha desde la web no se borra: se queda en la lista. Si aún no ha llegado, cancélala.";
/// Mismo texto en el worker (`reserva_no_pendiente`, `lib/errorCodes.ts`).
const MSG_NO_PENDIENTE: &str =
    "Esa reserva ya no se puede cancelar: el cliente ya ha llegado o la reserva ya está cerrada.";

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
            cliente,
            visto: None,
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

    /// Lo que se replica del último borrado: el texto de sus sentencias.
    async fn replicado(db: &Arc<Db>) -> Vec<String> {
        let json = texto(db, "SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;").await.unwrap();
        let sentencias: Vec<tpv_contracts::sync::SqlStatement> = serde_json::from_str(&json).unwrap();
        sentencias.into_iter().map(|s| s.sql).collect()
    }

    async fn sembrar(db: &Arc<Db>, filas: &[(&str, &str, &str)]) {
        let w = db.write().await;
        for (id, estado, origen) in filas {
            w.raw()
                .execute(
                    "INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Comensales, Estado, Origen) \
                     VALUES (?1, '2026-05-10', '21:00', 'CENA', 2, ?2, ?3);",
                    vec![Value::Text((*id).into()), Value::Text((*estado).into()), Value::Text((*origen).into())],
                )
                .await
                .unwrap();
        }
    }

    async fn estado_de(db: &Arc<Db>, id: &str) -> Option<String> {
        texto(db, &format!("SELECT Estado FROM Reservas WHERE ID_Reserva = '{id}';")).await
    }

    #[tokio::test]
    async fn no_vino_marca_las_que_llevan_su_rato_sin_llegar_y_nada_con_el_ajuste_a_cero() {
        let (db, repo, _dir) = abrir().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Comensales, Estado) VALUES \
                       ('hace-una-hora', '2026-05-10', '20:00', 'CENA', 2, 'PROXIMA'), \
                       ('justo', '2026-05-10', '20:30', 'CENA', 2, 'PROXIMA'), \
                       ('aun-no', '2026-05-10', '20:31', 'CENA', 2, 'PROXIMA'), \
                       ('de-ayer', '2026-05-09', '21:00', 'CENA', 2, 'PROXIMA'), \
                       ('sentada', '2026-05-10', '19:00', 'CENA', 2, 'ACTIVA'), \
                       ('cancelada', '2026-05-10', '19:00', 'CENA', 2, 'CANCELADA');",
                )
                .await
                .unwrap();
        }
        let estado = |id: &'static str| {
            let db = db.clone();
            async move { texto(&db, &format!("SELECT Estado FROM Reservas WHERE ID_Reserva = '{id}';")).await }
        };

        // Con el ajuste a 0 (lo de siempre), nunca.
        assert_eq!(repo.marcar_no_vino("2026-05-10 21:00", 200).await.unwrap(), 0);
        assert_eq!(estado("de-ayer").await.as_deref(), Some("PROXIMA"));

        // A la media hora: lo que lleva 30 minutos o más sin llegar, y nada más.
        db.write().await.raw().execute("UPDATE Business_Settings SET Reserva_No_Vino_Min = 30;", ()).await.unwrap();
        assert_eq!(repo.marcar_no_vino("2026-05-10 21:00", 200).await.unwrap(), 3);
        for id in ["hace-una-hora", "justo", "de-ayer"] {
            assert_eq!(estado(id).await.as_deref(), Some("NO_SHOW"), "{id}");
        }
        assert_eq!(estado("aun-no").await.as_deref(), Some("PROXIMA"));
        assert_eq!(estado("sentada").await.as_deref(), Some("ACTIVA"));
        assert_eq!(estado("cancelada").await.as_deref(), Some("CANCELADA"));
        // Se replica una sentencia por reserva, sin la condición de la hora.
        assert_eq!(replicado(&db).await, [SQL_NO_VINO; 3]);

        // A las 21:01 también le toca a «aun-no».
        assert_eq!(repo.marcar_no_vino("2026-05-10 21:01", 200).await.unwrap(), 1);
        assert_eq!(estado("aun-no").await.as_deref(), Some("NO_SHOW"));
    }

    #[tokio::test]
    async fn no_vino_va_por_tandas_y_empieza_por_las_mas_recientes() {
        // Al encender el ajuste con un histórico de reservas viejas sin cerrar, la de hoy no espera a
        // que se vacíe: sale en la primera tanda, y las viejas en las siguientes.
        let (db, repo, _dir) = abrir().await;
        {
            let w = db.write().await;
            w.raw()
                .execute_batch(
                    "UPDATE Business_Settings SET Reserva_No_Vino_Min = 30; \
                     INSERT INTO Reservas (ID_Reserva, Dia_YMD, Hora, Turno, Comensales, Estado) VALUES \
                       ('vieja-1', '2025-01-10', '21:00', 'CENA', 2, 'PROXIMA'), \
                       ('vieja-2', '2025-01-11', '21:00', 'CENA', 2, 'PROXIMA'), \
                       ('vieja-3', '2025-01-12', '21:00', 'CENA', 2, 'PROXIMA'), \
                       ('de-hoy', '2026-05-10', '20:00', 'CENA', 2, 'PROXIMA');",
                )
                .await
                .unwrap();
        }
        let por_llegar = || {
            let db = db.clone();
            async move {
                texto(
                    &db,
                    "SELECT group_concat(ID_Reserva, ',') FROM \
                     (SELECT ID_Reserva FROM Reservas WHERE Estado = 'PROXIMA' ORDER BY ID_Reserva);",
                )
                .await
            }
        };

        assert_eq!(repo.marcar_no_vino("2026-05-10 21:00", 2).await.unwrap(), 2);
        assert_eq!(por_llegar().await.as_deref(), Some("vieja-1,vieja-2"));
        assert_eq!(repo.marcar_no_vino("2026-05-10 21:00", 2).await.unwrap(), 2);
        assert_eq!(por_llegar().await, None);
        assert_eq!(repo.marcar_no_vino("2026-05-10 21:00", 2).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn una_reserva_web_no_se_borra_nunca() {
        // Ni por venir ni ya cerrada (§5.6): borrarla dejaba al cliente sin el correo de
        // cancelación si se borraba dos veces seguidas. Se cancela, y se queda.
        let (db, repo, _dir) = abrir().await;
        sembrar(&db, &[("web", "PROXIMA", "WEB"), ("web-cancelada", "CANCELADA", "WEB"), ("tpv", "CANCELADA", "TPV")]).await;
        for id in ["web", "web-cancelada"] {
            let e = repo.eliminar(id).await.unwrap_err();
            assert_eq!((e.code(), e.to_string().contains(MSG_WEB_NO_SE_BORRA)), (ErrorCode::Conflict, true), "{id}");
        }
        assert_eq!(texto(&db, "SELECT CAST(COUNT(*) AS TEXT) FROM Reservas;").await.as_deref(), Some("3"));

        // Una del TPV se borra, cancelada o no, y se replica sólo el borrado.
        assert!(repo.eliminar("tpv").await.unwrap());
        assert_eq!(replicado(&db).await, [SQL_DESVINCULAR_COMANDAS, SQL_BORRAR]);
        assert!(!repo.eliminar("tpv").await.unwrap());
    }

    #[tokio::test]
    async fn cancelar_decide_al_escribir_y_replica_solo_la_cancelacion() {
        // La otra copia puede tener la reserva en otro estado (una Handy la sentó): una sentencia
        // condicionada al estado haría allí otra cosa. Se replica la cancelación, sin más.
        let (db, repo, _dir) = abrir().await;
        sembrar(&db, &[("web", "PROXIMA", "WEB"), ("tpv", "PROXIMA", "TPV"), ("sentada", "ACTIVA", "TPV"), ("no-vino", "NO_SHOW", "WEB")]).await;
        for id in ["web", "tpv"] {
            assert!(repo.cancelar(id).await.unwrap(), "{id}");
            assert_eq!(replicado(&db).await, [SQL_CANCELAR]);
            assert_eq!(estado_de(&db, id).await.as_deref(), Some("CANCELADA"));
        }

        // Ya cancelada: no vuelve a escribir. Inexistente: `false`.
        let antes = texto(&db, "SELECT CAST(COUNT(*) AS TEXT) FROM _Sync_Outbox;").await;
        assert!(repo.cancelar("web").await.unwrap());
        assert!(!repo.cancelar("no-existe").await.unwrap());
        assert_eq!(texto(&db, "SELECT CAST(COUNT(*) AS TEXT) FROM _Sync_Outbox;").await, antes);

        // Sentada o sin presentarse ya no se cancela.
        for id in ["sentada", "no-vino"] {
            let e = repo.cancelar(id).await.unwrap_err();
            assert_eq!(e.code(), ErrorCode::Conflict, "{id}");
        }
        assert_eq!(estado_de(&db, "sentada").await.as_deref(), Some("ACTIVA"));
        assert_eq!(estado_de(&db, "no-vino").await.as_deref(), Some("NO_SHOW"));
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
            cliente: ClienteReserva::Ninguno,
            visto: None,
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

    /// RES-04: una comanda abierta ocupa la mesa todo el día: no se sabe cuándo se irá quien está
    /// sentado. Hoy no se puede reservar a ninguna hora, ni confirmando el aviso; mañana sí; y al
    /// cerrarse la comanda, hoy también.
    #[tokio::test]
    async fn una_comanda_abierta_no_deja_reservar_hoy_pero_si_manana() {
        let (db, repo, _dir) = abrir().await;
        sql(
            &db,
            "INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado)              VALUES ('c1', 'm1', 'MESA', datetime('now','localtime','-10 minutes'), 'Abierta');",
        )
        .await;
        let ahora = Local::now();
        let hoy = ahora.format("%Y-%m-%d").to_string();
        let manana = (ahora + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();

        for (hora, forzar) in [(ahora.format("%H:%M").to_string(), false), ("23:59".to_string(), true)] {
            let r = repo.guardar(reserva(&hoy, &hora, None), forzar).await;
            assert!(
                matches!(&r, Err(AppError::Conflict(m)) if m.contains("hoy no se puede reservar")),
                "{hora}: {r:?}"
            );
        }
        assert!(repo.guardar(reserva(&manana, "14:00", None), false).await.unwrap());

        sql(&db, "UPDATE Comandas SET Estado = 'Pagada';").await;
        assert!(repo.guardar(reserva(&hoy, "23:59", None), false).await.unwrap());
    }

    /// RES-04: no cuenta la comanda de la propia reserva (sus clientes ya están sentados), ni la de
    /// una reserva que ya era de esa mesa ese día: cambiarle la nota no crea el choque.
    #[tokio::test]
    async fn la_comanda_no_bloquea_cambiar_una_reserva_que_ya_era_de_la_mesa() {
        let (db, repo, _dir) = abrir().await;
        let hoy = Local::now().format("%Y-%m-%d").to_string();
        let mut r = reserva(&hoy, "23:00", None);
        r.id = Some("r1".into());
        repo.guardar(r.clone(), false).await.unwrap();
        sql(
            &db,
            "INSERT INTO Comandas (ID_Comanda, ID_Mesa, Canal, Fecha_Hora_Apertura, Estado)              VALUES ('ajena', 'm1', 'MESA', datetime('now','localtime'), 'Abierta');",
        )
        .await;

        r.nota = Some("Cumpleaños".into());
        assert!(repo.guardar(r.clone(), false).await.unwrap());

        // La suya: los clientes han llegado y se ha abierto su comanda.
        sql(&db, "UPDATE Comandas SET ID_Reserva = 'r1' WHERE ID_Comanda = 'ajena';").await;
        assert!(repo.guardar(r, false).await.unwrap());
    }

    /// SYN-INC-04: un formulario que seguía abierto mientras otro equipo cancelaba la reserva la
    /// cambió igual (de ocho a siete comensales, cancelada). Una cerrada ya no se cambia; una viva sí.
    #[tokio::test]
    async fn una_reserva_cerrada_no_se_cambia() {
        let (db, repo, _dir) = abrir().await;
        let mut r = reserva("2026-05-10", "21:00", None);
        r.id = Some("r1".into());
        repo.guardar(r.clone(), false).await.unwrap();
        r.comensales = 7;

        for estado in ["CANCELADA", "FINALIZADA", "NO_SHOW"] {
            sql(&db, &format!("UPDATE Reservas SET Estado = '{estado}';")).await;
            let e = repo.guardar(r.clone(), false).await;
            assert!(matches!(&e, Err(AppError::Conflict(m)) if m == MSG_RESERVA_CERRADA), "{estado}: {e:?}");
        }
        let g = db.read().await;
        let n = select_one_i64(&g, "SELECT Comensales FROM Reservas;", vec![]).await.unwrap().unwrap();
        drop(g);
        assert_eq!(n, 2, "no se ha tocado");

        for estado in ["ACTIVA", "PROXIMA"] {
            sql(&db, &format!("UPDATE Reservas SET Estado = '{estado}';")).await;
            assert!(repo.guardar(r.clone(), false).await.unwrap(), "{estado}");
        }
    }

    /// RES-INC-03: la Main subió los comensales de 2 a 3 con la reserva abierta en una Handy, que
    /// sólo tocó la nota; al guardar, la Handy volvió a escribir sus 2. La edición trae ahora lo que
    /// vio el formulario, y si la reserva ya no está así, no se guarda.
    #[tokio::test]
    async fn una_edicion_sobre_una_reserva_que_ha_cambiado_no_se_guarda() {
        let (db, repo, _dir) = abrir().await;
        let mut r = reserva("2026-05-10", "21:00", None);
        r.id = Some("r1".into());
        repo.guardar(r.clone(), false).await.unwrap();
        let vista = ReservaVista {
            id_mesa: "m1".into(),
            dia_ymd: "2026-05-10".into(),
            hora: "21:00".into(),
            comensales: 2,
            duracion_min: None,
            nota: None,
            id_cliente: None,
        };

        // La Main: 3 comensales.
        let mut main = r.clone();
        main.comensales = 3;
        main.visto = Some(vista.clone());
        repo.guardar(main, false).await.unwrap();

        // La Handy, con lo de antes: sólo la nota.
        let mut handy = r.clone();
        handy.nota = Some("Cumpleaños".into());
        handy.visto = Some(vista.clone());
        let e = repo.guardar(handy.clone(), false).await;
        assert!(matches!(&e, Err(AppError::Conflict(m)) if m == MSG_RESERVA_CAMBIADA_AL_EDITAR), "{e:?}");
        let g = db.read().await;
        let ahora = select_one_string(&g, "SELECT Comensales || '|' || COALESCE(Nota, '') FROM Reservas;", vec![]).await.unwrap();
        drop(g);
        assert_eq!(ahora.as_deref(), Some("3|"));

        // Con lo de ahora, sí.
        handy.comensales = 3;
        handy.visto = Some(ReservaVista { comensales: 3, ..vista.clone() });
        assert!(repo.guardar(handy, false).await.unwrap());

        // Una borrada entretanto no vuelve: la edición no la crea de nuevo.
        sql(&db, "DELETE FROM Reservas;").await;
        let mut tarde = r.clone();
        tarde.visto = Some(vista);
        assert!(repo.guardar(tarde, false).await.is_err());
        let g = db.read().await;
        assert_eq!(select_one_i64(&g, "SELECT COUNT(*) FROM Reservas;", vec![]).await.unwrap(), Some(0));
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

