//! # tpv-infra-aeat
//!
//! Adaptador de **remisión a la AEAT** (FISCAL-01, Veri\*factu). Es el único punto del diseño que
//! sale a internet con datos fiscales, y está aislado en su propia crate por dos motivos: trae la
//! dependencia de la API de Windows, y así se ve en el mapa qué habla con Hacienda y qué no.
//!
//! ## Lo que hace y lo que no
//!
//! Hace: construir el sobre SOAP desde la fila ya escrita, mandarlo por TLS mutuo con el
//! certificado del almacén de Windows, y transcribir la respuesta.
//!
//! **No hace**: decidir qué significa esa respuesta. Clasificar (aceptado / aceptado con errores /
//! rechazado / duplicado) es del caso de uso, que es donde se puede probar sin red. Aquí sólo se
//! transcribe lo que dijo la AEAT.
//!
//! Y sobre todo: **no recalcula nada**. Importes, huella y bloque del sistema informático salen tal
//! cual de la fila. Ver la nota de cabecera de [`xml`].

pub mod xml;

#[cfg(windows)]
mod certificados;
#[cfg(windows)]
mod transporte;

use async_trait::async_trait;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::aeat::{
    endpoint, AeatClient, CabeceraEnvio, CertificadoDisponible, EntornoAeat, RegistroParaEnvio,
    RespuestaRemision, TipoCertificado,
};

/// Máximo de registros por envío. Lo fija el diseño de registro (`maxOccurs="1000"` en el XSD) y
/// pasarse es un `4114` que rechaza el envío entero.
pub const MAX_REGISTROS_POR_ENVIO: usize = 1000;

/// Espera inicial entre envíos, en segundos (art. 16.2 de la Orden HAC/1177/2024).
///
/// No es un parámetro nuestro: es el valor con el que arranca el mecanismo de control de flujo, y
/// la AEAT lo actualiza en cada respuesta con `TiempoEsperaEnvio`.
pub const ESPERA_INICIAL_SEGUNDOS: i64 = 60;

/// El adaptador. En Windows habla de verdad; en el resto de plataformas existe para que compile.
pub struct AeatAdapter {
    /// Carpeta donde se deja cada respuesta en bruto. Sólo para los arneses de `examples/`.
    #[cfg_attr(not(windows), allow(dead_code))]
    volcado: Option<std::path::PathBuf>,
}

impl AeatAdapter {
    pub fn new() -> Self {
        Self { volcado: None }
    }

    /// Igual que [`Self::new`], pero guarda cada respuesta de `remitir` tal cual llegó, en un
    /// fichero de `dir`.
    ///
    /// Es para capturar respuestas **reales** de preproducción con las que probar el parser: los
    /// XML escritos a mano son los que dejaron pasar RI-89. El TPV no lo usa, y un fallo al
    /// escribir no afecta al envío.
    pub fn con_volcado(dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            volcado: Some(dir.into()),
        }
    }
}

impl Default for AeatAdapter {
    fn default() -> Self {
        Self::new()
    }
}

/// ¿A qué endpoint va este certificado?
///
/// Lo decide el **tipo de certificado**, no quién envía: el WSDL declara un puerto
/// `SistemaVerifactuSello` separado porque los certificados de sello de entidad entran por otra
/// subsede. Es una cuenta interna que el usuario no ve.
#[cfg(windows)]
fn tipo_de(cert: &CertificadoDisponible) -> TipoCertificado {
    if cert.es_sello {
        TipoCertificado::Sello
    } else {
        TipoCertificado::Persona
    }
}

#[cfg(windows)]
#[async_trait]
impl AeatClient for AeatAdapter {
    async fn certificados(&self) -> AppResult<Vec<CertificadoDisponible>> {
        // La enumeración toca la API de Windows (bloqueante) y puede tardar si hay una tarjeta
        // conectada: fuera del hilo del runtime.
        tokio::task::spawn_blocking(certificados::listar)
            .await
            .map_err(|e| AppError::internal(format!("listando certificados: {e}")))?
            .map_err(AppError::external)
    }

    async fn remitir(
        &self,
        entorno: EntornoAeat,
        huella_certificado: &str,
        cabecera: &CabeceraEnvio,
        registros: &[RegistroParaEnvio],
    ) -> AppResult<RespuestaRemision> {
        if registros.is_empty() {
            return Err(AppError::validation("No hay registros que remitir"));
        }
        if registros.len() > MAX_REGISTROS_POR_ENVIO {
            return Err(AppError::validation(format!(
                "Un envío no admite más de {MAX_REGISTROS_POR_ENVIO} registros"
            )));
        }

        let cert = certificados::buscar(huella_certificado)
            .map_err(AppError::external)?
            .ok_or_else(|| {
                // El certificado que se eligió ya no está. Pasa cada año o cada dos, cuando se
                // renueva: cambia de huella y el guardado deja de existir. Lo que NO puede es dejar
                // de remitir en silencio, así que esto sube hasta el panel.
                AppError::external(
                    "El certificado elegido ya no está en el almacén de Windows. Elige otro en \
                     Configuración → Fiscal (probablemente se ha renovado).",
                )
            })?;

        let url = endpoint(entorno, tipo_de(&cert)).to_string();
        let cuerpo = xml::construir_envio(cabecera, registros);
        let huella = huella_certificado.to_string();

        let respuesta =
            tokio::task::spawn_blocking(move || transporte::post_soap(&url, &huella, &cuerpo))
                .await
                .map_err(|e| AppError::internal(format!("enviando a la AEAT: {e}")))?
                .map_err(AppError::external)?;

        if let Some(dir) = &self.volcado {
            let nombre = format!("respuesta-{}.xml", chrono::Local::now().format("%Y%m%d-%H%M%S%3f"));
            let _ = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(dir.join(nombre), &respuesta));
        }

        xml::leer_respuesta(&respuesta).map_err(AppError::external)
    }

    async fn probar_conexion(
        &self,
        entorno: EntornoAeat,
        huella_certificado: &str,
        obligado: Option<&CabeceraEnvio>,
    ) -> AppResult<String> {
        let cert = certificados::buscar(huella_certificado)
            .map_err(AppError::external)?
            .ok_or_else(|| AppError::external("Ese certificado ya no está en el almacén"))?;

        let url = endpoint(entorno, tipo_de(&cert)).to_string();
        let huella = huella_certificado.to_string();

        // Se manda un sobre SIN REGISTROS a propósito. La AEAT contesta con un Fault, y eso basta:
        // lo que se está probando es el HANDSHAKE, no el contenido. Mandar un registro de verdad
        // para «probar» sería emitir una factura.
        //
        // La cabecera sí importa, y por eso es un parámetro. Con el NIF del obligado de verdad la
        // validación de formato pasa y la AEAT llega a mirar si el titular del certificado está
        // autorizado sobre ese NIF — que es lo otro que puede tumbar un envío real. Con la de
        // relleno, se queda en el error 4116 y sólo se prueba el transporte.
        let cabecera = obligado.cloned().unwrap_or(CabeceraEnvio {
            nif_obligado: "00000000T".to_string(),
            nombre_razon_obligado: "PRUEBA DE CONEXION".to_string(),
            incidencia: false,
        });
        let sonda = xml::construir_envio(&cabecera, &[]);

        let cuerpo =
            tokio::task::spawn_blocking(move || transporte::post_soap(&url, &huella, &sonda))
                .await
                .map_err(|e| AppError::internal(format!("probando la conexión: {e}")))?
                .map_err(AppError::external)?;

        // Llegar hasta aquí ya es el resultado: hubo handshake TLS y el servidor contestó. Lo que
        // conteste da igual (será un Fault de esquema), pero se devuelve para el diagnóstico.
        Ok(resumen_respuesta(&cuerpo))
    }
}

/// Un resumen legible de la respuesta para la pantalla de diagnóstico.
#[cfg(windows)]
fn resumen_respuesta(cuerpo: &str) -> String {
    match xml::leer_respuesta(cuerpo) {
        Ok(r) => format!(
            "Conexión correcta. La AEAT respondió: {} ({} líneas).",
            r.estado_envio,
            r.lineas.len()
        ),
        // Un Fault aquí es lo ESPERADO: la sonda va sin registros a propósito. Que conteste un
        // Fault de esquema significa que el TLS mutuo funcionó y que el servidor nos leyó.
        Err(e) => format!("Conexión correcta (el servidor respondió: {e})"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuera de Windows
// ─────────────────────────────────────────────────────────────────────────────

/// Implementación vacía para las plataformas que no son Windows.
///
/// No es un hueco pendiente: **la Handy no remite porque no cobra**, y el `libtpv_lib.so` de
/// Android tiene que seguir construyéndose sin arrastrar la API de Windows. El puerto existe
/// igualmente para que el resto del código no tenga que preguntar en qué plataforma corre.
#[cfg(not(windows))]
#[async_trait]
impl AeatClient for AeatAdapter {
    async fn certificados(&self) -> AppResult<Vec<CertificadoDisponible>> {
        Ok(Vec::new())
    }

    async fn remitir(
        &self,
        _entorno: EntornoAeat,
        _huella_certificado: &str,
        _cabecera: &CabeceraEnvio,
        _registros: &[RegistroParaEnvio],
    ) -> AppResult<RespuestaRemision> {
        let _ = endpoint(EntornoAeat::Pruebas, TipoCertificado::Persona);
        Err(AppError::external(
            "La remisión a la AEAT sólo está disponible en el TPV principal (Windows)",
        ))
    }

    async fn probar_conexion(
        &self,
        _entorno: EntornoAeat,
        _huella_certificado: &str,
        _obligado: Option<&CabeceraEnvio>,
    ) -> AppResult<String> {
        Err(AppError::external(
            "La remisión a la AEAT sólo está disponible en el TPV principal (Windows)",
        ))
    }
}
