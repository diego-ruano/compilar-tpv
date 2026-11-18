//! AUD-25: la **política de navegación** de la ventana.
//!
//! La ventana no tiene marco ni barra de direcciones: si la webview carga otra web, lo que se ve
//! es esa web ocupando el TPV entero, y puede imitar la pantalla del PIN. La CSP impide ejecutar
//! script ajeno, pero no regula la navegación de nivel superior (un `<meta http-equiv=refresh>`
//! que se cuele en la página, un enlace). Aquí se niega: de las navegaciones que llegan a esta
//! política, sólo pasan las que van a los orígenes desde los que Tauri sirve la propia aplicación.
//!
//! Es una segunda capa (la primera es que ese marcado no llegue a la página) y no intercepta
//! cualquier navegación:
//!
//! - Cubre el marco principal: en Windows, lo que WebView2 anuncia con `NavigationStarting`; en
//!   Android, lo que la WebView pasa por `shouldOverrideUrlLoading`; en iOS, lo que WKWebView
//!   consulta con `decidePolicyForNavigationAction`, que incluye la carga inicial.
//! - Los iframes no pasan por aquí: los para la CSP (`frame-src 'none'`).
//! - En Windows y Android la carga inicial no depende de esto: la hace Tauri con la dirección de la
//!   app, que sólo consulta a los plugins cuando la webview ya está registrada, y Android no la pasa
//!   por `shouldOverrideUrlLoading`. En iOS sí pasa por aquí, y por eso su origen tiene que estar
//!   admitido: sin él, la app se bloqueaba a sí misma y se quedaba en blanco.
//! - Una dirección que Tauri no sepa interpretar no llega: Tauri la deja pasar.
//!
//! La app no navega a ningún otro sitio: no tiene enlaces externos ni ventanas secundarias. Un
//! enlace que algún día haya que abrir (una ayuda, el portal de pagos, un correo) va al navegador
//! del sistema, nunca a esta ventana.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

/// El host desde el que Tauri sirve el frontend empaquetado en Windows y en Android
/// (`http://tauri.localhost`, o `https://` con `useHttpsScheme`).
const HOST_DE_TAURI: &str = "tauri.localhost";

/// En iOS (y en macOS) Tauri no sirve la app por `http`, sino por su propio esquema:
/// `tauri://localhost`. Sólo ahí es de la app; en Windows y Android ese esquema no lo es.
const EN_APPLE: bool = cfg!(any(target_os = "ios", target_os = "macos"));

/// Se registra como plugin porque es el único gancho de navegación que alcanza a una ventana
/// declarada en `tauri.conf.json`.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navegacion")
        .on_navigation(|webview, url| {
            // El servidor de Vite sólo es la app en desarrollo: en un build empaquetado, ese puerto
            // es de quien lo abra en el equipo.
            let servidor_dev = if tauri::is_dev() { webview.config().build.dev_url.as_ref() } else { None };
            let admitida = es_de_la_app(url, servidor_dev);
            if !admitida {
                tracing::warn!(
                    "[TPV] navegación bloqueada: la ventana no sale de la aplicación (destino: {})",
                    destino_para_el_registro(url)
                );
            }
            admitida
        })
        .build()
}

/// ¿Es `url` una página de la propia aplicación? `url` llega ya resuelta contra la página actual.
fn es_de_la_app(url: &Url, servidor_dev: Option<&Url>) -> bool {
    es_de_la_app_en(url, servidor_dev, EN_APPLE)
}

/// La regla, con la plataforma como argumento para poder probar las dos en cualquier equipo.
fn es_de_la_app_en(url: &Url, servidor_dev: Option<&Url>, en_apple: bool) -> bool {
    let de_tauri = matches!(url.scheme(), "http" | "https")
        && url.host_str() == Some(HOST_DE_TAURI)
        && url.port().is_none();
    let de_tauri_en_apple =
        en_apple && url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none();
    de_tauri || de_tauri_en_apple || servidor_dev.is_some_and(|dev| mismo_origen(url, dev))
}

fn mismo_origen(a: &Url, b: &Url) -> bool {
    a.has_host()
        && a.scheme() == b.scheme()
        && a.host() == b.host()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Al registro va el origen y nada más: la ruta y la consulta las escribe quien intenta la
/// navegación.
fn destino_para_el_registro(url: &Url) -> String {
    match url.host_str() {
        Some(host) => format!("{}://{host}", url.scheme()),
        None => format!("{}:", url.scheme()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// La política recibe la dirección como la resuelve la webview: contra la página en la que está.
    fn desde(pagina: &str, enlace: &str) -> Url {
        Url::parse(pagina).unwrap().join(enlace).unwrap()
    }

    fn desde_la_app(enlace: &str) -> Url {
        desde("http://tauri.localhost/estadisticas", enlace)
    }

    #[test]
    fn la_ventana_solo_navega_dentro_de_la_app() {
        // Lo que la app hace de verdad: cargar, recargar y moverse por sus rutas.
        for propia in [
            "http://tauri.localhost/",
            "http://tauri.localhost/estadisticas?rango=mes#clientes",
            "https://tauri.localhost/",
            "HTTP://TAURI.LOCALHOST:80/login",
            "/login",
            "",
        ] {
            assert!(es_de_la_app(&desde_la_app(propia), None), "{propia} es de la app");
        }

        // Y lo que no: otra web, otro puerto del equipo, un host que sólo se le parece, las piezas
        // de Tauri que no son páginas y los esquemas que pintan una página sin servidor.
        for ajena in [
            "http://127.0.0.1:9/",
            "//a.example",
            "https://a.example/pin",
            "https://tauri.localhost.evil.example",
            "http://evil.example/tauri.localhost",
            "http://tauri.localhost@a.example/",
            "http://tauri.localhost:9/",
            "http://tauri.localhost./",
            "http://xtauri.localhost/",
            "http://localhost/",
            "http://localhost:1420/",
            "http://asset.localhost/C%3A/x.html",
            "http://ipc.localhost/",
            "tauri://localhost/",
            "data:text/html,<h1>PIN</h1>",
            "javascript:alert(1)",
            "about:blank",
            "file:///C:/Windows/win.ini",
            "blob:http://tauri.localhost/0b5c6f0e-0000-4000-8000-000000000000",
            "ftp://tauri.localhost/",
        ] {
            assert!(!es_de_la_app(&desde_la_app(ajena), None), "{ajena} no es de la app");
        }
    }

    /// En iOS la app se sirve desde `tauri://localhost`, y la carga inicial pasa por la política: sin
    /// admitirlo, la ventana se bloqueaba a sí misma y se quedaba en blanco. Sólo ese origen exacto.
    #[test]
    fn en_ios_la_app_se_sirve_desde_su_esquema_propio() {
        let en_ios = |pagina: &str, enlace: &str| es_de_la_app_en(&desde(pagina, enlace), None, true);
        for propia in ["", "/", "/login", "/estadisticas?rango=mes#clientes"] {
            assert!(en_ios("tauri://localhost/", propia), "{propia} es de la app en iOS");
        }
        for ajena in [
            "tauri://localhost:9/",
            "tauri://localhost.evil.example/",
            "tauri://evil.example/",
            "tauri://localhost@a.example/",
            "https://a.example/pin",
            "data:text/html,<h1>PIN</h1>",
            "about:blank",
        ] {
            assert!(!en_ios("tauri://localhost/", ajena), "{ajena} no es de la app en iOS");
        }
        // Fuera de Apple, ese esquema sigue sin ser de la app.
        assert!(!es_de_la_app_en(&Url::parse("tauri://localhost/").unwrap(), None, false));
    }

    #[test]
    fn el_servidor_de_vite_solo_es_la_app_en_desarrollo() {
        let vite = Url::parse("http://localhost:1420").unwrap();
        let recarga = desde("http://localhost:1420/mesas", "");

        assert!(es_de_la_app(&recarga, Some(&vite)));
        assert!(es_de_la_app(&desde("http://localhost:1420/", "/login"), Some(&vite)));
        // Empaquetada, la app no se sirve desde ahí.
        assert!(!es_de_la_app(&recarga, None));

        for ajena in [
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://localhost.evil.example:1420/",
            "http://127.0.0.1:1420/",
            "//a.example",
            "data:text/html,<h1>PIN</h1>",
        ] {
            assert!(!es_de_la_app(&desde("http://localhost:1420/", ajena), Some(&vite)), "{ajena} no es de la app");
        }

        // En Android el servidor de desarrollo es el del equipo que compila.
        let por_red = Url::parse("http://192.168.1.20:1420/").unwrap();
        assert!(es_de_la_app(&desde("http://192.168.1.20:1420/", "/login"), Some(&por_red)));
        assert!(!es_de_la_app(&desde("http://192.168.1.20:1420/", "http://192.168.1.21:1420/"), Some(&por_red)));
    }

    #[test]
    fn al_registro_solo_va_el_origen_del_destino() {
        let destino = Url::parse("https://a.example/pin?cliente=Ana#x").unwrap();
        assert_eq!(destino_para_el_registro(&destino), "https://a.example");
        let sin_host = Url::parse("data:text/html,<h1>PIN de Ana</h1>").unwrap();
        assert_eq!(destino_para_el_registro(&sin_host), "data:");
    }
}
