import { commands } from "@tpv/client";


const MAX_IMAGEN_BYTES = 5 * 1024 * 1024;
export const FORMATOS_IMAGEN = "image/jpeg,image/png,.jpg,.jpeg,.png";

function validarImagen(file: File): void {
    if (!file.size || file.size > MAX_IMAGEN_BYTES) throw new Error("La imagen debe pesar como máximo 5 MB.");
    // AUD-30: WebP no se admite; Rust tampoco lo decodifica (`imagenes::decodificar`).
    if (!/\.(jpe?g|png)$/i.test(file.name)) throw new Error("Solo se admiten imágenes JPEG y PNG.");
}

/** RI-07: Rust detecta el formato real, reconstruye la imagen y genera su nombre. */
export async function guardarImagen(file: File, subfolder: string): Promise<{ nombre: string; ruta: string }> {
    validarImagen(file);
    const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.split(",")[1] ?? "") : reject(new Error("No se pudo leer la imagen"));
        reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
        reader.readAsDataURL(file);
    });
    const ruta = await commands.saveImage({ subfolder, base64_data: base64 });
    return { nombre: ruta.split("/").pop()!, ruta };
}
