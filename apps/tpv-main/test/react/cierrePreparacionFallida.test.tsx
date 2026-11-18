/** @vitest-environment jsdom */
// Si la preparación del cierre falla, la cabecera no puede decir «Primer cierre: no hay ninguno
// anterior»: no se sabe. Se enseña el error. Corre el modal de verdad; sólo se sustituye el IPC.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import CierreCajaModal from "../../src/features/cuentas/CierreCajaModal";

vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: async (comando: string) => {
		if (comando !== "cierre_preparar") throw new Error(`comando inesperado: ${comando}`);
		throw { code: "repository", message: "No se ha podido leer la caja." };
	},
}));

afterEach(() => cleanup());

it("con la preparación fallida enseña el error y no dice que es el primer cierre", async () => {
	render(<CierreCajaModal open onClose={() => {}} />);
	expect(await screen.findByText("No se ha podido leer la caja.")).toBeTruthy();
	expect(screen.queryByText(/Primer cierre/)).toBeNull();
});
