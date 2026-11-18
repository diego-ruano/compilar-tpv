// SYN-INC-05 · «Cobrar todo» mientras otro equipo cambia la cuenta.
//
// «Cobrar todo» selecciona lo pendiente al pulsar, y el cobro manda esa lista. Si mientras se elige
// el método otro equipo añade una línea (llega por la réplica y la pantalla recarga), la lista vieja
// cobraba la cuenta sin ella. Mientras se está cobrando todo, cada recarga vuelve a seleccionar todo
// lo pendiente y, si ha cambiado, se avisa con el total nuevo. El backend pone además su red: el
// cobro lleva `todo: true` y no entra si queda algo por cobrar fuera de la lista.
//
// Lo usan la venta rápida (`useVentaRapida`) y la mesa (`MesaComandaModal`).

import type { Dinero } from "@tpv/contracts";

import { eur } from "./dinero";
import { sumaImportes } from "./efectivo";

export type LineaCobrable = { id: string; pagado: boolean; precio: Dinero };

export type AvisoCuentaCambiada = { titulo: string; detalle: string };

/** Lo pendiente de cobrar: lo que «Cobrar todo» selecciona. */
export function pendientesDe(lineas: readonly LineaCobrable[]): Set<string> {
	return new Set(lineas.filter((l) => !l.pagado).map((l) => l.id));
}

/**
 * Con «Cobrar todo» activo, la selección tras una recarga: todo lo pendiente. `antes` es lo que
 * estaba seleccionado. Si lo pendiente no es lo mismo, devuelve también el aviso que hay que
 * enseñar, con el total nuevo.
 */
export function reseleccionarTodo(
	antes: ReadonlySet<string>,
	lineas: readonly LineaCobrable[],
): { seleccion: Set<string>; aviso: AvisoCuentaCambiada | null } {
	const seleccion = pendientesDe(lineas);
	const anadidas = [...seleccion].some((id) => !antes.has(id));
	const quitadas = [...antes].some((id) => !seleccion.has(id));
	if (!anadidas && !quitadas) return { seleccion, aviso: null };

	if (seleccion.size === 0) {
		return {
			seleccion,
			aviso: { titulo: "Ya no queda nada por cobrar", detalle: "La cuenta ha cambiado en otro equipo." },
		};
	}
	const total = sumaImportes(lineas.filter((l) => seleccion.has(l.id)).map((l) => l.precio));
	return {
		seleccion,
		aviso: {
			titulo: anadidas ? "Han añadido algo a la cuenta" : "La cuenta ha cambiado",
			detalle: `El total es ahora ${eur(total)}.`,
		},
	};
}
