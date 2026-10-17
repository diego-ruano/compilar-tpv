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

    async fn fijar_activa(&self, activa: bool) -> AppResult<()> {
        let g = self.db.write().await;
        g.execute(
            "UPDATE Business_Settings SET Reserva_Web_Activa = ?1 WHERE ID = 1;",
            vec![Value::Integer(i64::from(activa))],
        )
        .await
        .map_err(db_err)?;
        Ok(())
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
            // Un día ya cerrado conserva su id: sólo cambia el motivo.
            g.execute(
                "INSERT INTO Reserva_Web_Cierres (ID_Cierre, Dia_YMD, Motivo) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(Dia_YMD) DO UPDATE SET Motivo = excluded.Motivo;",
                vec![
                    Value::Text(new_id()),
                    Value::Text(cierre.dia_ymd.clone()),
                    opt_text(cierre.motivo.clone()),
                ],
            )
            .await
            .map_err(db_err)?;
            let mut rows = g
                .query(
                    "SELECT ID_Cierre FROM Reserva_Web_Cierres WHERE Dia_YMD = ?1;",
                    vec![Value::Text(cierre.dia_ymd.clone())],
                )
                .await
                .map_err(db_err)?;
            let row = rows
                .next()
                .await
                .map_err(db_err)?
                .ok_or_else(|| AppError::internal("El día cerrado no ha quedado guardado"))?;
            Ok(v_string(row.get_value(0).map_err(db_err)?).unwrap_or_default())
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

        repo.fijar_activa(true).await.unwrap();

        assert!(repo.activa().await.unwrap());
        assert_eq!(outbox(&db).await, antes + 1);
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
