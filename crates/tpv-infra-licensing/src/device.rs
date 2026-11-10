//! Identidad de dispositivo y cripto compartida por licensing y pairing:
//! device-id + clave ed25519 en keyring, firma de proof, y almacén del handy token.
//! Lógica de bajo nivel portada verbatim de `licensing.rs`/`pairing.rs` (devuelve `String`
//! como error; el adaptador la mapea a `AppError`).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::secret_store::{self, ErrorSecreto};

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
/// DEK del tenant para el cifrado de la PII del personal (TRAB-03).
const KEY_FIELD_DEK: &str = "field-dek";

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

/* ===== device-id + keypair (almacén de secretos) =====

   RI-72 · LEER NO ES CREAR. Antes había una sola función por secreto, «dámelo o invéntalo», y la
   llamaban todas las peticiones firmadas y el gate de la licencia. Como trataba cualquier error del
   almacén igual que «no hay nada», un Administrador de credenciales que tardaba en contestar al
   arrancar Windows bastaba para generar un `device-id` o una clave nuevos y escribirlos ENCIMA de los
   buenos. Eso no tiene vuelta atrás: con otro `device-id` la nube ya no ve aquí a la Main de su
   licencia (y salir exige el código del correo del titular), y con otra clave todas las firmas
   salen `bad_device_signature` y reactivar da `device_key_mismatch`.

   Ahora sólo crean la activación y el emparejamiento (`get_or_create_*`), que es cuando un equipo
   estrena identidad; firmar, comprobar la licencia y el updater sólo leen (`leer_*`). Y al leer:
     · hay valor → se usa;
     · no hay nada → se crea (si quien pregunta puede crear);
     · no se ha podido preguntar → error, y se vuelve a intentar en la siguiente llamada;
     · hay valor pero no se puede descifrar aquí (copia de Android restaurada en otro teléfono) → no
       va a servir nunca, y regenerar es lo correcto. */

/// Lo que hay que hacer con un secreto de identidad después de intentar leerlo.
#[derive(Debug, PartialEq, Eq)]
enum Lectura {
    Usar(String),
    Crear,
    Fallo(String),
}

fn decidir(leido: Result<Option<String>, ErrorSecreto>, que: &str) -> Lectura {
    match leido {
        Ok(Some(v)) if !v.trim().is_empty() => Lectura::Usar(v.trim().to_string()),
        Ok(_) => Lectura::Crear,
        Err(ErrorSecreto::Ilegible(e)) => {
            tracing::warn!("[identidad] {que} guardado no se puede descifrar en este equipo ({e}): se genera otro");
            Lectura::Crear
        }
        Err(ErrorSecreto::NoDisponible(e)) => {
            Lectura::Fallo(format!("No se ha podido leer {que} del almacén de secretos: {e}"))
        }
    }
}

/// El almacén, como algo que se le pasa a la lógica de identidad: así los tests pueden simular que no
/// responde sin tocar el keyring de verdad.
trait Almacen {
    fn get(&self, service: &str, key: &str) -> Result<Option<String>, ErrorSecreto>;
    fn set(&self, service: &str, key: &str, value: &str) -> Result<(), String>;
}

struct DelSistema;

impl Almacen for DelSistema {
    fn get(&self, service: &str, key: &str) -> Result<Option<String>, ErrorSecreto> {
        secret_store::get(service, key)
    }
    fn set(&self, service: &str, key: &str, value: &str) -> Result<(), String> {
        secret_store::set(service, key, value)
    }
}

fn device_id_en(almacen: &impl Almacen, crear: bool) -> Result<Option<String>, String> {
    match decidir(almacen.get(SVC_LICENSING, KEY_DEVICE_ID), "el device-id") {
        Lectura::Usar(id) => Ok(Some(id)),
        Lectura::Fallo(e) => Err(e),
        Lectura::Crear if !crear => Ok(None),
        Lectura::Crear => {
            let id = Uuid::new_v4().to_string();
            almacen.set(SVC_LICENSING, KEY_DEVICE_ID, &id)?;
            Ok(Some(id))
        }
    }
}

fn keypair_en(
    almacen: &impl Almacen,
    device_id: &str,
    crear: bool,
) -> Result<Option<(SigningKey, String)>, String> {
    match decidir(almacen.get(SVC_DEVICE_KEY, device_id), "la clave del dispositivo") {
        Lectura::Usar(b64) => clave_desde_b64(&b64).map(Some),
        Lectura::Fallo(e) => Err(e),
        Lectura::Crear if !crear => Ok(None),
        Lectura::Crear => {
            // 32 bytes del generador del sistema, que es lo que hace `SigningKey::generate`. Así la
            // clave no depende de que ed25519-dalek y `rand` compartan versión de `rand_core`.
            use rand::TryRng as _;
            let mut semilla = ed25519_dalek::SecretKey::default();
            rand::rngs::SysRng
                .try_fill_bytes(&mut semilla)
                .map_err(|e| format!("No se pudo obtener azar del sistema: {e}"))?;
            let sk = SigningKey::from_bytes(&semilla);
            almacen.set(SVC_DEVICE_KEY, device_id, &B64.encode(sk.to_bytes()))?;
            let pub_b64 = B64.encode(sk.verifying_key().to_bytes());
            Ok(Some((sk, pub_b64)))
        }
    }
}

/// Una clave guardada que no tiene el formato esperado es un error, no un motivo para crear otra:
/// sobrescribirla es justo lo que RI-72 viene a impedir.
fn clave_desde_b64(b64: &str) -> Result<(SigningKey, String), String> {
    let bytes = B64.decode(b64.trim()).map_err(|e| e.to_string())?;
    let arr: [u8; 32] = bytes[..]
        .try_into()
        .map_err(|_| "bad_private_key_len".to_string())?;
    let sk = SigningKey::from_bytes(&arr);
    let pub_b64 = B64.encode(sk.verifying_key().to_bytes());
    Ok((sk, pub_b64))
}

/// El `device-id` de este equipo, creándolo si no tiene. Sólo para la activación y el emparejamiento.
pub fn get_or_create_device_id() -> Result<String, String> {
    device_id_en(&DelSistema, true)?.ok_or_else(|| "device_id_no_creado".to_string())
}

/// `(SigningKey, pubkey_b64)` de ese `device-id`, creándola si no tiene. Sólo para la activación y el
/// emparejamiento.
pub fn get_or_create_device_keypair(device_id: &str) -> Result<(SigningKey, String), String> {
    keypair_en(&DelSistema, device_id, true)?.ok_or_else(|| "device_key_no_creada".to_string())
}

/// El `device-id` si este equipo ya tiene uno. Nunca lo crea.
pub fn leer_device_id() -> Result<Option<String>, String> {
    device_id_en(&DelSistema, false)
}

/// La clave privada de ese `device-id`. Nunca la crea: sin ella, quien firma no tiene nada que firmar.
pub fn leer_device_keypair(device_id: &str) -> Result<SigningKey, String> {
    keypair_en(&DelSistema, device_id, false)?
        .map(|(sk, _)| sk)
        .ok_or_else(|| "sin_clave_de_dispositivo".to_string())
}

/// `(device_id, clave)` para firmar. Nunca crea nada.
pub fn leer_identidad() -> Result<(String, SigningKey), String> {
    let device_id = leer_device_id()?.ok_or_else(|| "sin_identidad_de_dispositivo".to_string())?;
    let sk = leer_device_keypair(&device_id)?;
    Ok((device_id, sk))
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
        "DEVICE_PROOF\n{}\n{}\n{}\n{}\n{}",
        ts_ms,
        method.to_uppercase(),
        path,
        sha256_hex(token),
        sha256_hex_bytes(body)
    )
}

/// AUD-01 · La ruta de la activación: a donde se manda y lo que se firma.
pub const RUTA_ACTIVAR: &str = "/v1/license/activate";

/// AUD-01 · El mensaje que firma este equipo para activar una licencia.
///
/// Es el device-proof de siempre sobre `POST /v1/license/activate`, con el tramo del token vacío:
/// al activar todavía no hay sesión. `cuerpo` son los bytes EXACTOS que se mandan, y con ellos van
/// firmados el `deviceId`, la clave pública, la clave de activación, el código de traslado,
/// `soloSumar` y el negocio que el equipo ya tiene. El worker lo comprueba con la clave pública que
/// presenta ese mismo cuerpo (`licensing.helpers.ts::verificarFirmaDeActivacion`), así que presentar
/// una clave exige tener su privada. Los dos lados leen el mismo vector,
/// `firma_activacion_casos.json`.
pub fn mensaje_de_activacion(ts_ms: i64, cuerpo: &[u8]) -> String {
    device_proof_message(ts_ms, "POST", RUTA_ACTIVAR, "", cuerpo)
}

/// La firma (base64) de [`mensaje_de_activacion`]: lo que va en `X-Device-Sig`, con `ts_ms` en
/// `X-Device-Ts`.
pub fn firmar_activacion(sk: &SigningKey, ts_ms: i64, cuerpo: &[u8]) -> Result<String, String> {
    sign_payload_b64(sk, &mensaje_de_activacion(ts_ms, cuerpo))
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

/* ===== caducidad del token de sesión ===== */

/// Margen con el que se da por caducado un token que aún no lo está. Cubre el viaje de la petición
/// y un desajuste pequeño de reloj entre el equipo y la nube.
const MARGEN_CADUCIDAD_SEGS: i64 = 60;

/// ¿Este JWT ya no vale por fecha?
///
/// Se lee del propio token (su `exp`), **sin preguntar a nadie**, y es lo que decide si un 401 de la
/// nube merece renovar la credencial y repetir la petición. La alternativa —renovar ante cualquier
/// 401— no vale: por el mismo transporte viaja el login de la Handy, que contesta 401 con un PIN
/// incorrecto **y anota el intento** (LOGIN-01), así que repetirlo gastaría dos de los intentos que
/// alguien tiene antes de quedarse fuera. Con esta comprobación, un 401 con el token en regla no es
/// cosa nuestra y no se toca nada.
///
/// Un token que no se puede leer cuenta como caducado: si no sabemos ni qué llevamos, renovarlo es
/// lo único que puede arreglarlo, y quien decide de verdad es la nube al recibir la firma.
///
/// PROD-04: el `exp` lo pone la nube con su reloj, así que se compara con la hora de la nube. Con la
/// del equipo, uno atrasado seguiría creyendo vigente un token que la nube ya rechaza, y no lo
/// renovaría nunca.
pub fn token_caducado(token: &str) -> bool {
    let ahora = crate::reloj::ahora_ms() / 1000;
    match exp_del_token(token) {
        Some(exp) => exp <= ahora + MARGEN_CADUCIDAD_SEGS,
        None => true,
    }
}

/// El `exp` (segundos desde epoch) de un JWT, o `None` si no se puede leer. NO verifica la firma:
/// para eso está el worker. Aquí sólo se mira la fecha que el propio token dice llevar.
fn exp_del_token(token: &str) -> Option<i64> {
    let payload_b64 = token.trim().split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .ok()?;
    let payload: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    payload.get("exp")?.as_i64()
}

/* ===== handy token (almacén de secretos) ===== */

pub fn get_handy_token() -> Result<String, String> {
    let token = secret_store::get(SVC_AUTH, KEY_HANDY_TOKEN)
        .map_err(|_| "handy_token_missing".to_string())?
        .ok_or_else(|| "handy_token_missing".to_string())?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("handy_token_missing".into());
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

/* ===== DEK de cifrado de campo (TRAB-03) =====
   Clave de datos del tenant con la que se cifran DNI/IBAN/nº de la Seguridad Social antes de
   escribirlos. La genera el worker al aprovisionar y la entrega en la activación; aquí vive en
   el almacén de secretos del sistema, NUNCA en `license_state.json` ni en la base de datos:
   guardarla junto al dato cifrado no protegería de nada. */

pub fn get_field_dek() -> Result<Option<String>, String> {
    match secret_store::get(SVC_AUTH, KEY_FIELD_DEK) {
        Ok(Some(v)) => {
            let v = v.trim().to_string();
            Ok(if v.is_empty() { None } else { Some(v) })
        }
        Ok(None) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set_field_dek(dek_b64: &str) -> Result<(), String> {
    let dek = dek_b64.trim();
    if dek.is_empty() {
        return Err("field_dek vacía".into());
    }
    secret_store::set(SVC_AUTH, KEY_FIELD_DEK, dek)
}

pub fn clear_field_dek() -> Result<(), String> {
    let _ = secret_store::delete(SVC_AUTH, KEY_FIELD_DEK);
    Ok(())
}

// RI-20: un reto es un campo base64 canónico de 32 bytes, nunca un mensaje libre.
pub fn validar_reto(nonce: &str) -> Result<(), String> {
    if nonce.len() != 44 { return Err("Reto inválido".into()); }
    let bytes = B64.decode(nonce).map_err(|_| "Reto inválido")?;
    if bytes.len() != 32 || B64.encode(bytes) != nonce { return Err("Reto inválido".into()); }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// Almacén en memoria al que se le puede decir que falle al leer.
    #[derive(Default)]
    struct AlmacenFalso {
        valores: RefCell<HashMap<(String, String), String>>,
        fallo: RefCell<Option<ErrorSecreto>>,
        escrituras: RefCell<u32>,
    }

    impl AlmacenFalso {
        fn con(service: &str, key: &str, valor: &str) -> Self {
            let a = Self::default();
            a.valores
                .borrow_mut()
                .insert((service.into(), key.into()), valor.into());
            a
        }
        fn fallando(self, e: ErrorSecreto) -> Self {
            *self.fallo.borrow_mut() = Some(e);
            self
        }
        fn valor(&self, service: &str, key: &str) -> Option<String> {
            self.valores
                .borrow()
                .get(&(service.to_string(), key.to_string()))
                .cloned()
        }
    }

    impl Almacen for AlmacenFalso {
        fn get(&self, service: &str, key: &str) -> Result<Option<String>, ErrorSecreto> {
            if let Some(e) = self.fallo.borrow().clone() {
                return Err(e);
            }
            Ok(self.valor(service, key))
        }
        fn set(&self, service: &str, key: &str, value: &str) -> Result<(), String> {
            *self.escrituras.borrow_mut() += 1;
            self.valores
                .borrow_mut()
                .insert((service.into(), key.into()), value.into());
            Ok(())
        }
    }

    fn no_disponible() -> ErrorSecreto {
        ErrorSecreto::NoDisponible("el Administrador de credenciales no contesta".into())
    }

    fn ilegible() -> ErrorSecreto {
        ErrorSecreto::Ilegible("AEADBadTagException".into())
    }

    /// RI-72. El caso que costaba la identidad para siempre: el almacén no contesta y se generaba
    /// otra encima de la buena. Ahora es un error, y lo guardado sigue intacto para el siguiente
    /// intento.
    #[test]
    fn si_el_almacen_no_contesta_no_se_escribe_nada_encima() {
        let a = AlmacenFalso::con(SVC_LICENSING, KEY_DEVICE_ID, "el-bueno").fallando(no_disponible());
        assert!(device_id_en(&a, true).is_err());
        assert_eq!(*a.escrituras.borrow(), 0);
        assert_eq!(a.valor(SVC_LICENSING, KEY_DEVICE_ID).as_deref(), Some("el-bueno"));

        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let a = AlmacenFalso::con(SVC_DEVICE_KEY, "d1", &B64.encode(sk.to_bytes()))
            .fallando(no_disponible());
        assert!(keypair_en(&a, "d1", true).is_err());
        assert_eq!(*a.escrituras.borrow(), 0);
    }

    #[test]
    fn lo_guardado_se_usa_tal_cual() {
        let a = AlmacenFalso::con(SVC_LICENSING, KEY_DEVICE_ID, "  el-bueno ");
        assert_eq!(device_id_en(&a, true).unwrap().as_deref(), Some("el-bueno"));
        assert_eq!(*a.escrituras.borrow(), 0);

        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let a = AlmacenFalso::con(SVC_DEVICE_KEY, "d1", &B64.encode(sk.to_bytes()));
        let (leida, _) = keypair_en(&a, "d1", true).unwrap().unwrap();
        assert_eq!(leida.to_bytes(), sk.to_bytes());
    }

    #[test]
    fn sin_nada_guardado_crea_solo_quien_puede_crear() {
        let a = AlmacenFalso::default();
        assert_eq!(device_id_en(&a, false).unwrap(), None, "leer no crea");
        assert_eq!(*a.escrituras.borrow(), 0);

        let id = device_id_en(&a, true).unwrap().unwrap();
        assert_eq!(a.valor(SVC_LICENSING, KEY_DEVICE_ID), Some(id));

        assert!(keypair_en(&a, "d1", false).unwrap().is_none(), "leer no crea");
        assert!(keypair_en(&a, "d1", true).unwrap().is_some());
        assert!(a.valor(SVC_DEVICE_KEY, "d1").is_some());
    }

    /// La copia de Android restaurada en otro teléfono: lo guardado no se va a poder descifrar
    /// nunca, así que regenerar es lo correcto. Pero sólo si quien pregunta puede crear.
    #[test]
    fn un_secreto_ilegible_se_regenera_al_crear_y_al_leer_cuenta_como_ausente() {
        let a = AlmacenFalso::default().fallando(ilegible());
        assert_eq!(device_id_en(&a, false).unwrap(), None);
        assert_eq!(*a.escrituras.borrow(), 0);
        assert!(device_id_en(&a, true).unwrap().is_some());
        assert_eq!(*a.escrituras.borrow(), 1);
    }

    /// Una clave con otro formato es un error, no un hueco que rellenar.
    #[test]
    fn una_clave_mal_formada_no_se_sobrescribe() {
        let a = AlmacenFalso::con(SVC_DEVICE_KEY, "d1", "no-es-una-clave");
        assert!(keypair_en(&a, "d1", true).is_err());
        assert_eq!(*a.escrituras.borrow(), 0);
    }

    /// Un JWT de mentira con el `exp` que se le pida. No lleva firma válida a propósito: quien
    /// comprueba la firma es el worker, y `token_caducado` sólo lee la fecha.
    fn jwt_con_exp(exp: Option<i64>) -> String {
        let payload = match exp {
            Some(e) => format!(r#"{{"tenantId":"t","exp":{e}}}"#),
            None => r#"{"tenantId":"t"}"#.to_string(),
        };
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.as_bytes());
        format!("cabecera.{b64}.firma")
    }

    /// REV-02. Esta función decide si un 401 de la nube merece renovar la credencial y **repetir**
    /// la petición, y por ese mismo transporte viajan las escrituras de la Handy y su login —que
    /// contesta 401 con un PIN incorrecto y anota el intento—. O sea: que diga `true` de más cuesta
    /// intentos de alguien que quiere entrar a trabajar, y que diga `false` de más deja la Handy
    /// inservible. Por eso se prueba sola.
    #[test]
    fn un_token_vigente_no_se_renueva() {
        let dentro_de_una_hora = chrono::Utc::now().timestamp() + 3600;
        assert!(!token_caducado(&jwt_con_exp(Some(dentro_de_una_hora))));
    }

    #[test]
    fn un_token_pasado_de_fecha_si() {
        let hace_un_rato = chrono::Utc::now().timestamp() - 1;
        assert!(token_caducado(&jwt_con_exp(Some(hace_un_rato))));
    }

    /// El margen: un token que caduca dentro de treinta segundos no llega a destino.
    #[test]
    fn uno_a_punto_de_caducar_cuenta_como_caducado() {
        let ahora = chrono::Utc::now().timestamp();
        assert!(token_caducado(&jwt_con_exp(Some(ahora + 30))));
        assert!(!token_caducado(&jwt_con_exp(Some(ahora + 120))));
    }

    /// Lo que no se puede leer se renueva: si no sabemos ni qué llevamos, es lo único que puede
    /// arreglarlo, y el veredicto de verdad lo da la nube al recibir la firma.
    #[test]
    fn lo_que_no_se_puede_leer_se_renueva() {
        assert!(token_caducado(""));
        assert!(token_caducado("esto-no-es-un-jwt"));
        assert!(token_caducado("a.no-es-base64-valido!.c"));
        assert!(token_caducado(&jwt_con_exp(None)), "sin exp no sabemos hasta cuando vale");
    }

    /// Fija el formato del device-proof. Si alguien lo cambia aquí sin cambiarlo en el worker (o
    /// al revés), el cliente empieza a recibir 401 en TODAS sus llamadas y cuesta mucho verlo:
    /// este test convierte ese despiste en un fallo de compilación de la suite.
    #[test]
    fn mensaje_device_proof_tiene_el_formato_acordado() {
        let msg = device_proof_message(1700000000000, "post", "/v1/mesas/cobrar", "tok", b"{\"a\":1}");

        let lineas: Vec<&str> = msg.split('\n').collect();
        assert_eq!(lineas.len(), 6);
        assert_eq!(lineas[0], "DEVICE_PROOF");
        let lineas = &lineas[1..];
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
        assert_ne!(device_proof_message(1, "GET", "/x?q=1", "tok", b""), device_proof_message(1, "GET", "/x?q=2", "tok", b""));
        let a = device_proof_message(1, "POST", "/x", "tok", b"{\"importe\":10}");
        let b = device_proof_message(1, "POST", "/x", "tok", b"{\"importe\":9999}");
        assert_ne!(a, b);
    }

    /// Sin cuerpo (GET/DELETE) se firma la cadena vacía, no se omite el tramo.
    #[test]
    fn sin_cuerpo_se_firma_la_cadena_vacia() {
        let msg = device_proof_message(1, "GET", "/x", "tok", b"");
        assert_eq!(msg.split('\n').count(), 6);
        assert_eq!(
            msg.split('\n').nth(5).unwrap(),
            sha256_hex(""),
            "el último tramo es sha256(\"\")"
        );
    }
}

/// AUD-01: lo que firma un equipo para activar. Ninguno de estos tests toca el almacén de claves:
/// la clave sale de una semilla fija.
#[cfg(test)]
mod tests_firma_de_activar {
    use super::*;

    /// El vector que comparten este lado y el worker (`test/activarConFirma.test.ts`).
    fn vector() -> serde_json::Value {
        serde_json::from_str(include_str!("firma_activacion_casos.json"))
            .expect("firma_activacion_casos.json no es JSON válido")
    }

    fn casos(v: &serde_json::Value) -> &Vec<serde_json::Value> {
        v["casos"].as_array().expect("casos")
    }

    #[test]
    fn el_mensaje_de_activar_ata_la_ruta_la_hora_y_el_cuerpo() {
        let cuerpo = br#"{"activationKey":"TPV-1","deviceId":"d1","devicePubKey":"k"}"#;
        let msg = mensaje_de_activacion(1_790_000_000_000, cuerpo);

        let lineas: Vec<&str> = msg.split('\n').collect();
        assert_eq!(lineas.len(), 6);
        assert_eq!(lineas[0], "DEVICE_PROOF");
        assert_eq!(lineas[1], "1790000000000");
        assert_eq!(lineas[2], "POST");
        assert_eq!(lineas[3], "/v1/license/activate");
        // Sin token: sha256 de la cadena vacía, escrito a mano para que no lo calcule lo que se prueba.
        assert_eq!(
            lineas[4],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(lineas[5], sha256_hex_bytes(cuerpo));
    }

    /// El `deviceId`, la clave pública, la clave de activación, el código de traslado, `soloSumar` y
    /// el negocio del equipo van en el cuerpo: cambiar cualquiera cambia lo firmado.
    #[test]
    fn cambiar_cualquier_dato_del_cuerpo_cambia_lo_firmado() {
        let base = mensaje_de_activacion(1, br#"{"activationKey":"A","deviceId":"d","devicePubKey":"k"}"#);
        for otro in [
            &br#"{"activationKey":"B","deviceId":"d","devicePubKey":"k"}"#[..],
            br#"{"activationKey":"A","deviceId":"e","devicePubKey":"k"}"#,
            br#"{"activationKey":"A","deviceId":"d","devicePubKey":"q"}"#,
            br#"{"activationKey":"A","deviceId":"d","devicePubKey":"k","deviceChangeCode":"123456"}"#,
            br#"{"activationKey":"A","deviceId":"d","devicePubKey":"k","soloSumar":true}"#,
            br#"{"activationKey":"A","deviceId":"d","devicePubKey":"k","tenantActual":"t"}"#,
        ] {
            assert_ne!(base, mensaje_de_activacion(1, otro));
        }
        assert_ne!(base, mensaje_de_activacion(2, br#"{"activationKey":"A","deviceId":"d","devicePubKey":"k"}"#));
    }

    /// La firma de activar no vale como device-proof de otra ruta, ni al revés: la ruta va dentro, y
    /// una petición autenticada lleva siempre un token.
    #[test]
    fn la_firma_de_activar_no_sirve_para_otra_ruta() {
        let cuerpo = b"{}";
        let activar = mensaje_de_activacion(1, cuerpo);
        assert_ne!(activar, device_proof_message(1, "POST", "/v1/license/refresh", "", cuerpo));
        assert_ne!(activar, device_proof_message(1, "POST", RUTA_ACTIVAR, "un-token", cuerpo));
    }

    #[test]
    fn la_firma_de_activar_es_la_del_vector_compartido() {
        let v = vector();
        let semilla: [u8; 32] = B64
            .decode(v["semillaB64"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let sk = SigningKey::from_bytes(&semilla);
        assert_eq!(
            B64.encode(sk.verifying_key().to_bytes()),
            v["clavePublicaB64"].as_str().unwrap()
        );

        assert!(casos(&v).len() >= 3);
        for caso in casos(&v) {
            let nombre = caso["nombre"].as_str().unwrap();
            let ts = caso["tsMs"].as_i64().unwrap();
            let cuerpo = caso["cuerpo"].as_str().unwrap().as_bytes();

            assert_eq!(mensaje_de_activacion(ts, cuerpo), caso["mensaje"].as_str().unwrap(), "{nombre}");
            assert_eq!(
                firmar_activacion(&sk, ts, cuerpo).unwrap(),
                caso["firmaB64"].as_str().unwrap(),
                "{nombre}"
            );
        }
    }
}

#[cfg(test)]
mod tests_retos {
    use super::*;
    #[test]
    fn solo_acepta_un_reto_base64_canonico_de_32_bytes() {
        assert!(validar_reto(&B64.encode([0u8; 32])).is_ok());
        for n in ["", "DEVICE_PROOF\n1", "AAAA", &B64.encode([1u8; 33])] {
            assert!(validar_reto(n).is_err());
        }
    }
}
