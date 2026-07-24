//! Adaptador SQLite de **notificaciones**: implementa `NotificacionesRepository` (lectura/gestión)
//! y `Notifier` (emisión). Local-First: las escrituras son INSERT/UPDATE directos; el reparto a la
//! nube/Handy lo hace la captura del outbox de `db.rs` (no hay outbox manual aquí).
//!
//! Visibilidad: una notificación es visible para un usuario si su destino es `todos`, o `usuario`
//! con su `ID_Usuario`, o `rol` con el `ID_Rol` de ese usuario (resuelto contra `Usuarios`). El
//! estado "leída" es por usuario (tabla `Notificacion_Lecturas`).

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::notificaciones::{NotificacionesRepository, Notifier};
use tpv_contracts::notificaciones::NotificacionRow;
use tpv_domain::notificaciones::NuevaNotificacion;

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_text, v_i64, v_string};
use crate::util::new_id;

/// Predicado de visibilidad de una notificación **activa y no caducada** para el usuario `?1`.
/// Se interpola en las consultas de lectura (nunca en escrituras replicables). `?1` = `ID_Usuario`.
const VISIBLE: &str = r#"
    n.Estado = 'activa'
    AND (n.Expira_En IS NULL OR n.Expira_En >= datetime('now','localtime'))
    AND (
          n.Destino_Tipo = 'todos'
       OR (n.Destino_Tipo = 'usuario' AND n.Destino_Valor = ?1)
       OR (n.Destino_Tipo = 'rol'
           AND n.Destino_Valor = (SELECT u.ID_Rol FROM Usuarios u WHERE u.ID_Usuario = ?1))
    )
"#;

/// Tope de filas del centro de notificaciones (defensivo; en la práctica hay pocas activas).
const LIST_LIMIT: i64 = 200;

pub struct SqliteNotificacionesRepository {
    db: Arc<Db>,
}

impl SqliteNotificacionesRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    /// IDs de las notificaciones visibles y **no leídas** por `id_usuario` (orden estable).
    async fn ids_no_leidas(&self, id_usuario: &str) -> AppResult<Vec<String>> {
        let sql = format!(
            r#"
            SELECT n.ID_Notificacion
            FROM Notificaciones n
            WHERE {visible}
              AND NOT EXISTS (
                SELECT 1 FROM Notificacion_Lecturas l
                WHERE l.ID_Notificacion = n.ID_Notificacion AND l.ID_Usuario = ?1
              )
            ORDER BY n.Creada_En DESC, n.ID_Notificacion DESC;
            "#,
            visible = VISIBLE
        );

        let db = self.db.read().await;
        let mut rows = db
            .query(&sql, vec![Value::Text(id_usuario.to_string())])
            .await
            .map_err(db_err)?;

        let mut ids = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            if let Some(id) = v_string(row.get_value(0).map_err(db_err)?) {
                ids.push(id);
            }
        }
        Ok(ids)
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

#[async_trait]
impl NotificacionesRepository for SqliteNotificacionesRepository {
    async fn listar(
        &self,
        id_usuario: &str,
        solo_no_leidas: bool,
    ) -> AppResult<Vec<NotificacionRow>> {
        let filtro_no_leidas = if solo_no_leidas {
            "AND l.ID_Usuario IS NULL"
        } else {
            ""
        };

        let sql = format!(
            r#"
            SELECT
              n.ID_Notificacion, n.Tipo, n.Severidad, n.Titulo, n.Cuerpo,
              n.Destino_Tipo, n.Destino_Valor, n.Accion, n.Payload, n.Estado,
              n.Creada_En, n.Expira_En,
              CASE WHEN l.ID_Usuario IS NOT NULL THEN 1 ELSE 0 END AS Leida
            FROM Notificaciones n
            LEFT JOIN Notificacion_Lecturas l
              ON l.ID_Notificacion = n.ID_Notificacion AND l.ID_Usuario = ?1
            WHERE {visible}
              {filtro_no_leidas}
            ORDER BY n.Creada_En DESC, n.ID_Notificacion DESC
            LIMIT {limit};
            "#,
            visible = VISIBLE,
            filtro_no_leidas = filtro_no_leidas,
            limit = LIST_LIMIT
        );

        let db = self.db.read().await;
        let mut rows = db
            .query(&sql, vec![Value::Text(id_usuario.to_string())])
            .await
            .map_err(db_err)?;

        let mut out: Vec<NotificacionRow> = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(NotificacionRow {
                id_notificacion: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                tipo: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                severidad: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
                titulo: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
                cuerpo: norm_opt_string(row.get_value(4).map_err(db_err)?),
                destino_tipo: v_string(row.get_value(5).map_err(db_err)?).unwrap_or_default(),
                destino_valor: norm_opt_string(row.get_value(6).map_err(db_err)?),
                accion: norm_opt_string(row.get_value(7).map_err(db_err)?),
                payload: norm_opt_string(row.get_value(8).map_err(db_err)?),
                estado: v_string(row.get_value(9).map_err(db_err)?).unwrap_or_default(),
                creada_en: v_string(row.get_value(10).map_err(db_err)?).unwrap_or_default(),
                expira_en: norm_opt_string(row.get_value(11).map_err(db_err)?),
                leida: v_i64(row.get_value(12).map_err(db_err)?).unwrap_or(0) > 0,
            });
        }
        Ok(out)
    }

    async fn contar_no_leidas(&self, id_usuario: &str) -> AppResult<i64> {
        let sql = format!(
            r#"
            SELECT COUNT(*)
            FROM Notificaciones n
            WHERE {visible}
              AND NOT EXISTS (
                SELECT 1 FROM Notificacion_Lecturas l
                WHERE l.ID_Notificacion = n.ID_Notificacion AND l.ID_Usuario = ?1
              );
            "#,
            visible = VISIBLE
        );

        let db = self.db.read().await;
        let mut rows = db
            .query(&sql, vec![Value::Text(id_usuario.to_string())])
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(0);
        };
        Ok(v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0))
    }

    async fn marcar_leida(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
        // INSERT OR IGNORE: idempotente (relee/marcar dos veces no duplica ni falla). Se captura en
        // el outbox y replica; `datetime('now','localtime')` se congela a literal al capturarse.
        let db = self.db.write().await;
        let affected = db
            .execute(
                r#"
                INSERT OR IGNORE INTO Notificacion_Lecturas (ID_Notificacion, ID_Usuario, Leida_En)
                VALUES (?1, ?2, datetime('now','localtime'));
                "#,
                vec![
                    Value::Text(id_notificacion.to_string()),
                    Value::Text(id_usuario.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }

    async fn marcar_todas_leidas(&self, id_usuario: &str) -> AppResult<i64> {
        // Determinismo de replicación: en vez de un `INSERT ... SELECT` (cuyo SELECT reevaluaría la
        // nube en otro estado), resolvemos los IDs aquí y emitimos INSERTs EXPLÍCITOS. Van juntos en
        // una transacción (una sola operación en el outbox).
        let ids = self.ids_no_leidas(id_usuario).await?;
        if ids.is_empty() {
            return Ok(0);
        }

        let db = self.db.write().await;
        db.execute_batch("BEGIN;").await.map_err(db_err)?;
        for id in &ids {
            if let Err(e) = db
                .execute(
                    r#"
                    INSERT OR IGNORE INTO Notificacion_Lecturas (ID_Notificacion, ID_Usuario, Leida_En)
                    VALUES (?1, ?2, datetime('now','localtime'));
                    "#,
                    vec![
                        Value::Text(id.clone()),
                        Value::Text(id_usuario.to_string()),
                    ],
                )
                .await
            {
                let _ = db.execute_batch("ROLLBACK;").await;
                return Err(db_err(e));
            }
        }
        db.execute_batch("COMMIT;").await.map_err(db_err)?;
        Ok(ids.len() as i64)
    }
}

#[async_trait]
impl Notifier for SqliteNotificacionesRepository {
    async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
        let (destino_tipo, destino_valor) = nueva.destino.to_columns();

        // Escritor único: mantener el guard sobre el dedupe-check + INSERT hace la operación
        // race-free en la Main (no puede colarse otra emisión con la misma clave entre medias).
        let db = self.db.write().await;

        // Dedupe: si hay clave y ya existe una activa con ella, devolvemos su id (no insertamos).
        if let Some(clave) = nueva.clave_dedupe.as_deref() {
            let mut rows = db
                .query(
                    "SELECT ID_Notificacion FROM Notificaciones \
                     WHERE Clave_Dedupe = ?1 AND Estado = 'activa' LIMIT 1;",
                    vec![Value::Text(clave.to_string())],
                )
                .await
                .map_err(db_err)?;
            if let Some(row) = rows.next().await.map_err(db_err)? {
                if let Some(id) = v_string(row.get_value(0).map_err(db_err)?) {
                    return Ok(id);
                }
            }
        }

        let id = new_id();
        db.execute(
            r#"
            INSERT INTO Notificaciones (
                ID_Notificacion, Tipo, Severidad, Titulo, Cuerpo,
                Destino_Tipo, Destino_Valor, Accion, Payload, Clave_Dedupe,
                Creada_En, Expira_En
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9, ?10,
                datetime('now','localtime'), ?11
            );
            "#,
            vec![
                Value::Text(id.clone()),
                Value::Text(nueva.tipo),
                Value::Text(nueva.severidad.as_str().to_string()),
                Value::Text(nueva.titulo),
                opt_text(nueva.cuerpo),
                Value::Text(destino_tipo.to_string()),
                opt_text(destino_valor),
                opt_text(nueva.accion),
                opt_text(nueva.payload),
                opt_text(nueva.clave_dedupe),
                opt_text(nueva.expira_en),
            ],
        )
        .await
        .map_err(db_err)?;

        Ok(id)
    }

    async fn resolver_por_clave(&self, clave_dedupe: &str) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                "UPDATE Notificaciones SET Estado = 'resuelta' \
                 WHERE Clave_Dedupe = ?1 AND Estado = 'activa';",
                vec![Value::Text(clave_dedupe.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }
}
