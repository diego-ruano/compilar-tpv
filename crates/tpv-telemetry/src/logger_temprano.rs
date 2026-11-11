//! A dónde va lo que llega por la fachada `log`. En Android, el logger de plataforma (`android.rs`)
//! lo manda a Logcat durante el arranque y a `tracing`, por el puente, cuando hay subscriber. El
//! estado vive aquí, fuera de `android.rs`, para poder probar en escritorio lo que deja un `init`
//! que falla (AUD-29).

use std::sync::atomic::{AtomicU8, Ordering};

const LOGCAT: u8 = 0;
const TRACING: u8 = 1;
const NINGUNO: u8 = 2;

/// El del proceso. Lo cambia `montar` y lo lee el logger de plataforma de Android.
pub(crate) static ESTADO: Estado = Estado(AtomicU8::new(LOGCAT));

pub(crate) struct Estado(AtomicU8);

/// A dónde va ahora lo que llega por `log`.
#[cfg(any(target_os = "android", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Destino {
    /// El arranque, antes de `init`.
    Logcat,
    /// Con el subscriber montado.
    Tracing,
    /// A ningún sitio.
    Ninguno,
}

impl Estado {
    #[cfg(any(target_os = "android", test))]
    pub(crate) fn destino(&self) -> Destino {
        match self.0.load(Ordering::Acquire) {
            LOGCAT => Destino::Logcat,
            TRACING => Destino::Tracing,
            _ => Destino::Ninguno,
        }
    }

    /// Al empezar `init` (AUD-29). Sin `depuracion`, lo que llega por `log` deja de ir a Logcat
    /// desde aquí. Si `init` falla antes de montar el subscriber (el fichero de logs no se puede
    /// crear), el puente no llega a montarse, y sin esto el logger temprano seguiría escribiendo en
    /// Logcat todo lo que registra la app, sin filtro: con la feature `log` de `tracing`, un evento sin
    /// subscriber sale por `log`. En depuración (el APK de `tauri android dev` y el de E2E) el
    /// arranque sigue en Logcat hasta que lo sustituye el puente. Con el puente ya montado (un
    /// segundo `init`) no cambia nada.
    pub(crate) fn al_empezar_init(&self, depuracion: bool) {
        if !depuracion {
            let _ = self.0.compare_exchange(LOGCAT, NINGUNO, Ordering::AcqRel, Ordering::Acquire);
        }
    }

    /// Con el subscriber montado, lo de `log` va a `tracing` por el puente.
    pub(crate) fn activar(&self) {
        self.0.store(TRACING, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nuevo() -> Estado {
        Estado(AtomicU8::new(LOGCAT))
    }

    #[test]
    fn el_arranque_va_a_logcat() {
        assert_eq!(nuevo().destino(), Destino::Logcat);
    }

    #[test]
    fn en_release_logcat_se_calla_al_empezar_init_aunque_no_se_monte_el_subscriber() {
        let e = nuevo();
        e.al_empezar_init(false);
        assert_eq!(e.destino(), Destino::Ninguno);
        e.activar();
        assert_eq!(e.destino(), Destino::Tracing);
    }

    #[test]
    fn en_depuracion_el_arranque_sigue_en_logcat_hasta_el_puente() {
        let e = nuevo();
        e.al_empezar_init(true);
        assert_eq!(e.destino(), Destino::Logcat);
        e.activar();
        assert_eq!(e.destino(), Destino::Tracing);
    }

    #[test]
    fn un_segundo_init_no_quita_el_puente() {
        for depuracion in [false, true] {
            let e = nuevo();
            e.activar();
            e.al_empezar_init(depuracion);
            assert_eq!(e.destino(), Destino::Tracing);
        }
    }
}
