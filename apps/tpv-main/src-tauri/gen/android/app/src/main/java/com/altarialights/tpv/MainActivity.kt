package com.altarialights.tpv

import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // RI-75: antes de arrancar Tauri, que es quien llega a leer los secretos.
    TpvNativo.entregarContexto(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // RI-76: con `targetSdk` 36 Android dibuja la app detrás de la barra de estado, la de
    // navegación y la muesca, y desde Android 15 no deja evitarlo. Se le dan a la vista esos
    // márgenes, y también el del teclado: en este modo el teclado ya no encoge la ventana y taparía
    // el campo que se está escribiendo (`adjustResize`, en el manifiesto, es lo que hace que antes de
    // Android 11 también se informe del teclado). Hacerlo aquí y no con `env(safe-area-inset-*)` en el CSS
    // vale para cualquier versión del WebView y deja dentro también los modales a pantalla completa.
    val raiz = findViewById<View>(android.R.id.content)
    pintarFranjas(oscuro = false)
    ViewCompat.setOnApplyWindowInsetsListener(raiz) { vista, insets ->
      val m = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      vista.setPadding(m.left, m.top, m.right, m.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(PuenteAndroid(), "TpvAndroid")
  }

  /**
   * Lo que queda detrás de las barras del sistema es el fondo de la vista: tiene que ser el del tema
   * de la app (que no tiene por qué ser el del teléfono), con los iconos de las barras en contraste.
   * Los colores son los de `--bg` en `Global.css`.
   */
  private fun pintarFranjas(oscuro: Boolean) {
    findViewById<View>(android.R.id.content)
      .setBackgroundColor(if (oscuro) 0xFF0E0F13.toInt() else 0xFFF3F8FF.toInt())
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !oscuro
      isAppearanceLightNavigationBars = !oscuro
    }
  }

  /** Lo llama `useTheme` (`window.TpvAndroid.tema`) cada vez que se aplica un tema. */
  inner class PuenteAndroid {
    @JavascriptInterface
    fun tema(oscuro: Boolean) {
      runOnUiThread { pintarFranjas(oscuro) }
    }
  }
}
