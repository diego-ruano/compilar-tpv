import { commands } from "@tpv/client";
// SYNC-19 · Progreso del backfill del histórico (la fase 2 de una recuperación).
//
// Tras perder la `data.db`, la nube devuelve lo imprescindible para volver a vender —los maestros
// enteros y 30 días de lo transaccional— y un job de fondo va trayendo el resto. Mientras eso
// corre hay dos sitios que tienen que saberlo:
//
//   · Configuración → Conectividad, para que se vea que hay trabajo en curso y no parezca colgado.
//   · Estadísticas, porque un total de rango largo va a CRECER SOLO durante un rato, y un número
//     que cambia sin explicación se lee como un error de cálculo, no como una descarga a medias.
//
// Vive en `shared/` y no co-locado en una feature justamente porque lo miran las dos.

import { useQuery } from "@tanstack/react-query";

export const backfillKeys = {
	estado: ["sync", "backfill"] as const,
};

/** Cada cuánto se repregunta MIENTRAS hay backfill. El job trae páginas cada 5 min. */
const REFRESCO_MS = 20_000;

/**
 * Estado del backfill. En un equipo que nunca ha perdido su base devuelve todo a cero y **deja de
 * repreguntar**: `refetchInterval` se apaga en cuanto no queda nada pendiente, así que esto no es
 * un poll permanente en el 99,99 % de las instalaciones — sólo mientras de verdad hay algo que ver.
 */
export function useBackfillHistorico() {
	return useQuery({
		queryKey: backfillKeys.estado,
		queryFn: () => commands.syncBackfillEstado(),
		refetchInterval: (q) => (q.state.data?.tablas_pendientes ? REFRESCO_MS : false),
		// En una Handy contesta que no hay nada pendiente (lee de la nube, que tiene el histórico
		// entero). Falla mientras la base de la Main no está abierta, y eso no hay que enseñarlo: es
		// "aquí no aplica todavía".
		retry: false,
	});
}
