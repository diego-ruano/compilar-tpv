// src/shared/ui/ImageWithFallback.tsx
//
// <img> con manejo elegante de errores, pensado para el Handy: la fila de un producto puede
// llegar por WebSocket ANTES de que su imagen esté disponible en el CDN (la subida va por otro
// canal y puede tardar segundos, o minutos si la Main estaba offline).
//
// Comportamiento:
//   - Sin `src` o tras agotar reintentos → muestra `fallback` (placeholder estético del caller).
//   - Mientras carga / reintenta → muestra `loadingFallback` (por defecto "Cargando imagen…"),
//     nunca una imagen rota.
//   - Ante un error (p. ej. 404 porque aún no se ha subido) reintenta el MISMO URL con un pequeño
//     retardo (sin cache-busting, para no romper el cacheo del CDN cuando la imagen sí exista).

import React, { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";

type Props = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  /** Placeholder cuando no hay imagen o se agotaron los reintentos. */
  fallback: React.ReactNode;
  /** Placeholder mientras carga/reintenta. Si se omite, usa uno genérico de "Cargando…". */
  loadingFallback?: React.ReactNode;
  retries?: number;
  retryDelayMs?: number;
  draggable?: boolean;
  loading?: "lazy" | "eager";
};

const DefaultLoading = (
  <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 text-fg-subtle">
    <ImageOff className="size-6 animate-pulse" aria-hidden />
    <span className="text-xs font-semibold">Cargando imagen…</span>
  </div>
);

export default function ImageWithFallback({
  src,
  alt,
  className,
  fallback,
  loadingFallback,
  retries = 5,
  retryDelayMs = 3000,
  draggable = false,
  loading = "lazy",
}: Props) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Reset al cambiar de imagen.
  useEffect(() => {
    setAttempt(0);
    setLoaded(false);
    setFailed(false);
  }, [src]);

  if (!src || failed) return <>{fallback}</>;

  const handleError = () => {
    if (attempt < retries) {
      window.setTimeout(() => setAttempt((a) => a + 1), retryDelayMs);
    } else {
      setFailed(true);
    }
  };

  return (
    <>
      {!loaded ? <>{loadingFallback ?? DefaultLoading}</> : null}
      <img
        // `key` fuerza el remount al reintentar → vuelve a pedir el mismo URL.
        key={attempt}
        src={src}
        alt={alt}
        className={className}
        style={loaded ? undefined : { display: "none" }}
        draggable={draggable}
        loading={loading}
        onLoad={() => setLoaded(true)}
        onError={handleError}
      />
    </>
  );
}
