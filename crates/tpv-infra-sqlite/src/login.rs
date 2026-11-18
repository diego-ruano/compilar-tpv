//! Adaptador SQLite del repositorio de **login / auth / fichaje**. Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id.
//!
//! El puerto es de grano grueso: la verificación del PIN forma parte de cada operación.
//! Aquí se hace en local con la cripto del dominio (`verify_pin`/`hash_pin`); las consultas
//! finas (registro, hash, setup, email) son funciones privadas que componen esas operaciones.

use crate::util::new_id;
use crate::consultas::{db_err};
use std::sync::Arc;

use async_trait::async_trait;
use chrono::Local;
use crate::ejecutor::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::login::LoginRepository;
use tpv_contracts::login::{LoginOk, PunchParte, PunchStatus, SetupPendiente, UserListItem};
use tpv_domain::login::{
    hash_needs_upgrade, hash_pin, verify_pin, LoginUserRecord, SetupInfo,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::v_i64;

pub struct SqliteLoginRepository {
    db: Arc<Db>,
}

impl SqliteLoginRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

}

/// ¿Hay AL MENOS un usuario en la BD? Ver `setup_pendiente`: cero usuarios no es un estado
/// alcanzable en una instalación nueva, es la firma de una BD perdida.
async fn hay_algun_usuario<C: Reader>(conn: &C) -> AppResult<bool> {
    let mut rows = conn
        .query("SELECT COUNT(*) FROM Usuarios;", ())
        .await
        .map_err(db_err)?;
    let n = match rows.next().await.map_err(db_err)? {
        Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
        None => 0,
    };
    Ok(n > 0)
}

fn today_ymd() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}


fn now_iso() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/// RI-05: la entrada más antigua que todavía cuenta como **jornada en curso**. La jornada se busca
/// por su hora de entrada y no por su `Fecha`: quien entra a las 18:00 y sale a la 01:30 ficha la
/// salida al día siguiente, y buscarla por `Fecha = hoy` no la encontraba. Peor: la pantalla, al
/// no ver nada abierto hoy, mandaba una ENTRADA nueva a la 01:30, que se cerraba con la salida de la
/// noche siguiente como una jornada de dieciséis horas.
///
/// Pasado este margen el fichaje se da por olvidado: ni la entrada ni la salida lo ven, y lo cierra
/// [`auto_close_stale_punches`] como incidencia. Son 16 h y no 24 porque una jornada de día con la
/// salida olvidada (entrada a las 09:00) tiene que haber caducado a la mañana siguiente; si no, el
/// primer fichaje del día cerraría la de ayer con veinticuatro horas trabajadas. 16 h cubren de
/// sobra un turno de noche o uno doble.
///
/// La `Fecha` del fichaje sigue siendo la del día en que se entró. El worker usa el mismo margen
/// (`INICIO_MAS_ANTIGUO` en `login.queries.ts`).
const INICIO_MAS_ANTIGUO: &str = "datetime('now','localtime','-16 hours')";

/// El fichaje en curso del usuario (ver [`INICIO_MAS_ANTIGUO`]), sea del día que sea: su id y su
/// `Fecha`.
async fn fichaje_en_curso<C: Reader>(
    conn: &C,
    id_usuario: &str,
) -> AppResult<Option<(String, String)>> {
    let mut rows = conn
        .query(
            &format!(
                "SELECT ID_Fichaje, Fecha FROM Fichajes \
                 WHERE ID_Usuario = ?1 \
                   AND Estado = 'ABIERTO' \
                   AND Hora_Entrada IS NOT NULL \
                   AND Hora_Salida IS NULL \
                   AND Hora_Entrada >= {INICIO_MAS_ANTIGUO} \
                 ORDER BY Hora_Entrada DESC, ID_Fichaje DESC \
                 LIMIT 1;"
            ),
            vec![Value::Text(id_usuario.to_string())],
        )
        .await
        .map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    let id = match row.get_value(0).map_err(db_err)? {
        Value::Text(s) => s,
        _ => return Err(AppError::repository("ID_Fichaje inválido")),
    };
    let fecha = match row.get_value(1).map_err(db_err)? {
        Value::Text(s) => s,
        _ => return Err(AppError::repository("Fecha de fichaje inválida")),
    };
    Ok(Some((id, fecha)))
}

/// ¿Tiene el usuario una jornada de las mismas horas (ver [`INICIO_MAS_ANTIGUO`]) con la salida ya
/// puesta? Es lo que hay cuando otro equipo ha fichado la salida que esta pantalla todavía ofrecía.
async fn salida_reciente<C: Reader>(conn: &C, id_usuario: &str) -> AppResult<bool> {
    let mut rows = conn
        .query(
            &format!(
                "SELECT EXISTS (SELECT 1 FROM Fichajes \
                 WHERE ID_Usuario = ?1 AND Hora_Salida IS NOT NULL \
                   AND Hora_Entrada >= {INICIO_MAS_ANTIGUO});"
            ),
            vec![Value::Text(id_usuario.to_string())],
        )
        .await
        .map_err(db_err)?;
    Ok(match rows.next().await.map_err(db_err)? {
        Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0) != 0,
        None => false,
    })
}

/// TRAB-01: cierre automático de jornadas colgadas. Si un trabajador ficha entrada y olvida la
/// salida, su fichaje queda `ABIERTO` indefinidamente y corrompe las horas trabajadas que lee
/// `stats`. Esta función cierra los fichajes ABIERTOS que ya **no son jornada en curso** (entrada
/// anterior a [`INICIO_MAS_ANTIGUO`]) marcándolos `Cerrado_Automatico=1` + `Cierre_Motivo` +
/// `Incidencia` (para revisión manual) y **sin inventar hora de salida** (`Hora_Salida` queda
/// NULL). Es idempotente (los ya cerrados no vuelven a entrar) y va por el `Writer`, de modo que el
/// cambio se captura en el outbox y se replica a la nube.
///
/// RI-05: antes cerraba todo lo de `Fecha < hoy`, y como el job corre cada hora, el turno de noche
/// se cerraba solo pasada la medianoche, antes de que nadie pudiera fichar su salida. El fallback a
/// `Fecha` es para una fila sin hora de entrada, que sólo puede venir de fuera de `exec_punch`.
///
/// La ejecuta el job `fichajes_colgados` (RI-01): antes era un paso de `init_main`, que en un
/// arranque normal no llega a ejecutarse, y además un TPV que no se reinicia en días no cerraría
/// nunca nada. Por eso pregunta antes de escribir: `execute()` sube al outbox toda escritura, toque
/// filas o no, y un `UPDATE` a ciegas cada hora sería una operación vacía por hora en la nube.
pub async fn auto_close_stale_punches(db: &Db) -> AppResult<u64> {
    let colgado = format!(
        "Estado = 'ABIERTO' \
         AND Hora_Salida IS NULL \
         AND COALESCE(Hora_Entrada, Fecha) < {INICIO_MAS_ANTIGUO}"
    );

    let conn = db.write().await;
    let hay = {
        let mut rows = conn
            .query(
                &format!("SELECT EXISTS (SELECT 1 FROM Fichajes WHERE {colgado});"),
                Vec::<Value>::new(),
            )
            .await
            .map_err(db_err)?;
        match rows.next().await.map_err(db_err)? {
            Some(row) => v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0) != 0,
            None => false,
        }
    };
    if !hay {
        return Ok(0);
    }

    let affected = conn
        .execute(
            &format!(
                "UPDATE Fichajes \
                 SET Estado = 'CERRADO', \
                     Cerrado_Automatico = 1, \
                     Cierre_Motivo = 'Cierre automático: jornada sin fichar salida', \
                     Incidencia = 'Falta fichar la salida' \
                 WHERE {colgado};"
            ),
            Vec::<Value>::new(),
        )
        .await
        .map_err(db_err)?;
    Ok(affected)
}

async fn get_turno_partido_for<C: Reader>(
    conn: &C,
    id_usuario: &str,
    fecha: &str,
) -> AppResult<i64> {
    let mut rows = conn
        .query(
            r#"
            SELECT Turno_Partido
            FROM Fichaje_Dia
            WHERE ID_Usuario=?1 AND Fecha=?2
            LIMIT 1;
            "#,
            vec![Value::Text(id_usuario.to_string()), Value::Text(fecha.to_string())],
        )
        .await
        .map_err(db_err)?;

    if let Some(row) = rows.next().await.map_err(db_err)? {
        let v = match row.get_value(0).map_err(db_err)? {
            Value::Integer(n) => n,
            _ => 0,
        };
        return Ok(v);
    }
    Ok(0)
}

async fn build_punch_status<C: Reader>(
    conn: &C,
    id_usuario: &str,
    fecha: &str,
) -> AppResult<PunchStatus> {
    let turno_partido = get_turno_partido_for(conn, id_usuario, fecha).await?;

    let mut rows = conn
        .query(
            r#"
            SELECT Parte, Hora_Entrada, Hora_Salida, Estado
            FROM Fichajes
            WHERE ID_Usuario=?1 AND Fecha=?2
            ORDER BY Parte ASC;
            "#,
            vec![Value::Text(id_usuario.to_string()), Value::Text(fecha.to_string())],
        )
        .await
        .map_err(db_err)?;

    let mut partes: Vec<PunchParte> = vec![];

    while let Some(row) = rows.next().await.map_err(db_err)? {
        let parte = match row.get_value(0).map_err(db_err)? {
            Value::Integer(n) => n,
            _ => 1,
        };
        let entrada = match row.get_value(1).map_err(db_err)? {
            Value::Null => None,
            Value::Text(s) => Some(s),
            _ => None,
        };
        let salida = match row.get_value(2).map_err(db_err)? {
            Value::Null => None,
            Value::Text(s) => Some(s),
            _ => None,
        };
        let estado = match row.get_value(3).map_err(db_err)? {
            Value::Text(s) => tpv_domain::estados::EstadoFichaje::desde_texto(&s).map_err(db_err)?.como_texto().to_string(),
            _ => tpv_domain::estados::EstadoFichaje::Abierto.como_texto().into(),
        };

        partes.push(PunchParte {
            parte,
            entrada,
            salida,
            estado,
        });
    }

    Ok(PunchStatus {
        fecha: fecha.to_string(),
        turno_partido,
        partes,
    })
}

/* =========================================================
   Consultas finas (privadas): las operaciones gruesas del trait las componen.
========================================================= */

async fn query_login_record<C: Reader>(
    conn: &C,
    id_usuario: &str,
) -> AppResult<Option<LoginUserRecord>> {
    let mut rows = conn
        .query(
            r#"
            SELECT u.ID_Usuario, t.ID_Trabajador, u.Nombre, u.Apellido, u.Email,
                   u.Password_Hash, u.Requiere_Setup, r.Nombre_Rol, u.Sin_PIN
            FROM Usuarios u
            JOIN Roles r ON r.ID_Rol = u.ID_Rol
            LEFT JOIN Trabajadores t ON t.ID_Usuario = u.ID_Usuario
            WHERE u.ID_Usuario = ?1 AND u.Estado = 'Activo'
            LIMIT 1;
            "#,
            vec![Value::Text(id_usuario.to_string())],
        )
        .await
        .map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };

    let id = match row.get_value(0).map_err(db_err)? {
        Value::Text(s) => s,
        _ => return Err(AppError::repository("ID_Usuario inválido")),
    };
    let id_trabajador = match row.get_value(1).map_err(db_err)? {
        Value::Text(s) => Some(s),
        _ => None,
    };
    let nombre = match row.get_value(2).map_err(db_err)? {
        Value::Text(s) => s,
        _ => "".into(),
    };
    let apellido = match row.get_value(3).map_err(db_err)? {
        Value::Null => None,
        Value::Text(s) => Some(s),
        _ => None,
    };
    // LOGIN-06: Email es NULLABLE en el esquema; su ausencia se representa explícitamente como
    // cadena vacía (no con un `admin@local` falso que enmascare el dato faltante).
    let email = match row.get_value(4).map_err(db_err)? {
        Value::Text(s) => s,
        Value::Null => String::new(),
        _ => return Err(AppError::repository("Email inválido")),
    };
    let password_hash = match row.get_value(5).map_err(db_err)? {
        Value::Text(s) => s,
        _ => return Err(AppError::repository("Password_Hash inválido")),
    };
    let requiere_setup = match row.get_value(6).map_err(db_err)? {
        Value::Integer(n) => n,
        _ => 0,
    };
    // LOGIN-06: el rol es crítico (base de la autorización). Su ausencia es un error, no un
    // `"Sin rol"` silencioso que podría confundir o degradar comprobaciones de rol.
    let rol = match row.get_value(7).map_err(db_err)? {
        Value::Text(s) => s,
        _ => return Err(AppError::repository("Rol de usuario inválido")),
    };
    let sin_pin = v_i64(row.get_value(8).map_err(db_err)?).unwrap_or(0) == 1;

    Ok(Some(LoginUserRecord {
        id_usuario: id,
        id_trabajador,
        nombre,
        apellido,
        email,
        password_hash,
        requiere_setup,
        rol,
        sin_pin,
    }))
}

/// El PIN guardado de un usuario activo y si entra sin él (`Sin_PIN`).
async fn query_password_hash<C: Reader>(
    conn: &C,
    id_usuario: &str,
) -> AppResult<Option<(String, bool)>> {
    let mut rows = conn
        .query(
            r#"
            SELECT Password_Hash, Sin_PIN
            FROM Usuarios
            WHERE ID_Usuario = ?1 AND Estado = 'Activo'
            LIMIT 1;
            "#,
            vec![Value::Text(id_usuario.to_string())],
        )
        .await
        .map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    let hash = match row.get_value(0).map_err(db_err)? {
        Value::Text(s) => s,
        _ => return Err(AppError::repository("Password_Hash inválido")),
    };
    let sin_pin = v_i64(row.get_value(1).map_err(db_err)?).unwrap_or(0) == 1;
    Ok(Some((hash, sin_pin)))
}

/// Comprueba el PIN de un login o un fichaje con el freno de LOGIN-01: mira el bloqueo antes y
/// cuenta el intento después. A quien entra sin PIN (`Sin_PIN = 1`) no se le comprueba nada: no hay
/// secreto que adivinar, y un bloqueo que le quedara de antes le dejaría fuera sin poder hacer nada.
async fn comprobar_pin(db: &Db, id_usuario: &str, pin: &str, hash: &str, sin_pin: bool) -> AppResult<()> {
    if sin_pin {
        return Ok(());
    }
    crate::auth::throttle_check(db, id_usuario).await?;
    if let Err(e) = verificar_pin_sin_bloquear(pin, hash).await? {
        let _ = crate::auth::throttle_registrar(db, id_usuario, false).await;
        return Err(AppError::validation(e));
    }
    let _ = crate::auth::throttle_registrar(db, id_usuario, true).await;
    Ok(())
}

async fn query_setup_info<C: Reader>(conn: &C, id_usuario: &str) -> AppResult<Option<SetupInfo>> {
    let mut rows = conn
        .query(
            r#"
            SELECT Password_Hash, Requiere_Setup
            FROM Usuarios
            WHERE ID_Usuario = ?1 AND Estado='Activo'
            LIMIT 1;
            "#,
            vec![Value::Text(id_usuario.to_string())],
        )
        .await
        .map_err(db_err)?;

    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    let password_hash = match row.get_value(0).map_err(db_err)? {
        Value::Text(s) => s,
        _ => return Err(AppError::repository("Password_Hash inválido")),
    };
    let requiere_setup = match row.get_value(1).map_err(db_err)? {
        Value::Integer(n) => n,
        _ => 0,
    };
    Ok(Some(SetupInfo {
        password_hash,
        requiere_setup,
    }))
}

/// El correo del administrador se queda el del seed: nadie lo lee, y el de recuperar el PIN es otro
/// (`correo_recuperacion`, en la base central).
async fn exec_apply_initial_setup<C: Writer>(
    conn: &C,
    id_usuario: &str,
    new_hash: String,
) -> AppResult<()> {
    conn.execute(
        r#"
        UPDATE Usuarios
        SET Password_Hash = ?2, Requiere_Setup = 0
        WHERE ID_Usuario = ?1;
        "#,
        vec![Value::Text(id_usuario.to_string()), Value::Text(new_hash)],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}

/// `pub(crate)` para que el harness de contrato pueda comprobar el EFECTO del fichaje sin pasar por
/// la verificación del PIN (que es lo que mantenía a `punch` fuera del harness — y por ese hueco
/// entró TRAB-07, el INSERT del worker sin `ID_Fichaje`).
pub(crate) async fn exec_punch<C: Writer>(
    conn: &C,
    id_usuario: &str,
    tipo: &str,
) -> AppResult<PunchStatus> {
    // TRAB-02: el control horario debe ser VERAZ, así que la fecha y la hora las pone el equipo que
    // ficha y NO viajan en la petición — llegaron a viajar, sin que nadie las leyera, y ya ni
    // existen en la entrada. No hay flujo de corrección manual que preservar; si en el futuro se
    // añade, debe ser una operación admin separada y auditada.
    let fecha = today_ymd();
    let hora_evento = now_iso();

    let res: AppResult<PunchStatus> = conn.transaccion(async {
        if tipo == "entrada" {
            // RI-05: el abierto que bloquea puede ser de ayer (un turno de noche sin cerrar).
            if fichaje_en_curso(conn, id_usuario).await?.is_some() {
                return Err(AppError::conflict(
                    "Tienes un fichaje abierto. Ficha salida antes de fichar entrada.",
                ));
            }

            let turno_partido = get_turno_partido_for(conn, id_usuario, &fecha).await?;

            let mut p1 = conn
                .query(
                    r#"
                    SELECT Hora_Entrada, Hora_Salida
                    FROM Fichajes
                    WHERE ID_Usuario=?1 AND Fecha=?2 AND Parte=1
                    LIMIT 1;
                    "#,
                    vec![Value::Text(id_usuario.to_string()), Value::Text(fecha.clone())],
                )
                .await
                .map_err(db_err)?;

            let parte_a_abrir: i64 = if let Some(row) = p1.next().await.map_err(db_err)? {
                let salida = match row.get_value(1).map_err(db_err)? {
                    Value::Null => None,
                    Value::Text(s) => Some(s),
                    _ => None,
                };

                if salida.is_none() {
                    return Err(AppError::conflict(
                        "La Parte 1 no está cerrada. Ficha salida primero.",
                    ));
                }

                if turno_partido == 1 {
                    let mut p2 = conn
                        .query(
                            r#"
                            SELECT COUNT(*)
                            FROM Fichajes
                            WHERE ID_Usuario=?1 AND Fecha=?2 AND Parte=2;
                            "#,
                            vec![Value::Text(id_usuario.to_string()), Value::Text(fecha.clone())],
                        )
                        .await
                        .map_err(db_err)?;

                    let c2 = match p2.next().await.map_err(db_err)? {
                        Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
                        None => 0,
                    };

                    if c2 > 0 {
                        return Err(AppError::conflict("Ya has completado el turno partido hoy."));
                    }

                    2
                } else {
                    return Err(AppError::conflict(
                        "Hoy no tienes turno partido. Ya has fichado el día.",
                    ));
                }
            } else {
                1
            };

            conn.execute(
                r#"
                INSERT INTO Fichajes (
                  ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado, Cerrado_Automatico
                )
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'ABIERTO', 0);
                "#,
                vec![
                    Value::Text(new_id()),
                    Value::Text(id_usuario.to_string()),
                    Value::Text(fecha.clone()),
                    Value::Integer(parte_a_abrir),
                    Value::Text(hora_evento.clone()),
                ],
            )
            .await
            .map_err(db_err)?;

            build_punch_status(conn, id_usuario, &fecha).await
        } else {
            // RI-05: la jornada en curso, aunque empezara ayer. El estado que se devuelve es el
            // de SU día, que es el que se acaba de completar.
            let Some((id_f, fecha_jornada)) = fichaje_en_curso(conn, id_usuario).await? else {
                // TRA-INC-04: si la salida la acaba de fichar otro equipo (una Handy), se dice eso;
                // «primero ficha entrada» confundía a quien ya había entrado.
                if salida_reciente(conn, id_usuario).await? {
                    return Err(AppError::conflict("La salida ya está fichada."));
                }
                return Err(AppError::conflict(
                    "No hay fichaje abierto para cerrar (primero ficha entrada).",
                ));
            };

            // `Hora_Salida IS NULL` también en la sentencia: quien la aplica después (la nube) no
            // pisa una salida que ya tenga, como en el worker (`punchSalida`).
            conn.execute(
                r#"
                UPDATE Fichajes
                SET Hora_Salida = ?2,
                    Estado = 'CERRADO',
                    Cerrado_Automatico = 0,
                    Cierre_Motivo = NULL,
                    Incidencia = NULL
                WHERE ID_Fichaje = ?1 AND Hora_Salida IS NULL;
                "#,
                vec![Value::Text(id_f), Value::Text(hora_evento.clone())],
            )
            .await
            .map_err(db_err)?;

            build_punch_status(conn, id_usuario, &fecha_jornada).await
        }
    }).await;

    res
}

#[async_trait]
impl LoginRepository for SqliteLoginRepository {
    async fn list_login_users(&self) -> AppResult<Vec<UserListItem>> {
        let g = self.db.read().await;
        let db = &g;

        let mut rows = db
            .query(
                r#"
                SELECT u.ID_Usuario, u.Nombre, u.Apellido, r.Nombre_Rol, u.Sin_PIN
                FROM Usuarios u
                JOIN Roles r ON r.ID_Rol = u.ID_Rol
                WHERE u.Estado = 'Activo'
                ORDER BY u.Nombre ASC;
                "#,
                (),
            )
            .await
            .map_err(db_err)?;

        let mut out: Vec<UserListItem> = vec![];
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let id_usuario = match row.get_value(0).map_err(db_err)? {
                Value::Text(s) => s,
                _ => continue,
            };
            let nombre = match row.get_value(1).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "".into(),
            };
            let apellido = match row.get_value(2).map_err(db_err)? {
                Value::Null => None,
                Value::Text(s) => Some(s),
                _ => None,
            };
            let nombre_rol = match row.get_value(3).map_err(db_err)? {
                Value::Text(s) => s,
                _ => "Sin rol".into(),
            };
            let sin_pin = v_i64(row.get_value(4).map_err(db_err)?).unwrap_or(0) == 1;

            out.push(UserListItem {
                id_usuario,
                nombre,
                apellido,
                nombre_rol,
                sin_pin,
            });
        }
        Ok(out)
    }

    async fn setup_pendiente(&self) -> AppResult<SetupPendiente> {
        let g = self.db.read().await;
        let db = &g;

        // El seed deja UN admin con Requiere_Setup = 1 y el flag se apaga al completarlo, así que
        // esto es "equipo recién instalado". Se lee sin sesión: es lo que decide si la primera
        // pantalla es la de elegir PIN o la de login.
        let mut rows = db
            .query(
                r#"
                SELECT ID_Usuario, Nombre
                FROM Usuarios
                WHERE Requiere_Setup = 1 AND Estado = 'Activo'
                ORDER BY ID_Usuario ASC
                LIMIT 1;
                "#,
                (),
            )
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            // Sin admin pendiente hay dos mundos distintos: el normal (ya se hizo el setup) y el
            // de una BD que ha perdido a TODOS sus usuarios. Lo segundo es imposible en una
            // instalación nueva —el arranque siembra el admin— así que sólo ocurre cuando la
            // guardia de aprovisionamiento se negó a sembrar: la BD se perdió y hay que
            // reconstruirla desde la nube, no fabricar un admin nuevo.
            let sin_usuarios = !hay_algun_usuario(db).await?;
            return Ok(SetupPendiente {
                pendiente: false,
                requiere_recuperacion: sin_usuarios,
                id_usuario: None,
                nombre: None,
            });
        };

        let texto = |idx: i32| match row.get_value(idx) {
            Ok(Value::Text(s)) => Some(s),
            _ => None,
        };

        Ok(SetupPendiente {
            pendiente: true,
            requiere_recuperacion: false,
            id_usuario: texto(0),
            nombre: texto(1),
        })
    }

    /// RI-05: con una jornada en curso, el estado es el de SU día aunque haya empezado ayer. La
    /// pantalla decide si el siguiente fichaje es entrada o salida mirando este estado; con el de
    /// hoy, a la 01:30 un turno de noche aparecía sin empezar y se fichaba una entrada nueva.
    async fn get_today_punch_status(&self, id_usuario: &str) -> AppResult<PunchStatus> {
        let db = self.db.read().await;
        let fecha = match fichaje_en_curso(&db, id_usuario).await? {
            Some((_, fecha)) => fecha,
            None => today_ymd(),
        };
        build_punch_status(&db, id_usuario, &fecha).await
    }

    async fn intentos_fallidos(&self, id_usuario: &str) -> AppResult<i64> {
        let db = self.db.read().await;
        let mut rows = db
            .query(
                "SELECT Intentos_Fallidos FROM Intentos_Login WHERE ID_Usuario=?1 LIMIT 1;",
                vec![Value::Text(id_usuario.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(match rows.next().await.map_err(db_err)? {
            Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
            None => 0,
        })
    }

    async fn login(&self, id_usuario: &str, pin: &str) -> AppResult<LoginOk> {
        let rec = {
            let db = self.db.read().await;
            query_login_record(&db, id_usuario)
                .await?
                .ok_or_else(|| AppError::not_found("Usuario no encontrado o inactivo"))?
        };

        comprobar_pin(&self.db, id_usuario, pin, &rec.password_hash, rec.sin_pin).await?;

        // Rehash-en-login (LOGIN-04): si el hash usa menos iteraciones que el objetivo actual, se
        // recomputa con el PIN ya verificado y se actualiza. Best-effort: un fallo aquí NO rompe el
        // login. Hoy el objetivo es 100k → no-op; al subirlo (plan de pago) migra en el primer login.
        // Sin PIN no hay PIN verificado con el que rehacerlo.
        if !rec.sin_pin && hash_needs_upgrade(&rec.password_hash) {
            if let Ok(new_hash) = hash_pin(pin) {
                let w = self.db.write().await;
                let _ = w
                    .execute(
                        "UPDATE Usuarios SET Password_Hash = ?2 WHERE ID_Usuario = ?1;",
                        vec![Value::Text(rec.id_usuario.clone()), Value::Text(new_hash)],
                    )
                    .await;
            }
        }

        Ok(LoginOk {
            id_usuario: rec.id_usuario,
            id_trabajador: rec.id_trabajador,
            nombre: rec.nombre,
            apellido: rec.apellido,
            rol: rec.rol,
            email: rec.email,
            requiere_setup: rec.requiere_setup,
        })
    }

    /// No pide PIN actual: el setup del primer arranque ocurre ANTES del login, así que no hay
    /// ninguno que confirmar y el que hay es el del seed, que no es secreto. Quien autoriza es
    /// `Requiere_Setup = 1`, que además se apaga al aplicarlo: la puerta se cierra tras el primer
    /// uso. Es el ÚNICO cerrojo, y por eso esto sólo puede vivir donde está el dato (REV-06).
    async fn complete_initial_setup(&self, id_usuario: &str, pin_nuevo: &str) -> AppResult<()> {
        let db = self.db.write().await;
        let info = query_setup_info(&db, id_usuario)
            .await?
            .ok_or_else(|| AppError::not_found("Usuario no encontrado"))?;

        if info.requiere_setup == 0 {
            return Err(AppError::conflict("Este usuario ya completó el setup inicial"));
        }

        let new_hash = hash_pin(pin_nuevo).map_err(AppError::validation)?;

        exec_apply_initial_setup(&db, id_usuario, new_hash).await
    }

    /// LOGIN-07. Esto no pide PIN actual, así que no puede servir para cambiárselo a otro rol aunque
    /// alguien lo llame mal: el filtro de administrador activo va aquí, no sólo en el caso de uso.
    async fn restablecer_pin_admin(&self, id_usuario: &str, pin_nuevo: &str) -> AppResult<()> {
        let hash = hash_pin(pin_nuevo).map_err(AppError::validation)?;

        {
            let db = self.db.write().await;

            // Se comprueba ANTES de escribir, y no mirando las filas que tocó el `UPDATE`: una
            // escritura que no cambia nada se captura igual en el outbox y subiría a la nube como
            // una sentencia vacía. Dentro del mismo cerrojo, así que nadie cambia el rol entre medias.
            let mut rows = db
                .query(
                    r#"
                    SELECT 1
                    FROM Usuarios u
                    JOIN Roles r ON r.ID_Rol = u.ID_Rol
                    WHERE u.ID_Usuario = ?1 AND u.Estado = 'Activo' AND r.Nombre_Rol = 'Administrador'
                    LIMIT 1;
                    "#,
                    vec![Value::Text(id_usuario.to_string())],
                )
                .await
                .map_err(db_err)?;
            if rows.next().await.map_err(db_err)?.is_none() {
                return Err(AppError::not_found("No hay ningún administrador activo con ese usuario"));
            }

            // Por `execute` y no por `raw()`: el hash tiene que subir por el outbox, o la Handy
            // seguiría entrando con el PIN viejo. El filtro se repite como segunda red.
            db.execute(
                r#"
                UPDATE Usuarios
                SET Password_Hash = ?2
                WHERE ID_Usuario = ?1
                  AND Estado = 'Activo'
                  AND ID_Rol IN (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador');
                "#,
                vec![Value::Text(id_usuario.to_string()), Value::Text(hash)],
            )
            .await
            .map_err(db_err)?;
        }

        // Quien acaba de demostrar que es el titular no puede seguir bloqueado por los intentos
        // fallidos que le han traído hasta aquí. Best-effort, como en el login.
        let _ = crate::auth::throttle_registrar(&self.db, id_usuario, true).await;
        Ok(())
    }

    async fn punch(&self, id_usuario: &str, pin: &str, tipo: &str) -> AppResult<PunchStatus> {
        let (hash, sin_pin) = {
            let db = self.db.read().await;
            query_password_hash(&db, id_usuario)
                .await?
                .ok_or_else(|| AppError::not_found("Usuario no encontrado o inactivo"))?
        };

        comprobar_pin(&self.db, id_usuario, pin, &hash, sin_pin).await?;

        let db = self.db.write().await;
        exec_punch(&db, id_usuario, tipo).await
    }

    async fn set_turno_partido(
        &self,
        id_usuario: &str,
        fecha: Option<String>,
        turno_partido: bool,
    ) -> AppResult<()> {
        let db = self.db.write().await;
        let fecha = fecha.unwrap_or_else(today_ymd);

        // El WriteGuard excluye cualquier otra escritura hasta guardar el cambio.
        let mut partes = db.query(
            "SELECT 1 FROM Fichajes WHERE ID_Usuario=?1 AND Fecha=?2 AND Parte=2 LIMIT 1;",
            vec![Value::Text(id_usuario.to_string()), Value::Text(fecha.clone())],
        ).await.map_err(db_err)?;
        let hay_segunda = partes.next().await.map_err(db_err)?.is_some();
        tpv_domain::login::validar_cambio_turno_partido(turno_partido, hay_segunda)
            .map_err(AppError::conflict)?;

        db.execute(
            r#"
            INSERT INTO Fichaje_Dia (ID_Usuario, Fecha, Turno_Partido)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(ID_Usuario, Fecha) DO UPDATE SET
              Turno_Partido = excluded.Turno_Partido;
            "#,
            vec![
                Value::Text(id_usuario.to_string()),
                Value::Text(fecha),
                Value::Integer(if turno_partido { 1 } else { 0 }),
            ],
        )
        .await
        .map_err(db_err)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests_fichajes_colgados {
    //! TRAB-01 / RI-01: el cierre automático de las jornadas que quedaron abiertas.

    use super::*;

    async fn db_con_usuario() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("fichajes_colgados");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
                     VALUES ('u1', (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador'),
                             'u1@bar.test', 'h', 'Ana', 'Activo');",
                    Vec::<Value>::new(),
                )
                .await
                .unwrap();
        }
        (db, dir)
    }

    #[tokio::test]
    async fn acceso_exige_entrada_sin_abrir_sesion_durante_la_pausa_y_permite_salidas_finales() {
        use tpv_contracts::login::LoginUserArgs;
        let (db, _dir) = db_con_usuario().await;
        {
            let w = db.write().await;
            w.raw().execute("UPDATE Usuarios SET Password_Hash=?1 WHERE ID_Usuario='u1';",
                vec![Value::Text(hash_pin("1234").unwrap())]).await.unwrap();
        }
        let repo = SqliteLoginRepository::new(db.clone());
        let acceder = || tpv_application::use_cases::login::login_user(&repo, None,
            LoginUserArgs { id_usuario: "u1".into(), pin: "1234".into() });
        assert!(matches!(acceder().await, Err(AppError::Validation(_))));
        {
            let w = db.write().await;
            exec_punch(&w, "u1", "entrada").await.unwrap();
        }
        assert!(acceder().await.is_ok());
        {
            let w = db.write().await;
            exec_punch(&w, "u1", "salida").await.unwrap();
        }
        assert!(acceder().await.is_ok(), "la jornada continua cerrada permite acceder");
        repo.set_turno_partido("u1", None, true).await.unwrap();
        assert!(matches!(acceder().await, Err(AppError::Validation(_))), "la pausa requiere la segunda entrada");
        {
            let w = db.write().await;
            exec_punch(&w, "u1", "entrada").await.unwrap();
        }
        assert!(acceder().await.is_ok());
        assert!(matches!(repo.set_turno_partido("u1", None, false).await, Err(AppError::Conflict(_))));
        {
            let w = db.write().await;
            exec_punch(&w, "u1", "salida").await.unwrap();
        }
        assert!(acceder().await.is_ok(), "la jornada partida cerrada permite acceder");
        assert!(repo.set_turno_partido("u1", None, false).await.is_err());
        assert_eq!(repo.get_today_punch_status("u1").await.unwrap().partes.len(), 2, "el login no ficha");
    }

    /// Un fichaje abierto que entró hace `horas` horas. La hora se calcula en SQL, relativa a
    /// «ahora», para que el test no dependa de a qué hora se corra; la `Fecha` es la de la entrada.
    async fn abierto_hace(db: &Db, id: &str, horas: i64) {
        let w = db.write().await;
        w.raw()
            .execute(
                &format!(
                    "INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Estado)
                     VALUES (?1, 'u1', date('now','localtime','-{horas} hours'), 1,
                             datetime('now','localtime','-{horas} hours'), 'ABIERTO');"
                ),
                vec![Value::Text(id.into())],
            )
            .await
            .unwrap();
    }

    /// Un fichaje abierto con `Fecha` de AYER que entró hace `horas` horas: el turno de noche
    /// visto después de medianoche, sea cual sea la hora a la que corra el test.
    async fn abierto_ayer_hace(db: &Db, id: &str, horas: i64) {
        let w = db.write().await;
        w.raw()
            .execute(
                &format!(
                    "INSERT INTO Fichajes (ID_Fichaje, ID_Usuario, Fecha, Parte, Hora_Entrada, Estado)
                     VALUES (?1, 'u1', date('now','localtime','-1 day'), 1,
                             datetime('now','localtime','-{horas} hours'), 'ABIERTO');"
                ),
                vec![Value::Text(id.into())],
            )
            .await
            .unwrap();
    }

    async fn estado(db: &Db, id: &str) -> (String, i64) {
        let g = db.read().await;
        let mut rows = g
            .query(
                "SELECT Estado, Cerrado_Automatico FROM Fichajes WHERE ID_Fichaje = ?1;",
                vec![Value::Text(id.into())],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        (
            crate::mapping::v_string(row.get_value(0).unwrap()).unwrap_or_default(),
            v_i64(row.get_value(1).unwrap()).unwrap_or(0),
        )
    }

    async fn outbox(db: &Db) -> i64 {
        let g = db.read().await;
        let mut rows = g
            .query("SELECT COUNT(*) FROM _Sync_Outbox;", Vec::<Value>::new())
            .await
            .unwrap();
        v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap_or(0)
    }

    #[tokio::test]
    async fn cierra_la_olvidada_y_deja_la_en_curso() {
        // Con más de 24 h entre las dos, sus `Fecha` nunca coinciden (UNIQUE usuario-fecha-parte).
        let (db, _dir) = db_con_usuario().await;
        abierto_hace(&db, "olvidada", 30).await;
        abierto_hace(&db, "en_curso", 2).await;

        assert_eq!(auto_close_stale_punches(&db).await.unwrap(), 1);
        assert_eq!(estado(&db, "olvidada").await, ("CERRADO".into(), 1));
        assert_eq!(estado(&db, "en_curso").await, ("ABIERTO".into(), 0));

        // El cierre replica: la nube tiene que ver la misma jornada cerrada.
        assert_eq!(outbox(&db).await, 1);
    }

    #[tokio::test]
    async fn no_cierra_un_turno_de_noche_por_ser_de_ayer() {
        // RI-05: con `Fecha < hoy`, el job (cada hora) cerraba el turno de noche nada más pasar la
        // medianoche, antes de que su salida se pudiera fichar.
        let (db, _dir) = db_con_usuario().await;
        abierto_ayer_hace(&db, "noche", 3).await;

        assert_eq!(auto_close_stale_punches(&db).await.unwrap(), 0);
        assert_eq!(estado(&db, "noche").await, ("ABIERTO".into(), 0));
    }

    #[tokio::test]
    async fn sin_nada_colgado_no_sube_nada_a_la_nube() {
        // Corre cada hora: un `UPDATE` a ciegas serían veinticuatro operaciones vacías al día.
        let (db, _dir) = db_con_usuario().await;
        abierto_hace(&db, "en_curso", 2).await;

        assert_eq!(auto_close_stale_punches(&db).await.unwrap(), 0);
        assert_eq!(auto_close_stale_punches(&db).await.unwrap(), 0);
        assert_eq!(outbox(&db).await, 0);
    }

    #[tokio::test]
    async fn la_salida_que_ya_ficho_otro_equipo_lo_dice_y_no_se_pisa() {
        // TRA-INC-04: la Handy fichó la salida y la pantalla de la Main todavía la ofrecía.
        let (db, _dir) = db_con_usuario().await;
        abierto_hace(&db, "jornada", 3).await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "UPDATE Fichajes SET Hora_Salida = '2000-01-01 00:00:00', Estado = 'CERRADO' \
                     WHERE ID_Fichaje = 'jornada';",
                    Vec::<Value>::new(),
                )
                .await
                .unwrap();
        }

        let r = {
            let w = db.write().await;
            exec_punch(&w, "u1", "salida").await
        };
        match r {
            Err(AppError::Conflict(m)) => assert_eq!(m, "La salida ya está fichada."),
            otro => panic!("{otro:?}"),
        }
        assert_eq!(outbox(&db).await, 0, "no sube nada");

        // Sin ninguna jornada de estas horas, la frase de siempre.
        let (db, _dir) = db_con_usuario().await;
        let r = {
            let w = db.write().await;
            exec_punch(&w, "u1", "salida").await
        };
        match r {
            Err(AppError::Conflict(m)) => {
                assert_eq!(m, "No hay fichaje abierto para cerrar (primero ficha entrada).")
            }
            otro => panic!("{otro:?}"),
        }
    }

    #[tokio::test]
    async fn la_salida_que_sube_no_pisa_una_que_ya_este_puesta() {
        // Lo que sube por el outbox lo aplica la nube con sus datos: si allí la salida ya está
        // puesta (otra Handy), la sentencia no la cambia.
        let (db, _dir) = db_con_usuario().await;
        abierto_hace(&db, "jornada", 3).await;
        {
            let w = db.write().await;
            exec_punch(&w, "u1", "salida").await.unwrap();
        }
        let g = db.read().await;
        let mut rows = g
            .query("SELECT Statements_Json FROM _Sync_Outbox;", Vec::<Value>::new())
            .await
            .unwrap();
        let sql = crate::mapping::v_string(rows.next().await.unwrap().unwrap().get_value(0).unwrap())
            .unwrap_or_default();
        assert!(sql.contains("AND Hora_Salida IS NULL"), "{sql}");
    }

    /* RI-05: el turno de noche, de la entrada a la salida. */

    fn ayer() -> String {
        (Local::now().date_naive() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string()
    }

    #[tokio::test]
    async fn la_salida_cierra_la_jornada_que_empezo_ayer() {
        let (db, _dir) = db_con_usuario().await;
        abierto_ayer_hace(&db, "noche", 3).await;

        let status = {
            let w = db.write().await;
            exec_punch(&w, "u1", "salida").await.unwrap()
        };

        assert_eq!(estado(&db, "noche").await, ("CERRADO".into(), 0));
        // El estado devuelto es el de la jornada que se cierra, no el de hoy (que está vacío).
        assert_eq!(status.fecha, ayer());
        assert_eq!(status.partes.len(), 1);
        assert!(status.partes[0].salida.is_some());
    }

    #[tokio::test]
    async fn el_estado_ensena_la_jornada_en_curso_de_ayer() {
        // Es lo que mira la pantalla para elegir entre entrada y salida: con el estado de hoy, a
        // la 01:30 mandaba una ENTRADA nueva.
        let (db, _dir) = db_con_usuario().await;
        abierto_ayer_hace(&db, "noche", 3).await;

        let status = SqliteLoginRepository::new(db.clone())
            .get_today_punch_status("u1")
            .await
            .unwrap();

        assert_eq!(status.fecha, ayer());
        assert_eq!(status.partes.len(), 1);
        assert!(status.partes[0].entrada.is_some());
        assert!(status.partes[0].salida.is_none());
    }

    #[tokio::test]
    async fn la_entrada_ve_la_jornada_en_curso_de_ayer() {
        let (db, _dir) = db_con_usuario().await;
        abierto_ayer_hace(&db, "noche", 3).await;

        let r = {
            let w = db.write().await;
            exec_punch(&w, "u1", "entrada").await
        };

        assert!(matches!(r, Err(AppError::Conflict(_))), "{r:?}");
        assert_eq!(estado(&db, "noche").await, ("ABIERTO".into(), 0));
    }

    #[tokio::test]
    async fn una_jornada_olvidada_no_impide_fichar_ni_la_cierra_la_salida() {
        // Pasado el margen, el fichaje es del auto-cierre: ni bloquea la entrada de hoy ni se lo
        // lleva la salida (que le pondría veinte horas de trabajo).
        // 30 h y no 20: su `Fecha` nunca es hoy, y así no es la Parte 1 de la entrada que se ficha.
        let (db, _dir) = db_con_usuario().await;
        abierto_hace(&db, "olvidada", 30).await;

        {
            let w = db.write().await;
            exec_punch(&w, "u1", "entrada").await.unwrap();
            exec_punch(&w, "u1", "salida").await.unwrap();
        }

        assert_eq!(estado(&db, "olvidada").await, ("ABIERTO".into(), 0));
    }
}

#[cfg(test)]
mod tests_setup_inicial {
    //! REV-06: el setup inicial no pide PIN —en el primer arranque no hay ninguno que confirmar, y
    //! el del seed es público—, así que su ÚNICO cerrojo es `Requiere_Setup = 1`. Eso lo convierte
    //! en lo más delicado de este fichero: si ese flag deja de mirarse, cualquiera que alcance esta
    //! operación le cambia el PIN al administrador. Que la nube ya no ofrezca un camino hacia aquí
    //! es la otra mitad del arreglo; ésta es la que queda.

    use super::*;
    use crate::ejecutor::Connection;

    const ADMIN: &str = "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado, Requiere_Setup)
         VALUES ('admin', (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador'),
                 'admin@bar.test', 'hash-del-seed', 'Ana', 'Activo', 1);";

    async fn repo_temporal() -> (SqliteLoginRepository, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("login_setup");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            let conn: &Connection = w.raw();
            conn.execute(ADMIN, Vec::<Value>::new()).await.unwrap();
        }
        (SqliteLoginRepository::new(db.clone()), db, dir)
    }

    async fn campo(db: &Db, sql: &str) -> Value {
        let g = db.read().await;
        let mut rows = g.query(sql, Vec::<Value>::new()).await.unwrap();
        rows.next().await.unwrap().unwrap().get_value(0).unwrap()
    }

    #[tokio::test]
    async fn se_aplica_una_vez_y_cierra_la_puerta_detras() {
        let (repo, db, _dir) = repo_temporal().await;

        repo.complete_initial_setup("admin", "4321")
            .await
            .expect("el primer setup tiene que entrar");

        assert_eq!(
            campo(&db, "SELECT Requiere_Setup FROM Usuarios WHERE ID_Usuario='admin';").await,
            Value::Integer(0),
            "el flag se apaga al aplicarlo: eso es lo que cierra la puerta"
        );
        let hash = campo(&db, "SELECT Password_Hash FROM Usuarios WHERE ID_Usuario='admin';").await;
        assert_ne!(hash, Value::Text("hash-del-seed".into()), "el PIN tiene que haber cambiado");
        assert_eq!(
            campo(&db, "SELECT Email FROM Usuarios WHERE ID_Usuario='admin';").await,
            Value::Text("admin@bar.test".into()),
            "el correo se queda el del seed"
        );

        // Y una segunda vez ya no: no hay un segundo primer arranque.
        let otra = repo.complete_initial_setup("admin", "9999").await;
        assert!(otra.is_err(), "no puede volver a usarse");
        assert_eq!(
            campo(&db, "SELECT Password_Hash FROM Usuarios WHERE ID_Usuario='admin';").await,
            hash,
            "y el intento no puede haber tocado nada"
        );
    }

    #[tokio::test]
    async fn un_usuario_que_ya_hizo_su_setup_no_se_toca() {
        // El caso que la nube permitía: apuntar a un usuario cualquiera con el setup ya hecho.
        let (repo, db, _dir) = repo_temporal().await;
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "UPDATE Usuarios SET Requiere_Setup = 0 WHERE ID_Usuario = 'admin';",
                    Vec::<Value>::new(),
                )
                .await
                .unwrap();
        }

        let r = repo.complete_initial_setup("admin", "4321").await;

        assert!(r.is_err(), "sin Requiere_Setup no hay permiso");
        assert_eq!(
            campo(&db, "SELECT Password_Hash FROM Usuarios WHERE ID_Usuario='admin';").await,
            Value::Text("hash-del-seed".into())
        );
    }

    /// AUD-24: el PIN elegido llega a la nube por el outbox, y sólo por él: no hay un comando
    /// aparte que lo suba (`config_upload_initial_setup` subía cualquier PIN para cualquier
    /// usuario, sin sesión ni `Requiere_Setup`). Sube el hash calculado aquí, nunca el PIN.
    #[tokio::test]
    async fn el_pin_elegido_sube_a_la_nube_por_el_outbox() {
        let (repo, db, _dir) = repo_temporal().await;

        repo.complete_initial_setup("admin", "4321")
            .await
            .expect("el primer setup tiene que entrar");

        let Value::Text(hash) =
            campo(&db, "SELECT Password_Hash FROM Usuarios WHERE ID_Usuario='admin';").await
        else {
            panic!("el hash tiene que ser texto");
        };
        assert_eq!(
            campo(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await,
            Value::Integer(1),
            "una operación replicable: la del setup"
        );
        let Value::Text(sentencias) = campo(&db, "SELECT Statements_Json FROM _Sync_Outbox;").await
        else {
            panic!("las sentencias tienen que ser texto");
        };
        assert!(sentencias.contains("UPDATE Usuarios"), "{sentencias}");
        assert!(sentencias.contains("Requiere_Setup = 0"), "{sentencias}");
        assert!(sentencias.contains(&hash), "sube el hash de la Main: {sentencias}");
        assert!(!sentencias.contains("\"4321\""), "el PIN no sale del equipo: {sentencias}");
    }

    #[tokio::test]
    async fn nada_de_esto_sale_por_el_outbox_sin_haberse_aplicado() {
        // Un intento rechazado no puede dejar rastro replicable: subiría a la nube un UPDATE que
        // aquí no ha ocurrido.
        let (repo, db, _dir) = repo_temporal().await;
        let _ = repo.complete_initial_setup("nadie", "4321").await;

        assert_eq!(
            campo(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await,
            Value::Integer(0)
        );
    }
}

#[cfg(test)]
mod tests_restablecer_pin {
    //! LOGIN-07: fijar un PIN sin pedir el actual. Lo que no puede pasar es que sirva para otro rol
    //! o para un usuario dado de baja, que se quede sin subir a la nube, o que el administrador que
    //! lo recupera siga bloqueado por los intentos fallidos que le trajeron hasta aquí.

    use super::*;
    use crate::ejecutor::Connection;

    async fn db_temporal() -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("login_pin");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db, dir)
    }

    /// El estado de partida va por `raw()`: no es una escritura de negocio y no debe ir al outbox.
    async fn sembrar(db: &Arc<Db>, sentencias: &[&str]) {
        let w = db.write().await;
        let conn: &Connection = w.raw();
        for sql in sentencias {
            conn.execute(sql, Vec::<Value>::new())
                .await
                .unwrap_or_else(|e| panic!("sembrando: {sql}\n{e}"));
        }
    }

    async fn texto(db: &Db, sql: &str) -> String {
        let g = db.read().await;
        let mut rows = g.query(sql, Vec::<Value>::new()).await.unwrap();
        match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Text(s) => s,
            otro => panic!("se esperaba texto en {sql}: {otro:?}"),
        }
    }

    async fn contar(db: &Db, sql: &str) -> i64 {
        let g = db.read().await;
        let mut rows = g.query(sql, Vec::<Value>::new()).await.unwrap();
        v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap_or(0)
    }

    async fn hash_de(db: &Db, id: &str) -> String {
        texto(db, &format!("SELECT Password_Hash FROM Usuarios WHERE ID_Usuario = '{id}';")).await
    }

    #[tokio::test]
    async fn solo_cambia_el_pin_de_un_administrador_activo_lo_sube_y_lo_desbloquea() {
        let (db, _dir) = db_temporal().await;
        sembrar(
            &db,
            &[
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
                 VALUES ('admin', (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador'),
                         'admin@bar.test', 'viejo', 'Ana', 'Activo');",
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
                 VALUES ('baja', (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador'),
                         'baja@bar.test', 'viejo', 'Luis', 'Inactivo');",
                "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
                 VALUES ('camarero', (SELECT ID_Rol FROM Roles WHERE Nombre_Rol <> 'Administrador' LIMIT 1),
                         'camarero@bar.test', 'viejo', 'Eva', 'Activo');",
                "INSERT INTO Intentos_Login (ID_Usuario, Intentos_Fallidos, Bloqueado_Hasta_Ms)
                 VALUES ('admin', 7, 9999999999999);",
            ],
        )
        .await;
        let repo = SqliteLoginRepository::new(db.clone());

        for otro in ["camarero", "baja", "no-existe"] {
            assert!(
                matches!(repo.restablecer_pin_admin(otro, "4321").await, Err(AppError::NotFound(_))),
                "{otro} no debería poder recibir un PIN sin el actual"
            );
        }
        assert_eq!(hash_de(&db, "camarero").await, "viejo");
        assert_eq!(hash_de(&db, "baja").await, "viejo");
        assert_eq!(contar(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await, 0);

        repo.restablecer_pin_admin("admin", "4321").await.unwrap();

        assert!(verify_pin("4321", &hash_de(&db, "admin").await).is_ok());
        assert!(
            contar(&db, "SELECT COUNT(*) FROM _Sync_Outbox;").await > 0,
            "el PIN nuevo tiene que subir por el outbox, o la Handy seguiría con el viejo"
        );
        assert_eq!(
            contar(&db, "SELECT COUNT(*) FROM Intentos_Login WHERE ID_Usuario = 'admin';").await,
            0
        );
    }
}

#[cfg(test)]
mod tests_sin_pin {
    //! `Usuarios.Sin_PIN`: el login y el fichaje de ese usuario no comprueban el PIN, y a los demás
    //! se les sigue pidiendo igual.

    use super::*;
    use tpv_contracts::login::LoginUserArgs;

    async fn db_con_usuario(sin_pin: i64) -> (Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("sin_pin");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            w.raw()
                .execute(
                    "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado, Sin_PIN)
                     VALUES ('u1', (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Camarero'),
                             'u1@bar.test', ?1, 'Ana', 'Activo', ?2);",
                    vec![Value::Text(hash_pin("1234").unwrap()), Value::Integer(sin_pin)],
                )
                .await
                .unwrap();
        }
        (db, dir)
    }

    fn entrar(pin: &str) -> LoginUserArgs {
        LoginUserArgs { id_usuario: "u1".into(), pin: pin.into() }
    }

    #[tokio::test]
    async fn sin_pin_ficha_y_entra_sin_escribirlo() {
        let (db, _dir) = db_con_usuario(1).await;
        let repo = SqliteLoginRepository::new(db.clone());

        repo.punch("u1", "", "entrada").await.unwrap();
        let ok = tpv_application::use_cases::login::login_user(&repo, None, entrar("")).await.unwrap();
        assert_eq!(ok.id_usuario, "u1");

        let lista = repo.list_login_users().await.unwrap();
        assert!(lista.iter().any(|u| u.id_usuario == "u1" && u.sin_pin));
    }

    #[tokio::test]
    async fn con_pin_sigue_haciendo_falta() {
        let (db, _dir) = db_con_usuario(0).await;
        let repo = SqliteLoginRepository::new(db.clone());

        assert!(matches!(repo.punch("u1", "", "entrada").await, Err(AppError::Validation(_))));
        assert!(matches!(repo.login("u1", "").await, Err(AppError::Validation(_))));
        repo.punch("u1", "1234", "entrada").await.unwrap();
        tpv_application::use_cases::login::login_user(&repo, None, entrar("1234")).await.unwrap();

        let lista = repo.list_login_users().await.unwrap();
        assert!(lista.iter().any(|u| u.id_usuario == "u1" && !u.sin_pin));
    }

    #[tokio::test]
    async fn un_bloqueo_de_antes_no_deja_fuera_a_quien_pasa_a_entrar_sin_pin() {
        let (db, _dir) = db_con_usuario(0).await;
        let repo = SqliteLoginRepository::new(db.clone());
        for _ in 0..7 {
            let _ = repo.login("u1", "0000").await;
        }
        assert!(repo.punch("u1", "1234", "entrada").await.is_err(), "el freno de LOGIN-01 está puesto");

        {
            let w = db.write().await;
            w.raw()
                .execute("UPDATE Usuarios SET Sin_PIN = 1 WHERE ID_Usuario = 'u1';", Vec::<Value>::new())
                .await
                .unwrap();
        }
        repo.punch("u1", "", "entrada").await.unwrap();
    }
}

// RI-37: el trabajo PBKDF2 acotado tampoco ocupa los hilos del runtime de I/O.
async fn verificar_pin_sin_bloquear(pin: &str, hash: &str) -> AppResult<Result<(), String>> {
    let pin = pin.to_owned();
    let hash = hash.to_owned();
    tokio::task::spawn_blocking(move || verify_pin(&pin, &hash)).await
        .map_err(|e| AppError::validation(format!("No se ha podido comprobar el PIN: {e}")))
}

