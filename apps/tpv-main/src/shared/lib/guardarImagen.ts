import { commands } from "@tpv/client";


const MAX_IMAGEN_BYTES = 5 * 1024 * 1024;
/** El lado más largo con que se guarda una imagen: lo mismo que `imagenes::procesar` en Rust. */
const MAX_LADO = 1024;

/** El `accept` de los selectores de imagen: JPEG, PNG y WebP. */
export const ACEPTA_IMAGENES = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

function validarImagen(file: File): void {
    if (!file.size || file.size > MAX_IMAGEN_BYTES) throw new Error("La imagen debe pesar como máximo 5 MB.");
    if (!/\.(jpe?g|png|webp)$/i.test(file.name)) throw new Error("Solo se admiten imágenes JPEG, PNG y WebP.");
}

/** `RIFF····WEBP`: la cabecera de un WebP. Manda lo que hay dentro, no el nombre del fichero. */
function esWebp(bytes: Uint8Array): boolean {
    const dice = (desde: number, texto: string) => [...texto].every((c, i) => bytes[desde + i] === c.charCodeAt(0));
    return bytes.length >= 12 && dice(0, "RIFF") && dice(8, "WEBP");
}

/** Las cotas de RI-07 en `imagenes::decodificar`: 8192 px de lado y 24 Mpx. */
const MAX_LADO_ENTRADA = 8192;
const MAX_PIXELES = 24_000_000;
const NO_SE_LEE_EL_WEBP = "No se pudo leer la imagen WebP: prueba con otra o guárdala como JPEG o PNG.";

/**
 * Ancho y alto que declara la cabecera de un WebP, o `null` si no se entiende. El primer trozo dice
 * cuál de las tres es: `VP8X` (la extendida: el lienzo, 24 bits de ancho − 1 y de alto − 1), `VP8L`
 * (sin pérdida: firma 0x2f y 14 bits de cada uno, menos 1) o `VP8 ` (con pérdida: código 9d 01 2a
 * y 14 bits de cada uno). Así lo describe la RFC 9649.
 */
function dimensionesWebp(b: Uint8Array): { ancho: number; alto: number } | null {
    if (b.length < 16) return null;
    const trozo = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (trozo === "VP8X") {
        if (b.length < 30) return null;
        return { ancho: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), alto: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (trozo === "VP8L") {
        if (b.length < 25 || b[20] !== 0x2f) return null;
        const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { ancho: 1 + (v & 0x3fff), alto: 1 + ((v >>> 14) & 0x3fff) };
    }
    if (trozo === "VP8 ") {
        if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
        return { ancho: (b[26] | (b[27] << 8)) & 0x3fff, alto: (b[28] | (b[29] << 8)) & 0x3fff };
    }
    return null;
}

/**
 * Las cotas de RI-07, sobre la cabecera y antes de que la WebView reserve los píxeles: unos pocos
 * bytes pueden declarar un lienzo de 16384 × 16384, un giga decodificado. Lo mismo que hace Rust con
 * un JPEG o un PNG (`imagenes::decodificar`).
 */
function comprobarCotasWebp(bytes: Uint8Array): void {
    const d = dimensionesWebp(bytes);
    if (!d || d.ancho === 0 || d.alto === 0) throw new Error(NO_SE_LEE_EL_WEBP);
    if (d.ancho > MAX_LADO_ENTRADA || d.alto > MAX_LADO_ENTRADA || d.ancho * d.alto > MAX_PIXELES) {
        throw new Error("La imagen tiene demasiados píxeles: como mucho 8192 de lado y 24 millones en total.");
    }
}

/**
 * Convierte un WebP con el decodificador de la WebView: WebView2 (también la 109 de Windows 7), la
 * de Android y WKWebView (WebP desde iOS 14; `createImageBitmap` con un `Blob`, desde Safari 15, y
 * la app pide iOS 15). Rust no decodifica WebP (AUD-30, `imagenes::decodificar`). Sale con 1024 px
 * de lado como mucho —lo que guarda Rust—, en PNG si tiene transparencia y en JPEG si no; Rust lo
 * reconstruye después como cualquier otra (RI-07).
 */
async function webpEnLaWebView(webp: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(webp);
    try {
        const escala = Math.min(1, MAX_LADO / Math.max(bitmap.width, bitmap.height));
        const lienzo = document.createElement("canvas");
        lienzo.width = Math.max(1, Math.round(bitmap.width * escala));
        lienzo.height = Math.max(1, Math.round(bitmap.height * escala));
        const ctx = lienzo.getContext("2d");
        if (!ctx) throw new Error("sin contexto 2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, lienzo.width, lienzo.height);
        const pixeles = ctx.getImageData(0, 0, lienzo.width, lienzo.height).data;
        let transparente = false;
        for (let i = 3; i < pixeles.length; i += 4) {
            if (pixeles[i] !== 255) { transparente = true; break; }
        }
        return await new Promise<Blob>((resolve, reject) => {
            lienzo.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), transparente ? "image/png" : "image/jpeg", 0.92);
        });
    } finally {
        bitmap.close();
    }
}

function aBase64(bytes: Uint8Array): string {
    let binario = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binario);
}

/**
 * RI-07: Rust detecta el formato real, reconstruye la imagen y genera su nombre. Un WebP lo convierte
 * antes la WebView (`convertir`), así que lo guardado es siempre JPEG o PNG: lo que imprime el ticket,
 * lo que lleva el PDF de una factura y lo único que acepta el worker.
 */
export async function guardarImagen(
    file: File,
    subfolder: string,
    convertir: (webp: Blob) => Promise<Blob> = webpEnLaWebView,
): Promise<{ nombre: string; ruta: string }> {
    validarImagen(file);
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (esWebp(bytes)) {
        comprobarCotasWebp(bytes);
        let convertida: Blob;
        try {
            convertida = await convertir(file);
        } catch {
            throw new Error(NO_SE_LEE_EL_WEBP);
        }
        bytes = new Uint8Array(await convertida.arrayBuffer());
    }
    const ruta = await commands.saveImage({ subfolder, base64_data: aBase64(bytes) });
    return { nombre: ruta.split("/").pop()!, ruta };
}
