//! Dominio de **licenciamiento**: la política del gate.
//!
//! La única pregunta que importa —¿puede usarse el TPV?— y sus reglas: qué estado firmado da
//! una licencia por buena, cómo se reconstruye el mensaje que el servidor firmó (para poder
//! verificarlo), cuánto se aguanta sin red (gracia offline) y cuándo se descarta el estado
//! local. Todo funciones puras: ni red, ni ficheros, ni cripto (la verificación ed25519 la hace
//! el adaptador con la clave pineada; aquí solo se construye el mensaje canónico a verificar).

/// Cuánto puede seguir funcionando el TPV sin lograr contactar con el servidor de licencias.
/// 72 h (3 días): margen amplio ante cortes de internet antes de bloquear.
pub const GRACIA_OFFLINE_MS: i64 = 72 * 60 * 60 * 1000;

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
    pub phone: Option<String>,
    pub country: Option<String>,
    /// RI-52: sólo sumar el tiempo de la clave a la licencia que este equipo ya tiene (canje desde
    /// Configuración). El servidor rechaza cualquier otra cosa sin tocar nada.
    pub solo_sumar: bool,
}

impl SolicitudActivacion {
    /// Normaliza y valida. `clave` y `business_name` son obligatorios.
    pub fn validar(
        clave: String,
        business_name: String,
        legal_name: Option<String>,
        phone: Option<String>,
        country: Option<String>,
    ) -> Result<Self, String> {
        let clave = clave.trim().to_string();
        if clave.is_empty() {
            return Err("Escribe la clave de activación.".to_string());
        }

        let business_name = business_name.trim().to_string();
        if business_name.is_empty() {
            return Err("Escribe el nombre del negocio.".to_string());
        }

        Ok(SolicitudActivacion {
            clave,
            business_name,
            legal_name: limpia_opcional(legal_name),
            phone: limpia_opcional(phone),
            country: limpia_opcional(country),
            solo_sumar: false,
        })
    }

    /// RI-52: canjear una clave en un equipo que ya funciona. No lleva datos del negocio: no va a
    /// crear ninguno, y el servidor se niega a hacer otra cosa que sumar tiempo.
    pub fn para_sumar(clave: String) -> Result<Self, String> {
        let clave = clave.trim().to_string();
        if clave.is_empty() {
            return Err("Escribe la clave que quieres añadir.".to_string());
        }
        Ok(SolicitudActivacion {
            clave,
            business_name: String::new(),
            legal_name: None,
            phone: None,
            country: None,
            solo_sumar: true,
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
    /// La licencia estaba en otro equipo y se ha trasladado a éste. Lo que haya en la base local
    /// es de antes del traslado y no se reutiliza: se reconstruye desde la nube.
    pub cambio_de_equipo: bool,
    /// REV-13 · La clave no ha estrenado nada: le ha **sumado su tiempo** a la licencia que este
    /// equipo ya tenía. No hay negocio nuevo, ni base que reconstruir — sigue todo igual con más
    /// meses por delante. Es lo contrario de `cambio_de_equipo` y por eso son dos campos: uno dice
    /// «tus datos son de antes y no valen» y el otro «no ha cambiado nada».
    pub tiempo_sumado: bool,
}

/// Resultado de intentar activar. El servidor puede exigir un código de cambio de dispositivo
/// si la licencia ya está ligada a otro Main.
#[derive(Debug, Clone)]
pub enum ResultadoActivacion {
    Activada(Concesion),
    /// Hace falta el OTP del email para mover la licencia a este equipo. `email_hint` es la
    /// pista que se muestra al usuario (`a***@bar.com`).
    CambioDispositivoRequerido { email_hint: String },
}

/* =========================================================
   Lo pedido y lo concedido (AUD-01)
========================================================= */

const MSG_SIN_LICENCIA_A_LA_QUE_SUMAR: &str = "Este equipo no tiene una licencia a la que sumarle tiempo.";
const MSG_CLAVE_NO_SUMADA: &str =
    "Esa clave no se ha sumado a la licencia de este equipo. Aquí no se ha cambiado nada: contacta con soporte.";
const MSG_SUMADA_A_OTRO_NEGOCIO: &str =
    "Esa clave se ha sumado a la licencia de otro negocio, no a la de este equipo. Aquí no se ha cambiado nada: contacta con soporte.";

/// AUD-01 · ¿Se puede pedir esto a la nube? Se mira ANTES de mandar la clave.
///
/// Sumar (`solo_sumar`, el canje desde Configuración) es sumar a la licencia que el equipo ya
/// tiene: sin licencia guardada no hay a qué sumar, y la clave no sale del equipo.
/// `negocio_del_equipo` es el de esa licencia, `None` si no tiene.
pub fn comprobar_solicitud(solo_sumar: bool, negocio_del_equipo: Option<&str>) -> Result<(), &'static str> {
    if solo_sumar && negocio_del_equipo.is_none() {
        return Err(MSG_SIN_LICENCIA_A_LA_QUE_SUMAR);
    }
    Ok(())
}

/// AUD-01 · ¿Se puede guardar lo que la nube ha concedido, para lo que se le pidió? Se mira ANTES de
/// guardar nada de la respuesta: con su token y su clave de cifrado en el equipo, todo lo que
/// hable con la nube lo hace ya en nombre del negocio concedido.
///
/// - Quien pidió **sólo sumar** espera una suma (`tiempo_sumado`) sobre la licencia de su negocio.
///   Un negocio estrenado o un traslado no es lo que pidió.
/// - Una suma no cambia de negocio, se pidiera como se pidiera.
///
/// Los caminos en los que el negocio cambia a propósito —una primera activación, un traslado con su
/// código— no son sumas ni se piden con `solo_sumar`, y pasan. Un equipo sin licencia guardada no
/// tiene negocio con el que comparar.
///
/// Devuelve la frase para quien está delante. Es pura para que la llame quien decide guardar.
pub fn comprobar_concesion(
    solo_sumar: bool,
    negocio_del_equipo: Option<&str>,
    negocio_concedido: &str,
    tiempo_sumado: bool,
) -> Result<(), &'static str> {
    comprobar_solicitud(solo_sumar, negocio_del_equipo)?;

    if solo_sumar && !tiempo_sumado {
        return Err(MSG_CLAVE_NO_SUMADA);
    }
    if tiempo_sumado && negocio_del_equipo.is_some_and(|propio| propio.trim() != negocio_concedido.trim()) {
        return Err(MSG_SUMADA_A_OTRO_NEGOCIO);
    }
    Ok(())
}

/* =========================================================
   De quién es la base del equipo (AUD-06)
========================================================= */

/// Lo que dice una base (o una copia) de sí misma al leer su sello, `_Negocio`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sello {
    /// No lleva: es una base recién creada, o una anterior a los sellos.
    Ninguno,
    /// Lleva el de este negocio.
    De(String),
    /// No se ha podido leer: el fichero no es una base, o está dañado. No dice de quién es.
    Ilegible,
}

impl Sello {
    /// Lo leído de `_Negocio`. Un sello vacío no es un sello.
    pub fn leido(valor: Option<&str>) -> Sello {
        match valor.map(str::trim).filter(|s| !s.is_empty()) {
            Some(negocio) => Sello::De(negocio.to_string()),
            None => Sello::Ninguno,
        }
    }
}

/// De quién es una base local, o una copia suya, frente al negocio de una licencia.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Procedencia {
    /// Lleva el sello de ese negocio.
    Suya,
    /// No lleva sello.
    SinSello,
    /// Lleva el sello de otro negocio.
    DeOtroNegocio,
    /// No se ha podido leer: puede ser de cualquiera.
    Desconocida,
}

/// AUD-06 · La única comparación entre una base y una licencia.
pub fn procedencia(sello: &Sello, negocio: &str) -> Procedencia {
    match sello {
        Sello::Ninguno => Procedencia::SinSello,
        Sello::Ilegible => Procedencia::Desconocida,
        Sello::De(s) if s.trim() == negocio.trim() && !s.trim().is_empty() => Procedencia::Suya,
        Sello::De(_) => Procedencia::DeOtroNegocio,
    }
}

/// Qué se hace con la base del equipo para trabajar con la licencia de un negocio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueHacerConLaBase {
    /// Es la de ese negocio: se usa.
    Usar,
    /// No dice de quién es: se sella con ese negocio y se usa.
    Sellar,
    /// Es de ese negocio (o no lo dice), pero la licencia viene de otro equipo, que ha seguido
    /// trabajando: la base es de antes y se reconstruye desde la nube. Lo demás que hay en el
    /// equipo se queda.
    Reconstruir,
    /// Es de otro negocio, o no se puede saber de quién es: no se usa. Se aparta entera, con todo lo
    /// que ese negocio tiene en el equipo, y se trae de la nube la de la licencia. Al activar,
    /// además, el TPV se reinicia: nada de lo que estaba en marcha con el negocio anterior sigue.
    Apartar,
}

/// AUD-06 · La regla: **una base sólo se usa con la licencia de su negocio.**
///
/// Es la misma al abrir la base, al activar una licencia y al restaurar una copia, y sólo mira lo
/// que la base dice de sí misma. `licencia_de_otro_equipo` lo sabe únicamente la activación, por
/// el servidor (`cambioDeEquipo`); al abrir es `false`, porque de eso ya queda la marca de traslado.
/// Que el servidor diga que la base no vale nunca hace falta para apartar la de otro negocio: ese
/// aviso sólo sale en la primera activación y se pierde si la respuesta no llega. Y una base que no
/// se deja leer nunca se da por «sin sello»: no consta de quién es, así que se aparta.
pub fn que_hacer_con_la_base(
    sello: &Sello,
    negocio: &str,
    licencia_de_otro_equipo: bool,
) -> QueHacerConLaBase {
    match (procedencia(sello, negocio), licencia_de_otro_equipo) {
        (Procedencia::DeOtroNegocio | Procedencia::Desconocida, _) => QueHacerConLaBase::Apartar,
        (_, true) => QueHacerConLaBase::Reconstruir,
        (Procedencia::SinSello, false) => QueHacerConLaBase::Sellar,
        (Procedencia::Suya, false) => QueHacerConLaBase::Usar,
    }
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
/// aparece aquí: es una credencial, y va aparte hasta el keyring. El dominio solo decide.
#[derive(Debug, Clone)]
pub struct EstadoVerificado {
    pub assertion: AssertionVerificada,
    pub server_time_ms: i64,
}

/// Por qué no se pudo obtener un estado verificado, clasificado por lo que implica para el gate.
#[derive(Debug, Clone)]
pub enum FalloConsulta {
    /// Sin red, timeout, 5xx o una incidencia de auth transitoria. La licencia local sigue
    /// valiendo mientras dure la gracia offline.
    Inalcanzable,
    /// El servidor contesta, pero rechaza la firma porque el RELOJ de este equipo va desfasado
    /// (`device_ts_out_of_range`, más de 2 min). Para el gate se comporta igual que `Inalcanzable`
    /// —la licencia es buena y el TPV tiene que seguir vendiendo—, pero se distingue porque tiene
    /// arreglo y lo tiene quien está delante: se le puede decir que ajuste la hora (REV-10).
    RelojDesfasado,
    /// La respuesta llegó pero su firma no verifica (o no es de esta petición). Posible servidor
    /// falso / MITM: se bloquea, pero NO se borra la licencia (podría ser transitorio).
    FirmaInvalida,
    /// El servidor dice que esta licencia ya no vale (no existe, anulada, movida a otro equipo), pero
    /// con un código de error SIN FIRMAR, así que no se puede comprobar que lo diga él (RI-09).
    ///
    /// Una anulación de verdad llega firmada, en la aserción de `/status` o en la que acompaña al
    /// rechazo de `/refresh`. Lo que llega así es `license_not_found`, que con un token válido sólo
    /// puede ser un fallo nuestro (el worker no borra licencias): una base equivocada, una copia
    /// restaurada, una consulta rota. Por eso cuenta como no haber podido comprobar: gracia offline.
    RechazoSinFirmar { code: String },
    /// Respuesta que no sabemos interpretar. Ni un sí ni un no.
    Ilegible { detalle: String },
}

impl std::fmt::Display for FalloConsulta {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FalloConsulta::Inalcanzable => write!(f, "license_status_unreachable"),
            FalloConsulta::RelojDesfasado => write!(f, "device_ts_out_of_range"),
            FalloConsulta::FirmaInvalida => write!(f, "bad_signature"),
            FalloConsulta::RechazoSinFirmar { code } => write!(f, "{code}"),
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
    /// RI-09: el servidor ha dicho que no con un código sin firmar. Se sigue con la gracia offline,
    /// pero con su propio motivo: no es falta de red, y quien está delante tiene que saber que algo
    /// raro pasa y avisar a soporte.
    RechazoSinVerificar,
    GraciaOffline,
    GraciaOfflineAgotada,
    RelojAtrasado,
    /// REV-10: el servidor no acepta la firma porque el reloj de este equipo va desfasado.
    RelojDesfasado,
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
            Motivo::RechazoSinVerificar => "rejection_unverified".to_string(),
            Motivo::GraciaOffline => "offline_grace".to_string(),
            Motivo::GraciaOfflineAgotada => "offline_expired".to_string(),
            Motivo::RelojAtrasado => "clock_rollback_detected".to_string(),
            Motivo::RelojDesfasado => "clock_skew_detected".to_string(),
        }
    }
}

/// Decisión del gate.
///
/// RI-09 · **El gate nunca borra la licencia local.** Antes, `revoked`, `device_replaced` y
/// `license_not_found` la borraban, y eso convertía cualquier error NUESTRO en que el bar tuviera que
/// volver a teclear la clave: una base equivocada, una copia restaurada de antes de un cambio de
/// equipo (que firma un `device_replaced` con la clave buena)… Firmar el rechazo no lo arregla,
/// porque el worker firmaría igual la respuesta equivocada. Ahora se bloquea con su motivo y se
/// conserva: si el servidor se corrige, el equipo vuelve solo; si de verdad se acabó, quien está
/// delante pulsa «Borrar y volver a activar» (`clear_state`).
#[derive(Debug, Clone)]
pub struct Veredicto {
    pub permitido: bool,
    pub motivo: Motivo,
}

impl Veredicto {
    fn permitir(motivo: Motivo) -> Self {
        Veredicto { permitido: true, motivo }
    }

    fn bloquear(motivo: Motivo) -> Self {
        Veredicto { permitido: false, motivo }
    }
}

/// Traduce el estado firmado del servidor en un veredicto. Los que no dejan trabajar bloquean y
/// conservan: `Expired` se arregla renovando, y `Revoked` o `DeviceReplaced` deshaciendo el cambio en
/// el servidor; en los tres casos basta con reintentar, sin volver a teclear la clave.
pub fn evaluar_estado(estado: EstadoLicencia) -> Veredicto {
    match estado {
        EstadoLicencia::Active => Veredicto::permitir(Motivo::Ok),
        EstadoLicencia::Warn => Veredicto::permitir(Motivo::Warn),
        EstadoLicencia::ExpiryGrace => Veredicto::permitir(Motivo::ExpiryGrace),
        EstadoLicencia::Expired => Veredicto::bloquear(Motivo::Expired),
        EstadoLicencia::Revoked => Veredicto::bloquear(Motivo::Revoked),
        EstadoLicencia::DeviceReplaced => Veredicto::bloquear(Motivo::DeviceReplaced),
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
    consumido_ms: i64,
    forzar_red: bool,
) -> Resolucion {
    match fallo {
        FalloConsulta::Inalcanzable => Resolucion::Decidido(match evaluar_gracia(base_ms, ahora_ms, consumido_ms) {
            Gracia::Vigente => Veredicto::permitir(Motivo::GraciaOffline),
            Gracia::Agotada => Veredicto::bloquear(Motivo::GraciaOfflineAgotada),
            Gracia::RelojAtrasado => Veredicto::bloquear(Motivo::RelojAtrasado),
        }),

        // REV-10: el mismo VEREDICTO que `Inalcanzable` —la licencia vale y el TPV sigue
        // vendiendo mientras dure la gracia—, pero con su propio motivo. Sin él, un reloj mal
        // puesto se contaba como «sin conexión»: 72 h de cuenta atrás y luego un bloqueo que habla
        // de internet, cuando lo que hay que hacer es ajustar la hora. El motivo es el mismo
        // permita o bloquee, porque la acción de quien está delante es la misma.
        FalloConsulta::RelojDesfasado => {
            Resolucion::Decidido(match evaluar_gracia(base_ms, ahora_ms, consumido_ms) {
                Gracia::Vigente => Veredicto::permitir(Motivo::RelojDesfasado),
                _ => Veredicto::bloquear(Motivo::RelojDesfasado),
            })
        }

        // Sin firma válida no hay acceso, pase lo que pase. Se conserva la licencia: podría ser un
        // MITM puntual o una rotación de clave, no un motivo para forzar la re-activación.
        FalloConsulta::FirmaInvalida => {
            Resolucion::Decidido(Veredicto::bloquear(Motivo::BadSignature))
        }

        // RI-09: un «no» sin firma no se puede comprobar, así que pesa lo mismo que no haber podido
        // preguntar: la gracia offline. Con su motivo, para que se vea que no es la red.
        FalloConsulta::RechazoSinFirmar { .. } => {
            Resolucion::Decidido(match evaluar_gracia(base_ms, ahora_ms, consumido_ms) {
                Gracia::Vigente => Veredicto::permitir(Motivo::RechazoSinVerificar),
                Gracia::Agotada => Veredicto::bloquear(Motivo::RechazoSinVerificar),
                Gracia::RelojAtrasado => Veredicto::bloquear(Motivo::RelojAtrasado),
            })
        }

        FalloConsulta::Ilegible { .. } => {
            if forzar_red {
                return Resolucion::Indecidible;
            }
            match evaluar_gracia(base_ms, ahora_ms, consumido_ms) {
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

/// RI-36 · Suma al tiempo sin conexión ya gastado lo que ha pasado desde la última vez que se contó.
///
/// La gracia se medía restando fechas del reloj del equipo, y eso se puede trampear: quien atrasara
/// el reloj unas horas cada poco se quedaba dentro de las 72 h para siempre. Comparar con la última
/// fecha vista no lo arreglaba —basta con no atrasarlo por debajo de ella—. Lo que no se puede
/// atrasar es el reloj MONÓTONO del proceso, así que:
/// - con la app abierta (`monotono_ms` = lo transcurrido según él desde la última cuenta), cuenta lo
///   mayor de los dos relojes: atrasar el de pared no resta, y una suspensión —que el monótono puede
///   no contar— la cuenta el de pared;
/// - entre un arranque y otro no hay monótono, y cuenta el de pared, nunca hacia atrás.
///
/// Lo único que se puede esconder así es el rato con la app cerrada, que no importa: cerrada no vende.
pub fn sumar_tiempo_sin_conexion(consumido_ms: i64, monotono_ms: Option<i64>, pared_ms: i64) -> i64 {
    let paso = match monotono_ms {
        Some(m) => m.max(pared_ms),
        None => pared_ms,
    };
    consumido_ms.saturating_add(paso.max(0))
}

/// Cuánta gracia offline se ha gastado: lo que dice el reloj desde la base o lo que se ha contado
/// (`sumar_tiempo_sin_conexion`), lo que sea mayor. Para alguien honrado son lo mismo; para quien ha
/// atrasado el reloj, manda lo contado.
pub fn gracia_gastada(base_ms: i64, ahora_ms: i64, consumido_ms: i64) -> i64 {
    ahora_ms.saturating_sub(base_ms).max(consumido_ms)
}

pub fn evaluar_gracia(base_ms: i64, ahora_ms: i64, consumido_ms: i64) -> Gracia {
    if ahora_ms + TOLERANCIA_RELOJ_MS < base_ms {
        return Gracia::RelojAtrasado;
    }
    if gracia_gastada(base_ms, ahora_ms, consumido_ms) <= GRACIA_OFFLINE_MS {
        Gracia::Vigente
    } else {
        Gracia::Agotada
    }
}

use crate::texto::limpiar_opcional as limpia_opcional;

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
        for (e, permite, motivo) in [
            (EstadoLicencia::Active, true, "ok"),
            (EstadoLicencia::Warn, true, "warn"),
            (EstadoLicencia::ExpiryGrace, true, "expiry_grace"),
            (EstadoLicencia::Expired, false, "expired"),
            (EstadoLicencia::Revoked, false, "revoked"),
            (EstadoLicencia::DeviceReplaced, false, "device_replaced"),
        ] {
            let v = evaluar_estado(e);
            assert_eq!(v.permitido, permite, "{:?}", e);
            assert_eq!(v.motivo.codigo(), motivo, "{:?}", e);
        }
    }

    #[test]
    fn firma_invalida_bloquea_pero_no_borra() {
        match evaluar_fallo(&FalloConsulta::FirmaInvalida, AHORA, AHORA, 0, false) {
            Resolucion::Decidido(v) => {
                assert!(!v.permitido);
                assert_eq!(v.motivo.codigo(), "bad_signature");
            }
            Resolucion::Indecidible => panic!("una firma inválida siempre decide: bloquea"),
        }
    }

    #[test]
    fn un_reloj_desfasado_no_se_cuenta_como_falta_de_red() {
        // REV-10. El veredicto es el MISMO que sin conexión —la licencia es buena y el TPV tiene
        // que seguir vendiendo—, así que lo que se fija es el motivo: es lo único que le llega a
        // quien está delante, y es lo único que puede arreglar. Contado como «sin conexión», el
        // usuario veía 72 h de cuenta atrás y luego un bloqueo que hablaba de internet.
        let base = AHORA - 1000;

        match evaluar_fallo(&FalloConsulta::RelojDesfasado, base, AHORA, 0, false) {
            Resolucion::Decidido(v) => {
                assert!(v.permitido, "con gracia vigente se sigue vendiendo");
                assert_eq!(v.motivo.codigo(), "clock_skew_detected");
            }
            _ => panic!("tiene que decidir"),
        }

        // Y agotada la gracia bloquea, pero diciendo lo mismo: la acción de quien está delante no
        // cambia porque hayan pasado tres días.
        let vieja = AHORA - GRACIA_OFFLINE_MS - 1;
        match evaluar_fallo(&FalloConsulta::RelojDesfasado, vieja, AHORA, 0, false) {
            Resolucion::Decidido(v) => {
                assert!(!v.permitido);
                assert_eq!(v.motivo.codigo(), "clock_skew_detected");
            }
            _ => panic!("tiene que decidir"),
        }
    }

    #[test]
    fn sin_conexion_de_verdad_sigue_diciendo_lo_de_siempre() {
        // La otra mitad: si esto cambiara, un corte de internet pasaría a echarle la culpa al reloj.
        let base = AHORA - 1000;
        match evaluar_fallo(&FalloConsulta::Inalcanzable, base, AHORA, 0, false) {
            Resolucion::Decidido(v) => assert_eq!(v.motivo.codigo(), "offline_grace"),
            _ => panic!("tiene que decidir"),
        }
        let vieja = AHORA - GRACIA_OFFLINE_MS - 1;
        match evaluar_fallo(&FalloConsulta::Inalcanzable, vieja, AHORA, 0, false) {
            Resolucion::Decidido(v) => assert_eq!(v.motivo.codigo(), "offline_expired"),
            _ => panic!("tiene que decidir"),
        }
    }

    /// RI-09. Un `license_not_found` sin firmar —una base equivocada, una copia restaurada— dejaba a
    /// todos los bares teniendo que volver a teclear la clave. Ahora sigue la gracia offline con su
    /// propio motivo, y al agotarse bloquea sin echarle la culpa a la red.
    #[test]
    fn un_rechazo_sin_firmar_sigue_la_gracia_con_su_propio_motivo() {
        let fallo = FalloConsulta::RechazoSinFirmar { code: "license_not_found".into() };
        match evaluar_fallo(&fallo, AHORA - 1000, AHORA, 0, false) {
            Resolucion::Decidido(v) => {
                assert!(v.permitido, "con gracia vigente se sigue vendiendo");
                assert_eq!(v.motivo.codigo(), "rejection_unverified");
            }
            Resolucion::Indecidible => panic!("un rechazo siempre decide"),
        }
        match evaluar_fallo(&fallo, AHORA - GRACIA_OFFLINE_MS - 1, AHORA, 0, false) {
            Resolucion::Decidido(v) => {
                assert!(!v.permitido);
                assert_eq!(v.motivo.codigo(), "rejection_unverified");
            }
            Resolucion::Indecidible => panic!("un rechazo siempre decide"),
        }
    }

    #[test]
    fn sin_red_se_aguanta_hasta_agotar_la_gracia() {
        assert_eq!(evaluar_gracia(AHORA - GRACIA_OFFLINE_MS + 1, AHORA, 0), Gracia::Vigente);
        assert_eq!(evaluar_gracia(AHORA - GRACIA_OFFLINE_MS - 1, AHORA, 0), Gracia::Agotada);
    }

    #[test]
    fn atrasar_el_reloj_no_estira_la_gracia() {
        assert_eq!(evaluar_gracia(AHORA + TOLERANCIA_RELOJ_MS + 1, AHORA, 0), Gracia::RelojAtrasado);
    }

    /// RI-36. El caso que se colaba: atrasar el reloj poco a poco, sin bajar nunca de la última
    /// comprobación. El reloj de pared dice que ha pasado una hora; lo contado, cuatro días.
    #[test]
    fn atrasar_el_reloj_poco_a_poco_no_estira_la_gracia() {
        let base = AHORA - HORA_MS;
        let contado = 4 * 24 * HORA_MS;
        assert_eq!(evaluar_gracia(base, AHORA, contado), Gracia::Agotada);
        match evaluar_fallo(&FalloConsulta::Inalcanzable, base, AHORA, contado, false) {
            Resolucion::Decidido(v) => {
                assert!(!v.permitido);
                assert_eq!(v.motivo.codigo(), "offline_expired");
            }
            Resolucion::Indecidible => panic!("sin red siempre decide"),
        }
    }

    #[test]
    fn con_la_app_abierta_manda_el_monotono_si_el_reloj_va_hacia_atras() {
        // Ha pasado una hora de verdad, pero alguien ha atrasado el reloj tres horas.
        assert_eq!(sumar_tiempo_sin_conexion(10, Some(HORA_MS), -2 * HORA_MS), 10 + HORA_MS);
        // Una suspensión: el monótono puede no contarla, el de pared sí.
        assert_eq!(sumar_tiempo_sin_conexion(0, Some(1_000), 8 * HORA_MS), 8 * HORA_MS);
    }

    #[test]
    fn entre_arranques_cuenta_el_reloj_de_pared_y_nunca_resta() {
        assert_eq!(sumar_tiempo_sin_conexion(5_000, None, 3_000), 8_000);
        assert_eq!(sumar_tiempo_sin_conexion(5_000, None, -3_000), 5_000);
    }

    /// Para quien no toca el reloj, lo contado y lo que dice el reloj coinciden: nada cambia.
    #[test]
    fn sin_trampas_la_gracia_es_la_de_siempre() {
        let base = AHORA - 10 * HORA_MS;
        assert_eq!(gracia_gastada(base, AHORA, 10 * HORA_MS), 10 * HORA_MS);
        assert_eq!(evaluar_gracia(base, AHORA, 10 * HORA_MS), Gracia::Vigente);
    }

    const HORA_MS: i64 = 60 * 60 * 1000;

    #[test]
    fn la_activacion_exige_clave_y_nombre_de_negocio() {
        assert!(SolicitudActivacion::validar("  ".into(), "Bar".into(), None, None, None).is_err());
        assert!(SolicitudActivacion::validar("K".into(), "  ".into(), None, None, None).is_err());

        let s = SolicitudActivacion::validar(
            " K ".into(),
            " Bar ".into(),
            Some("  ".into()),
            Some(" +34 600 ".into()),
            None,
        )
        .expect("válida");
        assert_eq!(s.clave, "K");
        assert_eq!(s.business_name, "Bar");
        assert_eq!(s.legal_name, None);
        assert_eq!(s.phone.as_deref(), Some("+34 600"));
        assert!(!s.solo_sumar);
    }

    #[test]
    fn el_canje_solo_pide_la_clave_y_lleva_la_marca() {
        assert!(SolicitudActivacion::para_sumar("  ".into()).is_err());
        let s = SolicitudActivacion::para_sumar(" K ".into()).expect("válida");
        assert_eq!(s.clave, "K");
        assert!(s.solo_sumar);
    }

    // ── AUD-06 · una base sólo se usa con la licencia de su negocio ─────────────────────────

    #[test]
    fn la_procedencia_la_dice_el_sello() {
        let de = |s: &str| Sello::De(s.into());
        assert_eq!(procedencia(&de("a"), "a"), Procedencia::Suya);
        assert_eq!(procedencia(&de("a"), " a "), Procedencia::Suya);
        assert_eq!(procedencia(&de("a"), "x"), Procedencia::DeOtroNegocio);
        assert_eq!(procedencia(&Sello::Ninguno, "x"), Procedencia::SinSello);
        assert_eq!(procedencia(&Sello::Ilegible, "x"), Procedencia::Desconocida);
        // Un sello vacío no dice nada: nunca coincide con una licencia sin negocio.
        assert_eq!(Sello::leido(Some("  ")), Sello::Ninguno);
        assert_eq!(Sello::leido(Some(" a ")), de("a"));
        assert_eq!(procedencia(&de(""), ""), Procedencia::DeOtroNegocio);
    }

    #[test]
    fn una_base_solo_se_usa_con_la_licencia_de_su_negocio() {
        use QueHacerConLaBase::{Apartar, Reconstruir, Sellar, Usar};
        let de = |s: &str| Sello::De(s.into());

        // La base del negocio de la licencia: se usa; si la licencia viene de otro equipo, es de antes.
        assert_eq!(que_hacer_con_la_base(&de("a"), "a", false), Usar);
        assert_eq!(que_hacer_con_la_base(&de("a"), "a", true), Reconstruir);
        // Sin sello (recién creada, o anterior a los sellos): se sella, o se reconstruye sellándola.
        assert_eq!(que_hacer_con_la_base(&Sello::Ninguno, "a", false), Sellar);
        assert_eq!(que_hacer_con_la_base(&Sello::Ninguno, "a", true), Reconstruir);
        // De otro negocio: se aparta, lo diga el servidor o no (el reintento de una respuesta
        // perdida no lo dice, y un estreno que falló a medias tampoco).
        assert_eq!(que_hacer_con_la_base(&de("a"), "x", false), Apartar);
        assert_eq!(que_hacer_con_la_base(&de("a"), "x", true), Apartar);
        // Ilegible: no consta de quién es, y nunca se trata como «sin sello».
        assert_eq!(que_hacer_con_la_base(&Sello::Ilegible, "a", false), Apartar);
        assert_eq!(que_hacer_con_la_base(&Sello::Ilegible, "a", true), Apartar);
    }
}

#[cfg(test)]
mod tests_lo_pedido_y_lo_concedido {
    //! AUD-01: lo que la nube concede no se guarda sin mirar qué se le pidió.

    use super::*;

    const MIO: Option<&str> = Some("negocio-a");

    /// El canje desde Configuración: una suma sobre la licencia de su negocio, y nada más.
    #[test]
    fn quien_pide_solo_sumar_espera_una_suma_en_su_negocio() {
        assert!(comprobar_concesion(true, MIO, "negocio-a", true).is_ok());
        assert!(comprobar_concesion(true, Some(" negocio-a "), "negocio-a", true).is_ok());
    }

    /// Lo que pasaba si la licencia se anulaba o se trasladaba a mitad del canje: la nube estrenaba
    /// un negocio con esa clave, y el equipo guardaba su token y su clave de cifrado antes de que
    /// nadie mirase que no era una suma.
    #[test]
    fn un_solo_sumar_que_no_vuelve_como_suma_no_se_guarda() {
        // Un negocio nuevo, o un traslado.
        assert_eq!(comprobar_concesion(true, MIO, "negocio-nuevo", false), Err(MSG_CLAVE_NO_SUMADA));
        // Ni aunque el negocio sea el suyo: no es lo que pidió.
        assert_eq!(comprobar_concesion(true, MIO, "negocio-a", false), Err(MSG_CLAVE_NO_SUMADA));
    }

    /// Una suma no cambia de negocio, se pidiera con `solo_sumar` o desde la pantalla de activación.
    #[test]
    fn una_suma_en_otro_negocio_no_se_guarda() {
        assert_eq!(comprobar_concesion(true, MIO, "negocio-b", true), Err(MSG_SUMADA_A_OTRO_NEGOCIO));
        assert_eq!(comprobar_concesion(false, MIO, "negocio-b", true), Err(MSG_SUMADA_A_OTRO_NEGOCIO));
    }

    /// Sumar es sumar a la licencia que el equipo ya tiene: sin ella, la clave ni sale.
    #[test]
    fn sin_licencia_guardada_no_se_pide_sumar() {
        assert_eq!(comprobar_solicitud(true, None), Err(MSG_SIN_LICENCIA_A_LA_QUE_SUMAR));
        assert_eq!(comprobar_concesion(true, None, "negocio-a", true), Err(MSG_SIN_LICENCIA_A_LA_QUE_SUMAR));
        assert!(comprobar_solicitud(true, MIO).is_ok());
        assert!(comprobar_solicitud(false, None).is_ok());
    }

    /// Los caminos en los que el negocio cambia a propósito: una primera activación o un traslado
    /// con su código no son sumas ni se piden con `solo_sumar`. Y un equipo sin licencia guardada no
    /// tiene negocio con el que comparar una suma.
    #[test]
    fn estrenar_o_trasladar_si_cambian_de_negocio() {
        assert!(comprobar_concesion(false, MIO, "negocio-b", false).is_ok());
        assert!(comprobar_concesion(false, None, "negocio-b", false).is_ok());
        assert!(comprobar_concesion(false, None, "negocio-b", true).is_ok());
        assert!(comprobar_concesion(false, MIO, "negocio-a", true).is_ok());
    }
}
