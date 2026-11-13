//! VERIF-02 · El contraste con la nube, cuando toca.
//!
//! El job `verificar_nube` pasa por aquí cada cuarto de hora. Casi siempre no toca, y entonces esto
//! es media docena de lecturas locales: la regla (`tpv_domain::verificacion_nube::cuando_verificar`)
//! decide con lo que hay en la base y nada sale hacia la nube. Cuando toca, se contrasta
//! (`use_cases::sync::verificar_contra_la_nube`) y se anota cómo ha ido, que es de lo que vive la
//! regla la vez siguiente.

use tpv_contracts::sync::ResultadoVerificacion;
use tpv_domain::verificacion_nube::{cuando_verificar, Decision, EntradaVerificacion, Espera};

use crate::error::AppResult;
use crate::ports::licensing::PairingService;
use crate::ports::sync::SyncRepository;
use crate::ports::verificacion_nube::{IntentoVerificacion, VerificacionNubeRepository};
use crate::use_cases::sync::{verificar_contra_la_nube, Contraste};

/// Lo que la base no sabe del momento y trae quien llama.
#[derive(Debug, Clone, Copy)]
pub struct Momento {
    /// La hora, en milisegundos de época.
    pub ahora_ms: i64,
    /// Lo que lleva arrancada la aplicación, en reloj monótono.
    pub desde_el_arranque_ms: i64,
    /// Main con datos sanos y sin una recuperación en curso.
    pub main_operativa: bool,
}

/// Lo que ha hecho una vuelta del job.
#[derive(Debug)]
pub enum Vuelta {
    /// No tocaba: nada ha salido hacia la nube.
    NoToca(Espera),
    /// La foto de la nube iba por delante de lo que ha bajado esta Main: no se ha comparado, y se
    /// vuelve a intentar a los diez minutos.
    Aplazada,
    /// Se ha contrastado.
    Hecha(ResultadoVerificacion),
}

/// Una vuelta del job: decide si toca y, si toca, contrasta y lo anota.
///
/// Un fallo del contraste se anota (es lo que hace que el siguiente intento espere 30 min, 1 h…
/// hasta 6 h) y se devuelve como error, que es como el motor de jobs se entera.
pub async fn verificar_si_toca(
    nube: &dyn PairingService,
    sync: &dyn SyncRepository,
    estado: &dyn VerificacionNubeRepository,
    momento: Momento,
    reparar: bool,
) -> AppResult<Vuelta> {
    let s = estado.situacion().await?;
    let entrada = EntradaVerificacion {
        ultima_ok_ms: s.ultima_ok_ms,
        ultimo_intento_ms: s.ultimo_intento_ms,
        fallos: s.fallos,
        ultimo_cierre_ms: s.ultimo_cierre_ms,
        main_operativa: momento.main_operativa,
        historico_pendiente: s.historico_pendiente,
        outbox_pendiente: s.outbox_pendiente,
        bajada_detenida: s.bajada_detenida,
        desde_el_arranque_ms: momento.desde_el_arranque_ms,
        ultima_escritura_ms: s.ultima_escritura_ms,
    };
    if let Decision::Esperar(motivo) = cuando_verificar(&entrada, momento.ahora_ms) {
        return Ok(Vuelta::NoToca(motivo));
    }

    // La hora que se anota es la de antes de pedir nada: un cierre de caja hecho mientras se
    // contrasta queda como posterior a esta pasada, y es motivo para la siguiente.
    match verificar_contra_la_nube(nube, sync, reparar).await {
        Ok(Contraste::Hecho(resultado)) => {
            estado.anotar(IntentoVerificacion::Hecha, momento.ahora_ms).await?;
            Ok(Vuelta::Hecha(resultado))
        }
        Ok(Contraste::FotoPorDelante) => {
            estado.anotar(IntentoVerificacion::Aplazada, momento.ahora_ms).await?;
            Ok(Vuelta::Aplazada)
        }
        // La cola del histórico se ha sembrado entre la lectura de arriba y ésta.
        Ok(Contraste::HistoricoPendiente) => Ok(Vuelta::NoToca(Espera::HistoricoPendiente)),
        Err(e) => {
            // Si ni siquiera se puede anotar, el error que cuenta sigue siendo el del contraste:
            // lo único que se pierde es la espera, y el siguiente intento sale en la próxima vuelta.
            let _ = estado.anotar(IntentoVerificacion::Fallida, momento.ahora_ms).await;
            Err(e)
        }
    }
}
