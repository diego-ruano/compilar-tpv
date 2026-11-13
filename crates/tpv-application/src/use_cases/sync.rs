//! Casos de uso de **sincronización nube → Main**. Orquestación fina sobre `SyncRepository`.

use serde::de::DeserializeOwned;
use serde_json::json;

use tpv_contracts::sync::{
    AplicacionSync, ApplySyncChangesArgs, BackfillEstado, BootstrapResultado, BootstrapSnapshot,
    HistoricoPagina, OutboxEntry, OutboxFallo, ResultadoVerificacion, SyncHealth,
    VerificacionClaves, VerificacionNube,
};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::PairingService;
use crate::ports::sync::SyncRepository;

/// Pide `ruta` a la nube (modo `tpv`) y lee la respuesta **directamente en su tipo**.
///
/// Es para las rutas que contestan con un volcado: decenas de megas de JSON. Leído primero en un
/// `serde_json::Value` y deserializado después, el volcado estaba dos veces en memoria, y el árbol
/// intermedio pesa varias veces lo que el texto. Aquí va de los bytes al tipo.
///
/// `que` nombra la respuesta en el mensaje si no se puede leer, e `ilegible` dice qué clase de
/// error es (cada ruta conserva la suya).
async fn pedir<T: DeserializeOwned>(
    nube: &dyn PairingService,
    ruta: &str,
    cuerpo: serde_json::Value,
    que: &str,
    ilegible: fn(String) -> AppError,
) -> AppResult<T> {
    let bytes = nube.tpv_server_post_bytes("tpv", ruta, cuerpo).await?;
    leer_respuesta(&bytes, que, ilegible)
}

/// El cuerpo de una respuesta aceptada (2xx), en su tipo.
///
/// Primero se intenta leer como lo que se espera, de una pasada. Sólo si no encaja se mira si es
/// un 200 con `ok:false` (el worker marca así algunos fallos), que sale con el error de la API
/// como en `tpv_server_post_json`.
///
/// AUD-28 — si no se puede leer, el mensaje dice dónde (clase del fallo, línea y columna) y nada
/// del contenido: el texto de serde cita el valor que no encaja, y en un volcado ese valor es un
/// dato del negocio.
fn leer_respuesta<T: DeserializeOwned>(
    bytes: &[u8],
    que: &str,
    ilegible: fn(String) -> AppError,
) -> AppResult<T> {
    match serde_json::from_slice::<T>(bytes) {
        Ok(valor) => Ok(valor),
        Err(e) => {
            #[derive(serde::Deserialize)]
            struct Sobre {
                ok: Option<bool>,
            }
            if let Ok(Sobre { ok: Some(false) }) = serde_json::from_slice::<Sobre>(bytes) {
                return Err(AppError::from_api_body(200, &String::from_utf8_lossy(bytes)));
            }
            Err(ilegible(format!(
                "{que} ilegible ({:?}, línea {}, columna {})",
                e.classify(),
                e.line(),
                e.column()
            )))
        }
    }
}

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
    let r = repo.apply_changes(args.changes).await?;
    Ok(AplicacionSync { aplicadas: r.aplicadas, last_seq: r.last_seq })
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
    // AUD-06: el volcado es del negocio de la licencia, que es el del token con el que se firma la
    // petición (el adaptador no firma en modo `tpv` con el token de otro negocio). Con ése se sella
    // la base. Se vuelve a leer después: si la licencia ha cambiado mientras bajaba, no se sabe de
    // quién es lo que ha llegado y no se instala.
    let negocio = negocio_de_la_licencia(nube)?;
    let snapshot: BootstrapSnapshot = pedir(
        nube,
        "/v1/sync/bootstrap",
        json!({}),
        "respuesta de bootstrap",
        AppError::External,
    )
    .await?;
    if negocio_de_la_licencia(nube)? != negocio {
        return Err(AppError::conflict(
            "La licencia de este equipo ha cambiado mientras se traían los datos. Vuelve a intentarlo.",
        ));
    }

    repo.bootstrap_restaurar(snapshot, &negocio).await
}

fn negocio_de_la_licencia(nube: &dyn PairingService) -> AppResult<String> {
    nube.negocio_de_la_licencia()?
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| {
            AppError::conflict(
                "Este equipo no tiene ninguna licencia activada. Actívala antes de traer los datos de la nube.",
            )
        })
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

        let pagina: HistoricoPagina = match pedir(
            nube,
            "/v1/sync/historico",
            json!({ "tabla": tabla, "cursor": cursor, "limite": BACKFILL_FILAS_POR_PAGINA }),
            &format!("página de histórico ({tabla})"),
            AppError::External,
        )
        .await
        {
            Ok(pagina) => pagina,
            Err(e) => {
                // Se anota en la tabla (para que salga en el panel) y se propaga, que es lo que
                // activa el backoff del motor. Tragarse el error dejaría un backfill parado en
                // silencio, y su síntoma —un histórico que nunca termina de llegar— no se distingue
                // de "todavía va".
                let _ = repo.backfill_marcar_error(&tabla, &e.to_string()).await;
                return Err(e);
            }
        };

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
///
/// `reparar = false` es el interruptor `reparacion_nube` apagado (PROD-06): se compara y se
/// informa igual —es lo que permite ver si el problema sigue ahí—, pero no se escribe nada.
///
/// VERIF-01 · **Con el histórico a medias no se contrasta.** Tras recuperar desde la nube, la
/// fase 2 va trayendo lo que la ventana de la fase 1 dejó fuera; hasta que termina, todo lo que
/// falta por bajar saldría como «la nube tiene filas que aquí no están», y el checkpoint —que es
/// el `Seq` de la foto de la fase 1— dice que esta Main está al día. Con eso se pedían las claves
/// y cada fila pendiente de bajar se convertía en un `DELETE` arriba: los cierres de caja con sus
/// cascadas, los fichajes… borrados de la nube antes de que el backfill los trajera. No se pide
/// nada ni se informa: comparar maestros enteros con transaccionales a medias no dice nada.
pub async fn verificar_contra_la_nube(
    nube: &dyn PairingService,
    repo: &dyn SyncRepository,
    reparar: bool,
) -> AppResult<Contraste> {
    if repo.backfill_estado().await?.tablas_pendientes > 0 {
        return Ok(Contraste::HistoricoPendiente);
    }

    let foto: VerificacionNube = pedir(
        nube,
        "/v1/sync/verificar",
        json!({}),
        "respuesta de /v1/sync/verificar",
        AppError::Internal,
    )
    .await?;

    // VERIF-02 · La foto va por delante de lo que ha bajado esta Main: algo de lo que trae está
    // todavía de camino (una Handy acaba de escribir, o el catch-up no ha terminado). Compararla
    // daría por descuadre lo que se arregla solo en cuanto llegue, y no se podría tocar nada
    // arriba (`puede_borrar_arriba`). No se compara ni se informa: quien llama lo reintenta en
    // unos minutos. Con un worker que no manda `hasta_seq` (0) se compara, y no se toca nada.
    if foto.hasta_seq > repo.get_checkpoint().await? {
        return Ok(Contraste::FotoPorDelante);
    }

    // Se guarda ANTES de ceder la foto: es lo que decide si se puede borrar arriba.
    let hasta_seq = foto.hasta_seq;
    let mut resultado = repo.contrastar_con_la_nube(foto, reparar).await?;

    // SYNC-25 · segunda fase, y **sólo si hace falta**: un contador que no cuadra dice que algo
    // baila, no qué. Las claves lo dicen exactamente, pero pesan, así que se piden únicamente de
    // las tablas que ya se sabe que están mal. El caso normal —todo cuadra— no paga nada de esto.
    if !resultado.tablas_a_examinar.is_empty() {
        let claves: VerificacionClaves = pedir(
            nube,
            "/v1/sync/verificar-claves",
            json!({ "tablas": resultado.tablas_a_examinar }),
            "respuesta de /v1/sync/verificar-claves",
            AppError::Internal,
        )
        .await?;

        let (mas_descuadres, reparadas, borradas, aplazado) =
            repo.contrastar_claves(claves, hasta_seq, reparar).await?;

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
        resultado.aplazado = resultado.aplazado || aplazado;
    }

    let informe = json!({
        "descuadres": resultado.descuadres,
        "apartadas": resultado.descuadres.iter().map(|d| d.sobran).sum::<i64>(),
        "reparadas": resultado.reparadas,
        "borradas": resultado.borradas,
        "aplazado": resultado.aplazado,
        "ventana_omitida": resultado.ventana_omitida,
        "reparacion_apagada": !reparar,
    });
    // Best-effort, y el error se descarta A SABIENDAS. Dos razones: que el informe no salga no
    // puede deshacer la reparación que ya está encolada, y sobre todo que no se pierde información
    // — un descuadre no se arregla solo por no haberlo contado, así que la pasada siguiente vuelve
    // a encontrarlo y a informarlo. Lo que se vigila en Axiom es la serie, no el evento suelto.
    let _ = nube
        .tpv_server_post_json("tpv", "/v1/sync/salud", informe)
        .await;

    Ok(Contraste::Hecho(resultado))
}

/// Lo que ha hecho una pasada de [`verificar_contra_la_nube`].
#[derive(Debug)]
pub enum Contraste {
    /// Se ha comparado, reparado lo que se pudiera e informado.
    Hecho(ResultadoVerificacion),
    /// VERIF-01 · No se ha pedido nada a la nube: el histórico todavía se está descargando.
    HistoricoPendiente,
    /// VERIF-02 · La foto de la nube iba por delante del checkpoint local: no se ha comparado.
    FotoPorDelante,
}

impl Contraste {
    /// El resultado de la comparación, si la hubo.
    pub fn hecho(self) -> Option<ResultadoVerificacion> {
        match self {
            Contraste::Hecho(r) => Some(r),
            Contraste::HistoricoPendiente | Contraste::FotoPorDelante => None,
        }
    }
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
        ) -> AppResult<crate::ports::sync::BajadaAplicada> {
            Ok(crate::ports::sync::BajadaAplicada {
                aplicadas: changes.into_iter().map(|c| c.op_id).collect(),
                last_seq: 99,
                detenida: None,
            })
        }
        async fn cambio_detenido(&self) -> AppResult<Option<tpv_contracts::sync::SyncChange>> {
            Ok(None)
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
            _: bool,
        ) -> AppResult<ResultadoVerificacion> {
            Ok(ResultadoVerificacion::default())
        }
        async fn contrastar_claves(
            &self,
            _: VerificacionClaves,
            _: i64,
            _: bool,
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
            _: &str,
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

#[cfg(test)]
mod tests_leer_respuesta {
    //! De los bytes de la respuesta al tipo, sin un `Value` de por medio: lo que mandaba un worker
    //! anterior se sigue leyendo, lo que añada uno más nuevo no estorba, y un cuerpo que no encaja
    //! se dice sin citar lo que traía.

    use super::*;
    use tpv_contracts::errors::ErrorCode;

    fn leer<T: DeserializeOwned>(cuerpo: &str) -> AppResult<T> {
        leer_respuesta(cuerpo.as_bytes(), "respuesta de prueba", AppError::External)
    }

    #[test]
    fn el_volcado_de_un_worker_anterior_se_sigue_leyendo() {
        // Antes de SYNC-19: `totalFilas` en camelCase, sin `parcial` ni `backfill`.
        let foto: BootstrapSnapshot = leer(
            r#"{"ok":true,"seq":41,"totalFilas":2,"tablas":[
                 {"nombre":"Zonas","columnas":["ID_Zona","Nombre_Zona"],"filas":[["z1","Salón"],["z2",null]]}]}"#,
        )
        .unwrap();
        assert_eq!((foto.seq, foto.total_filas), (41, 2));
        assert_eq!(foto.tablas[0].filas[1], vec![serde_json::json!("z2"), serde_json::Value::Null]);
        assert!(!foto.tablas[0].parcial);
        assert!(foto.backfill.is_empty());
    }

    #[test]
    fn el_volcado_de_hoy_y_lo_que_anada_uno_mas_nuevo() {
        // El de ahora, más campos que esta versión no conoce: se ignoran.
        let foto: BootstrapSnapshot = leer(
            r#"{"ok":true,"seq":7,"total_filas":1,"ventana":{"desde":"2026-10-14","dias":30},"bytes":1234,
                "tablas":[{"nombre":"Comandas","columnas":["ID_Comanda"],"filas":[["c1"]],"parcial":true,"filas_totales":900}],
                "backfill":["Comandas"]}"#,
        )
        .unwrap();
        assert_eq!((foto.seq, foto.total_filas), (7, 1));
        assert!(foto.tablas[0].parcial);
        assert_eq!(foto.backfill, vec!["Comandas".to_string()]);
    }

    #[test]
    fn la_foto_del_contraste_de_un_worker_sin_hasta_seq() {
        let foto: VerificacionNube = leer(r#"{"conteos":[{"nombre":"Zonas","filas":3}],"ventana":[]}"#).unwrap();
        assert_eq!(foto.conteos[0].filas, 3);
        assert_eq!(foto.hasta_seq, 0, "sin `hasta_seq` no se puede afirmar nada: falla cerrado");
        assert!(!foto.ventana_omitida);

        let foto: VerificacionNube = leer(
            r#"{"conteos":[],"ventana":[],"ventana_omitida":true,"desde":"2026-10-14 00:00:00","hasta_seq":88}"#,
        )
        .unwrap();
        assert_eq!((foto.hasta_seq, foto.ventana_omitida), (88, true));
    }

    #[test]
    fn las_claves_y_una_pagina_del_historico() {
        let claves: VerificacionClaves = leer(
            r#"{"tablas":[{"nombre":"Pago_Detalles","columnas":["ID_Pago","ID_Detalle"],"claves":[["p1","d1"]]},
                         {"nombre":"Comandas","columnas":["ID_Comanda"],"claves":[],"truncada":true}]}"#,
        )
        .unwrap();
        assert_eq!(claves.tablas[0].claves.len(), 1);
        assert!(!claves.tablas[0].truncada);
        assert!(claves.tablas[1].truncada);

        let pagina: HistoricoPagina = leer(
            r#"{"ok":true,"tabla":"Comandas","columnas":["ID_Comanda","Total_Comanda"],"filas":[["c1",1250]],"siguiente_cursor":2000}"#,
        )
        .unwrap();
        assert_eq!((pagina.tabla.as_str(), pagina.siguiente_cursor), ("Comandas", Some(2000)));

        // La última página: con el cursor a `null` o sin él.
        for cuerpo in [
            r#"{"tabla":"Comandas","columnas":[],"filas":[],"siguiente_cursor":null}"#,
            r#"{"tabla":"Comandas","columnas":[],"filas":[]}"#,
        ] {
            let pagina: HistoricoPagina = leer(cuerpo).unwrap();
            assert_eq!(pagina.siguiente_cursor, None);
        }
    }

    #[test]
    fn un_200_con_ok_false_es_el_error_de_la_api() {
        let err = leer::<BootstrapSnapshot>(r#"{"ok":false,"code":"conflict","error":"tenant_db_already_provisioned"}"#)
            .unwrap_err();
        assert_eq!(err.code(), ErrorCode::Conflict, "{err}");
    }

    #[test]
    fn lo_que_no_encaja_se_dice_sin_citar_lo_que_traia() {
        // AUD-28: el texto de serde citaría el valor («invalid type: string "Ana López"…»).
        let err = leer::<BootstrapSnapshot>(r#"{"seq":"Ana López 600123456","total_filas":0,"tablas":[]}"#).unwrap_err();
        let texto = err.to_string();
        assert!(texto.contains("respuesta de prueba ilegible"), "{texto}");
        assert!(texto.contains("línea 1"), "{texto}");
        assert!(!texto.contains("Ana") && !texto.contains("600123456"), "{texto}");
        assert_eq!(err.code(), ErrorCode::External);

        // Un cuerpo cortado o que no es JSON, igual; y cada ruta conserva su clase de error.
        let err = leer_respuesta::<VerificacionNube>(b"{\"conteos\":[", "respuesta de /v1/sync/verificar", AppError::Internal)
            .unwrap_err();
        assert_eq!(err.code(), ErrorCode::Internal);
        assert!(leer::<HistoricoPagina>("<html>502 Bad Gateway</html>").is_err());
        assert!(leer::<VerificacionClaves>("").is_err());
    }

    /// La nube de un test: contesta con un `Value`, y el puerto lo entrega en bytes por defecto.
    struct NubeDePrueba(serde_json::Value);

    #[async_trait::async_trait]
    impl PairingService for NubeDePrueba {
        fn device_identity(&self) -> AppResult<tpv_contracts::licensing::DeviceIdentity> {
            unimplemented!()
        }
        fn firmar_hello(&self, _: &str, _: &str) -> AppResult<tpv_contracts::licensing::FirmaDispositivo> {
            unimplemented!()
        }
        fn firmar_emparejamiento(
            &self,
            _: tpv_contracts::licensing::DeviceFirmarEmparejamientoArgs,
        ) -> AppResult<tpv_contracts::licensing::FirmaDispositivo> {
            unimplemented!()
        }
        fn hora_para_firmar(&self) -> i64 {
            unimplemented!()
        }
        fn handy_set_token(&self, _: &str, _: &str) -> AppResult<()> {
            unimplemented!()
        }
        fn handy_clear_token(&self) -> AppResult<()> {
            unimplemented!()
        }
        fn handy_get_tenant(&self) -> AppResult<Option<String>> {
            unimplemented!()
        }
        fn negocio_de_la_licencia(&self) -> AppResult<Option<String>> {
            unimplemented!()
        }
        fn tpv_server_signed_headers(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &[u8],
        ) -> AppResult<tpv_contracts::licensing::ApiSignedHeaders> {
            unimplemented!()
        }
        async fn tpv_server_post_json(&self, _: &str, _: &str, _: serde_json::Value) -> AppResult<serde_json::Value> {
            Ok(self.0.clone())
        }
        async fn pair_create(&self) -> AppResult<tpv_contracts::licensing::PairCreateResult> {
            unimplemented!()
        }
        async fn upload_image(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: Vec<u8>,
            _: &str,
        ) -> AppResult<crate::ports::licensing::ResultadoSubidaImagen> {
            unimplemented!()
        }
        async fn delete_image(&self, _: &str, _: &str) -> AppResult<()> {
            unimplemented!()
        }
        async fn download_image(&self, _: &str, _: &str) -> AppResult<Option<Vec<u8>>> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn un_adaptador_que_solo_sabe_contestar_en_json_sirve_igual() {
        // Los dobles de los tests no implementan `tpv_server_post_bytes`: vale el del puerto.
        let nube = NubeDePrueba(serde_json::json!({ "tablas": [] }));
        let claves: VerificacionClaves =
            pedir(&nube, "/v1/sync/verificar-claves", json!({}), "respuesta de prueba", AppError::Internal)
                .await
                .unwrap();
        assert!(claves.tablas.is_empty());
    }
}
