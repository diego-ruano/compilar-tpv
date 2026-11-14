// src/domains/images/rutaDeImagen.ts
//
// OBS-06 · La ruta de una imagen: `images/{carpeta}/{uuid}.{ext}`, con una carpeta de la lista
// cerrada y por nombre el UUID que le pone la app al guardarla (`save_image`). Es lo que viaja en el
// camino de `/v1/images/…` y en la dirección pública de `r2.dev` que carga la Handy, y Cloudflare
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

export const RUTA_DE_IMAGEN =
	/^images\/(productos|categorias|proveedores|alergenos|logo)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.([jJ][pP][eE]?[gG]|[pP][nN][gG]|[wW][eE][bB][pP])$/;
