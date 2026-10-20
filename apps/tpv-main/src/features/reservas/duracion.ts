// src/features/reservas/duracion.ts
//
// RI-61: las duraciones que se ofrecen para una reserva (en Configuración, la de por defecto; en el
// formulario, la de cada reserva). El backend acepta cualquiera entre 1 minuto y 24 horas; esto es
// sólo lo que se ofrece en el desplegable.

export const DURACIONES_MIN = [30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360];

/** 90 → «1 h 30 min», 120 → «2 h», 45 → «45 min». */
export function etiquetaDuracion(minutos: number): string {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Las de la lista y, si no está, la que ya tiene guardada (para no perderla al abrir el formulario). */
export function opcionesDuracion(actual: number | null | undefined): number[] {
  if (actual == null || DURACIONES_MIN.includes(actual)) return DURACIONES_MIN;
  return [...DURACIONES_MIN, actual].sort((a, b) => a - b);
}

/** Lo que se ofrece para marcar «No vino» (minutos tras la hora de la reserva; 0, nunca, va aparte). */
export const NO_VINO_MIN = [15, 30, 45, 60, 90, 120];

/** Las de la lista y, si no está, la que ya tiene guardada; 0 (nunca) no entra. */
export function opcionesNoVino(actual: number): number[] {
  if (actual <= 0 || NO_VINO_MIN.includes(actual)) return NO_VINO_MIN;
  return [...NO_VINO_MIN, actual].sort((a, b) => a - b);
}

/** «21:00» + 120 min → «23:00» (pasada la medianoche vuelve a empezar: «00:30»). */
export function horaFin(hora: string, minutos: number): string {
  const [h, m] = hora.split(":").map(Number);
  const total = (((h * 60 + m + minutos) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
