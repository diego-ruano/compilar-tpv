/*
 * embed.js · El widget de reservas en la web del restaurante (docs/estudios/reservas-web.md §7.3).
 *
 *   <div data-negocio="rw_…"></div>
 *   <script src="https://…/reservas-web/v1/embed.js" async></script>
 *
 * Mete en cada [data-negocio] un iframe con el widget. El tamaño lo decide el hueco, con el CSS de
 * la web: el widget ocupa todo su ancho y, si el hueco ya tiene alto (`height`, `min-height`, un
 * flex que lo estira), lo llena y se desplaza por dentro; si no, crece con lo que ocupe cada paso,
 * con la altura que le diga el widget (sólo mensajes de su propio origen y de ese iframe). Sin
 * variables globales; cargarlo dos veces no hace nada más. Se sirve con caché corta: un cambio aquí
 * llega a todas las webs en minutos.
 */
(function () {
	"use strict";

	var script = document.currentScript;
	if (!script || !script.src) return;
	var origen;
	try {
		origen = new URL(script.src).origin;
	} catch {
		return;
	}

	var CLAVE = /^rw_[A-Za-z0-9_-]{22}$/;
	var MARCA = "data-tpv-reservas";
	var MENSAJE = "tpv-reservas-altura";
	// Los que crecen con su contenido: a éstos se les pone la altura que diga el widget.
	var iframes = [];

	var huecos = document.querySelectorAll("[data-negocio]:not([" + MARCA + "])");
	for (var i = 0; i < huecos.length; i++) {
		var hueco = huecos[i];
		var clave = hueco.getAttribute("data-negocio") || "";
		hueco.setAttribute(MARCA, "1");
		if (!CLAVE.test(clave)) continue;

		// Vacío, un hueco sin alto en su CSS mide 0. Si ya mide algo, ése es el tamaño que quiere la web.
		var conAlto = hueco.getBoundingClientRect().height > 0;

		var iframe = document.createElement("iframe");
		iframe.src = origen + "/reservas-web/v1/w/" + encodeURIComponent(clave);
		iframe.title = "Reservar mesa";
		iframe.loading = "lazy";
		iframe.style.width = "100%";
		iframe.style.border = "0";
		iframe.style.display = "block";
		if (conAlto) {
			// Encima del hueco y con su tamaño: así no le suma altura (con un `min-height`, un iframe
			// en el flujo lo haría crecer) y sigue a la web si el hueco cambia de tamaño.
			if (window.getComputedStyle(hueco).position === "static") hueco.style.position = "relative";
			iframe.style.position = "absolute";
			iframe.style.top = "0";
			iframe.style.left = "0";
			iframe.style.height = "100%";
		} else {
			iframe.style.height = "640px";
			iframes.push(iframe);
		}
		hueco.appendChild(iframe);
	}
	if (!iframes.length) return;

	window.addEventListener("message", function (e) {
		if (e.origin !== origen) return;
		var datos = e.data;
		if (!datos || datos.tipo !== MENSAJE || typeof datos.altura !== "number") return;
		for (var j = 0; j < iframes.length; j++) {
			if (iframes[j].contentWindow === e.source) {
				iframes[j].style.height = Math.min(Math.max(Math.round(datos.altura), 200), 4000) + "px";
			}
		}
	});
})();
