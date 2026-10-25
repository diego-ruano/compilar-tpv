//! PROD-06 · Interruptores remotos de emergencia: qué tiene apagado este equipo.
//!
//! La nube (`POST /v1/interruptores`) dice qué tareas automáticas están apagadas para este negocio
//! y esta versión. Aquí se decide qué hacer con esa respuesta, y la regla que manda sobre todo lo
//! demás es que **un interruptor es un freno de mano, no una dependencia**:
//!
//! - Si no se sabe nada de la nube, todo está **encendido**, que es como funcionaba el TPV antes
//!   de que esto existiera.
//! - Lo último que dijo la nube vale [`VIGENCIA_CONSULTA_MS`] (una hora). Pasado eso sin volver a
//!   saber de ella, se olvida: un equipo sin red no puede quedarse con una tarea parada porque la
//!   última vez que habló con la nube estaba apagada.
//! - Cada apagado trae su propia caducidad y, pasada ésta, está encendido aunque la consulta sea
//!   reciente.
//!
//! Esto sólo decide; guardar la foto en AppData y preguntar a la nube es cosa del shell.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tpv_contracts::interruptores::{Interruptor, InterruptorApagado};

use crate::error::{AppError, AppResult};
use crate::ports::licensing::PairingService;

/// Cuánto vale lo último que dijo la nube si no se vuelve a saber de ella.
pub const VIGENCIA_CONSULTA_MS: i64 = 60 * 60 * 1000;

/// Lo último que dijo la nube, y cuándo. Es lo que se persiste en AppData para que un reinicio no
/// encienda de golpe algo que se apagó a propósito hace diez minutos.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Instantanea {
    pub consultado_ms: i64,
    pub apagados: Vec<InterruptorApagado>,
}

/// Pregunta a la nube. `version` es la de este binario: la nube la usa para los apagados que
/// sólo afectan a un rango de versiones.
pub async fn consultar(
    nube: &dyn PairingService,
    modo: &str,
    version: &str,
    ahora_ms: i64,
) -> AppResult<Instantanea> {
    let bruto = nube
        .tpv_server_post_json(modo, "/v1/interruptores", json!({ "version": version }))
        .await?;
    Ok(Instantanea {
        consultado_ms: ahora_ms,
        apagados: leer_respuesta(bruto)?,
    })
}

/// Interpreta `{ ok, apagados: [...] }`.
///
/// Cada elemento se lee por separado y el que no se entiende **se salta**: un worker más nuevo que
/// este binario puede mandar un interruptor que aquí no existe, y eso no puede tirar la respuesta
/// entera (que dejaría encendido también lo que sí se entiende).
pub fn leer_respuesta(bruto: JsonValue) -> AppResult<Vec<InterruptorApagado>> {
    let lista = bruto
        .get("apagados")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            AppError::Internal("respuesta de /v1/interruptores sin `apagados`".to_string())
        })?;
    Ok(lista
        .iter()
        .filter_map(|v| serde_json::from_value::<InterruptorApagado>(v.clone()).ok())
        .collect())
}

/// Lo que está apagado AHORA según la foto. Vacío si la foto es demasiado vieja.
pub fn vigentes(foto: &Instantanea, ahora_ms: i64) -> Vec<InterruptorApagado> {
    if ahora_ms.saturating_sub(foto.consultado_ms) > VIGENCIA_CONSULTA_MS {
        return Vec::new();
    }
    foto.apagados
        .iter()
        .filter(|a| a.hasta_ms > ahora_ms)
        .cloned()
        .collect()
}

/// ¿Está apagado este interruptor ahora? Devuelve el apagado (con su motivo), o `None`.
pub fn apagado(
    foto: &Instantanea,
    interruptor: Interruptor,
    ahora_ms: i64,
) -> Option<InterruptorApagado> {
    vigentes(foto, ahora_ms)
        .into_iter()
        .find(|a| a.interruptor == interruptor)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AHORA: i64 = 1_800_000_000_000;
    const MIN: i64 = 60_000;

    fn apagado_hasta(i: Interruptor, hasta_ms: i64) -> InterruptorApagado {
        InterruptorApagado {
            interruptor: i,
            motivo: "pruebas".into(),
            hasta_ms,
        }
    }

    #[test]
    fn sin_saber_nada_de_la_nube_todo_esta_encendido() {
        let foto = Instantanea::default();
        assert!(apagado(&foto, Interruptor::VolcadoAtraso, AHORA).is_none());
    }

    #[test]
    fn un_apagado_reciente_se_obedece() {
        let foto = Instantanea {
            consultado_ms: AHORA - 5 * MIN,
            apagados: vec![apagado_hasta(Interruptor::ReparacionNube, AHORA + 60 * MIN)],
        };
        assert!(apagado(&foto, Interruptor::ReparacionNube, AHORA).is_some());
        assert!(apagado(&foto, Interruptor::VolcadoAtraso, AHORA).is_none());
    }

    #[test]
    fn un_apagado_caducado_esta_encendido_aunque_la_consulta_sea_reciente() {
        let foto = Instantanea {
            consultado_ms: AHORA - MIN,
            apagados: vec![apagado_hasta(Interruptor::ReparacionNube, AHORA)],
        };
        assert!(apagado(&foto, Interruptor::ReparacionNube, AHORA).is_none());
    }

    #[test]
    fn lo_que_dijo_la_nube_hace_mas_de_una_hora_se_olvida() {
        // Es lo que impide que un equipo sin red se quede con una tarea parada: el apagado duraba
        // 24 h, pero no se ha podido confirmar en la última hora.
        let foto = Instantanea {
            consultado_ms: AHORA - VIGENCIA_CONSULTA_MS - 1,
            apagados: vec![apagado_hasta(Interruptor::VolcadoAtraso, AHORA + 20 * 60 * MIN)],
        };
        assert!(apagado(&foto, Interruptor::VolcadoAtraso, AHORA).is_none());

        let justo = Instantanea {
            consultado_ms: AHORA - VIGENCIA_CONSULTA_MS,
            ..foto
        };
        assert!(apagado(&justo, Interruptor::VolcadoAtraso, AHORA).is_some());
    }

    #[test]
    fn la_respuesta_se_lee_elemento_a_elemento() {
        let bruto = json!({
            "ok": true,
            "apagados": [
                { "interruptor": "reparacion_nube", "motivo": "x", "hasta_ms": AHORA },
                { "interruptor": "uno_del_futuro", "motivo": "y", "hasta_ms": AHORA },
                { "interruptor": "imagenes" },
            ]
        });
        let lista = leer_respuesta(bruto).unwrap();
        assert_eq!(lista.len(), 1);
        assert_eq!(lista[0].interruptor, Interruptor::ReparacionNube);
    }

    #[test]
    fn una_respuesta_sin_lista_es_un_error_y_no_un_todo_encendido_silencioso() {
        // Un error hace que el job falle y se vea en el panel; la foto anterior sigue valiendo
        // hasta que caduque, que es lo que protege de un worker que conteste basura.
        assert!(leer_respuesta(json!({ "ok": false })).is_err());
    }
}
