// La página de la casilla de Turnstile del SDK (`verificar.html`): la monta con lo que trae la página.
// Qué hace y por qué es segura, en `casilla.ts`.

import { montarCasilla } from "./casilla";
import "./verificar.css";

montarCasilla({
	casilla: document.getElementById("casilla"),
	// La pone el worker al servir la página (`widget.routes.ts`).
	sitekey: document.querySelector('meta[name="turnstile"]')?.getAttribute("content") ?? "",
	destino: new URLSearchParams(window.location.search).get("origen") ?? "",
	ventana: window,
	padre: window.parent,
});
