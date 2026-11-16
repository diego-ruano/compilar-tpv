// src/shared/lib/diaDelNegocio.ts
//
// Qué día es «hoy» en el negocio, y de qué día es una fecha guardada (INC-01).
//
// Las fechas de la base son la hora de pared del negocio sin desfase (`YYYY-MM-DD HH:MM:SS`). Pasarlas
// por `Date` las interpreta con la zona del dispositivo, y compararlas con el «hoy» del dispositivo
// hace que una Handy con otra zona (un móvil en GMT) vea otro día: de madrugada, «Sin tickets». El día
// de una fecha guardada es su texto; el de hoy se calcula en la zona del negocio
// (`BusinessSettings.zona_horaria`).

/** `YYYY-MM-DD` de una fecha guardada, o `null` si no tiene esa forma. */
export function diaDeFecha(fecha: string | null | undefined): string | null {
    const dia = (fecha ?? "").trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(dia) ? dia : null;
}

/** Hoy (`YYYY-MM-DD`) en la zona del negocio. Una zona que el motor no conoce cae a la del equipo. */
export function hoyEnElNegocio(zona: string, ahoraMs: number = Date.now()): string {
    const opciones: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
    let formato: Intl.DateTimeFormat;
    try {
        formato = new Intl.DateTimeFormat("en-CA", { ...opciones, timeZone: zona });
    } catch {
        formato = new Intl.DateTimeFormat("en-CA", opciones);
    }
    const partes = formato.formatToParts(new Date(ahoraMs));
    const p = (tipo: string) => partes.find((x) => x.type === tipo)?.value ?? "";
    return `${p("year")}-${p("month")}-${p("day")}`;
}

/** «16/11 18:30» de una fecha guardada, tal cual, sin pasarla por la zona del dispositivo. */
export function diaYHoraCortos(fecha: string): string {
    const f = fecha.trim();
    const dia = diaDeFecha(f);
    if (!dia) return f;
    const hora = f.slice(11, 16);
    return `${dia.slice(8, 10)}/${dia.slice(5, 7)}${/^\d{2}:\d{2}$/.test(hora) ? ` ${hora}` : ""}`;
}
