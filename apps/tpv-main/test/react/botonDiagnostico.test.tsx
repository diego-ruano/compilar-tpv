/** @vitest-environment jsdom */
// OPS-02 · «Guardar diagnóstico…»: pide el paquete al backend, pregunta dónde guardarlo y lo
// escribe tal cual. Avisa de cómo ha ido: a quién mandarlo, si falta alguna parte, o por qué no se
// ha podido guardar. Se sustituyen el IPC, el diálogo y la escritura.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PaqueteDiagnostico } from "@tpv/contracts";

import {
	BotonDiagnostico,
	DIAGNOSTICO_FALLIDO,
	DIAGNOSTICO_GUARDADO,
	textoGuardado,
} from "../../src/shared/ui/BotonDiagnostico";
import { ToastProvider } from "../../src/shared/toast";

const ipc = vi.hoisted(() => ({
	invoke: vi.fn(),
	save: vi.fn(),
	writeFile: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<object>()),
	invoke: ipc.invoke,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: ipc.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: ipc.writeFile }));

const PAQUETE: PaqueteDiagnostico = {
	nombre_fichero: "diagnostico-tpv-20261120-103005.json",
	contenido: '{\n  "formato": "tpv-diagnostico/1"\n}',
	secciones_con_error: [],
};

function responder(paquete: PaqueteDiagnostico | { code: string; message: string }) {
	ipc.invoke.mockImplementation(async (comando: string) => {
		if (comando === "diagnostico_generar_paquete") {
			if ("code" in paquete) throw paquete;
			return paquete;
		}
		// `invocar` cuenta el fallo de un comando por aquí.
		if (comando === "telemetria_fallo_de_comando") return null;
		throw new Error(`comando inesperado: ${comando}`);
	});
}

beforeEach(() => {
	ipc.invoke.mockReset();
	ipc.save.mockReset().mockResolvedValue("D:\\soporte\\diagnostico.json");
	ipc.writeFile.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

async function pulsar() {
	render(
		<ToastProvider>
			<BotonDiagnostico />
		</ToastProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: /Guardar diagnóstico/ }));
}

it("lo guarda donde se elige, tal cual, y dice a quién mandarlo", async () => {
	responder(PAQUETE);
	await pulsar();

	expect(await screen.findByText(textoGuardado(0))).toBeInTheDocument();
	expect(screen.getByText(DIAGNOSTICO_GUARDADO)).toBeInTheDocument();
	expect(ipc.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: PAQUETE.nombre_fichero }));
	expect(ipc.writeFile).toHaveBeenCalledTimes(1);
	const [destino, bytes] = ipc.writeFile.mock.calls[0] as [string, Uint8Array];
	expect(destino).toBe("D:\\soporte\\diagnostico.json");
	expect(new TextDecoder().decode(bytes)).toBe(PAQUETE.contenido);
});

it("si alguna parte no se ha podido leer, lo guarda igual y lo dice", async () => {
	responder({ ...PAQUETE, secciones_con_error: ["base_local", "registro"] });
	await pulsar();

	expect(await screen.findByText(textoGuardado(2))).toBeInTheDocument();
	expect(textoGuardado(2)).toContain("2 partes no se han podido leer");
	expect(ipc.writeFile).toHaveBeenCalledTimes(1);
});

it("si se cancela el diálogo, no escribe nada ni avisa", async () => {
	responder(PAQUETE);
	ipc.save.mockResolvedValue(null);
	await pulsar();

	await waitFor(() => expect(ipc.save).toHaveBeenCalled());
	await waitFor(() => expect(screen.getByRole("button", { name: /Guardar diagnóstico/ })).toBeEnabled());
	expect(ipc.writeFile).not.toHaveBeenCalled();
	expect(screen.queryByText(DIAGNOSTICO_GUARDADO)).toBeNull();
});

it("si el comando falla, avisa con el motivo", async () => {
	responder({ code: "internal", message: "La aplicación no ha terminado de arrancar" });
	await pulsar();

	expect(await screen.findByText(DIAGNOSTICO_FALLIDO)).toBeInTheDocument();
	expect(screen.getByText("La aplicación no ha terminado de arrancar")).toBeInTheDocument();
	expect(ipc.save).not.toHaveBeenCalled();
});

it("si no se puede escribir donde se eligió, avisa con el motivo", async () => {
	responder(PAQUETE);
	ipc.writeFile.mockRejectedValue(new Error("El dispositivo no está preparado"));
	await pulsar();

	expect(await screen.findByText(DIAGNOSTICO_FALLIDO)).toBeInTheDocument();
	expect(screen.getByText("El dispositivo no está preparado")).toBeInTheDocument();
	expect(screen.queryByText(DIAGNOSTICO_GUARDADO)).toBeNull();
});
