// src/features/notificaciones/useNotificacionesToast.ts
//
// Muestra un toast cuando LLEGA una notificación nueva para el usuario logueado. Se apoya en el
// globito de la campana (`useNoLeidasCount`): el número de no leídas y la fecha de la más reciente
// que el usuario puede ver, también en la papelera. Avisa cuando SUBE el número **y** AVANZA esa
// fecha respecto a lo anterior. Restaurar una de la papelera sube el número, pero la fecha no se
// mueve: no es nueva (antes avisaba de «una nueva notificación» que era la de siempre). Cubre tanto
// las que llegan de otro equipo (el `change` invalida el contador) como las emitidas aquí.
//
// Se monta una sola vez en el shell (App.tsx). Es no-op sin sesión.

import { useEffect, useRef } from "react";

import type { NoLeidasDto } from "@tpv/contracts";
import { useAuth } from "../../shared/stores/useAuth";
import { useToast } from "../../shared/toast";
import { useNoLeidasCount } from "./notificacionesQueries";

/** ¿Hay una nueva desde `antes`? Sube el número y la más reciente es posterior (las fechas son
 *  `YYYY-MM-DD HH:MM:SS`, que se ordenan como texto). */
export function hayUnaNueva(antes: NoLeidasDto, ahora: NoLeidasDto): boolean {
  if (ahora.count <= antes.count) return false;
  if (ahora.ultima_creada_en == null) return false;
  return antes.ultima_creada_en == null || ahora.ultima_creada_en > antes.ultima_creada_en;
}

export function useNotificacionesToast() {
  const idUsuario = useAuth((s) => s.idUsuario);
  const toast = useToast();
  const { data: noLeidas } = useNoLeidasCount(idUsuario);

  // Lo anterior. `null` = aún sin línea base (primera carga / cambio de usuario): en ese caso NO
  // avisamos, sólo fijamos la referencia para comparar a partir de la siguiente.
  const previo = useRef<NoLeidasDto | null>(null);

  // Al cambiar de usuario (login/logout), re-basamos: el contador del nuevo usuario es otra serie.
  useEffect(() => {
    previo.current = null;
  }, [idUsuario]);

  useEffect(() => {
    if (noLeidas == null) return;

    const anterior = previo.current;
    previo.current = noLeidas;

    if (anterior == null) return; // primera lectura: solo fija la línea base
    if (hayUnaNueva(anterior, noLeidas)) {
      toast.info("Tienes una nueva notificación");
    }
  }, [noLeidas, toast]);
}
