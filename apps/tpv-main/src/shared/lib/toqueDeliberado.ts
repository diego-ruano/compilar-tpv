// src/shared/lib/toqueDeliberado.ts
//
// INI-06: en Android, al desplazar la lista del selector inicial saltaba «Activa tu TPV», como si
// el dedo que arrastraba hubiera pulsado la tarjeta del TPV. El selector no reacciona al tocar
// (`onPointerDown`/`onTouchStart`), sólo al `click`, así que el click llegaba igual al final del
// gesto; en el código no hay nada que lo explique y en el teléfono no se ha podido reproducir.
// Para una tarjeta que cambia el modo del equipo eso no puede pasar, venga de donde venga: un click
// cuyo puntero se ha movido o ha desplazado algo desde que tocó la pantalla no es una elección.
//
// El teclado (Intro o espacio sobre la tarjeta) no pasa por el puntero: cuenta siempre.

import { useEffect, useRef } from "react";
import type React from "react";

/** Lo que se puede mover el dedo de un toque y seguir siendo un toque, en píxeles CSS. */
const HOLGURA_DEL_TOQUE_PX = 10;

type Toque = { x: number; y: number; anulado: boolean };

/**
 * Manejadores para un botón que no debe dispararse al desplazar: `onPointerDown` y
 * `onPointerCancel` van en el botón, y `esDeliberado(e)` se pregunta en su `onClick`.
 */
export function useToqueDeliberado() {
	const toque = useRef<Toque | null>(null);

	useEffect(() => {
		// `scroll` no burbujea: en captura, en la ventana, se ve el de cualquier contenedor.
		const alDesplazar = () => {
			if (toque.current) toque.current.anulado = true;
		};
		window.addEventListener("scroll", alDesplazar, true);
		return () => window.removeEventListener("scroll", alDesplazar, true);
	}, []);

	return {
		onPointerDown: (e: React.PointerEvent) => {
			toque.current = { x: e.clientX, y: e.clientY, anulado: false };
		},
		/** El navegador se queda el gesto (para desplazar): lo que venga detrás no es un toque. */
		onPointerCancel: () => {
			if (toque.current) toque.current.anulado = true;
		},
		esDeliberado: (e: React.MouseEvent): boolean => {
			const t = toque.current;
			toque.current = null;
			// Sin puntero (teclado, o un click sintético): cuenta.
			if (e.detail === 0 || !t) return true;
			if (t.anulado) return false;
			return Math.hypot(e.clientX - t.x, e.clientY - t.y) <= HOLGURA_DEL_TOQUE_PX;
		},
	};
}
