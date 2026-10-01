//! Almacén de secretos por plataforma. Misma API que usaba `keyring::Entry`: get/set/delete de un
//! valor `String` por par `(service, key)`. `device.rs` lo consume sin conocer la plataforma.
//!
//! - **Escritorio** (`not(target_os = "android")`): `keyring` (keychain del SO: Windows Credential
//!   Manager, macOS Keychain, Secret Service en Linux). Comportamiento idéntico al anterior.
//! - **Android**: SharedPreferences **privadas** de la app con los **valores cifrados AES-256-GCM**
//!   usando una clave maestra **no exportable** del **Android Keystore** (respaldo hardware TEE/
//!   StrongBox cuando el dispositivo lo tiene). Equivale a `EncryptedSharedPreferences` de AndroidX
//!   pero implementado con **solo clases del framework** vía JNI, para:
//!   · no añadir dependencias AndroidX ni un plugin Kotlin, y
//!   · no tocar `gen/android` (sobrevive a `tauri android init`, que regenera ese árbol).
//!   La `JavaVM` la guarda `JNI_OnLoad` del cdylib de la app y el `Context` se obtiene con
//!   `ActivityThread.currentApplication()` (no hace falta `AppHandle`), así las funciones libres de
//!   `device.rs` no cambian de firma.
//!
//! ⚠️ El backend Android compila pero su comportamiento en runtime debe validarse en un
//!    dispositivo/emulador (los errores de firma JNI solo aparecen al ejecutar).

#[cfg(not(target_os = "android"))]
mod imp {
    use keyring::{Entry, Error};

    pub fn get(service: &str, key: &str) -> Result<Option<String>, String> {
        let entry = Entry::new(service, key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
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
        match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(target_os = "android")]
mod imp {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use jni::objects::{GlobalRef, JByteArray, JObject, JString, JValue};
    use jni::{JNIEnv, JavaVM};
    use std::os::raw::c_void;
    use std::sync::OnceLock;

    /// Nombre del fichero de SharedPreferences (privado de la app).
    const PREFS_NAME: &str = "tpv_secret_store";
    /// Alias de la clave maestra AES en el Android Keystore.
    const MASTER_ALIAS: &str = "tpv_secret_master_v1";

    fn je<E: std::fmt::Display>(e: E) -> String {
        let s = format!("secret_store(android): {e}");
        log::warn!("[secret_store] ERR {s}");
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
            Err(e) => log::warn!("[secret_store] init_java_vm: from_raw falló: {e}"),
        }
    }

    fn java_vm() -> Result<&'static JavaVM, String> {
        JAVA_VM
            .get()
            .ok_or_else(|| je("JavaVM no inicializada (¿JNI_OnLoad no se llamó?)"))
    }

    fn with_env<R>(f: impl FnOnce(&mut JNIEnv, &JObject) -> Result<R, String>) -> Result<R, String> {
        let vm = java_vm()?;
        let mut env = vm.attach_current_thread().map_err(je)?;
        // Context de la app sin que nadie nos lo pase: ActivityThread.currentApplication() devuelve la
        // Application (que es un Context). Suficiente para getSharedPreferences (el Keystore no lo usa).
        let context = env
            .call_static_method(
                "android/app/ActivityThread",
                "currentApplication",
                "()Landroid/app/Application;",
                &[],
            )
            .map_err(je)?
            .l()
            .map_err(je)?;
        if context.is_null() {
            return Err(je("ActivityThread.currentApplication() devolvió null"));
        }
        f(&mut env, &context)
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
    fn master_key(env: &mut JNIEnv) -> Result<GlobalRef, String> {
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
        env.new_global_ref(key).map_err(je)
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

    /// Descifra un blob producido por `encrypt`.
    fn decrypt(env: &mut JNIEnv, key: &JObject, blob: &[u8]) -> Result<Vec<u8>, String> {
        if blob.is_empty() {
            return Err(je("blob vacío"));
        }
        let iv_len = blob[0] as usize;
        if blob.len() < 1 + iv_len {
            return Err(je("blob corrupto"));
        }
        let iv = &blob[1..1 + iv_len];
        let ct = &blob[1 + iv_len..];

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

    pub fn get(service: &str, key: &str) -> Result<Option<String>, String> {
        let name = entry_name(service, key);
        with_env(|env, context| {
            let sp = prefs(env, context)?;
            let jname = env.new_string(&name).map_err(je)?;
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
            let blob = B64.decode(b64.trim()).map_err(je)?;
            let key_ref = master_key(env)?;
            let plain = decrypt(env, key_ref.as_obj(), &blob)?;
            let s = String::from_utf8(plain).map_err(je)?;
            Ok(Some(s))
        })
    }

    pub fn set(service: &str, key: &str, value: &str) -> Result<(), String> {
        let name = entry_name(service, key);
        with_env(|env, context| {
            let key_ref = master_key(env)?;
            let blob = encrypt(env, key_ref.as_obj(), value.as_bytes())?;
            let b64 = B64.encode(&blob);

            let sp = prefs(env, context)?;
            let editor = env
                .call_method(&sp, "edit", "()Landroid/content/SharedPreferences$Editor;", &[])
                .map_err(je)?
                .l()
                .map_err(je)?;
            let jname = env.new_string(&name).map_err(je)?;
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
        })
    }

    pub fn delete(service: &str, key: &str) -> Result<(), String> {
        let name = entry_name(service, key);
        with_env(|env, context| {
            let sp = prefs(env, context)?;
            let editor = env
                .call_method(&sp, "edit", "()Landroid/content/SharedPreferences$Editor;", &[])
                .map_err(je)?
                .l()
                .map_err(je)?;
            let jname = env.new_string(&name).map_err(je)?;
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
        })
    }
}

pub use imp::{delete, get, set};

/// Guarda la `JavaVM` del proceso (la llama `JNI_OnLoad` del cdylib de la app). Solo Android.
#[cfg(target_os = "android")]
pub use imp::init_java_vm;
