/** @vitest-environment jsdom */
// EMPAREJAR-ESPERA: la Handy que espera la aprobación de la Main dejaba de esperar al primer fallo
// que no fuera `not_approved`, también a un 503 o un 429 pasajeros, y volvía a la vinculación con el
// error. Ahora la espera sigue ante lo pasajero y lo dice, y sólo termina con lo que no va a cambiar.
// El rechazo de la Main y el código caducado, que tienen su código, dejan el código por gastado: la
// pantalla lo vacía para que no se vuelva a mandar.
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ESPERA_ENTRE_CONSULTAS_MS } from "../../src/app/arranque/emparejamiento";
import EmparejarHandy from "../../src/app/arranque/EmparejarHandy";
import { useEmparejamientoHandy, type EmparejamientoHandy } from "../../src/app/arranque/useEmparejamientoHandy";

const nube = vi.hoisted(() => ({ respuestas: [] as (() => unknown)[] }));

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../src/shared/observability/sentry", () => ({ captureException: vi.fn() }));

const CLAVE = "P".repeat(44);
const SIN_RED = { code: "external", message: "No se ha podido conectar con el servidor. Comprueba la conexión a internet." };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	localStorage.clear();
	nube.respuestas = [];
	invoke.mockReset();
	invoke.mockImplementation(async (comando: string, args: any) => {
		switch (comando) {
			case "handy_get_tenant":
				return null;
			case "handy_set_token":
				return "OK";
			case "device_get_identity":
				return { deviceId: "h1", devicePubkeyB64: CLAVE };
			case "device_firmar_emparejamiento":
				return { ts: 1, sigB64: "firma" };
			case "tpv_server_post_json": {
				const { path } = args.args;
				if (path === "/v1/pair/claim") return { nonceB64: "reto", nonceExpiresAtMs: 9, caducaEnMs: 60_000 };
				if (path === "/v1/pair/fetch-token") {
					const siguiente = nube.respuestas.shift();
					if (!siguiente) throw { code: "not_approved", message: "pendiente" };
					return siguiente();
				}
				if (path === "/v1/pair/cancel") return { ok: true, liberado: true };
				throw new Error(`ruta inesperada ${path}`);
			}
			default:
				throw new Error(`comando inesperado: ${comando}`);
		}
	});
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

/** Avanza el reloj de Vitest dentro de `act`, para que React pinte lo que haya cambiado. */
const pasar = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

async function esperandoLaAprobacion() {
	const hook = renderHook(() => useEmparejamientoHandy("handy"));
	await pasar(0);
	expect(hook.result.current.estado.step).toBe("idle");
	act(() => hook.result.current.vincular("", "123456"));
	await pasar(0);
	expect(hook.result.current.estado.step).toBe("waiting_approval");
	return hook;
}

describe("la espera de la aprobación", () => {
	it("con la nube sin contestar sigue esperando, lo dice, y entra la aprobación cuando vuelve", async () => {
		nube.respuestas = [
			() => {
				throw SIN_RED;
			},
			() => {
				throw { code: "not_approved", message: "pendiente" };
			},
			() => ({ tenantId: "negocio-1", token: "jwt" }),
		];
		const { result } = await esperandoLaAprobacion();

		await pasar(ESPERA_ENTRE_CONSULTAS_MS);
		expect(result.current.estado.step).toBe("waiting_approval");
		expect(result.current.error).toBeNull();
		expect(result.current.aviso).toContain(SIN_RED.message);

		// Tras un fallo, la siguiente consulta va el doble de espaciada; la nube contesta y el aviso se va.
		await pasar(2 * ESPERA_ENTRE_CONSULTAS_MS);
		expect(result.current.aviso).toBeNull();
		await pasar(ESPERA_ENTRE_CONSULTAS_MS);
		expect(result.current.estado.step).toBe("paired");
		expect(result.current.codigoGastado).toBe(false);
	});

	for (const fallo of [
		{ code: "pair_rejected", message: "El TPV principal ha rechazado la vinculación." },
		{ code: "pair_code_expired", message: "El código de vinculación ha caducado." },
	]) {
		it(`${fallo.code} termina la espera y da el código por gastado`, async () => {
			nube.respuestas = [
				() => {
					throw fallo;
				},
			];
			const { result } = await esperandoLaAprobacion();

			await pasar(ESPERA_ENTRE_CONSULTAS_MS);
			expect(result.current.estado.step).toBe("idle");
			expect(result.current.error).toBe(fallo.message);
			expect(result.current.codigoGastado).toBe(true);
			expect(result.current.aviso).toBeNull();
		});
	}

	it("un intento nuevo deja de dar el código por gastado", async () => {
		nube.respuestas = [
			() => {
				throw { code: "pair_rejected", message: "rechazada" };
			},
		];
		const { result } = await esperandoLaAprobacion();
		await pasar(ESPERA_ENTRE_CONSULTAS_MS);
		expect(result.current.codigoGastado).toBe(true);

		act(() => result.current.vincular("", "654321"));
		await pasar(0);
		expect(result.current.codigoGastado).toBe(false);
		act(() => result.current.cancelar());
	});
});

describe("la pantalla", () => {
	function emparejamiento(cambios: Partial<EmparejamientoHandy> = {}): EmparejamientoHandy {
		return {
			estado: { step: "idle" },
			ocupado: false,
			error: null,
			aviso: null,
			codigoGastado: false,
			huella: "",
			hayVinculoGuardado: false,
			vincular: vi.fn(),
			cancelar: vi.fn(),
			volverAVincular: vi.fn(),
			...cambios,
		};
	}

	it("vacía el código que la Main ha rechazado o que ha caducado", () => {
		const { rerender } = render(<EmparejarHandy emparejamiento={emparejamiento()} volviendo={false} onVolver={vi.fn()} />);
		const codigo = screen.getByLabelText("Código manual");
		fireEvent.change(codigo, { target: { value: "123456" } });
		expect(codigo).toHaveValue("123456");

		rerender(
			<EmparejarHandy
				emparejamiento={emparejamiento({ error: "rechazada", codigoGastado: true })}
				volviendo={false}
				onVolver={vi.fn()}
			/>,
		);
		expect(screen.getByLabelText("Código manual")).toHaveValue("");
		expect(screen.getByRole("alert")).toHaveTextContent("rechazada");
	});

	it("mientras espera, enseña por qué no contesta la nube", () => {
		render(
			<EmparejarHandy
				emparejamiento={emparejamiento({
					estado: { step: "waiting_approval", pairCode: "123456", pairSecret: "", nonceB64: "r", nonceExpiresAtMs: 9 },
					ocupado: true,
					aviso: "La nube no contesta. Se sigue esperando la aprobación.",
				})}
				volviendo={false}
				onVolver={vi.fn()}
			/>,
		);
		expect(screen.getByText("La nube no contesta. Se sigue esperando la aprobación.")).toBeInTheDocument();
	});
});
