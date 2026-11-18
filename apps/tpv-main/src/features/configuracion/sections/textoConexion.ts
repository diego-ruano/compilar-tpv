// src/features/configuracion/sections/textoConexion.ts
//
// Lo que dice Configuración → Conectividad de la conexión con la nube.

import type { EstadoSync } from "../../../shared/stores/useEstadoSync";

export type TextoConexion = { titulo: string; desc: string; tono: "ok" | "neutro" | "aviso" | "malo" };

/**
 * SYNC-17: cómo se cuenta cada estado. Ya no hay nada que elegir aquí —la Main se conecta sola—,
 * así que este panel es informativo: dice qué está pasando y, cuando algo no va, qué significa.
 *
 * `tono` decide el color: `ok` verde, `neutro` gris (no pasa nada malo, simplemente no aplica),
 * `aviso` ámbar (transitorio, se está resolviendo) y `malo` rojo (no se va a arreglar solo).
 */
const ESTADO_TEXTO: Record<EstadoSync, TextoConexion> = {
	conectado: {
		titulo: "Al día",
		desc: "Los cambios se guardan en la nube y los dispositivos Handy pueden trabajar.",
		tono: "ok",
	},
	conectando: {
		titulo: "Conectando…",
		desc: "Estableciendo la conexión con la nube.",
		tono: "aviso",
	},
	reintentando: {
		titulo: "Sin conexión",
		desc: "Este TPV sigue funcionando con normalidad y guarda todo lo que hagas; se subirá solo en cuanto vuelva la conexión. Los Handy no pueden trabajar mientras tanto.",
		tono: "aviso",
	},
	sin_identidad: {
		titulo: "Sin licencia activada",
		desc: "Todavía no hay una licencia activada en este dispositivo, así que no hay nada a lo que conectarse.",
		tono: "neutro",
	},
	rechazado: {
		titulo: "La nube ha rechazado la conexión",
		desc: "El servidor no acepta este dispositivo: normalmente es la licencia (caducada o anulada) o que la licencia se ha trasladado a otro equipo. Revisa la licencia; esto no se arregla solo.",
		tono: "malo",
	},
	pausada: {
		titulo: "Sincronización desactivada",
		desc: "Este dispositivo tiene la sincronización apagada a propósito. Todo se sigue guardando en local y se subirá si se vuelve a activar.",
		tono: "neutro",
	},
	// AUD-19: la base de este equipo es anterior a lo que guarda la nube. No se arregla reconectando.
	// SYNC-32: el TPV pasa a la pantalla de recuperación, que trae el estado actual de la nube.
	detenida: {
		titulo: "Sincronización detenida",
		desc: "Los datos de este equipo son anteriores a lo que guarda la nube y no se pueden poner al día con ella. Hay que recuperar el estado actual de la nube desde la pantalla de recuperación; lo que este equipo tenía sin subir se guarda aparte.",
		tono: "malo",
	},
};

/**
 * El texto del estado. Con conexión y cambios de este TPV por subir no está «al día»: la nube tiene
 * a los Handy esperando hasta que la Main termina de volcar lo que tenía pendiente, y decir que
 * pueden trabajar era mentira (`porSubir`, de `sync_health`; `null` si todavía no se sabe).
 */
export function textoDeConexion(estado: EstadoSync, porSubir: number | null): TextoConexion {
	if (estado === "conectado" && porSubir !== null && porSubir > 0) {
		return {
			titulo: `Subiendo cambios (${porSubir})…`,
			desc: "Este TPV está subiendo a la nube lo que tenía pendiente. Los Handy esperan a que termine para poder trabajar.",
			tono: "aviso",
		};
	}
	return ESTADO_TEXTO[estado];
}
