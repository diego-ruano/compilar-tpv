// src/vista_ios.rs
//
// La webview de iOS a pantalla completa y quieta.
//
// UIKit, por defecto (`contentInsetAdjustmentBehavior = automatic`), añade al desplazamiento de la
// WKWebView las zonas seguras de arriba (la barra de estado y la isla) y de abajo (la barra de
// inicio). Dos efectos: la página entera se puede arrastrar esos píxeles aunque quepa en pantalla
// —y le roba el gesto a la lista que el dedo quería mover—, y esas franjas enseñan el fondo nativo
// de la ventana, que no sigue el tema (en oscuro se quedan claras). Ni `overflow: hidden` ni
// `overscroll-behavior` lo evitan: no es un desplazamiento de la página sino del `UIScrollView`.
//
// Aquí se apaga ese ajuste: la página ocupa la pantalla entera (`viewport-fit=cover` en
// `index.html`) y deja ella el hueco de las zonas seguras con `env(safe-area-inset-*)`
// (`Global.css`). Una sola fuente para los márgenes: si lo hicieran las dos, saldrían dobles.

use tauri::{Manager, Runtime};

pub fn ajustar<R: Runtime, M: Manager<R>>(app: &M) {
    let Some(ventana) = app.get_webview_window("main") else {
        tracing::warn!("[TPV] iOS: no está la ventana principal para ajustar la webview");
        return;
    };
    let ajuste = ventana.with_webview(|webview| {
        use objc2::rc::Retained;
        use objc2::runtime::AnyObject;
        use objc2_ui_kit::{UIScrollView, UIScrollViewContentInsetAdjustmentBehavior};

        let puntero = webview.inner() as *const AnyObject;
        if puntero.is_null() {
            return;
        }
        // SAFETY: `inner()` es la WKWebView viva de esta ventana, y `with_webview` corre en el
        // hilo principal. `scrollView` es una propiedad de WKWebView que devuelve un UIScrollView.
        let desplazable: Retained<UIScrollView> =
            unsafe { objc2::msg_send![&*puntero, scrollView] };
        desplazable
            .setContentInsetAdjustmentBehavior(UIScrollViewContentInsetAdjustmentBehavior::Never);
        // wry ya quita el rebote; los «always» impiden que vuelva cuando el contenido cabe.
        desplazable.setBounces(false);
        desplazable.setAlwaysBounceVertical(false);
        desplazable.setAlwaysBounceHorizontal(false);
    });
    if let Err(e) = ajuste {
        tracing::warn!(error = %e, "[TPV] iOS: no se pudo ajustar la webview");
    }
}
