//! PROD-06 · Interruptores remotos de emergencia: lo que la nube ha apagado en este equipo.
//!
//! El job `interruptores` pregunta cada pocos minutos y deja aquí la respuesta; los jobs y
//! comandos afectados preguntan con [`apagado`]. La decisión de qué vale y cuánto la toma
//! `tpv_application::use_cases::interruptores`; esto sólo la guarda.
//!
//! Dos sitios, y por qué:
//!
//! - **En memoria** para que preguntar no cueste nada (lo hace el motor en cada vencimiento).
//! - **En AppData** (`interruptores.json`) para que reiniciar la aplicación no encienda de golpe algo
//!   que se apagó a propósito hace diez minutos. Lo que se lee de ahí caduca igual que lo demás: a
//!   la hora de la consulta, o antes si el apagado dura menos.
//!
//! Si el fichero no existe, no se puede leer o está roto, todo está encendido.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use tpv_application::use_cases::interruptores::{self as uc, Instantanea};
use tpv_contracts::interruptores::{Interruptor, InterruptorApagado};
use tpv_infra_licensing::PairingAdapter;

use crate::AppState;

/// Nombre del fichero en AppData. Está en el `deny` de escritura de la webview
/// (`capabilities/default.json`, REV-24): escribir aquí apaga partes del programa.
pub(crate) const FICHERO: &str = "interruptores.json";

/// `None` = todavía no se ha leído el fichero en este proceso.
static FOTO: Mutex<Option<Instantanea>> = Mutex::new(None);

fn ahora_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ruta(dir: &Path) -> PathBuf {
    dir.join(FICHERO)
}

fn leer_fichero(dir: &Path) -> Instantanea {
    std::fs::read(ruta(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn escribir_fichero(dir: &Path, foto: &Instantanea) -> Result<(), String> {
    let p = ruta(dir);
    let tmp = p.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(foto).map_err(|e| e.to_string())?;
    // AUD-28: el nombre del fichero y no la ruta de AppData, que lleva el usuario de Windows. El
    // error sube al motor de jobs, que lo registra (Axiom) y lo guarda en el estado del job. El
    // `io::Error` no cita la ruta.
    std::fs::write(&tmp, bytes).map_err(|e| format!("No se pudo escribir {FICHERO}.tmp: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("No se pudo renombrar {FICHERO}.tmp a {FICHERO}: {e}"))
}

fn foto(app: &AppHandle) -> Instantanea {
    let mut g = FOTO.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        let leida = app
            .path()
            .app_data_dir()
            .map(|d| leer_fichero(&d))
            .unwrap_or_default();
        *g = Some(leida);
    }
    g.clone().unwrap_or_default()
}

/// ¿Está apagado este interruptor ahora mismo? `None` = encendido (también si no se sabe).
pub(crate) fn apagado(app: &AppHandle, interruptor: Interruptor) -> Option<InterruptorApagado> {
    uc::apagado(&foto(app), interruptor, ahora_ms())
}

/// Todo lo apagado ahora mismo, para enseñarlo en pantalla.
pub(crate) fn vigentes(app: &AppHandle) -> Vec<InterruptorApagado> {
    uc::vigentes(&foto(app), ahora_ms())
}

/// Cuerpo del job: pregunta a la nube y guarda la respuesta.
///
/// Si falla, devuelve `Err` (el motor lo reintenta y sale en el panel) y **no toca** lo que había:
/// eso sigue valiendo hasta su caducidad y luego todo vuelve a estar encendido.
pub(crate) async fn refrescar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let Some(modo) = crate::signing_mode(*state.mode.lock().await) else {
        return Ok(());
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("AppData: {e}"))?;
    let version = app.package_info().version.to_string();

    let nueva = uc::consultar(&PairingAdapter::new(dir.clone()), modo, &version, ahora_ms())
        .await
        .map_err(|e| e.to_string())?;

    let antes: Vec<Interruptor> = vigentes(app).into_iter().map(|a| a.interruptor).collect();
    let despues = uc::vigentes(&nueva, ahora_ms());
    for a in &despues {
        if !antes.contains(&a.interruptor) {
            // AUD-28: sin el motivo, que es texto libre de quien lo apaga; se guarda y se enseña en
            // pantalla, pero no sale del equipo.
            tracing::warn!(
                target: "tpv::interruptores",
                interruptor = ?a.interruptor,
                hasta_ms = a.hasta_ms,
                "apagado desde la nube"
            );
        }
    }
    for i in &antes {
        if !despues.iter().any(|a| a.interruptor == *i) {
            tracing::info!(target: "tpv::interruptores", interruptor = ?i, "vuelve a estar encendido");
        }
    }

    // Primero el fichero y después la memoria: si el disco falla, que se note (Err) y que lo que se
    // obedece en este proceso no se adelante a lo que sobreviviría a un reinicio. Pero la memoria
    // se actualiza igual, porque la respuesta de la nube es la buena.
    let escrito = escribir_fichero(&dir, &nueva);
    *FOTO.lock().unwrap_or_else(|e| e.into_inner()) = Some(nueva);
    escrito
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_fichero_roto_o_ausente_es_todo_encendido() {
        let dir = std::env::temp_dir().join(format!("tpv_interruptores_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let _ = std::fs::remove_file(ruta(&dir));
        assert_eq!(leer_fichero(&dir), Instantanea::default());

        std::fs::write(ruta(&dir), b"{ esto no es json").unwrap();
        assert_eq!(leer_fichero(&dir), Instantanea::default());

        let foto = Instantanea {
            consultado_ms: 123,
            apagados: vec![InterruptorApagado {
                interruptor: Interruptor::ColaDo,
                motivo: "m".into(),
                hasta_ms: 456,
            }],
        };
        escribir_fichero(&dir, &foto).unwrap();
        assert_eq!(leer_fichero(&dir), foto);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AUD-28: si no se puede guardar, el error dice qué fichero y qué operación, no la ruta de
    /// AppData (lleva el usuario de Windows y sale del equipo con el estado del job).
    #[test]
    fn un_fallo_al_guardar_no_dice_la_ruta() {
        let dir = std::env::temp_dir().join(format!(
            "tpv_interruptores_aud28_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let carpeta = dir.to_string_lossy().to_string();
        let tmp = ruta(&dir).with_extension("json.tmp");

        // El temporal es una carpeta: escribirlo falla.
        std::fs::create_dir_all(&tmp).unwrap();
        let e = escribir_fichero(&dir, &Instantanea::default()).unwrap_err();
        assert!(e.starts_with("No se pudo escribir interruptores.json.tmp: "), "{e}");
        assert!(!e.contains(&carpeta) && !e.contains("tpv_interruptores_aud28"), "{e}");

        // El definitivo es una carpeta con algo dentro: renombrar encima falla.
        std::fs::remove_dir_all(&tmp).unwrap();
        std::fs::create_dir_all(ruta(&dir).join("dentro")).unwrap();
        let e = escribir_fichero(&dir, &Instantanea::default()).unwrap_err();
        assert!(e.starts_with("No se pudo renombrar interruptores.json.tmp a interruptores.json: "), "{e}");
        assert!(!e.contains(&carpeta) && !e.contains("tpv_interruptores_aud28"), "{e}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
