// src/shared/ui/ImageWithFallback.tsx
//
// <img> con manejo elegante de errores, pensado para el Handy: la fila de un producto puede
// llegar por WebSocket ANTES de que su imagen esté en el bucket (la subida va por otro canal y
// puede tardar segundos, o minutos si la Main estaba offline). La Handy la pide al GET público del
// worker (`imageUrl.ts`, INFRA-03).
//
// Comportamiento:
//   - Sin `src` o tras agotar reintentos → muestra `fallback` (placeholder estético del caller).
//   - Mientras carga / reintenta → la imagen está oculta (transparente), nunca un placeholder de
//     "Cargando…" ni una imagen rota. En modo Main las imágenes están en disco y aparecen al
//     instante; en el Handy aparecen en cuanto el worker responde.
//   - Ante un error (p. ej. 404 porque aún no se ha subido) reintenta el MISMO URL con un pequeño
//     retardo (sin cache-busting: la caché que ahorra peticiones es la de la webview, y sólo
//     funciona si la misma imagen da siempre el mismo URL).
//   - INFRA-03: agotados esos reintentos, pinta el `fallback` y hace UNO más pasado el minuto
//     (`ULTIMO_REINTENTO_MS`). Un `<img>` no ve el código de la respuesta, y el 429 del filtro por
//     IP del worker pide volver dentro de 60 s (`Retry-After`): los reintentos rápidos caen todos
//     dentro de esa ventana, así que sin éste una imagen frenada se quedaba en el marcador hasta
//     remontar la pantalla.
//
// IMPORTANTE (bug de imágenes cacheadas): un <img> cuyo fichero ya está en la caché del webview
// —lo normal con ficheros LOCALES en modo Main, que cargan al instante— puede quedar marcado como
// `complete` ANTES de que React monte el handler `onLoad`. Ese evento entonces nunca dispara y la
// imagen se quedaría oculta para siempre (síntoma: "tengo que entrar y salir para verla"). Por eso
// sincronizamos el estado leyendo `img.complete` justo tras montar (ver efecto de abajo).

import React, { useEffect, useRef, useState } from "react";

/**
 * INFRA-03 · Lo que espera el último reintento: más que el `Retry-After: 60` con el que el GET de
 * imágenes del worker contesta un 429 (`domains/images/images.routes.ts`), para caer en otra ventana
 * del filtro.
 */
export const ULTIMO_REINTENTO_MS = 65_000;

type Props = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  /** Placeholder cuando no hay imagen o se agotaron los reintentos. */
  fallback: React.ReactNode;
  retries?: number;
  retryDelayMs?: number;
  /** Espera del último reintento, con el `fallback` pintado (0: no lo hay). */
  ultimoReintentoMs?: number;
};

export default function ImageWithFallback({
  src,
  alt,
  className,
  fallback,
  retries = 5,
  retryDelayMs = 3000,
  ultimoReintentoMs = ULTIMO_REINTENTO_MS,
}: Props) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // El reintento pendiente: se anula al cambiar de imagen o al desmontar, para que el de una imagen
  // anterior no cuente en la nueva.
  const temporizador = useRef<number | undefined>(undefined);

  const programar = (fn: () => void, ms: number) => {
    window.clearTimeout(temporizador.current);
    temporizador.current = window.setTimeout(fn, ms);
  };

  // Reset al cambiar de imagen.
  useEffect(() => {
    window.clearTimeout(temporizador.current);
    setAttempt(0);
    setLoaded(false);
    setFailed(false);
  }, [src]);

  useEffect(() => () => window.clearTimeout(temporizador.current), []);

  const markError = () => {
    if (attempt < retries) {
      // El primer reintento es casi inmediato: en el Handy la imagen suele estar en el bucket a
      // los pocos cientos de ms (un 404 inicial es por propagación, no por ausencia real). Así
      // se evita el efecto "placeholder hasta que navego y vuelvo". Los siguientes reintentos sí
      // espacian (retryDelayMs) para no martillear cuando la imagen tarda de verdad.
      const delay = attempt === 0 ? 400 : retryDelayMs;
      programar(() => setAttempt((a) => a + 1), delay);
    } else if (attempt === retries && ultimoReintentoMs > 0) {
      // INFRA-03: el marcador mientras tanto, y un intento más pasada la ventana del 429.
      setFailed(true);
      programar(() => {
        setFailed(false);
        setAttempt((a) => a + 1);
      }, ultimoReintentoMs);
    } else {
      setFailed(true);
    }
  };

  // Sincroniza con el estado real del <img> tras montar/remontar: si el webview ya lo tenía
  // cacheado (`complete`), `onLoad` no dispararía, así que lo detectamos aquí. `naturalWidth > 0`
  // distingue "cargada OK" de "rota": una rota cacheada también está `complete` pero sin tamaño.
  useEffect(() => {
    const el = imgRef.current;
    if (!el || !el.complete) return;
    if (el.naturalWidth > 0) {
      setLoaded(true);
    } else {
      markError();
    }
    // markError depende de `attempt`, que ya está en deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, attempt]);

  if (!src || failed) return <>{fallback}</>;

  return (
    <img
      ref={imgRef}
      // `key` fuerza el remount al reintentar → vuelve a pedir el mismo URL.
      key={attempt}
      src={src}
      alt={alt}
      className={className}
      // Oculta mientras carga para no mostrar el icono de imagen rota durante un reintento;
      // al cargar aparece directamente la imagen buena, sin placeholder intermedio.
      style={loaded ? undefined : { visibility: "hidden" }}
      draggable={false}
      // "eager": la imagen empieza oculta, y con "lazy" no llegaría a cargarse.
      loading="eager"
      onLoad={() => setLoaded(true)}
      onError={markError}
    />
  );
}
