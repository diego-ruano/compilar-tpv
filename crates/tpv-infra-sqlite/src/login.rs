//! Adaptador SQLite del repositorio de **login / auth / fichaje**. Local-First:
//! sin Applied_Operations, sin Outbox, sin idempotencia por op_id. La verificación del PIN
//! (cripto) se hace en el caso de uso con el dominio; aquí solo va el SQL.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Local;
use libsql::{Connection, Value};

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::login::LoginRepository;
use tpv_contracts::login::{PunchParte, PunchStatus, UserListItem};
use tpv_domain::login::{LoginUserRecord, SetupInfo};

use crate::mapping::v_i64;

pub struct SqliteLoginRepository {
    conn: Arc<Connection>,
}

impl SqliteLoginRepository {
    pub fn new(conn: Arc<Connection>) -> Self {
        Self { conn }
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

async fn get_turno_partido_for(
    conn: &Connection,
    id_usuario: i64,
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
            vec![Value::Integer(id_usuario), Value::Text(fecha.to_string())],
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

async fn build_punch_status(
    conn: &Connection,
    id_usuario: i64,
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
            vec![Value::Integer(id_usuario), Value::Text(fecha.to_string())],
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

#[async_trait]
impl LoginRepository for SqliteLoginRepository {
    async fn list_login_users(&self) -> AppResult<Vec<UserListItem>> {
        let db = &self.conn;

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
                Value::Integer(n) => n,
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

    async fn get_login_record(&self, id_usuario: i64) -> AppResult<Option<LoginUserRecord>> {
        let db = &self.conn;

        let mut rows = db
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
                vec![Value::Integer(id_usuario)],
            )
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };

        let id = match row.get_value(0).map_err(db_err)? {
            Value::Integer(n) => n,
            _ => return Err(AppError::repository("ID_Usuario inválido")),
        };
        let id_trabajador = match row.get_value(1).map_err(db_err)? {
            Value::Integer(n) => Some(n),
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
        let email = match row.get_value(4).map_err(db_err)? {
            Value::Text(s) => s,
            _ => "admin@local".into(),
        };
        let password_hash = match row.get_value(5).map_err(db_err)? {
            Value::Text(s) => s,
            _ => return Err(AppError::repository("Password_Hash inválido")),
        };
        let requiere_setup = match row.get_value(6).map_err(db_err)? {
            Value::Integer(n) => n,
            _ => 0,
        };
        let rol = match row.get_value(7).map_err(db_err)? {
            Value::Text(s) => s,
            _ => "Sin rol".into(),
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

    async fn get_today_punch_status(&self, id_usuario: i64) -> AppResult<PunchStatus> {
        build_punch_status(&self.conn, id_usuario, &today_ymd()).await
    }

    async fn get_password_hash(&self, id_usuario: i64) -> AppResult<Option<String>> {
        let db = &self.conn;
        let mut rows = db
            .query(
                r#"
                SELECT Password_Hash
                FROM Usuarios
                WHERE ID_Usuario = ?1 AND Estado = 'Activo'
                LIMIT 1;
                "#,
                vec![Value::Integer(id_usuario)],
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

    async fn get_setup_info(&self, id_usuario: i64) -> AppResult<Option<SetupInfo>> {
        let db = &self.conn;
        let mut rows = db
            .query(
                r#"
                SELECT Password_Hash, Requiere_Setup
                FROM Usuarios
                WHERE ID_Usuario = ?1 AND Estado='Activo'
                LIMIT 1;
                "#,
                vec![Value::Integer(id_usuario)],
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

    async fn email_in_use(&self, email: &str, exclude_id: i64) -> AppResult<bool> {
        let db = &self.conn;
        let mut rows = db
            .query(
                r#"
                SELECT COUNT(*)
                FROM Usuarios
                WHERE Email = ?1 AND ID_Usuario <> ?2;
                "#,
                vec![Value::Text(email.to_string()), Value::Integer(exclude_id)],
            )
            .await
            .map_err(db_err)?;

        let count = match rows.next().await.map_err(db_err)? {
            Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
            None => 0,
        };
        Ok(count > 0)
    }

    async fn set_turno_partido(
        &self,
        id_usuario: i64,
        fecha: Option<String>,
        turno_partido: bool,
    ) -> AppResult<()> {
        let db = &self.conn;
        let fecha = fecha.unwrap_or_else(today_ymd);

        db.execute(
            r#"
            INSERT INTO Fichaje_Dia (ID_Usuario, Fecha, Turno_Partido)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(ID_Usuario, Fecha) DO UPDATE SET
              Turno_Partido = excluded.Turno_Partido;
            "#,
            vec![
                Value::Integer(id_usuario),
                Value::Text(fecha),
                Value::Integer(if turno_partido { 1 } else { 0 }),
            ],
        )
        .await
        .map_err(db_err)?;

        Ok(())
    }

    async fn apply_initial_setup(
        &self,
        id_usuario: i64,
        email: String,
        new_hash: String,
    ) -> AppResult<()> {
        let db = &self.conn;
        db.execute(
            r#"
            UPDATE Usuarios
            SET Email = ?2, Password_Hash = ?3, Requiere_Setup = 0
            WHERE ID_Usuario = ?1;
            "#,
            vec![
                Value::Integer(id_usuario),
                Value::Text(email),
                Value::Text(new_hash),
            ],
        )
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn punch(
        &self,
        id_usuario: i64,
        tipo: String,
        fecha: Option<String>,
        hora_evento: Option<String>,
    ) -> AppResult<PunchStatus> {
        let db = &self.conn;
        let fecha = fecha.unwrap_or_else(today_ymd);
        let hora_evento = hora_evento.unwrap_or_else(now_iso);

        db.execute_batch("BEGIN;").await.map_err(db_err)?;

        let res: AppResult<PunchStatus> = async {
            if tipo == "entrada" {
                let mut o = db
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
                        vec![Value::Integer(id_usuario), Value::Text(fecha.clone())],
                    )
                    .await
                    .map_err(db_err)?;

                if o.next().await.map_err(db_err)?.is_some() {
                    return Err(AppError::conflict(
                        "Tienes un fichaje abierto. Ficha salida antes de fichar entrada.",
                    ));
                }

                let turno_partido = get_turno_partido_for(db, id_usuario, &fecha).await?;

                let mut p1 = db
                    .query(
                        r#"
                        SELECT Hora_Entrada, Hora_Salida
                        FROM Fichajes
                        WHERE ID_Usuario=?1 AND Fecha=?2 AND Parte=1
                        LIMIT 1;
                        "#,
                        vec![Value::Integer(id_usuario), Value::Text(fecha.clone())],
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
                        let mut p2 = db
                            .query(
                                r#"
                                SELECT COUNT(*)
                                FROM Fichajes
                                WHERE ID_Usuario=?1 AND Fecha=?2 AND Parte=2;
                                "#,
                                vec![Value::Integer(id_usuario), Value::Text(fecha.clone())],
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

                db.execute(
                    r#"
                    INSERT INTO Fichajes (
                      ID_Usuario, Fecha, Parte, Hora_Entrada, Hora_Salida, Estado, Cerrado_Automatico
                    )
                    VALUES (?1, ?2, ?3, ?4, NULL, 'ABIERTO', 0);
                    "#,
                    vec![
                        Value::Integer(id_usuario),
                        Value::Text(fecha.clone()),
                        Value::Integer(parte_a_abrir),
                        Value::Text(hora_evento.clone()),
                    ],
                )
                .await
                .map_err(db_err)?;
            } else {
                let mut o = db
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
                        vec![Value::Integer(id_usuario), Value::Text(fecha.clone())],
                    )
                    .await
                    .map_err(db_err)?;

                let Some(row) = o.next().await.map_err(db_err)? else {
                    return Err(AppError::conflict(
                        "No hay fichaje abierto para cerrar (primero ficha entrada).",
                    ));
                };

                let id_f = match row.get_value(0).map_err(db_err)? {
                    Value::Integer(n) => n,
                    _ => return Err(AppError::repository("ID_Fichaje inválido")),
                };

                db.execute(
                    r#"
                    UPDATE Fichajes
                    SET Hora_Salida = ?2,
                        Estado = 'CERRADO',
                        Cerrado_Automatico = 0,
                        Cierre_Motivo = NULL,
                        Incidencia = NULL
                    WHERE ID_Fichaje = ?1;
                    "#,
                    vec![Value::Integer(id_f), Value::Text(hora_evento.clone())],
                )
                .await
                .map_err(db_err)?;
            }

            build_punch_status(db, id_usuario, &fecha).await
        }
        .await;

        match res {
            Ok(status) => {
                db.execute_batch("COMMIT;").await.map_err(db_err)?;
                Ok(status)
            }
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;").await;
                Err(e)
            }
        }
    }
}
