/** @vitest-environment jsdom */
// AUD-23: el «← Volver» de la vinculación de una Handy desvinculaba sin PIN.
//
// «← Vinculación» (siempre a la vista, también encima del login) y «← Ir a vinculación» (en la
// espera de la Main) sólo cambian de pantalla, pero el «← Volver» de la vinculación llamaba a
// `device_reset_mode`, cuyo gate deja pasar sin sesión: cualquiera con la tableta en la mano la
// dejaba sin token ni negocio, y había que volver a vincularla desde la Main. Ahora ir al selector y
// borrar el vínculo son dos cosas: «← Volver» enseña el selector sin tocar nada guardado, «Handy»
// vuelve al vínculo, «TPV» sigue el camino de la activación, un código de otra Main lo sustituye, y
// desvincular es de Configuración → Dispositivo (administrador y confirmación).
//
// Corre el frontend real —AppBoot, App, Login, EmparejarHandy, HandyEsperandoMain, SelectorModo,
// ActivacionLicencia, los hooks del arranque, `useAuth`, `useInactivityLogout` y `@tpv/client`— y
// sustituye sólo el IPC (`invoke`) por un backend de mentira con lo que hacen en Rust esos comandos.
// El último caso lee el fuente de Rust y falla si el modelo deja de ser el del código.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import App from "../../src/app/App";
import AppBoot from "../../src/app/AppBoot";
import { ESPERA_ENTRE_CONSULTAS_MS } from "../../src/app/arranque/emparejamiento";
import { Dispositivo } from "../../src/features/configuracion/sections/Dispositivo";
import { queryClient } from "../../src/shared/lib/queryClient";
import { useAuth } from "../../src/shared/stores/useAuth";
import { useMainPresence, type MotivoRechazo } from "../../src/shared/stores/useMainPresence";
import { useMode } from "../../src/shared/stores/useMode";

type SesionRust = { id_usuario: string; rol: string } | null;
type Vinculo = { token: string; tenant: string };

const { invoke, backend, confirmar } = vi.hoisted(() => {
	const backend = {
		/** `AppState::sesion` */
		sesion: null as SesionRust,
		/** `device_config.json` + `AppState::mode` */
		modo: "handy" as "handy" | "tpv" | null,
		/** `KEY_HANDY_TOKEN` + `KEY_HANDY_TENANT` del almacén de secretos */
		llavero: null as Vinculo | null,
		/** El almacén de secretos no contesta (`ErrorSecreto::NoDisponible`). */
		almacenSinContestar: false,
		/** Cada `device_reset_mode`: con qué sesión llegó y qué devolvió el gate. */
		resets: [] as { sesion: SesionRust; resultado: "OK" | "permiso_denegado" }[],
	};

	const hoy = () => {
		const d = new Date();
		return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
	};

	const invoke = async (comando: string, args?: any): Promise<unknown> => {
		switch (comando) {
			case "get_device_mode":
				return backend.modo;
			case "set_device_mode": // lib.rs: cierra la sesión y guarda el modo; no toca el vínculo
				backend.sesion = null;
				backend.modo = args.args.mode;
				return "OK";
			case "init_main":
				return "OK";
			case "logout": // commands/login.rs: `state.cerrar_sesion()`, sin gate
				backend.sesion = null;
				return null;
			case "device_get_identity":
				return { deviceId: "dev-ficticio", devicePubkeyB64: "A".repeat(44) };
			case "handy_get_tenant": // device.rs `handy_tenant_en`: el almacén sin contestar es un error
				if (backend.almacenSinContestar) {
					throw { code: "external", message: "almacén de secretos no disponible: no contesta" };
				}
				return backend.llavero?.tenant ?? null;
			case "handy_set_token": // commands/pairing.rs: cierra la sesión y sustituye el vínculo
				backend.sesion = null;
				backend.llavero = { token: args.args.token, tenant: args.args.tenant_id };
				return "OK";
			case "device_firmar_emparejamiento":
				return { ts: Date.now(), sigB64: "firma-ficticia" };
			case "tpv_server_post_json":
				if (args.args.path === "/v1/pair/claim") {
					return { nonceB64: "R".repeat(43) + "=", nonceExpiresAtMs: Date.now() + 600_000, caducaEnMs: 600_000 };
				}
				if (args.args.path === "/v1/pair/fetch-token") return { tenantId: "tenant-nuevo", token: "jwt-nuevo" };
				return null;
			case "setup_pendiente":
				return { pendiente: false, requiere_recuperacion: false, id_usuario: null, nombre: null };
			case "recovery_status":
				return { state: "ready" };
			case "list_login_users":
				return [{ id_usuario: "u-cam", nombre: "Lucía", apellido: null, nombre_rol: "Camarero", sin_pin: false }];
			case "get_today_punch_status":
				return { fecha: hoy(), turno_partido: 0, partes: [{ parte: 1, entrada: "09:00", salida: null, estado: "ACTIVO" }] };
			case "login_user":
				if (args?.args?.pin !== "1234") throw { code: "invalid_pin", message: "PIN incorrecto" };
				backend.sesion = { id_usuario: "u-cam", rol: "Camarero" };
				return { id_usuario: "u-cam", id_trabajador: "t-cam", nombre: "Lucía", apellido: null, rol: "Camarero", email: "", requiere_setup: 0 };
			case "permisos_sesion":
				if (!backend.sesion) throw { code: "permiso_denegado", message: "Inicia sesión para hacer esto" };
				return { rol: backend.sesion.rol, permisos: ["servicio.vender"] };
			case "device_reset_mode": {
				// lib.rs → `exigir_rol_si_hay_sesion(&[ADMIN])`: sin sesión, Ok(()).
				const sesion = backend.sesion;
				if (sesion !== null && sesion.rol !== "Administrador") {
					backend.resets.push({ sesion, resultado: "permiso_denegado" });
					throw { code: "permiso_denegado", message: "Esta acción es de Administrador" };
				}
				backend.resets.push({ sesion, resultado: "OK" });
				backend.sesion = null;
				const eraHandy = backend.modo === "handy";
				backend.modo = null;
				if (eraHandy) backend.llavero = null; // device.rs `handy_clear_token`
				return "OK";
			}
			default:
				return null;
		}
	};

	return { invoke: vi.fn(invoke), backend, confirmar: vi.fn(async (_mensaje: string, _opciones?: unknown) => true) };
});

vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: confirmar }));
vi.mock("../../src/shared/lib/useHandySocket", () => ({ useHandySocket: () => {} }));
vi.mock("../../src/shared/lib/useMainSocket", () => ({ useMainSocket: () => {} }));
vi.mock("../../src/shared/lib/useImageUrl", () => ({ useImageUrl: () => "" }));
vi.mock("../../src/shared/ui/UpdateBanner", () => ({ default: () => null }));
vi.mock("../../src/app/layoutComponent/Titlebar", () => ({ default: () => null }));
// La licencia es de la Main: en la Handy no decide nada del arranque. Elegida la Main, el equipo no
// tiene licencia y le toca activarla.
vi.mock("../../src/app/arranque/useLicencia", () => ({
	useLicencia: (modo: string) => ({
		lic: null,
		gate: modo === "tpv" ? { allowed: false, reason: "needs_activation", last_rejection: null, state: null } : "loading",
		refrescarLicencia: async () => {},
		refrescarGate: async () => {},
	}),
}));
// El layout real trae el menú; de él sólo importa su «Cerrar sesión», que llama a `useAuth.logout()`
// igual que `NavBar.handleLogout`.
vi.mock("../../src/app/layouts/layout", async () => {
	const { useAuth: auth } = await import("../../src/shared/stores/useAuth");
	return {
		default: ({ children }: { children: React.ReactNode }) => (
			<div>
				<button type="button" onClick={() => auth.getState().logout()}>
					Cerrar sesión
				</button>
				{children}
			</div>
		),
	};
});

const SELECTOR = /Elige el tipo de equipo que estás configurando/;
const VINCULADA: Vinculo = { token: "jwt-ficticio", tenant: "tenant-ficticio" };

function arrancarHandy(o: { mainOnline: boolean | null; vinculada?: boolean; rechazo?: MotivoRechazo | null }) {
	// Lo que hay al abrir la app: el proceso de Rust empieza sin sesión.
	backend.sesion = null;
	backend.modo = "handy";
	backend.llavero = o.vinculada === false ? null : { ...VINCULADA };
	backend.resets = [];
	useMode.setState({ mode: "loading" });
	useMainPresence.setState({ mainOnline: o.mainOnline, volcando: false, rechazo: o.rechazo ?? null, generacion: 1 });

	const router = createMemoryRouter([
		{ path: "/", element: <App />, children: [{ index: true, element: <p>Venta rápida (ficticia)</p> }] },
	]);
	render(
		<QueryClientProvider client={queryClient}>
			<AppBoot router={router} />
		</QueryClientProvider>,
	);
}

/** El login real de la Handy, sin sesión: la lista de usuarios ya está pintada. */
async function enElLogin() {
	expect((await screen.findAllByText("Lucía")).length).toBeGreaterThan(0);
	expect(screen.queryByText("Venta rápida (ficticia)")).toBeNull();
}

/**
 * Pulsa un botón cuando se puede pulsar, no en cuanto aparece.
 *
 * Una pantalla puede pintarse antes de habilitar sus botones: el modo es un store externo y React
 * pinta su cambio en el acto, pero el `ocupado` que se apaga después de un `await` llega en la tarea
 * siguiente. Entre las dos, «Activa tu TPV» o el selector ya están a la vista con los botones
 * deshabilitados, y un clic ahí se pierde. Se espera a eso, no a un plazo.
 */
async function pulsar(nombre: string | RegExp) {
	const boton = await waitFor(() => {
		const b = screen.getByRole("button", { name: nombre });
		expect(b).toBeEnabled();
		return b;
	});
	fireEvent.click(boton);
}

async function entrarComoCamarero() {
	const usuario = await waitFor(() => {
		const b = screen.getAllByText("Lucía")[0].closest("button")!;
		expect(b).toBeEnabled();
		return b;
	});
	fireEvent.click(usuario);
	// El fichaje cargado y el PIN escrito: «Entrar» se habilita cuando se puede entrar.
	expect((await screen.findAllByText("Fichar salida")).length).toBeGreaterThan(0);
	for (const cifra of ["1", "2", "3", "4"]) await pulsar(cifra);
	await pulsar("Entrar");
	expect(await screen.findByText("Venta rápida (ficticia)")).toBeInTheDocument();
	expect(backend.sesion).toEqual({ id_usuario: "u-cam", rol: "Camarero" });
}

/** «← Vinculación» (o «← Ir a vinculación», o «Vincular de nuevo») y después «← Volver». */
async function alSelector(primero: string) {
	await pulsar(primero);
	expect(await screen.findByText("Conecta este Handy")).toBeInTheDocument();
	await pulsar("← Volver");
	expect(await screen.findByText(SELECTOR)).toBeInTheDocument();
}

async function elegir(modo: "Handy" | "TPV") {
	await pulsar(new RegExp(`Configurar como ${modo}`));
}

/** Nada guardado ha cambiado: ni el vínculo, ni nadie ha llamado a `device_reset_mode`. */
function nadaBorrado() {
	expect(backend.resets).toEqual([]);
	expect(backend.llavero).toEqual(VINCULADA);
}

beforeEach(() => {
	useAuth.setState({ role: "", idUsuario: null, nombre: null, idTrabajador: null, requiresSetup: false, email: null });
	backend.almacenSinContestar = false;
	confirmar.mockClear();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	queryClient.clear();
});

/* ── Con el vínculo vivo, «← Volver» va al selector sin borrar nada, y «Handy» vuelve a él ────── */

it("desde el login, sin sesión, «← Volver» va al selector sin desvincular, y «Handy» vuelve al login", async () => {
	arrancarHandy({ mainOnline: true });
	await enElLogin();

	await alSelector("← Vinculación");
	nadaBorrado();
	expect(backend.modo).toBe("handy"); // ni el modo guardado
	// La tarjeta de Handy dice que vuelve al vínculo, no que haya que vincularla.
	expect(await screen.findByText(/Vuelve a la vinculación de este equipo\./)).toBeInTheDocument();
	expect(screen.queryByText(/Necesitarás vincularlo después/)).toBeNull();

	await elegir("Handy");
	await enElLogin();
	nadaBorrado();
});

it("tras «Cerrar sesión», lo mismo", async () => {
	arrancarHandy({ mainOnline: true });
	await enElLogin();
	await entrarComoCamarero();
	await pulsar("Cerrar sesión");
	await enElLogin();
	await waitFor(() => expect(backend.sesion).toBeNull());

	await alSelector("← Vinculación");
	nadaBorrado();

	await elegir("Handy");
	await enElLogin();
});

it("tras 10 minutos sin tocarla (cierre por inactividad), tampoco la desvinculan", async () => {
	arrancarHandy({ mainOnline: true });
	await enElLogin();
	await entrarComoCamarero();

	// El temporizador de inactividad se reprograma con la primera actividad: desde aquí, falso.
	vi.useFakeTimers({ shouldAdvanceTime: true });
	fireEvent.pointerDown(window);
	act(() => vi.advanceTimersByTime(10 * 60_000 + 1_000));
	await enElLogin();
	await waitFor(() => expect(backend.sesion).toBeNull());
	vi.useRealTimers();

	await alSelector("← Vinculación");
	nadaBorrado();
});

it("con sesión de camarero, «← Volver» la cierra y va al selector; el vínculo sigue", async () => {
	arrancarHandy({ mainOnline: true });
	await enElLogin();
	await entrarComoCamarero();

	await alSelector("← Vinculación");
	nadaBorrado();
	await waitFor(() => expect(backend.sesion).toBeNull());
	expect(useAuth.getState().role).toBe("");

	await elegir("Handy");
	await enElLogin();
});

it("desde la espera a pantalla completa, «← Volver» va al selector y «Handy» vuelve a la espera", async () => {
	arrancarHandy({ mainOnline: false });
	expect(await screen.findByText("La Main no está activa")).toBeInTheDocument();

	await alSelector("← Ir a vinculación");
	nadaBorrado();

	await elegir("Handy");
	expect(await screen.findByText("La Main no está activa")).toBeInTheDocument();
	nadaBorrado();
});

it("con la espera encima del login (la Main se apaga), lo mismo", async () => {
	arrancarHandy({ mainOnline: true });
	await enElLogin();
	act(() => useMainPresence.setState({ mainOnline: false }));
	expect(await screen.findByText("La Main no está activa")).toBeInTheDocument();

	await alSelector("← Ir a vinculación");
	nadaBorrado();
});

/* ── La Main desaparece: hay salida, y el vínculo sigue hasta que se sustituye ───────────────── */

it("sin Main, se puede probar el camino de la Main y volver: el vínculo sigue ahí", async () => {
	arrancarHandy({ mainOnline: false });
	expect(await screen.findByText("La Main no está activa")).toBeInTheDocument();
	await alSelector("← Ir a vinculación");

	await elegir("TPV");
	expect(await screen.findByText("Activa tu TPV")).toBeInTheDocument();
	expect(backend.modo).toBe("tpv");
	nadaBorrado();

	// El «← Volver» de la activación pone el modo a cero, pero el de la Main: el vínculo no lo toca.
	await pulsar("← Volver");
	expect(await screen.findByText(SELECTOR)).toBeInTheDocument();
	expect(backend.resets).toEqual([{ sesion: null, resultado: "OK" }]);
	expect(backend.llavero).toEqual(VINCULADA);

	await elegir("Handy");
	expect(await screen.findByText("La Main no está activa")).toBeInTheDocument();
	expect(backend.llavero).toEqual(VINCULADA);
});

it("sin Main, el código de otra Main sustituye el vínculo, y sólo entonces", async () => {
	arrancarHandy({ mainOnline: false });
	expect(await screen.findByText("La Main no está activa")).toBeInTheDocument();
	await alSelector("← Ir a vinculación");
	await elegir("Handy");
	expect(await screen.findByText("La Main no está activa")).toBeInTheDocument();
	nadaBorrado();

	await pulsar("← Ir a vinculación");
	expect(await screen.findByText("Conecta este Handy")).toBeInTheDocument();
	fireEvent.change(screen.getByLabelText("Código manual"), { target: { value: "654321" } });
	vi.useFakeTimers({ shouldAdvanceTime: true });
	await pulsar("Vincular dispositivo");
	expect(await screen.findByText("Esperando aprobación en el TPV…")).toBeInTheDocument();
	nadaBorrado();

	await act(async () => {
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);
	});
	await waitFor(() => expect(backend.llavero).toEqual({ token: "jwt-nuevo", tenant: "tenant-nuevo" }));
	expect(backend.resets).toEqual([]);
});

/* ── Rechazada por la nube, sin vincular o ilegible ───────────────────────────────────────────── */

it.each([
	["dispositivo", "Este dispositivo ya no tiene acceso", "Vincular de nuevo"],
	["licencia", "La licencia del negocio no está activa", "← Ir a vinculación"],
] as const)("una Handy rechazada por la nube (%s) va al selector sin pedir nada", async (rechazo, titulo, boton) => {
	arrancarHandy({ mainOnline: null, rechazo });
	expect(await screen.findByText(titulo)).toBeInTheDocument();

	await alSelector(boton);

	expect(confirmar).not.toHaveBeenCalled();
	nadaBorrado();
	await elegir("Handy");
	expect(await screen.findByText(titulo)).toBeInTheDocument();
});

it("una Handy sin vincular (primer arranque) va al selector y vuelve a la vinculación", async () => {
	arrancarHandy({ mainOnline: null, vinculada: false });
	expect(await screen.findByText("Conecta este Handy")).toBeInTheDocument();

	await pulsar("← Volver");
	expect(await screen.findByText(SELECTOR)).toBeInTheDocument();
	expect(backend.resets).toEqual([]);
	expect(await screen.findByText(/Necesitarás vincularlo después\./)).toBeInTheDocument();
	expect(screen.queryByText(/Vuelve a la vinculación de este equipo/)).toBeNull();

	await elegir("Handy");
	expect(await screen.findByText("Conecta este Handy")).toBeInTheDocument();
});

it("si el almacén no contesta, no se toma por una Handy sin vincular: lo dice y no borra nada", async () => {
	backend.almacenSinContestar = true;
	arrancarHandy({ mainOnline: true });

	expect(await screen.findByRole("alert")).toHaveTextContent(
		/No se ha podido leer la vinculación guardada de este Handy: almacén de secretos no disponible/,
	);
	await pulsar("← Volver");
	expect(await screen.findByText(SELECTOR)).toBeInTheDocument();
	nadaBorrado();

	// En cuanto contesta, «Handy» vuelve al vínculo sin pedir un código.
	backend.almacenSinContestar = false;
	await elegir("Handy");
	await enElLogin();
	nadaBorrado();
});

/* ── Desvincular de verdad: Configuración → Dispositivo ────────────────────────────────────── */

it("desde Configuración → Dispositivo, el administrador la desvincula tras confirmar", async () => {
	backend.sesion = { id_usuario: "u-adm", rol: "Administrador" };
	backend.modo = "handy";
	backend.llavero = { ...VINCULADA };
	backend.resets = [];
	useMode.setState({ mode: "handy" });

	render(<Dispositivo darkMode={false} />);
	await pulsar("Desvincular este dispositivo");

	await waitFor(() => expect(useMode.getState().mode).toBeNull());
	expect(confirmar).toHaveBeenCalledTimes(1);
	expect(backend.resets).toEqual([{ sesion: { id_usuario: "u-adm", rol: "Administrador" }, resultado: "OK" }]);
	expect(backend.llavero).toBeNull();
	expect(backend.modo).toBeNull();
});

/* ── El modelo ─────────────────────────────────────────────────────────────────────────────── */

it("el backend de mentira es el del fuente de Rust", () => {
	const aqui = dirname(fileURLToPath(import.meta.url));
	const leer = (ruta: string) => readFileSync(resolve(aqui, ruta), "utf8").replace(/\r\n/g, "\n");
	const lib = leer("../../src-tauri/src/lib.rs");
	const login = leer("../../src-tauri/src/commands/login.rs");
	const pairing = leer("../../src-tauri/src/commands/pairing.rs");
	const device = leer("../../../../crates/tpv-infra-licensing/src/device.rs");

	const cuerpo = (fuente: string, desde: string, hasta: string) => {
		const i = fuente.indexOf(desde);
		expect(i, desde).toBeGreaterThan(-1);
		const j = fuente.indexOf(hasta, i + desde.length);
		expect(j, hasta).toBeGreaterThan(i);
		return fuente.slice(i, j);
	};

	// Gate blando: sin sesión, Ok(()); con sesión, el rol.
	const gate = cuerpo(lib, "pub(crate) async fn exigir_rol_si_hay_sesion(", "/// Establece la sesión.");
	expect(gate).toMatch(/if self\.sesion\.lock\(\)\.await\.is_none\(\) \{\s*return Ok\(\(\)\);\s*\}/);
	expect(gate).toContain("self.exigir_rol(permitidos)");

	// `device_reset_mode`: el gate blando de administrador, y después sesión fuera, modo a None y,
	// si era Handy, token y negocio fuera.
	const reset = cuerpo(lib, "async fn device_reset_mode(", "#[tauri::command]");
	expect(reset).toContain("state.exigir_rol_si_hay_sesion(&[ADMIN]).await?;");
	expect(reset).toContain("state.cerrar_sesion().await;");
	expect(reset).toContain("cfg.mode = None;");
	expect(reset).toMatch(/if was_handy \{\s*let _ = PairingAdapter::new\(app_data_dir\)\.handy_clear_token\(\);/);

	// `set_device_mode`: cierra la sesión y guarda el modo, sin tocar el vínculo.
	const modo = cuerpo(lib, "async fn set_device_mode(", "#[tauri::command]");
	expect(modo).toContain("state.cerrar_sesion().await;");
	expect(modo).toContain("cfg.mode = Some(args.mode);");
	expect(modo).not.toMatch(/handy_clear_token|handy_set_token/);

	// `handy_set_token` cierra la sesión y sustituye el vínculo.
	const sustituir = cuerpo(pairing, "pub async fn handy_set_token(", "#[tauri::command]");
	expect(sustituir).toContain("state.cerrar_sesion().await;");
	expect(sustituir).toContain("uc::handy_set_token(&service, args)?;");

	// `logout` no exige nada y deja la sesión en None.
	const logout = cuerpo(login, "pub async fn logout(", "#[tauri::command]");
	expect(logout).toContain("state.cerrar_sesion().await;");
	expect(logout).not.toMatch(/exigir_|state\.sesion\(\)/);

	// `handy_get_tenant`: el almacén sin contestar es un error, no «no hay vínculo».
	const tenant = cuerpo(device, "fn handy_tenant_en(", "\n}\n");
	expect(tenant).toMatch(/Err\(e @ ErrorSecreto::NoDisponible\(_\)\) => Err\(e\.to_string\(\)\)/);

	// `handy_clear_token` borra el token y el negocio de la Handy.
	const borrar = cuerpo(device, "pub fn handy_clear_token()", "pub fn handy_get_tenant()");
	expect(borrar).toContain("secret_store::delete(SVC_AUTH, KEY_HANDY_TOKEN)");
	expect(borrar).toContain("secret_store::delete(SVC_AUTH, KEY_HANDY_TENANT)");
});
