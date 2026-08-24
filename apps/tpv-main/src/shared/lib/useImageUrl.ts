// src/shared/lib/useImageUrl.ts
//
// Envoltorio de React para `resolveImageUrl`. Existe porque lo que guarda la BD (y los stores) NO
// es una URL: es una **ruta relativa** (`images/{subcarpeta}/{uuid}.jpg`), la misma en el disco de
// la Main, en la clave de R2 y en la URL del CDN de la Handy. Convertirla en algo que un `<img>`
// entienda es asíncrono (`convertFileSrc` + AppData en la Main, tenant del pairing en la Handy),
// así que hace falta estado.
//
// Sin esto, la conversión se copiaba a mano en cada pantalla… y en tres de ellas no se copió: la
// barra de título, el arranque y el login pintaban `src={rutaRelativa}`, que el webview resuelve
// contra su propio origen (`tauri://localhost/images/…`) y da un 404 silencioso. El logo salía en
// la vista previa del ticket y en Configuración, y no salía en el resto.

import { useEffect, useState } from "react";

import { resolveImageUrl } from "./imageUrl";

/**
 * Resuelve una `Ruta_Imagen` a una URL para `<img src>`. Devuelve `""` mientras resuelve o si no
 * hay imagen, para que quien la use pueda caer a su placeholder.
 */
export function useImageUrl(ruta: string | null | undefined): string {
	const [url, setUrl] = useState<string>("");

	useEffect(() => {
		let vivo = true;

		resolveImageUrl(ruta)
			.then((u) => vivo && setUrl(u))
			.catch(() => vivo && setUrl(""));

		return () => {
			vivo = false;
		};
	}, [ruta]);

	return url;
}
