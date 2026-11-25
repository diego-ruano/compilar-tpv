//! Casos de uso de **sincronización nube → Main**. Orquestación fina sobre `SyncRepository`.

use serde::de::DeserializeOwned;
use serde_json::json;

use tpv_contracts::sync::{
    AplicacionSync, ApplySyncChangesArgs, BackfillEstado, BootstrapResultado, BootstrapSnapshot,
    ClavesPagina, FilasDeCubos, FilasPorClave, HistoricoPagina, OutboxEntry, OutboxFallo,
    ResultadoVerificacion, ResumenNube, SyncHealth,
};

use tpv_domain::notificaciones::{Destino, NuevaNotificacion, Severidad, ADMIN_ROL_ID};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::PairingService;
use crate::ports::notificaciones::Notifier;
use crate::ports::sync::{
    ContrasteLocal, Convergencia, PaginasDelContraste, PedidoDeClaves, PedidoDeFilas,
    PedidoPorClave, SyncRepository,
};

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
/// Antes se mira si es un 200 con `ok:false` (el worker marca así algunos fallos), que sale con
/// el error de la API como en `tpv_server_post_json`, **aunque el resto del cuerpo encaje en el
/// tipo**: un `{"ok":false,"conteos":[],"ventana":[]}` no es una foto vacía con la que dar el
/// contraste por hecho. Mirarlo es otra pasada sobre los bytes, sin guardar nada (serde descarta
/// lo que no es `ok`): nada que ver con montar el árbol entero.
///
/// AUD-28 — si no se puede leer, el mensaje dice dónde (clase del fallo, línea y columna) y nada
/// del contenido: el texto de serde cita el valor que no encaja, y en un volcado ese valor es un
/// dato del negocio.
fn leer_respuesta<T: DeserializeOwned>(
    bytes: &[u8],
    que: &str,
    ilegible: fn(String) -> AppError,
) -> AppResult<T> {
    #[derive(serde::Deserialize)]
    struct Sobre {
        ok: Option<bool>,
    }
    if let Ok(Sobre { ok: Some(false) }) = serde_json::from_slice::<Sobre>(bytes) {
        return Err(AppError::from_api_body(200, &String::from_utf8_lossy(bytes)));
    }

    serde_json::from_slice::<T>(bytes).map_err(|e| {
        ilegible(format!(
            "{que} ilegible ({:?}, línea {}, columna {})",
            e.classify(),
            e.line(),
            e.column()
        ))
    })
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
pub async fn purge_applied_ops(repo: &dyn SyncRepository) -> AppResult<()> {
    repo.purge_applied_ops().await
}

/// Cuánto se guarda una operación apartada de la subida: 30 días desde su último intento.
///
/// Para entonces ya ha hecho todo su trabajo. Al apartarse se registró en la telemetría
/// (`operación apartada de la subida`, con su `op_id` y su comando) y se encoló la reparación de
/// las filas que tocaba, cuya subida la retira (SYNC-22, SYNC-26). Y el contraste con la nube
/// (SYNC-24) ha pasado decenas de veces —tras cada cierre de caja y cada veinte horas— subiendo por
/// estado lo que a la nube le falte. Lo que queda es la sentencia que no entró, con los datos que
/// llevara (un nombre, un teléfono), sin nada que la vaya a usar, y su contador en el panel de
/// Conectividad diciendo para siempre que hay cambios rechazados: un aviso que no se apaga nunca
/// enseña a no mirarlo. Treinta días dan para que alguien lo vea en el panel y lo consulte, también
/// en un equipo que pase semanas sin conexión.
///
/// Las de la bajada no se retiran (`SyncRepository::purgar_cuarentenas` dice por qué), pero a los
/// mismos treinta días se quedan sin sus datos (SYNC-36, [`vaciar_cuarentenas_de_bajada`]): para
/// entonces se registraron al apartarse y se han intentado traer de la nube en cada contraste.
pub const RETENCION_CUARENTENAS_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Retira las operaciones apartadas de la subida de más de [`RETENCION_CUARENTENAS_MS`]
/// (`purga_sync`, cada día), y devuelve cuántas.
pub async fn purgar_cuarentenas(repo: &dyn SyncRepository, ahora_ms: i64) -> AppResult<u64> {
    repo.purgar_cuarentenas(ahora_ms - RETENCION_CUARENTENAS_MS).await
}

/// SYNC-36 · Vacía los datos de lo que no entró de la bajada y lleva apartado más de
/// [`RETENCION_CUARENTENAS_MS`] (`purga_sync`, cada día), y devuelve cuántas. La cuarentena se
/// queda, sin datos de nadie: es la barrera del contraste (`SyncRepository::vaciar_cuarentenas_de_bajada`).
pub async fn vaciar_cuarentenas_de_bajada(repo: &dyn SyncRepository, ahora_ms: i64) -> AppResult<u64> {
    repo.vaciar_cuarentenas_de_bajada(ahora_ms - RETENCION_CUARENTENAS_MS).await
}

/// Foto de salud de la sincronización local (SYNC-14) para el panel de Conectividad.
pub async fn health(repo: &dyn SyncRepository) -> AppResult<SyncHealth> {
    repo.health().await
}

/// SYNC-36 · Lo que tiene que llevar un cambio de la nube sin poder escribirse en esta Main (en una
/// cuarentena que no sale, o, SYNC-38, apuntado para traerlo y sin entrar) para que se avise al
/// administrador. Antes, lo normal es que se resuelva solo; una semana sin hacerlo ya no es eso.
pub const BAJADA_ATASCADA_TRAS_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// La clave del aviso: uno por situación, mientras dure.
pub const CLAVE_BAJADA_ATASCADA: &str = "bajada_atascada";

/// SYNC-36 · Avisa a los administradores si hay algo que la nube ha cambiado y lleva una semana sin
/// poder escribirse en esta Main (`SyncHealth::bajada_atascada`: un cambio en cuarentena que no sale
/// o, SYNC-38, filas apuntadas para traerlas de la nube que no entran), y cierra el aviso cuando ya
/// no lo hay (traer el estado actual de la nube vacía las dos cosas). Devuelve si lo hay.
///
/// Es un aviso: no bloquea nada. Lleva su clave, así que mirarlo cada vez no repite la notificación,
/// y la acción lleva a la pantalla de Conectividad (que no está en el menú: sólo la abre este aviso),
/// que ofrece traer la nube cuando es seguro. Lo
/// apuntado no se retira solo: el contraste no lo toca, y retirarlo dejaría subir lo de esta Main
/// encima de lo que la nube ordenó después.
pub async fn avisar_bajada_atascada(repo: &dyn SyncRepository, notifier: &dyn Notifier) -> AppResult<bool> {
    if repo.health().await?.bajada_atascada == 0 {
        notifier.resolver_por_clave(CLAVE_BAJADA_ATASCADA).await?;
        return Ok(false);
    }
    notifier
        .emitir(NuevaNotificacion {
            tipo: "bajada_atascada".into(),
            severidad: Severidad::Aviso,
            titulo: "Hay cambios hechos desde las Handy que el TPV no ha podido aplicar".into(),
            cuerpo: Some(
                "Hace más de una semana que algunos cambios hechos desde las Handy no se pueden aplicar en el TPV \
                 principal: en él pueden verse datos distintos de los de las Handy, y las comprobaciones diarias con la \
                 nube no lo pueden arreglar. Se arregla trayendo el estado actual de la nube: en el TPV principal, \
                 pulsa este aviso y, en la pantalla que se abre, «Recuperar el estado actual de la nube»."
                    .into(),
            ),
            destino: Destino::Rol(ADMIN_ROL_ID.to_string()),
            accion: Some("ver_conectividad".into()),
            payload: None,
            clave_dedupe: Some(CLAVE_BAJADA_ATASCADA.into()),
            expira_en: None,
        })
        .await?;
    Ok(true)
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

/// Filas por página con el equipo trabajando: las que admitía el worker antes de que la página del
/// histórico tuviera su techo propio (2.000). Cada página ocupa un rato el hilo del DO del negocio,
/// que atiende a la vez a la Main y a las Handy, y aquí el escritor de la base mientras se aplica: con
/// el bar trabajando, páginas cortas.
pub const BACKFILL_FILAS_POR_PAGINA: i64 = 2_000;

/// Páginas por vencimiento con el equipo trabajando: ~20.000 filas cada cinco minutos, unas 240.000
/// a la hora.
///
/// **No es el bucle entero a propósito.** El motor de jobs tiene que conservar el control: un
/// backfill que se lleva el equipo por delante durante media hora lo hace en hora punta, y eso es
/// peor que tardar.
pub const BACKFILL_PAGINAS_POR_TICK: usize = 10;

/// Filas por página con el equipo en calma: las que admite el worker (`HISTORICO_MAX_FILAS`, 10.000),
/// que además corta la página en 4 MiB (`HISTORICO_MAX_BYTES`).
pub const BACKFILL_FILAS_POR_PAGINA_EN_CALMA: i64 = 10_000;

/// Páginas por vencimiento con el equipo en calma: hasta 400.000 filas cada cinco minutos. Un año de
/// un bar de mil comandas diarias (unos ocho millones de filas) baja así en unas horas de calma, y
/// no en días: mientras tanto la reconciliación y el contraste no corren. Cada página es una petición
/// aparte, así que entre una y otra el DO atiende lo demás del negocio.
pub const BACKFILL_PAGINAS_POR_TICK_EN_CALMA: usize = 40;

/// Lo que tiene que llevar el equipo sin escribir nada (ni una operación de aquí ni un cambio
/// aplicado de la nube) para bajar el histórico a ritmo de calma. Se mira antes de cada página: si
/// entra una venta a mitad, lo que queda del vencimiento va al ritmo de trabajo.
pub const BACKFILL_CALMA_MS: i64 = 3 * 60 * 1000;

/// Progreso del backfill del histórico.
pub async fn backfill_estado(repo: &dyn SyncRepository) -> AppResult<BackfillEstado> {
    repo.backfill_estado().await
}

fn ahora_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// ¿Está el equipo en calma? Nadie ha escrito en [`BACKFILL_CALMA_MS`]: sin ninguna escritura
/// todavía, también.
fn en_calma(ultima_escritura_ms: Option<i64>, ahora_ms: i64) -> bool {
    ultima_escritura_ms.is_none_or(|t| ahora_ms.saturating_sub(t) >= BACKFILL_CALMA_MS)
}

/// Un vencimiento del job: trae unas cuantas páginas del histórico y las aplica.
///
/// Cuántas y de qué tamaño depende de si el equipo está en calma ([`en_calma`], mirado antes de cada
/// página): trabajando, [`BACKFILL_PAGINAS_POR_TICK`] de [`BACKFILL_FILAS_POR_PAGINA`]; en calma,
/// [`BACKFILL_PAGINAS_POR_TICK_EN_CALMA`] de [`BACKFILL_FILAS_POR_PAGINA_EN_CALMA`]. Las tablas van
/// una detrás de otra, en el orden que da el worker (padres primero), y cada una de lo más antiguo a
/// lo más nuevo: al bajar una tabla ya están todas las filas de las que cuelga.
///
/// Idempotente, como exige el motor: repetir una página no cambia nada (`ON CONFLICT(<clave
/// primaria>) DO NOTHING` en la persistencia) y el cursor sólo avanza cuando la página entra de
/// verdad.
///
/// Devuelve cuántas filas se procesaron. Cero significa que no queda backfill pendiente, que es el
/// caso normal de un equipo que nunca ha perdido su base: una lectura y se acabó.
pub async fn backfill_paso(
    nube: &dyn PairingService,
    repo: &dyn SyncRepository,
) -> AppResult<i64> {
    let mut total = 0i64;
    let mut paginas = 0usize;

    loop {
        let Some((tabla, cursor)) = repo.backfill_siguiente().await? else {
            break;
        };
        let ahora = ahora_ms();
        let (tope, limite) = if en_calma(repo.ultima_escritura_ms(ahora).await?, ahora) {
            (BACKFILL_PAGINAS_POR_TICK_EN_CALMA, BACKFILL_FILAS_POR_PAGINA_EN_CALMA)
        } else {
            (BACKFILL_PAGINAS_POR_TICK, BACKFILL_FILAS_POR_PAGINA)
        };
        if paginas >= tope {
            break;
        }
        paginas += 1;

        let pagina: HistoricoPagina = match pedir(
            nube,
            "/v1/sync/historico",
            json!({ "tabla": tabla, "cursor": cursor, "limite": limite }),
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

        // Una página de otra tabla no se aplica: avanzaría el cursor de una que no se ha pedido.
        if pagina.tabla != tabla {
            return Err(AppError::external(format!(
                "el servidor contestó con la tabla {} para una petición de {tabla}",
                pagina.tabla
            )));
        }

        total += repo.backfill_aplicar_pagina(cursor, pagina).await?;
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

/// El contraste con la nube: compara esta base con la de la nube, repara lo que se pueda y **se
/// chiva solo**.
///
/// Va por resúmenes (`docs/arquitectura/sincronizacion.md`): la nube manda, por tabla, sus conteos
/// y el resumen por cubos de su ventana (`/v1/sync/verificar/resumen`), y de lo que no cuadra se
/// bajan sólo las filas de los cubos que no cuadran (`/verificar/filas`) y, fuera de la ventana,
/// las claves por páginas (`/verificar/claves`). Lo compara y lo repara el repositorio
/// ([`SyncRepository::contrastar_con_la_nube`]); aquí se orquesta y se informa.
///
/// Los tres pasos van juntos a propósito. Separar "comprobar" de "contar lo que se ha encontrado"
/// deja la puerta abierta a que alguien llame a lo primero sin lo segundo, y entonces el descuadre
/// vuelve a existir sin que nadie lo sepa.
///
/// El informe va al worker y de ahí a Axiom, **no al usuario**: quien está delante del TPV no puede
/// atender un descuadre, y un aviso que no se puede atender enseña a ignorar los avisos. Se informa
/// SIEMPRE que se compara, también cuando todo cuadra: un silencio no distingue "va bien" de "este
/// equipo lleva tres semanas sin comprobarse".
///
/// `reparar = false` es el interruptor `reparacion_nube` apagado (PROD-06): se compara y se informa
/// igual, pero no se escribe nada.
///
/// Sólo se compara con las dos fotos del mismo instante: sin nada de aquí por subir y sin nada de
/// allí por bajar. Si no es así —el negocio está escribiendo, a esta Main le falta algo por aplicar,
/// la base se mueve a mitad de la pasada— se devuelve [`Contraste::Aplazado`], que no es un fallo:
/// el job lo reintenta en unos minutos.
///
/// VERIF-01 · **Con el histórico a medias no se contrasta.** Tras recuperar desde la nube, la fase 2
/// va trayendo lo que la ventana de la fase 1 dejó fuera; hasta que termina, todo lo que falta por
/// bajar saldría como «la nube tiene filas que aquí no están», y borrarlo arriba se llevaría lo que
/// el backfill iba a traer. No se pide nada ni se informa.
pub async fn verificar_contra_la_nube(
    nube: &dyn PairingService,
    repo: &dyn SyncRepository,
    reparar: bool,
) -> AppResult<Contraste> {
    if repo.backfill_estado().await?.tablas_pendientes > 0 {
        return Ok(Contraste::HistoricoPendiente);
    }

    // La marca de esta base antes de pedir nada: el resumen sólo vale contra ella. Con algo por
    // subir, la nube no tiene todavía lo de aquí y no hay nada que pedirle.
    let marca = repo.contraste_marca().await?;
    if marca.pendientes > 0 {
        return Ok(Contraste::Aplazado);
    }

    let resumen: ResumenNube = pedir(
        nube,
        "/v1/sync/verificar/resumen",
        json!({ "checkpoint": marca.checkpoint }),
        "respuesta de /v1/sync/verificar/resumen",
        AppError::Internal,
    )
    .await?;
    // La nube dice que ahora no: el negocio está escribiendo, o a esta Main le falta por aplicar
    // algo de lo que hay en el log.
    if resumen.aplazar {
        return Ok(Contraste::Aplazado);
    }

    let paginas = PaginasPorRest { nube };
    let resultado = match repo.contrastar_con_la_nube(resumen, marca, &paginas, reparar).await? {
        ContrasteLocal::Hecho(resultado) => resultado,
        ContrasteLocal::SeHaMovido => return Ok(Contraste::Aplazado),
        ContrasteLocal::EscritoAqui(cambio) => return Ok(Contraste::EscritoAqui(cambio)),
    };

    let informe = json!({
        "descuadres": resultado.descuadres,
        "apartadas": resultado.descuadres.iter().map(|d| d.sobran).sum::<i64>(),
        "reparadas": resultado.reparadas,
        "borradas": resultado.borradas,
        "aplazado": resultado.aplazado,
        "ventana_omitida": resultado.ventana_omitida,
        "filas_examinadas": resultado.filas_examinadas,
        "tablas_sin_comparar": resultado.tablas_sin_comparar,
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

/// SYNC-29 · Una vuelta de la convergencia con el orden de la nube: trae de la nube, por su clave,
/// las filas que su orden dejó de otra forma aquí y las escribe aquí
/// ([`SyncRepository::converger_con_la_nube`]). La llama el motor de réplica con todo subido.
pub async fn converger_con_la_nube(
    nube: &dyn PairingService,
    repo: &dyn SyncRepository,
) -> AppResult<Convergencia> {
    repo.converger_con_la_nube(&PaginasPorRest { nube }).await
}

/// Las páginas del contraste por la API REST de la nube: lo que el repositorio pide además del
/// resumen.
struct PaginasPorRest<'a> {
    nube: &'a dyn PairingService,
}

#[async_trait::async_trait]
impl PaginasDelContraste for PaginasPorRest<'_> {
    async fn filas(&self, pedido: PedidoDeFilas) -> AppResult<FilasDeCubos> {
        pedir(
            self.nube,
            "/v1/sync/verificar/filas",
            json!({
                "tabla": pedido.tabla,
                "desde": pedido.desde,
                "cubos": pedido.cubos,
                "pedir": pedido.pedir,
                "cursor": pedido.cursor,
            }),
            "respuesta de /v1/sync/verificar/filas",
            AppError::Internal,
        )
        .await
    }

    async fn por_clave(&self, pedido: PedidoPorClave) -> AppResult<FilasPorClave> {
        pedir(
            self.nube,
            "/v1/sync/verificar/por-clave",
            json!({ "tabla": pedido.tabla, "claves": pedido.claves }),
            "respuesta de /v1/sync/verificar/por-clave",
            AppError::Internal,
        )
        .await
    }

    async fn claves(&self, pedido: PedidoDeClaves) -> AppResult<ClavesPagina> {
        pedir(
            self.nube,
            "/v1/sync/verificar/claves",
            json!({ "tabla": pedido.tabla, "cursor": pedido.cursor }),
            "respuesta de /v1/sync/verificar/claves",
            AppError::Internal,
        )
        .await
    }
}

/// Lo que ha hecho una pasada de [`verificar_contra_la_nube`].
#[derive(Debug)]
pub enum Contraste {
    /// Se ha comparado, reparado lo que se pudiera e informado.
    Hecho(ResultadoVerificacion),
    /// VERIF-01 · No se ha pedido nada a la nube: el histórico todavía se está descargando.
    HistoricoPendiente,
    /// VERIF-02 · No se ha comparado, o se ha dejado a medias sin tocar nada: había algo por subir,
    /// la nube estaba escribiendo o iba por delante de esta Main, o una de las dos bases se movió
    /// durante la pasada. No es un fallo: se reintenta en unos minutos.
    Aplazado,
    /// SYN-INC-07 · Como `Aplazado`, pero porque se ha escrito aquí algo que sube (una fusión de
    /// fichas, un aviso): lleva lo que la pantalla tiene que releer.
    EscritoAqui(tpv_contracts::sync::CambioReplicado),
}

impl Contraste {
    /// El resultado de la comparación, si la hubo.
    pub fn hecho(self) -> Option<ResultadoVerificacion> {
        match self {
            Contraste::Hecho(r) => Some(r),
            Contraste::HistoricoPendiente | Contraste::Aplazado | Contraste::EscritoAqui(_) => None,
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
        async fn outbox_confirmar_lote(&self, _: &[(String, i64)]) -> AppResult<()> {
            Ok(())
        }
        async fn outbox_mark_failed(&self, _: &str, _: &str, _: bool) -> AppResult<OutboxFallo> {
            Ok(OutboxFallo::default())
        }
        async fn contraste_marca(&self) -> AppResult<crate::ports::sync::MarcaLocal> {
            Ok(crate::ports::sync::MarcaLocal::default())
        }
        async fn contrastar_con_la_nube(
            &self,
            _: ResumenNube,
            _: crate::ports::sync::MarcaLocal,
            _: &dyn PaginasDelContraste,
            _: bool,
        ) -> AppResult<ContrasteLocal> {
            Ok(ContrasteLocal::Hecho(ResultadoVerificacion::default()))
        }
        async fn purge_applied_ops(&self) -> AppResult<()> {
            Ok(())
        }
        async fn marcar_anterior_a_la_nube(&self) -> AppResult<()> {
            panic!("no usado")
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
        async fn backfill_aplicar_pagina(&self, _: i64, _: HistoricoPagina) -> AppResult<i64> {
            panic!("no usado")
        }
        async fn backfill_marcar_error(&self, _: &str, _: &str) -> AppResult<()> {
            Ok(())
        }
        async fn backfill_estado(&self) -> AppResult<BackfillEstado> {
            panic!("no usado")
        }
        async fn ultima_escritura_ms(&self, _: i64) -> AppResult<Option<i64>> {
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
    //! De los bytes de la respuesta al tipo, sin un `Value` de por medio: lo que añada un worker más
    //! nuevo no estorba, lo que falte no se adivina, y un cuerpo que no encaja se dice sin citar lo
    //! que traía.

    use super::*;
    use tpv_contracts::errors::ErrorCode;

    fn leer<T: DeserializeOwned>(cuerpo: &str) -> AppResult<T> {
        leer_respuesta(cuerpo.as_bytes(), "respuesta de prueba", AppError::External)
    }

    #[test]
    fn un_volcado_sin_lo_que_manda_el_worker_no_se_lee() {
        // Sin `parcial` no se sabe si la tabla viene entera, y sin `backfill`, qué rellenar después:
        // darlo por entero dejaría el histórico sin bajar, sin que nadie lo vea.
        let tabla = r#"{"nombre":"Zonas","columnas":["ID_Zona","Nombre_Zona"],"filas":[["z1","Salón"],["z2",null]]"#;
        for cuerpo in [
            format!(r#"{{"ok":true,"seq":41,"total_filas":2,"tablas":[{tabla}}}],"backfill":[]}}"#),
            format!(r#"{{"ok":true,"seq":41,"total_filas":2,"tablas":[{tabla},"parcial":false}}]}}"#),
            format!(r#"{{"ok":true,"seq":41,"totalFilas":2,"tablas":[{tabla},"parcial":false}}],"backfill":[]}}"#),
        ] {
            assert!(leer::<BootstrapSnapshot>(&cuerpo).is_err(), "{cuerpo}");
        }
        let foto: BootstrapSnapshot =
            leer(&format!(r#"{{"ok":true,"seq":41,"total_filas":2,"tablas":[{tabla},"parcial":false}}],"backfill":[]}}"#)).unwrap();
        assert_eq!((foto.seq, foto.total_filas), (41, 2));
        assert_eq!(foto.tablas[0].filas[1], vec![serde_json::json!("z2"), serde_json::Value::Null]);
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
    fn el_resumen_del_contraste_y_su_aplazamiento() {
        // Aplazado: sin tablas, con su motivo y lo que se le dice que espere (que no se usa).
        let resumen: ResumenNube = leer(
            r#"{"ok":true,"aplazar":true,"motivo":"actividad","reintentar_en_s":90,"hasta_seq":3}"#,
        )
        .unwrap();
        assert!(resumen.aplazar);
        assert_eq!(resumen.motivo.as_deref(), Some("actividad"));
        assert!(resumen.tablas.is_empty());

        // Un resumen: una tabla con su ventana y otra sólo con su conteo.
        let resumen: ResumenNube = leer(
            r#"{"ok":true,"aplazar":false,"checkpoint":4,"hasta_seq":9,"desde":"2026-10-14 12:00:00","ventana_omitida":false,
                "tablas":[{"nombre":"Zonas","total":2,"sql":"SELECT * FROM \"Zonas\";","args":[],"columnas":["ID_Zona","Nombre_Zona"],
                           "claves":["ID_Zona"],"filas":2,"cubos":1,"cuentas":[2],"sumas":["00000000000000ff"]},
                          {"nombre":"Comandas","total":17}]}"#,
        )
        .unwrap();
        assert_eq!((resumen.checkpoint, resumen.hasta_seq), (Some(4), 9));
        assert_eq!(resumen.tablas[0].cuentas, vec![2]);
        assert_eq!(resumen.tablas[1].sql, None, "sin ventana sólo se compara el conteo");
        assert_eq!(resumen.tablas[1].total, 17);

        // Sin `checkpoint` la nube no ha comprobado nada: no se puede comparar.
        let resumen: ResumenNube = leer(r#"{"ok":true,"tablas":[]}"#).unwrap();
        assert_eq!((resumen.checkpoint, resumen.aplazar), (None, false));
    }

    #[test]
    fn las_paginas_del_contraste_y_una_del_historico() {
        let filas: FilasDeCubos = leer(
            r#"{"ok":true,"tabla":"Zonas","columnas":["ID_Zona"],"filas":[["z1"],["z2"]],"siguiente_cursor":null,"hasta_seq":9}"#,
        )
        .unwrap();
        assert_eq!((filas.filas.len(), filas.siguiente_cursor, filas.hasta_seq), (2, None, 9));

        let claves: ClavesPagina = leer(
            r#"{"ok":true,"tabla":"Pago_Detalles","columnas":["ID_Pago","ID_Detalle"],"claves":[["p1","d1"]],"siguiente_cursor":["p1","d1"],"hasta_seq":9}"#,
        )
        .unwrap();
        assert_eq!(claves.claves.len(), 1);
        assert_eq!(claves.siguiente_cursor, Some(vec![json!("p1"), json!("d1")]));

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

        // También si el resto del cuerpo encaja en el tipo: no es una foto vacía con la que dar
        // el contraste por hecho, ni un volcado sin tablas.
        let err = leer::<ResumenNube>(r#"{"ok":false,"code":"conflict","error":"x","tablas":[]}"#)
            .unwrap_err();
        assert_eq!(err.code(), ErrorCode::Conflict, "{err}");
        let err = leer::<ClavesPagina>(r#"{"tabla":"Zonas","claves":[],"error":"x","code":"conflict","ok":false}"#).unwrap_err();
        assert_eq!(err.code(), ErrorCode::Conflict, "{err}");

        // Un `ok` que no es un booleano no dice nada, como antes: se lee el cuerpo.
        assert!(leer::<ClavesPagina>(r#"{"ok":"no","tabla":"Zonas","claves":[]}"#).is_ok());
        assert!(leer::<ClavesPagina>(r#"{"ok":true,"tabla":"Zonas","claves":[]}"#).is_ok());
    }

    #[test]
    fn lo_que_no_encaja_se_dice_sin_citar_lo_que_traia() {
        // AUD-28: el texto de serde citaría el valor («invalid type: string "Ana López"…»).
        let err = leer::<BootstrapSnapshot>(r#"{"seq":"Ana López 600123456","total_filas":0,"tablas":[],"backfill":[]}"#).unwrap_err();
        let texto = err.to_string();
        assert!(texto.contains("respuesta de prueba ilegible"), "{texto}");
        assert!(texto.contains("línea 1"), "{texto}");
        assert!(!texto.contains("Ana") && !texto.contains("600123456"), "{texto}");
        assert_eq!(err.code(), ErrorCode::External);

        // Un cuerpo cortado o que no es JSON, igual; y cada ruta conserva su clase de error.
        let err = leer_respuesta::<ResumenNube>(b"{\"tablas\":[", "respuesta de /v1/sync/verificar/resumen", AppError::Internal)
            .unwrap_err();
        assert_eq!(err.code(), ErrorCode::Internal);
        assert!(leer::<HistoricoPagina>("<html>502 Bad Gateway</html>").is_err());
        assert!(leer::<ClavesPagina>("").is_err());
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
        fn desfase_del_reloj_ms(&self) -> Option<i64> {
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
        let nube = NubeDePrueba(serde_json::json!({ "tabla": "Zonas", "claves": [] }));
        let claves: ClavesPagina =
            pedir(&nube, "/v1/sync/verificar/claves", json!({}), "respuesta de prueba", AppError::Internal)
                .await
                .unwrap();
        assert!(claves.claves.is_empty());
    }
}
