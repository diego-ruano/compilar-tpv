import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

/*
 * RI-76 · La clave con la que se firma la versión de release. Android sólo instala una actualización
 * firmada con la MISMA clave que la versión instalada: perderla obliga a desinstalar la Handy (y a
 * volver a emparejarla). Cómo generarla y guardarla: docs/guias/compilar-android.md.
 *
 * Se busca, por este orden:
 *   - gen/android/keystore.properties (fuera de git): storeFile, password, keyAlias y keyPassword;
 *   - variables de entorno: TPV_ANDROID_KEYSTORE (ruta) o TPV_ANDROID_KEYSTORE_BASE64 (el .jks en
 *     base64, como se guarda en Bitwarden y en GitHub), TPV_ANDROID_KEYSTORE_PASSWORD,
 *     TPV_ANDROID_KEY_ALIAS (por defecto "upload") y TPV_ANDROID_KEY_PASSWORD (por defecto, la del
 *     almacén).
 * Sin clave, la versión de release sale sin firmar, que Android no instala; la de depuración lleva
 * siempre la clave de depuración del equipo.
 */
data class Firma(val almacen: File, val password: String, val alias: String, val passwordClave: String)

val firma: Firma? = run {
    val props = Properties().apply {
        val fichero = rootProject.file("keystore.properties")
        if (fichero.exists()) fichero.inputStream().use { load(it) }
    }
    fun valor(propiedad: String, entorno: String): String? =
        props.getProperty(propiedad)?.takeIf { it.isNotBlank() }
            ?: System.getenv(entorno)?.takeIf { it.isNotBlank() }

    val password = valor("password", "TPV_ANDROID_KEYSTORE_PASSWORD") ?: return@run null
    val almacen = valor("storeFile", "TPV_ANDROID_KEYSTORE")?.let { rootProject.file(it) }
        ?: System.getenv("TPV_ANDROID_KEYSTORE_BASE64")?.takeIf { it.isNotBlank() }?.let { b64 ->
            layout.buildDirectory.file("firma/release.jks").get().asFile.apply {
                parentFile.mkdirs()
                writeBytes(Base64.getMimeDecoder().decode(b64))
            }
        }
        ?: return@run null
    if (!almacen.exists()) throw GradleException("No existe el almacén de claves de Android: ${almacen.path}")
    Firma(
        almacen,
        password,
        valor("keyAlias", "TPV_ANDROID_KEY_ALIAS") ?: "upload",
        valor("keyPassword", "TPV_ANDROID_KEY_PASSWORD") ?: password,
    )
}
if (firma == null) {
    logger.warn("Sin clave de firma de Android: la versión de release saldrá sin firmar (ver docs/guias/compilar-android.md).")
}

android {
    compileSdk = 36
    namespace = "com.altarialights.tpv"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.altarialights.tpv"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (firma != null) {
            create("release") {
                storeFile = firma.almacen
                storePassword = firma.password
                keyAlias = firma.alias
                keyPassword = firma.passwordClave
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")