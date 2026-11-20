import { commands } from "@tpv/client";
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

import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";

import { useMode } from "../stores/useMode";
import { captureException } from "../observability/sentry";

/**
 * Base pública desde la que el Handy carga las imágenes: la URL r2.dev del bucket.
 * La clave del objeto en R2 es `{tenant}/images/{subcarpeta}/{archivo}`, así que la URL
 * final queda `{CDN_IMAGES_BASE}/{tenant}/{Ruta_Imagen}`.
 */
export const CDN_IMAGES_BASE =
  "https://pub-6814391221e444b8b1747ab67ce3c21f.r2.dev";

// El tenant del Handy no cambia en una sesión: lo resolvemos una vez y lo cacheamos.
let handyTenantPromise: Promise<string> | null = null;

// Caché de URLs resueltas (por `Ruta_Imagen`). Una `Ruta_Imagen` (uuid en el nombre) es inmutable:
// al reemplazar la imagen de un producto/categoría cambia el nombre del fichero, así que cambia la
// clave y la entrada vieja simplemente queda huérfana (inocua). Cachear aquí evita:
//   - reinvocar `images_ensure_local` (un IPC a Rust) en cada refetch de TanStack Query, y
//   - devolver URLs distintas para la misma imagen, lo que rompería el cacheo del webview/CDN.
// En modo Main solo se cachea cuando el fichero YA está en disco (ensure_local => true); si aún no
// está (creada en otra Handy, pendiente de bajar de R2) NO se cachea, para reintentar la bajada en
// la siguiente resolución.
const urlCache = new Map<string, string>();
let contexto = 0;

/** Al cambiar de modo o negocio las mismas rutas relativas ya no identifican las mismas URLs. */
export function limpiarCacheImagenes(): void {
  contexto++;
  handyTenantPromise = null;
  urlCache.clear();
}

async function getHandyTenant(): Promise<string> {
  if (!handyTenantPromise) {
    handyTenantPromise = commands.handyGetTenant()
      .then((t) => String(t ?? "").trim())
      .catch(() => "");
  }
  return handyTenantPromise;
}

/**
 * OBS-06: una imagen guardada por la app, `images/{carpeta}/{uuid}.{ext}`. Su ruta viaja en la URL
 * pública de `r2.dev`, y Cloudflare la guarda: la Handy no pide una cuyo nombre no sea el UUID que le
 * pone la app (una heredada que la Main no ha podido renombrar, con el nombre que alguien le dio).
 * Lo mismo que piden la Main (`imagenes::ruta_segura`) y el worker (`RUTA_DE_IMAGEN`): el prefijo y la
 * carpeta en minúsculas, y el UUID y la extensión en cualquier caja.
 */
const RUTA_DE_IMAGEN =
  /^images\/(productos|categorias|proveedores|alergenos|logo)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.([jJ][pP][eE]?[gG]|[pP][nN][gG]|[wW][eE][bB][pP])$/;

/**
 * AUD-31: un icono de alérgeno de la propia app (`public/alergenos/`), la única imagen que no es una
 * ruta de `save_image`: la ponen las filas de `Alergenos` que trae el esquema.
 */
const ICONO_DE_ALERGENO = /^\/alergenos\/[a-z0-9_]+\.png$/;

/**
 * Resuelve una `Ruta_Imagen` (relativa) a una URL utilizable para `<img src>`. Cadena vacía → "".
 * Un icono de alérgeno de la propia aplicación (`/alergenos/…`, `public/`) se devuelve tal cual, en la
 * Main y en la Handy.
 *
 * AUD-31: **sólo se pinta lo que tiene la forma que genera la app.** El valor llega replicado (el
 * logo, la imagen de un producto) y lo puede escribir quien tenga las credenciales de una Handy;
 * se pinta en cada equipo y en cada arranque, también en la pantalla de entrada. Un `data:`, una URL
 * o la ruta de otro fichero dan "", que es el marcador neutro: el `<img>` no se pinta o pinta el
 * suyo. En la Main, además, lo que Rust no confirma en disco (`images_ensure_local`, que también
 * pasa por RI-07 lo que baja de R2) da "".
 */
export async function resolveImageUrl(
  ruta: string | null | undefined,
): Promise<string> {
  const vigente = contexto;
  const r = String(ruta ?? "").trim();
  if (!r) return "";
  if (ICONO_DE_ALERGENO.test(r)) return r;
  if (!RUTA_DE_IMAGEN.test(r)) return "";

  const cached = urlCache.get(r);
  if (cached) return cached;

  if (useMode.getState().mode === "handy") {
    const tenant = await getHandyTenant();
    if (!tenant || vigente !== contexto) return "";
    const url = `${CDN_IMAGES_BASE}/${tenant}/${r}`;
    urlCache.set(r, url);
    return url;
  }

  // Main: fichero local en AppData. Si falta (imagen creada en otra Handy: la fila llegó por
  // sync, pero el binario solo vive en R2), se baja de R2 a disco de forma perezosa. Es
  // best-effort: si no se puede (offline / aún no subida / no pasa RI-07), "" y el <img> degrada
  // al marcador; la próxima resolución lo vuelve a intentar.
  let present = false;
  try {
    present = await commands.imagesEnsureLocal({ rel_path: r });
  } catch {
    /* ignorado: el UI degrada al placeholder y reintenta en la próxima recarga */
  }
  // AUD-31: sin el fichero en disco no hay URL. Antes salía la del protocolo `asset:` igualmente,
  // también la de una ruta que Rust había rechazado.
  if (!present) return "";

  // HIG-04: esta función se promete best-effort, y la mayoría de quien la llama la espera dentro de
  // un `void (async () => …)()` sin `catch`. Si resolver la carpeta de AppData fallara, la promesa
  // rechazada se perdía y con ella la lista entera que se estaba pintando (proveedores, alérgenos),
  // no sólo la imagen. Una imagen que no se puede resolver es "": el <img> ya sabe degradar.
  let url: string;
  try {
    url = convertFileSrc(await join(await appDataDir(), r));
  } catch {
    return "";
  }
  // Sólo se llega aquí con el fichero ya en disco: si aún no estaba, no se ha memoizado nada y la
  // próxima resolución vuelve a intentar `images_ensure_local` (bajada de R2).
  if (vigente !== contexto) return "";
  urlCache.set(r, url);
  return url;
}

/**
 * Dispara (fire-and-forget) el drenado de la cola de imágenes pendientes de subir a R2.
 * Se llama tras guardar una imagen; en la Main online el WebSocket además lo reintenta.
 */
export function triggerImageUploadDrain(): void {
  commands.imagesDrainPending()
    .catch((e: unknown) => {
      captureException(e, { fase: "images_drain_pending" });
    });
}
