//! El **tamaño de la interfaz** en el escritorio: el zoom de la ventana.
//!
//! En una pantalla estrecha (un monitor 4:3 de 1024, un portátil con el escalado de Windows al
//! 125 %) la interfaz se maquetaba para muy poco ancho y la venta rápida enseñaba dos columnas. Con
//! el zoom, la página se ve como en una pantalla de [`ANCHO_DE_REFERENCIA`] y todo se escala por
//! igual, menú incluido: las proporciones no cambian.
//!
//! Es el zoom del propio WebView y no un `zoom`/`transform` de CSS: con el CSS, el Chromium del
//! WebView2 de Windows 7 (109) descuadra las coordenadas del puntero en el canvas del plano.
//!
//! Por defecto es **automático** y sale del monitor, no de la ventana: una ventana pequeña en un
//! monitor grande se queda al 100 % y la maqueta responde a su tamaño. Con `+`/`−` en la barra de
//! arriba pasa a manual en este equipo (`device_config.json`).

use std::sync::Mutex;

use tpv_contracts::ventana::{CambioZoom, ZoomVentana};

/// El ancho, en píxeles de CSS, para el que está pensada la interfaz.
pub const ANCHO_DE_REFERENCIA: f64 = 1280.0;
pub const ZOOM_MINIMO: f64 = 0.7;
pub const ZOOM_MAXIMO: f64 = 1.3;

/// Lo que hay que recordar mientras corre la app: el zoom fijado a mano (`None` = automático) y el
/// último aplicado, para no repetirlo en cada movimiento de la ventana.
struct Estado {
    manual: Option<f64>,
    aplicado: Option<f64>,
}

static ESTADO: Mutex<Estado> = Mutex::new(Estado { manual: None, aplicado: None });

fn estado() -> std::sync::MutexGuard<'static, Estado> {
    ESTADO.lock().unwrap_or_else(|e| e.into_inner())
}

/// A dos decimales: los pasos son del 5 % y del 10 %, y así no se arrastran restos de coma flotante.
fn redondear(z: f64) -> f64 {
    (z * 100.0).round() / 100.0
}

/// El zoom automático para un monitor de `ancho_css` píxeles de CSS: lo justo para que quepa el
/// ancho de referencia, hacia abajo y en pasos del 5 %. Nunca agranda, y un ancho desconocido es 100 %.
#[cfg_attr(mobile, allow(dead_code))]
pub fn automatico(ancho_css: f64) -> f64 {
    if !ancho_css.is_finite() || ancho_css <= 0.0 {
        return 1.0;
    }
    let justo = (ancho_css / ANCHO_DE_REFERENCIA).min(1.0);
    redondear(((justo * 20.0) + 1e-9).floor() / 20.0).max(ZOOM_MINIMO)
}

/// Un paso más grande, al siguiente múltiplo del 10 % (del 85 % automático se pasa al 90 %).
pub fn acercar(z: f64) -> f64 {
    redondear((((z * 10.0) + 1e-9).floor() + 1.0) / 10.0).min(ZOOM_MAXIMO)
}

/// Un paso más pequeño, al múltiplo del 10 % anterior (del 85 % se pasa al 80 %).
pub fn alejar(z: f64) -> f64 {
    redondear((((z * 10.0) - 1e-9).ceil() - 1.0) / 10.0).max(ZOOM_MINIMO)
}

/// Lo guardado en `device_config.json`, acotado: un valor fuera de rango o roto es automático.
pub fn fijar_manual(zoom: Option<f64>) {
    let zoom = zoom.filter(|z| z.is_finite()).map(|z| redondear(z.clamp(ZOOM_MINIMO, ZOOM_MAXIMO)));
    estado().manual = zoom;
}

/// El zoom aplicado ahora (100 % si todavía no se ha aplicado ninguno).
fn aplicado() -> f64 {
    estado().aplicado.unwrap_or(1.0)
}

pub fn actual() -> ZoomVentana {
    let automatico = estado().manual.is_none();
    ZoomVentana { porcentaje: (aplicado() * 100.0).round() as u32, automatico }
}

/// El zoom manual que resulta de un cambio desde la barra (`None` = automático).
pub fn tras_el_cambio(cambio: CambioZoom) -> Option<f64> {
    let ahora = aplicado();
    match cambio {
        CambioZoom::Acercar => Some(acercar(ahora)),
        CambioZoom::Alejar => Some(alejar(ahora)),
        CambioZoom::Automatico => None,
    }
}

/// Aplica el zoom que toca: el manual, o el automático del monitor en el que está la ventana. Se
/// llama al arrancar, al cambiarlo y cada vez que la ventana se mueve o cambia de tamaño (puede
/// haber pasado a otro monitor).
#[cfg(desktop)]
pub fn aplicar(ventana: &tauri::WebviewWindow) {
    let mut e = estado();
    let zoom = e.manual.unwrap_or_else(|| automatico(ancho_del_monitor(ventana)));
    if e.aplicado == Some(zoom) {
        return;
    }
    match ventana.set_zoom(zoom) {
        Ok(()) => e.aplicado = Some(zoom),
        Err(error) => tracing::warn!(target: "tpv::ventana", %error, zoom, "no se pudo ajustar el zoom"),
    }
}

/// Ancho del monitor en píxeles de CSS (los físicos entre el escalado de Windows). 0 si no se sabe.
#[cfg(desktop)]
fn ancho_del_monitor(ventana: &tauri::WebviewWindow) -> f64 {
    match ventana.current_monitor() {
        Ok(Some(monitor)) => f64::from(monitor.size().width) / monitor.scale_factor(),
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_pantalla_de_1024_se_ve_como_una_de_1280() {
        assert_eq!(automatico(1024.0), 0.8);
    }

    #[test]
    fn un_portatil_al_125_por_ciento_cabe_entero() {
        // 1366 físicos al 125 % son 1092,8 de CSS: el 85 % deja 1285, que cabe.
        let z = automatico(1366.0 / 1.25);
        assert_eq!(z, 0.85);
        assert!(1366.0 / 1.25 / z >= ANCHO_DE_REFERENCIA);
    }

    #[test]
    fn una_pantalla_grande_no_se_agranda() {
        assert_eq!(automatico(1280.0), 1.0);
        assert_eq!(automatico(1920.0), 1.0);
        assert_eq!(automatico(3840.0), 1.0);
    }

    #[test]
    fn una_pantalla_diminuta_no_baja_del_minimo() {
        assert_eq!(automatico(640.0), ZOOM_MINIMO);
    }

    #[test]
    fn sin_saber_el_monitor_no_se_toca_nada() {
        assert_eq!(automatico(0.0), 1.0);
        assert_eq!(automatico(f64::NAN), 1.0);
    }

    #[test]
    fn los_botones_van_de_diez_en_diez_desde_cualquier_punto() {
        assert_eq!(acercar(0.85), 0.9);
        assert_eq!(alejar(0.85), 0.8);
        assert_eq!(acercar(0.9), 1.0);
        assert_eq!(alejar(1.0), 0.9);
        assert_eq!(acercar(1.0), 1.1);
    }

    #[test]
    fn los_botones_no_pasan_de_los_limites() {
        assert_eq!(alejar(ZOOM_MINIMO), ZOOM_MINIMO);
        assert_eq!(acercar(ZOOM_MAXIMO), ZOOM_MAXIMO);
    }

    #[test]
    fn subir_y_bajar_vuelve_al_mismo_sitio() {
        let mut z = 0.7;
        for _ in 0..6 {
            z = acercar(z);
        }
        assert_eq!(z, 1.3);
        for _ in 0..6 {
            z = alejar(z);
        }
        assert_eq!(z, 0.7);
    }

    #[test]
    fn un_zoom_guardado_fuera_de_rango_se_acota_y_uno_roto_es_automatico() {
        fijar_manual(Some(5.0));
        assert_eq!(estado().manual, Some(ZOOM_MAXIMO));
        fijar_manual(Some(f64::NAN));
        assert_eq!(estado().manual, None);
    }
}
