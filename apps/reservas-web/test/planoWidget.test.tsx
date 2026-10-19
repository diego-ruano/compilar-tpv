/** @vitest-environment jsdom */

// El paso 2: los botones de mesas libres son los del salón que se ve, como el plano. Dos salones
// pueden tener cada uno su «Mesa 1», y elegir por un botón no puede reservar la del otro.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import PlanoWidget from "../src/PlanoWidget";
import type { PlanoPublico } from "../src/api";

vi.mock("react-konva", () => {
	const Nada = () => null;
	return { Stage: Nada, Layer: Nada, Rect: Nada, Line: Nada, Group: Nada, Text: Nada, Circle: Nada };
});

afterEach(cleanup);

const mesa = (id: string, id_salon: string, numero: string) => ({
	id,
	id_salon,
	numero,
	forma: "rect",
	x: 0,
	y: 0,
	ancho: 80,
	alto: 80,
	radio: null,
	capacidad: 4,
	reservable: true,
});

const PLANO: PlanoPublico = {
	completo: true,
	salones: [
		{ id: "dentro", nombre: "Interior", puntos: "[]" },
		{ id: "fuera", nombre: "Terraza", puntos: "[]" },
	],
	mesas: [mesa("i1", "dentro", "1"), mesa("t1", "fuera", "1"), mesa("t2", "fuera", "2")],
};

describe("las mesas libres del plano", () => {
	it("son las del salón que se ve, y al cambiar de salón cambian", async () => {
		const elegida = vi.fn();
		render(<PlanoWidget plano={PLANO} libres={["i1", "t1"]} elegida={null} onElegir={elegida} />);

		expect(await screen.findByText("Mesas libres en Interior:")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "Mesa 1 · 4 plazas" })).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Mesa 1 · 4 plazas" }));
		expect(elegida).toHaveBeenLastCalledWith(expect.objectContaining({ id: "i1" }));

		fireEvent.click(screen.getByRole("tab", { name: "Terraza" }));
		fireEvent.click(await screen.findByRole("button", { name: "Mesa 1 · 4 plazas" }));
		expect(elegida).toHaveBeenLastCalledWith(expect.objectContaining({ id: "t1" }));
	});

	it("si en el salón que se ve no queda ninguna, dice dónde hay", async () => {
		render(<PlanoWidget plano={PLANO} libres={["t2"]} elegida={null} onElegir={() => {}} />);
		// Se empieza por el salón que tiene alguna libre…
		expect(await screen.findByText("Mesas libres en Terraza:")).toBeInTheDocument();
		// …y en el otro se dice dónde mirar.
		fireEvent.click(screen.getByRole("tab", { name: "Interior" }));
		expect(await screen.findByText(/ninguna; hay en Terraza\./)).toBeInTheDocument();
	});
});
