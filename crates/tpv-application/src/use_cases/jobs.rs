//! Casos de uso del **estado de los jobs** periódicos.
//!
//! Aquí vive la única regla del ciclo de vida de un job: cómo evoluciona su estado tras un intento.
//! El motor del runner (en el shell Tauri) decide CUÁNDO ejecutar; esta capa decide QUÉ queda
//! registrado, y es lo que hace que el backoff y el vencimiento sean iguales para todos los jobs.

use crate::error::AppResult;
use crate::ports::jobs::{EstadoJob, JobsStateRepository};

/// Estado de arranque de un job: lo persistido, o "nunca ejecutado".
pub async fn cargar(repo: &dyn JobsStateRepository, nombre: &str) -> AppResult<EstadoJob> {
    Ok(repo.cargar(nombre).await?.unwrap_or_default())
}

/// Aplica el resultado de un intento al estado del job.
///
/// - Éxito: `last_ok_ms` avanza (reinicia el vencimiento) y el contador de fallos se pone a 0.
/// - Fallo: `last_ok_ms` NO se toca (el job sigue vencido y se reintentará con backoff) y se
///   guarda el error para que el panel de diagnóstico lo enseñe.
///
/// En ambos casos `last_run_ms` marca el intento: la diferencia entre `last_run_ms` y `last_ok_ms`
/// es justo lo que delata a un job que lleva tiempo intentándolo sin conseguirlo.
pub fn aplicar_resultado(
    mut estado: EstadoJob,
    resultado: Result<(), String>,
    ahora_ms: i64,
) -> EstadoJob {
    estado.last_run_ms = Some(ahora_ms);
    match resultado {
        Ok(()) => {
            estado.last_ok_ms = Some(ahora_ms);
            estado.last_error = None;
            estado.fallos = 0;
        }
        Err(e) => {
            estado.last_error = Some(e);
            estado.fallos = estado.fallos.saturating_add(1);
        }
    }
    estado
}

/// Persiste el estado tras un intento. Best-effort desde el runner: si esto falla (BD cerrada al
/// apagar, disco lleno) el job sigue corriendo con su estado en memoria; solo se pierde la memoria
/// entre arranques.
pub async fn registrar(
    repo: &dyn JobsStateRepository,
    nombre: &str,
    estado: &EstadoJob,
) -> AppResult<()> {
    repo.guardar(nombre, estado).await
}

/// Todos los estados guardados, indexados por nombre de job.
pub async fn listar(repo: &dyn JobsStateRepository) -> AppResult<Vec<(String, EstadoJob)>> {
    repo.listar().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_exito_avanza_el_vencimiento_y_limpia_el_error() {
        let previo = EstadoJob {
            last_run_ms: Some(100),
            last_ok_ms: Some(100),
            last_error: Some("feed caído".into()),
            fallos: 3,
        };

        let e = aplicar_resultado(previo, Ok(()), 500);

        assert_eq!(e.last_ok_ms, Some(500));
        assert_eq!(e.last_run_ms, Some(500));
        assert_eq!(e.last_error, None);
        assert_eq!(e.fallos, 0);
    }

    #[test]
    fn el_fallo_no_avanza_el_vencimiento_y_acumula() {
        let previo = EstadoJob {
            last_run_ms: Some(100),
            last_ok_ms: Some(100),
            last_error: None,
            fallos: 0,
        };

        let e = aplicar_resultado(previo, Err("sin red".into()), 500);

        // Clave: el job sigue vencido (last_ok_ms intacto) → se reintentará, no se dará por hecho.
        assert_eq!(e.last_ok_ms, Some(100));
        assert_eq!(e.last_run_ms, Some(500));
        assert_eq!(e.last_error.as_deref(), Some("sin red"));
        assert_eq!(e.fallos, 1);

        let e = aplicar_resultado(e, Err("sin red".into()), 900);
        assert_eq!(e.fallos, 2);
    }

    #[test]
    fn un_job_nuevo_parte_de_cero() {
        let e = aplicar_resultado(EstadoJob::default(), Ok(()), 42);
        assert_eq!(e.last_ok_ms, Some(42));
        assert_eq!(e.fallos, 0);
    }
}
