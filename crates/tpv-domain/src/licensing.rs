//! Dominio de **licenciamiento**: la política del gate.
//!
//! Aquí vive la única pregunta que importa —¿puede usarse el TPV?— y sus reglas:
//! qué respuesta del servidor da una licencia por buena, cuánto se aguanta sin poder
//! hablar con él (gracia offline), cuándo el estado local deja de valer y hay que
//! borrarlo. Todo son funciones puras: ni red, ni ficheros, ni Tauri. El adaptador
//! (`tpv-infra-licensing`) se limita a traer los datos y a ejecutar la acción.

use serde::{Deserialize, Serialize};

/// Cuánto puede seguir funcionando el TPV sin lograr contactar con el servidor de licencias.
pub const GRACIA_OFFLINE_MS: i64 = 48 * 60 * 60 * 1000;

/// Margen que se le concede al reloj del dispositivo antes de considerar que se ha
/// atrasado (a mano) para estirar la gracia offline.
pub const TOLERANCIA_RELOJ_MS: i64 = 2 * 60 * 1000;

/* =========================================================
   Datos que cruzan la frontera con el servidor de licencias
========================================================= */

/// Datos validados para activar una licencia en este dispositivo.
#[derive(Debug, Clone)]
pub struct SolicitudActivacion {
    pub clave: String,
    pub business_name: String,
    pub legal_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub country: Option<String>,
}

impl SolicitudActivacion {
    /// Normaliza y valida. `clave` y `business_name` son obligatorios.
    pub fn validar(
        clave: String,
        business_name: String,
        legal_name: Option<String>,
        email: Option<String>,
        phone: Option<String>,
        country: Option<String>,
    ) -> Result<Self, String> {
        let clave = clave.trim().to_string();
        if clave.is_empty() {
            return Err("activation_key required".to_string());
        }

        let business_name = business_name.trim().to_string();
        if business_name.is_empty() {
            return Err("business_name required".to_string());
        }

        Ok(SolicitudActivacion {
            clave,
            business_name,
            legal_name: limpia_opcional(legal_name),
            email: limpia_opcional(email),
            phone: limpia_opcional(phone),
            country: limpia_opcional(country),
        })
    }
}

/// Lo que el servidor concede al activar: identidad del tenant + token de sesión.
///
/// Ese `token` no es solo la llave del gate: es la credencial con la que el dispositivo
/// firma **todas** sus llamadas a la nube (sync, pairing, imágenes, WebSocket).
#[derive(Debug, Clone)]
pub struct Concesion {
    pub tenant_id: String,
    pub device_id: String,
    pub token: String,
    pub status: String,
    pub expires_at: Option<String>,
}

/// Estado de la licencia tal y como lo reporta el servidor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EstadoServidor {
    pub status: String,
    pub expires_at: Option<String>,
    pub disabled: bool,
}

/// Respuesta completa a la consulta de estado.
#[derive(Debug, Clone)]
pub struct RespuestaEstado {
    pub ok: bool,
    pub estado: EstadoServidor,
    pub server_time_ms: i64,
}

/// Por qué no se pudo consultar el estado, clasificado por lo que implica para el gate.
#[derive(Debug, Clone)]
pub enum FalloConsulta {
    /// No hubo forma de hablar con el servidor (sin red, timeout, 5xx, o un fallo local
    /// al firmar la petición). La licencia local sigue valiendo mientras dure la gracia.
    Inalcanzable,
    /// El servidor contestó rechazando la petición (4xx): la licencia local ya no vale.
    Rechazada { http: u16 },
    /// El servidor contestó algo que no sabemos interpretar. No es un "no", pero tampoco
    /// un "sí": no permite afirmar que la licencia sea válida.
    Ilegible { http: u16, detalle: String },
}

impl std::fmt::Display for FalloConsulta {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FalloConsulta::Inalcanzable => write!(f, "license_status_unreachable"),
            FalloConsulta::Rechazada { http } => write!(f, "license_status_rejected_http_{http}"),
            FalloConsulta::Ilegible { http, detalle } => {
                write!(f, "status_failed_http_{http}: {detalle}")
            }
        }
    }
}

/* =========================================================
   Veredicto del gate
========================================================= */

/// Motivo del veredicto. `codigo()` es el string estable que cruza a la UI (el frontend
/// compara `needs_activation` por igualdad y muestra el resto en la pantalla de bloqueo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Motivo {
    Ok,
    NecesitaActivacion,
    Invalida,
    InvalidaHttp(u16),
    GraciaOffline,
    GraciaOfflineAgotada,
    RelojAtrasado,
}

impl Motivo {
    pub fn codigo(&self) -> String {
        match self {
            Motivo::Ok => "ok".to_string(),
            Motivo::NecesitaActivacion => "needs_activation".to_string(),
            Motivo::Invalida => "invalid".to_string(),
            Motivo::InvalidaHttp(http) => format!("invalid_http_{http}"),
            Motivo::GraciaOffline => "offline_grace".to_string(),
            Motivo::GraciaOfflineAgotada => "offline_expired".to_string(),
            Motivo::RelojAtrasado => "clock_rollback_detected".to_string(),
        }
    }
}

/// Qué hacer con el estado local (`license_state.json`) después del veredicto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccionEstado {
    /// Persistirlo con las marcas de comprobación actualizadas.
    Conservar,
    /// Borrarlo: la licencia ya no es utilizable y hay que volver a activar.
    Borrar,
}

/// Decisión del gate.
#[derive(Debug, Clone)]
pub struct Veredicto {
    pub permitido: bool,
    pub motivo: Motivo,
    pub accion: AccionEstado,
}

impl Veredicto {
    fn permitir(motivo: Motivo) -> Self {
        Veredicto {
            permitido: true,
            motivo,
            accion: AccionEstado::Conservar,
        }
    }

    /// Bloquea pero conserva el estado: el problema puede ser temporal (sin red, reloj),
    /// así que no se tira la licencia; el usuario puede reintentar.
    fn bloquear(motivo: Motivo) -> Self {
        Veredicto {
            permitido: false,
            motivo,
            accion: AccionEstado::Conservar,
        }
    }

    /// Bloquea y descarta el estado: el servidor ha dicho que esta licencia no vale.
    fn invalidar(motivo: Motivo) -> Self {
        Veredicto {
            permitido: false,
            motivo,
            accion: AccionEstado::Borrar,
        }
    }
}

/// Resultado de evaluar un fallo de consulta.
pub enum Resolucion {
    /// Se puede decidir con lo que hay.
    Decidido(Veredicto),
    /// El fallo no permite decidir (respuesta ilegible sin gracia que aplicar). El caso de
    /// uso propaga el error al llamante en vez de inventarse un sí o un no.
    Indecidible,
}

/// Vigencia de la gracia offline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gracia {
    Vigente,
    Agotada,
    /// El reloj del dispositivo va por detrás del último contacto conocido: alguien lo ha
    /// atrasado para estirar la gracia.
    RelojAtrasado,
}

/// Instante desde el que se cuenta la gracia offline: la última comprobación correcta o,
/// si nunca hubo ninguna, el momento de la activación.
pub fn base_gracia(last_check_ok_ms: Option<i64>, activated_at_ms: i64) -> i64 {
    last_check_ok_ms.unwrap_or(activated_at_ms)
}

pub fn evaluar_gracia(base_ms: i64, ahora_ms: i64) -> Gracia {
    if ahora_ms + TOLERANCIA_RELOJ_MS < base_ms {
        return Gracia::RelojAtrasado;
    }
    if ahora_ms.saturating_sub(base_ms) <= GRACIA_OFFLINE_MS {
        Gracia::Vigente
    } else {
        Gracia::Agotada
    }
}

/// ¿Da el servidor la licencia por utilizable?
///
/// NOTA (LIC-02): hoy **no** se comprueba `expires_at`. El servidor actual es la autoridad
/// y el campo llega como string opaco; el sistema de licencias propio lo hará cumplir aquí,
/// junto con la verificación de la firma ed25519 (ver `docs/PLAN_LICENCIAS_PROPIAS.md` §5.6).
fn licencia_utilizable(estado: &EstadoServidor) -> bool {
    !estado.disabled && estado.status.trim().eq_ignore_ascii_case("active")
}

/// Evalúa una respuesta que sí se pudo leer.
pub fn evaluar_respuesta(respuesta: &RespuestaEstado) -> Veredicto {
    if respuesta.ok && licencia_utilizable(&respuesta.estado) {
        Veredicto::permitir(Motivo::Ok)
    } else {
        Veredicto::invalidar(Motivo::Invalida)
    }
}

/// Evalúa un fallo de consulta.
///
/// `forzar_red` es la comprobación que pide el usuario explícitamente ("Reintentar"): ante
/// una respuesta ilegible no se le deja caer en la gracia offline, se le devuelve el fallo.
pub fn evaluar_fallo(
    fallo: &FalloConsulta,
    base_ms: i64,
    ahora_ms: i64,
    forzar_red: bool,
) -> Resolucion {
    match fallo {
        FalloConsulta::Inalcanzable => Resolucion::Decidido(match evaluar_gracia(base_ms, ahora_ms)
        {
            Gracia::Vigente => Veredicto::permitir(Motivo::GraciaOffline),
            Gracia::Agotada => Veredicto::bloquear(Motivo::GraciaOfflineAgotada),
            Gracia::RelojAtrasado => Veredicto::bloquear(Motivo::RelojAtrasado),
        }),

        FalloConsulta::Rechazada { http } => {
            Resolucion::Decidido(Veredicto::invalidar(Motivo::InvalidaHttp(*http)))
        }

        FalloConsulta::Ilegible { .. } => {
            if forzar_red {
                return Resolucion::Indecidible;
            }
            match evaluar_gracia(base_ms, ahora_ms) {
                Gracia::Vigente => Resolucion::Decidido(Veredicto::permitir(Motivo::GraciaOffline)),
                _ => Resolucion::Indecidible,
            }
        }
    }
}

fn limpia_opcional(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AHORA: i64 = 1_700_000_000_000;

    fn estado(status: &str, disabled: bool) -> RespuestaEstado {
        RespuestaEstado {
            ok: true,
            estado: EstadoServidor {
                status: status.to_string(),
                expires_at: None,
                disabled,
            },
            server_time_ms: AHORA,
        }
    }

    #[test]
    fn licencia_activa_permite_usar_el_tpv() {
        let v = evaluar_respuesta(&estado("active", false));
        assert!(v.permitido);
        assert_eq!(v.motivo.codigo(), "ok");
        assert_eq!(v.accion, AccionEstado::Conservar);
    }

    #[test]
    fn licencia_deshabilitada_o_inactiva_borra_el_estado_local() {
        for r in [estado("active", true), estado("expired", false)] {
            let v = evaluar_respuesta(&r);
            assert!(!v.permitido);
            assert_eq!(v.accion, AccionEstado::Borrar);
        }
    }

    #[test]
    fn sin_red_se_aguanta_hasta_agotar_la_gracia() {
        let base = AHORA - GRACIA_OFFLINE_MS + 1;
        assert_eq!(evaluar_gracia(base, AHORA), Gracia::Vigente);
        assert_eq!(evaluar_gracia(AHORA - GRACIA_OFFLINE_MS - 1, AHORA), Gracia::Agotada);
    }

    #[test]
    fn atrasar_el_reloj_no_estira_la_gracia() {
        let base = AHORA + TOLERANCIA_RELOJ_MS + 1;
        assert_eq!(evaluar_gracia(base, AHORA), Gracia::RelojAtrasado);
    }

    #[test]
    fn un_4xx_invalida_la_licencia_pero_un_5xx_no() {
        let rechazada = evaluar_fallo(&FalloConsulta::Rechazada { http: 404 }, AHORA, AHORA, false);
        match rechazada {
            Resolucion::Decidido(v) => {
                assert!(!v.permitido);
                assert_eq!(v.motivo.codigo(), "invalid_http_404");
                assert_eq!(v.accion, AccionEstado::Borrar);
            }
            Resolucion::Indecidible => panic!("un 4xx siempre decide"),
        }

        match evaluar_fallo(&FalloConsulta::Inalcanzable, AHORA, AHORA, false) {
            Resolucion::Decidido(v) => {
                assert!(v.permitido);
                assert_eq!(v.accion, AccionEstado::Conservar);
            }
            Resolucion::Indecidible => panic!("sin red hay gracia"),
        }
    }

    #[test]
    fn una_respuesta_ilegible_solo_cae_en_la_gracia_si_no_la_pidio_el_usuario() {
        let fallo = FalloConsulta::Ilegible {
            http: 200,
            detalle: "invalid_json".to_string(),
        };

        assert!(matches!(
            evaluar_fallo(&fallo, AHORA, AHORA, true),
            Resolucion::Indecidible
        ));
        assert!(matches!(
            evaluar_fallo(&fallo, AHORA, AHORA, false),
            Resolucion::Decidido(_)
        ));
    }

    #[test]
    fn la_activacion_exige_clave_y_nombre_de_negocio() {
        assert!(SolicitudActivacion::validar(
            "  ".into(),
            "Bar La Plaza".into(),
            None,
            None,
            None,
            None
        )
        .is_err());

        assert!(
            SolicitudActivacion::validar("TPV-1".into(), "  ".into(), None, None, None, None)
                .is_err()
        );

        let s = SolicitudActivacion::validar(
            " TPV-1 ".into(),
            " Bar La Plaza ".into(),
            Some("  ".into()),
            Some(" a@b.com ".into()),
            None,
            None,
        )
        .expect("solicitud válida");

        assert_eq!(s.clave, "TPV-1");
        assert_eq!(s.business_name, "Bar La Plaza");
        assert_eq!(s.legal_name, None, "los opcionales vacíos se descartan");
        assert_eq!(s.email.as_deref(), Some("a@b.com"));
    }
}
