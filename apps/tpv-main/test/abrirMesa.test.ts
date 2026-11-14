// test/abrirMesa.test.ts
//
// Abrir una mesa que ya tiene su comanda: ponerle el trabajador sólo si le falta. Con trabajador,
// el backend no cambiaría nada, y aun así era un viaje más (y en la Main, una escritura que se
// replica a la nube y a las Handy). Y abrir la mesa al entrar es un solo comando
// (`mesas_abrir_o_retomar`), que trae la comanda y sus líneas.

import { afterEach, describe, expect, it, vi } from "vitest";

import { mesasAbrirORetomar, mesasEnsureOpenComanda } from "../src/features/mesas/mesasApi";

const backend = vi.hoisted(() => ({ abierta: null as unknown, llamadas: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: async (comando: string, args?: unknown) => {
		backend.llamadas.push(comando);
		switch (comando) {
			case "get_comanda_abierta_by_mesa":
				return backend.abierta;
			case "comanda_set_trabajador_if_null":
				return true;
			case "mesas_abrir_o_retomar":
				return { comanda: { id_comanda: "c1", id_trabajador: "t1" }, lineas: [], args };
			default:
				throw new Error(`comando inesperado: ${comando}`);
		}
	},
}));

afterEach(() => {
	backend.abierta = null;
	backend.llamadas = [];
});

describe("una mesa que ya tiene comanda", () => {
	it("con trabajador, no se le vuelve a poner", async () => {
		backend.abierta = { id_comanda: "c1", id_trabajador: "t1" };
		expect(await mesasEnsureOpenComanda({ idMesa: "m1", idUsuario: "u2", idReserva: null })).toBe("c1");
		expect(backend.llamadas).toEqual(["get_comanda_abierta_by_mesa"]);
	});

	it("sin trabajador, se le pone", async () => {
		backend.abierta = { id_comanda: "c1", id_trabajador: null };
		expect(await mesasEnsureOpenComanda({ idMesa: "m1", idUsuario: "u2", idReserva: null })).toBe("c1");
		expect(backend.llamadas).toEqual(["get_comanda_abierta_by_mesa", "comanda_set_trabajador_if_null"]);
	});
});

it("abrir o retomar la mesa es un solo comando", async () => {
	const r = await mesasAbrirORetomar({ idMesa: " m1 ", idReserva: "r1" });
	expect(r.comanda.id_comanda).toBe("c1");
	expect(backend.llamadas).toEqual(["mesas_abrir_o_retomar"]);
	expect((r as unknown as { args: unknown }).args).toEqual({ args: { id_mesa: "m1", id_reserva: "r1" } });
});
