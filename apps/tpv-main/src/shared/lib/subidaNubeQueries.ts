import { commands } from "@tpv/client";
// DO-SUBIDA · Cómo va la subida completa de la base a una nube que soporte ha devuelto en modo
// «main» (una base vacía, una copia o una vuelta a un instante).
//
// La hace el motor de réplica por su cuenta, en Rust; esto sólo la enseña. La mira Configuración →
// Conectividad (el estado de la conexión y su panel de progreso). Gemelo de `backfillQueries.ts`.

import { useQuery } from "@tanstack/react-query";

const subidaNubeKeys = {
	estado: ["sync", "subida-nube"] as const,
};

/** Cada cuánto se repregunta MIENTRAS hay subida. Una página tarda de un segundo a unos pocos. */
const REFRESCO_MS = 5_000;
/** Y sin ella: una sesión nueva puede traer una (es una lectura local, sin red). */
const SIN_SUBIDA_MS = 30_000;

/**
 * La subida en curso, o `null`. Sin subida (lo normal) se repregunta despacio. En una Handy contesta
 * `null`: no tiene base que subir.
 */
export function useSubidaNube(activa = true) {
	return useQuery({
		queryKey: subidaNubeKeys.estado,
		queryFn: () => commands.syncSubidaEstado(),
		enabled: activa,
		refetchInterval: (q) => (q.state.data ? REFRESCO_MS : SIN_SUBIDA_MS),
		// Falla mientras la base de la Main no está abierta, y eso no hay que enseñarlo: aquí no
		// aplica todavía.
		retry: false,
	});
}
