//! Dominio de **login / auth / fichaje**: cripto del PIN (PBKDF2-HMAC-SHA256),
//! validaciones puras y value objects internos. Sin DB, red ni Tauri.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;

const PBKDF2_PREFIX: &str = "$pbkdf2-sha256$";
// Tope IMPUESTO por Cloudflare Workers: su `crypto.subtle` PBKDF2 no admite más de 100.000
// iteraciones (límite del runtime, NO del plan). Como los hashes de PIN viajan por la sync y el
// worker los VERIFICA en el login de Handy (que no tiene BD local), el número tiene que ser uno
// que ambos runtimes acepten → 100k es el techo común. Espejo de `DEFAULT_ITERS` en el worker
// (login.crypto.ts). Para PINs numéricos la protección real es el rate-limit, no las iteraciones.
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
   Anti brute-force (LOGIN-01): política de bloqueo por intentos
========================================================= */

/// Intentos fallidos consecutivos "gratis" antes de empezar a bloquear.
pub const LOGIN_INTENTOS_LIBRES: u32 = 5;

/// Milisegundos de bloqueo tras `intentos_fallidos` fallos consecutivos. Escalado:
/// hasta 5 fallos → sin bloqueo; luego 30 s, 1 min, 5 min y 15 min (tope). Al acertar se resetea.
/// Función pura: la capa de aplicación la usa para fijar `Bloqueado_Hasta_Ms = now + este valor`.
pub fn login_bloqueo_ms(intentos_fallidos: u32) -> i64 {
    if intentos_fallidos <= LOGIN_INTENTOS_LIBRES {
        return 0;
    }
    match intentos_fallidos - LOGIN_INTENTOS_LIBRES {
        1 => 30_000,
        2 => 60_000,
        3 => 5 * 60_000,
        _ => 15 * 60_000,
    }
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

/// Iteraciones objetivo para los hashes **nuevos**. Fijado en 100k porque es el máximo que admite
/// el `crypto.subtle` PBKDF2 de Cloudflare Workers, que es quien verifica los PIN en el login de
/// Handy (online). Subirlo rompería ese login y la creación del admin del tenant. Los hashes con
/// menos iteraciones migran solos por **rehash-en-login** (ver `hash_needs_upgrade`).
pub const fn target_pbkdf2_iters() -> u32 {
    PBKDF2_ITERS
}

/// `true` si el hash almacenado usa **menos** iteraciones que el objetivo actual → conviene
/// recomputarlo (rehash-en-login) con el PIN ya verificado. Solo debe llamarse tras un `verify_pin`
/// exitoso (entonces el hash es pbkdf2 válido y parseable).
pub fn hash_needs_upgrade(stored_hash: &str) -> bool {
    match parse_pbkdf2_phc(stored_hash) {
        Ok((iters, _, _)) => iters < PBKDF2_ITERS,
        // Ilegible/no-pbkdf2: no forzamos rehash aquí (no debería ocurrir tras verificar).
        Err(_) => false,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn textos_requeridos_y_opcionales_se_limpian() {
        assert_eq!(requerido(" admin ", "rol").unwrap(), "admin");
        assert_eq!(requerido(" ", "rol").unwrap_err(), "rol required");
        assert_eq!(limpiar_opcional(Some(" Ana ".into())), Some("Ana".into()));
        assert_eq!(limpiar_opcional(Some("\t".into())), None);
        assert_eq!(limpiar_opcional(None), None);
    }

    #[test]
    fn email_basico_acepta_y_rechaza_casos_representativos() {
        for email in ["a@b.es", " usuario@example.com ", "A.B+tag@EXAMPLE.COM"] { assert!(validate_email_basic(email)); }
        for email in ["", "a@b", "abcdef", "a b@c.es", "@.com", "a@.c"] { assert!(!validate_email_basic(email), "deberia rechazar {email}"); }
    }

    #[test]
    fn bloqueo_escala_en_los_limites_definidos() {
        for intentos in 0..=LOGIN_INTENTOS_LIBRES { assert_eq!(login_bloqueo_ms(intentos), 0); }
        assert_eq!(login_bloqueo_ms(6), 30_000);
        assert_eq!(login_bloqueo_ms(7), 60_000);
        assert_eq!(login_bloqueo_ms(8), 300_000);
        assert_eq!(login_bloqueo_ms(9), 900_000);
        assert_eq!(login_bloqueo_ms(u32::MAX), 900_000);
    }

    #[test]
    fn comparacion_constante_cubre_igualdad_diferencia_y_longitud() {
        assert!(timing_safe_eq(&[], &[]));
        assert!(timing_safe_eq(&[1, 2, 3], &[1, 2, 3]));
        assert!(!timing_safe_eq(&[1, 2, 3], &[1, 2, 4]));
        assert!(!timing_safe_eq(&[1], &[1, 0]));
    }

    #[test]
    fn hash_nuevo_usa_formato_iteraciones_y_tamanos_correctos() {
        let hash = hash_pin("Abc123!").unwrap();
        assert!(hash.starts_with("$pbkdf2-sha256$i=100000$"));
        let (iters, salt, dk) = parse_pbkdf2_phc(&hash).unwrap();
        assert_eq!(iters, target_pbkdf2_iters());
        assert_eq!(salt.len(), SALT_LEN);
        assert_eq!(dk.len(), DK_LEN);
    }

    #[test]
    fn hash_usa_salt_aleatorio_y_verifica_pin_alfanumerico() {
        let h1 = hash_pin("Abc123!").unwrap();
        let h2 = hash_pin("Abc123!").unwrap();
        assert_ne!(h1, h2);
        assert!(verify_pin("Abc123!", &h1).is_ok());
        assert!(verify_pin("abc123!", &h1).is_err());
        assert!(verify_pin("Abc124!", &h1).is_err());
    }

    #[test]
    fn pin_recorta_extremos_pero_conserva_espacios_interiores() {
        let hash = hash_pin("  cafe 2026  ").unwrap();
        assert!(verify_pin("cafe 2026", &hash).is_ok());
        assert!(verify_pin(" cafe 2026 ", &hash).is_ok());
        assert!(verify_pin("cafe2026", &hash).is_err());
    }

    #[test]
    fn pin_corto_se_rechaza_al_crear_y_verificar() {
        for pin in ["", "1", "a1", "abc"] { assert!(hash_pin(pin).is_err()); }
        let hash = hash_pin("1234").unwrap();
        assert!(verify_pin("12", &hash).is_err());
    }

    #[test]
    fn parser_rechaza_algoritmos_y_hashes_malformados() {
        let casos = [
            "$argon2id$v=19$m=1$sal$hash", "argon2$loquesea", "texto plano",
            "$pbkdf2-sha256$", "$pbkdf2-sha256$x=100$aA==$aA==",
            "$pbkdf2-sha256$i=0$aA==$aA==", "$pbkdf2-sha256$i=abc$aA==$aA==",
            "$pbkdf2-sha256$i=1$%%%$aA==", "$pbkdf2-sha256$i=1$aA==$%%%",
        ];
        for hash in casos { assert!(parse_pbkdf2_phc(hash).is_err(), "deberia rechazar {hash}"); }
    }

    #[test]
    fn detecta_hash_antiguo_que_necesita_upgrade() {
        let hash = hash_pin("1234").unwrap();
        let antiguo = hash.replacen("i=100000", "i=99999", 1);
        assert!(!hash_needs_upgrade(&hash));
        assert!(hash_needs_upgrade(&antiguo));
        assert!(!hash_needs_upgrade("hash desconocido"));
    }
}
