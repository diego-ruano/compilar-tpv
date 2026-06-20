// src/shared/lib/imageUrl.ts
//
// Resolución ÚNICA de URLs de imagen para toda la app. Según el modo del dispositivo la imagen
// se obtiene de un sitio u otro:
//
//   - Main (tpv):  fichero LOCAL en AppData (`convertFileSrc`). Funciona offline y es instantáneo
//                  (la Main es quien crea/posee las imágenes).
//   - Handy:       URL del bucket R2 servida por el worker tras el CDN de Cloudflare (cacheada en
//                  el edge). La `Ruta_Imagen` de BD se compone verbatim: `{CDN}/{tenant}/{ruta}`.
//
// La `Ruta_Imagen` que guarda la BD es siempre relativa (`images/{subcarpeta}/{uuid}.jpg`) y se
// usa idéntica en los tres lados (disco local, clave R2 y URL del CDN).
//
// NOTA de despliegue: por defecto las lecturas del Handy van al endpoint del worker
// (`/v1/images`), que ya cachea en el edge con la Cache API. Si en el futuro conectas un dominio
// propio al bucket R2 (R2 → Custom Domain), basta con apuntar `CDN_IMAGES_BASE` a ese dominio
// para servir 100% desde el CDN sin invocar el worker.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";

import { useMode } from "../stores/useMode";

/** Base pública desde la que el Handy carga las imágenes (worker + CDN edge). */
export const CDN_IMAGES_BASE =
  "https://tpv-api.altarialights.workers.dev/v1/images";

// El tenant del Handy no cambia en una sesión: lo resolvemos una vez y lo cacheamos.
let handyTenantPromise: Promise<string> | null = null;

async function getHandyTenant(): Promise<string> {
  if (!handyTenantPromise) {
    handyTenantPromise = invoke<string | null>("handy_get_tenant")
      .then((t) => String(t ?? "").trim())
      .catch(() => "");
  }
  return handyTenantPromise;
}

function isAbsoluteUrl(u: string): boolean {
  return /^(https?:|asset:|tauri:|blob:|data:)/i.test(u);
}

/**
 * Resuelve una `Ruta_Imagen` (relativa) a una URL utilizable para `<img src>`.
 * Si ya viene como URL absoluta, la devuelve tal cual. Cadena vacía → "".
 */
export async function resolveImageUrl(
  ruta: string | null | undefined,
): Promise<string> {
  const r = String(ruta ?? "").trim();
  if (!r) return "";
  if (isAbsoluteUrl(r)) return r;

  if (useMode.getState().mode === "handy") {
    const tenant = await getHandyTenant();
    if (!tenant) return "";
    return `${CDN_IMAGES_BASE}/${tenant}/${r}`;
  }

  // Main: fichero local en AppData.
  const baseDir = await appDataDir();
  return convertFileSrc(await join(baseDir, r));
}

/**
 * Dispara (fire-and-forget) el drenado de la cola de imágenes pendientes de subir a R2.
 * Se llama tras guardar una imagen; en la Main online el WebSocket además lo reintenta.
 */
export function triggerImageUploadDrain(): void {
  void invoke("images_drain_pending").catch(() => {
    /* offline o sin modo: se reintentará luego */
  });
}
