//! Dominio de **login / auth / fichaje**: cripto del PIN (PBKDF2-HMAC-SHA256),
//! validaciones puras y value objects internos. Sin DB, red ni Tauri.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;

const PBKDF2_PREFIX: &str = "$pbkdf2-sha256$";
const PBKDF2_ITERS: u32 = 100_000;
const SALT_LEN: usize = 16;
const DK_LEN: usize = 32;

/* =========================================================
   Validaciones
========================================================= */

pub fn requerido(input: &str, field: &str) -> Result<String, String> {
    let out = input.trim().to_string();
    if out.is_empty() {
        return Err(format!("{field} required"));
    }
    Ok(out)
}

pub fn limpiar_opcional(input: Option<String>) -> Option<String> {
    input.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

pub fn validate_email_basic(email: &str) -> bool {
    let e = email.trim();
    e.len() >= 6 && e.contains('@') && e.contains('.') && !e.contains(' ')
}

/* =========================================================
   Cripto del PIN (PBKDF2)
========================================================= */

fn timing_safe_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn parse_pbkdf2_phc(phc: &str) -> Result<(u32, Vec<u8>, Vec<u8>), String> {
    let h = phc.trim();

    if h.starts_with("$argon2") || h.starts_with("argon2") {
        return Err("HASH_ARGON2_NO_SOPORTADO: rehash Password_Hash a pbkdf2-sha256".into());
    }

    if !h.starts_with(PBKDF2_PREFIX) {
        return Err("HASH_DESCONOCIDO: Password_Hash no es pbkdf2-sha256".into());
    }

    let parts: Vec<&str> = h.split('$').collect();

    if parts.len() < 5 {
        return Err("Hash almacenado mal formado".into());
    }

    let iter_part = parts[2].trim();
    let iters = iter_part
        .strip_prefix("i=")
        .ok_or_else(|| "Hash params i inválido".to_string())?
        .parse::<u32>()
        .map_err(|_| "Hash params i inválido".to_string())?;

    if iters == 0 {
        return Err("Hash params i inválido".into());
    }

    let salt_b64 = parts[3].trim();
    let dk_b64 = parts[4].trim();

    let salt = B64
        .decode(salt_b64)
        .map_err(|_| "Hash almacenado mal formado".to_string())?;

    let dk = B64
        .decode(dk_b64)
        .map_err(|_| "Hash almacenado mal formado".to_string())?;

    if salt.is_empty() || dk.is_empty() {
        return Err("Hash almacenado mal formado".into());
    }

    Ok((iters, salt, dk))
}

/// Genera el hash PHC pbkdf2-sha256 de un PIN (salt aleatorio).
pub fn hash_pin(pin: &str) -> Result<String, String> {
    let p = pin.trim();

    if p.len() < 4 {
        return Err("PIN demasiado corto".into());
    }

    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);

    let mut dk = [0u8; DK_LEN];
    pbkdf2_hmac::<Sha256>(p.as_bytes(), &salt, PBKDF2_ITERS, &mut dk);

    let salt_b64 = B64.encode(salt);
    let dk_b64 = B64.encode(dk);

    Ok(format!(
        "{}i={}${}${}",
        PBKDF2_PREFIX, PBKDF2_ITERS, salt_b64, dk_b64
    ))
}

/// Verifica un PIN contra un hash PHC almacenado (comparación en tiempo constante).
pub fn verify_pin(pin: &str, stored_hash: &str) -> Result<(), String> {
    let p = pin.trim();

    if p.len() < 4 {
        return Err("PIN incorrecto".into());
    }

    let (iters, salt, expected_dk) = parse_pbkdf2_phc(stored_hash)?;

    let mut actual = vec![0u8; expected_dk.len()];
    pbkdf2_hmac::<Sha256>(p.as_bytes(), &salt, iters, &mut actual);

    if !timing_safe_eq(&actual, &expected_dk) {
        return Err("PIN incorrecto".into());
    }

    Ok(())
}

/* =========================================================
   Value objects internos (no cruzan a la UI; portan password_hash)
========================================================= */

/// Registro de usuario para el flujo de login (incluye el hash, que NO sale a la UI).
#[derive(Debug, Clone)]
pub struct LoginUserRecord {
    pub id_usuario: String,
    pub id_trabajador: Option<String>,
    pub nombre: String,
    pub apellido: Option<String>,
    pub email: String,
    pub password_hash: String,
    pub requiere_setup: i64,
    pub rol: String,
}

/// Información mínima para el setup inicial.
#[derive(Debug, Clone)]
pub struct SetupInfo {
    pub password_hash: String,
    pub requiere_setup: i64,
}
