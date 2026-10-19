// Volver a cargar el widget (sólo el iframe, no la web donde va). Aparte para poder sustituirlo en
// los tests: jsdom no deja tocar `location.reload`.

export function recargarPagina() {
	window.location.reload();
}
