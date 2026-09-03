/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Badge from "../../src/shared/ui/Badge";
import Button from "../../src/shared/ui/Button";
import Card from "../../src/shared/ui/Card";
import EmptyState from "../../src/shared/ui/EmptyState";
import Input from "../../src/shared/ui/Input";
import SectionHeader from "../../src/shared/ui/SectionHeader";

describe("componentes base compartidos", () => {
	it("Button propaga eventos, atributos y la referencia", () => {
		const onClick = vi.fn();
		const ref = { current: null as HTMLButtonElement | null };
		render(<Button ref={ref} onClick={onClick}>Guardar</Button>);

		const button = screen.getByRole("button", { name: "Guardar" });
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledOnce();
		expect(ref.current).toBe(button);
		expect(button).toHaveAttribute("type", "button");
	});

	it("Button deshabilita la interacción mientras carga", () => {
		const onClick = vi.fn();
		const { container } = render(
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

	it("Button aplica variante, tamaño, ancho y clases personalizadas", () => {
		render(<Button variant="danger" size="lg" fullWidth className="clase-extra">Borrar</Button>);
		expect(screen.getByRole("button", { name: "Borrar" })).toHaveClass(
			"bg-danger",
			"h-12",
			"w-full",
			"clase-extra",
		);
	});

	it("Input reenvía atributos, referencia y estado inválido", () => {
		const ref = { current: null as HTMLInputElement | null };
		render(<Input ref={ref} aria-label="Nombre" invalid disabled defaultValue="Ada" />);
		const input = screen.getByLabelText("Nombre");
		expect(input).toBeDisabled();
		expect(input).toHaveValue("Ada");
		expect(input).toHaveClass("border-danger");
		expect(ref.current).toBe(input);
	});

	it("Badge representa el tono y conserva atributos HTML", () => {
		render(<Badge tone="success" data-testid="estado" className="extra">Activo</Badge>);
		expect(screen.getByTestId("estado")).toHaveTextContent("Activo");
		expect(screen.getByTestId("estado")).toHaveClass("bg-success-soft", "extra");
	});

	it("Card permite controlar padding e interacción", () => {
		render(<Card padded={false} interactive data-testid="card">Contenido</Card>);
		const card = screen.getByTestId("card");
		expect(card).not.toHaveClass("p-4");
		expect(card).toHaveClass("cursor-pointer");
		expect(card).toHaveTextContent("Contenido");
	});

	it("SectionHeader muestra sólo las zonas opcionales recibidas", () => {
		const { rerender } = render(<SectionHeader title="Inventario" />);
		expect(screen.getByRole("heading", { name: "Inventario" })).toBeInTheDocument();
		expect(screen.queryByText("Resumen")).not.toBeInTheDocument();

		rerender(<SectionHeader title="Inventario" subtitle="Resumen" actions={<button>Crear</button>} />);
		expect(screen.getByText("Resumen")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Crear" })).toBeInTheDocument();
	});

	it("EmptyState compone icono, descripción y acción", () => {
		render(
			<EmptyState
				icon={<span data-testid="icono" />}
				title="Sin productos"
				description="Añade el primero"
				action={<button>Nuevo</button>}
			/>,
		);
		expect(screen.getByTestId("icono")).toBeInTheDocument();
		expect(screen.getByText("Sin productos")).toBeInTheDocument();
		expect(screen.getByText("Añade el primero")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Nuevo" })).toBeInTheDocument();
	});
});
