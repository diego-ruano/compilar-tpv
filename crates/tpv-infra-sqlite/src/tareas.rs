//! Adaptador SQLite de tareas. Las escrituras se capturan en el outbox;
//! las operaciones con varias sentencias usan Writer::transaccion (RI-32).

use crate::util::new_id;
use crate::consultas::{db_err, lista_json, select_one_i64};
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::tareas::TareasRepository;
use tpv_contracts::tareas::{
    MisTareasRow, TareaAdminRow, TareaAsignadoRow, TareaRow, TrabajadorUI,
};
use tpv_domain::tareas::TareaData;

use crate::db::{Db, Reader, Writer};
use crate::mapping::{v_i64, v_string};

pub struct SqliteTareasRepository {
    db: Arc<Db>,
}

impl SqliteTareasRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

async fn exists_tarea<C: Reader>(conn: &C, id_tarea: &str) -> AppResult<bool> {
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
async fn apply_set_asignaciones_core<C: Writer>(
    conn: &C,
    id_tarea: &str,
    ids_trabajadores: &[String],
) -> AppResult<()> {
    // TAR-03: validar que todos los trabajadores existen antes de asignar. No se delega en la FK a
    // Trabajadores: en la Main ya abortaría, pero en la nube (DB-03) podría no aplicarse y dejar
    // asignaciones huérfanas. La lista llega ya normalizada (limpia y sin duplicados), así que su
    // longitud es el nº de ids distintos que deben existir.
    if !ids_trabajadores.is_empty() {
        let encontrados = select_one_i64(
            conn,
            // Un eliminado con historia (`Archivado_En`) ya no se puede asignar.
            "SELECT COUNT(DISTINCT t.ID_Trabajador) FROM Trabajadores t \
             JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario \
             WHERE t.ID_Trabajador IN (SELECT value FROM json_each(?1)) AND u.Archivado_En IS NULL;",
            vec![lista_json(ids_trabajadores)],
        )
        .await?
        .unwrap_or(0);
        if (encontrados as usize) != ids_trabajadores.len() {
            return Err(AppError::validation("Algún trabajador asignado no existe."));
        }
    }

    if ids_trabajadores.is_empty() {
        conn.execute(
            "DELETE FROM Tarea_Asignaciones WHERE ID_Tarea = ?1;",
            vec![Value::Text(id_tarea.to_string())],
        )
        .await
        .map_err(db_err)?;
    } else {
        // DO-01: los asignados que se quedan, en UN parámetro (un array JSON): esta sentencia se
        // replica y la nube admite 100 parámetros por sentencia.
        conn.execute(
            r#"
            DELETE FROM Tarea_Asignaciones
            WHERE ID_Tarea = ?1
              AND ID_Trabajador NOT IN (SELECT value FROM json_each(?2));
            "#,
            vec![Value::Text(id_tarea.to_string()), lista_json(ids_trabajadores)],
        )
        .await
        .map_err(db_err)?;
    }

    // TAR-02 (semántica decidida): `INSERT OR IGNORE` es intencional. Si un trabajador que YA
    // finalizó la tarea sigue en el conjunto de asignados, su fila (Estado='FINALIZADA') se
    // conserva: re-guardar el conjunto NO reabre su asignación. Solo quien se quita del conjunto
    // se borra arriba; si se le vuelve a añadir después, entra como fila nueva ('PENDIENTE').
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
        let g = self.db.read().await;
        let conn = &g;

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
        let g = self.db.read().await;
        let conn = &g;

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
            ORDER BY t.Fecha_Creacion DESC, t.ID_Tarea DESC;
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
        let g = self.db.read().await;
        let conn = &g;

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
        let g = self.db.read().await;
        let conn = &g;

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
                estado: tpv_domain::estados::EstadoAsignacion::desde_texto(&v_string(row.get_value(5).map_err(db_err)?).unwrap_or_default()).map_err(db_err)?.como_texto().to_string(),
                finalizada_at: v_string(row.get_value(6).map_err(db_err)?),
            });
        }

        Ok(out)
    }

    async fn get_mis_tareas(&self, id_trabajador: &str) -> AppResult<Vec<MisTareasRow>> {
        let g = self.db.read().await;
        let conn = &g;

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
                estado: tpv_domain::estados::EstadoAsignacion::desde_texto(&v_string(row.get_value(5).map_err(db_err)?).unwrap_or_default()).map_err(db_err)?.como_texto().to_string(),
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
        let g = self.db.write().await;
        let conn = &g;

        let res: AppResult<bool> = conn.transaccion(async {
            // UUIDv7 explícito (la BD ya no autoincrementa el id).
            let id_tarea = new_id();
            conn.execute(
                r#"
                INSERT INTO Tareas (
                  ID_Tarea,
                  Titulo,
                  Descripcion,
                  Fecha_Limite,
                  Fecha_Creacion
                )
                VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'));
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
        }).await;

        res
    }

    async fn update_tarea(&self, id_tarea: &str, data: TareaData) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;

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
        let g = self.db.write().await;
        let conn = &g;

        if !exists_tarea(conn, id_tarea).await? {
            return Err(AppError::not_found("Tarea no encontrada"));
        }

        let res: AppResult<bool> = conn.transaccion(async {
            apply_set_asignaciones_core(conn, id_tarea, &ids_trabajadores).await?;
            Ok(true)
        }).await;

        res
    }

    /// TAR-05: el borrado es **reversible**. En vez de perder la fila (y sus asignaciones por
    /// CASCADE), la tarea pasa a `Estado='ELIMINADA'`: desaparece de las listas y del escáner de
    /// avisos —que ya filtraban por `COALESCE(Estado,'ABIERTA')='ABIERTA'`— pero conserva a quién
    /// estaba asignada, que es lo que permite restaurarla tal y como estaba.
    async fn delete_tarea(&self, id_tarea: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;

        let affected = conn
            .execute(
                r#"
                UPDATE Tareas
                SET Estado = ?2
                WHERE ID_Tarea = ?1
                  AND COALESCE(Estado, 'ABIERTA') <> 'ELIMINADA';
                "#,
                vec![Value::Text(id_tarea.to_string()), Value::Text(tpv_domain::estados::EstadoTarea::Eliminada.como_texto().into())],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("Tarea no encontrada"));
        }

        Ok(true)
    }

    async fn get_papelera(&self) -> AppResult<Vec<TareaAdminRow>> {
        let g = self.db.read().await;
        let conn = &g;

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
            WHERE COALESCE(t.Estado, 'ABIERTA') = 'ELIMINADA'
            ORDER BY t.Fecha_Creacion DESC, t.ID_Tarea DESC;
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

    async fn restaurar_tarea(&self, id_tarea: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;

        let affected = conn
            .execute(
                r#"
                UPDATE Tareas
                SET Estado = ?2
                WHERE ID_Tarea = ?1
                  AND COALESCE(Estado, 'ABIERTA') = 'ELIMINADA';
                "#,
                vec![Value::Text(id_tarea.to_string()), Value::Text(tpv_domain::estados::EstadoTarea::Abierta.como_texto().into())],
            )
            .await
            .map_err(db_err)?;

        if affected == 0 {
            return Err(AppError::not_found("La tarea no está en la papelera"));
        }

        Ok(true)
    }

    /// Vaciar la papelera **sí** borra de verdad (es el único camino que pierde datos, y hay que
    /// pedirlo a propósito). Las asignaciones se borran a mano antes que las tareas: el CASCADE de
    /// la FK existe en la Main, pero en la nube puede no estar activo (DB-03) y dejaría huérfanas.
    async fn vaciar_papelera(&self) -> AppResult<i64> {
        let g = self.db.write().await;
        let conn = &g;

        let res: AppResult<i64> = conn.transaccion(async {
            conn.execute(
                r#"
                DELETE FROM Tarea_Asignaciones
                WHERE ID_Tarea IN (
                  SELECT ID_Tarea FROM Tareas WHERE COALESCE(Estado, 'ABIERTA') = 'ELIMINADA'
                );
                "#,
                vec![],
            )
            .await
            .map_err(db_err)?;

            let borradas = conn
                .execute(
                    "DELETE FROM Tareas WHERE COALESCE(Estado, 'ABIERTA') = 'ELIMINADA';",
                    vec![],
                )
                .await
                .map_err(db_err)?;

            Ok(borradas as i64)
        }).await;

        res
    }

    async fn marcar_finalizada(&self, id_tarea: &str, id_trabajador: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let conn = &g;

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
            return Err(AppError::not_found(MSG_TAREA_NO_ASIGNADA));
        }

        Ok(true)
    }
}

/// INC-20261030-010: finalizar una tarea que no es tuya (te la quitaron, o la pantalla se quedó con
/// una ajena al perder el permiso de gestión). El mismo texto que `tarea_no_asignada` en el worker,
/// que antes la daba por buena sin tocar nada.
pub(crate) const MSG_TAREA_NO_ASIGNADA: &str = "Esa tarea ya no está asignada a ti. Actualiza la lista.";

#[cfg(test)]
mod tests_finalizar {
    use super::*;

    async fn preparar() -> (Arc<Db>, SqliteTareasRepository) {
        let dir = crate::test_temp::dir_temporal("tareas_finalizar");
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        db.write().await.raw().execute_batch(
            "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado) SELECT 'u', ID_Rol, 'u@bar.test', 'h', 'Ana', 'Activo' FROM Roles WHERE Nombre_Rol = 'Administrador';
             INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('t', 'u');
             INSERT INTO Tareas (ID_Tarea, Titulo, Fecha_Creacion) VALUES ('tarea', 'Limpiar', '2026-10-30 10:00:00');",
        ).await.unwrap();
        let repo = SqliteTareasRepository::new(db.clone());
        (db, repo)
    }

    #[tokio::test]
    async fn finalizar_una_tarea_que_no_es_tuya_se_rechaza_y_dice_que_hacer() {
        let (_db, repo) = preparar().await;
        let e = repo.marcar_finalizada("tarea", "t").await.unwrap_err();
        assert!(matches!(&e, AppError::NotFound(m) if m == MSG_TAREA_NO_ASIGNADA), "{e:?}");
    }

    #[tokio::test]
    async fn finalizar_la_tuya_la_marca() {
        let (db, repo) = preparar().await;
        db.write().await.raw().execute_batch(
            "INSERT INTO Tarea_Asignaciones (ID_Tarea, ID_Trabajador, Asignada_At) VALUES ('tarea', 't', '2026-10-30 10:00:00');",
        ).await.unwrap();
        assert!(repo.marcar_finalizada("tarea", "t").await.unwrap());
    }
}

