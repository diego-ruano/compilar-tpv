//! Almacén de secretos por plataforma. Misma API que usaba `keyring::Entry`: get/set/delete de un
//! valor `String` por par `(service, key)`. `device.rs` lo consume sin conocer la plataforma.
//!
//! - **Escritorio** (ni Android ni iOS): `keyring` (keychain del SO: Windows Credential Manager,
//!   macOS Keychain, Secret Service en Linux). Comportamiento idéntico al anterior.
//! - **iOS**: el «protected data» de Apple (`apple-native-keyring-store`), el llavero de la propia
//!   app, que sólo se abre con el teléfono desbloqueado. keyring 4 no trae almacén por defecto para
//!   iOS, así que se fija éste una vez y se usa con la misma API (`keyring_core::Entry`).
//! - **Android**: SharedPreferences **privadas** de la app con los **valores cifrados AES-256-GCM**
//!   usando una clave maestra **no exportable** del **Android Keystore** (respaldo hardware TEE/
//!   StrongBox cuando el dispositivo lo tiene). Equivale a `EncryptedSharedPreferences` de AndroidX
//!   pero implementado con **solo clases del framework** vía JNI, para no añadir dependencias
//!   AndroidX ni un plugin Kotlin.
//!   La `JavaVM` la guarda `JNI_OnLoad` del cdylib de la app y el `Context` lo entrega
//!   `MainActivity` al arrancar (`TpvNativo.entregarContexto`, RI-75), así las funciones libres de
//!   `device.rs` no necesitan `AppHandle` ni cambian de firma.
//!
//! ⚠️ El backend Android compila pero su comportamiento en runtime debe validarse en un
//!    dispositivo/emulador (los errores de firma JNI solo aparecen al ejecutar).

/// Por qué no se ha podido leer un secreto (RI-72).
///
/// Las dos causas piden cosas opuestas, y por eso no van juntas en un `String`. Quien lee la
/// identidad del equipo trataba cualquier error como «no hay nada guardado» y generaba otra encima:
/// un Administrador de credenciales que tardaba en contestar al arrancar Windows bastaba para perder
/// para siempre el `device-id` o la clave con la que la nube reconoce a este equipo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorSecreto {
    /// No se ha podido preguntar: el almacén no responde, la sesión del sistema está a medio cargar,
    /// falla el JNI… Lo guardado sigue ahí y puede volver a leerse en el siguiente intento, así que
    /// lo único que NO se puede hacer es escribir otro valor encima.
    NoDisponible(String),
    /// Hay algo guardado, pero no se puede descifrar con la clave de este equipo y no va a poder
    /// nunca: es una copia de Android restaurada en otro teléfono, cuya clave del Keystore no viajó
    /// con ella (RI-76). Ese valor ya no sirve, y regenerarlo es lo correcto. En escritorio no pasa,
    /// y por eso allí sólo la construyen los tests.
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    Ilegible(String),
}

impl std::fmt::Display for ErrorSecreto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErrorSecreto::NoDisponible(e) => write!(f, "almacén de secretos no disponible: {e}"),
            ErrorSecreto::Ilegible(e) => write!(f, "secreto ilegible en este equipo: {e}"),
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod imp {
    use keyring::{Entry, Error};

    use super::ErrorSecreto;

    /// `NoEntry` es lo único que significa «no hay nada»; cualquier otro error del keyring es que no
    /// se ha podido preguntar. El keyring devuelve el texto en claro, así que aquí nunca hay nada
    /// ilegible.
    pub fn get(service: &str, key: &str) -> Result<Option<String>, ErrorSecreto> {
        let entry =
            Entry::new(service, key).map_err(|e| ErrorSecreto::NoDisponible(e.to_string()))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(ErrorSecreto::NoDisponible(e.to_string())),
        }
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        Entry::new(service, key)
            .map_err(|e| e.to_string())?
            .set_password(value)
            .map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, key: &str) -> Result<(), String> {
        let entry = Entry::new(service, key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(target_os = "ios")]
mod imp {
    use std::sync::LazyLock;

    use keyring_core::{Entry, Error};

    use super::ErrorSecreto;

    /// El almacén por defecto, fijado una sola vez: el «protected data» local del teléfono (no el de
    /// iCloud), con la política por defecto «accesible con el teléfono desbloqueado».
    static ALMACEN: LazyLock<Result<(), String>> = LazyLock::new(|| {
        let almacen = apple_native_keyring_store::protected::Store::new().map_err(|e| e.to_string())?;
        keyring_core::set_default_store(almacen);
        Ok(())
    });

    fn entrada(service: &str, key: &str) -> Result<Entry, String> {
        (*ALMACEN).clone()?;
        Entry::new(service, key).map_err(|e| e.to_string())
    }

    /// Lo mismo que en escritorio: `NoEntry` es lo único que significa «no hay nada».
    pub fn get(service: &str, key: &str) -> Result<Option<String>, ErrorSecreto> {
        let entry = entrada(service, key).map_err(ErrorSecreto::NoDisponible)?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(ErrorSecreto::NoDisponible(e.to_string())),
        }
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        entrada(service, key)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn delete(service: &str, key: &str) -> Result<(), String> {
        match entrada(service, key)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Lo que hace que un equipo ya instalado siga encontrando su identidad tras actualizar `keyring`.
///
/// keyring 2 guardaba cada secreto como credencial genérica de Windows llamada `{key}.{service}`,
/// con persistencia `ENTERPRISE` y el texto en UTF-16LE sin terminador. Si una versión nueva cambia
/// cualquiera de las tres cosas, compila y funciona en un equipo limpio, pero los instalados dejan de
/// encontrar su `device-id` y su clave al actualizar. La 4.2 se comprobó contra la 2.3.3 en los dos
/// sentidos (escribir con una y leer con la otra); este test vigila que siga siendo así.
#[cfg(all(test, windows))]
mod tests_credencial_windows {
    #[test]
    fn la_credencial_se_guarda_donde_la_buscan_los_equipos_instalados() {
        let (servicio, clave, secreto) = ("tpv-test-formato-credencial", "prueba", "ñ-€-123");
        let entrada = keyring::Entry::new(servicio, clave).expect("almacén de credenciales de Windows");
        if let Err(e) = entrada.set_password(secreto) {
            // Sin sesión de usuario (un servicio, un runner sin perfil) no hay almacén al que escribir.
            eprintln!("se omite: el almacén de credenciales no admite escrituras aquí ({e})");
            return;
        }
        let atributos = entrada.inner.get_attributes();
        let bruto = entrada.get_secret();
        let leido = entrada.get_password();
        let _ = entrada.delete_credential();

        let atributos = atributos.expect("atributos de la credencial");
        assert_eq!(atributos.get("target_name").map(String::as_str), Some("prueba.tpv-test-formato-credencial"));
        assert_eq!(atributos.get("persistence").map(String::as_str), Some("Enterprise"));
        let utf16: Vec<u8> = secreto.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(bruto.expect("secreto en bruto"), utf16);
        assert_eq!(leido.expect("secreto como texto"), secreto);
    }
}

#[cfg(target_os = "android")]
mod imp {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use jni::objects::{GlobalRef, JByteArray, JObject, JString, JValue};
    use jni::{JNIEnv, JavaVM};
    use std::os::raw::c_void;
    use std::sync::OnceLock;

    use super::ErrorSecreto;

    /// Nombre del fichero de SharedPreferences (privado de la app).
    const PREFS_NAME: &str = "tpv_secret_store";
    /// Alias de la clave maestra AES en el Android Keystore.
    const MASTER_ALIAS: &str = "tpv_secret_master_v1";

    fn je<E: std::fmt::Display>(e: E) -> String {
        let s = format!("secret_store(android): {e}");
        tracing::warn!("[secret_store] ERR {s}");
        s
    }

    /// Clave de la entrada en SharedPreferences a partir de `(service, key)` (separador 0x1F, que no
    /// aparece en texto normal).
    fn entry_name(service: &str, key: &str) -> String {
        format!("{service}\u{1f}{key}")
    }

    /// Ejecuta `f` con un `JNIEnv` adjunto al hilo actual y el `Context` de la app.
    static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();

    /// Guarda la `JavaVM` del proceso. La invoca `JNI_OnLoad` del cdylib de la app (ver app `lib.rs`),
    /// que el runtime de Android llama al cargar `libtpv_lib.so`, pasándole la VM del proceso. No
    /// usamos `ndk_context` (Tauri no lo inicializa) ni `JNI_GetCreatedJavaVMs` (el aislamiento de
    /// namespaces del linker de Android no lo expone vía `dlsym` desde la app).
    pub fn init_java_vm(raw_vm: *mut c_void) {
        if raw_vm.is_null() {
            return;
        }
        match unsafe { JavaVM::from_raw(raw_vm as *mut jni::sys::JavaVM) } {
            Ok(vm) => {
                let _ = JAVA_VM.set(vm);
            }
            Err(e) => tracing::warn!("[secret_store] init_java_vm: from_raw falló: {e}"),
        }
    }

    fn java_vm() -> Result<&'static JavaVM, String> {
        JAVA_VM
            .get()
            .ok_or_else(|| je("JavaVM no inicializada (¿JNI_OnLoad no se llamó?)"))
    }

    /// El `Context` de la aplicación, como referencia global: vale en cualquier hilo y vive lo que el
    /// proceso.
    static CONTEXTO: OnceLock<GlobalRef> = OnceLock::new();

    /// RI-75: guarda el `Context` que entrega `MainActivity` (`TpvNativo.entregarContexto`) antes de
    /// arrancar Tauri. Antes salía de `ActivityThread.currentApplication()`, una API no pública que
    /// Android tolera con un aviso en logcat pero puede cerrar en cualquier versión.
    pub fn init_contexto(raw_env: *mut c_void, raw_contexto: *mut c_void) {
        if raw_env.is_null() || raw_contexto.is_null() {
            tracing::warn!("[secret_store] init_contexto: llegó un puntero nulo");
            return;
        }
        let resultado = unsafe { JNIEnv::from_raw(raw_env as *mut jni::sys::JNIEnv) }.and_then(|env| {
            let contexto = unsafe { JObject::from_raw(raw_contexto as jni::sys::jobject) };
            env.new_global_ref(&contexto)
        });
        match resultado {
            Ok(global) => {
                let _ = CONTEXTO.set(global);
            }
            Err(e) => tracing::warn!("[secret_store] init_contexto: {e}"),
        }
    }

    fn contexto() -> Result<&'static JObject<'static>, String> {
        CONTEXTO
            .get()
            .map(GlobalRef::as_obj)
            .ok_or_else(|| je("Context no entregado (¿MainActivity no llamó a entregarContexto?)"))
    }

    ///
    /// RI-75: es también el ÚNICO sitio donde se trata una excepción de Java. Cuando un método de
    /// Java lanza, el crate `jni` devuelve `Error::JavaException` pero la excepción sigue pendiente en
    /// el hilo, y con una pendiente la especificación de JNI sólo deja llamar a las funciones que la
    /// tratan: la siguiente llamada sería ilegal (con CheckJNI, ART aborta el proceso). Todas las
    /// llamadas de este módulo salen con `?` al primer fallo, así que el error llega hasta aquí sin
    /// que se haya hecho ninguna otra, y aquí se limpia antes de soltar el hilo.
    fn with_env<R>(
        f: impl FnOnce(&mut JNIEnv, &JObject) -> Result<R, ErrorSecreto>,
    ) -> Result<R, ErrorSecreto> {
        let vm = java_vm().map_err(ErrorSecreto::NoDisponible)?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| ErrorSecreto::NoDisponible(je(e)))?;

        let context = contexto().map_err(ErrorSecreto::NoDisponible)?;

        match f(&mut env, context) {
            Ok(v) => Ok(v),
            Err(e) => {
                // El descifrado que no cuadra llega como un fallo de JNI más: lo que lo distingue es
                // la clase de la excepción. Es el blob de otro teléfono (o de una clave maestra que ya
                // no existe), y eso no se arregla reintentando.
                let mala_etiqueta = limpiar_excepcion(&mut env);
                Err(match e {
                    ErrorSecreto::NoDisponible(m) if mala_etiqueta => ErrorSecreto::Ilegible(m),
                    otro => otro,
                })
            }
        }
    }

    /// RI-75: si hay una excepción de Java pendiente, la manda al logcat y la limpia. Devuelve si era
    /// un `AEADBadTagException` (el descifrado no cuadra con la clave), lo único que hace ilegible un
    /// secreto en vez de dejarlo sin leer por ahora.
    fn limpiar_excepcion(env: &mut JNIEnv) -> bool {
        if !env.exception_check().unwrap_or(false) {
            return false;
        }
        let excepcion = env.exception_occurred();
        // `ExceptionDescribe` la escribe en el logcat y la limpia; el `clear` es por si acaso.
        let _ = env.exception_describe();
        let _ = env.exception_clear();

        let mala_etiqueta = match excepcion {
            Ok(exc) if !exc.is_null() => env
                .is_instance_of(&exc, "javax/crypto/AEADBadTagException")
                .unwrap_or(false),
            _ => false,
        };
        // Buscar la clase también puede lanzar (si no existiera): no se deja nada pendiente.
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        mala_etiqueta
    }

    /// String[] de Java a partir de un slice de &str (para `setBlockModes`/`setEncryptionPaddings`).
    fn string_array<'e>(env: &mut JNIEnv<'e>, items: &[&str]) -> Result<JObject<'e>, String> {
        let cls = env.find_class("java/lang/String").map_err(je)?;
        let arr = env
            .new_object_array(items.len() as i32, cls, JObject::null())
            .map_err(je)?;
        for (i, it) in items.iter().enumerate() {
            let s = env.new_string(it).map_err(je)?;
            env.set_object_array_element(&arr, i as i32, &s).map_err(je)?;
        }
        Ok(arr.into())
    }

    /// Crea la clave maestra AES-256-GCM no exportable en el Android Keystore (idempotente: solo si
    /// no existe ya el alias).
    fn generate_master_key(env: &mut JNIEnv) -> Result<(), String> {
        // KeyGenerator kg = KeyGenerator.getInstance("AES", "AndroidKeyStore");
        let aes = env.new_string("AES").map_err(je)?;
        let provider = env.new_string("AndroidKeyStore").map_err(je)?;
        let kg = env
            .call_static_method(
                "javax/crypto/KeyGenerator",
                "getInstance",
                "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;",
                &[(&aes).into(), (&provider).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;

        // new KeyGenParameterSpec.Builder(alias, PURPOSE_ENCRYPT | PURPOSE_DECRYPT)  (1 | 2 = 3)
        let alias = env.new_string(MASTER_ALIAS).map_err(je)?;
        let builder = env
            .new_object(
                "android/security/keystore/KeyGenParameterSpec$Builder",
                "(Ljava/lang/String;I)V",
                &[(&alias).into(), JValue::Int(1 | 2)],
            )
            .map_err(je)?;

        // .setBlockModes("GCM").setEncryptionPaddings("NoPadding").setKeySize(256)
        let gcm = string_array(env, &["GCM"])?;
        let builder = env
            .call_method(
                &builder,
                "setBlockModes",
                "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[(&gcm).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        let pad = string_array(env, &["NoPadding"])?;
        let builder = env
            .call_method(
                &builder,
                "setEncryptionPaddings",
                "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[(&pad).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        let builder = env
            .call_method(
                &builder,
                "setKeySize",
                "(I)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
                &[JValue::Int(256)],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        let spec = env
            .call_method(
                &builder,
                "build",
                "()Landroid/security/keystore/KeyGenParameterSpec;",
                &[],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;

        // kg.init(spec); kg.generateKey();  (generateKey persiste la clave en el keystore)
        env.call_method(
            &kg,
            "init",
            "(Ljava/security/spec/AlgorithmParameterSpec;)V",
            &[(&spec).into()],
        )
        .map_err(je)?;
        env.call_method(&kg, "generateKey", "()Ljavax/crypto/SecretKey;", &[])
            .map_err(je)?;
        Ok(())
    }

    /// Devuelve la SecretKey maestra del Android Keystore (creándola si no existe). Como `GlobalRef`
    /// para poder reutilizarla en varias llamadas JNI sin problemas de lifetimes.
    ///
    /// El `bool` dice si acaba de crearse. Leyendo, eso basta para saber que lo guardado no se puede
    /// descifrar: lo cifró una clave que ya no está (RI-72). Hay que decirlo aquí porque sólo se ve
    /// una vez: a partir de esta llamada el alias ya existe, y lo siguiente es un `AEADBadTagException`.
    fn master_key(env: &mut JNIEnv) -> Result<(GlobalRef, bool), String> {
        // KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null, null);
        let ks_name = env.new_string("AndroidKeyStore").map_err(je)?;
        let ks = env
            .call_static_method(
                "java/security/KeyStore",
                "getInstance",
                "(Ljava/lang/String;)Ljava/security/KeyStore;",
                &[(&ks_name).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        env.call_method(
            &ks,
            "load",
            "(Ljava/io/InputStream;[C)V",
            &[(&JObject::null()).into(), (&JObject::null()).into()],
        )
        .map_err(je)?;

        // if (!ks.containsAlias(alias)) generate
        let alias = env.new_string(MASTER_ALIAS).map_err(je)?;
        let exists = env
            .call_method(&ks, "containsAlias", "(Ljava/lang/String;)Z", &[(&alias).into()])
            .map_err(je)?
            .z()
            .map_err(je)?;
        if !exists {
            generate_master_key(env)?;
        }

        // SecretKey key = (SecretKey) ks.getKey(alias, null);
        let key = env
            .call_method(
                &ks,
                "getKey",
                "(Ljava/lang/String;[C)Ljava/security/Key;",
                &[(&alias).into(), (&JObject::null()).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        Ok((env.new_global_ref(key).map_err(je)?, !exists))
    }

    /// Cifra `plain` con AES-256-GCM; devuelve `[len_iv:u8][iv][ciphertext+tag]`.
    fn encrypt(env: &mut JNIEnv, key: &JObject, plain: &[u8]) -> Result<Vec<u8>, String> {
        let transform = env.new_string("AES/GCM/NoPadding").map_err(je)?;
        let cipher = env
            .call_static_method(
                "javax/crypto/Cipher",
                "getInstance",
                "(Ljava/lang/String;)Ljavax/crypto/Cipher;",
                &[(&transform).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        // cipher.init(ENCRYPT_MODE=1, key)
        env.call_method(&cipher, "init", "(ILjava/security/Key;)V", &[JValue::Int(1), key.into()])
            .map_err(je)?;
        // iv = cipher.getIV()
        let iv_obj = env.call_method(&cipher, "getIV", "()[B", &[]).map_err(je)?.l().map_err(je)?;
        let iv_arr = JByteArray::from(iv_obj);
        let iv = env.convert_byte_array(&iv_arr).map_err(je)?;
        // ct = cipher.doFinal(plain)
        let plain_arr = env.byte_array_from_slice(plain).map_err(je)?;
        let ct_obj = env
            .call_method(&cipher, "doFinal", "([B)[B", &[(&plain_arr).into()])
            .map_err(je)?
            .l()
            .map_err(je)?;
        let ct_arr = JByteArray::from(ct_obj);
        let ct = env.convert_byte_array(&ct_arr).map_err(je)?;

        let mut blob = Vec::with_capacity(1 + iv.len() + ct.len());
        blob.push(iv.len() as u8);
        blob.extend_from_slice(&iv);
        blob.extend_from_slice(&ct);
        Ok(blob)
    }

    /// Descifra un blob producido por `encrypt`. Un blob mal formado es ilegible; un fallo del
    /// descifrado sale como `NoDisponible` y `with_env` lo convierte en ilegible si la excepción fue un
    /// `AEADBadTagException`.
    fn decrypt(env: &mut JNIEnv, key: &JObject, blob: &[u8]) -> Result<Vec<u8>, ErrorSecreto> {
        if blob.is_empty() {
            return Err(ErrorSecreto::Ilegible(je("blob vacío")));
        }
        let iv_len = blob[0] as usize;
        if blob.len() < 1 + iv_len {
            return Err(ErrorSecreto::Ilegible(je("blob corrupto")));
        }
        let iv = &blob[1..1 + iv_len];
        let ct = &blob[1 + iv_len..];
        descifrar(env, key, iv, ct).map_err(ErrorSecreto::NoDisponible)
    }

    fn descifrar(env: &mut JNIEnv, key: &JObject, iv: &[u8], ct: &[u8]) -> Result<Vec<u8>, String> {

        let transform = env.new_string("AES/GCM/NoPadding").map_err(je)?;
        let cipher = env
            .call_static_method(
                "javax/crypto/Cipher",
                "getInstance",
                "(Ljava/lang/String;)Ljavax/crypto/Cipher;",
                &[(&transform).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        let iv_arr = env.byte_array_from_slice(iv).map_err(je)?;
        // new GCMParameterSpec(128, iv)
        let spec = env
            .new_object(
                "javax/crypto/spec/GCMParameterSpec",
                "(I[B)V",
                &[JValue::Int(128), (&iv_arr).into()],
            )
            .map_err(je)?;
        // cipher.init(DECRYPT_MODE=2, key, spec)
        env.call_method(
            &cipher,
            "init",
            "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V",
            &[JValue::Int(2), key.into(), (&spec).into()],
        )
        .map_err(je)?;
        let ct_arr = env.byte_array_from_slice(ct).map_err(je)?;
        let pt_obj = env
            .call_method(&cipher, "doFinal", "([B)[B", &[(&ct_arr).into()])
            .map_err(je)?
            .l()
            .map_err(je)?;
        let pt_arr = JByteArray::from(pt_obj);
        env.convert_byte_array(&pt_arr).map_err(je)
    }

    /// context.getSharedPreferences(PREFS_NAME, MODE_PRIVATE=0)
    fn prefs<'e>(env: &mut JNIEnv<'e>, context: &JObject) -> Result<JObject<'e>, String> {
        let name = env.new_string(PREFS_NAME).map_err(je)?;
        env.call_method(
            context,
            "getSharedPreferences",
            "(Ljava/lang/String;I)Landroid/content/SharedPreferences;",
            &[(&name).into(), JValue::Int(0)],
        )
        .map_err(je)?
        .l()
        .map_err(je)
    }

    /// El valor cifrado tal cual está en las SharedPreferences, o `None` si no hay nada.
    fn leer_crudo(env: &mut JNIEnv, context: &JObject, name: &str) -> Result<Option<String>, String> {
        let sp = prefs(env, context)?;
        let jname = env.new_string(name).map_err(je)?;
        let val = env
            .call_method(
                &sp,
                "getString",
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[(&jname).into(), (&JObject::null()).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        if val.is_null() {
            return Ok(None);
        }
        let b64: String = env.get_string(&JString::from(val)).map_err(je)?.into();
        Ok(Some(b64))
    }

    pub fn get(service: &str, key: &str) -> Result<Option<String>, ErrorSecreto> {
        let name = entry_name(service, key);
        with_env(|env, context| {
            let Some(b64) = leer_crudo(env, context, &name).map_err(ErrorSecreto::NoDisponible)?
            else {
                return Ok(None);
            };

            // De aquí en adelante HAY un valor guardado: lo que no se pueda interpretar es ilegible,
            // no ausente.
            let blob = B64
                .decode(b64.trim())
                .map_err(|e| ErrorSecreto::Ilegible(je(e)))?;
            let (key_ref, recien_creada) = master_key(env).map_err(ErrorSecreto::NoDisponible)?;
            if recien_creada {
                return Err(ErrorSecreto::Ilegible(je(
                    "la clave maestra que cifró este valor ya no está en el Keystore",
                )));
            }
            let plain = decrypt(env, key_ref.as_obj(), &blob)?;
            let s = String::from_utf8(plain).map_err(|e| ErrorSecreto::Ilegible(je(e)))?;
            Ok(Some(s))
        })
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        let name = entry_name(service, key);
        with_env(|env, context| escribir(env, context, &name, value).map_err(ErrorSecreto::NoDisponible))
            .map_err(|e| e.to_string())
    }

    fn escribir(env: &mut JNIEnv, context: &JObject, name: &str, value: &str) -> Result<(), String> {
        let (key_ref, _) = master_key(env)?;
        let blob = encrypt(env, key_ref.as_obj(), value.as_bytes())?;
        let b64 = B64.encode(&blob);

        let sp = prefs(env, context)?;
        let editor = env
            .call_method(&sp, "edit", "()Landroid/content/SharedPreferences$Editor;", &[])
            .map_err(je)?
            .l()
            .map_err(je)?;
        let jname = env.new_string(name).map_err(je)?;
        let jval = env.new_string(&b64).map_err(je)?;
        let editor = env
            .call_method(
                &editor,
                "putString",
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;",
                &[(&jname).into(), (&jval).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        env.call_method(&editor, "apply", "()V", &[]).map_err(je)?;
        Ok(())
    }

    pub fn delete(service: &str, key: &str) -> Result<(), String> {
        let name = entry_name(service, key);
        with_env(|env, context| borrar(env, context, &name).map_err(ErrorSecreto::NoDisponible))
            .map_err(|e| e.to_string())
    }

    fn borrar(env: &mut JNIEnv, context: &JObject, name: &str) -> Result<(), String> {
        let sp = prefs(env, context)?;
        let editor = env
            .call_method(&sp, "edit", "()Landroid/content/SharedPreferences$Editor;", &[])
            .map_err(je)?
            .l()
            .map_err(je)?;
        let jname = env.new_string(name).map_err(je)?;
        let editor = env
            .call_method(
                &editor,
                "remove",
                "(Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;",
                &[(&jname).into()],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        env.call_method(&editor, "apply", "()V", &[]).map_err(je)?;
        Ok(())
    }
}

/// El espacio de los secretos de este build. Sin fijar, que es producción: los nombres de siempre.
static ESPACIO: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

/// Aparta los secretos de este build bajo otro nombre (`{service}.{espacio}`).
///
/// Lo usa el build de E2E, que en el mismo Windows convive con la app de trabajo. Con el mismo
/// almacén compartían `device-id` y clave: para la nube eran el mismo equipo, y si la app de trabajo
/// era la Main de una licencia viva, la licencia de la tanda se canjeaba en ella (REV-13) y la tanda
/// trabajaba en ese negocio. Se fija una vez, al arrancar y antes de leer ningún secreto.
pub fn apartar_secretos(espacio: &'static str) {
    let _ = ESPACIO.set(espacio);
}

fn servicio(service: &str) -> std::borrow::Cow<'_, str> {
    match ESPACIO.get() {
        Some(espacio) => format!("{service}.{espacio}").into(),
        None => service.into(),
    }
}

pub fn get(service: &str, key: &str) -> Result<Option<String>, ErrorSecreto> {
    imp::get(&servicio(service), key)
}

pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
    imp::set(&servicio(service), key, value)
}

pub fn delete(service: &str, key: &str) -> Result<(), String> {
    imp::delete(&servicio(service), key)
}

/// Guardan la `JavaVM` del proceso (la entrega `JNI_OnLoad`) y el `Context` de la app (lo entrega
/// `MainActivity`), los dos desde el cdylib de la app. Solo Android.
#[cfg(target_os = "android")]
pub use imp::{init_contexto, init_java_vm};
