//! Raíz de los directorios temporales de los tests.
//!
//! Cada test abre su BD en un directorio propio de `%TEMP%`, y nadie los borraba: cada pasada del
//! suite dejaba ~150 carpetas con su `data.db` y su WAL. Se habían acumulado más de 18.000 (casi
//! 4 GB).
//!
//! **Se limpian al EMPEZAR, no al terminar.** Borrarlos al acabar cada test no funciona: en
//! `let (db, _dir) = …` el directorio se suelta ANTES que la BD, y Windows no deja borrar un
//! fichero que sigue abierto. Al empezar, en cambio, lo que quede de una ejecución anterior está
//! cerrado desde hace rato.
//!
//! Todo cuelga de una raíz común (`%TEMP%/tpv_tests`), así que la purga sólo mira lo nuestro y
//! nunca puede llevarse por delante un temporal de otro programa.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Once, OnceLock};

const RAIZ: &str = "tpv_tests";

/// El suite entero tarda segundos, así que una hora es margen de sobra para no tocar los
/// directorios de otra ejecución en curso —la del IDE mientras tú lanzas la tuya, o el proceso
/// de al lado cuando el runner reparte los tests entre varios.
const ANTIGUEDAD_MINIMA: std::time::Duration = std::time::Duration::from_secs(60 * 60);

static PURGA: Once = Once::new();

fn purgar_restos(raiz: &PathBuf) {
    let Ok(entradas) = std::fs::read_dir(raiz) else {
        return;
    };
    let ahora = std::time::SystemTime::now();
    for entrada in entradas.flatten() {
        let vieja = entrada
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| ahora.duration_since(t).ok())
            .is_some_and(|d| d >= ANTIGUEDAD_MINIMA);
        if vieja {
            let _ = std::fs::remove_dir_all(entrada.path());
        }
    }
}

/// Raíz bajo la que cada fixture crea su directorio. La primera llamada del proceso barre lo que
/// dejaron las ejecuciones anteriores.
pub fn raiz_temporal() -> PathBuf {
    let raiz = std::env::temp_dir().join(RAIZ);
    PURGA.call_once(|| {
        // Antes de purgar hay que poder leerla; si no se puede crear, los `create_dir_all` de cada
        // fixture fallarán con un error claro y no hace falta añadir otro aquí.
        let _ = std::fs::create_dir_all(&raiz);
        purgar_restos(&raiz);
    });
    raiz
}

/// Directorio propio para un test, ya creado.
///
/// El nombre **no puede depender sólo del PID**. Con un proceso por test (nextest) Windows recicla
/// los identificadores dentro de la misma tanda, dos tests caen en el mismo directorio y el segundo
/// abre la BD ya sembrada del primero: `UNIQUE constraint failed` en el seed, en tests distintos
/// cada vez. Por eso el nombre lleva además un número aleatorio **por proceso** —el de
/// `RandomState`, que el runtime siembra al azar en cada arranque— y un contador para los tests que
/// piden varios.
pub fn dir_temporal(prefijo: &str) -> PathBuf {
    use std::hash::{BuildHasher, Hasher};

    static SEMILLA: OnceLock<u64> = OnceLock::new();
    static CONTADOR: AtomicU64 = AtomicU64::new(0);

    let semilla = *SEMILLA.get_or_init(|| {
        std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish()
    });

    let dir = raiz_temporal().join(format!(
        "{prefijo}_{}_{semilla:x}_{}",
        std::process::id(),
        CONTADOR.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).expect("creando el directorio temporal del test");
    dir
}
