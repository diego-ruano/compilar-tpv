//! AUD-31 · La forma de una imagen guardada en una fila del negocio (`Ruta_Imagen` de productos,
//! categorías y proveedores; `Logo_DataUrl` del negocio).
//!
//! El valor se replica y lo pinta cada equipo del negocio, también en la pantalla de entrada, así
//! que sólo se guarda lo que genera la app al guardar una imagen (`save_image`):
//! `images/{carpeta}/{uuid}.{ext}`. Ni un `data:`, ni una URL, ni la ruta de otro fichero. La
//! pantalla, además, no pinta otra cosa (`shared/lib/imageUrl.ts`). El worker pide lo mismo
//! (`domains/images/rutaDeImagen.ts`, `esImagenGuardable`) y los dos lados leen los mismos casos
//! (`validacion_casos.json`).
//!
//! Es la forma de `imagenes::ruta_segura` (en la crate de Tauri) y de `RUTA_DE_IMAGEN` del worker: el
//! prefijo y la carpeta en minúsculas, y el UUID y la extensión en cualquier caja.

use crate::texto::limpiar_opcional;

/// Lo que se le dice a quien guarda una imagen que no tiene esa forma. El mismo texto en el worker.
pub const MSG_IMAGEN_NO_VALIDA: &str = "La imagen no es válida: vuelve a elegirla.";

const CARPETAS: [&str; 5] = ["productos", "categorias", "proveedores", "alergenos", "logo"];

/// `images/{carpeta}/{uuid}.{jpg|jpeg|png}`, con el UUID de 8-4-4-4-12 cifras hexadecimales.
pub fn es_ruta_de_imagen(ruta: &str) -> bool {
    let partes: Vec<&str> = ruta.split('/').collect();
    let [raiz, carpeta, nombre] = partes.as_slice() else { return false };
    if *raiz != "images" || !CARPETAS.contains(carpeta) {
        return false;
    }
    let Some((base, ext)) = nombre.split_once('.') else { return false };
    let uuid = base.len() == 36
        && base
            .bytes()
            .enumerate()
            .all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() });
    uuid && matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png")
}

/// La imagen de una fila: recortada, vacía es «sin imagen» (`None`), y si no, con la forma de
/// [`es_ruta_de_imagen`] o se rechaza con [`MSG_IMAGEN_NO_VALIDA`].
pub fn validar_ruta_imagen(ruta: Option<String>) -> Result<Option<String>, String> {
    match limpiar_opcional(ruta) {
        Some(r) if !es_ruta_de_imagen(&r) => Err(MSG_IMAGEN_NO_VALIDA.into()),
        r => Ok(r),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "0190f3a1-7b2c-4d4e-8f00-123456789abc";

    #[test]
    fn admite_lo_que_guarda_la_app_y_nada_mas() {
        for carpeta in CARPETAS {
            for ext in ["jpg", "jpeg", "png", "JPG", "Png"] {
                assert!(es_ruta_de_imagen(&format!("images/{carpeta}/{UUID}.{ext}")), "{carpeta} {ext}");
            }
        }
        assert!(es_ruta_de_imagen(&format!("images/logo/{}.png", UUID.to_uppercase())));
        for ruta in [
            "data:image/png;base64,AAAA".to_string(),
            "https://example.invalid/x.png".into(),
            "//example.invalid/x.png".into(),
            "http://asset.localhost/x.png".into(),
            "data.db".into(),
            "/alergenos/gluten.png".into(),
            "images/foto.jpg".into(),
            "images/proveedores/Juan-Perez.jpg".into(),
            format!("images/LOGO/{UUID}.png"),
            format!("IMAGES/logo/{UUID}.png"),
            format!("images/otra/{UUID}.png"),
            format!("images/logo/{UUID}.svg"),
            // M-081: lo guardado es siempre JPEG o PNG.
            format!("images/logo/{UUID}.webp"),
            format!("images/logo/{UUID}.png.png"),
            format!("images/logo/../{UUID}.png"),
            format!("/images/logo/{UUID}.png"),
            format!("images/logo/{UUID}"),
        ] {
            assert!(!es_ruta_de_imagen(&ruta), "{ruta}");
        }
    }

    #[test]
    fn vacio_es_sin_imagen_y_lo_demas_se_rechaza_con_su_mensaje() {
        assert_eq!(validar_ruta_imagen(None), Ok(None));
        assert_eq!(validar_ruta_imagen(Some("  ".into())), Ok(None));
        let ruta = format!("images/productos/{UUID}.jpg");
        assert_eq!(validar_ruta_imagen(Some(format!(" {ruta} "))), Ok(Some(ruta)));
        assert_eq!(validar_ruta_imagen(Some("data:image/png;base64,AAAA".into())), Err(MSG_IMAGEN_NO_VALIDA.to_string()));
    }
}
