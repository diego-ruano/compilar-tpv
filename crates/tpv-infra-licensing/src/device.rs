//! Identidad de dispositivo y cripto compartida por licensing y pairing:
//! device-id + clave ed25519 en keyring, firma de proof, y almacén del handy token.
//! Lógica de bajo nivel portada verbatim de `licensing.rs`/`pairing.rs` (devuelve `String`
//! como error; el adaptador la mapea a `AppError`).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey};
use keyring::Entry;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    out.iter().map(|b| format!("{:02x}", b)).collect()
}

/* ===== device-id + keypair (keyring) ===== */

fn key_entry_device_id() -> Result<Entry, String> {
    Entry::new("tpv-licensing", "device-id").map_err(|e| e.to_string())
}

pub fn get_or_create_device_id() -> Result<String, String> {
    let entry = key_entry_device_id()?;

    if let Ok(v) = entry.get_password() {
        let t = v.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }

    let id = Uuid::new_v4().to_string();
    entry.set_password(&id).map_err(|e| e.to_string())?;
    Ok(id)
}

fn key_entry_privkey(device_id: &str) -> Result<Entry, String> {
    Entry::new("tpv-licensing-devicekey", device_id).map_err(|e| e.to_string())
}

/// Devuelve `(SigningKey, pubkey_b64)` desde keyring; si no existe, la crea y persiste.
pub fn get_or_create_device_keypair(device_id: &str) -> Result<(SigningKey, String), String> {
    let entry = key_entry_privkey(device_id)?;

    if let Ok(b64) = entry.get_password() {
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
    entry.set_password(&sk_b64).map_err(|e| e.to_string())?;

    let pub_b64 = B64.encode(sk.verifying_key().to_bytes());
    Ok((sk, pub_b64))
}

/// Firma de proof: `{ts}\n{METHOD}\n{PATH}\n{sha256(token)}`.
pub fn sign_device_proof(
    sk: &SigningKey,
    ts_ms: i64,
    method: &str,
    path: &str,
    token: &str,
) -> Result<String, String> {
    let token_hash = sha256_hex(token);
    let msg = format!("{}\n{}\n{}\n{}", ts_ms, method.to_uppercase(), path, token_hash);
    let sig: Signature = sk.sign(msg.as_bytes());
    Ok(B64.encode(sig.to_bytes()))
}

pub fn sign_payload_b64(sk: &SigningKey, payload: &str) -> Result<String, String> {
    let sig: Signature = sk.sign(payload.as_bytes());
    Ok(B64.encode(sig.to_bytes()))
}

/* ===== handy token (keyring) ===== */

fn key_entry_handy_token() -> Result<Entry, String> {
    Entry::new("tpv-auth", "handy-token").map_err(|e| e.to_string())
}

fn key_entry_handy_tenant() -> Result<Entry, String> {
    Entry::new("tpv-auth", "handy-tenant-id").map_err(|e| e.to_string())
}

pub fn get_handy_token() -> Result<String, String> {
    let entry = key_entry_handy_token()?;
    let token = entry
        .get_password()
        .map_err(|_| "handy_token_missing".to_string())?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("handy_token required".into());
    }
    Ok(token)
}

pub fn handy_set_token(token: &str, tenant_id: &str) -> Result<(), String> {
    key_entry_handy_token()?
        .set_password(token)
        .map_err(|e| e.to_string())?;
    key_entry_handy_tenant()?
        .set_password(tenant_id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn handy_clear_token() -> Result<(), String> {
    let _ = key_entry_handy_token()?.delete_password();
    let _ = key_entry_handy_tenant()?.delete_password();
    Ok(())
}

pub fn handy_get_tenant() -> Result<Option<String>, String> {
    let entry = key_entry_handy_tenant()?;
    match entry.get_password() {
        Ok(v) => {
            let tenant_id = v.trim().to_string();
            if tenant_id.is_empty() {
                Ok(None)
            } else {
                Ok(Some(tenant_id))
            }
        }
        Err(_) => Ok(None),
    }
}
