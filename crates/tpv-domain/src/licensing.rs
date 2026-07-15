//! Dominio de **licenciamiento**: la política del gate.
//!
//! La única pregunta que importa —¿puede usarse el TPV?— y sus reglas: qué estado firmado da
//! una licencia por buena, cómo se reconstruye el mensaje que el servidor firmó (para poder
//! verificarlo), cuánto se aguanta sin red (gracia offline) y cuándo se descarta el estado
//! local. Todo funciones puras: ni red, ni ficheros, ni cripto (la verificación ed25519 la hace
//! el adaptador con la clave pineada; aquí solo se construye el mensaje canónico a verificar).

/// Cuánto puede seguir funcionando el TPV sin lograr contactar con el servidor de licencias.
pub const GRACIA_OFFLINE_MS: i64 = 48 * 60 * 60 * 1000;

/// Margen que se le concede al reloj del dispositivo antes de considerar que se ha atrasado
/// (a mano) para estirar la gracia offline.
pub const TOLERANCIA_RELOJ_MS: i64 = 2 * 60 * 1000;

/* =========================================================
   Activación
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

/// Lo que el servidor concede al activar: identidad del tenant y estado inicial.
///
/// El **token** de sesión concedido NO viaja aquí: el adaptador lo guarda directamente en el
/// keyring (es una credencial, no estado). Ni el dominio ni el caso de uso lo tocan.
#[derive(Debug, Clone)]
pub struct Concesion {
    pub tenant_id: String,
    pub device_id: String,
    pub status: String,
    pub expires_at: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub plan: Option<String>,
}

/// Resultado de intentar activar. El servidor puede exigir un código de cambio de dispositivo
/// si la licencia ya está ligada a otro Main (§6.4 del plan).
#[derive(Debug, Clone)]
pub enum ResultadoActivacion {
    Activada(Concesion),
    /// Hace falta el OTP del email para mover la licencia a este equipo. `email_hint` es la
    /// pista que se muestra al usuario (`a***@bar.com`).
    CambioDispositivoRequerido { email_hint: String },
}

/* =========================================================
   Estado firmado (lo que decide el gate)
========================================================= */

/// Estado de la licencia derivado por el SERVIDOR (la autoridad) y firmado con ed25519. El
/// cliente no lo recalcula: lo verifica y obedece. Los códigos coinciden con `LicenseGateState`
/// del worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstadoLicencia {
    Active,
    Warn,
    ExpiryGrace,
    Expired,
    Revoked,
    DeviceReplaced,
}

impl EstadoLicencia {
    pub fn from_code(s: &str) -> Option<Self> {
        match s.trim() {
            "active" => Some(EstadoLicencia::Active),
            "warn" => Some(EstadoLicencia::Warn),
            "expiry_grace" => Some(EstadoLicencia::ExpiryGrace),
            "expired" => Some(EstadoLicencia::Expired),
            "revoked" => Some(EstadoLicencia::Revoked),
            "device_replaced" => Some(EstadoLicencia::DeviceReplaced),
            _ => None,
        }
    }

    pub fn codigo(&self) -> &'static str {
        match self {
            EstadoLicencia::Active => "active",
            EstadoLicencia::Warn => "warn",
            EstadoLicencia::ExpiryGrace => "expiry_grace",
            EstadoLicencia::Expired => "expired",
            EstadoLicencia::Revoked => "revoked",
            EstadoLicencia::DeviceReplaced => "device_replaced",
        }
    }
}

/// Aserción **ya verificada** (el adaptador comprobó la firma y la frescura). Sus campos son de
/// fiar porque reconstruyen exactamente el mensaje que el servidor firmó.
#[derive(Debug, Clone)]
pub struct AssertionVerificada {
    pub version: u8,
    pub tenant_id: String,
    pub device_id: String,
    pub license_id: String,
    pub estado: EstadoLicencia,
    pub plan: String,
    pub expires_at_ms: Option<i64>,
    pub issued_at_ms: i64,
    pub assertion_expires_at_ms: i64,
    pub client_ts: i64,
}

/// Mensaje canónico que firma el servidor. Orden FIJO, separador `|`.
///
/// ⚠️ Tiene que ser **idéntico byte a byte** a `licenseAssertionMessage` del worker
/// (`apps/cloud-worker-licensing/src/domains/licensing/licensing.helpers.ts`). Cualquier cambio
/// aquí obliga a cambiarlo allí y a subir `version`.
pub fn mensaje_canonico(a: &AssertionVerificada) -> String {
    let expires = a
        .expires_at_ms
        .map(|v| v.to_string())
        .unwrap_or_default();

    format!(
        "v{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        a.version,
        a.tenant_id,
        a.device_id,
        a.license_id,
        a.estado.codigo(),
        a.plan,
        expires,
        a.issued_at_ms,
        a.assertion_expires_at_ms,
        a.client_ts,
    )
}

/// ¿Es la aserción de ESTA petición y sigue vigente? Aunque la firma sea válida, una aserción
/// vieja (otro `client_ts`) o ya caducada (> 5 min) no vale: es el anti-replay.
pub fn assertion_fresca(a: &AssertionVerificada, client_ts_enviado: i64, ahora_ms: i64) -> bool {
    a.client_ts == client_ts_enviado && ahora_ms <= a.assertion_expires_at_ms
}

/// Respuesta de estado ya verificada, lista para que decida el dominio.
///
/// El token renovado que el servidor devuelve en cada `/status` (fin del muro de los 30 días) NO
/// aparece aquí: el adaptador lo persiste directamente en el keyring. El dominio solo decide.
#[derive(Debug, Clone)]
pub struct EstadoVerificado {
    pub assertion: AssertionVerificada,
    pub server_time_ms: i64,
}

/// Por qué no se pudo obtener un estado verificado, clasificado por lo que implica para el gate.
#[derive(Debug, Clone)]
pub enum FalloConsulta {
    /// Sin red, timeout, 5xx, o una incidencia de auth transitoria (reloj desfasado). La licencia
    /// local sigue valiendo mientras dure la gracia offline.
    Inalcanzable,
    /// La respuesta llegó pero su firma no verifica (o no es de esta petición). Posible servidor
    /// falso / MITM: se bloquea, pero NO se borra la licencia (podría ser transitorio).
    FirmaInvalida,
    /// El servidor dice que esta licencia ya no vale (no existe, revocada, movida a otro equipo).
    Rechazada { code: String },
    /// Respuesta que no sabemos interpretar. Ni un sí ni un no.
    Ilegible { detalle: String },
}

impl std::fmt::Display for FalloConsulta {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FalloConsulta::Inalcanzable => write!(f, "license_status_unreachable"),
            FalloConsulta::FirmaInvalida => write!(f, "bad_signature"),
            FalloConsulta::Rechazada { code } => write!(f, "{code}"),
            FalloConsulta::Ilegible { detalle } => write!(f, "status_unreadable: {detalle}"),
        }
    }
}

/* =========================================================
   Veredicto del gate
========================================================= */

/// Motivo del veredicto. `codigo()` es el string estable que cruza a la UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Motivo {
    Ok,
    Warn,
    ExpiryGrace,
    Expired,
    Revoked,
    DeviceReplaced,
    BadSignature,
    NecesitaActivacion,
    /// Rechazo del servidor con su código verbatim (p. ej. `license_not_found`).
    Rechazada(String),
    GraciaOffline,
    GraciaOfflineAgotada,
    RelojAtrasado,
}

impl Motivo {
    pub fn codigo(&self) -> String {
        match self {
            Motivo::Ok => "ok".to_string(),
            Motivo::Warn => "warn".to_string(),
            Motivo::ExpiryGrace => "expiry_grace".to_string(),
            Motivo::Expired => "expired".to_string(),
            Motivo::Revoked => "revoked".to_string(),
            Motivo::DeviceReplaced => "device_replaced".to_string(),
            Motivo::BadSignature => "bad_signature".to_string(),
            Motivo::NecesitaActivacion => "needs_activation".to_string(),
            Motivo::Rechazada(code) => code.clone(),
            Motivo::GraciaOffline => "offline_grace".to_string(),
            Motivo::GraciaOfflineAgotada => "offline_expired".to_string(),
            Motivo::RelojAtrasado => "clock_rollback_detected".to_string(),
        }
    }
}

/// Qué hacer con el estado local (`license_state.json`) tras el veredicto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccionEstado {
    Conservar,
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
        Veredicto { permitido: true, motivo, accion: AccionEstado::Conservar }
    }

    /// Bloquea pero conserva el estado: el problema puede ser temporal (sin red, firma, caducidad
    /// renovable), así que no se tira la licencia; el usuario reintenta.
    fn bloquear(motivo: Motivo) -> Self {
        Veredicto { permitido: false, motivo, accion: AccionEstado::Conservar }
    }

    /// Bloquea y descarta el estado: el servidor ha dicho que esta licencia no vale en este equipo.
    fn invalidar(motivo: Motivo) -> Self {
        Veredicto { permitido: false, motivo, accion: AccionEstado::Borrar }
    }
}

/// Traduce el estado firmado del servidor en un veredicto.
///
/// `Expired` bloquea pero **conserva** el estado: si el cliente renueva, el siguiente `/status`
/// lo verá `active` y basta con reintentar, sin re-teclear la clave. `Revoked` y
/// `DeviceReplaced` sí borran: en este equipo la licencia se acabó.
pub fn evaluar_estado(estado: EstadoLicencia) -> Veredicto {
    match estado {
        EstadoLicencia::Active => Veredicto::permitir(Motivo::Ok),
        EstadoLicencia::Warn => Veredicto::permitir(Motivo::Warn),
        EstadoLicencia::ExpiryGrace => Veredicto::permitir(Motivo::ExpiryGrace),
        EstadoLicencia::Expired => Veredicto::bloquear(Motivo::Expired),
        EstadoLicencia::Revoked => Veredicto::invalidar(Motivo::Revoked),
        EstadoLicencia::DeviceReplaced => Veredicto::invalidar(Motivo::DeviceReplaced),
    }
}

/// Resultado de evaluar un fallo de consulta.
pub enum Resolucion {
    Decidido(Veredicto),
    /// El fallo no permite decidir; el caso de uso propaga el error en vez de inventar un sí/no.
    Indecidible,
}

pub fn evaluar_fallo(
    fallo: &FalloConsulta,
    base_ms: i64,
    ahora_ms: i64,
    forzar_red: bool,
) -> Resolucion {
    match fallo {
        FalloConsulta::Inalcanzable => Resolucion::Decidido(match evaluar_gracia(base_ms, ahora_ms) {
            Gracia::Vigente => Veredicto::permitir(Motivo::GraciaOffline),
            Gracia::Agotada => Veredicto::bloquear(Motivo::GraciaOfflineAgotada),
            Gracia::RelojAtrasado => Veredicto::bloquear(Motivo::RelojAtrasado),
        }),

        // Sin firma válida no hay acceso, pase lo que pase. Se conserva la licencia: podría ser un
        // MITM puntual o una rotación de clave, no un motivo para forzar la re-activación.
        FalloConsulta::FirmaInvalida => {
            Resolucion::Decidido(Veredicto::bloquear(Motivo::BadSignature))
        }

        FalloConsulta::Rechazada { code } => {
            Resolucion::Decidido(Veredicto::invalidar(Motivo::Rechazada(code.clone())))
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

/* =========================================================
   Gracia offline
========================================================= */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gracia {
    Vigente,
    Agotada,
    RelojAtrasado,
}

/// Instante desde el que se cuenta la gracia offline: la última comprobación correcta o, si nunca
/// hubo ninguna, el momento de la activación.
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

fn limpia_opcional(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AHORA: i64 = 1_700_000_000_000;

    fn assertion(estado: EstadoLicencia) -> AssertionVerificada {
        AssertionVerificada {
            version: 1,
            tenant_id: "t1".into(),
            device_id: "d1".into(),
            license_id: "lic1".into(),
            estado,
            plan: "standard".into(),
            expires_at_ms: Some(AHORA + 1000),
            issued_at_ms: AHORA,
            assertion_expires_at_ms: AHORA + 5 * 60 * 1000,
            client_ts: AHORA,
        }
    }

    #[test]
    fn el_mensaje_canonico_es_estable_y_coincide_con_el_worker() {
        // Debe ser idéntico a lo que compone `licenseAssertionMessage` en el worker.
        let a = assertion(EstadoLicencia::Active);
        assert_eq!(
            mensaje_canonico(&a),
            format!("v1|t1|d1|lic1|active|standard|{}|{}|{}|{}", AHORA + 1000, AHORA, AHORA + 300_000, AHORA),
        );
    }

    #[test]
    fn expires_at_null_se_serializa_como_vacio() {
        let mut a = assertion(EstadoLicencia::Active);
        a.expires_at_ms = None;
        assert!(mensaje_canonico(&a).contains("|standard||")); // plan | (vacío) | issued
    }

    #[test]
    fn una_asercion_de_otra_peticion_o_caducada_no_es_fresca() {
        let a = assertion(EstadoLicencia::Active);
        assert!(assertion_fresca(&a, AHORA, AHORA));
        assert!(!assertion_fresca(&a, AHORA + 1, AHORA), "otro client_ts");
        assert!(!assertion_fresca(&a, AHORA, a.assertion_expires_at_ms + 1), "caducada");
    }

    #[test]
    fn estados_que_permiten_usar_y_estados_que_bloquean() {
        for (e, permite, borra) in [
            (EstadoLicencia::Active, true, false),
            (EstadoLicencia::Warn, true, false),
            (EstadoLicencia::ExpiryGrace, true, false),
            (EstadoLicencia::Expired, false, false),
            (EstadoLicencia::Revoked, false, true),
            (EstadoLicencia::DeviceReplaced, false, true),
        ] {
            let v = evaluar_estado(e);
            assert_eq!(v.permitido, permite, "{:?}", e);
            assert_eq!(v.accion == AccionEstado::Borrar, borra, "{:?}", e);
        }
    }

    #[test]
    fn firma_invalida_bloquea_pero_no_borra() {
        match evaluar_fallo(&FalloConsulta::FirmaInvalida, AHORA, AHORA, false) {
            Resolucion::Decidido(v) => {
                assert!(!v.permitido);
                assert_eq!(v.motivo.codigo(), "bad_signature");
                assert_eq!(v.accion, AccionEstado::Conservar);
            }
            Resolucion::Indecidible => panic!("una firma inválida siempre decide: bloquea"),
        }
    }

    #[test]
    fn un_rechazo_del_servidor_borra_y_conserva_su_codigo() {
        let fallo = FalloConsulta::Rechazada { code: "license_not_found".into() };
        match evaluar_fallo(&fallo, AHORA, AHORA, false) {
            Resolucion::Decidido(v) => {
                assert!(!v.permitido);
                assert_eq!(v.motivo.codigo(), "license_not_found");
                assert_eq!(v.accion, AccionEstado::Borrar);
            }
            Resolucion::Indecidible => panic!("un rechazo siempre decide"),
        }
    }

    #[test]
    fn sin_red_se_aguanta_hasta_agotar_la_gracia() {
        assert_eq!(evaluar_gracia(AHORA - GRACIA_OFFLINE_MS + 1, AHORA), Gracia::Vigente);
        assert_eq!(evaluar_gracia(AHORA - GRACIA_OFFLINE_MS - 1, AHORA), Gracia::Agotada);
    }

    #[test]
    fn atrasar_el_reloj_no_estira_la_gracia() {
        assert_eq!(evaluar_gracia(AHORA + TOLERANCIA_RELOJ_MS + 1, AHORA), Gracia::RelojAtrasado);
    }

    #[test]
    fn la_activacion_exige_clave_y_nombre_de_negocio() {
        assert!(SolicitudActivacion::validar("  ".into(), "Bar".into(), None, None, None, None).is_err());
        assert!(SolicitudActivacion::validar("K".into(), "  ".into(), None, None, None, None).is_err());

        let s = SolicitudActivacion::validar(
            " K ".into(),
            " Bar ".into(),
            Some("  ".into()),
            Some(" a@b.com ".into()),
            None,
            None,
        )
        .expect("válida");
        assert_eq!(s.clave, "K");
        assert_eq!(s.business_name, "Bar");
        assert_eq!(s.legal_name, None);
        assert_eq!(s.email.as_deref(), Some("a@b.com"));
    }
}
