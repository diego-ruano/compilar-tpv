//! Persistencia de la reserva desde la web en la Main (docs/estudios/reservas-web.md).
//!
//! Todo lo que se escribe aquí es negocio replicable: va por `WriteGuard::execute`, que lo captura
//! en el outbox, porque la agenda web de la nube lo lee de su copia de la base.

use std::sync::Arc;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::reservas_web::ReservasWebRepository;

use crate::consultas::db_err;
use crate::db::{Db, Reader, Writer};
use crate::ejecutor::Value;
use crate::mapping::v_string;

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
}
