package com.altarialights.tpv

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // RI-75: antes de arrancar Tauri, que es quien llega a leer los secretos.
    TpvNativo.entregarContexto(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
