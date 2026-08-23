// Hooks de TanStack Query para el emparejamiento de Handys (Configuración → Vincular Handy).
//
// Las dos listas de esta pantalla —solicitudes pendientes y dispositivos vinculados— viven en la
// NUBE, no en el SQLite local, así que aquí React Query hace algo que no hace en el resto de la
// app: además de cachear, decide cuándo volver a preguntar.
//
// Cómo se enteran de que hay una solicitud nueva:
//   · Por empujón — el worker avisa al TenantHub cuando un Handy reclama un código y éste lo
//     manda por el WebSocket de la Main; `useMainSocket` invalida `pairingKeys.all` y la lista
//     se recarga al instante (ver `/internal/pair-request`).
//   · Por sondeo — sólo como red de seguridad, porque un empujón se pierde si el WS está caído
//     justo en ese momento. De ahí que el intervalo dependa de si hay socket.
//
// Antes esto era un `setInterval` de 5 s montado en el componente, que además borraba y repintaba
// las listas en cada vuelta.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { cloudPost } from "../../shared/lib/cloudApi";
import { deviceFingerprint } from "../../shared/lib/deviceFingerprint";
import { useEstadoSync } from "../../shared/stores/useEstadoSync";

export type PairPendingItem = {
	pairCode: string;
	status: string;
	createdAtMs: number;
	expiresAtMs: number;

	claimedAtMs: number | null;
	claimedDeviceId: string | null;
	claimedDeviceName: string | null;
	claimedDevicePubKeyB64: string | null;

	attempts: number;
	lastAttemptAtMs: number | null;

	/** Calculada en el cliente a partir de `claimedDevicePubKeyB64` (no viene del worker). */
	fingerprint?: string;
};

export type LinkedDevice = {
	deviceId: string;
	devicePubKeyB64: string | null;
	firstSeenAtMs: number;
	lastSeenAtMs: number;
	fingerprint?: string;
};

/** Prefijo de claves de la feature; invalidar esto refresca las dos listas. */
export const pairingKeys = {
	all: ["pairing"] as const,
	pendientes: ["pairing", "pendientes"] as const,
	vinculados: ["pairing", "vinculados"] as const,
};

/**
 * Cada cuánto se vuelve a preguntar, en milisegundos.
 *
 * Con socket, el empujón es quien avisa y esto es sólo una red por si se perdió uno. Sin socket
 * no puede llegar ningún empujón, así que se pregunta más a menudo — pero ni de lejos como el
 * sondeo de 5 s de antes, que se comía dos peticiones firmadas cada vez.
 */
const REFRESCO_CON_SOCKET_MS = 60_000;
const REFRESCO_SIN_SOCKET_MS = 15_000;

function useIntervaloRefresco(): number {
	const conectado = useEstadoSync((s) => s.estado) === "conectado";
	return conectado ? REFRESCO_CON_SOCKET_MS : REFRESCO_SIN_SOCKET_MS;
}

/** La huella es lo que el operario compara contra la pantalla del Handy antes de aprobar. */
async function conHuella<T extends { pub: string | null; item: any }>(
	entradas: T[],
): Promise<any[]> {
	return Promise.all(
		entradas.map(async ({ pub, item }) => ({
			...item,
			fingerprint: pub ? await deviceFingerprint(pub) : "",
		})),
	);
}

/** Solicitudes de emparejamiento esperando aprobación. */
export function usePairPendientes() {
	return useQuery({
		queryKey: pairingKeys.pendientes,
		queryFn: async (): Promise<PairPendingItem[]> => {
			const r = (await cloudPost("tpv", "/v1/pair/pending", {})) as any;
			const items = (r.items || []) as PairPendingItem[];

			return conHuella(
				items.map((item) => ({ pub: item.claimedDevicePubKeyB64, item })),
			);
		},
		refetchInterval: useIntervaloRefresco(),
		// El dato vive en la nube y lo cambia OTRO dispositivo, así que aquí sí interesa mirar
		// al volver a la ventana (el resto de la app es Local-First y lo tiene desactivado).
		refetchOnWindowFocus: true,
	});
}

/** Handys con acceso ahora mismo. */
export function useDispositivosVinculados() {
	return useQuery({
		queryKey: pairingKeys.vinculados,
		queryFn: async (): Promise<LinkedDevice[]> => {
			const r = (await cloudPost("tpv", "/v1/device/list", {})) as any;
			const items = (r.items || []) as LinkedDevice[];

			return conHuella(items.map((item) => ({ pub: item.devicePubKeyB64, item })));
		},
		refetchInterval: useIntervaloRefresco(),
		refetchOnWindowFocus: true,
	});
}

/** Aprueba una solicitud: el Handy queda vinculado y desaparece de las pendientes. */
export function useAprobarHandy() {
	const qc = useQueryClient();

	return useMutation({
		mutationFn: (pairCode: string) =>
			cloudPost("tpv", "/v1/pair/approve", { pairCode }),
		// Las dos listas cambian a la vez: la solicitud se va de pendientes y el dispositivo
		// aparece en vinculados.
		onSuccess: () => qc.invalidateQueries({ queryKey: pairingKeys.all }),
	});
}

/** Retira el acceso a un Handy vinculado. */
export function useRevocarHandy() {
	const qc = useQueryClient();

	return useMutation({
		mutationFn: (deviceId: string) =>
			cloudPost("tpv", "/v1/device/revoke", { deviceId }),
		onSuccess: () => qc.invalidateQueries({ queryKey: pairingKeys.all }),
	});
}
