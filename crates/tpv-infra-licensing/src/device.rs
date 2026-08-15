//! Identidad de dispositivo y cripto compartida por licensing y pairing:
//! device-id + clave ed25519 en keyring, firma de proof, y almacén del handy token.
//! Lógica de bajo nivel portada verbatim de `licensing.rs`/`pairing.rs` (devuelve `String`
//! como error; el adaptador la mapea a `AppError`).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::secret_store;

// Identificadores (service, key) del almacén de secretos. En escritorio son el par (service, user)
// del keyring del SO; en Android son claves de las SharedPreferences cifradas. NO cambiar: cambiarlos
// haría "perder" los secretos ya guardados en instalaciones existentes.
const SVC_LICENSING: &str = "tpv-licensing";
const KEY_DEVICE_ID: &str = "device-id";
const SVC_DEVICE_KEY: &str = "tpv-licensing-devicekey";
const SVC_AUTH: &str = "tpv-auth";
const KEY_LICENSE_TOKEN: &str = "license-token";
const KEY_HANDY_TOKEN: &str = "handy-token";
const KEY_HANDY_TENANT: &str = "handy-tenant-id";

pub fn sha256_hex(s: &str) -> String {
    sha256_hex_bytes(s.as_bytes())
}

/// Igual que [`sha256_hex`] pero sobre bytes crudos: el cuerpo de una petición no siempre es
/// texto (la subida de imágenes manda el binario tal cual).
pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    out.iter().map(|b| format!("{:02x}", b)).collect()
}

/* ===== device-id + keypair (almacén de secretos) ===== */

pub fn get_or_create_device_id() -> Result<String, String> {
    if let Ok(Some(v)) = secret_store::get(SVC_LICENSING, KEY_DEVICE_ID) {
        let t = v.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }

    let id = Uuid::new_v4().to_string();
    secret_store::set(SVC_LICENSING, KEY_DEVICE_ID, &id)?;
    Ok(id)
}

/// Devuelve `(SigningKey, pubkey_b64)` desde el almacén; si no existe, la crea y persiste.
pub fn get_or_create_device_keypair(device_id: &str) -> Result<(SigningKey, String), String> {
    if let Ok(Some(b64)) = secret_store::get(SVC_DEVICE_KEY, device_id) {
        let bytes = B64.decode(b64.trim()).map_err(|e| e.to_string())?;

        if bytes.len() != 32 {
            return Err("bad_private_key_len".into());
        }

        let arr: [u8; 32] = bytes[..]
            .try_into()
            .map_err(|_| "bad_private_key_len".to_string())?;

        let sk = SigningKey::from_bytes(&arr);
        let pub_b64 = B64.encode(sk.verifying_key().to_bytes());
        return Ok((sk, pub_b64));
    }

    use rand::rngs::OsRng;
    let mut rng = OsRng;
    let sk = SigningKey::generate(&mut rng);

    let sk_b64 = B64.encode(sk.to_bytes());
    secret_store::set(SVC_DEVICE_KEY, device_id, &sk_b64)?;

    let pub_b64 = B64.encode(sk.verifying_key().to_bytes());
    Ok((sk, pub_b64))
}

/// Firma de proof: `{ts}\n{METHOD}\n{PATH}\n{sha256(token)}\n{sha256(body)}`.
///
/// El último tramo (**FABLE-E**) es lo que impide alterar el contenido de una petición ya firmada:
/// antes la firma solo cubría método y ruta, así que el cuerpo (importes, líneas de una comanda…)
/// podía cambiarse sin invalidarla. `body` son los bytes EXACTOS que se envían; para peticiones sin
/// cuerpo (GET/DELETE) se firma la cadena vacía, cuyo sha256 es un valor fijo y conocido.
///
/// ⚠️ Este formato tiene que ser idéntico al del verificador del worker
/// (`server/middleware/auth.ts` y `domains/licensing/licensing.helpers.ts`). Si cambia aquí, cambia
/// allí en el mismo despliegue: un cliente firmando distinto de como verifica el worker recibe 401
/// en TODAS sus llamadas.
pub fn sign_device_proof(
    sk: &SigningKey,
    ts_ms: i64,
    method: &str,
    path: &str,
    token: &str,
    body: &[u8],
) -> Result<String, String> {
    let msg = device_proof_message(ts_ms, method, path, token, body);
    let sig: Signature = sk.sign(msg.as_bytes());
    Ok(B64.encode(sig.to_bytes()))
}

/// El mensaje exacto que se firma. Separado de la firma para poder testearlo: es la ÚNICA
/// definición del formato en el lado cliente, y su gemelo en el worker está en
/// `server/middleware/auth.ts` y `domains/licensing/licensing.helpers.ts`.
pub fn device_proof_message(
    ts_ms: i64,
    method: &str,
    path: &str,
    token: &str,
    body: &[u8],
) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        ts_ms,
        method.to_uppercase(),
        path,
        sha256_hex(token),
        sha256_hex_bytes(body)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fija el formato del device-proof. Si alguien lo cambia aquí sin cambiarlo en el worker (o
    /// al revés), el cliente empieza a recibir 401 en TODAS sus llamadas y cuesta mucho verlo:
    /// este test convierte ese despiste en un fallo de compilación de la suite.
    #[test]
    fn mensaje_device_proof_tiene_el_formato_acordado() {
        let msg = device_proof_message(1700000000000, "post", "/v1/mesas/cobrar", "tok", b"{\"a\":1}");

        let lineas: Vec<&str> = msg.split('\n').collect();
        assert_eq!(lineas.len(), 5, "el mensaje son 5 tramos separados por \\n");
        assert_eq!(lineas[0], "1700000000000");
        assert_eq!(lineas[1], "POST", "el método va en mayúsculas");
        assert_eq!(lineas[2], "/v1/mesas/cobrar");
        // sha256("tok") y sha256(r#"{"a":1}"#) en hex minúsculas: exactamente lo que produce
        // `sha256HexStr` en el worker. Valores fijados a mano (no calculados aquí) para que el
        // test falle si alguien cambia el algoritmo o la codificación.
        assert_eq!(
            lineas[3],
            "1a7674eb4ee78df7e1ac439a93c3fa8e3c945784d4dec9fd8e3011738b2f1d62"
        );
        assert_eq!(
            lineas[4],
            "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862"
        );
    }

    /// Un cuerpo distinto ⇒ firma distinta. Es justo lo que FABLE-E venía a cerrar: antes se
    /// podía cambiar el contenido de una petición sin invalidar su firma.
    #[test]
    fn el_cuerpo_cambia_el_mensaje() {
        let a = device_proof_message(1, "POST", "/x", "tok", b"{\"importe\":10}");
        let b = device_proof_message(1, "POST", "/x", "tok", b"{\"importe\":9999}");
        assert_ne!(a, b);
    }

    /// Sin cuerpo (GET/DELETE) se firma la cadena vacía, no se omite el tramo.
    #[test]
    fn sin_cuerpo_se_firma_la_cadena_vacia() {
        let msg = device_proof_message(1, "GET", "/x", "tok", b"");
        assert_eq!(msg.split('\n').count(), 5);
        assert_eq!(
            msg.split('\n').nth(4).unwrap(),
            sha256_hex(""),
            "el último tramo es sha256(\"\")"
        );
    }
}

pub fn sign_payload_b64(sk: &SigningKey, payload: &str) -> Result<String, String> {
    let sig: Signature = sk.sign(payload.as_bytes());
    Ok(B64.encode(sig.to_bytes()))
}

/* ===== license token (keyring) =====
   El token de sesión de la Main es una credencial (JWT que firma TODAS las llamadas a la nube):
   vive SOLO en el keyring del SO, nunca en `license_state.json`. Un fichero copiado no basta para
   suplantar al dispositivo (falta también la clave privada ed25519, que igualmente está aquí). */

pub fn get_license_token() -> Result<String, String> {
    let token = secret_store::get(SVC_AUTH, KEY_LICENSE_TOKEN)
        .map_err(|_| "license_token_missing".to_string())?
        .ok_or_else(|| "license_token_missing".to_string())?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("license_token_missing".into());
    }
    Ok(token)
}

pub fn set_license_token(token: &str) -> Result<(), String> {
    secret_store::set(SVC_AUTH, KEY_LICENSE_TOKEN, token.trim())
}

pub fn clear_license_token() -> Result<(), String> {
    let _ = secret_store::delete(SVC_AUTH, KEY_LICENSE_TOKEN);
    Ok(())
}

/* ===== handy token (almacén de secretos) ===== */

pub fn get_handy_token() -> Result<String, String> {
    let token = secret_store::get(SVC_AUTH, KEY_HANDY_TOKEN)
        .map_err(|_| "handy_token_missing".to_string())?
        .ok_or_else(|| "handy_token_missing".to_string())?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("handy_token required".into());
    }
    Ok(token)
}

pub fn handy_set_token(token: &str, tenant_id: &str) -> Result<(), String> {
    secret_store::set(SVC_AUTH, KEY_HANDY_TOKEN, token)?;
    secret_store::set(SVC_AUTH, KEY_HANDY_TENANT, tenant_id)?;
    Ok(())
}

pub fn handy_clear_token() -> Result<(), String> {
    let _ = secret_store::delete(SVC_AUTH, KEY_HANDY_TOKEN);
    let _ = secret_store::delete(SVC_AUTH, KEY_HANDY_TENANT);
    Ok(())
}

pub fn handy_get_tenant() -> Result<Option<String>, String> {
    match secret_store::get(SVC_AUTH, KEY_HANDY_TENANT) {
        Ok(Some(v)) => {
            let tenant_id = v.trim().to_string();
            if tenant_id.is_empty() {
                Ok(None)
            } else {
                Ok(Some(tenant_id))
            }
        }
        _ => Ok(None),
    }
}
