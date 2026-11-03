//! Registro de **los fallos de comandos** que ve la pantalla (capa fina).
//!
//! Todo comando pasa por `invocar` (`@tpv/client`); cuando uno falla, `fallosDeComandos.ts` decide
//! su gravedad por el código y lo cuenta aquí. Esto sólo lo escribe con `tracing`, que lo lleva al
//! log local y a Axiom por la cola en disco: lo que falla sin red llega al volver.
//!
//! Sin sesión a propósito: también falla lo que pasa antes del login, y es lo que más cuesta
//! averiguar después. No escribe nada de negocio.

use tpv_contracts::errors::AppErrorDto;
use tpv_contracts::telemetria::{FalloDeComando, GravedadFallo};
use tpv_telemetry::TARGET_FALLOS_DE_COMANDOS;

#[tauri::command]
#[specta::specta]
pub async fn telemetria_fallo_de_comando(args: FalloDeComando) -> Result<(), AppErrorDto> {
    registrar(&args);
    Ok(())
}

/// `programa` sale como `error!` para que cuente en la tasa de errores del dispositivo en Axiom;
/// a Sentry no va desde aquí (`filtro_de_sentry`): lo manda la pantalla, con lo que se pulsó antes.
fn registrar(f: &FalloDeComando) {
    let texto = match f.mensaje.as_deref() {
        Some(mensaje) => format!("{} falló ({}): {mensaje}", f.comando, f.code.wire()),
        None => format!("{} falló ({})", f.comando, f.code.wire()),
    };
    let pantalla = f.pantalla.as_deref().unwrap_or("");

    macro_rules! emitir {
        ($nivel:ident) => {
            tracing::$nivel!(
                target: TARGET_FALLOS_DE_COMANDOS,
                comando = %f.comando,
                code = f.code.wire(),
                gravedad = ?f.gravedad,
                pantalla,
                duracion_ms = f.duracion_ms,
                veces = f.veces,
                "{texto}"
            )
        };
    }
    match f.gravedad {
        GravedadFallo::Programa => emitir!(error),
        GravedadFallo::Entorno => emitir!(warn),
        GravedadFallo::Normal => emitir!(info),
    }
}
