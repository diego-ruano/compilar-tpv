//! Adaptador SQLite del puerto `VerificacionNubeRepository` (VERIF-02): lo que el contraste con la
//! nube recuerda de sus pasadas y lo que la base dice del momento.
//!
//! `_Verificacion_Nube` es estado **local del equipo**, como `_Jobs_State`: cuándo se contrastó
//! esta base por última vez no le dice nada a otro equipo. Por eso se escribe por la conexión
//! CRUDA (`WriteGuard::raw()`): por `execute()` cada pasada subiría a la nube.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::TimeZone;

use tpv_application::error::AppResult;
use tpv_application::ports::verificacion_nube::{
    IntentoVerificacion, SituacionVerificacion, VerificacionNubeRepository,
};

use crate::consultas::db_err;
use crate::db::{Db, Reader};
use crate::ejecutor::Value;
use crate::mapping::{v_i64, v_string};

pub struct SqliteVerificacionNube {
    db: Arc<Db>,
}

impl SqliteVerificacionNube {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

/// La primera columna de la primera fila, si la hay y no es `NULL`.
async fn un_valor<C: Reader>(conn: &C, sql: &str) -> AppResult<Option<Value>> {
    let mut filas = conn.query(sql, ()).await.map_err(db_err)?;
    Ok(match filas.next().await.map_err(db_err)? {
        Some(fila) => match fila.get_value(0).map_err(db_err)? {
            Value::Null => None,
            v => Some(v),
        },
        None => None,
    })
}

async fn un_entero<C: Reader>(conn: &C, sql: &str) -> AppResult<Option<i64>> {
    Ok(un_valor(conn, sql).await?.and_then(v_i64))
}

/// Una hora local de la base (`YYYY-MM-DD HH:MM:SS`, la del equipo: RELOJ-01) en milisegundos de
/// época. `None` si no es una hora, o si cae en la hora que no existe de un cambio de horario.
fn hora_local_a_ms(texto: &str) -> Option<i64> {
    let hora = chrono::NaiveDateTime::parse_from_str(texto.trim(), "%Y-%m-%d %H:%M:%S").ok()?;
    chrono::Local.from_local_datetime(&hora).earliest().map(|h| h.timestamp_millis())
}

#[async_trait]
impl VerificacionNubeRepository for SqliteVerificacionNube {
    async fn situacion(&self) -> AppResult<SituacionVerificacion> {
        let r = self.db.read().await;

        let (ultima_ok_ms, ultimo_intento_ms, fallos) = {
            let mut filas = r
                .query(
                    "SELECT Ultima_Ok_Ms, Ultimo_Intento_Ms, Fallos FROM _Verificacion_Nube WHERE Id = 1;",
                    (),
                )
                .await
                .map_err(db_err)?;
            match filas.next().await.map_err(db_err)? {
                Some(f) => (
                    v_i64(f.get_value(0).map_err(db_err)?),
                    v_i64(f.get_value(1).map_err(db_err)?),
                    v_i64(f.get_value(2).map_err(db_err)?).unwrap_or(0),
                ),
                None => (None, None, 0),
            }
        };

        // El último cierre que sigue en pie. Uno reabierto no cuenta: la caja vuelve a estar
        // abierta y el servicio sigue.
        let ultimo_cierre_ms = un_valor(
            &r,
            "SELECT Fecha_Hora FROM Cierres_Caja WHERE Reabierto_En IS NULL \
             ORDER BY Fecha_Hora DESC LIMIT 1;",
        )
        .await?
        .and_then(v_string)
        .and_then(|texto| hora_local_a_ms(&texto));

        let historico_pendiente =
            un_entero(&r, "SELECT COUNT(*) FROM _Backfill_Historico WHERE Completada = 0;")
                .await?
                .unwrap_or(0)
                > 0;

        // Lo apartado no cuenta: no va a subir solo, y repararlo es cosa del contraste.
        let outbox_pendiente =
            un_entero(&r, "SELECT COUNT(*) FROM _Sync_Outbox WHERE Cuarentena = 0;")
                .await?
                .unwrap_or(0);

        // Un cambio en cuarentena tampoco: no se resuelve esperando, y con él la pasada sólo
        // compara e informa (`hay_fallos_de_bajada`).
        let bajada_detenida =
            un_entero(&r, "SELECT COUNT(*) FROM _Sync_Failed WHERE Quarantined = 0;")
                .await?
                .unwrap_or(0)
                > 0;

        // Cada operación de aquí y cada cambio aplicado de la nube deja su fila en
        // `_Sync_Applied_Ops` con la hora a la que entró: la más reciente es la última escritura.
        let ultima_escritura_ms =
            un_entero(&r, "SELECT MAX(Applied_At_Ms) FROM _Sync_Applied_Ops;").await?;

        Ok(SituacionVerificacion {
            ultima_ok_ms,
            ultimo_intento_ms,
            fallos,
            ultimo_cierre_ms,
            historico_pendiente,
            outbox_pendiente,
            bajada_detenida,
            ultima_escritura_ms,
        })
    }

    async fn anotar(&self, intento: IntentoVerificacion, ahora_ms: i64) -> AppResult<()> {
        // Un upsert por si la fila no está (una base de antes de la tabla, restaurada de una copia).
        let sql = match intento {
            IntentoVerificacion::Hecha => {
                "INSERT INTO _Verificacion_Nube (Id, Ultima_Ok_Ms, Ultimo_Intento_Ms, Fallos) \
                 VALUES (1, ?1, ?1, 0) \
                 ON CONFLICT(Id) DO UPDATE SET \
                   Ultima_Ok_Ms = excluded.Ultima_Ok_Ms, \
                   Ultimo_Intento_Ms = excluded.Ultimo_Intento_Ms, \
                   Fallos = 0;"
            }
            IntentoVerificacion::Aplazada => {
                "INSERT INTO _Verificacion_Nube (Id, Ultima_Ok_Ms, Ultimo_Intento_Ms, Fallos) \
                 VALUES (1, NULL, ?1, 0) \
                 ON CONFLICT(Id) DO UPDATE SET \
                   Ultimo_Intento_Ms = excluded.Ultimo_Intento_Ms, \
                   Fallos = 0;"
            }
            IntentoVerificacion::Fallida => {
                "INSERT INTO _Verificacion_Nube (Id, Ultima_Ok_Ms, Ultimo_Intento_Ms, Fallos) \
                 VALUES (1, NULL, ?1, 1) \
                 ON CONFLICT(Id) DO UPDATE SET \
                   Ultimo_Intento_Ms = excluded.Ultimo_Intento_Ms, \
                   Fallos = Fallos + 1;"
            }
        };
        let w = self.db.write().await;
        w.raw().execute(sql, vec![Value::Integer(ahora_ms)]).await.map_err(db_err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn repo_temporal() -> (SqliteVerificacionNube, Arc<Db>, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("verificacion-nube");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        (SqliteVerificacionNube::new(db.clone()), db, dir)
    }

    async fn sembrar(db: &Arc<Db>, sql: &str) {
        let w = db.write().await;
        w.raw().execute_batch(sql).await.unwrap();
    }

    /// La hora local que la base guardaría para ese instante.
    fn hora_local(ms: i64) -> String {
        chrono::Local.timestamp_millis_opt(ms).unwrap().format("%Y-%m-%d %H:%M:%S").to_string()
    }

    /// Un mediodía de invierno: lejos de un cambio de horario en cualquier zona.
    const MEDIODIA_MS: i64 = 1_768_478_400_000;

    #[tokio::test]
    async fn una_base_recien_abierta_no_tiene_nada_que_contar() {
        let (repo, _db, _dir) = repo_temporal().await;
        assert_eq!(repo.situacion().await.unwrap(), SituacionVerificacion::default());
    }

    #[tokio::test]
    async fn cada_intento_deja_su_marca() {
        let (repo, _db, _dir) = repo_temporal().await;

        // Dos fallos seguidos: suben la cuenta y no tocan la última pasada buena.
        repo.anotar(IntentoVerificacion::Fallida, 1_000).await.unwrap();
        repo.anotar(IntentoVerificacion::Fallida, 2_000).await.unwrap();
        let s = repo.situacion().await.unwrap();
        assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (None, Some(2_000), 2));

        // La nube contesta pero no se llega a comparar: la cuenta de fallos se queda a cero.
        repo.anotar(IntentoVerificacion::Aplazada, 3_000).await.unwrap();
        let s = repo.situacion().await.unwrap();
        assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (None, Some(3_000), 0));

        // Una pasada buena.
        repo.anotar(IntentoVerificacion::Hecha, 4_000).await.unwrap();
        let s = repo.situacion().await.unwrap();
        assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (Some(4_000), Some(4_000), 0));

        // Y un fallo después no la borra.
        repo.anotar(IntentoVerificacion::Fallida, 5_000).await.unwrap();
        let s = repo.situacion().await.unwrap();
        assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (Some(4_000), Some(5_000), 1));
    }

    #[tokio::test]
    async fn anotar_no_sube_nada_a_la_nube() {
        // Estado local: por `raw()`. Por `execute()` cada pasada dejaría una operación en el outbox.
        let (repo, db, _dir) = repo_temporal().await;
        repo.anotar(IntentoVerificacion::Hecha, 1_000).await.unwrap();
        repo.anotar(IntentoVerificacion::Fallida, 2_000).await.unwrap();
        let r = db.read().await;
        assert_eq!(un_entero(&r, "SELECT COUNT(*) FROM _Sync_Outbox;").await.unwrap(), Some(0));
    }

    #[tokio::test]
    async fn anotar_funciona_aunque_falte_la_fila() {
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(&db, "DELETE FROM _Verificacion_Nube;").await;
        repo.anotar(IntentoVerificacion::Fallida, 7_000).await.unwrap();
        let s = repo.situacion().await.unwrap();
        assert_eq!((s.ultima_ok_ms, s.ultimo_intento_ms, s.fallos), (None, Some(7_000), 1));
    }

    #[tokio::test]
    async fn el_ultimo_cierre_es_el_que_sigue_en_pie() {
        let (repo, db, _dir) = repo_temporal().await;
        let ayer = MEDIODIA_MS - 24 * 3_600_000;
        let hoy = MEDIODIA_MS;
        sembrar(
            &db,
            &format!(
                "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde) VALUES ('c-ayer', '{}', NULL);
                 INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde, Reabierto_En)
                   VALUES ('c-hoy', '{}', '{}', '{}');",
                hora_local(ayer),
                hora_local(hoy),
                hora_local(ayer),
                hora_local(hoy + 60_000),
            ),
        )
        .await;

        // El de hoy está reabierto: el que cuenta es el de ayer.
        assert_eq!(repo.situacion().await.unwrap().ultimo_cierre_ms, Some(ayer));

        // Vuelto a cerrar, cuenta el nuevo.
        sembrar(
            &db,
            &format!(
                "INSERT INTO Cierres_Caja (ID_Cierre, Fecha_Hora, Periodo_Desde) VALUES ('c-hoy-2', '{}', '{}');",
                hora_local(hoy + 120_000),
                hora_local(ayer),
            ),
        )
        .await;
        assert_eq!(repo.situacion().await.unwrap().ultimo_cierre_ms, Some(hoy + 120_000));
    }

    #[tokio::test]
    async fn lo_pendiente_de_subir_y_de_bajar_no_cuenta_lo_apartado() {
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms, Cuarentena)
               VALUES ('op-apartada', 'main_op', '[]', 1, 1);
             INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
               First_Failed_At_Ms, Last_Failed_At_Ms) VALUES ('op-cuarentena', 5, '[]', 5, 1, 1, 1);",
        )
        .await;
        let s = repo.situacion().await.unwrap();
        assert_eq!((s.outbox_pendiente, s.bajada_detenida), (0, false));

        sembrar(
            &db,
            "INSERT INTO _Sync_Outbox (Op_Id, Command_Name, Statements_Json, Created_At_Ms)
               VALUES ('op-pendiente', 'main_op', '[]', 2);
             INSERT INTO _Sync_Failed (Op_Id, Seq, Statements_Json, Attempts, Quarantined,
               First_Failed_At_Ms, Last_Failed_At_Ms) VALUES ('op-detenida', 6, '[]', 1, 0, 1, 1);",
        )
        .await;
        let s = repo.situacion().await.unwrap();
        assert_eq!((s.outbox_pendiente, s.bajada_detenida), (1, true));
    }

    #[tokio::test]
    async fn el_historico_a_medias_y_la_ultima_escritura() {
        let (repo, db, _dir) = repo_temporal().await;
        sembrar(
            &db,
            "INSERT INTO _Backfill_Historico (Tabla, Orden, Completada) VALUES ('Comandas', 0, 1), ('Pagos', 1, 0);
             INSERT INTO _Sync_Applied_Ops (Op_Id, Seq, Applied_At_Ms) VALUES ('a', 0, 500), ('b', 7, 900), ('c', 0, 700);",
        )
        .await;
        let s = repo.situacion().await.unwrap();
        assert!(s.historico_pendiente);
        assert_eq!(s.ultima_escritura_ms, Some(900));

        sembrar(&db, "UPDATE _Backfill_Historico SET Completada = 1;").await;
        assert!(!repo.situacion().await.unwrap().historico_pendiente);
    }

    #[tokio::test]
    async fn una_escritura_de_negocio_cuenta_como_ultima_escritura() {
        // Lo que de verdad pasa: `WriteGuard::execute` deja el anti-eco de la operación con su hora.
        use crate::db::Writer;
        let (repo, db, _dir) = repo_temporal().await;
        let antes = crate::util::now_ms();
        {
            let w = db.write().await;
            w.execute("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salón');", ()).await.unwrap();
        }
        let escritura = repo.situacion().await.unwrap().ultima_escritura_ms.expect("hay una escritura");
        assert!(escritura >= antes && escritura <= crate::util::now_ms());
    }

    #[test]
    fn una_hora_que_no_lo_es_no_cuenta() {
        assert_eq!(hora_local_a_ms(""), None);
        assert_eq!(hora_local_a_ms("ayer"), None);
        assert_eq!(hora_local_a_ms(&hora_local(MEDIODIA_MS)), Some(MEDIODIA_MS));
    }
}
