// src/shared/lib/diasNaturales.ts
//
// Cuántos días de CALENDARIO faltan hasta una fecha, en la hora local del equipo.
//
// No es `Math.ceil((fecha - ahora) / día)`. Con esa cuenta, una licencia que caducaba a las 23:00
// decía a las 08:00 que caducaba «mañana»: quince horas redondeadas hacia arriba son un día. «Hoy» y
// «mañana» son fechas, no horas que faltan. Gemela de `dias_naturales_hasta` en `tpv-application`,
// que redacta el mismo aviso como notificación.

const DIA_MS = 24 * 60 * 60 * 1000;

/** Días de calendario desde hoy hasta la fecha de `fechaMs`: 0 es hoy, 1 mañana, negativo ya pasó. */
export function diasNaturalesHasta(fechaMs: number, ahoraMs: number = Date.now()): number {
    const fecha = new Date(fechaMs);
    const hoy = new Date(ahoraMs);
    // Cada fecha LOCAL se lleva a medianoche UTC antes de restar: así el día del cambio de hora, que
    // tiene 23 o 25 horas, sigue contando como un día.
    const desde = Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    const hasta = Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
    return Math.round((hasta - desde) / DIA_MS);
}
