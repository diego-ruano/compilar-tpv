// El widget va dentro de un iframe en la web del restaurante. `embed.js` le pone la altura que dice
// este mensaje, para que no haya barras de desplazamiento dentro de la página.

import { useEffect } from "react";

const MENSAJE_ALTURA = "tpv-reservas-altura";

export function useAvisarAltura() {
	useEffect(() => {
		if (window.parent === window) return;
		let ultima = 0;
		const avisar = () => {
			const altura = Math.ceil(document.documentElement.scrollHeight);
			if (altura === ultima) return;
			ultima = altura;
			// El destino no se conoce (es la web que lo incruste) y la altura no dice nada de nadie;
			// quién puede incrustarlo lo decide `frame-ancestors`.
			window.parent.postMessage({ tipo: MENSAJE_ALTURA, altura }, "*");
		};
		avisar();
		const ro = new ResizeObserver(avisar);
		ro.observe(document.documentElement);
		return () => ro.disconnect();
	}, []);
}
