//! Puertos de **Veri\*factu** (FISCAL-01).
//!
//! Dos interfaces, y la separación importa:
//!
//! - [`VerifactuRepository`] es lo local: la cadena de registros, la cola de envío y el panel.
//! - [`AeatClient`] es lo que sale a internet. Es un puerto propio porque su implementación de
//!   verdad **sólo existe en Windows** (necesita el almacén de certificados del sistema para el
//!   TLS mutuo) y porque los tests no pueden usarla: el certificado vive en el almacén de una
//!   máquina concreta. Todo lo que se puede probar sin red está del otro lado de esta frontera.

use async_trait::async_trait;

use crate::error::AppResult;
use crate::ports::aeat::RegistroParaEnvio;
use tpv_contracts::verifactu::{BloqueFiscal, EstadoFiscal, RegistroFiscal};

/// En qué quedó un registro tras el envío: lo que [`VerifactuRepository::marcar_resultados`]
/// guarda en su fila de `_Verifactu_Envios`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultadoRegistro {
    pub id_registro: String,
    /// El estado de la cola (`EstadoEnvio::wire`).
    pub estado: &'static str,
    pub codigo_error: Option<i64>,
    pub descripcion_error: Option<String>,
    /// El CSV **del envío**, sólo en los aceptados. `None` no borra el que ya hubiera.
    pub csv: Option<String>,
}

/// La cadena de registros y su cola de envío, en local.
#[async_trait]
pub trait VerifactuRepository: Send + Sync {
    /// Resumen para el panel de Configuración → Fiscal y para la escalera de avisos.
    async fn estado(&self) -> AppResult<EstadoFiscal>;

    /// Los registros para el panel, del más reciente al más antiguo.
    async fn listar(&self, limite: i64, desplazamiento: i64) -> AppResult<Vec<RegistroFiscal>>;

    // ── Cola de envío ───────────────────────────────────────────────────────────────────────────

    /// Los registros pendientes de remitir, **por `Orden` ascendente**.
    ///
    /// El orden no es una preferencia: la AEAT valida cada registro contra su encadenamiento
    /// anterior, así que mandar el eslabón N+1 antes que el N es mandarlo contra una huella que
    /// todavía no tiene.
    async fn pendientes(&self, limite: i64) -> AppResult<Vec<RegistroParaEnvio>>;

    /// Cuántos hay pendientes. Se usa para el control de flujo (el tope de 1000 manda sobre el
    /// reloj) y para el panel.
    async fn contar_pendientes(&self) -> AppResult<i64>;

    /// El estado del control de flujo: `(espera_en_segundos, instante_del_ultimo_envio_ms)`.
    async fn flujo(&self) -> AppResult<(i64, Option<i64>)>;

    /// Guarda el estado del control de flujo tras un envío.
    async fn guardar_flujo(&self, espera_s: i64, ultimo_envio_ms: i64) -> AppResult<()>;

    /// Anota en qué quedó cada registro de un envío, **todos a la vez** (RI-34).
    ///
    /// Un envío trae hasta 1000: anotarlos de uno en uno eran 1000 escrituras sueltas compitiendo
    /// con los cobros por el escritor, justo tras un atraso, que es cuando el lote viene lleno.
    async fn marcar_resultados(&self, resultados: &[ResultadoRegistro]) -> AppResult<()>;

    /// Anota que se intentó enviar estos registros y no se pudo procesar la respuesta.
    ///
    /// **Siguen `PENDIENTE`**: un fallo de transporte no dice nada de si la AEAT los tiene o no, y
    /// darlos por perdidos sería tan malo como darlos por buenos. Sólo se cuenta el intento, que es
    /// lo que alimenta el backoff y lo que se ve en el panel.
    async fn marcar_intento(&self, ids: &[String]) -> AppResult<()>;

    /// Los datos del obligado que van en la cabecera del envío, más el entorno.
    ///
    /// Devuelve `None` si faltan: sin ellos no hay nada que remitir, y no es un error del job sino
    /// una tarea del dueño.
    async fn obligado(&self) -> AppResult<Option<(String, String, bool)>>;

    /// Emite una **factura completa en sustitución** de un ticket ya expedido (`F3`, FISCAL-02).
    ///
    /// Es el *«¿me lo puedes hacer con IVA?»* del día siguiente. **No rectifica nada** (art. 15.6
    /// ROF): canjear una simplificada por una completa no es rectificar, y la original se queda
    /// exactamente como está.
    async fn emitir_sustitutiva(
        &self,
        num_serie_original: &str,
        destinatario: tpv_domain::verifactu::Destinatario,
    ) -> AppResult<BloqueFiscal>;
}
