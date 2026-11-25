//! RI-07: imágenes raster reconstruidas, con rutas y recursos acotados.
use std::{fs, io::Cursor, path::{Component, Path, PathBuf}};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};

pub const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_LADO_ENTRADA: u32 = 8192;
const MAX_PIXELES: u64 = 24_000_000;
const MAX_MEMORIA: u64 = 128 * 1024 * 1024;

/// RI-67: un archivo antiguo o alterado no debe ocupar memoria sin límite antes del 413.
pub fn leer_para_subida(ruta: &Path) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;
    let fichero = fs::File::open(ruta)?;
    let mut bytes = Vec::new();
    fichero.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= MAX_BYTES).then_some(bytes))
}

/// AUD-28 — una imagen tal como se nombra en lo que sale del equipo (avisos y errores, que llegan
/// a Axiom y a Sentry). La carpeta y el nombre, si el nombre es el UUID que le pone la app; si no
/// (una imagen heredada, guardada con el nombre que alguien le dio), sólo la carpeta y la extensión:
/// ese nombre puede ser el de una persona. Nunca la ruta de AppData.
pub fn para_registro(rel: &str) -> String {
    if ruta_segura(rel) {
        return rel.to_string();
    }
    if !con_forma_de_imagen(rel) {
        return "(ruta no válida)".to_string();
    }
    let partes: Vec<_> = rel.split('/').collect();
    let ext = partes[2].rsplit_once('.').map_or("", |(_, ext)| ext);
    format!("images/{}/(nombre propio).{}", partes[1], ext)
}

/// OBS-06 · Una imagen guardada por la app: `images/{carpeta}/{uuid}.{ext}`. Es lo único que se
/// sube, se baja, se borra o se lee del disco. Su ruta viaja en la URL (`/v1/images/…`, también la
/// que carga la Handy), y Cloudflare guarda la URL de cada petición:
/// el nombre que alguien le diera al fichero puede ser el de una persona. Las heredadas las renombra
/// antes `images_backfill` (`nombre_opaco`). El worker pide lo mismo (`RUTA_DE_IMAGEN`, en
/// `domains/images/rutaDeImagen.ts`).
pub fn ruta_segura(rel: &str) -> bool {
    con_forma_de_imagen(rel)
        && rel.rsplit('/').next().and_then(|nombre| nombre.rsplit_once('.')).is_some_and(|(base, _)| es_uuid(base))
}

/// OBS-06 · El nombre opaco que le toca a una imagen heredada: la misma carpeta, un UUID nuevo y su
/// extensión en minúsculas. `None` si ya lo tiene, o si la ruta no tiene forma de imagen.
pub fn nombre_opaco(rel: &str) -> Option<String> {
    if ruta_segura(rel) || !con_forma_de_imagen(rel) {
        return None;
    }
    let (carpeta, nombre) = rel.rsplit_once('/')?;
    let (_, ext) = nombre.rsplit_once('.')?;
    Some(format!("{carpeta}/{}.{}", uuid::Uuid::new_v4(), ext.to_ascii_lowercase()))
}

/// El nombre que le pone la app a una imagen (`Uuid::new_v4`, con guiones): 8-4-4-4-12 cifras
/// hexadecimales.
fn es_uuid(base: &str) -> bool {
    base.len() == 36
        && base.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() })
}

/// La forma de una imagen guardada, sin mirar su nombre: `images/{carpeta}/{nombre}.{ext}`, con una
/// carpeta de la lista, un nombre de letras, cifras, punto, guion y guion bajo que no es un
/// dispositivo de Windows, y una extensión de imagen. La tienen también las heredadas.
fn con_forma_de_imagen(rel: &str) -> bool {
    let partes: Vec<_> = rel.split('/').collect();
    if partes.len() != 3 || partes[0] != "images" || !matches!(partes[1], "productos" | "categorias" | "proveedores" | "alergenos" | "logo") { return false; }
    let nombre = partes[2];
    if nombre.len() > 160 || nombre.contains("..") || !nombre.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        || !nombre.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        || !Path::new(rel).components().all(|c| matches!(c, Component::Normal(_))) { return false; }
    let Some((base, ext)) = nombre.rsplit_once('.') else { return false; };
    let dispositivo = base.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(dispositivo.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (dispositivo.len() == 4 && (dispositivo.starts_with("COM") || dispositivo.starts_with("LPT"))
            && dispositivo.as_bytes()[3].is_ascii_digit()) { return false; }
    matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png")
}

pub fn destino(app_data: &Path, rel: &str, crear: bool) -> Result<PathBuf, String> {
    if !ruta_segura(rel) { return Err("Ruta de imagen no válida".into()); }
    let raiz_app = app_data.canonicalize().map_err(|e| e.to_string())?;
    let partes: Vec<_> = rel.split('/').collect();
    let raiz = raiz_app.join("images");
    let carpeta = raiz.join(partes[1]);
    for dir in [&raiz, &carpeta] {
        if dir.exists() {
            if !dir.canonicalize().map_err(|e| e.to_string())?.starts_with(&raiz) { return Err("La carpeta de imágenes sale de su ubicación permitida".into()); }
        } else if crear { fs::create_dir(dir).map_err(|e| e.to_string())?; }
    }
    let archivo = carpeta.join(partes[2]);
    if archivo.exists() && !archivo.canonicalize().map_err(|e| e.to_string())?.starts_with(&raiz) { return Err("La imagen sale de su ubicación permitida".into()); }
    Ok(archivo)
}

/// Decodifica una imagen con las cotas de RI-07: 5 MB, JPEG o PNG, 8192 px de lado, 24 Mpx y
/// 128 MiB de imagen decodificada. Se comprueban con la cabecera, antes de reservar los píxeles,
/// así que una imagen que declara más se rechaza sin ocupar memoria.
///
/// AUD-30: por aquí pasa toda imagen que decodifica Rust, la que se guarda (`procesar`) y la que
/// se imprime (`printing::rasterizar_logo`). El logo llega replicado: que la interfaz sólo guarde
/// imágenes ya reconstruidas no dice nada de lo que hay en `Logo_DataUrl`.
///
/// WebP no se admite, y `image` se compila sin él. Su decodificador reserva lo que declara el
/// fichero antes de comprobarlo —el tamaño de un trozo EXIF que no está, los planos de un VP8 más
/// grande que el lienzo, una tabla por cada grupo de códigos de un VP8L— e `image` no le pasa
/// ningún límite: con unos bytes pedía gigas, dentro de todas las cotas de arriba. Los de PNG y
/// JPEG reservan según los bytes que hay o según las dimensiones ya comprobadas, y el perfil de
/// color de un PNG, que va comprimido, no pasa de `max_alloc`.
///
/// Quien elige un WebP en la pantalla lo puede guardar: lo convierte antes la WebView, con su propio
/// decodificador, a JPEG o PNG (`shared/lib/guardarImagen.ts`), así que lo guardado es siempre JPEG
/// o PNG. El mensaje de rechazo nombra los tres porque es lo que la persona puede elegir.
pub fn decodificar(bytes: &[u8]) -> Result<(DynamicImage, ImageFormat), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES { return Err("La imagen debe pesar como máximo 5 MB".into()); }
    let formato = image::guess_format(bytes).map_err(|_| "Imagen no válida")?;
    if !matches!(formato, ImageFormat::Jpeg | ImageFormat::Png) { return Err("Solo se admiten imágenes JPEG, PNG y WebP.".into()); }
    let mut lector = ImageReader::with_format(Cursor::new(bytes), formato);
    let mut limites = Limits::default();
    limites.max_image_width = Some(MAX_LADO_ENTRADA);
    limites.max_image_height = Some(MAX_LADO_ENTRADA);
    limites.max_alloc = Some(MAX_MEMORIA);
    lector.limits(limites);
    let mut decoder = lector.into_decoder().map_err(|e| format!("Imagen no válida: {e}"))?;
    let (ancho, alto) = decoder.dimensions();
    if u64::from(ancho) * u64::from(alto) > MAX_PIXELES || decoder.total_bytes() > MAX_MEMORIA { return Err("La imagen tiene demasiados píxeles".into()); }
    let orientacion = decoder.orientation().map_err(|e| e.to_string())?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| format!("Imagen no válida: {e}"))?;
    img.apply_orientation(orientacion);
    Ok((img, formato))
}

pub fn procesar(bytes: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    let (mut img, formato) = decodificar(bytes)?;
    let extension = if formato == ImageFormat::Jpeg { "jpg" } else { "png" };
    if img.width() > 1024 || img.height() > 1024 { img = img.resize(1024, 1024, FilterType::Lanczos3); }
    // Solo se codifican píxeles: no se trasladan metadatos ni bytes añadidos al original.
    let mut out = Cursor::new(Vec::new());
    if formato == ImageFormat::Jpeg {
        DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(JpegEncoder::new_with_quality(&mut out, 80))
    } else {
        DynamicImage::ImageRgba8(img.to_rgba8()).write_to(&mut out, formato)
    }.map_err(|e| format!("No se ha podido reconstruir la imagen: {e}"))?;
    if out.get_ref().len() > MAX_BYTES { return Err("La imagen procesada supera 5 MB".into()); }
    Ok((out.into_inner(), extension))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subida_lee_como_maximo_el_limite_y_detecta_un_archivo_grande() {
        let ruta = std::env::temp_dir().join(format!("tpv-imagen-{}", uuid::Uuid::new_v4()));
        fs::File::create(&ruta).unwrap().set_len((MAX_BYTES + 1) as u64).unwrap();
        assert!(leer_para_subida(&ruta).unwrap().is_none());
        fs::write(&ruta, b"imagen").unwrap();
        assert_eq!(leer_para_subida(&ruta).unwrap().unwrap(), b"imagen");
        fs::remove_file(ruta).unwrap();
    }
    #[test]
    fn lo_que_sale_del_equipo_no_lleva_el_nombre_que_alguien_le_dio_a_una_imagen() {
        let uuid = "0190f3a1-7b2c-7d4e-8f00-123456789abc";
        assert_eq!(para_registro(&format!("images/productos/{uuid}.jpg")), format!("images/productos/{uuid}.jpg"));
        assert_eq!(para_registro("images/logo/Tarta-de-Ana-Prueba.png"), "images/logo/(nombre propio).png");
        assert_eq!(para_registro("images/../C:/Users/ana/AppData/data.db"), "(ruta no válida)");
    }
    #[test]
    fn rechaza_rutas_absolutas_traversal_y_nombres_especiales() {
        for rel in ["images/../data.db", "images/logo/../a.jpg", "images/logo/C:/a.jpg", "images/logo/a.jpg:datos", "images/logo/CON.jpg", "images/logo/a.svg", "images/logo/a.jpg/otro"] { assert!(!ruta_segura(rel), "{rel}"); }
        let uuid = "0190f3a1-7b2c-4d4e-8f00-123456789abc";
        for ext in ["jpg", "jpeg", "png", "JPG"] { assert!(ruta_segura(&format!("images/logo/{uuid}.{ext}"))); }
        for rel in [format!("images/logo/{uuid}.webp"), format!("images/logo/{uuid}.svg"), format!("images/otra/{uuid}.jpg"), format!("images/logo/../{uuid}.jpg"), format!("images/LOGO/{uuid}.jpg"), format!("IMAGES/logo/{uuid}.jpg")] { assert!(!ruta_segura(&rel), "{rel}"); }
    }

    // OBS-06: el nombre de una imagen viaja en la URL; sólo se admite el UUID que le pone la app. Los
    // mismos casos que `RUTA_DE_IMAGEN` en el worker (`sinDatosPersonalesEnLaQuery.node.test.ts`).
    #[test]
    fn solo_admite_un_uuid_por_nombre() {
        let uuid = "0190f3a1-7b2c-4d4e-8f00-123456789abc";
        assert!(ruta_segura(&format!("images/productos/{}.jpg", uuid.to_uppercase())));
        for nombre in [
            "Juan-Perez.jpg".to_string(),
            "tarta_de_ana.png".to_string(),
            format!("{}.jpg", uuid.replace('-', "")),
            format!("{uuid}x.jpg"),
            format!("x{uuid}.jpg"),
            format!("{uuid}.jpg.jpg"),
            uuid.to_string(),
        ] {
            assert!(!ruta_segura(&format!("images/productos/{nombre}")), "{nombre}");
        }
        // Y lo que guarda la app, siempre.
        assert!(ruta_segura(&format!("images/productos/{}.jpg", uuid::Uuid::new_v4())));
    }

    #[test]
    fn una_heredada_recibe_un_uuid_con_su_extension_y_la_carpeta_de_antes() {
        let opaco = nombre_opaco("images/proveedores/Juan-Perez.JPG").unwrap();
        assert!(ruta_segura(&opaco), "{opaco}");
        assert!(opaco.starts_with("images/proveedores/") && opaco.ends_with(".jpg"), "{opaco}");
        assert!(!opaco.contains("Juan"));
        assert_ne!(nombre_opaco("images/proveedores/Juan-Perez.JPG").unwrap(), opaco);
        // Una que ya es opaca, o una ruta que no es de imagen, no se toca.
        assert_eq!(nombre_opaco(&opaco), None);
        for rel in ["images/../data.db", "images/logo/CON.jpg", "images/logo/a.svg", "otra/cosa.jpg"] {
            assert_eq!(nombre_opaco(rel), None, "{rel}");
        }
    }
    #[test]
    fn conserva_formato_y_transparencia_sin_bytes_anadidos() {
        for formato in [ImageFormat::Jpeg, ImageFormat::Png] {
            let mut original = Cursor::new(Vec::new());
            let img = if formato == ImageFormat::Jpeg { DynamicImage::new_rgb8(2, 2) } else { DynamicImage::new_rgba8(2, 2) };
            img.write_to(&mut original, formato).unwrap();
            original.get_mut().extend_from_slice(b"contenido_ajeno_a_la_imagen");
            let (salida, _) = procesar(original.get_ref()).unwrap();
            assert_eq!(image::guess_format(&salida).unwrap(), formato);
            assert!(!salida.windows(b"contenido_ajeno_a_la_imagen".len()).any(|s| s == b"contenido_ajeno_a_la_imagen"));
            if formato != ImageFormat::Jpeg { assert_eq!(image::load_from_memory(&salida).unwrap().to_rgba8().get_pixel(0, 0)[3], 0); }
        }
    }
    #[test]
    fn rechaza_archivos_grandes_y_dimensiones_excesivas() {
        assert!(procesar(&vec![0; MAX_BYTES + 1]).is_err());
        let img = DynamicImage::new_rgba8(8193, 1);
        let mut original = Cursor::new(Vec::new());
        img.write_to(&mut original, ImageFormat::Png).unwrap();
        assert!(procesar(original.get_ref()).is_err());
        assert!(procesar(b"<svg><script/></svg>").is_err());
    }
    #[test]
    fn no_admite_webp_aunque_sea_valido() {
        // AUD-30: un WebP sin pérdida de 1×1, correcto. Lo que no se admite es el formato: el que
        // se elige en la pantalla llega aquí ya convertido por la WebView (`guardarImagen.ts`).
        let webp = b"RIFF\x1a\0\0\0WEBPVP8L\x0d\0\0\0\x2f\0\0\0\x10\x07\x10\x11\x11\x88\x88\xfe\x07\0";
        assert_eq!(image::guess_format(webp).unwrap(), ImageFormat::WebP);
        assert_eq!(procesar(webp).unwrap_err(), "Solo se admiten imágenes JPEG, PNG y WebP.");
    }
}
