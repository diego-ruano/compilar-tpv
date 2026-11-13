//! Puerto del **estado del contraste con la nube** (VERIF-02): lo que el job `verificar_nube`
//! recuerda de sus pasadas y lo que la base local dice del momento.
//!
//! La regla que decide con esto es pura y vive en `tpv_domain::verificacion_nube`; quien la
//! orquesta, en `use_cases::verificacion_nube`.

use async_trait::async_trait;

use crate::error::AppResult;

/// Lo que sólo la base local sabe del momento. Las horas, en milisegundos de época.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SituacionVerificacion {
    /// La última pasada que llegó a comparar.
    pub ultima_ok_ms: Option<i64>,
    /// El último intento, acabara como acabara.
    pub ultimo_intento_ms: Option<i64>,
    /// Intentos fallidos seguidos.
    pub fallos: i64,
    /// El último cierre de caja sin reabrir.
    pub ultimo_cierre_ms: Option<i64>,
    /// Queda histórico por bajar (VERIF-01).
    pub historico_pendiente: bool,
    /// Operaciones pendientes de subir, sin las apartadas.
    pub outbox_pendiente: i64,
    /// Hay un cambio de la nube detenido (un fallo de bajada sin cuarentena).
    pub bajada_detenida: bool,
    /// La última escritura: una operación de aquí o un cambio aplicado de la nube.
    pub ultima_escritura_ms: Option<i64>,
}

/// Cómo acabó un intento de contraste.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentoVerificacion {
    /// Se comparó: es una pasada buena, encontrara lo que encontrara.
    Hecha,
    /// La nube contestó, pero su foto iba por delante de lo que ha bajado esta Main: no se comparó.
    Aplazada,
    /// No se pudo: la nube no contestó, o contestó algo que no se entiende.
    Fallida,
}

#[async_trait]
pub trait VerificacionNubeRepository: Send + Sync {
    /// Lo que hay a la hora `ahora_ms`. Sólo lee.
    ///
    /// La hora hace falta para la última escritura: es la más reciente que no pasa de `ahora_ms` en
    /// más de `tpv_domain::verificacion_nube::MARCA_FUTURA_CREIBLE_MS`. Una fechada más allá es de
    /// un reloj que estuvo adelantado, y taparía las escrituras de verdad hechas después.
    async fn situacion(&self, ahora_ms: i64) -> AppResult<SituacionVerificacion>;

    /// Anota cómo acabó el intento que empezó en `ahora_ms`. Es estado local del equipo: no se
    /// replica.
    async fn anotar(&self, intento: IntentoVerificacion, ahora_ms: i64) -> AppResult<()>;
}
