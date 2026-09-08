//! Lectura del **almacén de certificados de Windows** (`CurrentUser\My` y `LocalMachine\My`).
//!
//! ## Qué sale de aquí y qué no
//!
//! Sale: la huella digital (para poder elegirlo después), el sujeto y el emisor (para que la
//! persona reconozca el suyo en la lista), la caducidad y en qué almacén está.
//!
//! **No sale nada de la clave privada, y no puede salir**: no se exporta, no se copia y no se
//! guarda. Lo único que la aplicación persiste es la **huella** del elegido, que identifica al
//! certificado pero no lo abre — no es un secreto. Por eso el certificado ni siquiera toca el
//! almacén de secretos de la aplicación: un secreto menos que proteger es un secreto menos que
//! filtrar.
//!
//! ## Por qué el almacén de Windows y no un fichero `.p12`
//!
//! Porque **da igual de qué fichero vino**. Una vez instalado, un `.p12`, un `.pfx`, un DNIe, una
//! tarjeta criptográfica o un token USB se usan todos igual, y quien firma el handshake es Windows
//! sin que la clave salga nunca del almacén — es lo mismo que hace Autofirma. Con un fichero, cada
//! formato raro sería un caso nuestro; así es problema de quien lo instaló, que además es quien
//! sabe hacerlo. Y el soporte se explica en una frase: *«instálalo como lo instalarías para
//! Autofirma»*.
//!
//! ## El único filtro
//!
//! Que tenga **clave privada**. Un `.cer` o un `.crt` sólo llevan la parte pública, así que no
//! pueden autenticar nada; si alguien instala uno de esos creyendo que ya está, simplemente no sale
//! en la lista.
//!
//! ## Dos almacenes, y hay que decir cuál
//!
//! El almacén personal es **por usuario de Windows**. Si la gestoría entra con su sesión e instala
//! ahí el certificado, el TPV corriendo como otro usuario **no lo ve**. Es una llamada de soporte
//! garantizada, y por eso cada certificado dice en cuál se encontró.

use std::ffi::c_void;

use tpv_application::ports::aeat::CertificadoDisponible;
use windows_sys::Win32::Security::Cryptography::*;

/// Los dos almacenes personales donde puede estar un certificado de firma.
const ALMACENES: [(u32, &str); 2] = [
    (CERT_SYSTEM_STORE_CURRENT_USER_ID, "CurrentUser"),
    (CERT_SYSTEM_STORE_LOCAL_MACHINE_ID, "LocalMachine"),
];

/// OID de *Client Authentication*. No se usa como filtro —hay certificados de firma perfectamente
/// válidos para esto que no lo declaran— pero sirve para ordenar la lista poniendo delante los que
/// con más probabilidad son el que la persona busca.
const EKU_CLIENT_AUTH: &str = "1.3.6.1.5.5.7.3.2";

/// Nombre de la política de certificado de **sello de entidad** en @firma. Los tipos 4 y 8 entran
/// por otra subsede de la AEAT (`www10` / `prewww10`), así que hay que distinguirlos — pero **sólo
/// para eso**. La interfaz no menciona el sello: es de pago, sólo se emite a personas jurídicas
/// (un autónomo no puede tenerlo) y recomendarlo convierte una pantalla de dos clics en una
/// conversación fiscal.
fn parece_sello(sujeto: &str, uso_extendido: &[String]) -> bool {
    // Dos señales, y con una basta. La primera es el OID de política de sello de la FNMT y de los
    // prestadores que siguen el perfil de @firma; la segunda, el texto que estos certificados
    // llevan en el sujeto.
    const OIDS_SELLO: [&str; 3] = [
        "1.3.6.1.4.1.5734.3.13", // FNMT — sello de entidad
        "2.16.724.1.3.5.6.2",    // @firma — sello nivel medio
        "2.16.724.1.3.5.7.2",    // @firma — sello nivel alto
    ];
    if uso_extendido.iter().any(|o| OIDS_SELLO.contains(&o.as_str())) {
        return true;
    }
    let s = sujeto.to_uppercase();
    s.contains("SELLO ELECTRONICO") || s.contains("SELLO ELECTRÓNICO")
}

/// Los certificados **con clave privada** de los dos almacenes personales.
pub fn listar() -> Result<Vec<CertificadoDisponible>, String> {
    let mut out: Vec<CertificadoDisponible> = Vec::new();
    for (id, nombre) in ALMACENES {
        // Un almacén que no se puede abrir no es un error: `LocalMachine` puede requerir permisos
        // que el TPV no tiene, y eso no impide usar el de usuario. Se sigue con el siguiente.
        if let Ok(mut v) = listar_de(id, nombre) {
            out.append(&mut v);
        }
    }
    // Primero los que se pueden usar SIN diálogos —que son los únicos que sirven para un job
    // desatendido— y dentro de cada grupo por caducidad más lejana: lo que la persona busca suele
    // estar arriba, y el que le va a dar problemas a las tres de la mañana, abajo.
    out.sort_by(|a, b| {
        b.uso_silencioso
            .cmp(&a.uso_silencioso)
            .then_with(|| b.valido_hasta.cmp(&a.valido_hasta))
    });
    Ok(out)
}

/// Busca uno por su huella, en los dos almacenes.
pub fn buscar(huella: &str) -> Result<Option<CertificadoDisponible>, String> {
    let h = huella.trim().to_uppercase().replace([' ', ':'], "");
    Ok(listar()?.into_iter().find(|c| c.huella == h))
}

fn listar_de(store_id: u32, nombre_almacen: &str) -> Result<Vec<CertificadoDisponible>, String> {
    unsafe {
        let mi: Vec<u16> = "My\0".encode_utf16().collect();
        let store = CertOpenStore(
            CERT_STORE_PROV_SYSTEM_W,
            0,
            0,
            // READ_ONLY: esto sólo lee. Y `CERT_STORE_OPEN_EXISTING_FLAG` para no crear un almacén
            // vacío si no existiera, que dejaría rastro en el registro de Windows por una lectura.
            (store_id << CERT_SYSTEM_STORE_LOCATION_SHIFT)
                | CERT_STORE_READONLY_FLAG
                | CERT_STORE_OPEN_EXISTING_FLAG,
            mi.as_ptr() as *const c_void,
        );
        if store.is_null() {
            return Err(format!("no se pudo abrir el almacén {nombre_almacen}"));
        }

        let mut out = Vec::new();
        let mut ctx: *const CERT_CONTEXT = std::ptr::null();
        loop {
            ctx = CertEnumCertificatesInStore(store, ctx);
            if ctx.is_null() {
                break;
            }
            // EL FILTRO, y el único: sin clave privada no puede autenticar nada.
            if !tiene_clave_privada(ctx) {
                continue;
            }
            if let Some(c) = leer(ctx, nombre_almacen) {
                out.push(c);
            }
        }

        CertCloseStore(store, 0);
        Ok(out)
    }
}

/// ¿Este certificado tiene clave privada asociada?
///
/// Se comprueba con la **propiedad** `CERT_KEY_PROV_INFO_PROP_ID`, que es metadato guardado junto
/// al certificado en el registro de Windows. **No se abre la clave**: abrirla podría sacar el
/// diálogo de PIN de una tarjeta, y esto es una lectura de lista.
unsafe fn tiene_clave_privada(ctx: *const CERT_CONTEXT) -> bool {
    let mut cb: u32 = 0;
    CertGetCertificateContextProperty(ctx, CERT_KEY_PROV_INFO_PROP_ID, std::ptr::null_mut(), &mut cb)
        != 0
}

/// ¿La clave se puede usar sin diálogos?
///
/// Se abre con `CRYPT_ACQUIRE_SILENT_FLAG`: si Windows necesita interfaz de usuario (la
/// *«protección alta»* del asistente de importación, o el PIN de una tarjeta), falla — y eso es la
/// respuesta. **No se firma nada**: sólo se pide el manejador y se suelta.
///
/// ⚠️ **No es infalible.** Microsoft documenta que con lectores con *pinpad* y drivers propios el
/// flag se ignora y el diálogo sale igual. Por eso existe además el botón «probar ahora» de la
/// pantalla, que hace un handshake real con el usuario delante: si hay un PIN escondido, sale ahí y
/// no a las tres de la mañana.
unsafe fn permite_uso_silencioso(ctx: *const CERT_CONTEXT) -> bool {
    let mut handle: HCRYPTPROV_OR_NCRYPT_KEY_HANDLE = 0;
    let mut spec: u32 = 0;
    let mut hay_que_liberar: i32 = 0;
    let ok = CryptAcquireCertificatePrivateKey(
        ctx,
        // ALLOW_NCRYPT: acepta las dos formas en que puede estar la clave — un KSP moderno (CNG) o
        // un CSP heredado. Los certificados de la FNMT instalados desde un `.p12` suelen quedar en
        // el CSP heredado («Microsoft Enhanced Cryptographic Provider v1.0»), así que exigir CNG
        // dejaría fuera precisamente los que la gente tiene.
        CRYPT_ACQUIRE_ALLOW_NCRYPT_KEY_FLAG | CRYPT_ACQUIRE_SILENT_FLAG,
        std::ptr::null_mut(),
        &mut handle,
        &mut spec,
        &mut hay_que_liberar,
    );
    if ok == 0 {
        return false;
    }
    if hay_que_liberar != 0 && handle != 0 {
        if spec == CERT_NCRYPT_KEY_SPEC {
            NCryptFreeObject(handle);
        } else {
            CryptReleaseContext(handle, 0);
        }
    }
    true
}

unsafe fn leer(ctx: *const CERT_CONTEXT, nombre_almacen: &str) -> Option<CertificadoDisponible> {
    let huella = huella_de(ctx)?;
    let sujeto = nombre_de(ctx, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0);
    let emisor = nombre_de(ctx, CERT_NAME_SIMPLE_DISPLAY_TYPE, CERT_NAME_ISSUER_FLAG);
    let valido_hasta = caduca_el(ctx);
    let usos = uso_extendido(ctx);

    // Un certificado sin `clientAuth` puede servir igual —hay perfiles de firma que no lo
    // declaran y la AEAT los acepta—, así que NO se filtra por esto: sólo se anota para que la
    // lista ponga delante lo más probable.
    let _client_auth = declara_client_auth(&usos);

    Some(CertificadoDisponible {
        huella,
        sujeto,
        emisor,
        valido_hasta,
        almacen: nombre_almacen.to_string(),
        es_sello: parece_sello_de(ctx, &usos),
        uso_silencioso: permite_uso_silencioso(ctx),
    })
}

unsafe fn parece_sello_de(ctx: *const CERT_CONTEXT, usos: &[String]) -> bool {
    parece_sello(&nombre_de(ctx, CERT_NAME_RDN_TYPE, 0), usos)
}

/// SHA-1 del certificado, en hexadecimal y mayúsculas. Es su identificador en el almacén.
unsafe fn huella_de(ctx: *const CERT_CONTEXT) -> Option<String> {
    let mut cb: u32 = 0;
    if CertGetCertificateContextProperty(ctx, CERT_HASH_PROP_ID, std::ptr::null_mut(), &mut cb) == 0 {
        return None;
    }
    let mut buf = vec![0u8; cb as usize];
    if CertGetCertificateContextProperty(
        ctx,
        CERT_HASH_PROP_ID,
        buf.as_mut_ptr() as *mut c_void,
        &mut cb,
    ) == 0
    {
        return None;
    }
    buf.truncate(cb as usize);
    Some(buf.iter().map(|b| format!("{b:02X}")).collect())
}

unsafe fn nombre_de(ctx: *const CERT_CONTEXT, tipo: u32, flags: u32) -> String {
    let n = CertGetNameStringW(ctx, tipo, flags, std::ptr::null_mut(), std::ptr::null_mut(), 0);
    if n <= 1 {
        return String::new();
    }
    let mut buf = vec![0u16; n as usize];
    let escritos = CertGetNameStringW(
        ctx,
        tipo,
        flags,
        std::ptr::null_mut(),
        buf.as_mut_ptr(),
        n,
    );
    if escritos <= 1 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..(escritos as usize).saturating_sub(1)])
}

/// `NotAfter` en `AAAA-MM-DD`.
unsafe fn caduca_el(ctx: *const CERT_CONTEXT) -> String {
    let info = (*ctx).pCertInfo;
    if info.is_null() {
        return String::new();
    }
    let ft = (*info).NotAfter;
    let mut st = std::mem::zeroed::<windows_sys::Win32::Foundation::SYSTEMTIME>();
    if windows_sys::Win32::System::Time::FileTimeToSystemTime(&ft, &mut st) == 0 {
        return String::new();
    }
    format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay)
}

/// Los OID del uso extendido de clave, si los declara.
unsafe fn uso_extendido(ctx: *const CERT_CONTEXT) -> Vec<String> {
    let mut cb: u32 = 0;
    if CertGetEnhancedKeyUsage(ctx, 0, std::ptr::null_mut(), &mut cb) == 0 || cb == 0 {
        return Vec::new();
    }
    let mut buf = vec![0u8; cb as usize];
    // En windows-sys el tipo se llama `CTL_USAGE`; `CERT_ENHKEY_USAGE` es su alias en la
    // cabecera de C y no está expuesto.
    let usage = buf.as_mut_ptr() as *mut CTL_USAGE;
    if CertGetEnhancedKeyUsage(ctx, 0, usage, &mut cb) == 0 {
        return Vec::new();
    }
    let n = (*usage).cUsageIdentifier as usize;
    let ids = (*usage).rgpszUsageIdentifier;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let p = *ids.add(i);
        if p.is_null() {
            continue;
        }
        let cstr = std::ffi::CStr::from_ptr(p as *const i8);
        out.push(cstr.to_string_lossy().to_string());
    }
    out
}

/// ¿Declara autenticación de cliente? Sólo se usa para ordenar la lista.
pub fn declara_client_auth(usos: &[String]) -> bool {
    usos.iter().any(|o| o == EKU_CLIENT_AUTH)
}

// ─────────────────────────────────────────────────────────────────────────────
// El contexto para el handshake
// ─────────────────────────────────────────────────────────────────────────────

/// Un `CERT_CONTEXT` con dueño: se libera al salir del ámbito.
///
/// Lo necesita el transporte para pasárselo a WinHTTP. **No lleva ninguna clave dentro**: es el
/// puntero al certificado del almacén, y quien firma con él es Windows.
pub struct ContextoCertificado(pub *const CERT_CONTEXT);

impl Drop for ContextoCertificado {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CertFreeCertificateContext(self.0) };
        }
    }
}

// El puntero se crea en un hilo (`spawn_blocking`) y se usa en ese mismo hilo. `CERT_CONTEXT` es
// seguro de mover entre hilos: la API de CryptoAPI lo permite explícitamente.
unsafe impl Send for ContextoCertificado {}

/// Busca el contexto de un certificado por su huella, en los dos almacenes personales.
///
/// Devuelve un contexto **duplicado y propio** (`CertDuplicateCertificateContext`), para poder
/// cerrar el almacén sin invalidarlo: WinHTTP lo usará después de que esta función vuelva.
pub fn contexto_por_huella(huella: &str) -> Result<ContextoCertificado, String> {
    let objetivo = huella.trim().to_uppercase().replace([' ', ':'], "");
    if objetivo.is_empty() {
        return Err("no hay ningún certificado elegido".to_string());
    }

    unsafe {
        for (id, _) in ALMACENES {
            let mi: Vec<u16> = "My\0".encode_utf16().collect();
            let store = CertOpenStore(
                CERT_STORE_PROV_SYSTEM_W,
                0,
                0,
                (id << CERT_SYSTEM_STORE_LOCATION_SHIFT)
                    | CERT_STORE_READONLY_FLAG
                    | CERT_STORE_OPEN_EXISTING_FLAG,
                mi.as_ptr() as *const c_void,
            );
            if store.is_null() {
                continue;
            }

            let mut ctx: *const CERT_CONTEXT = std::ptr::null();
            let mut encontrado: *const CERT_CONTEXT = std::ptr::null();
            loop {
                ctx = CertEnumCertificatesInStore(store, ctx);
                if ctx.is_null() {
                    break;
                }
                if huella_de(ctx).as_deref() == Some(objetivo.as_str()) {
                    encontrado = CertDuplicateCertificateContext(ctx);
                    // No se sigue enumerando: `CertEnumCertificatesInStore` libera el contexto
                    // anterior en cada vuelta, y el duplicado ya es nuestro.
                    CertFreeCertificateContext(ctx);
                    break;
                }
            }
            CertCloseStore(store, 0);

            if !encontrado.is_null() {
                return Ok(ContextoCertificado(encontrado));
            }
        }
    }

    Err("el certificado elegido ya no está en el almacén de Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_un_sello_por_su_oid_de_politica() {
        // El tipo del certificado decide el ENDPOINT (`www10` en vez de `www1`) y nada más. Si se
        // clasifica mal, el envío va a la subsede equivocada y la AEAT lo rechaza — no es un
        // detalle cosmético.
        assert!(parece_sello("EMPRESA SL", &["1.3.6.1.4.1.5734.3.13".to_string()]));
        assert!(parece_sello("EMPRESA SL", &["2.16.724.1.3.5.6.2".to_string()]));
    }

    #[test]
    fn reconoce_un_sello_por_el_texto_del_sujeto() {
        assert!(parece_sello("SELLO ELECTRONICO DE EMPRESA SL", &[]));
        assert!(parece_sello("Sello Electrónico de Empresa SL", &[]));
    }

    #[test]
    fn un_certificado_de_persona_no_es_un_sello() {
        // El caso mayoritario: un autónomo con su certificado de la FNMT. No puede tener sello, y
        // clasificarlo como tal lo mandaría a una subsede a la que no tiene acceso.
        assert!(!parece_sello("GARCIA LOPEZ JUAN - 12345678Z", &["1.3.6.1.5.5.7.3.2".to_string()]));
        assert!(!parece_sello("REPRESENTANTE DE EMPRESA SL", &[]));
    }

    #[test]
    fn client_auth_se_reconoce_por_su_oid() {
        assert!(declara_client_auth(&["1.3.6.1.5.5.7.3.2".to_string()]));
        assert!(!declara_client_auth(&["1.3.6.1.5.5.7.3.1".to_string()]));
        assert!(!declara_client_auth(&[]));
    }
}
