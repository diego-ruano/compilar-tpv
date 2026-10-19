//! # Catálogo de jobs periódicos
//!
//! **Este es el único fichero que hay que tocar para añadir una tarea de fondo.** El motor
//! (`jobs/mod.rs`) se encarga del resto: vencimiento, jitter, backoff, gating, panics y registro.
//!
//! Para añadir un job:
//!
//! 1. Escribe una `async fn <nombre>(app: AppHandle) -> Result<(), String>` aquí abajo. Devolver
//!    `Err` es la forma de decir "ha fallado": el motor lo reintentará con backoff y lo enseñará
//!    en Configuración → Conectividad. No captures el error para devolver `Ok`.
//! 2. Añade su [`Job`] a [`catalogo`], eligiendo `cada`, `retardo_inicial` y `requiere`.
//! 3. Nada más. No se toca `lib.rs` ni se escribe ningún bucle.
//!
//! El cuerpo debe ser **idempotente**: el motor puede ejecutarlo antes de tiempo (job vencido tras
//! un apagón) o repetirlo tras un fallo parcial.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use tpv_application::use_cases::avisos as uc_avisos;
use tpv_application::use_cases::cierre_caja as uc_cierre_caja;
use tpv_application::use_cases::licensing as uc_licensing;
use tpv_application::use_cases::reconciliacion as uc_reconciliacion;
use tpv_application::use_cases::reservas_web as uc_reservas_web;
use tpv_application::use_cases::reservas_web_avisos as uc_reservas_web_avisos;
use tpv_application::use_cases::stock_alertas as uc_stock_alertas;
use tpv_application::use_cases::sync as uc_sync;
use tpv_infra_licensing::PairingAdapter;

use tpv_contracts::interruptores::Interruptor;

use super::{tarea, Job, Requiere};
use crate::AppState;

/// Cada cuánto se revalida la licencia contra el worker mientras la app está abierta.
const LICENCIA_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// RI-36: cada cuánto se cuenta el tiempo sin conexión de la gracia offline. Es lo más que se puede
/// esconder cerrando la app y atrasando el reloj; contarlo es escribir un fichero pequeño.
const LICENCIA_RELOJ_INTERVAL_SECS: u64 = 5 * 60;

/// PROD-06: cada cuánto se pregunta a la nube qué interruptores tiene apagados este equipo.
const INTERRUPTORES_INTERVAL_SECS: u64 = 5 * 60;

/// Cada cuánto se mira si hay registros de facturación que remitir a la AEAT (FISCAL-01).
///
/// Un minuto, que es la cadencia con la que arranca el **control de flujo** que impone el art. 16.2
/// de la Orden: el primer valor de `TiempoEsperaEnvio` son 60 segundos. Mirar más a menudo no
/// enviaría antes —la propia norma lo impide— y mirar menos dejaría el ticket recién cobrado
/// esperando sin motivo.
///
/// El vencimiento del job es sólo *cuándo se mira*; **quién decide si se envía es
/// `puede_enviar`**, que respeta la espera que dijo la AEAT y el tope de 1000 registros.
const VERIFACTU_INTERVAL_SECS: u64 = 60;

/// Cada cuánto se mira si la caja lleva demasiado sin cerrarse. Una hora sobra: el aviso no es
/// urgente, sólo tiene que llegar antes de que se acumulen dos servicios sin arqueo.
const CAJA_ABIERTA_INTERVAL_SECS: u64 = 60 * 60;

/// A partir de cuántas horas abiertas se avisa. 20 h deja pasar una jornada larga —un bar que abre
/// a las 09:00 y cierra a las 03:00 sigue dentro— y salta cuando de verdad se ha saltado un cierre.
const CAJA_ABIERTA_HORAS: i64 = 20;

/// Cada cuánto se cierran las jornadas que quedaron sin fichar la salida (TRAB-01). Una hora: un
/// TPV que no se apaga cierra las de ayer como mucho una hora después de medianoche, y en el 99 %
/// de las vueltas es una lectura que no encuentra nada.
const FICHAJES_COLGADOS_INTERVAL_SECS: u64 = 60 * 60;

/// Cada cuánto se buscan tareas vencidas y reservas próximas.
const AVISOS_INTERVAL_SECS: u64 = 10 * 60;

/// Cada cuánto se buscan productos con stock total negativo (sobreventa) para avisar. Como los
/// negativos entran por ventas de la Handy replicadas a la Main, 10 min da un aviso casi inmediato
/// sin machacar la BD (es un par de lecturas agregadas).
const STOCK_NEGATIVO_INTERVAL_SECS: u64 = 10 * 60;

/// Cada cuánto se comprueba la zona horaria del negocio (reservas desde la web). Corto a propósito:
/// el `retardo_inicial` sólo vale la primera vez, así que tras un reinicio el job espera lo que le
/// quede del intervalo, y un equipo que cambia de zona tiene que contárselo a la nube enseguida. Es
/// una lectura; sólo escribe (y sube a la nube) si la zona cambia.
const ZONA_HORARIA_INTERVAL_SECS: u64 = 10 * 60;

/// Cada cuánto salen los avisos al cliente de las reservas web que el restaurante ha cambiado. Un
/// minuto: es un correo que el cliente espera ver pronto, y sin nada en la cola es una lectura.
const AVISOS_RESERVA_WEB_INTERVAL_SECS: u64 = 60;

/// Cada cuánto se reintenta subir a R2 lo que quedó pendiente. No hace falta más a menudo: el
/// camino normal es el evento (tras guardar la imagen y al reconectar el WS); esto es la red.
const IMAGENES_INTERVAL_SECS: u64 = 15 * 60;

/// Cada cuánto se busca PII del personal todavía en claro. No hace falta más: sólo hay trabajo
/// la primera vez tras activar el cifrado (y tras un cambio de equipo que traiga filas viejas).
const CIFRADO_PII_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// Cada cuánto se comprueba que los valores derivados (stock por lote, gasto por cliente)
/// siguen cuadrando con lo que suman sus orígenes. Una vez al día basta: la deriva no aparece de
/// golpe, y el chequeo recorre lotes y clientes enteros.
const RECONCILIACION_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Cada cuánto se poda `_Sync_Applied_Ops`. Los registros solo son purgables tras un TTL de 72 h,
/// así que una pasada al día va sobrada.
const PURGA_SYNC_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Cada cuánto se traen unas páginas del histórico pendiente (SYNC-19, fase 2).
///
/// Cinco minutos por ~10.000 filas es el ritmo que hace converger un histórico de tres meses en
/// unas horas SIN que se note: ni en el equipo, que puede estar en hora punta, ni en las lecturas
/// facturadas de Turso. En el 99,99 % de los vencimientos no hay nada que hacer y el job es una
/// lectura de una tabla vacía.
const BACKFILL_INTERVAL_SECS: u64 = 5 * 60;

/// SYNC-24: cada cuánto se contrasta la nube contra esta base.
///
/// Una vez al día, y no más. Cada pasada se descarga la ventana de 30 días del tenant, y esas
/// lecturas de Turso se facturan: comprobar cada hora costaría 24 veces más para encontrar lo mismo
/// —un descuadre no se arregla solo, así que sigue ahí mañana—. Lo que sí se detecta al instante es
/// lo que importa de verdad: SYNC-22 repara en el momento en que una operación se aparta, sin
/// esperar a esta pasada. Esto es la red de debajo, no la primera línea.
const VERIFICAR_NUBE_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Una instantánea coherente al día y las siete últimas: suficiente para errores humanos o del
/// disco local sin convertir cada escritura del TPV en trabajo de backup.
const BACKUP_LOCAL_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Cada cuánto se vuelve a preguntar al feed de actualizaciones. Un TPV puede pasar semanas
/// encendido sin reiniciarse: sin este tick, una release nueva no se vería hasta el próximo
/// arranque.
#[cfg(desktop)]
const UPDATE_CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// Margen antes del primer chequeo del feed: deja que el arranque (BD, licencia, WS) termine
/// primero y da tiempo a que exista el notifier, para que el aviso in-app salga ya en la primera
/// pasada.
#[cfg(desktop)]
const UPDATE_CHECK_DELAY_SECS: u64 = 30;

/// Los jobs de este dispositivo. El orden no importa: cada uno corre en su propio bucle.
pub(crate) fn catalogo() -> Vec<Job> {
    #[allow(unused_mut)]
    let mut jobs = vec![
        Job {
            nombre: "licencia",
            cada: Duration::from_secs(LICENCIA_INTERVAL_SECS),
            // Al arrancar, la pantalla de AppBoot ya pide el gate por su cuenta; este margen evita
            // duplicar esa llamada en los primeros segundos.
            retardo_inicial: Duration::from_secs(2 * 60),
            // El gate de arranque ya valida la licencia. Durante una recuperación no se ejecuta
            // este job porque sus avisos podrían escribir en una BD vacía antes del bootstrap.
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(licencia),
        },
        Job {
            // RI-36: cuenta el tiempo sin conexión con el reloj monótono, sin red. Entre dos pulsos
            // de `licencia` hay 6 h: sin este, cerrar la app y atrasar el reloj escondía hasta eso.
            // Sin BD ni red, así que corre siempre; sin licencia guardada no hace nada.
            nombre: "licencia_reloj",
            cada: Duration::from_secs(LICENCIA_RELOJ_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(LICENCIA_RELOJ_INTERVAL_SECS),
            requiere: Requiere::Siempre,
            interruptor: None,
            ejecutar: tarea(licencia_reloj),
        },
        Job {
            // PROD-06: pregunta a la nube qué tiene apagado este equipo. Cinco minutos es lo que
            // tarda, como mucho, en obedecer un apagado; lo que dijo la nube vale una hora
            // (`VIGENCIA_CONSULTA_MS`), así que un par de fallos seguidos no enciende nada.
            nombre: "interruptores",
            cada: Duration::from_secs(INTERRUPTORES_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(20),
            requiere: Requiere::MainOperativa,
            // Él mismo, nunca: un interruptor que apagase la consulta de interruptores no se
            // podría volver a encender.
            interruptor: None,
            ejecutar: tarea(interruptores),
        },
        Job {
            // FISCAL-01. Remitir es un job y no una llamada dentro del cobro por una razón de la
            // propia norma: el art. 16.2 impone un control de flujo entre envíos, así que el envío
            // NO PUEDE ser síncrono con la venta aunque se quisiera. Y por otra de producto: nada
            // de lo que rodea al envío puede impedir cobrar.
            //
            // ⚠️ Su gating es `MainOperativa` y **NO cuelga del interruptor de la sincronización**.
            // `connectivity: "off"` (SYNC-17) apaga el WebSocket de NUESTRA nube, que es una
            // comodidad de producto —«este cliente no quiere nube»—; remitir a la AEAT es una
            // obligación tributaria. Si compartieran interruptor, el atajo para una red patológica
            // convertiría en silencio un TPV conforme en uno que no lo es, y no se notaría: la
            // aplicación se vería perfectamente sana.
            //
            // Cumplir esa regla consiste en NO AÑADIR NADA aquí. Se escribe porque la forma de
            // romperla es que a alguien le parezca razonable, dentro de seis meses, «respetar el
            // modo de conexión» en este job.
            //
            // El `interruptor` de abajo (PROD-06) NO contradice esto, y conviene saber por qué: no
            // es una preferencia del equipo sino una pausa que decide SOPORTE desde la nube cuando
            // una versión manda registros rotos, caduca sola a las 24 h como mucho (lo impone el
            // worker) y se ve en Configuración → Fiscal. Sigue sin haber ninguna forma de que el
            // cliente, o una red mala, dejen de remitir.
            nombre: "verifactu_remitir",
            cada: Duration::from_secs(VERIFACTU_INTERVAL_SECS),
            // Un minuto de margen: el arranque (BD, licencia, WebSocket) va primero, y lo que haya
            // en la cola lleva ahí desde antes de encender el equipo.
            retardo_inicial: Duration::from_secs(60),
            requiere: Requiere::MainOperativa,
            interruptor: Some(Interruptor::VerifactuRemitir),
            ejecutar: tarea(verifactu_remitir),
        },
        Job {
            nombre: "avisos",
            cada: Duration::from_secs(AVISOS_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(60),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(avisos),
        },
        Job {
            // TRAB-01 / RI-01. Era un paso de `init_main`, que en un arranque normal no se llega a
            // ejecutar (la base ya la abrió `setup()`), y un paso de arranque tampoco serviría: un
            // TPV que no se reinicia en días no cerraría nunca nada.
            nombre: "fichajes_colgados",
            cada: Duration::from_secs(FICHAJES_COLGADOS_INTERVAL_SECS),
            // Tras un apagado nocturno ya está vencido y sale sin esperar; esto sólo cuenta en un
            // equipo recién estrenado, donde no hay nada que cerrar.
            retardo_inicial: Duration::from_secs(30),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(fichajes_colgados),
        },
        Job {
            nombre: "caja_sin_cerrar",
            cada: Duration::from_secs(CAJA_ABIERTA_INTERVAL_SECS),
            // Pronto tras arrancar: si el bar cerró anoche sin hacer el arqueo, el aviso tiene que
            // estar ahí cuando abran, no una hora después.
            retardo_inicial: Duration::from_secs(120),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(caja_sin_cerrar),
        },
        Job {
            nombre: "stock_negativo",
            cada: Duration::from_secs(STOCK_NEGATIVO_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(90),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(stock_negativo),
        },
        Job {
            // Reservas desde la web: la agenda de la nube necesita la zona horaria del negocio
            // para saber qué es «hoy». Cambia casi nunca (un TPV que se lleva a Canarias), pero
            // cuando cambia tiene que llegar pronto: ver `ZONA_HORARIA_INTERVAL_SECS`.
            nombre: "zona_horaria",
            cada: Duration::from_secs(ZONA_HORARIA_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(30),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(zona_horaria),
        },
        Job {
            // Reservas desde la web (docs/estudios/reservas-web.md §5.7): el correo al cliente de una
            // reserva web que el restaurante cambia o cancela. La Main lo encola al cambiarla, y esto
            // lo manda cuando hay conexión.
            nombre: "avisos_reserva_web",
            cada: Duration::from_secs(AVISOS_RESERVA_WEB_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(45),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(avisos_reserva_web),
        },
        Job {
            nombre: "imagenes",
            cada: Duration::from_secs(IMAGENES_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(3 * 60),
            // No pide BD ni modo Main: la cola es un fichero de AppData y una Handy también sube
            // fotos. Sin modo elegido el propio cuerpo devuelve "sin_modo" y no hace nada.
            requiere: Requiere::Siempre,
            interruptor: None,
            ejecutar: tarea(imagenes),
        },
        Job {
            nombre: "purga_sync",
            cada: Duration::from_secs(PURGA_SYNC_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(5 * 60),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(purga_sync),
        },
        Job {
            nombre: "reconciliacion",
            cada: Duration::from_secs(RECONCILIACION_INTERVAL_SECS),
            // A los 10 min del arranque: fuera del pico de apertura, pero sin esperar al día
            // siguiente en un equipo que se apaga cada noche (el motor mide el vencimiento en
            // reloj de pared, así que un TPV apagado 12 h lo ejecuta al encender).
            retardo_inicial: Duration::from_secs(10 * 60),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(reconciliacion),
        },
        Job {
            nombre: "backup_local",
            cada: Duration::from_secs(BACKUP_LOCAL_INTERVAL_SECS),
            // La primera copia se hace pronto, pero fuera del camino crítico del arranque.
            retardo_inicial: Duration::from_secs(5 * 60),
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(backup_local),
        },
        Job {
            nombre: "backfill_historico",
            cada: Duration::from_secs(BACKFILL_INTERVAL_SECS),
            // Después de la reconciliación: si el equipo acaba de recuperarse, lo primero es
            // desbloquear el login. `MainOperativa` ya garantiza que no corre durante eso, pero el
            // margen evita competir por el ancho de banda con el catch-up del arranque.
            retardo_inicial: Duration::from_secs(3 * 60),
            // `MainOperativa` es justo lo que hace falta y no una casualidad: mientras la
            // reconciliación de la recuperación está pendiente este job NO corre, así que no compite
            // con la fase 1 ni retrasa el desbloqueo del login.
            requiere: Requiere::MainOperativa,
            interruptor: Some(Interruptor::BackfillHistorico),
            ejecutar: tarea(backfill_historico),
        },
        Job {
            nombre: "verificar_nube",
            cada: Duration::from_secs(VERIFICAR_NUBE_INTERVAL_SECS),
            // Tarde en el arranque: el catch-up del principio todavía está aplicando lo que llegó
            // mientras el equipo estaba apagado, y comparar contra una base a medio poner al día
            // sacaría descuadres que se arreglan solos treinta segundos después. Un aluvión de
            // avisos falsos enseña a ignorar precisamente la alarma que no hay que ignorar.
            retardo_inicial: Duration::from_secs(10 * 60),
            // `MainOperativa` excluye una reconciliación en curso, que es cuando la base local
            // está por definición incompleta.
            requiere: Requiere::MainOperativa,
            interruptor: None,
            ejecutar: tarea(verificar_nube),
        },
        Job {
            nombre: "cifrado_pii",
            cada: Duration::from_secs(CIFRADO_PII_INTERVAL_SECS),
            // Al minuto del arranque: da tiempo a que la activación haya guardado la DEK,
            // sin retrasar la conversión hasta el siguiente ciclo de 6 h.
            retardo_inicial: Duration::from_secs(60),
            requiere: Requiere::MainOperativa,
            interruptor: Some(Interruptor::CifradoPii),
            ejecutar: tarea(cifrado_pii),
        },
    ];

    // El updater no existe en móvil (en Android las actualizaciones van por Google Play).
    #[cfg(desktop)]
    jobs.push(Job {
        nombre: "updater",
        cada: Duration::from_secs(UPDATE_CHECK_INTERVAL_SECS),
        retardo_inicial: Duration::from_secs(UPDATE_CHECK_DELAY_SECS),
        // No depende del modo ni de la BD: comprobar el feed es útil se haya elegido modo o no.
        requiere: Requiere::Siempre,
        interruptor: None,
        ejecutar: tarea(updater),
    });

    jobs
}

// ──────────────────────────────────────────────────────────────────────────────
// Cuerpos
// ──────────────────────────────────────────────────────────────────────────────

/// Pulso periódico de la licencia: revalida contra el worker, renueva el arriendo local y avisa a
/// los administradores (por caducar / caducada-en-gracia / gracia offline).
///
/// Usa `gate` y no `check_now` **a propósito**: `check_now` es la acción manual del botón
/// "Reintentar" y no se apoya en la gracia offline, así que un corte de red devolvería error en vez
/// de dejar seguir trabajando. Además `gate` es el que emite los avisos.
///
/// Corre en Rust (y no en un `setInterval` del frontend) porque la licencia decide si la app puede
/// operar: aquí sobrevive a una recarga del webview y no depende de que haya un componente montado.
async fn licencia(app: AppHandle) -> Result<(), String> {
    // Sin notifier (BD no lista) el gate decide igual; solo se queda sin avisar.
    let notifier = app.state::<AppState>().notifier().await.ok();
    let svc = crate::commands::licensing::svc(&app)?;

    let res = uc_licensing::gate(&svc, notifier.as_deref()).await?;

    // La UI (AppBoot) escucha este evento para repintar el gate sin volver a preguntar.
    app.emit("license:changed", res)
        .map_err(|e| format!("no se pudo emitir license:changed: {e}"))?;
    Ok(())
}

/// RI-36: el pulso del reloj de la gracia offline (`uc_licensing::contar_tiempo_sin_conexion`).
async fn licencia_reloj(app: AppHandle) -> Result<(), String> {
    let svc = crate::commands::licensing::svc(&app)?;
    uc_licensing::contar_tiempo_sin_conexion(&svc).map_err(|e| e.to_string())
}

/// Reconciliación de los valores derivados (INV-06 / DB-14).
///
/// El stock de un lote y el gasto de un cliente se guardan ya sumados, así que un fallo parcial
/// los deja mintiendo sin ningún síntoma: no hay error ni ticket que falte, el número simplemente
/// se queda viejo. Esto los recalcula desde su origen y **avisa**; no corrige nada por su cuenta,
/// ni siquiera el gasto (que sí sería derivable): quien decide qué hacer es quien lleva el negocio.
///
/// Idempotente: recalcular dos veces da lo mismo, y los avisos llevan `clave_dedupe`.
async fn reconciliacion(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    // SYNC-19: con el histórico a medias, esto no informa: MIENTE. Los dos valores "guardados"
    // (`Stock_Disponible`, `Total_Gastado`) son columnas de tablas MAESTRAS, que la fase 1 restaura
    // completas y correctas; los dos "calculados" salen de tablas transaccionales, que durante el
    // backfill están sin la mitad de sus filas. Resultado: prácticamente todos los lotes y todos
    // los clientes con historial saldrían descuadrados.
    //
    // No corrompe nada —el job sólo lee— y el daño es peor que eso: un aluvión de notificaciones
    // falsas justo después de una recuperación enseña al usuario a ignorar precisamente la alarma
    // que no debe ignorar. Al terminar el backfill el job vuelve solo en su siguiente vencimiento,
    // y ESA primera pasada sí es informativa, porque compara sobre datos completos.
    let sync = state.sync_repo().await?;
    let backfill = uc_sync::backfill_estado(sync.as_ref()).await?;
    if backfill.tablas_pendientes > 0 {
        tracing::info!(
            "reconciliacion: saltada, el histórico todavía se está descargando ({} tablas pendientes)",
            backfill.tablas_pendientes
        );
        return Ok(());
    }

    let repo = state.reconciliacion_repo().await?;
    let notifier = state.notifier().await?;

    let r = uc_reconciliacion::ejecutar(repo.as_ref(), notifier.as_ref()).await?;

    // Además del aviso in-app, al log: si esto salta cada día hay un bug aguas arriba, y esa
    // señal la queremos en la telemetría, no solo en una notificación que alguien marca como leída.
    if r.clientes_descuadrados > 0 || r.lotes_descuadrados > 0 {
        tracing::warn!(
            target: "tpv::jobs",
            clientes_descuadrados = r.clientes_descuadrados,
            lotes_descuadrados = r.lotes_descuadrados,
            "reconciliación: valores derivados fuera de cuadre"
        );
    }
    Ok(())
}

/// Escáner de avisos: tareas vencidas y reservas próximas → notificación a los administradores.
/// Las emisiones llevan `clave_dedupe`, así que repetir el escaneo no duplica nada.
async fn avisos(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let scan = state.avisos_scan_repo().await?;
    let notifier = state.notifier().await?;

    uc_avisos::escanear(
        scan.as_ref(),
        notifier.as_ref(),
        uc_avisos::VENTANA_RESERVA_MIN,
    )
    .await?;
    Ok(())
}

/// Deja en la base la zona horaria del reloj de este equipo (reservas desde la web). Se deduce de
/// lo que el reloj se separa de UTC en enero y en julio: el nombre de la zona del sistema sólo se
/// puede leer en Windows con WinRT, que no existe en Windows 7 (ver
/// `tpv_domain::reservas_web::zona_por_desfases`).
async fn zona_horaria(app: AppHandle) -> Result<(), String> {
    use chrono::{Datelike, Local, Offset, TimeZone};

    let anio = Local::now().year();
    let desfase = |mes: u32| {
        Local
            .with_ymd_and_hms(anio, mes, 15, 12, 0, 0)
            .single()
            .map(|d| d.offset().fix().local_minus_utc() / 60)
    };
    let desfases = desfase(1).zip(desfase(7));

    let repo = app.state::<AppState>().reservas_web_repo().await?;
    match uc_reservas_web::sincronizar_zona_horaria(repo.as_ref(), desfases).await? {
        Some(zona) => tracing::info!(target: "tpv::reservas_web", zona, "zona horaria del negocio actualizada"),
        None if desfases.is_some_and(|(i, v)| tpv_domain::reservas_web::zona_por_desfases(i, v).is_none()) => {
            // No es una avería: un PC en UTC o fuera de España. La nube sigue con la que hubiera.
            tracing::warn!(target: "tpv::reservas_web", ?desfases, "zona horaria no reconocida; se deja la guardada");
        }
        None => {}
    }
    Ok(())
}

/// Manda al worker los avisos al cliente de las reservas web que esperan en la cola
/// (`use_cases/reservas_web_avisos.rs`). Con la conectividad apagada no sale nada: se quedan para
/// cuando vuelva.
async fn avisos_reserva_web(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    if crate::load_config(&dir).connectivity == Some(crate::ConnectivityMode::Off) {
        return Ok(());
    }
    let db = app.state::<AppState>().db.lock().await.as_ref().cloned().ok_or("DB no inicializada")?;
    let cola = tpv_infra_sqlite::reservas_web_avisos::SqliteAvisosReservaWeb::new(db);
    // La hora del negocio es la del equipo (RELOJ-01), como el día y la hora de las reservas.
    let ahora_local = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    let r = uc_reservas_web_avisos::enviar(&cola, &PairingAdapter::new(dir), &ahora_local).await?;
    if r.descartados > 0 {
        // Sin datos de nadie: cuántos. La reserva ya ha pasado, lleva un día sin poder salir o el
        // worker no lo acepta.
        tracing::warn!(target: "tpv::reservas_web", descartados = r.descartados, "avisos al cliente descartados sin enviar");
    }
    if r.enviados > 0 || r.pendientes > 0 {
        tracing::info!(target: "tpv::reservas_web", enviados = r.enviados, pendientes = r.pendientes, "avisos al cliente");
    }
    Ok(())
}

/// Escáner de stock negativo (VR-06): productos cuyo stock total ha caído por debajo de cero
/// (sobreventa, típicamente por una venta de la Handy replicada a la Main) → aviso a los
/// administradores. Emite una notificación por producto con `clave_dedupe`, así que seguir
/// vendiéndolo en negativo no genera avisos nuevos; y cierra el de los que se recuperan.
async fn stock_negativo(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let repo = state.stock_alertas_repo().await?;
    let notifier = state.notifier().await?;

    uc_stock_alertas::escanear(repo.as_ref(), notifier.as_ref()).await?;
    Ok(())
}

/// Avisa si la caja lleva demasiado tiempo sin cerrarse (CUENTA-06).
///
/// **Avisa, no cierra.** Un cierre automático se inventaría el recuento: tendría el esperado pero
/// nadie habría abierto el cajón, y guardaría un arqueo con descuadre cero que no ha comprobado
/// nadie. Lo único honrado que puede hacer el programa es dar un toque.
async fn caja_sin_cerrar(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let repo = state.cierre_caja_repo().await?;
    let notifier = state.notifier().await?;

    uc_cierre_caja::avisar_si_lleva_mucho_abierta(
        repo.as_ref(),
        notifier.as_ref(),
        CAJA_ABIERTA_HORAS,
    )
    .await?;
    Ok(())
}

/// Cierra las jornadas que quedaron sin fichar la salida (TRAB-01): las que entraron hace más de
/// 16 h, no las de días anteriores, para no llevarse un turno de noche en curso (RI-05). Las marca
/// como incidencia para revisarlas, sin inventar la hora de salida.
async fn fichajes_colgados(app: AppHandle) -> Result<(), String> {
    let db = app
        .state::<AppState>()
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "DB no inicializada".to_string())?;

    let n = tpv_infra_sqlite::login::auto_close_stale_punches(&db).await?;
    if n > 0 {
        tracing::info!(target: "tpv::fichajes", cerradas = n, "jornadas colgadas cerradas");
    }
    Ok(())
}

/// Si ya se ha contado en este arranque que falta la identidad del productor.
static PRODUCTOR_SIN_IDENTIDAD_AVISADO: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// `true` sólo la primera vez que se pregunta por esa marca.
fn primera_vez(marca: &std::sync::atomic::AtomicBool) -> bool {
    !marca.swap(true, std::sync::atomic::Ordering::Relaxed)
}

/// Remite a la AEAT los registros de facturación pendientes (FISCAL-01).
///
/// El cuerpo es fino porque la decisión vive en el caso de uso, que es donde se puede probar sin
/// red. Aquí sólo se resuelven las dos cosas que sólo el shell sabe —cuál es el certificado
/// elegido y qué hora es— y se traduce el resultado al lenguaje del runner.
///
/// ## Qué es un error y qué no
///
/// Devolver `Err` activa el backoff y pinta el job en rojo en el panel. Eso es lo correcto para un
/// fallo de red o para un rechazo del servicio, que se arreglan reintentando o mirando.
///
/// **No** lo es para «faltan los datos fiscales» ni para «no hay certificado»: eso no se arregla
/// esperando, es una tarea del dueño, y tratarlo como avería llenaría el panel de rojo por algo que
/// el propio panel ya explica mejor en su sección. Esos casos devuelven `Ok` y se anotan en el log.
async fn verifactu_remitir(app: AppHandle) -> Result<(), String> {
    use tpv_application::use_cases::verifactu::{self as uc_verifactu, SinEnviar};

    let state = app.state::<AppState>();
    let repo = state.verifactu_repo().await?;

    // MODO-PRUEBA (temporal): con el modo prueba no hay nada que remitir ni de qué avisar. Se quita
    // entero antes de que Veri*factu sea obligatorio.
    if uc_verifactu::estado(repo.as_ref()).await.is_ok_and(|e| e.modo_prueba) {
        return Ok(());
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("AppData: {e}"))?;
    let certificado = crate::certificado_verifactu(&dir);

    // Sin identidad del productor NO se remite, y es deliberado aunque duela.
    //
    // `Sistema_Json` se congela en la fila al emitir, así que un registro creado con el NIF del
    // productor vacío lo lleva vacío para siempre. Mandarlo sería que la AEAT lo rechazara por
    // formato y que ese rechazo fuese definitivo: la fila ya está escrita y no se recompone al
    // remitir. Callándonos ahora, esos registros esperan a que una versión posterior traiga la
    // constante — y antes del primer envío con ella se corrigen solos (ver más abajo) y salen.
    //
    // Es un bug NUESTRO, no del bar, así que se registra como error y no como aviso: el panel dirá
    // `sin_datos_del_productor` y la escalera de avisos mandará a soporte en vez de a mirar el
    // router.
    if !tpv_infra_sqlite::verifactu::productor_configurado() {
        // Una vez por arranque, no una por vuelta: el job corre cada minuto y el error sube a
        // Sentry, así que un equipo abierto una tarde dejaba cientos de eventos iguales que no
        // dicen nada más que el primero. La constante no cambia sin recompilar, así que tampoco
        // hay nada nuevo que contar hasta el siguiente arranque.
        if primera_vez(&PRODUCTOR_SIN_IDENTIDAD_AVISADO) {
            tracing::error!(
                target: "tpv::verifactu",
                "no se remite: falta la identidad del productor del software (PRODUCTOR_NIF). \
                 Los registros quedan PENDIENTE y se corregirán solos en cuanto la versión la traiga."
            );
        }
        // Se evalúa el aviso igualmente: el bar tiene derecho a saber que lleva sin remitir.
        if let Ok(notifier) = state.notifier().await {
            let _ = uc_verifactu::avisar_de_atraso(repo.as_ref(), notifier.as_ref()).await;
        }
        return Ok(());
    }

    // El aviso del CERTIFICADO, antes de intentar nada. Va aparte del aviso por atraso y por una
    // razón de fondo: aquel mide horas de cola, así que llega tarde por definición —cuando salta, ya
    // se ha dejado de remitir—. Éste llega antes de que pase nada, que es el único momento en que
    // renovar un certificado es un trámite y no una urgencia.
    let cert = crate::commands::verifactu::estado_del_certificado(&dir).await;
    if let Ok(notifier) = state.notifier().await {
        if let Err(e) = uc_verifactu::avisar_del_certificado(notifier.as_ref(), &cert).await {
            tracing::warn!(target: "tpv::verifactu", error = %e, "no se pudo evaluar el aviso del certificado");
        }
        // Y las anomalías de la cadena (art. 7.i). Se leen del mismo estado que pinta el panel.
        if let Ok(e) = uc_verifactu::estado(repo.as_ref()).await {
            let _ = uc_verifactu::avisar_de_anomalias(
                notifier.as_ref(),
                e.anomalias_sin_reconocer,
                e.ultima_anomalia.as_deref(),
            )
            .await;
        }
    }

    // Si el certificado elegido ya no está o caducó, no se intenta: el handshake fallaría seguro y
    // sería una conexión TLS por minuto contra la AEAT para nada. Los registros se quedan
    // `PENDIENTE`, que es de donde salen solos en cuanto alguien elija uno válido.
    //
    // Se paran SÓLO esos dos casos, no el del certificado que pide un PIN: ahí el envío puede
    // funcionar si hay alguien delante, y negarlo garantizaría el fallo donde había una posibilidad.
    if cert.elegido && (!cert.encontrado || cert.dias_para_caducar.is_some_and(|d| d < 0)) {
        tracing::warn!(
            target: "tpv::verifactu",
            encontrado = cert.encontrado,
            dias = ?cert.dias_para_caducar,
            "no se remite: el certificado elegido ya no sirve"
        );
        return Ok(());
    }

    // RI-01: reparar el bloque `SistemaInformatico` es la PRECONDICIÓN del envío, no una tarea de
    // arranque aparte. Vivía en `init_main`, que en un arranque normal no llega a ejecutarla, y un
    // job propio tampoco serviría: los jobs no tienen orden entre sí y éste, vencido tras una
    // actualización, sale el primero. Si la reparación falla, no se remite: un solo envío con el
    // NIF vacío es un rechazo que ya no tiene arreglo. Sólo toca la base cuando el bloque cambia.
    let db = state
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "DB no inicializada".to_string())?;
    tpv_infra_sqlite::verifactu::asegurar_sistema_reparado(&db)
        .await
        .map_err(|e| format!("no se pudo reparar el bloque SistemaInformatico: {e}"))?;

    let ahora_ms = chrono::Local::now().timestamp_millis();
    let cliente = tpv_infra_aeat::AeatAdapter::new();

    let resultado =
        uc_verifactu::remitir_ciclo(repo.as_ref(), &cliente, certificado.as_deref(), ahora_ms).await;

    // La escalera de avisos se evalúa DESPUÉS y SIEMPRE, pase lo que pase arriba: lo que la dispara
    // es la antigüedad del pendiente más viejo, que no depende de si este ciclo envió algo. Se hace
    // aquí y no dentro de `remitir_ciclo` porque el caso de uso del envío no tiene por qué conocer
    // el notificador —y porque los dos caminos que NO envían (cola vacía, control de flujo) salen
    // antes y se saltarían el aviso—.
    //
    // Y es best-effort: que no se pueda emitir una notificación no puede convertir un envío correcto
    // en un job en rojo.
    if let Ok(notifier) = state.notifier().await {
        if let Err(e) = uc_verifactu::avisar_de_atraso(repo.as_ref(), notifier.as_ref()).await {
            tracing::warn!(target: "tpv::verifactu", error = %e, "no se pudo evaluar el aviso por atraso");
        }
    }

    match resultado {
        Ok(Ok(r)) => {
            tracing::info!(
                target: "tpv::verifactu",
                enviados = r.enviados,
                aceptados = r.aceptados,
                con_errores = r.aceptados_con_errores,
                rechazados = r.rechazados,
                "lote remitido a la AEAT"
            );
            // Que la pantalla fiscal se refresque sin tener que recargarla. Es un aviso, no un
            // dato: quien lo reciba vuelve a pedir el estado.
            let _ = app.emit("verifactu:cambio", ());
            Ok(())
        }
        // Las tres razones normales de no enviar. Ninguna es una avería.
        Ok(Err(SinEnviar::ColaVacia)) | Ok(Err(SinEnviar::ControlDeFlujo)) => Ok(()),
        Ok(Err(SinEnviar::SinDatosFiscales)) => {
            tracing::warn!(
                target: "tpv::verifactu",
                "hay registros pendientes y faltan los datos fiscales del negocio: no se puede remitir"
            );
            Ok(())
        }
        Ok(Err(SinEnviar::SinCertificado)) => {
            tracing::warn!(
                target: "tpv::verifactu",
                "hay registros pendientes y no hay certificado elegido: no se puede remitir"
            );
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// PROD-06: ver `crate::interruptores`.
async fn interruptores(app: AppHandle) -> Result<(), String> {
    crate::interruptores::refrescar(&app).await
}

/// Red de seguridad de la subida de imágenes a R2: sube lo que quedó en la cola de AppData.
///
/// El camino normal sigue siendo el evento (tras guardar una imagen, y al reconectar el WS), que es
/// lo que da inmediatez. Este job cubre lo que aquel no puede: una imagen creada sin red cuyo
/// dispositivo no vuelve a guardar ninguna, o una Main con internet pero sin WebSocket.
async fn imagenes(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    crate::drenar_imagenes(&app, &state).await.map(|_| ())
}

/// Poda de `_Sync_Applied_Ops`, la tabla anti-eco: una fila por escritura local, que solo se puede
/// retirar cuando la op ya está confirmada en la nube y ha pasado su TTL. (El outbox no entra aquí:
/// se vacía solo, cada op se borra al recibir su `apply_ack`.)
///
/// Antes iba colgada del drenado del outbox y solo se ejecutaba si esa pasada había subido algo;
/// como job tiene disparador propio y corre también en un equipo online y ocioso.
async fn purga_sync(app: AppHandle) -> Result<(), String> {
    let repo = app.state::<AppState>().sync_repo().await?;
    uc_sync::purge_applied_ops(repo.as_ref()).await?;
    Ok(())
}

/// SYNC-19 · fase 2: trae unas páginas del histórico que la ventana del bootstrap dejó fuera.
///
/// La recuperación desde la nube ya no baja el histórico entero —no cabía, y ese era el techo que
/// hacía que un equipo con tres meses de uso no pudiera rescatarse—: baja lo imprescindible para
/// volver a vender y deja el resto anotado en `_Backfill_Historico`. Esto es lo que lo va trayendo,
/// con el bar ya trabajando.
///
/// Un equipo que nunca ha perdido su base no tiene nada anotado, así que aquí el job es una lectura
/// de una tabla vacía y se acabó.
async fn backfill_historico(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let repo = state.sync_repo().await?;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    let filas = uc_sync::backfill_paso(&PairingAdapter::new(dir), repo.as_ref()).await?;
    if filas > 0 {
        let estado = uc_sync::backfill_estado(repo.as_ref()).await?;
        tracing::info!(
            target: "tpv::jobs",
            filas,
            pendientes = estado.tablas_pendientes,
            completadas = estado.tablas_completadas,
            "histórico: página(s) traída(s)"
        );
    }
    Ok(())
}

/// SYNC-24: comprueba que la nube y esta base dicen lo mismo, repara lo que pueda y lo informa.
///
/// Existe porque el sistema tenía una asimetría incómoda: si una operación no llegaba a subir, la
/// Handy —que no tiene base local y lee de la nube— enseñaba al camarero un mundo distinto del que
/// veía la Main, y nada lo comprobaba nunca. SYNC-22 arregla el caso conocido (una operación
/// apartada) en el momento; esto es la red para el que no se conoce.
///
/// El informe NO va al usuario. Un descuadre no lo puede atender quien está delante del TPV, así
/// que avisarle sería un mensaje que aprende a descartar; va al worker y de ahí a Axiom, donde lo
/// ve quien puede arreglarlo sin tener que mirar nada.
async fn verificar_nube(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let repo = state.sync_repo().await?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;

    // PROD-06: con `reparacion_nube` apagado se compara e informa igual, pero no se escribe nada.
    let reparar = crate::interruptores::apagado(&app, Interruptor::ReparacionNube).is_none();
    let r = uc_sync::verificar_contra_la_nube(&PairingAdapter::new(dir), repo.as_ref(), reparar)
        .await?;

    if r.descuadres.is_empty() {
        tracing::debug!(target: "tpv::jobs", "verificación: la nube y la base local coinciden");
    } else {
        // A nivel WARN y con el detalle: esto es lo que alguien lee cuando un cliente dice que la
        // tablet enseña otra cosa.
        tracing::warn!(
            target: "tpv::jobs",
            tablas = r.descuadres.len(),
            reparadas = r.reparadas,
            ventana_omitida = r.ventana_omitida,
            detalle = ?r.descuadres,
            "verificación: la nube NO coincide con la base local"
        );
    }
    Ok(())
}

async fn backup_local(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Error obteniendo AppData: {e}"))?;
    let db = app
        .state::<AppState>()
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "DB no inicializada".to_string())?;

    if let Some(copia) = tpv_infra_sqlite::recovery::create_backup(&db, &dir).await? {
        tracing::info!(
            target: "tpv::jobs",
            backup = %copia.id,
            bytes = copia.size_bytes,
            "copia local diaria creada"
        );
    }

    // Recolección de los restos que deja una restauración (`pre-restore-*`, `failed-restore-*`,
    // temporales). No entran en la retención de siete porque no son copias diarias, y sin esto
    // cada intento de recuperación dejaba una BD entera en AppData para siempre. Aquí es el sitio:
    // el job sólo corre con la Main ya operativa, o sea con la restauración terminada.
    tpv_infra_sqlite::recovery::purge_restore_leftovers(&dir)?;
    Ok(())
}

/// TRAB-03: convierte a texto cifrado la PII del personal (DNI/IBAN/nº SS) que siga en claro.
///
/// Existe porque el cifrado se activó sobre una base de datos que ya tenía trabajadores dados de
/// alta: las escrituras nuevas ya nacen cifradas, pero las filas antiguas no se convierten solas.
/// Idempotente y barato: si no hay nada pendiente, es un SELECT y se acabó.
async fn cifrado_pii(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    let conn = state
        .db
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "DB no inicializada".to_string())?;

    let repo = tpv_infra_sqlite::trabajadores::SqliteTrabajadoresRepository::with_cipher(
        conn,
        crate::field_cipher(),
    );

    let n = repo.cifrar_pii_pendiente().await?;
    if n > 0 {
        tracing::info!("cifrado_pii: {n} fichas de personal convertidas a texto cifrado");
    }
    Ok(())
}

/// Chequeo del feed de actualizaciones. Si hay versión nueva, `check_and_announce` emite el evento
/// del banner y la notificación in-app (con dedupe por versión).
#[cfg(desktop)]
async fn updater(app: AppHandle) -> Result<(), String> {
    crate::check_and_announce(&app).await.map(|_| ())
}

#[cfg(test)]
mod tests_primera_vez {
    use super::primera_vez;
    use std::sync::atomic::AtomicBool;

    /// El aviso de que falta la identidad del productor sale una vez por arranque, no cada minuto.
    #[test]
    fn solo_la_primera_vuelta_avisa() {
        let marca = AtomicBool::new(false);
        assert!(primera_vez(&marca));
        assert!(!primera_vez(&marca));
        assert!(!primera_vez(&marca));
    }
}
