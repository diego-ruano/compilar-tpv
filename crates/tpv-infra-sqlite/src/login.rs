//! Adaptador SQLite del repositorio de **login / auth / fichaje**. Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id.
//!
//! El puerto es de grano grueso: la verificación del PIN forma parte de cada operación.
//! Aquí se hace en local con la cripto del dominio (`verify_pin`/`hash_pin`); las consultas
//! finas (registro, hash, setup, email) son funciones privadas que componen esas operaciones.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Local;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::login::LoginRepository;
use tpv_contracts::login::{LoginOk, PunchParte, PunchStatus, SetupPendiente, UserListItem};
use tpv_domain::login::{
    hash_needs_upgrade, hash_pin, verify_pin, LoginUserRecord, SetupInfo,
};

use crate::db::{Db, Reader, Writer};
use crate::mapping::v_i64;
use crate::util::new_id;

pub struct SqliteLoginRepository {
    db: Arc<Db>,
}

impl SqliteLoginRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
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

/// TRAB-01: cierre automático de jornadas colgadas. Si un trabajador ficha entrada y olvida la
/// salida, su fichaje queda `ABIERTO` indefinidamente y corrompe las horas trabajadas que lee
/// `stats`. Esta función cierra los fichajes ABIERTOS **de días anteriores** marcándolos
/// `Cerrado_Automatico=1` + `Cierre_Motivo` + `Incidencia` (para revisión manual) y **sin inventar
/// hora de salida** (`Hora_Salida` queda NULL). Solo afecta a `Fecha < hoy`, así que la jornada en
/// curso del día no se toca. Es idempotente (los ya cerrados no vuelven a entrar) y va por el
/// `Writer`, de modo que el cambio se captura en el outbox y se replica a la nube. Se ejecuta al
/// arrancar el modo Main (ver `init_main`).
pub async fn auto_close_stale_punches(db: &Db) -> AppResult<u64> {
    let conn = db.write().await;
    let affected = conn
        .execute(
            r#"
            UPDATE Fichajes
            SET Estado = 'CERRADO',
                Cerrado_Automatico = 1,
                Cierre_Motivo = 'Cierre automático: jornada sin fichar salida',
                Incidencia = 'Falta fichar la salida'
            WHERE Estado = 'ABIERTO'
              AND Hora_Salida IS NULL
              AND Fecha < date('now','localtime');
            "#,
            vec![],
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
            Value::Text(s) => s,
            _ => "ABIERTO".into(),
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
                   u.Password_Hash, u.Requiere_Setup, r.Nombre_Rol
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

    Ok(Some(LoginUserRecord {
        id_usuario: id,
        id_trabajador,
        nombre,
        apellido,
        email,
        password_hash,
        requiere_setup,
        rol,
    }))
}

async fn query_password_hash<C: Reader>(conn: &C, id_usuario: &str) -> AppResult<Option<String>> {
    let mut rows = conn
        .query(
            r#"
            SELECT Password_Hash
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
    match row.get_value(0).map_err(db_err)? {
        Value::Text(s) => Ok(Some(s)),
        _ => Err(AppError::repository("Password_Hash inválido")),
    }
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

async fn query_email_in_use<C: Reader>(
    conn: &C,
    email: &str,
    exclude_id: &str,
) -> AppResult<bool> {
    let mut rows = conn
        .query(
            r#"
            SELECT COUNT(*)
            FROM Usuarios
            WHERE Email = ?1 AND ID_Usuario <> ?2;
            "#,
            vec![Value::Text(email.to_string()), Value::Text(exclude_id.to_string())],
        )
        .await
        .map_err(db_err)?;

    let count = match rows.next().await.map_err(db_err)? {
        Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
        None => 0,
    };
    Ok(count > 0)
}

async fn exec_apply_initial_setup<C: Writer>(
    conn: &C,
    id_usuario: &str,
    email: String,
    new_hash: String,
) -> AppResult<()> {
    conn.execute(
        r#"
        UPDATE Usuarios
        SET Email = ?2, Password_Hash = ?3, Requiere_Setup = 0
        WHERE ID_Usuario = ?1;
        "#,
        vec![
            Value::Text(id_usuario.to_string()),
            Value::Text(email),
            Value::Text(new_hash),
        ],
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
    _fecha: Option<String>,
    _hora_evento: Option<String>,
) -> AppResult<PunchStatus> {
    // TRAB-02: el control horario debe ser VERAZ. Se ignora deliberadamente la fecha/hora que
    // envía el cliente (la Main —o un dispositivo— podría falsearla para backdating/forward-dating)
    // y se usa SIEMPRE el reloj de confianza del backend. No hay flujo de corrección manual que
    // preservar; si en el futuro se añade, debe ser una operación admin separada y auditada.
    let fecha = today_ymd();
    let hora_evento = now_iso();

    conn.execute_batch("BEGIN;").await.map_err(db_err)?;

    let res: AppResult<PunchStatus> = async {
        if tipo == "entrada" {
            let mut o = conn
                .query(
                    r#"
                    SELECT ID_Fichaje
                    FROM Fichajes
                    WHERE ID_Usuario=?1 AND Fecha=?2
                      AND Estado='ABIERTO'
                      AND Hora_Entrada IS NOT NULL
                      AND Hora_Salida IS NULL
                    LIMIT 1;
                    "#,
                    vec![Value::Text(id_usuario.to_string()), Value::Text(fecha.clone())],
                )
                .await
                .map_err(db_err)?;

            if o.next().await.map_err(db_err)?.is_some() {
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
        } else {
            let mut o = conn
                .query(
                    r#"
                    SELECT ID_Fichaje, Parte
                    FROM Fichajes
                    WHERE ID_Usuario=?1 AND Fecha=?2
                      AND Estado='ABIERTO'
                      AND Hora_Entrada IS NOT NULL
                      AND Hora_Salida IS NULL
                    ORDER BY Parte DESC
                    LIMIT 1;
                    "#,
                    vec![Value::Text(id_usuario.to_string()), Value::Text(fecha.clone())],
                )
                .await
                .map_err(db_err)?;

            let Some(row) = o.next().await.map_err(db_err)? else {
                return Err(AppError::conflict(
                    "No hay fichaje abierto para cerrar (primero ficha entrada).",
                ));
            };

            let id_f = match row.get_value(0).map_err(db_err)? {
                Value::Text(s) => s,
                _ => return Err(AppError::repository("ID_Fichaje inválido")),
            };

            conn.execute(
                r#"
                UPDATE Fichajes
                SET Hora_Salida = ?2,
                    Estado = 'CERRADO',
                    Cerrado_Automatico = 0,
                    Cierre_Motivo = NULL,
                    Incidencia = NULL
                WHERE ID_Fichaje = ?1;
                "#,
                vec![Value::Text(id_f), Value::Text(hora_evento.clone())],
            )
            .await
            .map_err(db_err)?;
        }

        build_punch_status(conn, id_usuario, &fecha).await
    }
    .await;

    match res {
        Ok(status) => {
            conn.execute_batch("COMMIT;").await.map_err(db_err)?;
            Ok(status)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;").await;
            Err(e)
        }
    }
}

#[async_trait]
impl LoginRepository for SqliteLoginRepository {
    async fn list_login_users(&self) -> AppResult<Vec<UserListItem>> {
        let g = self.db.read().await;
        let db = &g;

        let mut rows = db
            .query(
                r#"
                SELECT u.ID_Usuario, u.Nombre, u.Apellido, r.Nombre_Rol
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

            out.push(UserListItem {
                id_usuario,
                nombre,
                apellido,
                nombre_rol,
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
                SELECT ID_Usuario, Nombre, Email
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
                email: None,
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
            email: texto(2),
        })
    }

    async fn get_today_punch_status(&self, id_usuario: &str) -> AppResult<PunchStatus> {
        let db = self.db.read().await;
        build_punch_status(&db, id_usuario, &today_ymd()).await
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
        crate::auth::throttle_check(&self.db, id_usuario).await?;

        let rec = {
            let db = self.db.read().await;
            query_login_record(&db, id_usuario)
                .await?
                .ok_or_else(|| AppError::not_found("Usuario no encontrado o inactivo"))?
        };

        if let Err(e) = verify_pin(pin, &rec.password_hash) {
            let _ = crate::auth::throttle_registrar(&self.db, id_usuario, false).await;
            return Err(AppError::validation(e));
        }
        let _ = crate::auth::throttle_registrar(&self.db, id_usuario, true).await;

        // Rehash-en-login (LOGIN-04): si el hash usa menos iteraciones que el objetivo actual, se
        // recomputa con el PIN ya verificado y se actualiza. Best-effort: un fallo aquí NO rompe el
        // login. Hoy el objetivo es 100k → no-op; al subirlo (plan de pago) migra en el primer login.
        if hash_needs_upgrade(&rec.password_hash) {
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

    /// `_pin_actual` no se usa aquí: el setup del primer arranque ocurre ANTES del login (no hay
    /// PIN que confirmar, y el que hay es el del seed, que no es secreto). Quien autoriza es
    /// `Requiere_Setup = 1`, que además se apaga al aplicarlo: la puerta se cierra tras el primer
    /// uso. El adaptador HTTP sí lo manda, porque el worker lo exige por su cuenta.
    async fn complete_initial_setup(
        &self,
        id_usuario: &str,
        _pin_actual: &str,
        pin_nuevo: &str,
        email_nuevo: &str,
    ) -> AppResult<()> {
        let db = self.db.write().await;
        let info = query_setup_info(&db, id_usuario)
            .await?
            .ok_or_else(|| AppError::not_found("Usuario no encontrado"))?;

        if info.requiere_setup == 0 {
            return Err(AppError::conflict("Este usuario ya completó el setup inicial"));
        }

        if query_email_in_use(&db, email_nuevo, id_usuario).await? {
            return Err(AppError::conflict("Ese email ya está en uso"));
        }

        let new_hash = hash_pin(pin_nuevo).map_err(AppError::validation)?;

        exec_apply_initial_setup(&db, id_usuario, email_nuevo.to_string(), new_hash).await
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

    async fn punch(
        &self,
        id_usuario: &str,
        pin: &str,
        tipo: &str,
        fecha: Option<String>,
        hora_evento: Option<String>,
    ) -> AppResult<PunchStatus> {
        crate::auth::throttle_check(&self.db, id_usuario).await?;

        let hash = {
            let db = self.db.read().await;
            query_password_hash(&db, id_usuario)
                .await?
                .ok_or_else(|| AppError::not_found("Usuario no encontrado o inactivo"))?
        };

        if let Err(e) = verify_pin(pin, &hash) {
            let _ = crate::auth::throttle_registrar(&self.db, id_usuario, false).await;
            return Err(AppError::validation(e));
        }
        let _ = crate::auth::throttle_registrar(&self.db, id_usuario, true).await;

        let db = self.db.write().await;
        exec_punch(&db, id_usuario, tipo, fecha, hora_evento).await
    }

    async fn set_turno_partido(
        &self,
        id_usuario: &str,
        fecha: Option<String>,
        turno_partido: bool,
    ) -> AppResult<()> {
        let db = self.db.write().await;
        let fecha = fecha.unwrap_or_else(today_ymd);

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
mod tests_restablecer_pin {
    //! LOGIN-07: fijar un PIN sin pedir el actual. Lo que no puede pasar es que sirva para otro rol
    //! o para un usuario dado de baja, que se quede sin subir a la nube, o que el administrador que
    //! lo recupera siga bloqueado por los intentos fallidos que le trajeron hasta aquí.

    use super::*;
    use libsql::Connection;

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
