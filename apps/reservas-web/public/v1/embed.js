/*
 * embed.js · El widget de reservas en la web del restaurante (docs/estudios/reservas-web.md §7.3).
 *
 *   <div data-negocio="rw_…"></div>
 *   <script src="https://…/reservas-web/v1/embed.js" async></script>
 *
 * Mete en cada [data-negocio] un iframe con el widget. El tamaño lo decide el hueco, con el CSS de
 * la web: el iframe ocupa todo su ancho y, de alto, lo que ocupe cada paso del widget (la altura
 * que manda el widget, sólo en mensajes de su propio origen y de ese iframe). Si el CSS del hueco le
 * pone otro alto (`height`, `min-height`, `max-height`, un flex que lo estira), el iframe llena ese
 * alto y el widget se desplaza por dentro. Sin variables globales; cargarlo dos veces no hace nada
 * más. Se sirve con caché corta: un cambio aquí llega a todas las webs en minutos.
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
	// Cada widget: su hueco, su iframe y la altura que pide su contenido.
	var widgets = [];

	/** El alto del contenido del hueco, sin su padding ni sus bordes. */
	function altoDelHueco(hueco) {
		var cs = window.getComputedStyle(hueco);
		return hueco.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
	}

	/**
	 * Se le da al iframe el alto que pide el widget y se mira cuánto mide entonces el hueco. Sin alto
	 * en su CSS, el hueco mide lo mismo que el iframe; si mide otra cosa, es que su CSS se lo pone, y
	 * el iframe lo llena. Todo en la misma vuelta: la web no llega a pintar el alto intermedio.
	 */
	function ajustar(w) {
		w.iframe.style.height = w.pedida + "px";
		// Oculto (en una pestaña, en un menú cerrado): no se puede medir. Se mira al aparecer.
		if (!w.hueco.getClientRects().length) return;
		var alto = Math.round(altoDelHueco(w.hueco));
		if (alto > 0 && Math.abs(alto - w.pedida) > 1) w.iframe.style.height = alto + "px";
	}

	var observador =
		typeof ResizeObserver === "function"
			? new ResizeObserver(function (cambios) {
					for (var c = 0; c < cambios.length; c++) {
						for (var k = 0; k < widgets.length; k++) {
							if (widgets[k].hueco === cambios[c].target) ajustar(widgets[k]);
						}
					}
				})
			: null;

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
		hueco.appendChild(iframe);

		var w = { hueco: hueco, iframe: iframe, pedida: 640 };
		widgets.push(w);
		ajustar(w);
		// Si el hueco cambia de tamaño (llega su CSS, sale de una pestaña oculta, gira el móvil), se
		// vuelve a mirar.
		if (observador) observador.observe(hueco);
	}
	if (!widgets.length) return;

	window.addEventListener("message", function (e) {
		if (e.origin !== origen) return;
		var datos = e.data;
		if (!datos || datos.tipo !== MENSAJE || typeof datos.altura !== "number") return;
		for (var j = 0; j < widgets.length; j++) {
			if (widgets[j].iframe.contentWindow === e.source) {
				widgets[j].pedida = Math.min(Math.max(Math.round(datos.altura), 200), 4000);
				ajustar(widgets[j]);
			}
		}
	});
})();
