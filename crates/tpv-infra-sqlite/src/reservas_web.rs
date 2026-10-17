//! Persistencia de la reserva desde la web en la Main (docs/estudios/reservas-web.md).
//!
//! Todo lo que se escribe aquí es negocio replicable: va por `WriteGuard::execute`, que lo captura
//! en el outbox, porque la agenda web de la nube lo lee de su copia de la base.

use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reservas_web::ReservasWebRepository;
use tpv_contracts::reservas_web::CierreReservaWebDto;
use tpv_domain::reservas_web::CierreValidado;

use crate::consultas::db_err;
use crate::db::{Db, Reader, Writer};
use crate::ejecutor::Value;
use crate::mapping::{opt_text, v_i64, v_string};
use crate::util::new_id;

pub struct SqliteReservasWebRepository {
    db: Arc<Db>,
}

impl SqliteReservasWebRepository {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }
}

#[async_trait]
impl ReservasWebRepository for SqliteReservasWebRepository {
    async fn zona_horaria(&self) -> AppResult<String> {
        let g = self.db.read().await;
        let mut rows = g
            .query("SELECT Zona_Horaria FROM Business_Settings WHERE ID = 1;", ())
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Business_Settings (ID=1)"))?;
        Ok(v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default())
    }

    async fn fijar_zona_horaria(&self, zona: &str) -> AppResult<()> {
        let g = self.db.write().await;
        g.execute(
            "UPDATE Business_Settings SET Zona_Horaria = ?1 WHERE ID = 1;",
            vec![Value::Text(zona.to_string())],
        )
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn activa(&self) -> AppResult<bool> {
        let g = self.db.read().await;
        let mut rows = g
            .query("SELECT Reserva_Web_Activa FROM Business_Settings WHERE ID = 1;", ())
            .await
            .map_err(db_err)?;
        let row = rows
            .next()
            .await
            .map_err(db_err)?
            .ok_or_else(|| AppError::not_found("No existe Business_Settings (ID=1)"))?;
        Ok(v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0) != 0)
    }

    async fn fijar_activa(&self, activa: bool) -> AppResult<bool> {
        // Comparar y escribir bajo el MISMO cerrojo de escritura: con la lectura fuera, dos
        // pulsaciones seguidas podían leer las dos el valor viejo, y la segunda se saltaba su
        // escritura aunque fuera la última elección.
        let g = self.db.write().await;
        let mut rows = g
            .query("SELECT Reserva_Web_Activa FROM Business_Settings WHERE ID = 1;", ())
            .await
            .map_err(db_err)?;
        let ahora = match rows.next().await.map_err(db_err)? {
            Some(row) => v_i64(row.get_value(0).map_err(db_err)?).unwrap_or(0) != 0,
            None => return Err(AppError::not_found("No existe Business_Settings (ID=1)")),
        };
        drop(rows);
        // Sólo se escribe si cambia: cada escritura viaja a la nube.
        if ahora == activa {
            return Ok(false);
        }
        g.execute(
            "UPDATE Business_Settings SET Reserva_Web_Activa = ?1 WHERE ID = 1;",
            vec![Value::Integer(i64::from(activa))],
        )
        .await
        .map_err(db_err)?;
        Ok(true)
    }

    async fn cierres(&self) -> AppResult<Vec<CierreReservaWebDto>> {
        let g = self.db.read().await;
        // Una lectura de la Main: `'now'` es el reloj de este equipo, que es la hora del negocio.
        let mut rows = g
            .query(
                "SELECT ID_Cierre, Dia_YMD, Motivo FROM Reserva_Web_Cierres \
                 WHERE Dia_YMD >= date('now','localtime') ORDER BY Dia_YMD;",
                (),
            )
            .await
            .map_err(db_err)?;
        let mut cierres = Vec::new();
        while let Some(row) = rows.next().await.map_err(db_err)? {
            let g = |i: i32| row.get_value(i).map_err(db_err);
            cierres.push(CierreReservaWebDto {
                id_cierre: v_string(g(0)?).unwrap_or_default(),
                dia_ymd: v_string(g(1)?).unwrap_or_default(),
                motivo: v_string(g(2)?),
            });
        }
        Ok(cierres)
    }

    async fn cerrar_dia(&self, cierre: CierreValidado) -> AppResult<String> {
        let g = self.db.write().await;
        g.transaccion(async {
            // Un día ya cerrado conserva su id, y es ESE id el que lleva la sentencia que se
            // replica. Con uno nuevo en el VALUES y el ON CONFLICT sobre el día, la fila guardaba
            // el viejo pero el outbox el nuevo: si la nube apartaba la operación, la reparación por
            // estado (`sync_reparacion`, que lee la clave del VALUES) buscaba una fila que no existe
            // y no reparaba nada.
            let mut rows = g
                .query(
                    "SELECT ID_Cierre FROM Reserva_Web_Cierres WHERE Dia_YMD = ?1;",
                    vec![Value::Text(cierre.dia_ymd.clone())],
                )
                .await
                .map_err(db_err)?;
            let existente = match rows.next().await.map_err(db_err)? {
                Some(row) => v_string(row.get_value(0).map_err(db_err)?),
                None => None,
            };
            drop(rows);
            let id = existente.unwrap_or_else(new_id);
            g.execute(
                "INSERT INTO Reserva_Web_Cierres (ID_Cierre, Dia_YMD, Motivo) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(ID_Cierre) DO UPDATE SET Dia_YMD = excluded.Dia_YMD, Motivo = excluded.Motivo;",
                vec![
                    Value::Text(id.clone()),
                    Value::Text(cierre.dia_ymd.clone()),
                    opt_text(cierre.motivo.clone()),
                ],
            )
            .await
            .map_err(db_err)?;
            Ok(id)
        })
        .await
    }

    async fn quitar_cierre(&self, id_cierre: &str) -> AppResult<bool> {
        let g = self.db.write().await;
        let borradas = g
            .execute(
                "DELETE FROM Reserva_Web_Cierres WHERE ID_Cierre = ?1;",
                vec![Value::Text(id_cierre.to_string())],
            )
            .await
            .map_err(db_err)?;
        Ok(borradas > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn abrir() -> (Arc<Db>, SqliteReservasWebRepository, std::path::PathBuf) {
        let dir = crate::test_temp::dir_temporal("reservas_web");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("data.db").to_str().unwrap()).await.unwrap();
        let repo = SqliteReservasWebRepository::new(db.clone());
        (db, repo, dir)
    }

    async fn outbox(db: &Db) -> i64 {
        let g = db.read().await;
        let mut rows = g.query("SELECT COUNT(*) FROM _Sync_Outbox;", ()).await.unwrap();
        match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Integer(n) => n,
            otro => panic!("se esperaba un entero: {otro:?}"),
        }
    }

    /// La nube la lee de su copia: cambiarla tiene que viajar por el outbox.
    #[tokio::test]
    async fn la_zona_horaria_nace_peninsular_y_su_cambio_se_replica() {
        let (db, repo, dir) = abrir().await;
        assert_eq!(repo.zona_horaria().await.unwrap(), "Europe/Madrid");
        let antes = outbox(&db).await;

        repo.fijar_zona_horaria("Atlantic/Canary").await.unwrap();

        assert_eq!(repo.zona_horaria().await.unwrap(), "Atlantic/Canary");
        assert_eq!(outbox(&db).await, antes + 1);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn la_reserva_web_nace_apagada_y_encenderla_se_replica() {
        let (db, repo, dir) = abrir().await;
        assert!(!repo.activa().await.unwrap());
        let antes = outbox(&db).await;

        assert!(repo.fijar_activa(true).await.unwrap());

        assert!(repo.activa().await.unwrap());
        assert_eq!(outbox(&db).await, antes + 1);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Lo que ya está no se vuelve a escribir (cada escritura sube a la nube), y la comparación va
    /// bajo el cerrojo de escritura: pulsaciones simultáneas acaban todas aplicadas en orden y la
    /// base dice lo mismo que la última sentencia que ha salido hacia la nube.
    #[tokio::test]
    async fn encender_o_apagar_solo_escribe_si_cambia_y_en_orden() {
        let (db, repo, dir) = abrir().await;
        let antes = outbox(&db).await;
        assert!(!repo.fijar_activa(false).await.unwrap());
        assert_eq!(outbox(&db).await, antes, "ya estaba apagada");

        let repo = Arc::new(repo);
        let mut tareas = Vec::new();
        for i in 0..20 {
            let repo = repo.clone();
            tareas.push(tokio::spawn(async move { repo.fijar_activa(i % 2 == 0).await.unwrap() }));
        }
        for t in tareas {
            t.await.unwrap();
        }

        let g = db.read().await;
        let mut rows = g
            .query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;", ())
            .await
            .unwrap();
        let ultima = match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Text(t) => t,
            otro => panic!("{otro:?}"),
        };
        drop(rows);
        drop(g);
        let en_la_base = repo.activa().await.unwrap();
        let sentencias: Vec<tpv_contracts::sync::SqlStatement> = serde_json::from_str(&ultima).unwrap();
        assert!(sentencias[0].sql.contains("Reserva_Web_Activa"));
        assert_eq!(sentencias[0].args[0], serde_json::json!(i64::from(en_la_base)), "{ultima}");
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn cierre(dia: &str, motivo: Option<&str>) -> CierreValidado {
        CierreValidado { dia_ymd: dia.into(), motivo: motivo.map(str::to_string) }
    }

    /// Cerrar dos veces el mismo día no lo duplica: conserva su id y se queda con el motivo nuevo.
    #[tokio::test]
    async fn cerrar_un_dia_ya_cerrado_solo_cambia_el_motivo() {
        let (_db, repo, dir) = abrir().await;
        let primero = repo.cerrar_dia(cierre("2099-12-24", Some("Nochebuena"))).await.unwrap();
        let segundo = repo.cerrar_dia(cierre("2099-12-24", Some("Cena de empresa"))).await.unwrap();

        assert_eq!(primero, segundo);
        let cierres = repo.cierres().await.unwrap();
        assert_eq!(cierres.len(), 1);
        assert_eq!(cierres[0].motivo.as_deref(), Some("Cena de empresa"));
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// La sentencia que se replica lleva el id de la fila de verdad: es el que usa la reparación
    /// por estado para encontrarla si la nube aparta la operación.
    #[tokio::test]
    async fn recerrar_un_dia_replica_con_su_id_de_siempre() {
        let (db, repo, dir) = abrir().await;
        let id = repo.cerrar_dia(cierre("2099-12-24", None)).await.unwrap();
        repo.cerrar_dia(cierre("2099-12-24", Some("Nochebuena"))).await.unwrap();

        let g = db.read().await;
        let mut rows = g
            .query("SELECT Statements_Json FROM _Sync_Outbox ORDER BY Seq DESC LIMIT 1;", ())
            .await
            .unwrap();
        let ultima = match rows.next().await.unwrap().unwrap().get_value(0).unwrap() {
            Value::Text(t) => t,
            otro => panic!("{otro:?}"),
        };
        assert!(ultima.contains("Nochebuena"));
        assert!(ultima.contains(&id), "la sentencia replicada lleva el id de la fila: {ultima}");
        drop(rows);
        drop(g);
        drop(repo);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn los_dias_cerrados_salen_de_hoy_en_adelante_y_por_fecha() {
        let (_db, repo, dir) = abrir().await;
        repo.cerrar_dia(cierre("2099-12-31", None)).await.unwrap();
        repo.cerrar_dia(cierre("2000-01-01", Some("Ya pasó"))).await.unwrap();
        let navidad = repo.cerrar_dia(cierre("2099-12-25", None)).await.unwrap();

        let dias: Vec<String> = repo.cierres().await.unwrap().into_iter().map(|c| c.dia_ymd).collect();
        assert_eq!(dias, ["2099-12-25", "2099-12-31"]);

        assert!(repo.quitar_cierre(&navidad).await.unwrap());
        assert!(!repo.quitar_cierre(&navidad).await.unwrap(), "ya no estaba cerrado");
        assert_eq!(repo.cierres().await.unwrap().len(), 1);
        drop(repo);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
