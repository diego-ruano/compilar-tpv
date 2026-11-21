// test/subidaCompleta.test.ts
//
// DO-SUBIDA · La Main sube su base entera a una nube que soporte le ha devuelto en modo «main»
// (`tenantHub.subida.ts`). Contra un TenantHub de verdad, con la Main y una Handy conectadas por
// sockets reales:
//
//   · la petición se apunta con el log (base vacía, copia o vuelta a un instante en modo main) y se
//     borra en modo nube; la vuelta a un instante echa a quien ya estaba dentro, y su `hello_ok`
//     siguiente lleva la petición, sólo para la Main de la petición (otra Main la deja huérfana);
//   · las páginas insertan y actualizan sólo lo distinto, nunca borran ni pisan lo fiscal, no tocan
//     el log ni difunden filas, y al acabar una tabla avisan a las Handy;
//   · lo que no es la forma de una página de la Main se rechaza como permanente, sin tocar nada;
//   · lo de una Handy por encima del checkpoint de la página la aplaza;
//   · el presupuesto: no gasta el de la hora del negocio (AUD-36), tiene el suyo por hora (pasajero)
//     y un techo total (permanente: la deja `agotada`, y la reabre la administración);
//   · una página con una fila mala entra entera menos esa fila;
//   · huellas y tramos dicen qué falta o es distinto arriba;
//   · `fin`, la caducidad y las copias protegidas de la poda.

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { enElHub } from "./helpers/hub";
import { montarMainEnElHub } from "./helpers/mainEnElHub";
import { laMainEs } from "./helpers/mainVigente";
import { Canonico, hex64, SumaDeTramo } from "../src/domains/sync/resumenCubos";
import { apuntarGasto, gastadoEnLaHora } from "../src/durableObjects/tenantHub.presupuesto";
import { claveDeCopia, podarCopias } from "../src/durableObjects/tenantHub.copia";
import {
	LIMITES_DE_SUBIDA,
	PLAZO_DE_SUBIDA_MS,
	copiasProtegidasDesde,
	ejecutarPasoDeSubida,
	leerSubida,
	pedirSubida,
	reabrirSubida,
	sentenciaDeSubida,
	sinEmpezarParaAvisar,
} from "../src/durableObjects/tenantHub.subida";

vi.setConfig({ testTimeout: 60_000 });

const MAIN = "main-subida";
const ahoraCliente = () => new Date().toISOString().slice(0, 19).replace("T", " ");

let pasos = 0;

/** Manda un paso de la subida por el socket de la Main y devuelve su acuse. */
async function paso(hub: any, m: any, cuerpo: Record<string, unknown>, socket = m.main): Promise<any> {
	const pasoId = `p-${++pasos}`;
	const acuse = socket.esperar((x: any) => x.type === "subida_ack" && x.pasoId === pasoId, 15_000);
	await hub.webSocketMessage(socket.servidor, JSON.stringify({ type: "subida", pasoId, ...cuerpo }));
	return acuse;
}

/** Un negocio con su Main y una Handy dentro, y una petición de subida de esa Main. */
async function conSubida(hub: any, tenant: string, origen: "copia" | "base_vacia" | "instante" = "copia") {
	const m = await montarMainEnElHub(hub, tenant, { main: MAIN, recovering: false });
	pedirSubida(m.sql, { id: "s1", origen, mainDeviceId: MAIN, inicioSeq: 0, ahoraMs: Date.now() });
	return m;
}

const cliente = (id: string, nombre: string, total = 0) => [id, nombre, total];
const COLS_CLIENTE = ["ID_Cliente", "Nombre", "Total_Gastado"];

/** Un `tpv` que saluda de verdad (con la firma y la base central sustituidas). Devuelve su `hello_ok`. */
async function saludaLaMain(hub: any, tenant: string, deviceId = MAIN): Promise<{ servidor: WebSocket; hello: any }> {
	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [deviceId]);
	par[1].serializeAttachment({ tenantId: tenant, deviceId, role: "tpv", authed: false, pubkeyB64: null, challenge: { nonceB64: "n", expiresAtMs: Date.now() + 60_000 }, recovering: true });
	const recibidos: any[] = [];
	par[0].accept();
	par[0].addEventListener("message", (ev: MessageEvent) => {
		recibidos.push(JSON.parse(String(ev.data)));
	});
	hub.verifyHelloSigned = async () => ({ roleFinal: "tpv", pubkeyB64: "x" });
	hub.mainEnCentral = async () => deviceId;
	hub.touchLastSeen = async () => {};
	await hub.webSocketMessage(par[1], JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s", recovering: true }));
	await vi.waitFor(() => expect(recibidos.some((x) => x.type === "hello_ok")).toBe(true), { timeout: 10_000 });
	return { servidor: par[1], hello: recibidos.find((x) => x.type === "hello_ok") };
}

describe("DO-SUBIDA · la petición", () => {
	it("una base vacía en modo main la pide sin dueño, en la misma transacción que abre el log; en modo nube no", async () => {
		await enElHub("subida-base-vacia-main", async (hub: any) => {
			const r = await hub.crearBaseVacia({ tenantId: "subida-base-vacia-main", modo: "main" });
			expect(r.ok).toBe(true);
			const p = leerSubida(hub.state.storage.sql)!;
			expect(p).toMatchObject({ estado: "esperando", origen: "base_vacia", mainDeviceId: null, inicioSeq: r.inicio });
			// El id es el del cambio vacío que abre el log.
			const log = hub.state.storage.sql.exec("SELECT Op_Id FROM Sync_Changes WHERE Seq = ?1;", r.inicio).one();
			expect(log.Op_Id).toBe(p.id);
		});
		await enElHub("subida-base-vacia-nube", async (hub: any) => {
			const r = await hub.crearBaseVacia({ tenantId: "subida-base-vacia-nube", modo: "nube" });
			expect(r.ok).toBe(true);
			expect(leerSubida(hub.state.storage.sql)).toBeNull();
		});
	});

	it("la Main que saluda mientras se llena la base vacía no se queda sin la petición: se la echa al acabar", async () => {
		await enElHub("subida-base-vacia-saludo", async (hub: any) => {
			const t = "subida-base-vacia-saludo";
			// La Main reconecta mientras se llena la base (el PIN del administrador, la copia de R2).
			const crear = hub.crearBase.bind(hub);
			let entretanto: { servidor: WebSocket; hello: any } | null = null;
			hub.crearBase = async (tenant: string) => {
				await crear(tenant);
				entretanto = await saludaLaMain(hub, t);
			};
			const r = await hub.crearBaseVacia({ tenantId: t, modo: "main" });
			expect(r.ok).toBe(true);
			// Su saludo salió sin la petición, que aún no existía...
			expect(entretanto!.hello.subida).toBeUndefined();
			// ...así que esa sesión no puede seguir: vuelve a saludar y entonces la recibe.
			expect(entretanto!.servidor.readyState).not.toBe(1);
			const otra = await saludaLaMain(hub, t);
			expect(otra.hello.subida).toEqual({ id: leerSubida(hub.state.storage.sql)!.id, estado: "esperando", origen: "base_vacia" });
		});
	});

	it("la vuelta a un instante en modo main echa a quien ya estaba, y el hello_ok de su Main lleva la petición", async () => {
		await enElHub("subida-instante", async (hub: any) => {
			const t = "subida-instante";
			const m = await montarMainEnElHub(hub, t, { main: MAIN, recovering: false });
			const r = await hub.trasVolver({ tenantId: t, seqAntes: 0, modo: "main" });
			expect(r.ok).toBe(true);
			expect(m.main.servidor.readyState).not.toBe(1);
			expect(leerSubida(m.sql)).toMatchObject({ estado: "esperando", origen: "instante", mainDeviceId: null });

			// Vuelve a saludar.
			const par = new WebSocketPair();
			hub.state.acceptWebSocket(par[1], [MAIN]);
			par[1].serializeAttachment({ tenantId: t, deviceId: MAIN, role: "tpv", authed: false, pubkeyB64: null, challenge: { nonceB64: "n", expiresAtMs: Date.now() + 60_000 }, recovering: true });
			const recibidos: any[] = [];
			par[0].accept();
			par[0].addEventListener("message", (ev: MessageEvent) => {
				recibidos.push(JSON.parse(String(ev.data)));
			});
			hub.verifyHelloSigned = async () => ({ roleFinal: "tpv", pubkeyB64: "x" });
			laMainEs(hub, MAIN);
			await hub.webSocketMessage(par[1], JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s", recovering: true }));
			await vi.waitFor(() => expect(recibidos.some((x) => x.type === "hello_ok")).toBe(true), { timeout: 10_000 });
			const hello = recibidos.find((x) => x.type === "hello_ok");
			expect(hello.subida).toEqual({ id: leerSubida(m.sql)!.id, estado: "esperando", origen: "instante" });

			// Una Handy no la ve nunca.
			const h = new WebSocketPair();
			hub.state.acceptWebSocket(h[1], ["handy-x"]);
			h[1].serializeAttachment({ tenantId: t, deviceId: "handy-x", role: "handy", authed: false, pubkeyB64: null, challenge: { nonceB64: "n", expiresAtMs: Date.now() + 60_000 } });
			const deLaHandy: any[] = [];
			h[0].accept();
			h[0].addEventListener("message", (ev: MessageEvent) => {
				deLaHandy.push(JSON.parse(String(ev.data)));
			});
			hub.verifyHelloSigned = async () => ({ roleFinal: "handy", pubkeyB64: "x" });
			await hub.webSocketMessage(h[1], JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }));
			await vi.waitFor(() => expect(deLaHandy.some((x) => x.type === "hello_ok")).toBe(true), { timeout: 10_000 });
			expect(deLaHandy.find((x) => x.type === "hello_ok").subida).toBeUndefined();
		});
	});

	it("la vuelta a un instante no ata la petición a la Main de entonces: la Main de ahora la recibe", async () => {
		await enElHub("subida-instante-traslado", async (hub: any) => {
			const t = "subida-instante-traslado";
			const m = await montarMainEnElHub(hub, t, { main: MAIN, recovering: false });
			// La tabla de la Main vigente ha vuelto al instante con todo lo demás: nombra al equipo de
			// antes de un traslado de licencia.
			laMainEs(hub, "main-de-antes");
			const r = await hub.trasVolver({ tenantId: t, seqAntes: 0, modo: "main" });
			expect(r.ok).toBe(true);
			expect(leerSubida(m.sql)).toMatchObject({ estado: "esperando", origen: "instante", mainDeviceId: null });

			// La Main de ahora (la de la base central) saluda y se la queda.
			const par = new WebSocketPair();
			hub.state.acceptWebSocket(par[1], [MAIN]);
			par[1].serializeAttachment({ tenantId: t, deviceId: MAIN, role: "tpv", authed: false, pubkeyB64: null, challenge: { nonceB64: "n", expiresAtMs: Date.now() + 60_000 }, recovering: true });
			const recibidos: any[] = [];
			par[0].accept();
			par[0].addEventListener("message", (ev: MessageEvent) => {
				recibidos.push(JSON.parse(String(ev.data)));
			});
			hub.verifyHelloSigned = async () => ({ roleFinal: "tpv", pubkeyB64: "x" });
			hub.mainEnCentral = async () => MAIN;
			await hub.webSocketMessage(par[1], JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s", recovering: true }));
			await vi.waitFor(() => expect(recibidos.some((x) => x.type === "hello_ok")).toBe(true), { timeout: 10_000 });
			expect(recibidos.find((x) => x.type === "hello_ok").subida).toMatchObject({ estado: "esperando", origen: "instante" });
			expect(leerSubida(m.sql)).toMatchObject({ estado: "esperando", mainDeviceId: MAIN });
		});
	});

	it("otra Main vigente que saluda deja la petición huérfana y no la recibe", async () => {
		await enElHub("subida-huerfana", async (hub: any) => {
			const t = "subida-huerfana";
			const m = await conSubida(hub, t);
			const par = new WebSocketPair();
			hub.state.acceptWebSocket(par[1], ["otra-main"]);
			par[1].serializeAttachment({ tenantId: t, deviceId: "otra-main", role: "tpv", authed: false, pubkeyB64: null, challenge: { nonceB64: "n", expiresAtMs: Date.now() + 60_000 } });
			const recibidos: any[] = [];
			par[0].accept();
			par[0].addEventListener("message", (ev: MessageEvent) => {
				recibidos.push(JSON.parse(String(ev.data)));
			});
			hub.verifyHelloSigned = async () => ({ roleFinal: "tpv", pubkeyB64: "x" });
			hub.mainEnCentral = async () => "otra-main";
			await hub.webSocketMessage(par[1], JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }));
			await vi.waitFor(() => expect(recibidos.some((x) => x.type === "hello_ok")).toBe(true), { timeout: 10_000 });
			expect(recibidos.find((x) => x.type === "hello_ok").subida).toBeUndefined();
			expect(leerSubida(m.sql)!.estado).toBe("huerfana");
		});
	});
});

describe("DO-SUBIDA · las páginas", () => {
	it("el plan dice las tablas con su clave y su ventana, y lo vivo de arriba", async () => {
		await enElHub("subida-plan", async (hub: any) => {
			const m = await conSubida(hub, "subida-plan");
			m.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
			m.sql.exec("INSERT INTO Comandas (ID_Comanda, Canal, Estado, Fecha_Hora_Apertura) VALUES ('c-abierta', 'BARRA', 'Abierta', '2026-01-01 10:00:00');");
			const r = await paso(hub, m, { accion: "plan", id: "s1", clientNow: ahoraCliente(), checkpoint: 0, totales: { Zonas: 3, Clientes: 7 } });
			expect(r.ok).toBe(true);
			const zonas = r.tablas.find((t: any) => t.tabla === "Zonas");
			expect(zonas).toMatchObject({ clave: ["ID_Zona"], parcial: false, politica: "upsert", parametrizada: false });
			const pagos = r.tablas.find((t: any) => t.tabla === "Pagos");
			expect(pagos).toMatchObject({ parcial: true, parametrizada: true });
			expect(r.tablas.find((t: any) => t.tabla === "Registros_Facturacion").politica).toBe("solo_insertar");
			// Ni el andamiaje ni lo que empieza por `_`.
			const nombres = r.tablas.map((t: any) => t.tabla);
			for (const fuera of ["Sync_Changes", "Applied_Operations", "Sync_Main_Checkpoints", "Intentos_Login", "_Main_Vigente", "_Subida_Completa"]) {
				expect(nombres).not.toContain(fuera);
			}
			expect(r.vivos.Comandas).toEqual([["c-abierta"]]);
			expect(leerSubida(m.sql)!.filasDeclaradas).toBe(10);
		});
	});

	it("inserta, actualiza sólo lo distinto y no borra: una zona con sus mesas sigue con ellas", async () => {
		await enElHub("subida-filas", async (hub: any) => {
			const m = await conSubida(hub, "subida-filas");
			m.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
			m.sql.exec(
				"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('m1', 'z1', '1', 4, 0, 0, 'square', 1, 1);",
			);
			const logAntes = m.log().length;
			const r = await paso(hub, m, {
				accion: "filas", id: "s1", tabla: "Zonas", columnas: ["ID_Zona", "Nombre_Zona"],
				filas: [["z1", "Salón"], ["z2", "Terraza"]], checkpoint: 0, ultimaDeLaTabla: false,
			});
			expect(r).toMatchObject({ ok: true, escritas: 2, iguales: 0, noEntraron: [] });
			expect(m.sql.exec("SELECT ID_Zona, Nombre_Zona FROM Zonas ORDER BY ID_Zona;").toArray()).toEqual([
				{ ID_Zona: "z1", Nombre_Zona: "Salón" },
				{ ID_Zona: "z2", Nombre_Zona: "Terraza" },
			]);
			expect(m.sql.exec("SELECT COUNT(*) AS n FROM Mesas WHERE ID_Zona = 'z1';").one().n).toBe(1);

			// Lo mismo otra vez no escribe nada.
			const otra = await paso(hub, m, {
				accion: "filas", id: "s1", tabla: "Zonas", columnas: ["ID_Zona", "Nombre_Zona"],
				filas: [["z1", "Salón"], ["z2", "Terraza"]], checkpoint: 0, ultimaDeLaTabla: true,
			});
			expect(otra).toMatchObject({ ok: true, escritas: 0, iguales: 2 });

			// Ni log ni difusión de filas; al acabar la tabla, aviso a las Handy.
			expect(m.log().length).toBe(logAntes);
			expect(m.difundidos()).toEqual([]);
			await m.handy.esperar((x: any) => x.type === "datos_subidos" && x.tablas.includes("Zonas"));
		});
	});

	it("un registro de facturación sólo se inserta: lo que ya está y es distinto no se toca y se dice", async () => {
		await enElHub("subida-fiscal", async (hub: any) => {
			const m = await conSubida(hub, "subida-fiscal");
			const cols = ["ID_Registro", "Orden", "Tipo", "NIF_Emisor", "Num_Serie_Factura", "Fecha_Expedicion", "Serie", "Numero",
				"Nombre_Razon_Emisor", "Cadena_Huella", "Huella", "Fecha_Hora_Huso", "Sistema_Json", "QR_Url"];
			const registro = (id: string, orden: number, huella: string) =>
				[id, orden, "ALTA", "B00000000", `A-${orden}`, "20-11-2026", "A", orden, "Bar", "cadena", huella, "2026-11-20T10:00:00+01:00", "{}", "https://qr"];
			m.sql.exec(`INSERT INTO Registros_Facturacion (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")});`, ...registro("r1", 1, "H1"));
			const r = await paso(hub, m, {
				accion: "filas", id: "s1", tabla: "Registros_Facturacion", columnas: cols,
				filas: [registro("r1", 1, "OTRA"), registro("r2", 2, "H2")], checkpoint: 0, ultimaDeLaTabla: false,
			});
			expect(r.ok).toBe(true);
			expect(r.noEntraron).toEqual([{ clave: ["r1"], motivo: "fiscal" }]);
			expect(m.sql.exec("SELECT ID_Registro, Huella FROM Registros_Facturacion ORDER BY ID_Registro;").toArray()).toEqual([
				{ ID_Registro: "r1", Huella: "H1" },
				{ ID_Registro: "r2", Huella: "H2" },
			]);
		});
	});

	it("el contador de una serie sólo sube: la nube de una copia se pone al día y nunca baja", async () => {
		await enElHub("subida-serie", async (hub: any) => {
			const m = await conSubida(hub, "subida-serie");
			m.sql.exec("INSERT INTO Serie_Facturacion (Serie, Ultimo) VALUES ('A', 7), ('B', 9);");
			const r = await paso(hub, m, {
				accion: "filas", id: "s1", tabla: "Serie_Facturacion", columnas: ["Serie", "Ultimo"],
				filas: [["A", 12], ["B", 3], ["C", 1]], checkpoint: 0, ultimaDeLaTabla: false,
			});
			expect(r).toMatchObject({ ok: true, escritas: 2, noEntraron: [] });
			expect(m.sql.exec("SELECT Serie, Ultimo FROM Serie_Facturacion ORDER BY Serie;").toArray()).toEqual([
				{ Serie: "A", Ultimo: 12 },
				{ Serie: "B", Ultimo: 9 },
				{ Serie: "C", Ultimo: 1 },
			]);
			// Ni se ofrece borrar arriba una serie: no tiene sobrantes ni vivos.
			const plan = await paso(hub, m, { accion: "plan", id: "s1", clientNow: ahoraCliente(), checkpoint: 0, totales: {} });
			expect(plan.tablas.find((t: any) => t.tabla === "Serie_Facturacion").politica).toBe("monotono");
			expect(plan.dispositivo).toBe(MAIN);
		});
	});

	it("lo que no es la forma de una página de la Main se rechaza como permanente sin tocar nada", async () => {
		await enElHub("subida-forma", async (hub: any) => {
			const m = await conSubida(hub, "subida-forma");
			const base = { accion: "filas", id: "s1", checkpoint: 0, ultimaDeLaTabla: false };
			const casos: [Record<string, unknown>, string][] = [
				[{ ...base, tabla: "_Main_Vigente", columnas: ["Id"], filas: [[1]] }, "subida_tabla_no_admitida"],
				[{ ...base, tabla: "Sync_Changes", columnas: ["Seq"], filas: [[1]] }, "subida_tabla_no_admitida"],
				[{ ...base, tabla: "Applied_Operations", columnas: ["Op_Id"], filas: [["x"]] }, "subida_tabla_no_admitida"],
				[{ ...base, tabla: "Intentos_Login", columnas: ["Clave"], filas: [["x"]] }, "subida_tabla_no_admitida"],
				[{ ...base, tabla: "sqlite_master", columnas: ["name"], filas: [["x"]] }, "subida_tabla_no_admitida"],
				[{ ...base, tabla: "v_lineas_cobradas", columnas: ["ID_Pago"], filas: [["x"]] }, "subida_tabla_no_admitida"],
				[{ ...base, tabla: "Clientes", columnas: ["ID_Cliente", "Inventada"], filas: [["c", 1]] }, "subida_columnas_desconocidas"],
				[{ ...base, tabla: "Clientes", columnas: ['Nombre"; DROP TABLE Zonas; --'], filas: [["x"]] }, "subida_mal_formada"],
				[{ ...base, tabla: "Clientes", columnas: ["Nombre"], filas: [["x"]] }, "subida_columnas_desconocidas"],
				[{ ...base, tabla: "Clientes", columnas: COLS_CLIENTE, filas: [["c", "Ana"]] }, "subida_mal_formada"],
				[{ ...base, tabla: "Clientes", columnas: COLS_CLIENTE, filas: [["c", { x: 1 }, 0]] }, "subida_mal_formada"],
				[{ ...base, tabla: "Clientes", columnas: COLS_CLIENTE, filas: [["c", "Ana", true]] }, "subida_mal_formada"],
				[{ ...base, tabla: "Clientes", columnas: COLS_CLIENTE, filas: Array.from({ length: 5001 }, (_, i) => cliente(`c${i}`, "x")) }, "subida_pagina_demasiado_grande"],
				[{ ...base, id: "otra", tabla: "Clientes", columnas: COLS_CLIENTE, filas: [cliente("c", "Ana")] }, "subida_no_pedida"],
			];
			for (const [cuerpo, error] of casos) {
				const r = await paso(hub, m, cuerpo);
				expect(r.ok, error).toBe(false);
				expect(r.error, JSON.stringify(cuerpo).slice(0, 120)).toBe(error);
				if (error !== "subida_pagina_demasiado_grande") expect(r.permanente, error).toBe(true);
			}
			expect(m.sql.exec("SELECT COUNT(*) AS n FROM Clientes;").one().n).toBe(0);
			expect(m.sql.exec("SELECT COUNT(*) AS n FROM Zonas;").one().n).toBe(0);
		});
	});

	it("una Handy no puede mandar pasos de la subida", async () => {
		await enElHub("subida-handy", async (hub: any) => {
			const m = await conSubida(hub, "subida-handy");
			const r = await paso(hub, m, { accion: "filas", id: "s1", tabla: "Clientes", columnas: COLS_CLIENTE, filas: [cliente("c", "Ana")], checkpoint: 0 }, m.handy);
			expect(r).toMatchObject({ ok: false, error: "forbidden_not_tpv" });
			expect(m.sql.exec("SELECT COUNT(*) AS n FROM Clientes;").one().n).toBe(0);
		});
	});

	it("lo de una Handy por encima del checkpoint aplaza la página; lo de la propia Main no cuenta", async () => {
		await enElHub("subida-guarda", async (hub: any) => {
			const m = await conSubida(hub, "subida-guarda");
			m.sql.exec("INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (10, 'de-la-main', 'x', '[]', ?1, 1);", MAIN);
			const cuerpo = { accion: "filas", id: "s1", tabla: "Clientes", columnas: COLS_CLIENTE, filas: [cliente("c1", "Ana")], checkpoint: 5 };
			expect(await paso(hub, m, cuerpo)).toMatchObject({ ok: true, escritas: 1 });
			m.sql.exec("INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (11, 'de-la-handy', 'x', '[]', 'handy-lote', 1);");
			m.sql.exec("UPDATE Clientes SET Nombre = 'Ana (Handy)' WHERE ID_Cliente = 'c1';");
			expect(await paso(hub, m, { ...cuerpo, filas: [cliente("c1", "Ana")] })).toEqual({ type: "subida_ack", pasoId: expect.any(String), ok: false, aplazada: true, hastaSeq: 11 });
			expect(m.sql.exec("SELECT Nombre FROM Clientes;").one().Nombre).toBe("Ana (Handy)");
			// Con el checkpoint al día, entra.
			expect(await paso(hub, m, { ...cuerpo, filas: [cliente("c1", "Ana")], checkpoint: 11 })).toMatchObject({ ok: true, escritas: 1 });
		});
	});

	it("una página de 5.000 filas con una mala entra entera menos esa fila", async () => {
		await enElHub("subida-particion", async (hub: any) => {
			const m = await conSubida(hub, "subida-particion");
			const filas = Array.from({ length: 5000 }, (_, i) => cliente(`c${String(i).padStart(5, "0")}`, `Cliente ${i}`, i));
			filas[3210] = ["c03210", "Mala", 1.5];
			const r = await paso(hub, m, { accion: "filas", id: "s1", tabla: "Clientes", columnas: COLS_CLIENTE, filas, checkpoint: 0 });
			expect(r.ok).toBe(true);
			expect(r.escritas).toBe(4999);
			expect(r.noEntraron).toEqual([{ clave: ["c03210"], motivo: "check" }]);
			expect(m.sql.exec("SELECT COUNT(*) AS n FROM Clientes;").one().n).toBe(4999);
		});
	});

	it("un único que choca sale como «unico» y lo demás entra", async () => {
		await enElHub("subida-unico", async (hub: any) => {
			const m = await conSubida(hub, "subida-unico");
			m.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-arriba', 'Sala');");
			const r = await paso(hub, m, {
				accion: "filas", id: "s1", tabla: "Zonas", columnas: ["ID_Zona", "Nombre_Zona"],
				filas: [["z1", "Sala"], ["z2", "Terraza"]], checkpoint: 0,
			});
			expect(r.noEntraron).toEqual([{ clave: ["z1"], motivo: "unico" }]);
			expect(r.escritas).toBe(1);
		});
	});

	it("las huellas dicen lo que falta o es distinto arriba, y los tramos, qué tramos no cuadran", async () => {
		await enElHub("subida-huellas", async (hub: any) => {
			const m = await conSubida(hub, "subida-huellas");
			m.sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre, Total_Gastado) VALUES ('a', 'Ana', 10), ('b', 'Bea', 20), ('c', 'Carla', 30);");
			const huella = (fila: unknown[]) => {
				const c = new Canonico();
				for (const v of fila) c.valor(v);
				c.hash();
				return hex64(c.alto, c.bajo);
			};
			const r = await paso(hub, m, {
				accion: "huellas", id: "s1", tabla: "Clientes", columnas: COLS_CLIENTE,
				huellas: [[["a"], huella(["a", "Ana", 10])], [["b"], huella(["b", "Bea", 21])], [["z"], huella(["z", "Zoe", 0])]],
			});
			expect(r).toMatchObject({ ok: true, distintas: [["b"], ["z"]], faltan: [["z"]] });

			const suma = (filas: unknown[][]) => {
				const s = new SumaDeTramo();
				for (const f of filas) s.fila(f);
				return { n: s.n, suma: s.suma };
			};
			const t = await paso(hub, m, {
				accion: "tramos", id: "s1", tabla: "Clientes", columnas: COLS_CLIENTE,
				tramos: [
					{ desde: null, hasta: ["b"], ...suma([["a", "Ana", 10], ["b", "Bea", 20]]) },
					{ desde: ["b"], hasta: ["c"], ...suma([["c", "Carla", 31]]) },
				],
			});
			expect(t).toMatchObject({ ok: true, distintos: [1] });
		});
	});

	it("los sobrantes son lo que la nube tiene en el tramo y la Main no ha mandado", async () => {
		await enElHub("subida-sobrantes", async (hub: any) => {
			const m = await conSubida(hub, "subida-sobrantes");
			m.sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre) VALUES ('a', 'Ana'), ('b', 'Bea'), ('c', 'Carla'), ('d', 'Dora');");
			const r = await paso(hub, m, { accion: "sobrantes", id: "s1", tabla: "Clientes", desde: null, hasta: ["c"], claves: [["a"], ["c"]], checkpoint: 0 });
			expect(r).toMatchObject({ ok: true, sobran: [["b"]], incompleto: false });
			expect(r.hastaSeq).toBeGreaterThanOrEqual(0);
		});
	});
});

describe("DO-SUBIDA · el presupuesto (AUD-36)", () => {
	it("con el presupuesto de la hora del negocio gastado, la página entra y no lo gasta", async () => {
		await enElHub("subida-presupuesto-negocio", async (hub: any) => {
			const m = await conSubida(hub, "subida-presupuesto-negocio");
			const ahora = Date.now();
			apuntarGasto(hub.state.storage, ahora, 600_000, 0);
			const antes = gastadoEnLaHora(hub.state.storage, ahora);
			const r = await paso(hub, m, { accion: "filas", id: "s1", tabla: "Clientes", columnas: COLS_CLIENTE, filas: [cliente("c1", "Ana")], checkpoint: 0 });
			expect(r).toMatchObject({ ok: true, escritas: 1 });
			expect(gastadoEnLaHora(hub.state.storage, ahora)).toEqual(antes);
			expect(leerSubida(m.sql)!.paginas).toBe(1);
		});
	});

	it("el de la hora de la subida es pasajero; el techo total, permanente, la deja agotada y la reabre la administración", async () => {
		await enElHub("subida-presupuesto-propio", async (hub: any) => {
			const m = await conSubida(hub, "subida-presupuesto-propio");
			const storage = hub.state.storage;
			const pagina = (nombre: string) => ({
				accion: "filas" as const, id: "s1", tabla: "Clientes", columnas: COLS_CLIENTE,
				filas: [cliente("c1", nombre), cliente("c2", nombre)], checkpoint: 0, ultimaDeLaTabla: false,
			});
			const ahora = Date.now();
			const porHora = { ...LIMITES_DE_SUBIDA, filasPorHora: 1 };
			ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: pagina("Ana"), ahoraMs: ahora, limites: porHora });
			expect(() => ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: pagina("Bea"), ahoraMs: ahora, limites: porHora })).toThrow(
				expect.objectContaining({ code: "presupuesto_de_subida_agotado" }),
			);
			// A la hora siguiente, sigue.
			ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: pagina("Bea"), ahoraMs: ahora + 60 * 60 * 1000, limites: porHora });

			// Reescribir las mismas filas con valores alternos acaba con el techo total.
			const techo = { ...LIMITES_DE_SUBIDA, sueloTotal: 40, factorDeclaradas: 1 };
			let agotada: any = null;
			for (let i = 0; i < 100 && !agotada; i++) {
				try {
					ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: pagina(i % 2 ? "Ana" : "Bea"), ahoraMs: ahora + 2 * 60 * 60 * 1000, limites: techo });
				} catch (e) {
					agotada = e;
				}
			}
			expect(agotada).toMatchObject({ code: "subida_presupuesto_superado" });
			expect(leerSubida(m.sql)!.estado).toBe("agotada");
			// Por el socket, ya no se admite ninguna.
			expect(await paso(hub, m, pagina("Ana"))).toMatchObject({ ok: false, error: "subida_no_pedida", permanente: true });

			// La administración la reabre: sin dueño, con su presupuesto a cero.
			expect(await hub.reabrirSubida("subida-presupuesto-propio")).toEqual({ ok: true, antes: "agotada" });
			expect(leerSubida(m.sql)).toMatchObject({ estado: "esperando", mainDeviceId: null, filasEscritas: 0 });
			expect(reabrirSubida(m.sql, Date.now())).toBeNull();
		});
	});
});

describe("DO-SUBIDA · el final", () => {
	it("fin la da por terminada, repetirlo contesta lo mismo, y caducada ya no admite pasos", async () => {
		await enElHub("subida-fin", async (hub: any) => {
			const m = await conSubida(hub, "subida-fin");
			m.sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
			const r = await paso(hub, m, { accion: "fin", id: "s1", conteos: { Zonas: 2 }, porRevisar: 0 });
			expect(r).toMatchObject({ ok: true, diferencias: 1 });
			expect(r.conteos.Zonas).toBe(1);
			expect(leerSubida(m.sql)!.estado).toBe("terminada");
			expect(await paso(hub, m, { accion: "fin", id: "s1", conteos: {}, porRevisar: 0 })).toMatchObject({ ok: true, yaTerminada: true });

			pedirSubida(m.sql, { id: "s2", origen: "copia", mainDeviceId: MAIN, inicioSeq: 0, ahoraMs: Date.now() - PLAZO_DE_SUBIDA_MS - 1 });
			expect(await paso(hub, m, { accion: "fin", id: "s2", conteos: {}, porRevisar: 0 })).toMatchObject({ ok: false, error: "subida_no_pedida" });
			expect(leerSubida(m.sql)!.estado).toBe("caducada");
		});
	});

	it("el plazo es para empezar: una subida empezada sigue pasados los 14 días y sus copias siguen protegidas", async () => {
		await enElHub("subida-empezada-no-caduca", async (hub: any) => {
			const m = await conSubida(hub, "subida-empezada-no-caduca");
			const storage = hub.state.storage;
			const ahora = Date.now();
			const pasado = ahora + PLAZO_DE_SUBIDA_MS + 24 * 60 * 60 * 1000;
			const pagina = (nombre: string) => ({
				accion: "filas" as const, id: "s1", tabla: "Clientes", columnas: COLS_CLIENTE,
				filas: [cliente("c1", nombre)], checkpoint: 0, ultimaDeLaTabla: false,
			});
			// La Main sube parte y se para (el equipo apagado, la subida pausada) más de 14 días.
			ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: pagina("Ana"), ahoraMs: ahora });
			expect(sinEmpezarParaAvisar(m.sql, pasado)).toBeNull();
			expect(leerSubida(m.sql)!.estado).toBe("esperando");
			expect(copiasProtegidasDesde(m.sql)).toBe(leerSubida(m.sql)!.desdeMs);
			// Cuando vuelve, sigue por donde iba.
			expect(ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: pagina("Bea"), ahoraMs: pasado }).respuesta).toMatchObject({ ok: true, escritas: 1 });

			// Con sólo el plan pedido también está empezada.
			pedirSubida(m.sql, { id: "s2", origen: "copia", mainDeviceId: MAIN, inicioSeq: 0, ahoraMs: ahora });
			ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: { accion: "plan", id: "s2", clientNow: ahoraCliente(), checkpoint: 0, totales: { Clientes: 2 } }, ahoraMs: ahora });
			expect(ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: { ...pagina("Ana"), id: "s2" }, ahoraMs: pasado }).respuesta).toMatchObject({ ok: true });
			expect(leerSubida(m.sql)!.estado).toBe("esperando");
		});
	});

	it("reabrirla echa a la Main conectada, que al volver a saludar se la queda, y el aviso de «sin empezar» vuelve a contar", async () => {
		await enElHub("subida-reabrir-conectada", async (hub: any) => {
			const t = "subida-reabrir-conectada";
			const m = await conSubida(hub, t);
			const ahora = Date.now();
			// Se pidió hace días, empezó, se agotó y ya avisó de que no empezaba; la Main sigue conectada.
			m.sql.exec(
				"UPDATE _Subida_Completa SET Estado = 'agotada', Desde_Ms = ?1, Primera_Pagina_Ms = ?1, Aviso_Sin_Empezar_Ms = ?1, Filas_Declaradas = 10 WHERE Id = 1;",
				ahora - 3 * 24 * 60 * 60 * 1000,
			);
			expect(await hub.reabrirSubida(t)).toEqual({ ok: true, antes: "agotada" });
			// La sesión de la Main no se entera de otra forma: se la echa. La Handy sigue.
			expect(m.main.servidor.readyState).not.toBe(1);
			expect(m.handy.servidor.readyState).toBe(1);
			const p = leerSubida(m.sql)!;
			expect(p).toMatchObject({ estado: "esperando", mainDeviceId: null, primeraPaginaMs: null, avisoSinEmpezarMs: null, filasDeclaradas: 10 });
			const otra = await saludaLaMain(hub, t);
			expect(otra.hello.subida).toEqual({ id: "s1", estado: "esperando", origen: "copia" });
			expect(leerSubida(m.sql)!.mainDeviceId).toBe(MAIN);
			// Si nadie la retoma en un día desde que se reabrió, la alarma vuelve a avisar.
			expect(sinEmpezarParaAvisar(m.sql, ahora + 60 * 60 * 1000)).toBeNull();
			expect(sinEmpezarParaAvisar(m.sql, ahora + 25 * 60 * 60 * 1000)).not.toBeNull();
		});
	});

	it("una reabierta que ya tenía plan vuelve a tener su plazo: caduca si su Main no da ningún paso, y un paso la libra", async () => {
		await enElHub("subida-reabierta-caduca", async (hub: any) => {
			const m = await conSubida(hub, "subida-reabierta-caduca");
			const storage = hub.state.storage;
			const ahora = Date.now();
			const pasado = ahora + PLAZO_DE_SUBIDA_MS + 60 * 60 * 1000;
			const plan = (id: string) => ({ accion: "plan" as const, id, clientNow: ahoraCliente(), checkpoint: 0, totales: { Clientes: 2 } });
			const pagina = (id: string, nombre: string) => ({
				accion: "filas" as const, id, tabla: "Clientes", columnas: COLS_CLIENTE,
				filas: [cliente("c1", nombre)], checkpoint: 0, ultimaDeLaTabla: false,
			});
			/** Una petición que su Main empezó y que acabó `estado`, reabierta ahora. */
			const reabierta = (id: string, estado: "huerfana" | "agotada", conPagina: boolean) => {
				pedirSubida(m.sql, { id, origen: "copia", mainDeviceId: MAIN, inicioSeq: 0, ahoraMs: ahora - 24 * 60 * 60 * 1000 });
				ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: plan(id), ahoraMs: ahora - 60 * 60 * 1000 });
				if (conPagina) ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: pagina(id, "Ana"), ahoraMs: ahora - 60 * 60 * 1000 });
				m.sql.exec("UPDATE _Subida_Completa SET Estado = ?1 WHERE Id = 1;", estado);
				expect(reabrirSubida(m.sql, ahora)).toBe(estado);
				expect(leerSubida(m.sql)).toMatchObject({ estado: "esperando", mainDeviceId: null, filasDeclaradas: 2 });
			};

			// Huérfana después del plan: la reabre soporte y ninguna Main la retoma. Caduca a su plazo y
			// suelta las copias.
			reabierta("s-huerfana", "huerfana", false);
			expect(sinEmpezarParaAvisar(m.sql, pasado)).toBeNull();
			expect(leerSubida(m.sql)!.estado).toBe("caducada");
			expect(copiasProtegidasDesde(m.sql)).toBeNull();

			// Agotada (plan y páginas) y reabierta: la Main se la queda al saludar y no vuelve a mandar nada.
			reabierta("s-agotada", "agotada", true);
			m.sql.exec("UPDATE _Subida_Completa SET Main_Device_Id = ?1 WHERE Id = 1;", MAIN);
			expect(sinEmpezarParaAvisar(m.sql, pasado)).toBeNull();
			expect(leerSubida(m.sql)!.estado).toBe("caducada");

			// Si su Main da un paso después de reabrirla, ya no caduca.
			reabierta("s-retomada", "agotada", true);
			m.sql.exec("UPDATE _Subida_Completa SET Main_Device_Id = ?1 WHERE Id = 1;", MAIN);
			ejecutarPasoDeSubida(storage, { deviceId: MAIN, paso: pagina("s-retomada", "Bea"), ahoraMs: ahora + 60 * 60 * 1000 });
			expect(sinEmpezarParaAvisar(m.sql, pasado)).toBeNull();
			expect(leerSubida(m.sql)!.estado).toBe("esperando");
			expect(copiasProtegidasDesde(m.sql)).not.toBeNull();
		});
	});

	it("la que caduca en la alarma se avisa", async () => {
		await enElHub("subida-caduca-en-la-alarma", async (hub: any) => {
			const m = await conSubida(hub, "subida-caduca-en-la-alarma");
			pedirSubida(m.sql, { id: "s2", origen: "copia", mainDeviceId: MAIN, inicioSeq: 0, ahoraMs: Date.now() - PLAZO_DE_SUBIDA_MS - 1 });
			await hub.alarma();
			expect(leerSubida(m.sql)!.estado).toBe("caducada");
			expect(m.eventos.map((e) => e.name)).toContain("subida_caducada");
		});
	});

	it("mientras se espera la subida, la poda no se lleva las copias de antes de la pérdida", async () => {
		const bucket = (env as any).COPIAS_NEGOCIOS as R2Bucket;
		const t = "subida-poda";
		const hoy = Date.UTC(2026, 10, 20);
		const dias = Array.from({ length: 35 }, (_, i) => new Date(hoy - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
		for (const d of dias) await bucket.put(claveDeCopia(t, d), "x");
		// La base se perdió hace 3 días: las 32 de antes son las buenas.
		const perdida = hoy - 2 * 24 * 60 * 60 * 1000 - 1;
		expect(await podarCopias(bucket, t, 30, perdida)).toBe(0);
		expect(await podarCopias(bucket, t, 30, null)).toBe(5);
	});

	it("la sentencia de una página nunca reemplaza ni borra, y lleva la lista en un parámetro", () => {
		const s = sentenciaDeSubida("Zonas", ["ID_Zona", "Nombre_Zona"], ["ID_Zona"], "upsert");
		expect(s).not.toMatch(/REPLACE|DELETE/i);
		expect(s).toContain("json_each(?1)");
		expect(s).toContain('ON CONFLICT("ID_Zona") DO UPDATE SET "Nombre_Zona" = excluded."Nombre_Zona"');
		expect(sentenciaDeSubida("Registros_Facturacion", ["ID_Registro", "Huella"], ["ID_Registro"], "solo_insertar")).toContain("DO NOTHING");
		const serie = sentenciaDeSubida("Serie_Facturacion", ["Serie", "Ultimo"], ["Serie"], "monotono");
		expect(serie).toContain('"Ultimo" = MAX("Ultimo", excluded."Ultimo")');
		expect(serie).not.toMatch(/REPLACE|DELETE/i);
	});
});
