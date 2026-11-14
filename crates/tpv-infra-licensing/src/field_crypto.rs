//! Cifrado de la PII del personal (TRAB-03) — adaptador de `ports::field_cipher`.
//!
//! # Qué protege y qué no
//!
//! Protege el **dato en reposo en la nube**: quien consiga un volcado de la base de datos
//! del tenant en la nube ve texto cifrado, no DNIs ni IBANes. La clave (DEK) no vive en esa
//! base de datos: la genera el worker en la primera activación, se la entrega a la Main en cada
//! activación y ésta la guarda en el almacén de secretos del sistema (keyring / Android Keystore).
//!
//! NO es zero-knowledge: el control-plane conserva una copia de la DEK para poder
//! devolvérsela al cliente si cambia de equipo. Es la misma decisión que toma cualquier
//! SaaS de gestión, y es lo que hace que el cliente no tenga que custodiar una clave.
//!
//! # Por qué el cifrado es DETERMINISTA
//!
//! `DNI` y `Numero_Seguridad_Social` son `TEXT UNIQUE` en el esquema. Con un nonce aleatorio,
//! el mismo DNI produciría un texto distinto en cada escritura y el índice UNIQUE dejaría de
//! detectar duplicados: se perdería una validación de negocio real.
//!
//! Por eso el nonce **se deriva del propio valor** (construcción tipo SIV):
//!
//! ```text
//! enc_key   = HMAC-SHA256(dek, "tpv/field/enc/v1")
//! nonce_key = HMAC-SHA256(dek, "tpv/field/nonce/v1")
//! nonce     = HMAC-SHA256(nonce_key, claro)[..12]
//! salida    = "enc:v1:" || base64url(nonce || AES-256-GCM(enc_key, nonce, claro))
//! ```
//!
//! El peligro clásico de AES-GCM es repetir un nonce con **plaintexts distintos**: eso
//! rompe la autenticidad y filtra el XOR de los mensajes. Aquí no puede ocurrir, porque el
//! nonce es función (resistente a colisiones) del propio plaintext: mismo nonce implica
//! mismo plaintext. Es exactamente el razonamiento de los modos SIV.
//!
//! Lo que sí se acepta a cambio: **se puede saber que dos filas comparten DNI** sin
//! descifrarlas. Es información que el índice UNIQUE ya revelaba, así que no se pierde nada
//! que no estuviera perdido.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64U, Engine as _};
use hmac::{Hmac, Mac};
use sha2::Sha256;

use tpv_application::error::{AppError, AppResult};
use tpv_application::ports::field_cipher::FieldCipher;

type HmacSha256 = Hmac<Sha256>;

/// Marca de versión. Permite (a) distinguir lo ya cifrado de lo pendiente de migrar y
/// (b) rotar el esquema en el futuro sin reescribir la tabla de golpe.
const PREFIJO: &str = "enc:v1:";

const INFO_ENC: &[u8] = b"tpv/field/enc/v1";
const INFO_NONCE: &[u8] = b"tpv/field/nonce/v1";
const NONCE_LEN: usize = 12;

/// Deriva una subclave de 32 bytes de la DEK. HMAC-SHA256 usado como PRF.
fn subclave(dek: &[u8], info: &[u8]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(dek).expect("HMAC acepta clave de cualquier tamaño");
    mac.update(info);
    mac.finalize().into_bytes().into()
}

pub struct FieldCipherAes {
    enc_key: [u8; 32],
    nonce_key: [u8; 32],
}

impl FieldCipherAes {
    /// Construye el cifrador a partir de la DEK del tenant en base64 (32 bytes).
    pub fn new(dek_b64: &str) -> AppResult<Self> {
        let dek = B64U
            .decode(dek_b64.trim())
            .or_else(|_| base64::engine::general_purpose::STANDARD.decode(dek_b64.trim()))
            .map_err(|_| AppError::internal("field_dek_no_es_base64"))?;

        if dek.len() != 32 {
            return Err(AppError::internal(format!(
                "field_dek debe tener 32 bytes, tiene {}",
                dek.len()
            )));
        }

        Ok(Self {
            enc_key: subclave(&dek, INFO_ENC),
            nonce_key: subclave(&dek, INFO_NONCE),
        })
    }

    fn nonce_de(&self, claro: &str) -> [u8; NONCE_LEN] {
        let mut mac = <HmacSha256 as Mac>::new_from_slice(&self.nonce_key).expect("clave válida");
        mac.update(claro.as_bytes());
        let full = mac.finalize().into_bytes();
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&full[..NONCE_LEN]);
        nonce
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.enc_key))
    }
}

impl FieldCipher for FieldCipherAes {
    fn encrypt(&self, plain: Option<&str>) -> AppResult<Option<String>> {
        let Some(claro) = plain else { return Ok(None) };
        if claro.is_empty() {
            return Ok(Some(String::new()));
        }
        // Idempotencia: si ya está cifrado, no se vuelve a cifrar (el job de migración
        // pasa varias veces sobre las mismas filas).
        if self.is_encrypted(claro) {
            return Ok(Some(claro.to_string()));
        }

        let nonce = self.nonce_de(claro);
        let ct = self
            .cipher()
            .encrypt(Nonce::from_slice(&nonce), claro.as_bytes())
            .map_err(|_| AppError::internal("fallo cifrando campo"))?;

        let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ct);

        Ok(Some(format!("{PREFIJO}{}", B64U.encode(blob))))
    }

    fn decrypt(&self, stored: Option<&str>) -> AppResult<Option<String>> {
        let Some(guardado) = stored else {
            return Ok(None);
        };
        if guardado.is_empty() {
            return Ok(Some(String::new()));
        }
        // Fila aún sin migrar: se devuelve tal cual para no romper la lectura.
        if !self.is_encrypted(guardado) {
            return Ok(Some(guardado.to_string()));
        }

        let blob = B64U
            .decode(&guardado[PREFIJO.len()..])
            .map_err(|_| AppError::internal("campo cifrado con base64 inválido"))?;

        if blob.len() <= NONCE_LEN {
            return Err(AppError::internal("campo cifrado truncado"));
        }

        let (nonce, ct) = blob.split_at(NONCE_LEN);
        let claro = self
            .cipher()
            .decrypt(Nonce::from_slice(nonce), ct)
            .map_err(|_| AppError::internal("no se pudo descifrar el campo (clave o dato alterado)"))?;

        String::from_utf8(claro)
            .map(Some)
            .map_err(|_| AppError::internal("el campo descifrado no es UTF-8"))
    }

    fn is_encrypted(&self, stored: &str) -> bool {
        stored.starts_with(PREFIJO)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as B64S;

    fn cipher() -> FieldCipherAes {
        FieldCipherAes::new(&B64S.encode([7u8; 32])).unwrap()
    }

    fn otro_cipher() -> FieldCipherAes {
        FieldCipherAes::new(&B64S.encode([9u8; 32])).unwrap()
    }

    #[test]
    fn ida_y_vuelta() {
        let c = cipher();
        let cifrado = c.encrypt(Some("12345678Z")).unwrap().unwrap();
        assert_ne!(cifrado, "12345678Z");
        assert_eq!(c.decrypt(Some(&cifrado)).unwrap().unwrap(), "12345678Z");
    }

    #[test]
    fn el_texto_claro_no_aparece_en_el_cifrado() {
        let c = cipher();
        let cifrado = c.encrypt(Some("ES9121000418450200051332")).unwrap().unwrap();
        assert!(!cifrado.contains("ES9121000418450200051332"));
        assert!(!cifrado.contains("0200051332"));
    }

    /// La razón de ser del diseño: el UNIQUE de DNI/NSS tiene que seguir detectando duplicados.
    #[test]
    fn es_determinista_para_que_el_unique_siga_valiendo() {
        let c = cipher();
        let a = c.encrypt(Some("12345678Z")).unwrap();
        let b = c.encrypt(Some("12345678Z")).unwrap();
        assert_eq!(a, b, "el mismo DNI debe dar el mismo texto cifrado");

        let distinto = c.encrypt(Some("87654321X")).unwrap();
        assert_ne!(a, distinto, "DNIs distintos no pueden colisionar");
    }

    #[test]
    fn cifrar_dos_veces_no_cambia_nada() {
        let c = cipher();
        let una = c.encrypt(Some("12345678Z")).unwrap().unwrap();
        let dos = c.encrypt(Some(&una)).unwrap().unwrap();
        assert_eq!(una, dos);
        assert_eq!(c.decrypt(Some(&dos)).unwrap().unwrap(), "12345678Z");
    }

    #[test]
    fn nulos_y_vacios_se_quedan_como_estan() {
        let c = cipher();
        assert_eq!(c.encrypt(None).unwrap(), None);
        assert_eq!(c.decrypt(None).unwrap(), None);
        assert_eq!(c.encrypt(Some("")).unwrap(), Some(String::new()));
        assert_eq!(c.decrypt(Some("")).unwrap(), Some(String::new()));
    }

    /// Filas anteriores a activar el cifrado: se leen tal cual hasta que el job las migre.
    #[test]
    fn un_valor_sin_prefijo_se_lee_en_claro() {
        let c = cipher();
        assert_eq!(c.decrypt(Some("12345678Z")).unwrap().unwrap(), "12345678Z");
        assert!(!c.is_encrypted("12345678Z"));
    }

    #[test]
    fn con_otra_clave_no_se_descifra() {
        let cifrado = cipher().encrypt(Some("12345678Z")).unwrap().unwrap();
        assert!(otro_cipher().decrypt(Some(&cifrado)).is_err());
    }

    #[test]
    fn detecta_manipulacion_del_dato() {
        let c = cipher();
        let cifrado = c.encrypt(Some("12345678Z")).unwrap().unwrap();

        // Se le cambia un byte al blob: el tag de GCM tiene que cantar.
        let payload = &cifrado[PREFIJO.len()..];
        let mut blob = B64U.decode(payload).unwrap();
        let ultimo = blob.len() - 1;
        blob[ultimo] ^= 0x01;
        let alterado = format!("{PREFIJO}{}", B64U.encode(&blob));

        assert!(c.decrypt(Some(&alterado)).is_err());
    }

    #[test]
    fn detecta_truncamiento() {
        let c = cipher();
        let corto = format!("{PREFIJO}{}", B64U.encode([1u8; 4]));
        assert!(c.decrypt(Some(&corto)).is_err());
    }

    #[test]
    fn rechaza_claves_de_tamano_incorrecto() {
        assert!(FieldCipherAes::new(&B64S.encode([1u8; 16])).is_err());
        assert!(FieldCipherAes::new("no-es-base64-!!!").is_err());
    }

    #[test]
    fn acepta_la_dek_en_base64_estandar_y_urlsafe() {
        let bytes = [3u8; 32];
        let a = FieldCipherAes::new(&B64S.encode(bytes)).unwrap();
        let b = FieldCipherAes::new(&B64U.encode(bytes)).unwrap();
        assert_eq!(
            a.encrypt(Some("12345678Z")).unwrap(),
            b.encrypt(Some("12345678Z")).unwrap(),
        );
    }

    #[test]
    fn soporta_acentos_y_texto_largo() {
        let c = cipher();
        let valor = "Núñez-Ávila ÑÖÜ 1234567890".repeat(20);
        let cifrado = c.encrypt(Some(&valor)).unwrap().unwrap();
        assert_eq!(c.decrypt(Some(&cifrado)).unwrap().unwrap(), valor);
    }
}
