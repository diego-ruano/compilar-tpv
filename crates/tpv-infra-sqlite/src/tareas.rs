//! Adaptador SQLite del repositorio de **tareas**. Local-First: sin Applied_Operations,
//! sin Outbox, sin idempotencia por op_id. Las escrituras multi-sentencia van en una
//! transacción explícita (BEGIN/COMMIT/ROLLBACK), igual que el resto de repositorios.

use std::sync::Arc;

use async_trait::async_trait;
use libsql::Value;

use crate::recording::TrackedConnection as Connection;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::tareas::TareasRepository;
use tpv_contracts::tareas::{
    MisTareasRow, TareaAdminRow, TareaAsignadoRow, TareaRow, TrabajadorUI,
};
use tpv_domain::tareas::TareaData;

use crate::mapping::{v_i64, v_string};
use crate::util::new_id;

pub struct SqliteTareasRepository {
    conn: Arc<Connection>,
}

impl SqliteTareasRepository {
    pub fn new(conn: Arc<Connection>) -> Self {
        Self { conn }
    }
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::repository(e.to_string())
}

fn build_in_placeholders(start: i64, count: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start + i as i64))
        .collect::<Vec<_>>()
        .join(", ")
}

async fn select_one_i64(
    conn: &Connection,
    sql: &str,
    args: Vec<Value>,
) -> AppResult<Option<i64>> {
    let mut rows = conn.query(sql, args).await.map_err(db_err)?;
    if let Some(row) = rows.next().await.map_err(db_err)? {
        return Ok(v_i64(row.get_value(0).map_err(db_err)?));
    }
    Ok(None)
}

async fn exists_tarea(conn: &Connection, id_tarea: &str) -> AppResult<bool> {
    if id_tarea.trim().is_empty() {
        return Ok(false);
    }
    Ok(
        select_one_i64(conn, "SELECT 1 FROM Tareas WHERE ID_Tarea=?1 LIMIT 1;", vec![
            Value::Text(id_tarea.to_string()),
        ])
        .await?
        .is_some(),
    )
}

/// Sustituye el conjunto de asignaciones de una tarea (borra las que sobran e inserta
/// las nuevas con estado PENDIENTE). No abre transacción: el llamador la gestiona.
async fn apply_set_asignaciones_core(
    conn: &Connection,
    id_tarea: &str,
    ids_trabajadores: &[String],
) -> AppResult<()> {
    if ids_trabajadores.is_empty() {
        conn.execute(
            "DELETE FROM Tarea_Asignaciones WHERE ID_Tarea = ?1;",
            vec![Value::Text(id_tarea.to_string())],
        )
        .await
        .map_err(db_err)?;
    } else {
        let placeholders = build_in_placeholders(2, ids_trabajadores.len());

        let mut sql_args: Vec<Value> = Vec::with_capacity(1 + ids_trabajadores.len());
        sql_args.push(Value::Text(id_tarea.to_string()));
        for id_trab in ids_trabajadores.iter() {
            sql_args.push(Value::Text(id_trab.clone()));
        }

        let sql = format!(
            r#"
            DELETE FROM Tarea_Asignaciones
            WHERE ID_Tarea = ?1
              AND ID_Trabajador NOT IN ({});
            "#,
            placeholders
        );

        conn.execute(&sql, sql_args).await.map_err(db_err)?;
    }

    for id_trab in ids_trabajadores.iter() {
        conn.execute(
            r#"
            INSERT OR IGNORE INTO Tarea_Asignaciones (
              ID_Tarea,
              ID_Trabajador,
              Asignada_At,
              Estado
            )
            VALUES (
              ?1,
              ?2,
              datetime('now','localtime'),
              'PENDIENTE'
            );
            "#,
            vec![Value::Text(id_tarea.to_string()), Value::Text(id_trab.clone())],
        )
        .await
        .map_err(db_err)?;
    }

    Ok(())
}

#[async_trait]
impl TareasRepository for SqliteTareasRepository {
    async fn get_trabajadores(&self) -> AppResult<Vec<TrabajadorUI>> {
        let conn = &self.conn;

        let sql = r#"
            SELECT
              t.ID_Trabajador,
              t.ID_Usuario,
              u.Nombre,
              u.Apellido,
              t.Puesto,
              u.Email
            FROM Trabajadores t
            JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
            WHERE u.Estado = 'Activo'
            ORDER BY u.Nombre ASC;
        "#;

        let mut rows = conn.query(sql, ()).await.map_err(db_err)?;
        let mut out: Vec<TrabajadorUI> = vec![];

        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(TrabajadorUI {
                id_trabajador: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                id_usuario: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                nombre: v_string(row.get_value(2).map_err(db_err)?).unwrap_or_default(),
                apellido: v_string(row.get_value(3).map_err(db_err)?),
                puesto: v_string(row.get_value(4).map_err(db_err)?),
                email: v_string(row.get_value(5).map_err(db_err)?).unwrap_or_default(),
            });
        }

        Ok(out)
    }

    async fn get_tareas_admin(&self) -> AppResult<Vec<TareaAdminRow>> {
        let conn = &self.conn;

        let sql = r#"
            SELECT
              t.ID_Tarea,
              t.Titulo,
              t.Descripcion,
              t.Fecha_Creacion,
              t.Fecha_Limite,
              (
                SELECT COUNT(*)
                FROM Tarea_Asignaciones a
                WHERE a.ID_Tarea = t.ID_Tarea
              ) AS Total_Asignados,
              (
                SELECT COUNT(*)
                FROM Tarea_Asignaciones a
                WHERE a.ID_Tarea = t.ID_Tarea
                  AND a.Estado = 'FINALIZADA'
              ) AS Total_Finalizadas
            FROM Tareas t
            WHERE COALESCE(t.Estado, 'ABIERTA') = 'ABIERTA'
            ORDER BY t.ID_Tarea DESC;
        "#;

        let mut rows = conn.query(sql, ()).await.map_err(db_err)?;
        let mut out: Vec<TareaAdminRow> = vec![];

        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(TareaAdminRow {
                id_tarea: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                titulo: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                descripcion: v_string(row.get_value(2).map_err(db_err)?),
                fecha_creacion: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
                fecha_limite: v_string(row.get_value(4).map_err(db_err)?),
                total_asignados: v_i64(row.get_value(5).map_err(db_err)?).unwrap_or(0),
                total_finalizadas: v_i64(row.get_value(6).map_err(db_err)?).unwrap_or(0),
            });
        }

        Ok(out)
    }

    async fn get_tarea_by_id(&self, id_tarea: &str) -> AppResult<Option<TareaRow>> {
        let conn = &self.conn;

        if id_tarea.trim().is_empty() {
            return Ok(None);
        }

        let mut rows = conn
            .query(
                r#"
                SELECT ID_Tarea, Titulo, Descripcion, Fecha_Creacion, Fecha_Limite
                FROM Tareas
                WHERE ID_Tarea = ?1
                LIMIT 1;
                "#,
                vec![Value::Text(id_tarea.to_string())],
            )
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(None);
        };

        Ok(Some(TareaRow {
            id_tarea: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
            titulo: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
            descripcion: v_string(row.get_value(2).map_err(db_err)?),
            fecha_creacion: v_string(row.get_value(3).map_err(db_err)?).unwrap_or_default(),
            fecha_limite: v_string(row.get_value(4).map_err(db_err)?),
        }))
    }

    async fn get_tarea_asignados(&self, id_tarea: &str) -> AppResult<Vec<TareaAsignadoRow>> {
        let conn = &self.conn;

        if id_tarea.trim().is_empty() {
            return Ok(vec![]);
        }

        let sql = r#"
            SELECT
              a.ID_Trabajador,
              u.Nombre,
              u.Apellido,
              t.Puesto,
              a.Asignada_At,
              a.Estado,
              a.Finalizada_At
            FROM Tarea_Asignaciones a
            JOIN Trabajadores t ON t.ID_Trabajador = a.ID_Trabajador
            JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
            WHERE a.ID_Tarea = ?1
            ORDER BY u.Nombre ASC;
        "#;

        let mut rows = conn
            .query(sql, vec![Value::Text(id_tarea.to_string())])
            .await
            .map_err(db_err)?;

        let mut out: Vec<TareaAsignadoRow> = vec![];

        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(TareaAsignadoRow {
                id_trabajador: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                nombre: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                apellido: v_string(row.get_value(2).map_err(db_err)?),
                puesto: v_string(row.get_value(3).map_err(db_err)?),
                asignada_at: v_string(row.get_value(4).map_err(db_err)?).unwrap_or_default(),
                estado: v_string(row.get_value(5).map_err(db_err)?)
                    .unwrap_or_else(|| "PENDIENTE".into()),
                finalizada_at: v_string(row.get_value(6).map_err(db_err)?),
            });
        }

        Ok(out)
    }

    async fn get_mis_tareas(&self, id_trabajador: &str) -> AppResult<Vec<MisTareasRow>> {
        let conn = &self.conn;

        if id_trabajador.trim().is_empty() {
            return Ok(vec![]);
        }

        let sql = r#"
            SELECT
              t.ID_Tarea,
              t.Titulo,
              t.Descripcion,
              t.Fecha_Limite,
              a.Asignada_At,
              a.Estado,
              a.Finalizada_At
            FROM Tarea_Asignaciones a
            JOIN Tareas t ON t.ID_Tarea = a.ID_Tarea
            WHERE a.ID_Trabajador = ?1
              AND COALESCE(t.Estado, 'ABIERTA') = 'ABIERTA'
              AND (
                a.Estado <> 'FINALIZADA'
                OR date(a.Finalizada_At) = date('now','localtime')
              )
            ORDER BY
              CASE WHEN a.Estado='PENDIENTE' THEN 0 ELSE 1 END,
              t.Fecha_Limite ASC,
              t.ID_Tarea DESC;
        "#;

        let mut rows = conn
            .query(sql, vec![Value::Text(id_trabajador.to_string())])
            .await
            .map_err(db_err)?;

        let mut out: Vec<MisTareasRow> = vec![];

        while let Some(row) = rows.next().await.map_err(db_err)? {
            out.push(MisTareasRow {
                id_tarea: v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default(),
                titulo: v_string(row.get_value(1).map_err(db_err)?).unwrap_or_default(),
                descripcion: v_string(row.get_value(2).map_err(db_err)?),
                fecha_limite: v_string(row.get_value(3).map_err(db_err)?),
                asignada_at: v_string(row.get_value(4).map_err(db_err)?).unwrap_or_default(),
                estado: v_string(row.get_value(5).map_err(db_err)?)
                    .unwrap_or_else(|| "PENDIENTE".into()),
                finalizada_at: v_string(row.get_value(6).map_err(db_err)?),
            });
        }

        Ok(out)
    }

    async fn create_tarea(
        &self,
        data: TareaData,
        ids_trabajadores: Vec<String>,
    ) -> AppResult<bool> {
        let conn = &self.conn;

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            // UUIDv7 explícito (la BD ya no autoincrementa el id).
            let id_tarea = new_id();
            conn.execute(
                r#"
                INSERT INTO Tareas (
                  ID_Tarea,
                  Titulo,
                  Descripcion,
                  Fecha_Limite
                )
                VALUES (?1, ?2, ?3, ?4);
                "#,
                vec![
                    Value::Text(id_tarea.clone()),
                    Value::Text(data.titulo.clone()),
                    data.descripcion.clone().map(Value::Text).unwrap_or(Value::Null),
                    data.fecha_limite.clone().map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(db_err)?;

            apply_set_asignaciones_core(conn, &id_tarea, &ids_trabajadores).await?;

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

    async fn update_tarea(&self, id_tarea: &str, data: TareaData) -> AppResult<bool> {
        let conn = &self.conn;

        let affected = conn
            .execute(
                r#"
                UPDATE Tareas
                SET
                  Titulo = ?2,
                  Descripcion = ?3,
                  Fecha_Limite = ?4
                WHERE ID_Tarea = ?1;
                "#,
                vec![
                    Value::Text(id_tarea.to_string()),
                    Value::Text(data.titulo.clone()),
                    data.descripcion.clone().map(Value::Text).unwrap_or(Value::Null),
                    data.fecha_limite.clone().map(Value::Text).unwrap_or(Value::Null),
                ],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("Tarea no encontrada"));
        }

        Ok(true)
    }

    async fn set_asignaciones(
        &self,
        id_tarea: &str,
        ids_trabajadores: Vec<String>,
    ) -> AppResult<bool> {
        let conn = &self.conn;

        if !exists_tarea(conn, id_tarea).await? {
            return Err(AppError::not_found("Tarea no encontrada"));
        }

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            apply_set_asignaciones_core(conn, id_tarea, &ids_trabajadores).await?;
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

    async fn delete_tarea(&self, id_tarea: &str) -> AppResult<bool> {
        let conn = &self.conn;

        conn.execute_batch("BEGIN;").await.map_err(db_err)?;
        let res: AppResult<bool> = async {
            conn.execute(
                "DELETE FROM Tarea_Asignaciones WHERE ID_Tarea = ?1;",
                vec![Value::Text(id_tarea.to_string())],
            )
            .await
            .map_err(db_err)?;

            let affected = conn
                .execute(
                    "DELETE FROM Tareas WHERE ID_Tarea = ?1;",
                    vec![Value::Text(id_tarea.to_string())],
                )
                .await
                .map_err(db_err)?;

            if affected == 0 {
                return Err(AppError::not_found("Tarea no encontrada"));
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

    async fn marcar_finalizada(&self, id_tarea: &str, id_trabajador: &str) -> AppResult<bool> {
        let conn = &self.conn;

        let affected = conn
            .execute(
                r#"
                UPDATE Tarea_Asignaciones
                SET
                  Estado = 'FINALIZADA',
                  Finalizada_At = COALESCE(Finalizada_At, datetime('now','localtime'))
                WHERE ID_Tarea = ?1
                  AND ID_Trabajador = ?2;
                "#,
                vec![Value::Text(id_tarea.to_string()), Value::Text(id_trabajador.to_string())],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("Asignación no encontrada"));
        }

        Ok(true)
    }
}
