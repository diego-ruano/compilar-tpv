/** @vitest-environment jsdom */

// Tests de los componentes base compartidos.
//
// ⚠️ Se renderiza con `pintar()` y no con `render()` a secas. El motivo no es de estilo:
//
// Bajo Vitest, el `react` que carga Testing Library (CommonJS, por `require`) y el que resuelve el
// grafo de Vite para este fichero son DOS INSTANCIAS distintas del mismo 19.2.7. `act()` encola el
// trabajo en la de una y `react-dom` mira la de la otra, así que el vaciado SÍNCRONO no ocurre:
// `render()` vuelve con el contenedor vacío y React avisa de que "an update to Root was not wrapped
// in act(...)". Se comprobó cargando las dos por CommonJS, y ahí `act` vacía perfectamente.
//
// Lo que NO está roto es React: el pintado ocurre, sólo que de forma asíncrona. Así que se espera a
// él —que es para lo que existen las consultas asíncronas de Testing Library— y a partir de ahí las
// comprobaciones son las mismas de siempre. Vale para estos componentes porque todo lo que
// comprueban son props: no hay estado que se actualice después del primer pintado. Un componente
// con estado necesitaría envolver cada interacción en un `await waitFor(...)`, y llegado ese punto
// lo que hay que arreglar es el grafo de módulos, no el test.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import Badge from "../../src/shared/ui/Badge";
import Button from "../../src/shared/ui/Button";
import Card from "../../src/shared/ui/Card";
import Input from "../../src/shared/ui/Input";

/** Renderiza y espera al primer pintado (ver la nota de arriba). */
async function pintar(ui: ReactElement) {
	const utils = render(ui);
	await esperarPintado(utils.container);
	return utils;
}

async function esperarPintado(container: HTMLElement) {
	await waitFor(() => {
		if (!container.firstChild) throw new Error("React todavía no ha pintado");
	});
}

describe("componentes base compartidos", () => {
	it("Button propaga eventos, atributos y la referencia", async () => {
		const onClick = vi.fn();
		const ref = { current: null as HTMLButtonElement | null };
		await pintar(<Button ref={ref} onClick={onClick}>Guardar</Button>);

		const button = screen.getByRole("button", { name: "Guardar" });
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledOnce();
		expect(ref.current).toBe(button);
		expect(button).toHaveAttribute("type", "button");
	});

	it("Button deshabilita la interacción mientras carga", async () => {
		const onClick = vi.fn();
		const { container } = await pintar(
			<Button loading onClick={onClick} leftIcon={<span>izquierda</span>} rightIcon={<span>derecha</span>}>
				Guardando
			</Button>,
		);

		const button = screen.getByRole("button", { name: "Guardando" });
		expect(button).toBeDisabled();
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		expect(screen.queryByText("izquierda")).not.toBeInTheDocument();
		expect(screen.queryByText("derecha")).not.toBeInTheDocument();
		fireEvent.click(button);
		expect(onClick).not.toHaveBeenCalled();
	});

	it("Button aplica variante, tamaño, ancho y clases personalizadas", async () => {
		await pintar(<Button variant="danger" size="lg" fullWidth className="clase-extra">Borrar</Button>);
		expect(screen.getByRole("button", { name: "Borrar" })).toHaveClass(
			"bg-danger",
			"h-12",
			"w-full",
			"clase-extra",
		);
	});

	it("Input reenvía atributos, referencia y estado inválido", async () => {
		const ref = { current: null as HTMLInputElement | null };
		await pintar(<Input ref={ref} aria-label="Nombre" invalid disabled defaultValue="Ada" />);
		const input = screen.getByLabelText("Nombre");
		expect(input).toBeDisabled();
		expect(input).toHaveValue("Ada");
		expect(input).toHaveClass("border-danger");
		expect(ref.current).toBe(input);
	});

	it("Badge representa el tono y conserva atributos HTML", async () => {
		await pintar(<Badge tone="success" data-testid="estado" className="extra">Activo</Badge>);
		expect(screen.getByTestId("estado")).toHaveTextContent("Activo");
		expect(screen.getByTestId("estado")).toHaveClass("bg-success-soft", "extra");
	});

	it("Card permite controlar padding e interacción", async () => {
		await pintar(<Card padded={false} interactive data-testid="card">Contenido</Card>);
		const card = screen.getByTestId("card");
		expect(card).not.toHaveClass("p-4");
		expect(card).toHaveClass("cursor-pointer");
		expect(card).toHaveTextContent("Contenido");
	});
});
