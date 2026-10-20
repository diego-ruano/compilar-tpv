/** @vitest-environment jsdom */

// Con el dedo sobre el plano se puede desplazar la página. Konva cancela el toque en sus figuras
// (`preventDefault`, que viene activado), y en el widget, metido en la web de un restaurante, un dedo
// en el plano no bajaba ni el widget ni la página. El widget lo apaga en todas sus figuras; la sala de
// la Main lo deja como siempre.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AspectoMesa, SalonPlano } from "@tpv/plano";

// Cada figura que se pide dibujar, con sus propiedades.
const figuras = vi.hoisted(() => [] as { tipo: string; props: Record<string, unknown> }[]);
vi.mock("react-konva", () => {
	const figura = (tipo: string) => (props: Record<string, unknown>) => {
		figuras.push({ tipo, props });
		return (props.children as never) ?? null;
	};
	const contenedor = (props: { children?: unknown }) => (props.children as never) ?? null;
	return {
		Stage: contenedor,
		Layer: contenedor,
		Group: contenedor,
		Rect: figura("Rect"),
		Line: figura("Line"),
		Circle: figura("Circle"),
		Text: figura("Text"),
	};
});

const { Lienzo } = await import("@tpv/plano");

afterEach(() => {
	cleanup();
	figuras.length = 0;
});

const SALON: SalonPlano = {
	id: "s1",
	name: "Interior",
	room: { points: [0, 0, 400, 0, 400, 300, 0, 300] },
	tables: [
		{ id: "m1", name: "1", x: 10, y: 10, width: 80, height: 80, radius: null, seats: 4, shape: "rect" },
		{ id: "m2", name: "2", x: 200, y: 10, width: 90, height: 90, radius: 45, seats: 2, shape: "circle" },
	],
};

const ASPECTO: AspectoMesa = {
	relleno: "#016ffc",
	borde: "#016ffc",
	grosorBorde: 1,
	texto: "#fff",
	subtexto: "#fff",
	etiqueta: "1",
	subetiqueta: "4 plazas",
	pulsable: true,
};

function dibujar(dejarDesplazar?: boolean) {
	render(
		<Lienzo
			salon={SALON}
			tamano={{ width: 400, height: 300 }}
			vista={{ x: 0, y: 0, scale: 1 }}
			fondo="#fff"
			bordeSalon="#000"
			aspecto={() => ASPECTO}
			dejarDesplazar={dejarDesplazar}
		/>,
	);
}

describe("el toque sobre el plano", () => {
	it("con `dejarDesplazar`, ninguna figura lo cancela: ni el fondo, ni la sala, ni las mesas ni sus textos", () => {
		dibujar(true);
		expect(new Set(figuras.map((f) => f.tipo))).toEqual(new Set(["Rect", "Line", "Circle", "Text"]));
		expect(figuras.filter((f) => f.props.preventDefault !== false)).toEqual([]);
	});

	it("sin él (la sala de la Main), Konva hace lo de siempre", () => {
		dibujar();
		expect(figuras.length).toBeGreaterThan(0);
		expect(figuras.filter((f) => "preventDefault" in f.props)).toEqual([]);
	});
});
