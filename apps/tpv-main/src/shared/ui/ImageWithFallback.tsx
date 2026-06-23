// src/shared/ui/ImageWithFallback.tsx
//
// <img> con manejo elegante de errores, pensado para el Handy: la fila de un producto puede
// llegar por WebSocket ANTES de que su imagen esté disponible en el CDN (la subida va por otro
// canal y puede tardar segundos, o minutos si la Main estaba offline).
//
// Comportamiento:
//   - Sin `src` o tras agotar reintentos → muestra `fallback` (placeholder estético del caller).
//   - Mientras carga / reintenta → la imagen está oculta (transparente), nunca un placeholder de
//     "Cargando…" ni una imagen rota. En modo Main las imágenes están en disco y aparecen al
//     instante; en el Handy aparecen en cuanto el CDN responde.
//   - Ante un error (p. ej. 404 porque aún no se ha subido) reintenta el MISMO URL con un pequeño
//     retardo (sin cache-busting, para no romper el cacheo del CDN cuando la imagen sí exista).
//
// IMPORTANTE (bug de imágenes cacheadas): un <img> cuyo fichero ya está en la caché del webview
// —lo normal con ficheros LOCALES en modo Main, que cargan al instante— puede quedar marcado como
// `complete` ANTES de que React monte el handler `onLoad`. Ese evento entonces nunca dispara y la
// imagen se quedaría oculta para siempre (síntoma: "tengo que entrar y salir para verla"). Por eso
// sincronizamos el estado leyendo `img.complete` justo tras montar (ver efecto de abajo).

import React, { useEffect, useRef, useState } from "react";

type Props = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  /** Placeholder cuando no hay imagen o se agotaron los reintentos. */
  fallback: React.ReactNode;
  retries?: number;
  retryDelayMs?: number;
  draggable?: boolean;
  loading?: "lazy" | "eager"; // usa "eager" (default) si el img empieza hidden
};

export default function ImageWithFallback({
  src,
  alt,
  className,
  fallback,
  retries = 5,
  retryDelayMs = 3000,
  draggable = false,
  loading = "eager",
}: Props) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // Reset al cambiar de imagen.
  useEffect(() => {
    setAttempt(0);
    setLoaded(false);
    setFailed(false);
  }, [src]);

  const markError = () => {
    if (attempt < retries) {
      // El primer reintento es casi inmediato: en el Handy la imagen suele estar en R2/edge a
      // los pocos cientos de ms (un 404 inicial es por propagación, no por ausencia real). Así
      // se evita el efecto "placeholder hasta que navego y vuelvo". Los siguientes reintentos sí
      // espacian (retryDelayMs) para no martillear cuando la imagen tarda de verdad.
      const delay = attempt === 0 ? 400 : retryDelayMs;
      window.setTimeout(() => setAttempt((a) => a + 1), delay);
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
      draggable={draggable}
      loading={loading}
      onLoad={() => setLoaded(true)}
      onError={markError}
    />
  );
}
