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

/// Igual que [`VISIBLE`] pero para la PAPELERA: lo descartado. Sin filtro de caducidad — una
/// notificación caducada que alguien borró sigue estando en su papelera hasta que decida qué hacer
/// con ella, y esconderla sólo daría la sensación de que el "borrar para siempre" se ejecutó solo.
const VISIBLE_PAPELERA: &str = r#"
    n.Estado = 'descartada'
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

    /// Filas de notificación de un usuario bajo el predicado que se le pase (centro o papelera).
    /// El `where_extra` sale SIEMPRE de una constante de este módulo, nunca de la entrada.
    async fn filas(
        &self,
        id_usuario: &str,
        predicado: &str,
        filtro_no_leidas: &str,
    ) -> AppResult<Vec<NotificacionRow>> {
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
            WHERE {predicado}
              {filtro_no_leidas}
            ORDER BY n.Creada_En DESC, n.ID_Notificacion DESC
            LIMIT {limit};
            "#,
            predicado = predicado,
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

    /// Cambia el estado de una notificación. Es una escritura normal (`execute`), así que la
    /// captura del outbox la replica a la nube y a las Handy como cualquier otra.
    async fn set_estado(&self, id_notificacion: &str, estado: &'static str) -> AppResult<bool> {
        let db = self.db.write().await;
        let affected = db
            .execute(
                "UPDATE Notificaciones SET Estado = ?2 WHERE ID_Notificacion = ?1;",
                vec![
                    Value::Text(id_notificacion.to_string()),
                    Value::Text(estado.to_string()),
                ],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
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

        self.filas(id_usuario, VISIBLE, filtro_no_leidas).await
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

    async fn descartar(&self, id_notificacion: &str) -> AppResult<bool> {
        self.set_estado(id_notificacion, "descartada").await
    }

    async fn listar_descartadas(&self, id_usuario: &str) -> AppResult<Vec<NotificacionRow>> {
        self.filas(id_usuario, VISIBLE_PAPELERA, "").await
    }

    async fn restaurar(&self, id_notificacion: &str) -> AppResult<bool> {
        // Vuelve a 'activa'. Ojo con el índice único de dedupe: si mientras estaba en la papelera
        // se volvió a emitir el mismo aviso, restaurarla chocaría con la nueva. El error sube tal
        // cual (la UI lo enseña): inventarse un desempate aquí sería decidir por el usuario cuál
        // de las dos vale.
        self.set_estado(id_notificacion, "activa").await
    }

    async fn eliminar(&self, id_notificacion: &str) -> AppResult<bool> {
        // Los recibos de lectura se van con ella por ON DELETE CASCADE. El DELETE se captura en el
        // outbox y cada motor re-deriva su cascada al aplicarlo (FK activadas en toda conexión).
        let db = self.db.write().await;
        let affected = db
            .execute(
                "DELETE FROM Notificaciones WHERE ID_Notificacion = ?1;",
                vec![Value::Text(id_notificacion.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(affected > 0)
    }
}

/// Lo que se puede cambiar de una notificación activa al volver a emitirla (RI-12), en el orden de
/// `COLUMNAS_ACTUALIZABLES`. Los dos primeros son lo que se ve de un vistazo; si cambia alguno, el
/// aviso vuelve a salir como no leído.
#[derive(PartialEq)]
struct Contenido {
    severidad: Option<String>,
    titulo: Option<String>,
    cuerpo: Option<String>,
    tipo: Option<String>,
    destino_tipo: Option<String>,
    destino_valor: Option<String>,
    accion: Option<String>,
    payload: Option<String>,
    expira_en: Option<String>,
}

const COLUMNAS_ACTUALIZABLES: &str =
    "Severidad, Titulo, Cuerpo, Tipo, Destino_Tipo, Destino_Valor, Accion, Payload, Expira_En";

impl Contenido {
    fn de(n: &NuevaNotificacion) -> Self {
        let (destino_tipo, destino_valor) = n.destino.to_columns();
        Contenido {
            severidad: Some(n.severidad.as_str().to_string()),
            titulo: Some(n.titulo.clone()),
            cuerpo: n.cuerpo.clone(),
            tipo: Some(n.tipo.clone()),
            destino_tipo: Some(destino_tipo.to_string()),
            destino_valor,
            accion: n.accion.clone(),
            payload: n.payload.clone(),
            expira_en: n.expira_en.clone(),
        }
    }

    fn se_ve_distinto(&self, otro: &Contenido) -> bool {
        (&self.severidad, &self.titulo) != (&otro.severidad, &otro.titulo)
    }

    fn valores(&self) -> Vec<Value> {
        [
            &self.severidad,
            &self.titulo,
            &self.cuerpo,
            &self.tipo,
            &self.destino_tipo,
            &self.destino_valor,
            &self.accion,
            &self.payload,
            &self.expira_en,
        ]
        .into_iter()
        .map(|v| opt_text(v.clone()))
        .collect()
    }
}

/// La notificación activa con esa clave, si la hay, con su contenido.
async fn activa_por_clave<C: Reader>(conn: &C, clave: &str) -> AppResult<Option<(String, Contenido)>> {
    let mut rows = conn
        .query(
            &format!(
                "SELECT ID_Notificacion, {COLUMNAS_ACTUALIZABLES} FROM Notificaciones \
                 WHERE Clave_Dedupe = ?1 AND Estado = 'activa' LIMIT 1;"
            ),
            vec![Value::Text(clave.to_string())],
        )
        .await
        .map_err(db_err)?;
    let Some(row) = rows.next().await.map_err(db_err)? else {
        return Ok(None);
    };
    let col = |i: i32| -> AppResult<Option<String>> { Ok(v_string(row.get_value(i).map_err(db_err)?)) };
    let Some(id) = col(0)? else {
        return Ok(None);
    };
    Ok(Some((
        id,
        Contenido {
            severidad: col(1)?,
            titulo: col(2)?,
            cuerpo: col(3)?,
            tipo: col(4)?,
            destino_tipo: col(5)?,
            destino_valor: col(6)?,
            accion: col(7)?,
            payload: col(8)?,
            expira_en: col(9)?,
        },
    )))
}

#[async_trait]
impl Notifier for SqliteNotificacionesRepository {
    /// Emite, o actualiza la activa con la misma clave (RI-12).
    ///
    /// Antes, con clave, se devolvía la existente sin tocarla: el aviso de atraso fiscal se quedaba
    /// con el texto y la severidad del primer escalón aunque llevara tres días sin remitir, y el del
    /// certificado seguía diciendo «caduca en 30 días» con siete por delante. Ahora:
    ///
    /// - **Igual**: no se escribe nada (cada escritura sube a la nube, y quien emite lo hace en cada
    ///   comprobación periódica).
    /// - **Cambia lo que se ve de un vistazo** (severidad o título: el atraso que sube de escalón,
    ///   «caduca en 7 días»): se actualiza, sube arriba (`Creada_En` = ahora) y se borran sus
    ///   lecturas, para que vuelva a salir como no leída.
    /// - **Cambia sólo el detalle** (cuerpo, acción, payload…): se actualiza sin molestar a nadie. El
    ///   aviso de stock negativo lleva la cantidad en el cuerpo, y cada venta la cambia: si eso lo
    ///   volviera a poner como no leído, saltaría en cada pasada en pleno servicio.
    ///
    /// Espejo de la ruta `POST /v1/notificaciones` del worker (`notificaciones.commands.ts::actualizar`).
    async fn emitir(&self, nueva: NuevaNotificacion) -> AppResult<String> {
        let (destino_tipo, destino_valor) = nueva.destino.to_columns();

        // Escritor único: mantener el guard sobre la búsqueda + la escritura hace la operación
        // race-free en la Main (no puede colarse otra emisión con la misma clave entre medias).
        let db = self.db.write().await;

        if let Some(clave) = nueva.clave_dedupe.as_deref() {
            if let Some((id, actual)) = activa_por_clave(&db, clave).await? {
                let nuevo = Contenido::de(&nueva);
                if nuevo == actual {
                    return Ok(id);
                }
                let se_ve_distinto = nuevo.se_ve_distinto(&actual);
                let fecha = if se_ve_distinto { ", Creada_En = datetime('now','localtime')" } else { "" };
                let mut valores = nuevo.valores();
                valores.push(Value::Text(id.clone()));

                db.execute_batch("BEGIN;").await.map_err(db_err)?;
                let res: AppResult<()> = async {
                    db.execute(
                        &format!(
                            "UPDATE Notificaciones SET Severidad = ?1, Titulo = ?2, Cuerpo = ?3, \
                             Tipo = ?4, Destino_Tipo = ?5, Destino_Valor = ?6, Accion = ?7, \
                             Payload = ?8, Expira_En = ?9{fecha} WHERE ID_Notificacion = ?10;"
                        ),
                        valores,
                    )
                    .await
                    .map_err(db_err)?;
                    if se_ve_distinto {
                        db.execute(
                            "DELETE FROM Notificacion_Lecturas WHERE ID_Notificacion = ?1;",
                            vec![Value::Text(id.clone())],
                        )
                        .await
                        .map_err(db_err)?;
                    }
                    Ok(())
                }
                .await;
                return match res {
                    Ok(()) => {
                        db.execute_batch("COMMIT;").await.map_err(db_err)?;
                        Ok(id)
                    }
                    Err(e) => {
                        let _ = db.execute_batch("ROLLBACK;").await;
                        Err(e)
                    }
                };
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
        // Quien resuelve lo hace en cada comprobación periódica, haya aviso o no (RI-12: también la
        // licencia en cada pulso). Sin nada activo no se escribe: un UPDATE que no toca ninguna
        // fila también se captura en el outbox y sube a la nube.
        if activa_por_clave(&db, clave_dedupe).await?.is_none() {
            return Ok(false);
        }
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

#[cfg(test)]
mod tests_emision_repetida {
    //! RI-12: quien emite o resuelve lo hace en cada comprobación periódica. Lo que no cambia nada
    //! no puede escribir: cada escritura entra en el outbox y sube a la nube.

    use super::*;
    use tpv_domain::notificaciones::{Destino, Severidad};

    async fn abrir() -> (Arc<Db>, SqliteNotificacionesRepository, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("notif_repetida");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (db.clone(), SqliteNotificacionesRepository::new(db), dir)
    }

    async fn en_outbox(db: &Db) -> i64 {
        let g = db.read().await;
        let mut rows = g.query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
        v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap_or(0)
    }

    fn aviso(titulo: &str) -> NuevaNotificacion {
        NuevaNotificacion {
            tipo: "gracia_offline".into(),
            severidad: Severidad::Aviso,
            titulo: titulo.into(),
            cuerpo: Some("Quedan ~72 h".into()),
            destino: Destino::Rol("rol-admin".into()),
            accion: None,
            payload: None,
            clave_dedupe: Some("gracia_offline".into()),
            expira_en: None,
        }
    }

    #[tokio::test]
    async fn repetir_el_mismo_aviso_no_escribe() {
        let (db, repo, _dir) = abrir().await;
        let id = repo.emitir(aviso("Sin conexión con licencias")).await.unwrap();
        let antes = en_outbox(&db).await;

        assert_eq!(repo.emitir(aviso("Sin conexión con licencias")).await.unwrap(), id);
        assert_eq!(en_outbox(&db).await, antes);

        // Y uno que cambia sí escribe, sobre la misma fila.
        assert_eq!(repo.emitir(aviso("Otro título")).await.unwrap(), id);
        assert!(en_outbox(&db).await > antes);
    }

    #[tokio::test]
    async fn resolver_lo_que_no_esta_activo_no_escribe() {
        let (db, repo, _dir) = abrir().await;
        let antes = en_outbox(&db).await;
        assert!(!repo.resolver_por_clave("gracia_offline").await.unwrap());
        assert_eq!(en_outbox(&db).await, antes);

        repo.emitir(aviso("Sin conexión con licencias")).await.unwrap();
        assert!(repo.resolver_por_clave("gracia_offline").await.unwrap());
    }
}
