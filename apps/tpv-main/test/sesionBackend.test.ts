// apps/tpv-main/test/sesionBackend.test.ts
//
// SEC-01: la sesión ya no vive sólo en el webview. `AppState::sesion` (Rust) es la que
// comprueban los comandos gateados, y este fichero cubre la costura entre las dos.
//
// Lo que se sostiene aquí es que **cerrar sesión cierra las dos**. Si sólo se limpiara el store,
// la UI volvería al login con una sesión de administrador viva detrás — y el cierre por
// inactividad, que pasa por este mismo `logout()`, dejaría el equipo desatendido en ese estado.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invocaciones: Array<{ cmd: string; args: unknown }> = [];
let fallaElComando = false;

vi.mock("@tpv/client", () => ({
	invokeClient: async (cmd: string, args: unknown) => {
		invocaciones.push({ cmd, args });
		if (fallaElComando) throw { code: "internal", message: "IPC caído" };
		return null;
	},
	toAppError: (e: unknown) => e,
	esError: (e: unknown, code: string) => (e as { code?: string })?.code === code,
}));

const { useAuth } = await import("../src/shared/stores/useAuth");
const { esAdmin, esPermisoDenegado } = await import("../src/shared/lib/permisos");

const SESION = {
	role: "Administrador",
	idUsuario: "u1",
	nombre: "Ana",
	idTrabajador: "t1",
	requiresSetup: false,
	email: "ana@bar.example",
};

beforeEach(() => {
	invocaciones.length = 0;
	fallaElComando = false;
	useAuth.setState({ ...SESION });
});

describe("SEC-01 · cerrar sesión cierra las dos", () => {
	it("logout avisa al backend", () => {
		useAuth.getState().logout();

		expect(invocaciones.map((i) => i.cmd)).toContain("logout");
	});

	it("y vacía el store, que es lo que devuelve la UI al login", () => {
		useAuth.getState().logout();

		const s = useAuth.getState();
		expect(s.role).toBe("");
		expect(s.idUsuario).toBeNull();
		expect(s.idTrabajador).toBeNull();
		expect(s.email).toBeNull();
		expect(s.requiresSetup).toBe(false);
	});

	// El store se limpia ANTES de hablar por el IPC, y a propósito: si un fallo del comando
	// pudiera dejar la sesión puesta en pantalla, un error de transporte se convertiría en un
	// equipo que se queda dentro. Que el backend no se entere es peor, pero es recuperable —
	// el arranque del webview vuelve a llamar a `logout`.
	it("el store se vacía aunque el comando falle", async () => {
		fallaElComando = true;

		expect(() => useAuth.getState().logout()).not.toThrow();
		expect(useAuth.getState().role).toBe("");

		// La promesa rechazada se atrapa dentro del store; dejarla suelta sería un
		// unhandled rejection en cada cierre de sesión fallido.
		await Promise.resolve();
	});

	it("logout no es una llamada de ida y vuelta: no bloquea a quien lo llama", () => {
		// `useInactivityLogout` lo invoca desde un `setTimeout`, sin await posible. Si `logout()`
		// devolviera una promesa que hay que esperar, el cierre por inactividad se quedaría a
		// medias sin que nadie lo notara.
		expect(useAuth.getState().logout()).toBeUndefined();
	});
});

describe("SEC-01 · el rol, en un solo sitio", () => {
	it("esAdmin no se cree cualquier cosa", () => {
		expect(esAdmin("Administrador")).toBe(true);
		for (const r of ["administrador", "ADMIN", "Camarero", "", null, undefined]) {
			expect(esAdmin(r as string | null | undefined), `${r}`).toBe(false);
		}
	});

	// Se ramifica por el código, nunca por el texto (ARCH-05): reescribir un mensaje no puede
	// romper en silencio la rama que distingue "no puedes" de "ha fallado".
	it("permiso denegado se reconoce por el código", () => {
		expect(esPermisoDenegado({ code: "permiso_denegado", message: "x" })).toBe(true);
		expect(esPermisoDenegado({ code: "internal", message: "No tienes permiso" })).toBe(false);
		expect(esPermisoDenegado(new Error("permiso_denegado"))).toBe(false);
	});
});
