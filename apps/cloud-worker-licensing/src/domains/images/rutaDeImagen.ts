// src/domains/images/rutaDeImagen.ts
//
// OBS-06 · La ruta de una imagen: `images/{carpeta}/{uuid}.{ext}`, con una carpeta de la lista
// cerrada y por nombre el UUID que le pone la app al guardarla (`save_image`). Es lo que viaja en el
// camino de `/v1/images/…`, que es lo que carga la Handy (INFRA-03), y Cloudflare
// guarda la URL de cada petición: un nombre que alguien le diera al fichero puede ser el de una
// persona. Las imágenes heredadas, guardadas antes con su nombre, las renombra la Main antes de
// subir nada (`images_backfill`). Evita también el path traversal y las claves arbitrarias en el
// bucket.
//
// Admite exactamente lo mismo que la Main (`imagenes::ruta_segura`) y la Handy (`imageUrl.ts`): el
// prefijo y la carpeta en minúsculas, y el UUID y la extensión en cualquier caja. Una carpeta en
// mayúsculas que pasara aquí la rechazaría la Main al bajarla o al imprimir el logo.
//
// Va aparte de `images.routes.ts` para que la lea `test/sinDatosPersonalesEnLaQuery.node.test.ts`,
// que corre en Node.

import { recortar } from "../../lib/texto";

export const RUTA_DE_IMAGEN =
	/^images\/(productos|categorias|proveedores|alergenos|logo)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.([jJ][pP][eE]?[gG]|[pP][nN][gG])$/;

/**
 * AUD-31 · Lo que dice quien guarda una imagen que no tiene esa forma: el mismo texto en la Main
 * (`tpv_domain::imagenes::MSG_IMAGEN_NO_VALIDA`), con su caso en `validacion_casos.json`.
 */
export const MSG_IMAGEN_NO_VALIDA = "La imagen no es válida: vuelve a elegirla.";

/**
 * AUD-31 · ¿Se puede guardar este valor en una columna de imagen (`Ruta_Imagen`, `Logo_DataUrl`)?
 * Vacío (sin imagen) o, recortado, una ruta con la forma de `RUTA_DE_IMAGEN`. Ni un `data:`, ni una
 * URL, ni una ruta de otra carpeta: el valor se replica y lo pinta cada equipo del negocio, también
 * en la pantalla de entrada, y lo que no sale de `save_image` no se pinta (`imageUrl.ts`). Lo mismo
 * que la Main (`tpv_domain::imagenes::validar_ruta_imagen`).
 */
export function esImagenGuardable(valor: string | null | undefined): boolean {
	const r = recortar(valor ?? "");
	return r === "" || RUTA_DE_IMAGEN.test(r);
}
