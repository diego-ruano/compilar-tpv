//! # Runner de jobs periódicos
//!
//! **Motor** de las tareas de fondo de la app. Todo lo que haya que hacer "cada X tiempo" y cuyo
//! dueño sea la app (no una pantalla ni una conexión) se declara en [`registro::catalogo`] y corre
//! aquí, con la misma política para todos. Para añadir un job nuevo NO se toca este fichero: se
//! añade una entrada al catálogo.
//!
//! ## Qué garantiza el motor (y por eso ningún job lo reimplementa)
//!
//! - **Vencimiento en reloj de pared.** El ciclo se mide contra `Last_Ok_Ms` persistido en
//!   `_Jobs_State`, no contra el tiempo de proceso. Un job de 6 h se ejecuta igual en un equipo que
//!   se apaga cada noche, y uno vencido durante una suspensión larga se dispara al despertar.
//! - **Jitter.** Los ticks se desincronizan entre dispositivos para no pegarle al mismo endpoint
//!   en el mismo segundo.
//! - **Backoff.** Un job que falla reintenta con espera creciente acotada en vez de esperar el
//!   intervalo entero (o de martillear un servicio caído).
//! - **Gating por modo.** Un job que necesita la Main con BD no se ejecuta —ni despierta a fallar—
//!   en Handy o antes de elegir modo.
//! - **A prueba de panics.** El cuerpo corre en su propia task: un panic se registra como fallo en
//!   vez de matar el bucle y dejar el job muerto en silencio hasta el siguiente reinicio.
//! - **Visible.** Cada intento queda en `_Jobs_State` y se expone por `jobs_status` en
//!   Configuración → Conectividad.
//!
//! ## Qué NO entra aquí (a propósito)
//!
//! - Lo que pertenece al ciclo de vida del **WebSocket** (ping, drenado del outbox, reconexión):
//!   es una máquina de estados de la conexión, no un pulso periódico. Vive en `useMainSocket`.
//! - Lo que pertenece al ciclo de vida de una **pantalla** (polling de un panel abierto, cuentas
//!   atrás, debounces): ahí el montaje/desmontaje del componente ya es la política correcta.
//! - La **telemetría**, que mantiene su propio hilo y su spool con backoff propio: su drenado es
//!   una cola caliente (1 s) fuera del camino de emisión, no una comprobación periódica.
//!
//! No hay cancelación: hoy nada la dispararía (el cambio de modo lo resuelve el gating y la salida
//! del proceso se lleva las tasks por delante). Si algún día hace falta parar un job en caliente,
//! el sitio es un `select!` sobre un `watch::Receiver` en [`correr`].

pub(crate) mod registro;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use tauri::{AppHandle, Manager};

use tpv_application::ports::jobs::{EstadoJob, JobsStateRepository};
use tpv_application::use_cases::jobs as uc;
use tpv_contracts::jobs::JobStatus;

use crate::AppState;

/// Espera base del backoff tras el primer fallo (se dobla en cada fallo consecutivo).
const BACKOFF_BASE: Duration = Duration::from_secs(60);

/// Techo del backoff: un servicio caído se reintenta como mucho cada media hora.
const BACKOFF_TECHO: Duration = Duration::from_secs(30 * 60);

/// Cada cuánto se vuelve a mirar si un job bloqueado por su `Requiere` ya puede correr.
const ESPERA_GATE: Duration = Duration::from_secs(60);

/// Tope absoluto del jitter, para que un job de intervalo largo no se retrase de más.
const JITTER_TECHO: Duration = Duration::from_secs(5 * 60);

/// Cuerpo de un job ya empaquetado. Se construye con [`tarea`].
type Ejecutar =
    Box<dyn Fn(AppHandle) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> + Send + Sync>;

/// Envuelve una `async fn(AppHandle) -> Result<(), String>` como cuerpo de job.
pub(crate) fn tarea<F, Fut>(f: F) -> Ejecutar
where
    F: Fn(AppHandle) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), String>> + Send + 'static,
{
    Box::new(move |app| Box::pin(f(app)))
}

/// Condición previa para ejecutar un job. Se comprueba en cada vencimiento, así que un cambio de
/// modo en caliente no necesita reiniciar nada: el job simplemente deja de (o vuelve a) ejecutarse.
pub(crate) enum Requiere {
    /// Cualquier modo, con o sin BD.
    Siempre,
    /// Solo la Main (modo TPV) y con la BD local abierta.
    MainConBd,
}

impl Requiere {
    async fn cumplido(&self, app: &AppHandle) -> bool {
        match self {
            Requiere::Siempre => true,
            Requiere::MainConBd => app.state::<AppState>().es_main_con_bd().await,
        }
    }
}

/// Un job periódico. Todos los campos son política; el cuerpo es lo único específico.
pub(crate) struct Job {
    /// Identificador estable: clave en `_Jobs_State` y etiqueta en logs (`job=<nombre>`).
    /// Cambiarlo hace que el job pierda su historial y se trate como nuevo.
    pub nombre: &'static str,
    /// Cada cuánto vence, contado desde la última ejecución CORRECTA.
    pub cada: Duration,
    /// Espera antes del primer intento cuando no hay historial (instalación nueva). Sirve para
    /// dejar que el arranque —BD, licencia, WebSocket— termine antes de meter más trabajo.
    pub retardo_inicial: Duration,
    /// Condición previa (ver [`Requiere`]).
    pub requiere: Requiere,
    /// Qué hace el job. Devolver `Err` cuenta como fallo (backoff + queda en el panel).
    pub ejecutar: Ejecutar,
}

fn ahora_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Arranca un bucle por job del catálogo. Se llama una vez, en el `setup()` de Tauri y **después**
/// de `app.manage(AppState)`: los cuerpos resuelven sus repositorios desde el estado global.
pub(crate) fn arrancar(app: &AppHandle) {
    for job in registro::catalogo() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tracing::info!(
                target: "tpv::jobs",
                job = job.nombre,
                cada_secs = job.cada.as_secs(),
                "job registrado"
            );
            correr(app, job).await;
        });
    }
}

/// Bucle de un job: esperar lo que toque → comprobar la condición → ejecutar → registrar.
async fn correr(app: AppHandle, job: Job) {
    let mut estado = match repo(&app).await {
        Some(r) => uc::cargar(r.as_ref(), job.nombre).await.unwrap_or_default(),
        // Sin BD todavía (Handy, o antes de elegir modo): se arranca sin historial. En cuanto la
        // haya, el primer registro lo persiste y a partir de ahí ya sobrevive a los reinicios.
        None => EstadoJob::default(),
    };

    loop {
        let espera = proxima_espera(
            &estado,
            job.cada,
            job.retardo_inicial,
            ahora_ms(),
            jitter(job.cada),
        );
        tokio::time::sleep(espera).await;

        if !job.requiere.cumplido(&app).await {
            tokio::time::sleep(ESPERA_GATE).await;
            continue;
        }

        // El cuerpo va en su propia task: un panic se convierte en un fallo registrado en lugar de
        // reventar este bucle (que dejaría el job muerto hasta el siguiente arranque de la app).
        let resultado = match tokio::spawn((job.ejecutar)(app.clone())).await {
            Ok(r) => r,
            Err(e) => Err(format!("panic en el job: {e}")),
        };

        match &resultado {
            Ok(()) => tracing::debug!(target: "tpv::jobs", job = job.nombre, "ejecutado"),
            Err(e) => tracing::warn!(
                target: "tpv::jobs",
                job = job.nombre,
                error = %e,
                fallos = estado.fallos + 1,
                "job falló (se reintentará con backoff)"
            ),
        }

        estado = uc::aplicar_resultado(estado, resultado, ahora_ms());

        // Persistir es best-effort: si la BD no está (aún) disponible, el job sigue corriendo con
        // su estado en memoria; lo único que se pierde es la memoria entre arranques.
        if let Some(r) = repo(&app).await {
            if let Err(e) = uc::registrar(r.as_ref(), job.nombre, &estado).await {
                tracing::warn!(target: "tpv::jobs", job = job.nombre, error = %e, "no se pudo persistir el estado");
            }
        }
    }
}

/// Cuánto esperar antes del siguiente intento. Pura a propósito (el jitter entra por parámetro):
/// es la política de planificación entera y se puede probar sin reloj ni BD.
fn proxima_espera(
    estado: &EstadoJob,
    cada: Duration,
    retardo_inicial: Duration,
    ahora_ms: i64,
    jitter: Duration,
) -> Duration {
    // Fallando: backoff exponencial acotado, para no martillear un servicio caído.
    if estado.fallos > 0 {
        return backoff(estado.fallos) + jitter;
    }

    match estado.last_ok_ms {
        // Nunca se ejecutó con éxito en este equipo: margen de arranque (ya escalona de por sí).
        None => retardo_inicial,
        Some(ok) => {
            let restante = cada.as_millis() as i64 - (ahora_ms - ok).max(0);
            if restante <= 0 {
                // Vencido: la app estuvo cerrada, o el equipo suspendido, más de un ciclo entero.
                Duration::ZERO
            } else {
                Duration::from_millis(restante as u64) + jitter
            }
        }
    }
}

fn backoff(fallos: i64) -> Duration {
    let exp = fallos.saturating_sub(1).clamp(0, 16) as u32;
    BACKOFF_BASE
        .saturating_mul(2u32.saturating_pow(exp))
        .min(BACKOFF_TECHO)
}

/// Desincroniza los ticks entre dispositivos: sin esto, todos los TPV que arrancaron a la vez
/// pegarían al mismo endpoint en el mismo segundo cada ciclo. Hasta un 10 % del intervalo.
fn jitter(cada: Duration) -> Duration {
    let techo = (cada / 10).min(JITTER_TECHO);
    if techo.is_zero() {
        return Duration::ZERO;
    }
    Duration::from_millis(rand::thread_rng().gen_range(0..=techo.as_millis() as u64))
}

async fn repo(app: &AppHandle) -> Option<Arc<dyn JobsStateRepository>> {
    app.state::<AppState>().jobs_state_repo().await.ok()
}

/// Foto de todos los jobs registrados para el panel de diagnóstico. Parte del catálogo (no de la
/// tabla) para que un job que aún no se ha ejecutado nunca también aparezca, en blanco.
pub(crate) async fn estado_actual(app: &AppHandle) -> Result<Vec<JobStatus>, String> {
    let guardados = match repo(app).await {
        Some(r) => uc::listar(r.as_ref()).await.unwrap_or_default(),
        None => Vec::new(),
    };

    Ok(registro::catalogo()
        .into_iter()
        .map(|job| {
            let e = guardados
                .iter()
                .find(|(n, _)| n == job.nombre)
                .map(|(_, e)| e.clone())
                .unwrap_or_default();

            JobStatus {
                nombre: job.nombre.to_string(),
                cada_secs: job.cada.as_secs() as i64,
                last_run_ms: e.last_run_ms,
                last_ok_ms: e.last_ok_ms,
                last_error: e.last_error,
                fallos: e.fallos,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CADA: Duration = Duration::from_secs(6 * 60 * 60);
    const INICIAL: Duration = Duration::from_secs(30);
    const SIN_JITTER: Duration = Duration::ZERO;

    fn con_ok(last_ok_ms: i64) -> EstadoJob {
        EstadoJob {
            last_run_ms: Some(last_ok_ms),
            last_ok_ms: Some(last_ok_ms),
            last_error: None,
            fallos: 0,
        }
    }

    #[test]
    fn sin_historial_espera_el_retardo_inicial() {
        let e = EstadoJob::default();
        assert_eq!(
            proxima_espera(&e, CADA, INICIAL, 1_000_000, SIN_JITTER),
            INICIAL
        );
    }

    #[test]
    fn recien_ejecutado_espera_el_intervalo_completo() {
        let ahora = 1_000_000;
        let e = con_ok(ahora);
        assert_eq!(proxima_espera(&e, CADA, INICIAL, ahora, SIN_JITTER), CADA);
    }

    #[test]
    fn a_media_ventana_espera_solo_lo_que_falta() {
        let ahora = 10_000_000;
        let e = con_ok(ahora - 2 * 60 * 60 * 1000); // ejecutado hace 2 h de las 6 h
        assert_eq!(
            proxima_espera(&e, CADA, INICIAL, ahora, SIN_JITTER),
            Duration::from_secs(4 * 60 * 60)
        );
    }

    /// El caso que motiva persistir `Last_Ok_Ms`: la app estuvo cerrada (o el equipo suspendido)
    /// más de un ciclo entero. Al arrancar, el job está vencido y se ejecuta ya, sin esperar.
    #[test]
    fn vencido_tras_un_apagon_largo_se_ejecuta_ya() {
        let ahora = 100_000_000;
        let e = con_ok(ahora - 30 * 60 * 60 * 1000); // hace 30 h
        assert_eq!(
            proxima_espera(&e, CADA, INICIAL, ahora, SIN_JITTER),
            Duration::ZERO
        );
    }

    /// Reloj movido hacia atrás (cambio de hora, NTP): `ahora < last_ok`. No debe entrar en pánico
    /// ni calcular una espera negativa; se trata como "recién ejecutado".
    #[test]
    fn un_reloj_hacia_atras_no_rompe_el_calculo() {
        let ahora = 1_000_000;
        let e = con_ok(ahora + 9_999_999);
        assert_eq!(proxima_espera(&e, CADA, INICIAL, ahora, SIN_JITTER), CADA);
    }

    #[test]
    fn los_fallos_mandan_sobre_el_intervalo_y_hacen_backoff() {
        let ahora = 1_000_000;
        let mut e = con_ok(ahora);
        e.fallos = 1;
        assert_eq!(
            proxima_espera(&e, CADA, INICIAL, ahora, SIN_JITTER),
            BACKOFF_BASE
        );

        e.fallos = 3;
        assert_eq!(
            proxima_espera(&e, CADA, INICIAL, ahora, SIN_JITTER),
            BACKOFF_BASE * 4
        );
    }

    #[test]
    fn el_backoff_esta_acotado() {
        assert_eq!(backoff(99), BACKOFF_TECHO);
        assert_eq!(backoff(1), BACKOFF_BASE);
    }

    #[test]
    fn el_jitter_nunca_pasa_del_diez_por_ciento_ni_del_techo() {
        for _ in 0..100 {
            assert!(jitter(Duration::from_secs(600)) <= Duration::from_secs(60));
            assert!(jitter(Duration::from_secs(48 * 60 * 60)) <= JITTER_TECHO);
        }
    }
}
