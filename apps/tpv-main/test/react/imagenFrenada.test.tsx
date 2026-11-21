/** @vitest-environment jsdom */

// INFRA-03 · Una imagen que el worker frena (429 con `Retry-After: 60`) no se queda en el marcador.
//
// La Handy pide las imágenes al GET público del worker, que tiene un filtro por IP. Un `<img>` no ve el
// código de la respuesta: para él, el 429 es un error más. Los reintentos rápidos de
// `ImageWithFallback` (unos 12 s en total) caían todos dentro de la ventana de un minuto del filtro, y
// después la imagen se quedaba en el marcador hasta remontar la pantalla. Ahora, agotados, pinta el
// marcador y hace uno más pasado el minuto.
//
// jsdom no carga imágenes: el fallo de cada petición se simula con `fireEvent.error`. Los tiempos se
// acortan por props; que el de verdad pase del minuto lo comprueba el último caso. Se espera al
// pintado con `waitFor` por lo que explica la cabecera de `shared-ui.test.tsx`.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ImageWithFallback, { ULTIMO_REINTENTO_MS } from "../../src/shared/ui/ImageWithFallback";

const URL_IMAGEN = "https://worker.test/v1/images/negocio/images/productos/a.jpg";

function pintar(ultimoReintentoMs?: number) {
	return render(
		<ImageWithFallback
			src={URL_IMAGEN}
			alt="Producto"
			fallback={<span>marcador</span>}
			retries={1}
			retryDelayMs={10}
			{...(ultimoReintentoMs === undefined ? {} : { ultimoReintentoMs })}
		/>,
	);
}

/** Espera a que haya un `<img>` distinto de los anteriores (cada reintento lo remonta) y lo devuelve. */
async function siguienteImg(vistas: Set<HTMLElement>, timeout = 2000): Promise<HTMLElement> {
	let img: HTMLElement | null = null;
	await waitFor(
		() => {
			img = screen.queryByAltText("Producto");
			if (!img || vistas.has(img)) throw new Error("aún no hay otro <img>");
		},
		{ timeout },
	);
	vistas.add(img!);
	return img!;
}

describe("INFRA-03 · ImageWithFallback ante una imagen frenada", () => {
	it("agotados los reintentos rápidos pinta el marcador y vuelve a pedir el mismo URL una vez más", async () => {
		pintar(150);
		const vistas = new Set<HTMLElement>();

		const primera = await siguienteImg(vistas);
		expect(primera).toHaveAttribute("src", URL_IMAGEN);
		fireEvent.error(primera);

		// El reintento rápido (el único con `retries={1}`).
		const segunda = await siguienteImg(vistas);
		fireEvent.error(segunda);

		// Agotados: el marcador mientras espera…
		await waitFor(() => expect(screen.getByText("marcador")).toBeInTheDocument());
		expect(screen.queryByAltText("Producto")).toBeNull();

		// …y pasado el último plazo, la misma URL otra vez.
		const tardia = await siguienteImg(vistas);
		expect(tardia).toHaveAttribute("src", URL_IMAGEN);
		expect(screen.queryByText("marcador")).toBeNull();

		// Si ésa también falla, el marcador se queda: no hay más peticiones.
		fireEvent.error(tardia);
		await waitFor(() => expect(screen.getByText("marcador")).toBeInTheDocument());
		await new Promise((r) => setTimeout(r, 400));
		expect(screen.queryByAltText("Producto")).toBeNull();
	});

	it("si la petición tardía carga, se ve la imagen", async () => {
		pintar(100);
		const vistas = new Set<HTMLElement>();
		fireEvent.error(await siguienteImg(vistas));
		fireEvent.error(await siguienteImg(vistas));

		const tardia = await siguienteImg(vistas);
		fireEvent.load(tardia);
		await waitFor(() => expect(screen.getByAltText("Producto")).toBeVisible());
	});

	it("el último reintento, por defecto, cae fuera del minuto del `Retry-After` del worker", () => {
		expect(ULTIMO_REINTENTO_MS).toBeGreaterThan(60_000);
	});
});
