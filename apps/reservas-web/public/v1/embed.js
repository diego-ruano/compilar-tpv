/*
 * embed.js · El widget de reservas en la web del restaurante (docs/estudios/reservas-web.md §7.3).
 *
 *   <div data-negocio="rw_…"></div>
 *   <script src="https://…/reservas-web/v1/embed.js" async></script>
 *
 * Mete en cada [data-negocio] un iframe con el widget y le ajusta la altura con lo que el widget le
 * diga (sólo mensajes de su propio origen y de ese iframe). Sin variables globales; cargarlo dos
 * veces no hace nada más. Se sirve con caché corta: un cambio aquí llega a todas las webs en minutos.
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
	var iframes = [];

	var huecos = document.querySelectorAll("[data-negocio]:not([" + MARCA + "])");
	for (var i = 0; i < huecos.length; i++) {
		var hueco = huecos[i];
		var clave = hueco.getAttribute("data-negocio") || "";
		hueco.setAttribute(MARCA, "1");
		if (!CLAVE.test(clave)) continue;

		var iframe = document.createElement("iframe");
		iframe.src = origen + "/reservas-web/v1/w/" + encodeURIComponent(clave);
		iframe.title = "Reservar mesa";
		iframe.loading = "lazy";
		iframe.style.width = "100%";
		iframe.style.border = "0";
		iframe.style.display = "block";
		iframe.style.height = "640px";
		hueco.appendChild(iframe);
		iframes.push(iframe);
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
