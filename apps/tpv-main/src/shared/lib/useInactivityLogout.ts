// shared/lib/useInactivityLogout.ts
//
// Auto-logout por inactividad: si NADIE interactúa con la app durante `minutos`, se cierra la
// sesión y se vuelve al login (útil para puestos desatendidos). Cualquier interacción real
// (puntero, teclado, rueda, táctil, movimiento de ratón) reinicia el temporizador, de modo que a
// quien está trabajando no se le echa a mitad de faena.
//
// Solo actúa con sesión iniciada (`role` no vacío). Al cerrar sesión, `useAuth.logout()` pone
// `role=""` y el gate de `App` (`if (!role) return <Login/>`) muestra el login automáticamente.

import { useEffect, useRef } from "react";

import { useAuth } from "../stores/useAuth";

/** Minutos de inactividad total antes de cerrar sesión. Ajustable (podría venir de Configuración). */
export const INACTIVITY_MINUTES = 10;

// Eventos que cuentan como "actividad". `mousemove` es el más sensible (reinicia ante cualquier
// movimiento), así que basta con estar usando la app para no caer nunca en el timeout.
const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "mousemove",
] as const;

export function useInactivityLogout(minutes: number = INACTIVITY_MINUTES): void {
  const role = useAuth((s) => s.role);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // Sin sesión no hay nada que cerrar.
    if (!role) return;

    const ms = Math.max(1, minutes) * 60_000;

    const cerrar = () => useAuth.getState().logout();

    const reset = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(cerrar, ms);
    };

    // `mousemove` dispara muy a menudo; throttle a ~1/s para no reprogramar el timeout sin parar.
    let ultimo = 0;
    const onActivity = () => {
      const ahora = Date.now();
      if (ahora - ultimo < 1000) return;
      ultimo = ahora;
      reset();
    };

    ACTIVITY_EVENTS.forEach((e) =>
      window.addEventListener(e, onActivity, { passive: true }),
    );
    reset(); // arranca el reloj al montar / al iniciar sesión

    return () => {
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [role, minutes]);
}
