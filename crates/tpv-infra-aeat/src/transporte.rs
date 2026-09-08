//! Transporte HTTPS con **certificado de cliente**, por WinHTTP.
//!
//! # Por qué WinHTTP y no `rustls-cng` (corrección al diseño original)
//!
//! El plan elegía `rustls-cng` para que la clave privada no saliera nunca del almacén. La idea es
//! la correcta y aquí se conserva entera; lo que no se sostiene es el mecanismo, y se descubrió
//! mirando los certificados que hay instalados de verdad:
//!
//! `rustls-cng` habla por **NCrypt**, que es la API de CNG y sólo abre claves guardadas en un
//! *Key Storage Provider*. Los certificados de la FNMT importados desde un `.p12` —que es como los
//! instala todo el mundo, y como estaban los dos de la máquina de desarrollo— quedan en un **CSP
//! heredado** (`Microsoft Enhanced Cryptographic Provider v1.0`, `dwProvType = 1`). NCrypt no los
//! ve. Con `rustls-cng`, el certificado que el bar tiene instalado sencillamente no aparecería, y
//! la única salida sería pedirle que lo reimporte con `certutil -importpfx -csp "Microsoft
//! Software Key Storage Provider"` — o sea, un paso manual con la contraseña del `.p12` delante de
//! cada cliente.
//!
//! WinHTTP va por debajo a **schannel**, la pila TLS del propio Windows, que es la que usan el
//! navegador y Autofirma. Y schannel sirve las tres formas por igual:
//!
//! | Cómo está la clave | `rustls-cng` (NCrypt) | WinHTTP (schannel) |
//! |---|---|---|
//! | KSP moderno (CNG) | ✅ | ✅ |
//! | CSP heredado (`.p12` importado) | ❌ **no la ve** | ✅ |
//! | Tarjeta / DNIe / token | ✅ | ✅ |
//!
//! Lo que motivaba la decisión original se mantiene intacto: **la clave privada no sale del
//! almacén**, no se parsea ningún formato, no hay contraseña que pedir ni que guardar, y lo único
//! que la aplicación persiste es la huella del certificado elegido. Se le pasa a WinHTTP el
//! `CERT_CONTEXT` del almacén (`WINHTTP_OPTION_CLIENT_CERT_CONTEXT`) y quien firma el handshake es
//! Windows.
//!
//! El precio: es **sólo Windows** (que ya era el precio de la opción original) y la API es
//! bloqueante, así que se llama desde `spawn_blocking`.

use std::ffi::c_void;

use windows_sys::Win32::Networking::WinHttp::*;
use windows_sys::Win32::Security::Cryptography::*;

/// Cabecera `User-Agent`. La AEAT no la exige, pero una traza sin agente es una traza que nadie
/// puede atribuir cuando hay que llamar a soporte.
const AGENTE: &str = "TPV-Altaria-Verifactu/1.0";

/// Timeouts en milisegundos. Generosos a propósito: un lote de 1000 registros tarda, y el peor caso
/// de un corte de red es que el job lo reintente — no que un bar se quede sin cobrar, porque cobrar
/// y remitir son dos cosas separadas en el tiempo.
const TIMEOUT_RESOLUCION_MS: u32 = 15_000;
const TIMEOUT_CONEXION_MS: u32 = 30_000;
const TIMEOUT_ENVIO_MS: u32 = 60_000;
const TIMEOUT_RECEPCION_MS: u32 = 120_000;

fn a_utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Trocea una URL `https://host/ruta` en sus partes. Sólo acepta HTTPS: los cuatro endpoints del
/// WSDL lo son, y aceptar HTTP aquí sería aceptar mandar registros de facturación en claro.
fn partir_url(url: &str) -> Result<(String, String), String> {
    let resto = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("la URL del servicio tiene que ser https: {url}"))?;
    match resto.find('/') {
        Some(i) => Ok((resto[..i].to_string(), resto[i..].to_string())),
        None => Ok((resto.to_string(), "/".to_string())),
    }
}

/// Cierra un manejador de WinHTTP al salir del ámbito, pase lo que pase.
///
/// Sin esto, cada `return` por error de los que hay más abajo dejaría una conexión abierta: en un
/// job que corre cada minuto, eso es una fuga que se ve a los pocos días.
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { WinHttpCloseHandle(self.0) };
        }
    }
}

/// Manda el sobre SOAP y devuelve el cuerpo de la respuesta.
///
/// `huella_certificado` identifica el certificado del almacén; su clave privada **no se toca aquí**:
/// se le da a WinHTTP el contexto del certificado y Windows hace la firma del handshake.
pub fn post_soap(url: &str, huella_certificado: &str, cuerpo: &str) -> Result<String, String> {
    let (host, ruta) = partir_url(url)?;

    unsafe {
        let sesion = Handle(WinHttpOpen(
            a_utf16(AGENTE).as_ptr(),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            0,
        ));
        if sesion.0.is_null() {
            return Err(format!("WinHttpOpen falló ({})", ultimo_error()));
        }
        WinHttpSetTimeouts(
            sesion.0,
            TIMEOUT_RESOLUCION_MS as i32,
            TIMEOUT_CONEXION_MS as i32,
            TIMEOUT_ENVIO_MS as i32,
            TIMEOUT_RECEPCION_MS as i32,
        );

        let conexion = Handle(WinHttpConnect(
            sesion.0,
            a_utf16(&host).as_ptr(),
            INTERNET_DEFAULT_HTTPS_PORT as u16,
            0,
        ));
        if conexion.0.is_null() {
            return Err(format!("no se pudo conectar con {host} ({})", ultimo_error()));
        }

        let peticion = Handle(WinHttpOpenRequest(
            conexion.0,
            a_utf16("POST").as_ptr(),
            a_utf16(&ruta).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        ));
        if peticion.0.is_null() {
            return Err(format!("WinHttpOpenRequest falló ({})", ultimo_error()));
        }

        // ── El certificado de cliente ──
        //
        // Aquí es donde ocurre lo que hace falta y nada más: se le pasa a WinHTTP el CONTEXTO del
        // certificado que está en el almacén. La clave privada no se lee, no se copia y no pasa por
        // este proceso; quien la usa para firmar el handshake es Windows.
        let ctx = super::certificados::contexto_por_huella(huella_certificado)?;
        let ok = WinHttpSetOption(
            peticion.0,
            WINHTTP_OPTION_CLIENT_CERT_CONTEXT,
            ctx.0 as *const c_void,
            std::mem::size_of::<CERT_CONTEXT>() as u32,
        );
        if ok == 0 {
            return Err(format!(
                "no se pudo usar el certificado para la conexión ({}). \
                 Si es de una tarjeta o un DNIe, comprueba que está insertado.",
                ultimo_error()
            ));
        }

        // ── Cabeceras y cuerpo ──
        //
        // `SOAPAction` va vacía porque así lo declara el WSDL (`soap:operation soapAction=""`), y
        // el `charset=utf-8` no es decorativo: el servicio exige UTF-8 y mandarlo sin declarar es
        // el error 4119.
        let cabeceras = a_utf16(
            "Content-Type: text/xml; charset=utf-8\r\n\
             SOAPAction: \"\"\r\n\
             Accept-Encoding: gzip, deflate\r\n",
        );
        let bytes = cuerpo.as_bytes();
        let enviado = WinHttpSendRequest(
            peticion.0,
            cabeceras.as_ptr(),
            (cabeceras.len() - 1) as u32,
            bytes.as_ptr() as *const c_void,
            bytes.len() as u32,
            bytes.len() as u32,
            0,
        );
        if enviado == 0 {
            return Err(traducir_error_envio(ultimo_error()));
        }

        if WinHttpReceiveResponse(peticion.0, std::ptr::null_mut()) == 0 {
            return Err(format!("la AEAT no respondió ({})", ultimo_error()));
        }

        let estado = codigo_estado(peticion.0);
        let cuerpo = leer_cuerpo(peticion.0)?;

        // Un 200 con un `Fault` dentro también llega por aquí: eso lo interpreta `xml::leer_respuesta`.
        // Lo que se distingue aquí es el fallo de TRANSPORTE, que es otra cosa y se reintenta solo.
        if !(200..300).contains(&estado) {
            return Err(format!(
                "la AEAT respondió HTTP {estado}: {}",
                recortar(&cuerpo, 500)
            ));
        }
        Ok(cuerpo)
    }
}

unsafe fn codigo_estado(peticion: *mut c_void) -> u32 {
    let mut estado: u32 = 0;
    let mut cb = std::mem::size_of::<u32>() as u32;
    WinHttpQueryHeaders(
        peticion,
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        std::ptr::null(),
        &mut estado as *mut u32 as *mut c_void,
        &mut cb,
        std::ptr::null_mut(),
    );
    estado
}

unsafe fn leer_cuerpo(peticion: *mut c_void) -> Result<String, String> {
    let mut datos: Vec<u8> = Vec::with_capacity(8192);
    loop {
        let mut disponible: u32 = 0;
        if WinHttpQueryDataAvailable(peticion, &mut disponible) == 0 {
            return Err(format!("leyendo la respuesta ({})", ultimo_error()));
        }
        if disponible == 0 {
            break;
        }
        let mut trozo = vec![0u8; disponible as usize];
        let mut leidos: u32 = 0;
        if WinHttpReadData(
            peticion,
            trozo.as_mut_ptr() as *mut c_void,
            disponible,
            &mut leidos,
        ) == 0
        {
            return Err(format!("leyendo la respuesta ({})", ultimo_error()));
        }
        trozo.truncate(leidos as usize);
        datos.extend_from_slice(&trozo);
        // Tope de cordura: la respuesta de 1000 registros son unos pocos MB. Si llegara mucho más,
        // algo va mal y es mejor cortar que llenar la memoria del TPV.
        if datos.len() > 32 * 1024 * 1024 {
            return Err("la respuesta de la AEAT es desmesuradamente grande".to_string());
        }
    }
    // El servicio contesta en UTF-8. `from_utf8_lossy` en vez de fallar: una respuesta con un byte
    // raro se sigue pudiendo leer para saber qué dijo, y lo que se busca dentro es ASCII.
    Ok(String::from_utf8_lossy(&datos).to_string())
}

/// Traduce los errores de WinHTTP que tienen una causa concreta y accionable.
///
/// El resto salen con su número: un código que se puede buscar es más útil que una frase inventada.
fn traducir_error_envio(code: u32) -> String {
    match code {
        // ERROR_WINHTTP_CLIENT_AUTH_CERT_NEEDED
        12044 => "La AEAT pide un certificado de cliente y el elegido no le sirve. \
                  Comprueba en Configuración → Fiscal que sigue siendo el correcto."
            .to_string(),
        // ERROR_WINHTTP_SECURE_FAILURE
        12175 => "Falló la conexión segura con la AEAT. Suele ser el certificado (caducado, \
                  revocado o sin clave privada utilizable) o un proxy que intercepta el tráfico."
            .to_string(),
        // ERROR_WINHTTP_TIMEOUT
        12002 => "La AEAT no respondió a tiempo. Se reintentará solo.".to_string(),
        // ERROR_WINHTTP_NAME_NOT_RESOLVED / CANNOT_CONNECT
        12007 | 12029 => "No hay conexión con la AEAT. Se reintentará solo.".to_string(),
        otro => format!("no se pudo enviar a la AEAT (WinHTTP {otro})"),
    }
}

fn ultimo_error() -> u32 {
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

fn recortar(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
