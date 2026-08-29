//! Casos de uso de **sincronización nube → Main**. Orquestación fina sobre `SyncRepository`.

use serde_json::json;

use tpv_contracts::sync::{
    AplicacionSync, ApplySyncChangesArgs, BootstrapResultado, BootstrapSnapshot, OutboxEntry,
    SyncHealth,
};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::PairingService;
use crate::ports::sync::SyncRepository;

/// Aplica un lote de cambios recibidos de la nube. Si viene vacío, solo devuelve el checkpoint.
pub async fn apply_changes(
    repo: &dyn SyncRepository,
    args: ApplySyncChangesArgs,
) -> AppResult<AplicacionSync> {
    if args.changes.is_empty() {
        return Ok(AplicacionSync {
            aplicadas: Vec::new(),
            last_seq: repo.get_checkpoint().await?,
        });
    }
    repo.apply_changes(args.changes).await
}

/// Último `seq` aplicado localmente (cursor del catch-up).
pub async fn get_checkpoint(repo: &dyn SyncRepository) -> AppResult<i64> {
    repo.get_checkpoint().await
}

/// Operaciones pendientes de subir a la nube (outbox), en orden.
pub async fn outbox_pending(repo: &dyn SyncRepository, limit: i64) -> AppResult<Vec<OutboxEntry>> {
    let limit = if limit <= 0 { 50 } else { limit.min(500) };
    repo.outbox_pending(limit).await
}

/// Marca una operación del outbox como enviada tras el `apply_ack` de la nube. `seq` es el cursor
/// que la nube le asignó (0 si no lo pudo devolver); se usa para ascender el anti-eco a su Seq real.
pub async fn outbox_mark_sent(repo: &dyn SyncRepository, op_id: &str, seq: i64) -> AppResult<()> {
    repo.outbox_mark_sent(op_id, seq).await
}

/// Purga de mantenimiento de `_Sync_Applied_Ops` (solo lo ya subido a la nube). Se invoca cuando el
/// outbox queda vacío tras drenar.
/// SYNC-18: la nube aceptó estas operaciones en su cola (ver el puerto).
pub async fn outbox_mark_encolada(repo: &dyn SyncRepository, op_ids: &[String]) -> AppResult<()> {
    repo.outbox_mark_encolada(op_ids).await
}

/// SYNC-18: devuelve al outbox lo que lleva demasiado tiempo encolado sin confirmar.
pub async fn liberar_encoladas_caducadas(
    repo: &dyn SyncRepository,
    antiguedad_ms: i64,
) -> AppResult<i64> {
    repo.liberar_encoladas_caducadas(antiguedad_ms).await
}

pub async fn purge_applied_ops(repo: &dyn SyncRepository) -> AppResult<()> {
    repo.purge_applied_ops().await
}

/// Foto de salud de la sincronización local (SYNC-14) para el panel de Conectividad.
pub async fn health(repo: &dyn SyncRepository) -> AppResult<SyncHealth> {
    repo.health().await
}

/// Reconstruye la BD local desde la nube (`/v1/sync/bootstrap`) y deja el checkpoint en el `seq`
/// de la foto. Es la salida cuando la Main ha perdido su `data.db`: el catch-up no sirve para eso
/// (ver el puerto `bootstrap_restaurar`).
///
/// La guardia que impide restaurar sobre escrituras locales sin subir vive en el adaptador, dentro
/// de la misma transacción que borra: comprobarla aquí dejaría una ventana entre el permiso y el
/// borrado por la que puede colarse una venta.
pub async fn bootstrap_desde_nube(
    nube: &dyn PairingService,
    repo: &dyn SyncRepository,
) -> AppResult<BootstrapResultado> {
    let raw = nube
        .tpv_server_post_json("tpv", "/v1/sync/bootstrap", json!({}))
        .await?;

    let snapshot: BootstrapSnapshot = serde_json::from_value(raw)
        .map_err(|e| AppError::external(format!("respuesta de bootstrap ilegible: {e}")))?;

    repo.bootstrap_restaurar(snapshot).await
}

/// Crea una base vacía en la nube y la descarga. El endpoint del servidor sólo acepta la petición
/// cuando el tenant NO tiene ya una base aprovisionada; por eso esta operación nunca es fallback
/// automático de un error de red ni puede sobrescribir una nube existente.
pub async fn inicializar_tenant_vacio(
    nube: &dyn PairingService,
    repo: &dyn SyncRepository,
) -> AppResult<BootstrapResultado> {
    nube.tpv_server_post_json("tpv", "/v1/sync/initialize-empty", json!({}))
        .await?;
    bootstrap_desde_nube(nube, repo).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRepo {
        limits: Mutex<Vec<i64>>,
        checkpoints: Mutex<usize>,
    }
    #[async_trait]
    impl SyncRepository for FakeRepo {
        async fn apply_changes(
            &self,
            changes: Vec<tpv_contracts::sync::SyncChange>,
        ) -> AppResult<AplicacionSync> {
            Ok(AplicacionSync {
                aplicadas: changes.into_iter().map(|c| c.op_id).collect(),
                last_seq: 99,
            })
        }
        async fn get_checkpoint(&self) -> AppResult<i64> {
            *self.checkpoints.lock().unwrap() += 1;
            Ok(42)
        }
        async fn outbox_pending(&self, limit: i64) -> AppResult<Vec<OutboxEntry>> {
            self.limits.lock().unwrap().push(limit);
            Ok(vec![])
        }
        async fn outbox_mark_sent(&self, _: &str, _: i64) -> AppResult<()> {
            Ok(())
        }
        async fn outbox_mark_encolada(&self, _: &[String]) -> AppResult<()> {
            Ok(())
        }
        async fn liberar_encoladas_caducadas(&self, _: i64) -> AppResult<i64> {
            Ok(0)
        }
        async fn purge_applied_ops(&self) -> AppResult<()> {
            Ok(())
        }
        async fn health(&self) -> AppResult<SyncHealth> {
            panic!("no usado")
        }
        async fn bootstrap_restaurar(
            &self,
            _: tpv_contracts::sync::BootstrapSnapshot,
        ) -> AppResult<tpv_contracts::sync::BootstrapResultado> {
            panic!("no se debe llegar a restaurar en estas pruebas")
        }
    }

    #[tokio::test]
    async fn lote_vacio_devuelve_checkpoint_sin_aplicar() {
        let repo = FakeRepo::default();
        let r = apply_changes(&repo, ApplySyncChangesArgs { changes: vec![] })
            .await
            .unwrap();
        assert_eq!(r.last_seq, 42);
        assert!(r.aplicadas.is_empty(), "un lote vacío no aplica nada");
        assert_eq!(*repo.checkpoints.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn limite_outbox_se_acota_y_usa_default() {
        let repo = FakeRepo::default();
        outbox_pending(&repo, 0).await.unwrap();
        outbox_pending(&repo, 900).await.unwrap();
        assert_eq!(*repo.limits.lock().unwrap(), vec![50, 500]);
    }

    #[tokio::test]
    async fn lote_no_vacio_se_delega_y_devuelve_checkpoint_nuevo() {
        let repo = FakeRepo::default();
        let change = tpv_contracts::sync::SyncChange {
            op_id: "op-1".into(),
            seq: 99,
            statements: vec![tpv_contracts::sync::SqlStatement {
                sql: "UPDATE Configuracion SET Valor=?1".into(),
                args: vec![serde_json::json!("nuevo")],
            }],
        };
        let r = apply_changes(
            &repo,
            ApplySyncChangesArgs {
                changes: vec![change],
            },
        )
        .await
        .unwrap();
        assert_eq!(r.last_seq, 99);
        assert_eq!(r.aplicadas, vec!["op-1".to_string()]);
        assert_eq!(*repo.checkpoints.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn cualquier_limite_no_positivo_usa_cincuenta() {
        let repo = FakeRepo::default();
        outbox_pending(&repo, -100).await.unwrap();
        outbox_pending(&repo, i64::MIN).await.unwrap();
        assert_eq!(*repo.limits.lock().unwrap(), vec![50, 50]);
    }
}
