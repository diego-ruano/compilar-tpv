//! Puerto de **remisión a la AEAT** (FISCAL-01).
//!
//! Está separado de `VerifactuRepository` por tres razones que no son de estilo:
//!
//! 1. Su implementación de verdad **sólo existe en Windows**: necesita el almacén de certificados
//!    del sistema para autenticar la conexión (TLS mutuo). El `libtpv_lib.so` del Handy tiene que
//!    seguir construyéndose, y la Handy no remite porque no cobra.
//! 2. **Los tests automáticos no pueden usarla.** El certificado vive en el almacén de una máquina
//!    concreta; lo que se puede probar sin red está del otro lado de esta frontera, y el cliente de
//!    verdad se ejercita a mano contra preproducción.
//! 3. Es lo único de todo el diseño que **sale a internet**, y conviene que eso se vea en el mapa.
//!
//! ⚠️ Y una nota que decide la arquitectura: en VERI\*FACTU **no se firma la factura**. La firma
//! electrónica del registro (XAdES) es un requisito de la modalidad NO VERI\*FACTU. Aquí el
//! certificado sirve para **una cosa sola**: autenticar la conexión con el servicio web. La
//! integridad la da la cadena de huellas, que es un SHA-256 pelado.

use async_trait::async_trait;

use crate::error::AppResult;

/// Entorno al que se remite. Decide el endpoint, y lo decide junto con la URL del QR que se
/// imprime: son la misma decisión, y separarlas es la forma de imprimir un ticket de producción con
/// un QR que apunta a preproducción.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntornoAeat {
    Produccion,
    Pruebas,
}

/// Tipo del certificado elegido. **Decide el endpoint**, no quién envía.
///
/// El WSDL declara un puerto `SistemaVerifactuSello` separado porque los certificados de **sello de
/// entidad** (tipos 4 y 8 en @firma) entran por otra subsede (`www10` / `prewww10`). Los de persona
/// física y representante van por `www1` / `prewww1`. Es una cuenta interna: el usuario elige su
/// certificado de una lista y no ve nada de esto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TipoCertificado {
    /// Persona física o representante.
    Persona,
    /// Sello de entidad.
    Sello,
}

/// Los cuatro endpoints del servicio, tal como los declara `SistemaFacturacion.wsdl`.
///
/// Están aquí y no en una constante suelta porque la combinación (entorno × tipo de certificado) es
/// lo que decide a cuál se va, y verlos juntos es lo que evita el error que se comete a las dos de
/// la mañana: `prewww1` y `www1` se distinguen en tres caracteres.
pub fn endpoint(entorno: EntornoAeat, tipo: TipoCertificado) -> &'static str {
    match (entorno, tipo) {
        (EntornoAeat::Produccion, TipoCertificado::Persona) => {
            "https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP"
        }
        (EntornoAeat::Produccion, TipoCertificado::Sello) => {
            "https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP"
        }
        (EntornoAeat::Pruebas, TipoCertificado::Persona) => {
            "https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP"
        }
        (EntornoAeat::Pruebas, TipoCertificado::Sello) => {
            "https://prewww10.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP"
        }
    }
}

/// La cabecera del envío: quién es el obligado y si esto llega tarde.
#[derive(Debug, Clone)]
pub struct CabeceraEnvio {
    pub nif_obligado: String,
    pub nombre_razon_obligado: String,
    /// `RemisionVoluntaria/Incidencia = "S"` cuando el envío **no pudo ser inmediato**: se acumuló
    /// cola por falta de red, o se acaba de restaurar el equipo. Es la forma que da la norma de
    /// decir «esto llega tarde y sé por qué», y usarla es mejor que no usarla.
    pub incidencia: bool,
}

/// Un registro listo para remitir, **leído de su fila** y no recompuesto.
///
/// Todos los importes son ya el texto exacto que se guardó y que entró en la cadena hasheada. El
/// adaptador no recalcula nada: si lo hiciera, la huella que manda dejaría de corresponder a los
/// datos que la acompañan y la AEAT lo marcaría como «aceptado con errores» (código 2000).
#[derive(Debug, Clone)]
pub struct RegistroParaEnvio {
    pub id_registro: String,
    /// `ALTA` | `ANULACION`.
    pub tipo: String,
    pub nif_emisor: String,
    pub num_serie_factura: String,
    /// `DD-MM-AAAA`.
    pub fecha_expedicion: String,
    pub nombre_razon_emisor: String,
    pub tipo_factura: Option<String>,
    pub tipo_rectificativa: Option<String>,
    pub descripcion_operacion: Option<String>,
    pub importe_total: Option<String>,
    pub cuota_total: Option<String>,
    /// El desglose, como lo guardó `desglose_json`.
    pub desglose_json: Option<String>,
    pub destinatario_json: Option<String>,
    pub referencias_json: Option<String>,
    pub macrodato: Option<String>,
    pub primer_registro: Option<String>,
    pub ant_nif: Option<String>,
    pub ant_num_serie: Option<String>,
    pub ant_fecha: Option<String>,
    pub ant_huella: Option<String>,
    pub huella: String,
    pub tipo_huella: String,
    /// `AAAA-MM-DDThh:mm:ss±hh:mm`.
    pub fecha_hora_huso: String,
    /// El bloque `SistemaInformatico` congelado, como lo guardó `SistemaInformatico::to_json`.
    pub sistema_json: String,
    pub subsanacion: Option<String>,
    pub rechazo_previo: Option<String>,
    pub sin_registro_previo: Option<String>,
}

/// Cómo quedó UN registro dentro del envío.
///
/// La clasificación no la hace el adaptador: sólo transcribe lo que dijo la AEAT. Decidir qué
/// significa cada combinación es del caso de uso, que es donde se puede probar.
#[derive(Debug, Clone)]
pub struct LineaRespuesta {
    /// El número de factura, con el que se casa contra el registro enviado.
    pub num_serie_factura: String,
    /// `Correcto` | `AceptadoConErrores` | `Incorrecto`.
    pub estado: String,
    /// Código numérico del catálogo (`errores.properties`). El **rango** decide la clase:
    /// 2000-2999 son admisibles, 3000 es duplicado, el resto rechaza.
    pub codigo_error: Option<i64>,
    pub descripcion_error: Option<String>,
    /// Sólo si el rechazo fue por duplicado: en qué estado está el registro que ya tenían
    /// (`Correcta` | `AceptadaConErrores` | `Anulada`).
    pub estado_duplicado: Option<String>,
}

/// La respuesta completa de un envío.
#[derive(Debug, Clone)]
pub struct RespuestaRemision {
    /// `Correcto` | `ParcialmenteCorrecto` | `Incorrecto`.
    pub estado_envio: String,
    /// **Hay que guardarlo en el momento del alta**: la propia documentación avisa de que no se
    /// puede recuperar con una consulta posterior.
    pub csv: Option<String>,
    /// Segundos de espera hasta el siguiente envío (art. 16.2 de la Orden). Valor inicial 60.
    pub tiempo_espera_envio: Option<i64>,
    pub lineas: Vec<LineaRespuesta>,
}

/// Lo que hace falta saber de un certificado para elegirlo, **sin sacar nada de dentro**.
///
/// La huella digital (*thumbprint*) no es un secreto: identifica al certificado, no lo abre. Es lo
/// único que se guarda, y por eso el certificado **ni siquiera toca el almacén de secretos** de la
/// aplicación. Un secreto menos que proteger es un secreto menos que filtrar.
#[derive(Debug, Clone)]
pub struct CertificadoDisponible {
    /// SHA-1 del certificado, en hexadecimal y mayúsculas. Es su identificador en el almacén.
    pub huella: String,
    /// Para que la persona reconozca el suyo en la lista.
    pub sujeto: String,
    pub emisor: String,
    /// `AAAA-MM-DD`.
    pub valido_hasta: String,
    /// `CurrentUser` | `LocalMachine`. **Hay que decirlo**: el almacén es por usuario de Windows, y
    /// si la gestoría instaló el certificado con su sesión, el TPV corriendo como otro usuario no
    /// lo ve. Es una llamada de soporte garantizada, y la respuesta es esta palabra.
    pub almacen: String,
    /// ¿Es un certificado de **sello de entidad**? Decide el endpoint y nada más. La interfaz no lo
    /// menciona: es de pago, sólo se emite a personas jurídicas —un autónomo no puede tenerlo— y
    /// recomendarlo convierte una pantalla de dos clics en una conversación fiscal.
    pub es_sello: bool,
    /// ¿La clave privada se puede usar **sin interfaz de usuario**?
    ///
    /// Si es `false`, ese certificado no sirve para un job desatendido: pedirá un PIN o un diálogo
    /// en cada handshake. Las dos causas son la *«protección alta»* del asistente de importación
    /// (una casilla que alguien marcó sin querer, y que se arregla reimportando) y el PIN de una
    /// tarjeta o un DNIe (que no tiene arreglo: es del hardware).
    ///
    /// ⚠️ **No es infalible**: Microsoft documenta que con lectores con *pinpad* y drivers propios
    /// el flag de silencio se ignora y el diálogo sale igual. Por eso existe además el botón
    /// «probar ahora», que hace un handshake real con el usuario delante.
    pub uso_silencioso: bool,
}

/// El cliente del servicio web de la AEAT.
#[async_trait]
pub trait AeatClient: Send + Sync {
    /// Los certificados del almacén de Windows que **tienen clave privada**.
    ///
    /// El filtro es técnico y es el único: un `.cer` o un `.crt` sólo llevan la parte pública, así
    /// que no pueden autenticar nada. Si alguien instala uno de esos creyendo que ya está,
    /// simplemente no sale en la lista.
    ///
    /// Se busca en `CurrentUser` **y** en `LocalMachine`, y se dice en cuál se encontró.
    async fn certificados(&self) -> AppResult<Vec<CertificadoDisponible>>;

    /// Remite un lote (máximo 1000 registros, que es el tope del diseño de registro).
    async fn remitir(
        &self,
        entorno: EntornoAeat,
        huella_certificado: &str,
        cabecera: &CabeceraEnvio,
        registros: &[RegistroParaEnvio],
    ) -> AppResult<RespuestaRemision>;

    /// Handshake real contra el entorno indicado, **sin enviar ningún registro**.
    ///
    /// Es el botón «probar ahora» de la pantalla de selección, y existe por una razón concreta: si
    /// el certificado esconde un diálogo de PIN, sale **ahí, con el usuario delante**, y no a las
    /// tres de la mañana con la cola creciendo en silencio.
    async fn probar_conexion(
        &self,
        entorno: EntornoAeat,
        huella_certificado: &str,
    ) -> AppResult<String>;
}
