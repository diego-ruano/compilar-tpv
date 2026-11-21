// src/features/configuracion/sections/textoConexion.ts
//
// Lo que dice Configuración → Conectividad de la conexión con la nube.

import type { SubidaNubeEstado } from "@tpv/contracts";

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
 * El texto del estado. Con conexión y cambios de este TPV por subir no está «al día»
 * (`porSubir`, de `sync_health`; `null` si todavía no se sabe). Que los Handy esperan sólo se dice
 * cuando es así (`handyRetenidas`): la nube los retiene desde que esta Main conecta hasta que vuelca
 * por primera vez lo que tenía pendiente. Después, lo que se sube tras cada venta o una operación
 * que se reintenta no los retiene: decir que esperaban era mentira.
 */
export function textoDeConexion(
	estado: EstadoSync,
	porSubir: number | null,
	handyRetenidas: boolean,
	subida: SubidaNubeEstado | null = null,
): TextoConexion {
	if (estado !== "conectado") return ESTADO_TEXTO[estado];
	const hayPorSubir = porSubir !== null && porSubir > 0;
	// DO-SUBIDA: soporte ha devuelto la nube a una copia (o a una base vacía) y este TPV le sube lo
	// que tiene. Los Handy esperan sólo a lo imprescindible; lo demás sigue con ellos trabajando y
	// se ve en su panel.
	if (handyRetenidas && subida?.estado === "subiendo") {
		return {
			titulo: "Devolviendo los datos a la nube…",
			desc: "La nube del negocio se ha restaurado y este TPV le está subiendo lo que tiene. Los Handy esperan a que llegue lo imprescindible; este TPV sigue cobrando con normalidad.",
			tono: "aviso",
		};
	}
	if (handyRetenidas) {
		return {
			titulo: hayPorSubir ? `Subiendo cambios (${porSubir})…` : "Poniéndose al día…",
			desc: "Este TPV está poniendo al día la nube con lo que tenía pendiente. Los Handy esperan a que termine para poder trabajar.",
			tono: "aviso",
		};
	}
	if (hayPorSubir) {
		return {
			titulo: `Subiendo cambios (${porSubir})…`,
			desc: "Este TPV está subiendo a la nube sus últimos cambios. Los dispositivos Handy pueden trabajar.",
			tono: "ok",
		};
	}
	return ESTADO_TEXTO[estado];
}

/**
 * DO-SUBIDA · Los avisos del panel de la subida de los datos a la nube, en español y sin códigos:
 * lo que no entró a la primera (se comprueba al final), una parte que la nube no admite (la revisa
 * la comprobación con la nube, no se reintenta) y un rechazo que se está reintentando (se apaga en
 * cuanto un paso entra).
 */
export function avisosDeSubida(subida: SubidaNubeEstado): { texto: string; tono: "info" | "aviso" }[] {
	const avisos: { texto: string; tono: "info" | "aviso" }[] = [];
	if (subida.filas_por_revisar > 0) {
		avisos.push({
			texto: `${subida.filas_por_revisar.toLocaleString("es-ES")} registros no han entrado a la primera; se comprueban al final.`,
			tono: "info",
		});
	}
	if (subida.tablas_fallidas > 0) {
		avisos.push({
			texto:
				subida.tablas_fallidas === 1
					? "Una parte de los datos no se ha podido subir así; la revisará la comprobación con la nube cuando termine."
					: `${subida.tablas_fallidas} partes de los datos no se han podido subir así; las revisará la comprobación con la nube cuando termine.`,
			tono: "aviso",
		});
	}
	if (subida.reintentando) {
		avisos.push({ texto: "La nube no ha aceptado el último envío. Se reintenta solo en unos segundos.", tono: "aviso" });
	}
	return avisos;
}
