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
use tpv_application::use_cases::licensing as uc_licensing;
use tpv_application::use_cases::sync as uc_sync;

use super::{tarea, Job, Requiere};
use crate::AppState;

/// Cada cuánto se revalida la licencia contra el worker mientras la app está abierta.
const LICENCIA_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// Cada cuánto se buscan tareas vencidas y reservas próximas.
const AVISOS_INTERVAL_SECS: u64 = 10 * 60;

/// Cada cuánto se reintenta subir a R2 lo que quedó pendiente. No hace falta más a menudo: el
/// camino normal es el evento (tras guardar la imagen y al reconectar el WS); esto es la red.
const IMAGENES_INTERVAL_SECS: u64 = 15 * 60;

/// Cada cuánto se busca PII del personal todavía en claro. No hace falta más: sólo hay trabajo
/// la primera vez tras activar el cifrado (y tras un cambio de equipo que traiga filas viejas).
const CIFRADO_PII_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// Cada cuánto se poda `_Sync_Applied_Ops`. Los registros solo son purgables tras un TTL de 72 h,
/// así que una pasada al día va sobrada.
const PURGA_SYNC_INTERVAL_SECS: u64 = 24 * 60 * 60;

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
            requiere: Requiere::MainConBd,
            ejecutar: tarea(licencia),
        },
        Job {
            nombre: "avisos",
            cada: Duration::from_secs(AVISOS_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(60),
            requiere: Requiere::MainConBd,
            ejecutar: tarea(avisos),
        },
        Job {
            nombre: "imagenes",
            cada: Duration::from_secs(IMAGENES_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(3 * 60),
            // No pide BD ni modo Main: la cola es un fichero de AppData y una Handy también sube
            // fotos. Sin modo elegido el propio cuerpo devuelve "sin_modo" y no hace nada.
            requiere: Requiere::Siempre,
            ejecutar: tarea(imagenes),
        },
        Job {
            nombre: "purga_sync",
            cada: Duration::from_secs(PURGA_SYNC_INTERVAL_SECS),
            retardo_inicial: Duration::from_secs(5 * 60),
            requiere: Requiere::MainConBd,
            ejecutar: tarea(purga_sync),
        },
        Job {
            nombre: "cifrado_pii",
            cada: Duration::from_secs(CIFRADO_PII_INTERVAL_SECS),
            // Al minuto del arranque: da tiempo a que la activación haya guardado la DEK,
            // sin retrasar la conversión hasta el siguiente ciclo de 6 h.
            retardo_inicial: Duration::from_secs(60),
            requiere: Requiere::MainConBd,
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

/// Red de seguridad de la subida de imágenes a R2: sube lo que quedó en la cola de AppData.
///
/// El camino normal sigue siendo el evento (tras guardar una imagen, y al reconectar el WS), que es
/// lo que da inmediatez. Este job cubre lo que aquel no puede: una imagen creada sin red cuyo
/// dispositivo no vuelve a guardar ninguna, o una Main con internet pero sin WebSocket. Antes esto
/// lo hacía un `setInterval` de 3 s colgado del socket, que dependía de la condición equivocada.
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
        log::info!("cifrado_pii: {n} fichas de personal convertidas a texto cifrado");
    }
    Ok(())
}

/// Chequeo del feed de actualizaciones. Si hay versión nueva, `check_and_announce` emite el evento
/// del banner y la notificación in-app (con dedupe por versión).
#[cfg(desktop)]
async fn updater(app: AppHandle) -> Result<(), String> {
    crate::check_and_announce(&app).await.map(|_| ())
}
