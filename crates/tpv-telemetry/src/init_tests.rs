//! nextest aísla cada prueba en su proceso: subscriber y logger son globales.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use crate::{TelemetryConfig, GUARD, STATE};
use crate::test_support::TestDir;

struct ExistingLogger(AtomicUsize);
impl log::Log for ExistingLogger {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool { true }
    fn log(&self, _: &log::Record<'_>) { self.0.fetch_add(1, Ordering::Relaxed); }
    fn flush(&self) {}
}
static EXISTING: ExistingLogger = ExistingLogger(AtomicUsize::new(0));

fn start(dir: &TestDir) {
    let mut cfg = TelemetryConfig::local_only(dir.0.clone(), "test");
    cfg.console = false;
    crate::init(cfg).unwrap();
    assert!(GUARD.get().is_some());
    assert!(STATE.get().is_some());
}

fn wait_for_log(dir: &TestDir, message: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let found = std::fs::read_dir(dir.0.join("logs")).unwrap().any(|entry| {
            std::fs::read_to_string(entry.unwrap().path()).unwrap_or_default().contains(message)
        });
        if found { return; }
        assert!(Instant::now() < deadline, "no llegó el mensaje al fichero local");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn un_logger_previo_no_deja_la_telemetria_a_medias() {
    log::set_logger(&EXISTING).unwrap();
    log::set_max_level(log::LevelFilter::Info);
    tracing::warn!("diagnóstico antes del subscriber");
    assert_eq!(EXISTING.0.load(Ordering::Relaxed), 1);
    let dir = TestDir::new();
    start(&dir);
    tracing::info!("subscriber y appender activos");
    wait_for_log(&dir, "subscriber y appender activos");
    let second = TelemetryConfig::local_only(dir.0.clone(), "test");
    assert!(crate::init(second).is_err());
    tracing::info!("el segundo init conserva el primer appender");
    wait_for_log(&dir, "el segundo init conserva el primer appender");
}

#[test]
fn log_de_dependencias_llega_a_los_destinos_de_tracing_en_escritorio() {
    let dir = TestDir::new();
    start(&dir);
    log::warn!(target: "tpv::test", "dependencia externa a tracing");
    wait_for_log(&dir, "dependencia externa a tracing");
    assert!(STATE.get().unwrap().drain().iter()
        .any(|event| event.message == "dependencia externa a tracing"));
}

// ── AUD-29: Logcat, sólo en una compilación de depuración ──────────────────────────────────────────
//
// `android::Logcat` sólo compila para Android. Aquí se monta la misma capa (`capa_de_logcat`) con un
// writer que hace lo que `android::Line`: un búfer por evento que se entrega entero al soltarse. Sin
// subscriber global (`with_default` vale para este hilo), así que no choca con los tests de arriba.

#[derive(Clone, Default)]
struct LogcatDePrueba(std::sync::Arc<std::sync::Mutex<Vec<String>>>);

struct LineaDePrueba {
    destino: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    bufer: Vec<u8>,
}

impl std::io::Write for LineaDePrueba {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bufer.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if !self.bufer.is_empty() {
            self.destino.lock().unwrap().push(String::from_utf8_lossy(&self.bufer).into_owned());
            self.bufer.clear();
        }
        Ok(())
    }
}

impl Drop for LineaDePrueba {
    fn drop(&mut self) {
        let _ = std::io::Write::flush(self);
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogcatDePrueba {
    type Writer = LineaDePrueba;
    fn make_writer(&'a self) -> LineaDePrueba {
        LineaDePrueba { destino: self.0.clone(), bufer: Vec::new() }
    }
}

/// Lo que llegaría a Logcat con la capa montada según `depuracion`: el aviso con el que
/// `commands/telemetria.rs` registra el fallo de un comando de la Handy sin red (datos ficticios).
fn lo_que_llega_a_logcat(depuracion: bool) -> Vec<String> {
    use tracing_subscriber::prelude::*;
    let logcat = LogcatDePrueba::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("info"))
        .with(crate::capa_de_logcat(depuracion, logcat.clone()));
    tracing::subscriber::with_default(subscriber, || {
        tracing::warn!(
            target: crate::TARGET_FALLOS_DE_COMANDOS,
            comando = "reservas_buscar_cliente",
            code = "external",
            "reservas_buscar_cliente falló (external): No se ha podido conectar con el servidor. \
             (error sending request for url (https://api.example.invalid/v1/reservas/buscar-cliente\
             ?telefono=612345678&email=ana.prueba%40example.com))"
        );
    });
    let lineas = logcat.0.lock().unwrap().clone();
    lineas
}

#[test]
fn sin_depuracion_no_llega_nada_a_logcat() {
    assert_eq!(lo_que_llega_a_logcat(false), Vec::<String>::new());
    // Con la capa, el mismo fallo llega entero, con el teléfono y el correo del cliente.
    let lineas = lo_que_llega_a_logcat(true);
    assert_eq!(lineas.len(), 1, "{lineas:?}");
    assert!(lineas[0].contains("WARN tpv::comandos: reservas_buscar_cliente falló"), "{lineas:?}");
    assert!(lineas[0].contains("telefono=612345678&email=ana.prueba%40example.com"), "{lineas:?}");
}

#[test]
fn android_monta_la_capa_de_logcat_solo_en_depuracion() {
    // `montar` no se puede compilar aquí para Android: se mira la línea que monta la capa y lo que
    // le pasa `init`. Lo que decide es `cfg!(debug_assertions)`; con un `true`, o con la capa hecha
    // a mano, el APK de release volvería a escribir en Logcat.
    let fuente = include_str!("lib.rs").replace("\r\n", "\n");
    assert!(
        fuente.contains(
            "pub fn init(config: TelemetryConfig) -> Result<(), TelemetryError> {\n    \
             montar(config, cfg!(debug_assertions))\n}"
        ),
        "`init` decide la compilación con `cfg!(debug_assertions)`"
    );
    let marca = "#[cfg(target_os = \"android\")]\n    let logcat_layer = ";
    let i = fuente.find(marca).expect("la capa de Logcat de Android, en `montar`") + marca.len();
    let declaracion = &fuente[i..i + fuente[i..].find(';').unwrap()];
    assert_eq!(declaracion, "capa_de_logcat(depuracion, android::Logcat)");
    assert_eq!(fuente.matches("android::Logcat").count(), 1, "nadie más escribe en Logcat");
}

// ── AUD-29: un `init` que falla no deja abierto Logcat ────────────────────────────────────────────
//
// Si el fichero de logs no se puede crear (el almacenamiento lleno), `montar` sale antes de montar
// el subscriber y el puente. En Android, el logger temprano seguiría entonces copiando en Logcat todo
// lo que registra la app (con la feature `log` de `tracing`, un evento sin subscriber sale por `log`):
// en release se calla al empezar `montar`. Aquí no hay logger de Android, pero sí el estado que lee
// (`logger_temprano::ESTADO`), y un `init` que falla de verdad.

/// Una carpeta de datos donde `logs` es un fichero: el appender no puede crear el suyo.
fn sin_sitio_para_los_logs() -> (TestDir, TelemetryConfig) {
    let dir = TestDir::new();
    std::fs::write(dir.0.join("logs"), b"no es una carpeta").unwrap();
    let mut cfg = TelemetryConfig::local_only(dir.0.clone(), "test");
    cfg.console = false;
    (dir, cfg)
}

#[test]
fn un_init_que_falla_en_release_no_deja_lo_de_log_en_logcat() {
    use crate::logger_temprano::{Destino, ESTADO};
    let (_dir, cfg) = sin_sitio_para_los_logs();
    assert_eq!(ESTADO.destino(), Destino::Logcat, "el arranque, antes de `init`");

    let error = crate::montar(cfg, false).expect_err("sin carpeta de logs, `init` falla");
    assert!(error.to_string().contains("rolling appender"), "{error}");
    assert!(!tracing::dispatcher::has_been_set(), "no queda subscriber");
    assert!(GUARD.get().is_none() && STATE.get().is_none());
    assert_eq!(ESTADO.destino(), Destino::Ninguno);
}

#[test]
fn un_init_que_falla_en_depuracion_deja_el_arranque_en_logcat() {
    use crate::logger_temprano::{Destino, ESTADO};
    let (_dir, cfg) = sin_sitio_para_los_logs();
    assert!(crate::montar(cfg, true).is_err());
    assert_eq!(ESTADO.destino(), Destino::Logcat);
}

#[test]
fn con_el_subscriber_montado_lo_de_log_va_a_tracing() {
    use crate::logger_temprano::{Destino, ESTADO};
    let dir = TestDir::new();
    let mut cfg = TelemetryConfig::local_only(dir.0.clone(), "test");
    cfg.console = false;
    crate::montar(cfg, false).unwrap();
    assert_eq!(ESTADO.destino(), Destino::Tracing);
}
