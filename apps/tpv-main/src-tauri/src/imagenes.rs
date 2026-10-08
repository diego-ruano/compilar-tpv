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

pub fn ruta_segura(rel: &str) -> bool {
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
    matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "webp")
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

pub fn procesar(bytes: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES { return Err("La imagen debe pesar como máximo 5 MB".into()); }
    let formato = image::guess_format(bytes).map_err(|_| "Imagen no válida")?;
    let extension = match formato {
        ImageFormat::Jpeg => "jpg", ImageFormat::Png => "png", ImageFormat::WebP => "webp",
        _ => return Err("Solo se admiten JPEG, PNG y WebP".into()),
    };
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
    fn rechaza_rutas_absolutas_traversal_y_nombres_especiales() {
        for rel in ["images/../data.db", "images/logo/../a.jpg", "images/logo/C:/a.jpg", "images/logo/a.jpg:datos", "images/logo/CON.jpg", "images/logo/a.svg", "images/logo/a.jpg/otro"] { assert!(!ruta_segura(rel), "{rel}"); }
        for ext in ["jpg", "jpeg", "png", "webp"] { assert!(ruta_segura(&format!("images/logo/a.{ext}"))); }
    }
    #[test]
    fn conserva_formato_y_transparencia_sin_bytes_anadidos() {
        for formato in [ImageFormat::Jpeg, ImageFormat::Png, ImageFormat::WebP] {
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
}
