//! Casos de uso de **sincronización nube → Main**. Orquestación fina sobre `SyncRepository`.

use serde_json::json;

use tpv_contracts::sync::{
    AplicacionSync, ApplySyncChangesArgs, BackfillEstado, BootstrapResultado, BootstrapSnapshot,
    HistoricoPagina, OutboxEntry, OutboxFallo, ResultadoVerificacion, SyncHealth,
    VerificacionClaves, VerificacionNube,
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

/// SYNC-20: la nube rechazó una operación del outbox. Devuelve si se aparta (y el drenado debe
/// seguir con la siguiente) o si se sigue reintentando.
///
/// Un `op_id` vacío no se acepta: sin él no hay fila que anotar y el contador de intentos nunca
/// subiría, así que la operación se reintentaría eternamente — justo el atasco que esto arregla,
/// pero con la cuarentena puesta y sin funcionar.
pub async fn outbox_mark_failed(
    repo: &dyn SyncRepository,
    op_id: &str,
    error: &str,
    permanente: bool,
) -> AppResult<OutboxFallo> {
    if op_id.trim().is_empty() {
        return Err(AppError::Validation("op_id vacío".into()));
    }
    repo.outbox_mark_failed(op_id, error, permanente).await
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

/* ===== SYNC-19 · fase 2: el histórico, en segundo plano ===== */

/// Filas por página. El servidor tiene su propio techo (más bajo manda); esto es lo que se pide.
pub const BACKFILL_FILAS_POR_PAGINA: i64 = 1_000;

/// Páginas por vencimiento del job. Con el intervalo del job son ~10.000 filas cada cinco minutos:
/// un histórico de tres meses converge en unas horas sin que nadie lo note ni en el equipo ni en la
/// factura de Turso.
///
/// **No es el bucle entero a propósito.** El motor de jobs tiene que conservar el control: un
/// backfill que se lleva el equipo por delante durante media hora lo hace en hora punta, y eso es
/// peor que tardar.
pub const BACKFILL_PAGINAS_POR_TICK: usize = 10;

/// Progreso del backfill del histórico.
pub async fn backfill_estado(repo: &dyn SyncRepository) -> AppResult<BackfillEstado> {
    repo.backfill_estado().await
}

/// Un vencimiento del job: trae unas cuantas páginas del histórico y las aplica.
///
/// Idempotente, como exige el motor: repetir una página no cambia nada (`INSERT OR IGNORE` en la
/// persistencia) y el cursor sólo avanza cuando la página entra de verdad.
///
/// Devuelve cuántas filas se procesaron. Cero significa que no queda backfill pendiente, que es el
/// caso normal de un equipo que nunca ha perdido su base: una lectura y se acabó.
pub async fn backfill_paso(
    nube: &dyn PairingService,
    repo: &dyn SyncRepository,
) -> AppResult<i64> {
    let mut total = 0i64;

    for _ in 0..BACKFILL_PAGINAS_POR_TICK {
        let Some((tabla, cursor)) = repo.backfill_siguiente().await? else {
            break;
        };

        let raw = match nube
            .tpv_server_post_json(
                "tpv",
                "/v1/sync/historico",
                json!({ "tabla": tabla, "cursor": cursor, "limite": BACKFILL_FILAS_POR_PAGINA }),
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                // Se anota en la tabla (para que salga en el panel) y se propaga, que es lo que
                // activa el backoff del motor. Tragarse el error dejaría un backfill parado en
                // silencio, y su síntoma —un histórico que nunca termina de llegar— no se distingue
                // de "todavía va".
                let _ = repo.backfill_marcar_error(&tabla, &e.to_string()).await;
                return Err(e);
            }
        };

        let pagina: HistoricoPagina = serde_json::from_value(raw).map_err(|e| {
            AppError::external(format!("página de histórico ilegible ({tabla}): {e}"))
        })?;

        // Un worker antiguo (sin `/historico`) no puede llegar aquí: respondería 404 y el error de
        // arriba se lo habría llevado. Lo que sí puede pasar es que conteste otra tabla; aplicarla
        // avanzaría el cursor de una que no se ha pedido.
        if pagina.tabla != tabla {
            return Err(AppError::external(format!(
                "el servidor contestó con la tabla {} para una petición de {tabla}",
                pagina.tabla
            )));
        }

        total += repo.backfill_aplicar_pagina(pagina).await?;
    }

    Ok(total)
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

/// SYNC-24: contrasta la nube contra esta base, repara lo que se pueda y **se chiva solo**.
///
/// Los tres pasos van juntos a propósito. Separar "comprobar" de "contar lo que se ha encontrado"
/// deja la puerta abierta a que alguien llame a lo primero sin lo segundo, y entonces el descuadre
/// vuelve a existir sin que nadie lo sepa — que es exactamente el estado del que se viene.
///
/// El informe va al worker y de ahí a Axiom, **no al usuario**: un `op_id` y un error de SQL no los
/// puede atender quien está delante del TPV, y un aviso que no se puede atender enseña a ignorar
/// los avisos. Quien está delante sólo ve la consecuencia, en Conectividad.
///
/// Se informa SIEMPRE, también cuando todo cuadra: un silencio no distingue "va bien" de "este
/// equipo lleva tres semanas sin comprobarse". Lo que se vigila es la serie, no el evento suelto.
pub async fn verificar_contra_la_nube(
    nube: &dyn PairingService,
    repo: &dyn SyncRepository,
) -> AppResult<ResultadoVerificacion> {
    let bruto = nube
        .tpv_server_post_json("tpv", "/v1/sync/verificar", json!({}))
        .await?;
    let foto: VerificacionNube = serde_json::from_value(bruto).map_err(|e| {
        AppError::Internal(format!("respuesta de /v1/sync/verificar ilegible: {e}"))
    })?;

    // Se guarda ANTES de ceder la foto: es lo que decide si se puede borrar arriba.
    let hasta_seq = foto.hasta_seq;
    let mut resultado = repo.contrastar_con_la_nube(foto).await?;

    // SYNC-25 · segunda fase, y **sólo si hace falta**: un contador que no cuadra dice que algo
    // baila, no qué. Las claves lo dicen exactamente, pero pesan, así que se piden únicamente de
    // las tablas que ya se sabe que están mal. El caso normal —todo cuadra— no paga nada de esto.
    if !resultado.tablas_a_examinar.is_empty() {
        let bruto = nube
            .tpv_server_post_json(
                "tpv",
                "/v1/sync/verificar-claves",
                json!({ "tablas": resultado.tablas_a_examinar }),
            )
            .await?;
        let claves: VerificacionClaves = serde_json::from_value(bruto).map_err(|e| {
            AppError::Internal(format!("respuesta de /v1/sync/verificar-claves ilegible: {e}"))
        })?;

        let (mas_descuadres, reparadas, borradas, aplazado) =
            repo.contrastar_claves(claves, hasta_seq).await?;

        // La segunda fase sabe CUÁLES, así que su cuenta manda sobre la estimación por contadores
        // de la primera. Dejar las dos sumaría el mismo descuadre dos veces.
        for d in mas_descuadres {
            match resultado.descuadres.iter_mut().find(|x| x.tabla == d.tabla) {
                Some(x) => {
                    x.faltan = d.faltan;
                    x.sobran = d.sobran;
                }
                None => resultado.descuadres.push(d),
            }
        }
        resultado.reparadas += reparadas;
        resultado.borradas = borradas;
        resultado.borrado_aplazado = aplazado;
    }

    let informe = json!({
        "descuadres": resultado.descuadres,
        "apartadas": resultado.descuadres.iter().map(|d| d.sobran).sum::<i64>(),
        "reparadas": resultado.reparadas,
        "borradas": resultado.borradas,
        "borrado_aplazado": resultado.borrado_aplazado,
        "ventana_omitida": resultado.ventana_omitida,
    });
    // Best-effort, y el error se descarta A SABIENDAS. Dos razones: que el informe no salga no
    // puede deshacer la reparación que ya está encolada, y sobre todo que no se pierde información
    // — un descuadre no se arregla solo por no haberlo contado, así que la pasada siguiente vuelve
    // a encontrarlo y a informarlo. Lo que se vigila en Axiom es la serie, no el evento suelto.
    let _ = nube
        .tpv_server_post_json("tpv", "/v1/sync/salud", informe)
        .await;

    Ok(resultado)
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
        async fn outbox_mark_failed(&self, _: &str, _: &str, _: bool) -> AppResult<OutboxFallo> {
            Ok(OutboxFallo::default())
        }
        async fn contrastar_con_la_nube(
            &self,
            _: VerificacionNube,
        ) -> AppResult<ResultadoVerificacion> {
            Ok(ResultadoVerificacion::default())
        }
        async fn contrastar_claves(
            &self,
            _: VerificacionClaves,
            _: i64,
        ) -> AppResult<(Vec<tpv_contracts::sync::DescuadreTabla>, i64, i64, bool)> {
            Ok((Vec::new(), 0, 0, false))
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
        async fn backfill_siguiente(&self) -> AppResult<Option<(String, i64)>> {
            Ok(None)
        }
        async fn backfill_aplicar_pagina(&self, _: HistoricoPagina) -> AppResult<i64> {
            panic!("no usado")
        }
        async fn backfill_marcar_error(&self, _: &str, _: &str) -> AppResult<()> {
            Ok(())
        }
        async fn backfill_estado(&self) -> AppResult<BackfillEstado> {
            panic!("no usado")
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
