import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { leerRuta } from "./logica";
import "./estilos.css";

const raiz = document.getElementById("raiz");
if (raiz) {
	createRoot(raiz).render(
		<StrictMode>
			<App ruta={leerRuta(window.location.pathname, window.location.hash)} />
		</StrictMode>,
	);
}
