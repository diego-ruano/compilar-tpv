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
use tpv_contracts::login::{LoginOk, PunchParte, PunchStatus, UserListItem};
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

async fn exec_punch<C: Writer>(
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

    async fn complete_initial_setup(
        &self,
        id_usuario: &str,
        pin_actual: &str,
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

        verify_pin(pin_actual, &info.password_hash).map_err(AppError::validation)?;

        if query_email_in_use(&db, email_nuevo, id_usuario).await? {
            return Err(AppError::conflict("Ese email ya está en uso"));
        }

        let new_hash = hash_pin(pin_nuevo).map_err(AppError::validation)?;

        exec_apply_initial_setup(&db, id_usuario, email_nuevo.to_string(), new_hash).await
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
