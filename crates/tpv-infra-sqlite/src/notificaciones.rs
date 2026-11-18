//! Adaptador SQLite de **notificaciones**: implementa `NotificacionesRepository` (lectura/gestión)
//! y `Notifier` (emisión). Local-First: las escrituras son INSERT/UPDATE directos; el reparto a la
//! nube/Handy lo hace la captura del outbox de `db.rs` (no hay outbox manual aquí).
//!
//! Visibilidad: una notificación es visible para un usuario si su destino es `todos`, o `usuario`
//! con su `ID_Usuario`, o `rol` con el `ID_Rol` de ese usuario (resuelto contra `Usuarios`). El
//! estado "leída" es por usuario (tabla `Notificacion_Lecturas`).

use crate::util::new_id;
use crate::consultas::{db_err};
use std::sync::Arc;

use async_trait::async_trait;
use crate::ejecutor::Value;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::notificaciones::{NotificacionesRepository, Notifier};
use tpv_contracts::notificaciones::{NoLeidasDto, NotificacionRow};
use tpv_domain::notificaciones::NuevaNotificacion;

use crate::db::{Db, Reader, Writer};
use crate::mapping::{norm_opt_string, opt_text, v_i64, v_string};

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

/// AUD-26: el `WHERE` de las escrituras de un usuario sobre una notificación. `?1` es la
/// notificación y `?2` el usuario de la sesión; va dirigida a él si es para todos, para él o para
/// su rol. Sin alias de tabla: va en un `UPDATE`, en un `DELETE` y en el `SELECT` de un `INSERT`,
/// todos sobre `Notificaciones`. El worker construye la misma condición
/// (`notificaciones.commands.ts`), y el arnés de contrato comprueba que hacen lo mismo.
const DIRIGIDA_AL_USUARIO: &str = "ID_Notificacion = ?1 AND (Destino_Tipo = 'todos' \
     OR (Destino_Tipo = 'usuario' AND Destino_Valor = ?2) \
     OR (Destino_Tipo = 'rol' AND Destino_Valor = \
         (SELECT u.ID_Rol FROM Usuarios u WHERE u.ID_Usuario = ?2)))";

/// Lo que se puede descartar es lo que está en el centro; lo que se restaura o se borra para
/// siempre, lo que está en la papelera.
const EN_EL_CENTRO: &str = "Estado = 'activa'";
const EN_LA_PAPELERA: &str = "Estado = 'descartada'";

const NO_ESTA_EN_TU_LISTA: &str = "Esa notificación no está en tu lista.";

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

    /// AUD-26: escribe `sentencia` sólo si la notificación `?1` cumple `donde` para el usuario `?2`
    /// (va dirigida a él y, si se pide, está en ese estado). Es una escritura normal (`execute`):
    /// la captura del outbox la replica a la nube y a las Handy como cualquier otra.
    ///
    /// - Se comprueba con el escritor ya tomado: entre la comprobación y la escritura no entra nada,
    ///   tampoco lo que llega de la nube, que se aplica por este mismo escritor.
    /// - Si no la cumple, `not_found` y no se escribe: el outbox captura también una sentencia que
    ///   no toca ninguna fila, y subiría a la nube.
    /// - La sentencia lleva la misma condición en su `WHERE`, para que se cumpla también donde se
    ///   aplique después: si en la nube una Handy la restauró mientras tanto, el borrado que sube de
    ///   aquí no se la lleva.
    async fn escribir_si_es_suya(
        &self,
        id_notificacion: &str,
        id_usuario: &str,
        donde: &str,
        sentencia: &str,
    ) -> AppResult<u64> {
        let args = || {
            vec![
                Value::Text(id_notificacion.to_string()),
                Value::Text(id_usuario.to_string()),
            ]
        };
        let db = self.db.write().await;
        let es_suya = {
            let mut rows = db
                .query(&format!("SELECT 1 FROM Notificaciones WHERE {donde} LIMIT 1;"), args())
                .await
                .map_err(db_err)?;
            rows.next().await.map_err(db_err)?.is_some()
        };
        if !es_suya {
            return Err(AppError::not_found(NO_ESTA_EN_TU_LISTA));
        }
        db.execute(sentencia, args()).await.map_err(db_err)
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

    /// Con la fecha de la más reciente que puede ver, también en la papelera (`NoLeidasDto`): el
    /// aviso de una nueva sale si sube el número y avanza la fecha, y restaurar una de la papelera
    /// sólo sube el número.
    async fn contar_no_leidas(&self, id_usuario: &str) -> AppResult<NoLeidasDto> {
        let sql = format!(
            r#"
            SELECT
              (SELECT COUNT(*)
                 FROM Notificaciones n
                WHERE {visible}
                  AND NOT EXISTS (
                    SELECT 1 FROM Notificacion_Lecturas l
                    WHERE l.ID_Notificacion = n.ID_Notificacion AND l.ID_Usuario = ?1
                  )),
              (SELECT MAX(n.Creada_En)
                 FROM Notificaciones n
                WHERE ({visible}) OR ({papelera}));
            "#,
            visible = VISIBLE,
            papelera = VISIBLE_PAPELERA
        );

        let db = self.db.read().await;
        let mut rows = db
            .query(&sql, vec![Value::Text(id_usuario.to_string())])
            .await
            .map_err(db_err)?;

        let Some(row) = rows.next().await.map_err(db_err)? else {
            return Ok(NoLeidasDto::default());
        };
        Ok(NoLeidasDto {
            count: v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0),
            ultima_creada_en: norm_opt_string(row.get_value(1).map_err(db_err)?),
        })
    }

    async fn marcar_leida(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
        // INSERT OR IGNORE: idempotente (relee/marcar dos veces no duplica ni falla). Se captura en
        // el outbox y replica; `datetime('now','localtime')` se congela a literal al capturarse.
        // AUD-26: sólo de una notificación dirigida a quien lee, en cualquier estado (el recibo es
        // suyo y no cambia nada a nadie más). Por eso es un `INSERT ... SELECT` de esa fila: la
        // condición viaja con la sentencia.
        let insertadas = self
            .escribir_si_es_suya(
                id_notificacion,
                id_usuario,
                DIRIGIDA_AL_USUARIO,
                &format!(
                    "INSERT OR IGNORE INTO Notificacion_Lecturas (ID_Notificacion, ID_Usuario, Leida_En) \
                     SELECT ?1, ?2, datetime('now','localtime') FROM Notificaciones \
                     WHERE {DIRIGIDA_AL_USUARIO};"
                ),
            )
            .await?;
        Ok(insertadas > 0)
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
        db.transaccion(async {
        for id in &ids {
            db
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
                .await.map_err(db_err)?;
        }
            Ok(ids.len() as i64)
        }).await
    }

    async fn descartar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
        let donde = format!("{DIRIGIDA_AL_USUARIO} AND {EN_EL_CENTRO}");
        let cambiadas = self
            .escribir_si_es_suya(
                id_notificacion,
                id_usuario,
                &donde,
                &format!("UPDATE Notificaciones SET Estado = 'descartada' WHERE {donde};"),
            )
            .await?;
        Ok(cambiadas > 0)
    }

    async fn listar_descartadas(&self, id_usuario: &str) -> AppResult<Vec<NotificacionRow>> {
        self.filas(id_usuario, VISIBLE_PAPELERA, "").await
    }

    async fn restaurar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
        // Vuelve a 'activa'. Ojo con el índice único de dedupe: si mientras estaba en la papelera
        // se volvió a emitir el mismo aviso, restaurarla chocaría con la nueva. El error sube tal
        // cual (la UI lo enseña): inventarse un desempate aquí sería decidir por el usuario cuál
        // de las dos vale.
        let donde = format!("{DIRIGIDA_AL_USUARIO} AND {EN_LA_PAPELERA}");
        let cambiadas = self
            .escribir_si_es_suya(
                id_notificacion,
                id_usuario,
                &donde,
                &format!("UPDATE Notificaciones SET Estado = 'activa' WHERE {donde};"),
            )
            .await?;
        Ok(cambiadas > 0)
    }

    async fn eliminar(&self, id_notificacion: &str, id_usuario: &str) -> AppResult<bool> {
        // Los recibos de lectura se van con ella por ON DELETE CASCADE. El DELETE se captura en el
        // outbox y cada motor re-deriva su cascada al aplicarlo (FK activadas en toda conexión).
        // AUD-26: sólo una que siga en la papelera del usuario al borrarla; si alguien la restauró
        // entre que la vio y la borró, no se la lleva, ni aquí ni en la nube.
        let donde = format!("{DIRIGIDA_AL_USUARIO} AND {EN_LA_PAPELERA}");
        let borradas = self
            .escribir_si_es_suya(
                id_notificacion,
                id_usuario,
                &donde,
                &format!("DELETE FROM Notificaciones WHERE {donde};"),
            )
            .await?;
        Ok(borradas > 0)
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

impl SqliteNotificacionesRepository {
    /// `emitir`, y además si ha escrito algo: la Main lo usa para avisar a su pantalla sólo cuando
    /// cambia (`src-tauri/src/notificador.rs`).
    pub async fn emitir_y_decir_si_cambia(&self, nueva: NuevaNotificacion) -> AppResult<(String, bool)> {
        let (destino_tipo, destino_valor) = nueva.destino.to_columns();

        // Escritor único: mantener el guard sobre la búsqueda + la escritura hace la operación
        // race-free en la Main (no puede colarse otra emisión con la misma clave entre medias).
        let db = self.db.write().await;

        if let Some(clave) = nueva.clave_dedupe.as_deref() {
            if let Some((id, actual)) = activa_por_clave(&db, clave).await? {
                let nuevo = Contenido::de(&nueva);
                if nuevo == actual {
                    return Ok((id, false));
                }
                let se_ve_distinto = nuevo.se_ve_distinto(&actual);
                let fecha = if se_ve_distinto { ", Creada_En = datetime('now','localtime')" } else { "" };
                let mut valores = nuevo.valores();
                valores.push(Value::Text(id.clone()));

                return db.transaccion(async {
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
                }).await.map(|_| (id, true));
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

        Ok((id, true))
    }
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
        self.emitir_y_decir_si_cambia(nueva).await.map(|(id, _)| id)
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


#[cfg(test)]
mod tests_cada_uno_lo_suyo {
    //! AUD-26: el centro de notificaciones es de quien ha iniciado sesión. El comando pone el
    //! usuario de la sesión; aquí se comprueba, contra la base de verdad, lo que hacen con él el
    //! caso de uso y este repositorio: un usuario no lee ni marca en nombre de otro, y no descarta,
    //! restaura ni elimina lo que no ve. Lo que se le niega no deja nada en el outbox, y la
    //! condición va dentro de la sentencia que escribe: aguanta un cruce y se cumple también donde
    //! se aplique después.

    use super::*;
    use tpv_application::use_cases::notificaciones as uc;
    use tpv_contracts::notificaciones::{NotificacionIdInput, NotificacionesListArgs};
    use tpv_contracts::sync::SqlStatement;
    use tpv_domain::notificaciones::{Destino, Severidad, ADMIN_ROL_ID};

    const ADMIN: &str = "aud26-admin-ficticio";
    const OTRO_ADMIN: &str = "aud26-otro-admin-ficticio";
    const CAMARERO: &str = "aud26-camarero-ficticio";

    /// Una base con dos administradores y un camarero. El estado de partida va por `raw()`: no es
    /// una escritura de negocio.
    async fn base(prefijo: &str) -> Arc<Db> {
        let dir = crate::test_temp::dir_temporal(prefijo);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        {
            let w = db.write().await;
            for (id, rol) in [
                (ADMIN, "Administrador"),
                (OTRO_ADMIN, "Administrador"),
                (CAMARERO, "Camarero"),
            ] {
                w.raw()
                    .execute(
                        "INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado) \
                         VALUES (?1, (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = ?2), \
                                 ?1 || '@ficticio.invalid', 'x', 'Ficticio', 'Activo');",
                        vec![Value::Text(id.into()), Value::Text(rol.into())],
                    )
                    .await
                    .unwrap();
            }
        }
        db
    }

    async fn abrir() -> (Arc<Db>, SqliteNotificacionesRepository) {
        let db = base("notif_lo_suyo").await;
        (db.clone(), SqliteNotificacionesRepository::new(db))
    }

    /// Un aviso para los administradores, con datos de un cliente (ficticios).
    async fn aviso_al_admin(repo: &SqliteNotificacionesRepository) -> String {
        repo.emitir(NuevaNotificacion {
            tipo: "reserva_web_fallida".into(),
            severidad: Severidad::Aviso,
            titulo: "Reserva web sin confirmar".into(),
            cuerpo: Some("Llama al cliente: Cliente Ficticio · 600000000".into()),
            destino: Destino::Rol(ADMIN_ROL_ID.into()),
            accion: None,
            payload: None,
            clave_dedupe: None,
            expira_en: None,
        })
        .await
        .unwrap()
    }

    async fn contar(db: &Db, sql: &str) -> i64 {
        let g = db.read().await;
        let mut rows = g.query(sql, ()).await.unwrap();
        v_i64(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap_or(0)
    }

    async fn en_outbox(db: &Db) -> i64 {
        contar(db, "SELECT COUNT(*) FROM _Sync_Outbox;").await
    }

    /// Las sentencias de la última operación del outbox: lo que sube a la nube.
    async fn ultima_operacion(db: &Db) -> Vec<SqlStatement> {
        let g = db.read().await;
        let mut rows = g
            .query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;", ())
            .await
            .unwrap();
        let json = v_string(rows.next().await.unwrap().unwrap().get_value(0).unwrap()).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    fn id(id_notificacion: &str) -> NotificacionIdInput {
        NotificacionIdInput { id_notificacion: id_notificacion.into() }
    }

    async fn ids_del_centro(repo: &SqliteNotificacionesRepository, id_usuario: &str) -> Vec<String> {
        uc::listar(repo, id_usuario, NotificacionesListArgs { solo_no_leidas: None })
            .await
            .unwrap()
            .into_iter()
            .map(|n| n.id_notificacion)
            .collect()
    }

    #[tokio::test]
    async fn un_usuario_no_lee_ni_marca_lo_de_otro() {
        let (db, repo) = abrir().await;
        let aviso = aviso_al_admin(&repo).await;
        let antes = en_outbox(&db).await;

        // El camarero, con su usuario, no ve el aviso del rol Administrador ni lo cuenta.
        assert!(ids_del_centro(&repo, CAMARERO).await.is_empty());
        assert_eq!(uc::contar_no_leidas(&repo, CAMARERO).await.unwrap().count, 0);
        assert!(uc::listar_descartadas(&repo, CAMARERO).await.unwrap().is_empty());

        // Aunque conozca el id, no puede marcarlo: no es suyo. Ni recibo ni nada que suba.
        let r = uc::marcar_leida(&repo, CAMARERO, id(&aviso)).await;
        assert!(matches!(r, Err(AppError::NotFound(_))), "{r:?}");
        assert_eq!(
            contar(&db, "SELECT COUNT(*) FROM Notificacion_Lecturas;").await,
            0,
            "no queda ningún recibo"
        );
        assert_eq!(uc::marcar_todas_leidas(&repo, CAMARERO).await.unwrap(), 0);
        assert_eq!(en_outbox(&db).await, antes, "lo negado no sube a la nube");
        assert_eq!(uc::contar_no_leidas(&repo, ADMIN).await.unwrap().count, 1);

        // El administrador, con el suyo, lo ve y lo marca; la segunda vez no hay nada que marcar.
        assert_eq!(ids_del_centro(&repo, ADMIN).await, std::slice::from_ref(&aviso));
        assert!(uc::marcar_leida(&repo, ADMIN, id(&aviso)).await.unwrap());
        assert!(!uc::marcar_leida(&repo, ADMIN, id(&aviso)).await.unwrap());
        assert_eq!(uc::contar_no_leidas(&repo, ADMIN).await.unwrap().count, 0);
    }

    #[tokio::test]
    async fn restaurar_de_la_papelera_sube_el_numero_pero_no_la_fecha_de_la_mas_reciente() {
        // El aviso «Tienes una nueva notificación» salta si sube el número Y avanza la fecha de la
        // más reciente que el usuario puede ver, también en la papelera: restaurar una sube el
        // número, pero no es nueva.
        let (db, repo) = abrir().await;
        let aviso = aviso_al_admin(&repo).await;
        let creada = uc::contar_no_leidas(&repo, ADMIN).await.unwrap();
        assert_eq!(creada.count, 1);
        let fecha = creada.ultima_creada_en.clone().expect("la fecha de la más reciente");

        assert!(uc::descartar(&repo, ADMIN, id(&aviso)).await.unwrap());
        let en_la_papelera = uc::contar_no_leidas(&repo, ADMIN).await.unwrap();
        assert_eq!((en_la_papelera.count, en_la_papelera.ultima_creada_en.as_deref()), (0, Some(fecha.as_str())));

        assert!(uc::restaurar(&repo, ADMIN, id(&aviso)).await.unwrap());
        assert_eq!(uc::contar_no_leidas(&repo, ADMIN).await.unwrap(), creada, "otra vez la misma: no es nueva");

        // Una de verdad nueva (más tarde) sí la mueve; una que no es suya, no.
        db.write()
            .await
            .raw()
            .execute_batch(
                "INSERT INTO Notificaciones (ID_Notificacion, Tipo, Severidad, Titulo, Destino_Tipo, Destino_Valor, Estado, Creada_En) \
                 VALUES ('ajena', 'tarea', 'info', 'De otro', 'usuario', 'otro', 'activa', '2999-01-01 00:00:00'), \
                        ('nueva', 'tarea', 'info', 'Nueva', 'todos', NULL, 'activa', '2998-01-01 00:00:00');",
            )
            .await
            .unwrap();
        let ahora = uc::contar_no_leidas(&repo, ADMIN).await.unwrap();
        assert_eq!((ahora.count, ahora.ultima_creada_en.as_deref()), (2, Some("2998-01-01 00:00:00")));
    }

    #[tokio::test]
    async fn un_usuario_no_descarta_restaura_ni_elimina_lo_que_no_ve() {
        let (db, repo) = abrir().await;
        let aviso = aviso_al_admin(&repo).await;
        let antes = en_outbox(&db).await;

        // Desde el centro del camarero no se manda a la papelera.
        assert!(matches!(
            uc::descartar(&repo, CAMARERO, id(&aviso)).await,
            Err(AppError::NotFound(_))
        ));
        assert_eq!(ids_del_centro(&repo, ADMIN).await, std::slice::from_ref(&aviso));
        assert_eq!(en_outbox(&db).await, antes, "lo negado no sube a la nube");

        // El administrador lo descarta; desde la papelera del camarero no se restaura ni se
        // borra para siempre.
        assert!(uc::descartar(&repo, ADMIN, id(&aviso)).await.unwrap());
        let tras_descartar = en_outbox(&db).await;
        for r in [
            uc::restaurar(&repo, CAMARERO, id(&aviso)).await,
            uc::eliminar(&repo, CAMARERO, id(&aviso)).await,
        ] {
            assert!(matches!(r, Err(AppError::NotFound(_))), "{r:?}");
        }
        assert_eq!(en_outbox(&db).await, tras_descartar, "lo negado no sube a la nube");
        let papelera = uc::listar_descartadas(&repo, ADMIN).await.unwrap();
        assert_eq!(papelera.len(), 1, "sigue en la papelera del administrador");

        // Y el administrador hace lo de siempre: restaurar, volver a descartar y eliminar.
        assert!(uc::restaurar(&repo, ADMIN, id(&aviso)).await.unwrap());
        assert!(uc::descartar(&repo, ADMIN, id(&aviso)).await.unwrap());
        assert!(uc::eliminar(&repo, ADMIN, id(&aviso)).await.unwrap());
        assert!(uc::listar_descartadas(&repo, ADMIN).await.unwrap().is_empty());
        assert!(ids_del_centro(&repo, ADMIN).await.is_empty());
    }

    /// El cruce: A ve el aviso en su papelera, B lo restaura, y A pulsa «eliminar» sobre lo que
    /// vio. Lo que se borra para siempre tiene que seguir en la papelera al borrarlo: el aviso,
    /// ya activo, se queda.
    #[tokio::test]
    async fn restaurar_y_eliminar_cruzados_no_borran_un_aviso_activo() {
        let (db, repo) = abrir().await;
        let aviso = aviso_al_admin(&repo).await;
        assert!(uc::descartar(&repo, ADMIN, id(&aviso)).await.unwrap());

        // A la tiene en su papelera...
        let vista = uc::listar_descartadas(&repo, ADMIN).await.unwrap();
        assert_eq!(vista.len(), 1);
        // ...B la restaura...
        assert!(uc::restaurar(&repo, OTRO_ADMIN, id(&aviso)).await.unwrap());
        let antes = en_outbox(&db).await;
        // ...y A la borra para siempre.
        let r = uc::eliminar(&repo, ADMIN, id(&vista[0].id_notificacion)).await;

        assert!(matches!(r, Err(AppError::NotFound(_))), "{r:?}");
        assert_eq!(ids_del_centro(&repo, ADMIN).await, std::slice::from_ref(&aviso));
        assert_eq!(en_outbox(&db).await, antes, "lo negado no sube a la nube");
    }

    /// La condición viaja con la sentencia. Aquí se borra lo que está en la papelera; si en la nube
    /// una Handy la restauró antes de que llegue el borrado, al aplicarlo allí no se la lleva.
    #[tokio::test]
    async fn la_condicion_se_cumple_tambien_al_aplicarse_en_la_nube() {
        let (db, repo) = abrir().await;
        let aviso = aviso_al_admin(&repo).await;
        assert!(uc::descartar(&repo, ADMIN, id(&aviso)).await.unwrap());
        assert!(uc::eliminar(&repo, ADMIN, id(&aviso)).await.unwrap());
        let sube = ultima_operacion(&db).await;
        assert_eq!(sube.len(), 1, "{:?}", sube.iter().map(|s| &s.sql).collect::<Vec<_>>());
        assert!(sube[0].sql.starts_with("DELETE FROM Notificaciones"), "{}", sube[0].sql);

        // Dos nubes: en una sigue en la papelera; en la otra, una Handy la ha restaurado.
        for (estado, queda) in [("descartada", 0), ("activa", 1)] {
            let nube = base("notif_nube").await;
            {
                let w = nube.write().await;
                w.raw()
                    .execute(
                        "INSERT INTO Notificaciones (ID_Notificacion, Tipo, Severidad, Titulo, \
                         Destino_Tipo, Destino_Valor, Estado, Creada_En) \
                         VALUES (?1, 'reserva_web_fallida', 'aviso', 'Reserva web sin confirmar', \
                                 'rol', ?2, ?3, '2026-11-11 10:00:00');",
                        vec![
                            Value::Text(aviso.clone()),
                            Value::Text(ADMIN_ROL_ID.into()),
                            Value::Text(estado.into()),
                        ],
                    )
                    .await
                    .unwrap();
                for st in &sube {
                    let args: Vec<Value> = st
                        .args
                        .iter()
                        .map(|a| match a {
                            serde_json::Value::String(s) => Value::Text(s.clone()),
                            serde_json::Value::Null => Value::Null,
                            otro => panic!("argumento inesperado: {otro}"),
                        })
                        .collect();
                    w.raw().execute(&st.sql, args).await.unwrap();
                }
            }
            assert_eq!(
                contar(&nube, "SELECT COUNT(*) FROM Notificaciones;").await,
                queda,
                "en la nube estaba {estado}"
            );
        }
    }
}
