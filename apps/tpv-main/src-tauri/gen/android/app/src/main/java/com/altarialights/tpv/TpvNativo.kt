package com.altarialights.tpv

import android.content.Context

/**
 * Lo que la parte Kotlin le entrega a Rust y Tauri no le pasa.
 *
 * RI-75: el almacén de secretos necesita un `Context` para sus SharedPreferences, y fuera de Tauri
 * no hay forma soportada de conseguirlo. `MainActivity` lo entrega una vez, antes de arrancar Tauri.
 * La función nativa está en `lib.rs` (`Java_com_altarialights_tpv_TpvNativo_entregarContexto`).
 */
object TpvNativo {
    init {
        // La misma librería que carga `Rust.kt`; cargarla dos veces no hace nada.
        System.loadLibrary("tpv_lib")
    }

    @JvmStatic external fun entregarContexto(contexto: Context)
}
