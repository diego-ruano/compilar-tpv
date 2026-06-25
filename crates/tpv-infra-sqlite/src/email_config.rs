//! Adaptador SQLite para configuración de correo. Local-First (singleton ID=1).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::email_config::EmailConfigRepository;
use tpv_domain::email_config::EmailConfig;

use crate::db::{Db, Reader, Writer};
use crate::mapping::{v_i64, v_string};

pub struct SqliteEmailConfigRepository {
    db: Arc<Db>,
}

impl SqliteEmailConfigRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

#[async_trait]
impl EmailConfigRepository for SqliteEmailConfigRepository {
    async fn get(&self) -> AppResult<EmailConfig> {
        let g = self.db.write().await;
        let conn = &g;

        conn.execute("INSERT OR IGNORE INTO Email_Settings (ID) VALUES (1);", ())
            .await
            .map_err(db_err)?;

        let mut rows = conn
            .query(
                "SELECT Modo, Smtp_Host, Smtp_Port, Smtp_User, Smtp_Password, \
                        Smtp_From_Email, Smtp_From_Name, Smtp_Use_Tls \
                 FROM Email_Settings WHERE ID=1 LIMIT 1;",
                (),
            )
            .await
            .map_err(db_err)?;

        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Email_Settings (ID=1)"))?;

        let g = |idx: i32| row.get_value(idx).map_err(db_err);

        let smtp_use_tls = match g(7)? {
            Value::Integer(n) => n != 0,
            _ => true,
        };

        Ok(EmailConfig {
            modo: v_string(g(0)?).unwrap_or_else(|| "managed".into()),
            smtp_host: v_string(g(1)?).unwrap_or_default(),
            smtp_port: v_i64(g(2)?).unwrap_or(587) as i32,
            smtp_user: v_string(g(3)?).unwrap_or_default(),
            smtp_password: v_string(g(4)?).unwrap_or_default(),
            smtp_from_email: v_string(g(5)?).unwrap_or_default(),
            smtp_from_name: v_string(g(6)?).unwrap_or_default(),
            smtp_use_tls,
        })
    }

    async fn patch(&self, config: &EmailConfig) -> AppResult<()> {
        let g = self.db.write().await;
        let conn = &g;

        conn.execute("INSERT OR IGNORE INTO Email_Settings (ID) VALUES (1);", ())
            .await
            .map_err(db_err)?;

        let affected = conn
            .execute(
                "UPDATE Email_Settings SET \
                    Modo = ?1, Smtp_Host = ?2, Smtp_Port = ?3, Smtp_User = ?4, \
                    Smtp_Password = ?5, Smtp_From_Email = ?6, Smtp_From_Name = ?7, \
                    Smtp_Use_Tls = ?8, Updated_At = datetime('now','localtime') \
                 WHERE ID = 1;",
                vec![
                    Value::Text(config.modo.clone()),
                    Value::Text(config.smtp_host.clone()),
                    Value::Integer(config.smtp_port as i64),
                    Value::Text(config.smtp_user.clone()),
                    Value::Text(config.smtp_password.clone()),
                    Value::Text(config.smtp_from_email.clone()),
                    Value::Text(config.smtp_from_name.clone()),
                    Value::Integer(if config.smtp_use_tls { 1 } else { 0 }),
                ],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("No existe Email_Settings (ID=1)"));
        }
        Ok(())
    }
}
