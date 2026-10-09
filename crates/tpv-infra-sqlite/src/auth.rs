//! Anti brute-force compartido (LOGIN-01).
//!
//! `throttle_check` / `throttle_registrar`: bloqueo escalado por intentos fallidos de PIN. El
//! estado vive en `Intentos_Login` (esquema compartido) pero es DEVICE-LOCAL: se escribe con la
//! conexión `raw` (sin outbox), así que no se replica a la nube.

use crate::consultas::{db_err};
use crate::util::now_ms;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_domain::login::login_bloqueo_ms;

use crate::db::{Db, Reader};
use crate::mapping::v_i64;

/// Rechaza si el usuario está bloqueado por intentos fallidos (LOGIN-01).
pub async fn throttle_check(db: &Db, id_usuario: &str) -> AppResult<()> {
    let g = db.read().await;
    let mut rows = g
        .query(
            "SELECT Bloqueado_Hasta_Ms FROM Intentos_Login WHERE ID_Usuario=?1 LIMIT 1;",
            vec![Value::Text(id_usuario.to_string())],
        )
        .await
        .map_err(db_err)?;
    let hasta = match rows.next().await.map_err(db_err)? {
        Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
        None => 0,
    };
    let now = now_ms();
    if hasta > now {
        let secs = ((hasta - now) as f64 / 1000.0).ceil() as i64;
        return Err(AppError::conflict(format!(
            "Demasiados intentos fallidos. Prueba de nuevo en {secs} s."
        )));
    }
    Ok(())
}

/// Registra el resultado de un intento de PIN. Éxito → resetea; fallo → incrementa y bloquea de
/// forma escalada. Escribe con la conexión `raw` (device-local, SIN outbox).
pub async fn throttle_registrar(db: &Db, id_usuario: &str, exito: bool) -> AppResult<()> {
    let g = db.write().await;
    let conn = g.raw();
    if exito {
        conn.execute(
            "DELETE FROM Intentos_Login WHERE ID_Usuario=?1;",
            vec![Value::Text(id_usuario.to_string())],
        )
        .await
        .map_err(db_err)?;
        return Ok(());
    }
    let prev = {
        let mut rows = conn
            .query(
                "SELECT Intentos_Fallidos FROM Intentos_Login WHERE ID_Usuario=?1 LIMIT 1;",
                vec![Value::Text(id_usuario.to_string())],
            )
            .await
            .map_err(db_err)?;
        match rows.next().await.map_err(db_err)? {
            Some(r) => v_i64(r.get_value(0).map_err(db_err)?).unwrap_or(0),
            None => 0,
        }
    };
    let fallidos = prev + 1;
    let now = now_ms();
    let hasta = now + login_bloqueo_ms(fallidos as u32);
    conn.execute(
        r#"
        INSERT INTO Intentos_Login (ID_Usuario, Intentos_Fallidos, Bloqueado_Hasta_Ms, Ultimo_Intento_Ms)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(ID_Usuario) DO UPDATE SET
          Intentos_Fallidos = excluded.Intentos_Fallidos,
          Bloqueado_Hasta_Ms = excluded.Bloqueado_Hasta_Ms,
          Ultimo_Intento_Ms = excluded.Ultimo_Intento_Ms;
        "#,
        vec![
            Value::Text(id_usuario.to_string()),
            Value::Integer(fallidos),
            Value::Integer(hasta),
            Value::Integer(now),
        ],
    )
    .await
    .map_err(db_err)?;
    Ok(())
}


