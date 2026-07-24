// src/features/notificaciones/useNotificacionesToast.ts
//
// Muestra un toast cuando LLEGA una notificación nueva para el usuario logueado. Se apoya en el
// contador de no leídas (`useNoLeidasCount`): cuando SUBE respecto al valor previo, lanza el toast.
// Así cubre tanto las notificaciones que llegan por WebSocket (el `change` invalida el contador →
// sube) como las emitidas localmente (el contador se refresca en segundos).
//
// Se monta una sola vez en el shell (App.tsx). Es no-op sin sesión.

import { useEffect, useRef } from "react";

import { useAuth } from "../../shared/stores/useAuth";
import { useToast } from "../../shared/toast";
import { useNoLeidasCount } from "./notificacionesQueries";

export function useNotificacionesToast() {
  const idUsuario = useAuth((s) => s.idUsuario);
  const toast = useToast();
  const { data: noLeidas } = useNoLeidasCount(idUsuario);

  // Valor previo del contador. `null` = aún sin línea base (primera carga / cambio de usuario):
  // en ese caso NO avisamos, solo fijamos la referencia para comparar a partir de la siguiente.
  const previo = useRef<number | null>(null);

  // Al cambiar de usuario (login/logout), re-basamos: el contador del nuevo usuario es otra serie.
  useEffect(() => {
    previo.current = null;
  }, [idUsuario]);

  useEffect(() => {
    if (noLeidas == null) return;

    const anterior = previo.current;
    previo.current = noLeidas;

    if (anterior == null) return; // primera lectura: solo fija la línea base
    if (noLeidas > anterior) {
      toast.info("Tienes una nueva notificación");
    }
  }, [noLeidas, toast]);
}
