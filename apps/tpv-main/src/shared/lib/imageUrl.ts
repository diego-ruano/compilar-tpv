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
// NOTA de despliegue: las lecturas del Handy van directas a la URL pública del bucket R2
// (r2.dev), servida y cacheada por la red de Cloudflare → sin invocar el worker en cada imagen.
// La SUBIDA sigue yendo firmada por el worker (PUT /v1/images). Si en el futuro conectas un
// dominio propio al bucket, basta con cambiar `CDN_IMAGES_BASE` por ese dominio.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";

import { useMode } from "../stores/useMode";

/**
 * Base pública desde la que el Handy carga las imágenes: la URL r2.dev del bucket.
 * La clave del objeto en R2 es `{tenant}/images/{subcarpeta}/{archivo}`, así que la URL
 * final queda `{CDN_IMAGES_BASE}/{tenant}/{Ruta_Imagen}`.
 */
export const CDN_IMAGES_BASE =
  "https://pub-6814391221e444b8b1747ab67ce3c21f.r2.dev";

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

  // Main: fichero local en AppData. Si falta (imagen creada en otra Handy: la fila llegó por
  // sync, pero el binario solo vive en R2), se baja de R2 a disco de forma perezosa. Es
  // best-effort: si no se puede (offline / aún no subida), seguimos y el <img> hará fallback.
  try {
    await invoke<boolean>("images_ensure_local", { args: { rel_path: r } });
  } catch {
    /* ignorado: el UI degrada al placeholder y reintenta en la próxima recarga */
  }

  const baseDir = await appDataDir();
  return convertFileSrc(await join(baseDir, r));
}

/**
 * Dispara (fire-and-forget) el drenado de la cola de imágenes pendientes de subir a R2.
 * Se llama tras guardar una imagen; en la Main online el WebSocket además lo reintenta.
 */
export function triggerImageUploadDrain(): void {
  invoke<string>("images_drain_pending")
    .then((r) => {
      if (r && r !== "vacio" && r !== "sin_modo") {
        if (r.includes("error=")) {
          console.warn("[images_drain]", r);
        } else {
          console.log("[images_drain]", r);
        }
      }
    })
    .catch((e) => console.error("[images_drain] Tauri error:", e));
}
