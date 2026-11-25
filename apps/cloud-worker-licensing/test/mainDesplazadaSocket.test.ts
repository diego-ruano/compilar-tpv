// test/mainDesplazadaSocket.test.ts
//
// AUD-02 · La Main que deja de serlo deja de serlo también en el `TenantHub`.
//
// El rol `tpv` de una sesión se fija al saludar y vive en el attachment del socket. Un traslado de
// la licencia a otro equipo sólo cambia `licenses.main_device_id`, así que el socket que el equipo
// anterior ya tenía abierto seguía siendo una Main: mandaba SQL que la nube confirmaba y la Main
// nueva ejecutaba tal cual, leía cualquier tabla, recibía todo lo del negocio y contaba como Main
// para las Handy. Aquí se fija lo que hace ahora el DO:
//
//   · quién es la Main está apuntado en su SQL (`_Main_Vigente`), y todo lo que depende de ello lo
//     mira ahí sin esperar (`esLaMain`): escribir, soltar a las Handy, recibir lo del negocio y
//     contar como Main;
//   · la tabla la pone al día el saludo de un `tpv` y, cuando hay trabajo, una lectura de la base
//     central como mucho por minuto; quien la pide se queda la marca antes de esperar, y una
//     respuesta vieja no deshace una nueva;
//   · la sesión `tpv` que deja de ser la Main se echa en el mismo paso (4001, `sessionGone`), y lo
//     que estaba esperando a que la comprobaran no entra;
//   · si la base central no contesta o rechaza la consulta, la tabla se queda como está y no se
//     rechaza nada; un mensaje mal formado no gasta la lectura;
//   · lo que la Main manda y entra en el acto (`apply_lote`) entra en el orden en que llegó,
//     aunque al primero le toque esperar la comprobación;
//   · un cambio de licencia (`releerMain`) hace releer, no echa por su cuenta: un aviso que llega
//     tarde no echa a la Main que ha vuelto a serlo. La baja de un dispositivo
//     (`revocarDispositivo`) sí echa en el acto;
//   · todo cierre deja la sesión fuera y contabiliza la salida; un saludo cuyo socket se cierra
//     mientras espera no se autentica ni se anuncia;
//   · la tabla sobrevive a un reinicio del DO.
//
// DO real con sockets reales (`WebSocketPair` + `acceptWebSocket`), sin sustituir `isMainConnected`
// ni `isMainReady`. La base del negocio es el SQLite del propio DO, con su cliente de producción, y
// la base central, una de verdad con el negocio dado de alta (`helpers/central.ts`). Lo único que el
// DO le pide es quién es la Main de la licencia y el `last_seen`; que no conteste, que no haga la
// consulta o que tarde se provoca en su stub.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RespuestaDeLaCentral, SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { aplicarLectura, empezarLectura, mainVigente, olvidarComprobacion, tocaComprobar } from "../src/durableObjects/tenantHub.main";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { bytesToB64 } from "../src/server/utils/base64";
import { centralDePrueba, centralQueApunta, filasDe, negocioEnLaCentral, type CentralDePrueba } from "./helpers/central";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub, ponerLaCentral } from "./helpers/hub";
import { laLicenciaDiceQueLaMainEs, laTablaDiceQueLaMainEs } from "./helpers/mainVigente";

const TENANT = "tenant-1";
const ADMIN = "00000000-0000-7000-8000-000000000001";
const UN_MINUTO_LARGO_MS = 61_000;
/** Lo que la Main espera el acuse de un lote (`ESPERA_DEL_LOTE`, `use_cases/replicacion.rs`). */
const LA_MAIN_ESPERA_SU_ACUSE_MS = 30_000;

// Los casos esperan mensajes y cierres de sockets de verdad. Con la máquina cargada, los 5 s por
// defecto de un test y las esperas cortas se quedan en nada: aquí van con margen. Una espera acaba
// en cuanto llega lo que espera, así que el margen no alarga la pasada cuando todo va bien.
vi.setConfig({ testTimeout: 60_000 });
const ESPERA_MS = 15_000;

/** Una espera que se suelta a mano: para retener un lote en el turno del log. */
function retencion() {
	let soltar!: () => void;
	const espera = new Promise<void>((r) => (soltar = r));
	return { espera, soltar };
}

// ── La base central ───────────────────────────────────────────────────────────

/** La pregunta del DO a la base central: quién es la Main de la licencia (`mainDeLaLicencia`). */
const PIDE_LA_MAIN = /FROM licenses/;
/**
 * Lo único que el DO le pide a la base central: quién es la Main y el `last_seen` (`touchLastSeen`).
 * Del dispositivo no se pregunta nada: el rol y la clave los pasa el Worker al abrir el socket
 * (`abrir`), y una lectura de `devices` haría fallar el caso (`inesperadas`).
 */
const LO_QUE_SE_PIDE_A_LA_CENTRAL = /FROM licenses|UPDATE devices SET last_seen_at_ms/;

/**
 * Lo que le ha llegado a la base central en el caso en curso sin ser `LO_QUE_SE_PIDE_A_LA_CENTRAL`.
 * Se apunta y se contesta con un rechazo, sin lanzar: el `last_seen` va por `waitUntil`, y lo que
 * se lanzara por ahí no lo recogería nadie y el caso pasaría igual. Lo comprueba el `afterEach`.
 */
const inesperadas: string[] = [];

afterEach(() => {
	expect(inesperadas.splice(0), "AUD-02: la prueba no espera esto en la base central").toEqual([]);
});

/** Lo que contesta la base central cuando no ha hecho la consulta. */
const rechazo = (detalle: string): RespuestaDeLaCentral<never> => ({ ok: false, error: "central_error_sql", detalle });

/** Una respuesta de la base central que se ha quedado esperando en su stub. */
type Retenida = { que: "licenses"; soltar: () => void };

type Central = {
	/** La base central de verdad del DO, con el negocio dado de alta. */
	base: CentralDePrueba;
	/** La base central no contesta. */
	caida: boolean;
	/** La base central contesta, pero no ha hecho la consulta. */
	rechaza: boolean;
	/** Lecturas de `licenses`: lo que cuesta saber quién es la Main. */
	readonly lecturas: number;
	/** Retiene cada lectura de `licenses`, con la respuesta de cuando se hizo. */
	retenerLicencias: boolean;
	/** Lo retenido, en el orden en que llegó. */
	retenidas: Retenida[];
};

function retener(central: Central): Promise<void> {
	return new Promise<void>((resolver) => {
		const r: Retenida = {
			que: "licenses",
			soltar: () => {
				const i = central.retenidas.indexOf(r);
				if (i >= 0) central.retenidas.splice(i, 1);
				resolver();
			},
		};
		central.retenidas.push(r);
	});
}

const soltarTodas = (central: Central) => [...central.retenidas].forEach((r) => r.soltar());

/**
 * Una base central nueva para el DO, con el negocio y su licencia, de la que `main` es la Main
 * (`null`: anulada), puesta detrás del hub. La tabla del DO no se toca. Lo que el DO le pide pasa
 * por su stub, que lo apunta y hace lo que diga `Central`.
 */
async function centralDelHub(hub: any, main: string | null): Promise<Central> {
	const base = await centralDePrueba();
	await negocioEnLaCentral(base, { tenantId: TENANT, main: main ?? "main-de-la-anulada" });
	if (main === null) {
		await filasDe(base, "UPDATE licenses SET status = 'revoked', disabled = 1 WHERE tenant_id = ?;", TENANT);
	}
	const vista = centralQueApunta(base, async (metodo, [s], llamar) => {
		const texto = metodo === "ejecutar" ? (s as SentenciaEnlazada).sql : "";
		if (!LO_QUE_SE_PIDE_A_LA_CENTRAL.test(texto)) {
			inesperadas.push(`${metodo} ${texto}`.trim());
			return rechazo("la prueba no lo espera");
		}
		if (!PIDE_LA_MAIN.test(texto)) return llamar();
		if (central.caida) throw new Error("la base central no contesta");
		if (central.rechaza) return rechazo("consulta rechazada");
		// Lo que hay AHORA, aunque la respuesta tarde en llegar.
		const respuesta = await llamar();
		if (central.retenerLicencias) await retener(central);
		return respuesta;
	});
	const central: Central = {
		base,
		caida: false,
		rechaza: false,
		get lecturas() {
			return vista.pedido.filter((q) => PIDE_LA_MAIN.test(q)).length;
		},
		retenerLicencias: false,
		retenidas: [],
	};
	ponerLaCentral(hub, vista);
	return central;
}

async function prepararHub(hub: any, main: string | null) {
	const sql = hub.state.storage.sql;
	crearEsquemaTenant(sql);
	const base = clienteLocal(hub.state.storage);
	// El lote que lleve este texto se queda esperando: es como se retiene el turno del log.
	const turno = { texto: null as string | null, pausa: retencion(), retenidos: 0 };
	const db = {
		...base,
		async batch(sentencias: any[]) {
			if (turno.texto && JSON.stringify(sentencias).includes(turno.texto)) {
				turno.retenidos++;
				await turno.pausa.espera;
			}
			return base.batch(sentencias);
		},
	};
	hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
	const eventos: { name: string; [campo: string]: unknown }[] = [];
	hub.emitSyncEvent = (name: string, campos: Record<string, unknown>) => eventos.push({ name, ...campos });
	const central = await centralDelHub(hub, main);
	return { sql, db, central, eventos, turno };
}

// ── La tabla del DO ───────────────────────────────────────────────────────────

/** Hace como si la última lectura de la base central fuera de hace más de un minuto. */
function pasaUnMinuto(hub: any) {
	hub.state.storage.sql.exec("UPDATE _Main_Vigente SET Comprobada_Ms = ? WHERE Id = 1;", Date.now() - UN_MINUTO_LARGO_MS);
}

/**
 * El traslado cuyo aviso de cierre no llegó al DO: la tabla dice `vieja`, la última lectura es de
 * hace más de un minuto y la base central ya dice `nueva`.
 */
async function trasladoSinAviso(hub: any, vieja: string, nueva: string | null) {
	const preparado = await prepararHub(hub, nueva);
	laTablaDiceQueLaMainEs(hub, vieja);
	pasaUnMinuto(hub);
	return preparado;
}

const mainDeLaTabla = (hub: any) => mainVigente(hub.state.storage).deviceId;

// ── Sockets ───────────────────────────────────────────────────────────────────

type Conexion = {
	deviceId: string;
	cliente: WebSocket;
	servidor: WebSocket;
	recibidos: any[];
	cierre: { code: number; reason: string } | null;
};

function escuchar(deviceId: string, cliente: WebSocket, servidor: WebSocket): Conexion {
	const c: Conexion = { deviceId, cliente, servidor, recibidos: [], cierre: null };
	cliente.accept();
	cliente.addEventListener("message", (ev: MessageEvent) => {
		c.recibidos.push(JSON.parse(String(ev.data)));
	});
	cliente.addEventListener("close", (ev: CloseEvent) => {
		c.cierre = { code: ev.code, reason: ev.reason };
	});
	return c;
}

/** Un socket aceptado por el DO con el attachment que deja un saludo correcto. */
function conectar(hub: any, deviceId: string, role: "tpv" | "handy" = "tpv", recovering = false): Conexion {
	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [deviceId]);
	par[1].serializeAttachment({
		tenantId: TENANT,
		deviceId,
		role,
		authed: true,
		autenticadaMs: Date.now(),
		pubkeyB64: null,
		challenge: null,
		recovering,
	});
	return escuchar(deviceId, par[0], par[1]);
}

/** Un socket aceptado y todavía sin autenticar, con su reto: lo que hay justo antes del saludo. */
function sinSaludar(hub: any, deviceId: string, role: "tpv" | "handy"): Conexion {
	const par = new WebSocketPair();
	hub.state.acceptWebSocket(par[1], [deviceId]);
	par[1].serializeAttachment({
		tenantId: TENANT,
		deviceId,
		role,
		authed: false,
		pubkeyB64: null,
		challenge: { nonceB64: "n", expiresAtMs: Date.now() + 60_000 },
		recovering: false,
	});
	return escuchar(deviceId, par[0], par[1]);
}

/**
 * El upgrade de verdad (`abrirWebSocket`): el DO acepta el socket y manda su reto. Con las cabeceras
 * de identidad que pone el Worker al canjear el ticket (`app.ts`): el rol y la clave del dispositivo.
 */
async function abrir(hub: any, deviceId: string): Promise<Conexion> {
	const antes: WebSocket[] = hub.state.getWebSockets(deviceId);
	const res = await hub.fetch(
		new Request("https://hub/ws", {
			headers: {
				Upgrade: "websocket",
				"x-tenant-id": TENANT,
				"x-device-id": deviceId,
				"x-role": "tpv",
				"x-device-pubkey-b64": PUB,
			},
		}),
	);
	const servidor = hub.state.getWebSockets(deviceId).find((ws: WebSocket) => !antes.includes(ws));
	expect(servidor).toBeDefined();
	return escuchar(deviceId, res.webSocket as WebSocket, servidor);
}

async function esperar(c: Conexion, pred: (m: any) => boolean, ms = ESPERA_MS): Promise<any> {
	const limite = Date.now() + ms;
	while (Date.now() < limite) {
		const m = c.recibidos.find(pred);
		if (m) return m;
		await new Promise((r) => setTimeout(r, 10));
	}
	return undefined;
}

/** Espera a que se cumpla `cond`. Sin `setTimeout`: vale también con el reloj de mentira puesto. */
async function esperarA(cond: () => boolean, ms = ESPERA_MS): Promise<boolean> {
	const limite = Date.now() + ms;
	while (!cond() && Date.now() < limite) await scheduler.wait(10);
	return cond();
}

async function esperarCierre(c: Conexion, ms = ESPERA_MS): Promise<{ code: number; reason: string } | null> {
	await esperarA(() => c.cierre !== null, ms);
	return c.cierre;
}

/** Deja pasar lo que hubiera quedado en vuelo: una difusión, un ack que no debería llegar. */
const unMomento = () => new Promise((r) => setTimeout(r, 150));

async function cerrar(_hub: any, ...conexiones: Conexion[]) {
	for (const c of conexiones) {
		try {
			c.cliente.close(1000, "fin");
		} catch {}
	}
}

const att = (c: Conexion) => c.servidor.deserializeAttachment() as any;

const cambios = (c: Conexion, desde = 0) => c.recibidos.slice(desde).filter((m) => m.type === "change");

// ── Mensajes ──────────────────────────────────────────────────────────────────

const n = (sql: any, q: string) => Number(sql.exec(q).toArray()[0]?.n ?? 0);

const altaDeZona = (id: string) => ({
	kind: "execute",
	sql: `INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('${id}', 'Zona ${id}');`,
});

function operacion(opId: string, steps: any[]) {
	return {
		opId,
		commandName: "x",
		command: { type: "tenantDb.transaction", payload: { steps } },
	};
}

/** Un `apply_lote` de una operación: el lote se llama como ella. */
const applyLote = (opId: string, steps: any[]) =>
	JSON.stringify({ type: "apply_lote", loteId: `lote-${opId}`, clientNow: "2026-11-08 12:00:00", ops: [operacion(opId, steps)] });
const acusesDeLote = (c: Conexion) => c.recibidos.filter((m) => m.type === "apply_lote_ack");
/** Los acuses de los lotes que han entrado enteros. */
const lotesAplicados = (c: Conexion) =>
	acusesDeLote(c).filter((m) => m.ok && m.resultados?.every((r: any) => r.ok));
/** El acuse del lote de una operación (`applyLote`). */
const acuseDe = (c: Conexion, opId: string) =>
	esperar(c, (m) => m.type === "apply_lote_ack" && m.loteId === `lote-${opId}`);

/**
 * Pasos que dependen unos de otros: el primero da de alta la zona y cada uno de los siguientes le
 * añade su número al nombre. Aplicados en otro orden, el nombre sale distinto (o el alta llega
 * tarde y los primeros no encuentran la fila).
 */
const encadenado = (zona: string, i: number) =>
	i === 0
		? [altaDeZona(zona)]
		: [{ kind: "execute", sql: `UPDATE Zonas SET Nombre_Zona = Nombre_Zona || '-${i}' WHERE ID_Zona = '${zona}';` }];
const nombreEncadenado = (zona: string, cuantos: number) =>
	`Zona ${zona}` + Array.from({ length: cuantos - 1 }, (_, i) => `-${i + 1}`).join("");
const nombreDe = (sql: any, zona: string) =>
	(sql.exec("SELECT Nombre_Zona AS nombre FROM Zonas WHERE ID_Zona = ?;", zona).toArray()[0] as any)?.nombre;
const elLog = (sql: any) =>
	sql.exec("SELECT Op_Id FROM Sync_Changes ORDER BY Seq;").toArray().map((fila: any) => fila.Op_Id);

const recoveryReady = JSON.stringify({ type: "recovery_ready" });

/** Lo que escribe una Handy por REST: el RPC `aplicar` del DO. */
function escribeLaHandy(hub: any, opId: string, zona: string) {
	return hub.aplicar({
		tenantId: TENANT,
		deviceId: "handy-1",
		opId,
		commandName: "alta_zona",
		command: { type: "tenantDb.transaction", payload: { steps: [altaDeZona(zona)] } },
		clientNow: "2026-11-08 12:00:00",
	});
}

/** El saludo de una Handy, sin la firma, que no es lo que se prueba. */
async function saludaLaHandy(hub: any, c: Conexion) {
	hub.verifyHelloSigned = async () => ({ roleFinal: "handy", pubkeyB64: "x" });
	await hub.webSocketMessage(c.servidor, JSON.stringify({ type: "helloSigned", ts: Date.now(), nonceB64: "n", sigB64: "s" }));
	return esperar(c, (m) => m.type === "main_status");
}

// ── Saludo firmado de verdad ──────────────────────────────────────────────────

let claves: CryptoKeyPair;
let PUB: string;

beforeAll(async () => {
	claves = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const cruda = (await crypto.subtle.exportKey("raw", claves.publicKey)) as ArrayBuffer;
	PUB = bytesToB64(new Uint8Array(cruda));
});

/** Contesta al reto del DO como la Main (`WS_HELLO`), sin esperar a lo que diga el DO. */
async function mandarSaludo(hub: any, c: Conexion): Promise<void> {
	const reto = await esperar(c, (m) => m.type === "challenge");
	expect(reto).toBeTruthy();
	const ts = Date.now();
	const firmado = new TextEncoder().encode(`WS_HELLO\n${ts}\n${TENANT}\n${c.deviceId}\n${reto.nonceB64}`);
	const firma = await crypto.subtle.sign({ name: "Ed25519" }, claves.privateKey, firmado);
	await hub.webSocketMessage(
		c.servidor,
		JSON.stringify({
			type: "helloSigned",
			ts,
			nonceB64: reto.nonceB64,
			sigB64: bytesToB64(new Uint8Array(firma)),
			recovering: true,
		}),
	);
}

const respuestaAlSaludo = (c: Conexion) =>
	esperar(c, (m) => m.type === "hello_ok" || (m.type === "error" && m.error === "hello_failed"));

/** Saluda y devuelve lo primero que conteste el DO. */
async function saludar(hub: any, c: Conexion): Promise<any> {
	await mandarSaludo(hub, c);
	return respuestaAlSaludo(c);
}

// ══════════════════════════════════════════════════════════════════════════════

describe("AUD-02 · la tabla del DO", () => {
	it("una respuesta vieja que llega tarde no deshace una nueva", async () => {
		await enElHub("aud02-tabla-orden", async (hub: any) => {
			const storage = hub.state.storage;
			expect(mainVigente(storage)).toEqual({ leida: false, deviceId: null });

			const primera = empezarLectura(storage);
			const segunda = empezarLectura(storage);
			expect(segunda).toBeGreaterThan(primera);
			// Empezar una lectura no es leer.
			expect(mainVigente(storage).leida).toBe(false);

			expect(aplicarLectura(storage, segunda, "equipo-b")).toBe(true);
			expect(aplicarLectura(storage, primera, "equipo-a")).toBe(false);
			expect(mainVigente(storage)).toEqual({ leida: true, deviceId: "equipo-b" });

			// Y una anulación (sin Main) se apunta como cualquier otra respuesta.
			expect(aplicarLectura(storage, empezarLectura(storage), null)).toBe(true);
			expect(mainVigente(storage)).toEqual({ leida: true, deviceId: null });
		});
	});

	it("una vez por minuto: quien pregunta se queda la marca antes de esperar", async () => {
		await enElHub("aud02-tabla-minuto", async (hub: any) => {
			const storage = hub.state.storage;
			// Nunca se ha preguntado: toca, y sólo al primero.
			expect(tocaComprobar(storage)).toBe(true);
			expect(tocaComprobar(storage)).toBe(false);

			pasaUnMinuto(hub);
			expect(tocaComprobar(storage)).toBe(true);
			expect(tocaComprobar(storage)).toBe(false);

			// El reloj ha ido hacia atrás: toca, para no quedarse sin preguntar.
			storage.sql.exec("UPDATE _Main_Vigente SET Comprobada_Ms = ? WHERE Id = 1;", Date.now() + 10 * 60_000);
			expect(tocaComprobar(storage)).toBe(true);

			// El aviso de las rutas: toca en la siguiente actividad.
			olvidarComprobacion(storage);
			expect(tocaComprobar(storage)).toBe(true);

			// Toda lectura cuenta para el minuto, también la de un saludo.
			pasaUnMinuto(hub);
			empezarLectura(storage);
			expect(tocaComprobar(storage)).toBe(false);
		});
	});
});

describe("AUD-02 · la tabla sobrevive a un reinicio del DO", () => {
	it("quién es la Main, la marca y el número de las lecturas, y una respuesta de antes del reinicio no se apunta", async () => {
		const nombre = "aud02-tabla-reinicio";
		let lecturaEnVuelo = 0;
		await enElHub(nombre, (hub: any) => {
			const storage = hub.state.storage;
			aplicarLectura(storage, empezarLectura(storage), "equipo-b");
			// Una lectura que sale y no vuelve antes del reinicio.
			lecturaEnVuelo = empezarLectura(storage);
			hub.gbInstancia = "la de antes";
		});

		// El DO se reinicia: la instancia se descarta y el almacenamiento queda.
		await enElHub(nombre, (hub: any) => hub.state.abort("reinicio de prueba")).catch(() => undefined);

		await enElHub(nombre, (hub: any) => {
			const storage = hub.state.storage;
			expect(hub.gbInstancia).toBeUndefined();
			expect(mainVigente(storage)).toEqual({ leida: true, deviceId: "equipo-b" });
			// La marca sigue: no toca preguntar otra vez.
			expect(tocaComprobar(storage)).toBe(false);

			// Las lecturas siguen numerándose desde donde iban.
			const despues = empezarLectura(storage);
			expect(despues).toBe(lecturaEnVuelo + 1);
			expect(aplicarLectura(storage, despues, "equipo-a")).toBe(true);
			// Y la respuesta de la que salió antes del reinicio no deshace la de después.
			expect(aplicarLectura(storage, lecturaEnVuelo, "equipo-b")).toBe(false);
			expect(mainVigente(storage)).toEqual({ leida: true, deviceId: "equipo-a" });
		});
	});
});

describe("AUD-02 · la tabla manda", () => {
	it("una sesión `tpv` autenticada que la tabla no nombra no escribe, no suelta a nadie, no recibe y no cuenta", async () => {
		// No se llega a esto por ningún camino (`fijarMain` echa en el mismo paso en que apunta, y el
		// saludo decide con la tabla), pero es lo que se mira en cada sitio: aquí se fabrica a mano.
		await enElHub("aud02-tabla-manda", async (hub: any) => {
			const { sql, central } = await prepararHub(hub, "main-1");
			laTablaDiceQueLaMainEs(hub, "main-1");
			const main = conectar(hub, "main-1");
			const otra = conectar(hub, "main-2", "tpv", true);
			const handy = conectar(hub, "handy-1", "handy");
			try {
				await hub.webSocketMessage(otra.servidor, applyLote("op-otra", [altaDeZona("z-otra")]));
				expect(await acuseDe(otra, "op-otra")).toMatchObject({ ok: false, error: "not_authenticated" });
				await hub.webSocketMessage(otra.servidor, recoveryReady);
				expect(await esperar(otra, (m) => m.type === "error")).toMatchObject({ error: "not_authenticated" });

				expect(await escribeLaHandy(hub, "op-handy", "z-handy")).toMatchObject({ ok: true });
				expect(await esperar(main, (m) => m.type === "change" && m.opId === "op-handy")).toBeTruthy();
				await unMomento();
				expect(cambios(otra)).toEqual([]);
				expect(handy.recibidos.filter((m) => m.type === "main_volcando")).toEqual([]);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-otra';")).toBe(0);

				// Sin la Main de la tabla, no queda ninguna, aunque `main-2` siga autenticada.
				main.servidor.close(1000, "se va");
				await hub.webSocketClose(main.servidor, 1000, "se va", true);
				expect(hub.isMainConnected()).toBe(false);
				expect(hub.isMainRecovering()).toBe(false);
				expect(central.lecturas).toBe(0);
			} finally {
				await cerrar(hub, main, otra, handy);
			}
		});
	});

	it("nunca leída, cuenta cualquier sesión `tpv`, y la primera actividad la lee y echa a la que no es", async () => {
		// Una sesión que saludó antes de que hubiera tabla: el saludo de ahora siempre la lee.
		await enElHub("aud02-tabla-sin-leer", async (hub: any) => {
			const { sql, central } = await prepararHub(hub, "main-nueva");
			const vieja = conectar(hub, "main-vieja", "tpv", true);
			const handy = conectar(hub, "handy-1", "handy");
			try {
				expect(hub.isMainConnected()).toBe(true);
				// Lo que no lee la tabla decide como antes.
				await hub.webSocketMessage(vieja.servidor, recoveryReady);
				expect(await esperar(vieja, (m) => m.type === "recovery_ready_ack")).toBeTruthy();
				expect(central.lecturas).toBe(0);

				// Lo primero que pregunta, la lee: no es la Main, y se la echa antes de escribir.
				expect(await escribeLaHandy(hub, "op-handy", "z-handy")).toMatchObject({ ok: false, error: "main_offline" });
				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(handy.recibidos).toContainEqual({ type: "main_offline", deviceId: "main-vieja" });
				expect(mainDeLaTabla(hub)).toBe("main-nueva");
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
				expect(central.lecturas).toBe(1);
			} finally {
				await cerrar(hub, vieja, handy);
			}
		});
	});
});

describe("AUD-02 · el traslado sin aviso: la siguiente actividad echa a la Main anterior", () => {
	it("su `apply_lote` no escribe, ni lee, ni llega a la Main nueva, y se la echa con 4001", async () => {
		await enElHub("aud02-lote", async (hub: any) => {
			const { sql, central, eventos } = await trasladoSinAviso(hub, "main-vieja", "main-nueva");
			sql.exec(
				"INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES ('u-1', ?, 'admin@ejemplo.test', 'pbkdf2$ficticio', 'Admin');",
				ADMIN,
			);
			const vieja = conectar(hub, "main-vieja");
			// La Main nueva ya está dentro, pero la tabla todavía no lo sabe.
			const nueva = conectar(hub, "main-nueva");
			try {
				await hub.webSocketMessage(
					vieja.servidor,
					applyLote("op-x", [
						altaDeZona("z-intrusa"),
						{ kind: "rows", sql: "SELECT ID_Usuario, Password_Hash FROM Usuarios;", saveAs: "r" },
					]),
				);

				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				await unMomento();

				// Ni confirmación ni lectura de vuelta.
				expect(lotesAplicados(vieja)).toEqual([]);
				// Nada en la base del negocio ni en el log de sync.
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-intrusa';")).toBe(0);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Sync_Changes;")).toBe(0);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Applied_Operations;")).toBe(0);
				// Nada que la Main nueva vaya a ejecutar.
				expect(cambios(nueva)).toEqual([]);

				// La tabla ya dice quién es; la sesión queda fuera y sin autenticar, y su salida se ha
				// contabilizado (`sessionGone`) sin dar el negocio por sin Main.
				expect(mainDeLaTabla(hub)).toBe("main-nueva");
				expect(att(vieja)).toMatchObject({ authed: false, fuera: true });
				expect(nueva.recibidos.filter((m) => m.type === "main_offline")).toEqual([]);
				expect(hub.isMainConnected()).toBe(true);
				expect(eventos).toContainEqual({ name: "main_expulsada", device_id: "main-vieja", motivo: "device_replaced" });
				expect(central.lecturas).toBe(1);
				expect(nueva.cierre).toBeNull();
			} finally {
				await cerrar(hub, vieja, nueva);
			}
		});
	});

	it("una vez fuera no recibe lo del negocio ni los avisos de la Main, y no cuenta como Main", async () => {
		await enElHub("aud02-fuera", async (hub: any) => {
			const { sql } = await trasladoSinAviso(hub, "main-vieja", "main-nueva");
			const vieja = conectar(hub, "main-vieja");
			const nueva = conectar(hub, "main-nueva");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				await hub.webSocketMessage(vieja.servidor, applyLote("op-x", [altaDeZona("z-intrusa")]));
				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				const hasta = vieja.recibidos.length;

				// La Main nueva y una Handy escriben; se manda además un aviso sólo para la Main.
				await hub.webSocketMessage(nueva.servidor, applyLote("op-nueva", [altaDeZona("z-nueva")]));
				expect(await acuseDe(nueva, "op-nueva")).toMatchObject({ ok: true, resultados: [{ ok: true }] });
				expect(await escribeLaHandy(hub, "op-handy", "z-handy")).toMatchObject({ ok: true });
				hub.avisarEmparejamiento();
				expect(await esperar(nueva, (m) => m.type === "pair_request")).toBeTruthy();
				expect(await esperar(handy, (m) => m.type === "change" && m.opId === "op-nueva")).toBeTruthy();
				await unMomento();

				expect(vieja.recibidos.slice(hasta).filter((m) => m.type === "change" || m.type === "pair_request")).toEqual([]);

				// Y al irse la Main nueva no queda ninguna: las Handy se congelan.
				nueva.servidor.close(1000, "se va");
				await hub.webSocketClose(nueva.servidor, 1000, "se va", true);
				expect(hub.isMainConnected()).toBe(false);
				expect(hub.isMainReady()).toBe(false);
				expect(await escribeLaHandy(hub, "op-handy-sola", "z-handy-sola")).toMatchObject({ ok: false, error: "main_offline" });
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-handy-sola';")).toBe(0);
			} finally {
				await cerrar(hub, vieja, nueva, handy);
			}
		});
	});

	it("la Main de una licencia anulada también: 4001 y el negocio se queda sin Main", async () => {
		// El reembolso o la disputa de un alta, o la anulación a mano, cuando el aviso de cierre no llegó.
		await enElHub("aud02-anulada", async (hub: any) => {
			const { sql } = await trasladoSinAviso(hub, "main-unica", null);
			const main = conectar(hub, "main-unica");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				await hub.webSocketMessage(main.servidor, applyLote("op-x", [altaDeZona("z-anulada")]));

				expect(await esperarCierre(main)).toEqual({ code: 4001, reason: "license_revoked" });
				await unMomento();
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-anulada';")).toBe(0);
				expect(mainDeLaTabla(hub)).toBeNull();
				// `sessionGone`: era la única Main, así que las Handy se enteran.
				expect(handy.recibidos).toContainEqual({ type: "main_offline", deviceId: "main-unica" });
				expect(hub.isMainConnected()).toBe(false);
			} finally {
				await cerrar(hub, main, handy);
			}
		});
	});

	it("veinte lotes suyos a la vez hacen una sola lectura, y no entra ninguno", async () => {
		await enElHub("aud02-veinte-vieja", async (hub: any) => {
			const { sql, central } = await trasladoSinAviso(hub, "main-vieja", "main-nueva");
			const vieja = conectar(hub, "main-vieja");
			try {
				central.retenerLicencias = true;
				const ids = Array.from({ length: 20 }, (_, i) => `op-${String(i + 1).padStart(2, "0")}`);
				await Promise.all(ids.map((id) => hub.webSocketMessage(vieja.servidor, applyLote(id, [altaDeZona(`z-${id}`)]))));

				// El primero pregunta en la fila de entrada; los demás esperan detrás de él.
				expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);
				await unMomento();
				expect(central.lecturas).toBe(1);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Applied_Operations;")).toBe(0);

				central.retenerLicencias = false;
				soltarTodas(central);
				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				await unMomento();

				expect(central.lecturas).toBe(1);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Applied_Operations;")).toBe(0);
				expect(lotesAplicados(vieja)).toEqual([]);
			} finally {
				soltarTodas(central);
				await cerrar(hub, vieja);
			}
		});
	});
});

describe("AUD-02 · la Main anterior que no escribe también deja de serlo", () => {
	// El aviso de cierre del traslado no llegó, la Main nueva aún no ha saludado y al equipo
	// anterior le basta con callarse: seguía recibiendo todo y contando como Main sin límite.

	it("una escritura de la Handy pregunta antes, no la cuenta como Main ni le entrega el cambio", async () => {
		await enElHub("aud02-pasiva-handy", async (hub: any) => {
			const { sql, central } = await trasladoSinAviso(hub, "main-vieja", "main-nueva");
			const vieja = conectar(hub, "main-vieja");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				expect(hub.isMainReady()).toBe(true);

				expect(await escribeLaHandy(hub, "op-handy", "z-handy")).toMatchObject({ ok: false, error: "main_offline" });

				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
				expect(cambios(vieja)).toEqual([]);
				expect(hub.isMainConnected()).toBe(false);
				// Las Handy se enteran de que no hay Main.
				expect(handy.recibidos).toContainEqual({ type: "main_offline", deviceId: "main-vieja" });
				expect(central.lecturas).toBe(1);
			} finally {
				await cerrar(hub, vieja, handy);
			}
		});
	});

	it("a una Handy que saluda no se le dice que hay Main", async () => {
		await enElHub("aud02-pasiva-saludo", async (hub: any) => {
			const { central } = await trasladoSinAviso(hub, "main-vieja", "main-nueva");
			const vieja = conectar(hub, "main-vieja");
			const handy = sinSaludar(hub, "handy-1", "handy");
			try {
				expect(await saludaLaHandy(hub, handy)).toMatchObject({ online: false });
				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(central.lecturas).toBe(1);
			} finally {
				await cerrar(hub, vieja, handy);
			}
		});
	});

	it("el aviso de emparejamiento pregunta antes, y sólo le llega a la Main de la licencia", async () => {
		await enElHub("aud02-pasiva-aviso", async (hub: any) => {
			const { central } = await trasladoSinAviso(hub, "main-vieja", "main-nueva");
			const vieja = conectar(hub, "main-vieja");
			const nueva = conectar(hub, "main-nueva");
			try {
				hub.avisarEmparejamiento();
				expect(await esperar(nueva, (m) => m.type === "pair_request")).toBeTruthy();
				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(vieja.recibidos.filter((m) => m.type === "pair_request")).toEqual([]);
				expect(central.lecturas).toBe(1);
			} finally {
				await cerrar(hub, vieja, nueva);
			}
		});
	});

	it("un socket que no ha saludado no recibe los cambios, aunque sea de la Main", async () => {
		// Abrió el socket con un ticket de cuando era la Main y se quedó sin saludar.
		await enElHub("aud02-sin-saludar", async (hub: any) => {
			await prepararHub(hub, "main-nueva");
			laTablaDiceQueLaMainEs(hub, "main-nueva");
			const callado = sinSaludar(hub, "main-vieja", "tpv");
			const propio = sinSaludar(hub, "handy-2", "handy");
			const nueva = conectar(hub, "main-nueva");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				expect(await escribeLaHandy(hub, "op-handy", "z-handy")).toMatchObject({ ok: true });
				expect(await esperar(nueva, (m) => m.type === "change" && m.opId === "op-handy")).toBeTruthy();
				await unMomento();

				for (const c of [callado, propio]) {
					expect(c.recibidos.filter((m) => m.type === "change")).toEqual([]);
				}
			} finally {
				await cerrar(hub, callado, propio, nueva, handy);
			}
		});
	});

	it("dentro de su minuto sigue dentro, y la primera actividad después la echa", async () => {
		// La ventana que queda si el aviso de cierre falla: lo que le quede al minuto de la última lectura.
		await enElHub("aud02-pasiva-ventana", async (hub: any) => {
			const { sql, central } = await prepararHub(hub, "main-nueva");
			laTablaDiceQueLaMainEs(hub, "main-vieja");
			const vieja = conectar(hub, "main-vieja");
			try {
				expect(await escribeLaHandy(hub, "op-1", "z-1")).toMatchObject({ ok: true });
				expect(await esperar(vieja, (m) => m.type === "change" && m.opId === "op-1")).toBeTruthy();
				expect(central.lecturas).toBe(0);

				pasaUnMinuto(hub);
				const hasta = vieja.recibidos.length;
				expect(await escribeLaHandy(hub, "op-2", "z-2")).toMatchObject({ ok: false, error: "main_offline" });
				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(cambios(vieja, hasta)).toEqual([]);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(1);
				expect(central.lecturas).toBe(1);
			} finally {
				await cerrar(hub, vieja);
			}
		});
	});
});

describe("AUD-02 · la Main de la licencia no nota la comprobación", () => {
	it("todo lo que sube se atiende, con una lectura de la base central por minuto", async () => {
		await enElHub("aud02-legitima", async (hub: any) => {
			const { sql, central } = await trasladoSinAviso(hub, "main-nueva", "main-nueva");
			const main = conectar(hub, "main-nueva");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				for (const i of [1, 2, 3]) {
					await hub.webSocketMessage(main.servidor, applyLote(`op-${i}`, [altaDeZona(`z-${i}`)]));
					expect(await acuseDe(main, `op-${i}`)).toMatchObject({ ok: true, resultados: [{ ok: true }] });
				}
				await hub.webSocketMessage(main.servidor, applyLote("op-b1", [altaDeZona("z-lote")]));
				expect(await acuseDe(main, "op-b1")).toMatchObject({
					ok: true,
					resultados: [{ opId: "op-b1", ok: true }],
				});
				await hub.webSocketMessage(main.servidor, recoveryReady);
				expect(await esperar(main, (m) => m.type === "recovery_ready_ack")).toBeTruthy();
				// Lo de las Handy también depende de ella, y tampoco cuesta otra lectura.
				expect(await escribeLaHandy(hub, "op-handy", "z-handy")).toMatchObject({ ok: true });
				expect(await esperar(main, (m) => m.type === "change" && m.opId === "op-handy")).toBeTruthy();

				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(5);
				expect(cambios(main).map((m) => m.opId)).toEqual(["op-handy"]);
				expect(central.lecturas).toBe(1);
				// Lo que se sabe está en el SQL del DO (sobrevive a la hibernación).
				expect(mainDeLaTabla(hub)).toBe("main-nueva");

				// Pasado el minuto se vuelve a preguntar, una vez.
				pasaUnMinuto(hub);
				for (const i of [4, 5]) {
					await hub.webSocketMessage(main.servidor, applyLote(`op-${i}`, [altaDeZona(`z-${i}`)]));
					expect(await acuseDe(main, `op-${i}`)).toMatchObject({ ok: true, resultados: [{ ok: true }] });
				}
				expect(central.lecturas).toBe(2);
				expect(main.cierre).toBeNull();
				expect(att(main).authed).toBe(true);

				// Y esa lectura va con plazo: con la base central colgada, el lote no la espera más de lo
				// que la Main espera su acuse, y entra con lo que dice la tabla. El plazo corre en un reloj
				// de mentira: el caso no lo espera de verdad, y si se pierde, falla aquí en vez de colgarse.
				pasaUnMinuto(hub);
				central.retenerLicencias = true;
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				try {
					await hub.webSocketMessage(main.servidor, applyLote("op-6", [altaDeZona("z-6")]));
					expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);
					expect(elLog(sql)).not.toContain("op-6");
					await vi.advanceTimersByTimeAsync(LA_MAIN_ESPERA_SU_ACUSE_MS - 1);
				} finally {
					vi.useRealTimers();
				}
				expect(await acuseDe(main, "op-6")).toMatchObject({ ok: true, resultados: [{ ok: true }] });
				// La base central no ha llegado a contestar: la lectura sigue retenida, y la tabla, igual.
				expect(central.retenidas).toHaveLength(1);
				expect(central.lecturas).toBe(3);
				expect(mainDeLaTabla(hub)).toBe("main-nueva");
				expect(main.cierre).toBeNull();
			} finally {
				soltarTodas(central);
				await cerrar(hub, main, handy);
			}
		});
	});

	it("los lotes se confirman en el orden en que llegaron aunque al primero le cueste más abrir la base", async () => {
		// Antes de coger sitio en el turno del log, cada lote calcula sus hashes y abre la base del
		// negocio (al despertar, el DO comprueba sus migraciones). Si al primero le cuesta y al segundo
		// no, el segundo se le adelantaba: la fila no lo soltaba, pero no esperaba a que el primero
		// tuviera sitio.
		await enElHub("aud02-abrir-la-base", async (hub: any) => {
			const { sql } = await prepararHub(hub, "main-nueva");
			laTablaDiceQueLaMainEs(hub, "main-nueva");
			const main = conectar(hub, "main-nueva");
			const directo = hub.withTenantDbRetry;
			const abrir = retencion();
			let primera = true;
			hub.withTenantDbRetry = async (tenantId: string, run: any) => {
				if (primera) {
					primera = false;
					await abrir.espera;
				}
				return directo(tenantId, run);
			};
			try {
				const ids = Array.from({ length: 10 }, (_, i) => `op-${String(i).padStart(2, "0")}`);
				await Promise.all(ids.map((id, i) => hub.webSocketMessage(main.servidor, applyLote(id, encadenado("z-cred", i)))));
				await unMomento();
				// El primero espera su base, y nadie se le ha adelantado.
				expect(n(sql, "SELECT COUNT(*) AS n FROM Applied_Operations;")).toBe(0);
				expect(acusesDeLote(main)).toEqual([]);

				abrir.soltar();
				expect(await esperarA(() => lotesAplicados(main).length === 10)).toBe(true);
				expect(acusesDeLote(main).map((m) => m.loteId)).toEqual(ids.map((id) => `lote-${id}`));
				const enElLog = sql.exec("SELECT Op_Id FROM Sync_Changes ORDER BY Seq;").toArray().map((f: any) => f.Op_Id);
				expect(enElLog).toEqual(ids);
				expect(nombreDe(sql, "z-cred")).toBe(nombreEncadenado("z-cred", 10));
			} finally {
				abrir.soltar();
				await cerrar(hub, main);
			}
		});
	});

	it("veinte mensajes de varias clases a la vez: una sola lectura, y se atienden todos", async () => {
		await enElHub("aud02-veinte-mezcla", async (hub: any) => {
			const { sql, central } = await trasladoSinAviso(hub, "main-nueva", "main-nueva");
			const main = conectar(hub, "main-nueva", "tpv", true);
			const handy = conectar(hub, "handy-1", "handy");
			try {
				central.retenerLicencias = true;
				const mensajes = Array.from({ length: 20 }, (_, i) => {
					if (i % 3 === 2) return recoveryReady;
					return applyLote(`op-${i}`, [altaDeZona(`z-${i}`)]);
				});
				const enviados = Promise.all(mensajes.map((m) => hub.webSocketMessage(main.servidor, m)));
				expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);
				await unMomento();
				expect(central.lecturas).toBe(1);

				central.retenerLicencias = false;
				soltarTodas(central);
				await enviados;
				expect(await esperarA(() => lotesAplicados(main).length === 14)).toBe(true);
				expect(await esperarA(() => main.recibidos.filter((m) => m.type === "recovery_ready_ack").length === 6)).toBe(true);

				expect(central.lecturas).toBe(1);
				expect(main.cierre).toBeNull();
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(14);
				// Los lotes van en fila: entran en el orden en que llegaron.
				const escrituras = Array.from({ length: 20 }, (_, i) => i).filter((i) => i % 3 !== 2);
				expect(elLog(sql)).toEqual(escrituras.map((i) => `op-${i}`));
			} finally {
				soltarTodas(central);
				await cerrar(hub, main, handy);
			}
		});
	});

	it("veinte lotes a la vez con la lectura en vuelo: una sola, y entran en el orden en que llegaron", async () => {
		// El primero se queda esperando la comprobación; el segundo ya no tendría que preguntar, y antes
		// entraba por delante. Las operaciones dependen unas de otras: el orden se ve en el resultado.
		await enElHub("aud02-veinte-lotes", async (hub: any) => {
			const { sql, central } = await trasladoSinAviso(hub, "main-nueva", "main-nueva");
			const main = conectar(hub, "main-nueva");
			try {
				central.retenerLicencias = true;
				const ids = Array.from({ length: 20 }, (_, i) => `op-${String(i).padStart(2, "0")}`);
				await Promise.all(ids.map((id, i) => hub.webSocketMessage(main.servidor, applyLote(id, encadenado("z-orden", i)))));
				expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);
				await unMomento();
				expect(central.lecturas).toBe(1);
				// Ninguno ha entrado por delante del que espera.
				expect(elLog(sql)).toEqual([]);
				expect(acusesDeLote(main)).toEqual([]);

				central.retenerLicencias = false;
				soltarTodas(central);
				expect(await esperarA(() => lotesAplicados(main).length === 20)).toBe(true);
				expect(acusesDeLote(main).map((m) => m.loteId)).toEqual(ids.map((id) => `lote-${id}`));
				expect(elLog(sql)).toEqual(ids);
				expect(nombreDe(sql, "z-orden")).toBe(nombreEncadenado("z-orden", 20));
				expect(central.lecturas).toBe(1);
			} finally {
				soltarTodas(central);
				await cerrar(hub, main);
			}
		});
	});

	it("un mensaje mal formado, uno vacío, un `ping`, `recovery_ready` o el de una Handy no gastan la lectura", async () => {
		await enElHub("aud02-sin-coste", async (hub: any) => {
			const { sql, central } = await trasladoSinAviso(hub, "main-nueva", "main-nueva");
			const main = conectar(hub, "main-nueva", "tpv", true);
			const handy = conectar(hub, "handy-1", "handy");
			try {
				await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "ping" }));
				await hub.webSocketMessage(main.servidor, "esto no es json");
				await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "no_existe" }));
				await hub.webSocketMessage(
					main.servidor,
					JSON.stringify({
						type: "apply_lote",
						loteId: "mal",
						ops: [{ opId: "sin-nombre", command: { type: "tenantDb.transaction" } }],
					}),
				);
				// Sin operaciones o vacío: no hay trabajo, y se contesta en el acto.
				await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "apply_lote", loteId: "raro", ops: {} }));
				await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "apply_lote", loteId: "vacio", ops: [] }));
				// Mensajes de los que ya no existen: un tipo desconocido más.
				await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "event", name: "mesa.abierta" }));
				await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "bulk_apply", ops: [] }));
				await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "apply", opId: "op-suelta" }));
				await hub.webSocketMessage(main.servidor, JSON.stringify({ type: "cola_apartada_ack", opIds: [] }));
				// Soltar a las Handy no pregunta nada: decide la tabla.
				await hub.webSocketMessage(main.servidor, recoveryReady);
				// Una Handy que lo intenta se rechaza por su rol, sin preguntar por ninguna licencia.
				await hub.webSocketMessage(handy.servidor, applyLote("op-hb", [altaDeZona("z-hb")]));
				await hub.webSocketMessage(handy.servidor, recoveryReady);
				await unMomento();

				expect(acusesDeLote(main)).toMatchObject([
					{ loteId: "mal", ok: false, error: "missing_apply_fields" },
					{ loteId: "raro", ok: false, error: "missing_apply_fields" },
					{ loteId: "vacio", ok: true, resultados: [] },
				]);
				expect(main.recibidos.filter((m) => m.type === "error" && m.error === "unknown_type")).toHaveLength(5);
				expect(handy.recibidos.filter((m) => m.type === "event")).toEqual([]);
				expect(main.recibidos.filter((m) => m.type === "recovery_ready_ack")).toHaveLength(1);
				expect(acusesDeLote(handy)).toMatchObject([{ ok: false, error: "forbidden_not_tpv" }]);
				expect(central.lecturas).toBe(0);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
				expect(main.cierre).toBeNull();
			} finally {
				await cerrar(hub, main, handy);
			}
		});
	});

	it("con la base central caída o rechazando la consulta no se rechaza nada, y las Handy se sueltan", async () => {
		await enElHub("aud02-central-caida", async (hub: any) => {
			const { sql, central } = await trasladoSinAviso(hub, "main-nueva", "main-nueva");
			central.caida = true;
			// La Main saludó poniéndose al día: las Handy esperan a que las suelte.
			const main = conectar(hub, "main-nueva", "tpv", true);
			const handy = conectar(hub, "handy-1", "handy");
			const handy2 = sinSaludar(hub, "handy-2", "handy");
			try {
				await hub.webSocketMessage(main.servidor, applyLote("op-1", [altaDeZona("z-1")]));
				expect(await acuseDe(main, "op-1")).toMatchObject({ ok: true, resultados: [{ ok: true }] });
				expect(central.lecturas).toBe(1);
				await hub.webSocketMessage(main.servidor, applyLote("op-b1", [altaDeZona("z-b1")]));
				expect(await acuseDe(main, "op-b1")).toMatchObject({
					ok: true,
					resultados: [{ opId: "op-b1", ok: true }],
				});

				// `recovery_ready` no lee nada: suelta a las Handy con la base central caída.
				await hub.webSocketMessage(main.servidor, recoveryReady);
				expect(await esperar(main, (m) => m.type === "recovery_ready_ack")).toBeTruthy();
				expect(await esperar(handy, (m) => m.type === "main_volcando" && m.volcando === false)).toBeTruthy();
				expect(await escribeLaHandy(hub, "op-handy", "z-handy")).toMatchObject({ ok: true });
				expect(await saludaLaHandy(hub, handy2)).toMatchObject({ online: true, volcando: false });
				// No se insiste: como mucho una pregunta por minuto, conteste o no.
				expect(central.lecturas).toBe(1);
				expect(mainDeLaTabla(hub)).toBe("main-nueva");

				// La base central contesta, pero rechaza la consulta: tampoco se rechaza nada.
				central.caida = false;
				central.rechaza = true;
				pasaUnMinuto(hub);
				await hub.webSocketMessage(main.servidor, applyLote("op-2", [altaDeZona("z-2")]));
				expect(await acuseDe(main, "op-2")).toMatchObject({ ok: true, resultados: [{ ok: true }] });
				expect(central.lecturas).toBe(2);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(4);
				expect(main.cierre).toBeNull();
				expect(att(main).authed).toBe(true);

				// La base central vuelve, y entretanto la licencia se había trasladado.
				central.rechaza = false;
				await laLicenciaDiceQueLaMainEs(central.base, TENANT, "otro-equipo");
				pasaUnMinuto(hub);
				await hub.webSocketMessage(main.servidor, applyLote("op-3", [altaDeZona("z-3")]));
				expect(await esperarCierre(main)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(4);
			} finally {
				await cerrar(hub, main, handy, handy2);
			}
		});
	});
});

describe("AUD-02 · una expulsión entre la última espera y lo que se iba a hacer", () => {
	// La rama espera la comprobación por actividad; mientras tanto se echa a su sesión (el aviso de
	// las rutas). La respuesta, cuando llega, dice que sigue siendo la Main: lo que decide es la
	// sesión como está después de esperar, no como estaba antes.

	async function conLaLecturaRetenida(hub: any, mensaje: string) {
		const preparado = await trasladoSinAviso(hub, "main-1", "main-1");
		const main = conectar(hub, "main-1");
		const handy = conectar(hub, "handy-1", "handy");
		preparado.central.retenerLicencias = true;
		// La rama se queda esperando la lectura: no se la espera aquí.
		const atendido = hub.webSocketMessage(main.servidor, mensaje);
		expect(await esperarA(() => preparado.central.retenidas.length === 1)).toBe(true);

		hub.revocarDispositivo("main-1");
		expect(await esperarCierre(main)).toEqual({ code: 4001, reason: "revoked" });

		preparado.central.retenerLicencias = false;
		soltarTodas(preparado.central);
		await atendido;
		await unMomento();
		expect(mainDeLaTabla(hub)).toBe("main-1");
		return { ...preparado, main, handy };
	}

	it("`apply_lote`, que espera la lectura en la fila de entrada: no escribe", async () => {
		await enElHub("aud02-espera-lote", async (hub: any) => {
			const { sql, main, handy, central } = await conLaLecturaRetenida(hub, applyLote("op-b1", [altaDeZona("z-b1")]));
			try {
				expect(lotesAplicados(main)).toEqual([]);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Applied_Operations;")).toBe(0);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
				expect(cambios(handy)).toEqual([]);
			} finally {
				soltarTodas(central);
				await cerrar(hub, main, handy);
			}
		});
	});

	it("`recovery_ready` no espera nada, y una vez echada no suelta a nadie", async () => {
		await enElHub("aud02-espera-ready", async (hub: any) => {
			const { central } = await trasladoSinAviso(hub, "main-1", "main-1");
			const main = conectar(hub, "main-1", "tpv", true);
			const handy = conectar(hub, "handy-1", "handy");
			try {
				hub.revocarDispositivo("main-1");
				expect(await esperarCierre(main)).toEqual({ code: 4001, reason: "revoked" });
				await hub.webSocketMessage(main.servidor, recoveryReady);
				await unMomento();
				expect(main.recibidos.filter((m) => m.type === "recovery_ready_ack")).toEqual([]);
				expect(handy.recibidos.filter((m) => m.type === "main_volcando")).toEqual([]);
				expect(central.lecturas).toBe(0);
			} finally {
				await cerrar(hub, main, handy);
			}
		});
	});
});

describe("AUD-02 · el turno del log", () => {
	it("el lote que esperaba el turno no entra si entretanto se echa a su sesión", async () => {
		// El mensaje pasó su comprobación y espera detrás de otra escritura. Llega el aviso de las
		// rutas y se echa su socket.
		await enElHub("aud02-turno-retenido", async (hub: any) => {
			const { sql, central, turno } = await prepararHub(hub, "main-1");
			laTablaDiceQueLaMainEs(hub, "main-1");
			const main = conectar(hub, "main-1");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				// Una escritura de la Handy tiene el turno: su lote no ha vuelto de la base.
				turno.texto = "z-handy";
				const deLaHandy = escribeLaHandy(hub, "op-handy", "z-handy");
				expect(await esperarA(() => turno.retenidos === 1)).toBe(true);

				// La Main manda el suyo, que se queda esperando el turno.
				await hub.webSocketMessage(main.servidor, applyLote("op-main", [altaDeZona("z-main")]));
				await unMomento();

				// El aviso: se echa su socket. Y el turno sigue.
				hub.revocarDispositivo("main-1");
				turno.pausa.soltar();
				expect(await deLaHandy).toMatchObject({ ok: true });
				await unMomento();

				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-handy';")).toBe(1);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-main';")).toBe(0);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Applied_Operations WHERE Op_Id = 'op-main';")).toBe(0);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Sync_Changes WHERE Op_Id = 'op-main';")).toBe(0);
				expect(lotesAplicados(main)).toEqual([]);
				expect(central.lecturas).toBe(0);
			} finally {
				turno.pausa.soltar();
				await cerrar(hub, main, handy);
			}
		});
	});

	it("una espera larga en el turno con el traslado en medio: se pregunta al llegarle el turno", async () => {
		// Se le preguntó hace nada, cuando aún era la Main, y su lote se queda esperando el turno.
		// Mientras espera se traslada la licencia, el aviso no llega y pasa el minuto. Cuando le toca,
		// se pregunta antes de enviarlo.
		await enElHub("aud02-turno-traslado", async (hub: any) => {
			const { sql, central, turno } = await prepararHub(hub, "main-vieja");
			laTablaDiceQueLaMainEs(hub, "main-vieja");
			const vieja = conectar(hub, "main-vieja");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				turno.texto = "z-handy";
				const deLaHandy = escribeLaHandy(hub, "op-handy", "z-handy");
				expect(await esperarA(() => turno.retenidos === 1)).toBe(true);
				await hub.webSocketMessage(vieja.servidor, applyLote("op-vieja", [altaDeZona("z-vieja")]));
				await unMomento();
				expect(central.lecturas).toBe(0);

				await laLicenciaDiceQueLaMainEs(central.base, TENANT, "main-nueva");
				pasaUnMinuto(hub);
				turno.pausa.soltar();
				expect(await deLaHandy).toMatchObject({ ok: true });

				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				await unMomento();
				expect(n(sql, "SELECT COUNT(*) AS n FROM Applied_Operations WHERE Op_Id = 'op-vieja';")).toBe(0);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-vieja';")).toBe(0);
				expect(lotesAplicados(vieja)).toEqual([]);
				expect(central.lecturas).toBe(1);
				expect(mainDeLaTabla(hub)).toBe("main-nueva");
			} finally {
				turno.pausa.soltar();
				await cerrar(hub, vieja, handy);
			}
		});
	});

	it("tampoco el de la sesión que reemplaza su propia reconexión: lo vuelve a mandar la nueva", async () => {
		await enElHub("aud02-turno-reemplazada", async (hub: any) => {
			const { sql, central, turno } = await prepararHub(hub, "main-nueva");
			laTablaDiceQueLaMainEs(hub, "main-nueva");
			const handy = conectar(hub, "handy-1", "handy");
			const primera = conectar(hub, "main-nueva");
			let segunda: Conexion | null = null;
			try {
				turno.texto = "z-handy";
				const deLaHandy = escribeLaHandy(hub, "op-handy", "z-handy");
				expect(await esperarA(() => turno.retenidos === 1)).toBe(true);
				await hub.webSocketMessage(primera.servidor, applyLote("op-1", [altaDeZona("z-1")]));
				await unMomento();

				// La Main reconecta: el DO echa su sesión anterior.
				segunda = await abrir(hub, "main-nueva");
				expect(await esperarCierre(primera)).toEqual({ code: 4000, reason: "replaced" });
				expect(await saludar(hub, segunda)).toMatchObject({ type: "hello_ok" });
				expect(att(primera)).toMatchObject({ authed: false, fuera: true });
				turno.pausa.soltar();
				await deLaHandy;
				await unMomento();
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-1';")).toBe(0);

				// La sesión nueva la manda otra vez, y entra una sola vez.
				await hub.webSocketMessage(segunda.servidor, applyLote("op-1", [altaDeZona("z-1")]));
				expect(await acuseDe(segunda, "op-1")).toMatchObject({ ok: true, resultados: [{ ok: true }] });
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-1';")).toBe(1);
			} finally {
				turno.pausa.soltar();
				await cerrar(hub, primera, handy, ...(segunda ? [segunda] : []));
			}
		});
	});
});

describe("AUD-02 · los avisos de las rutas", () => {
	it("la baja de un dispositivo echa su sesión con 4001 y no le atiende nada más, aunque la tabla la diera por Main", async () => {
		await enElHub("aud02-revocar", async (hub: any) => {
			const { sql, central } = await prepararHub(hub, "main-1");
			laTablaDiceQueLaMainEs(hub, "main-1");
			const main = conectar(hub, "main-1");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				hub.revocarDispositivo("main-1");

				expect(await esperarCierre(main)).toEqual({ code: 4001, reason: "revoked" });
				expect(att(main)).toMatchObject({ authed: false, fuera: true });
				// `sessionGone`: era la Main, y las Handy se enteran.
				expect(handy.recibidos).toContainEqual({ type: "main_offline", deviceId: "main-1" });
				expect(hub.isMainConnected()).toBe(false);

				// Un cliente que no conteste al cierre podría seguir mandando por ese socket.
				await hub.webSocketMessage(main.servidor, applyLote("op-tardia", [altaDeZona("z-tardia")]));
				await hub.webSocketMessage(main.servidor, applyLote("op-tardia-b", [altaDeZona("z-tardia-b")]));
				await unMomento();
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
				expect(elLog(sql)).toEqual([]);
				expect(central.lecturas).toBe(0);
			} finally {
				await cerrar(hub, main, handy);
			}
		});
	});

	it("un cambio de licencia relee en el acto, sin esperar al minuto, y echa a la que ya no es la Main", async () => {
		await enElHub("aud02-releer", async (hub: any) => {
			const { central, eventos } = await prepararHub(hub, "main-nueva");
			laTablaDiceQueLaMainEs(hub, "main-vieja");
			const vieja = conectar(hub, "main-vieja");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				await hub.releerMain(TENANT);

				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(mainDeLaTabla(hub)).toBe("main-nueva");
				expect(eventos).toContainEqual({ name: "main_expulsada", device_id: "main-vieja", motivo: "device_replaced" });
				expect(handy.recibidos).toContainEqual({ type: "main_offline", deviceId: "main-vieja" });
				expect(central.lecturas).toBe(1);
			} finally {
				await cerrar(hub, vieja, handy);
			}
		});
	});

	it("un aviso de traslado que llega tarde no echa a la Main que ha vuelto a serlo (B→A→B)", async () => {
		// B→A, y el aviso de ese traslado se retrasa; A→B, y B saluda y queda como la Main. Llega
		// entonces el primer aviso: antes echaba a B sin más.
		await enElHub("aud02-aviso-tarde", async (hub: any) => {
			const { central, eventos } = await prepararHub(hub, "equipo-b");
			const handy = conectar(hub, "handy-1", "handy");
			const b = await abrir(hub, "equipo-b");
			try {
				expect(await saludar(hub, b)).toMatchObject({ type: "hello_ok", role: "tpv" });
				const hasta = handy.recibidos.length;

				await hub.releerMain(TENANT);
				await unMomento();

				expect(b.cierre).toBeNull();
				expect(att(b).authed).toBe(true);
				expect(mainDeLaTabla(hub)).toBe("equipo-b");
				expect(hub.isMainConnected()).toBe(true);
				expect(eventos.filter((e) => e.name === "main_expulsada")).toEqual([]);
				expect(handy.recibidos.slice(hasta).filter((m) => m.type === "main_offline")).toEqual([]);
				expect(central.lecturas).toBe(2);
			} finally {
				await cerrar(hub, b, handy);
			}
		});
	});

	it("si la lectura del aviso no contesta, no echa a nadie y la siguiente actividad vuelve a preguntar", async () => {
		await enElHub("aud02-releer-caida", async (hub: any) => {
			const { sql, central } = await prepararHub(hub, "main-nueva");
			laTablaDiceQueLaMainEs(hub, "main-vieja");
			const vieja = conectar(hub, "main-vieja");
			try {
				central.caida = true;
				await hub.releerMain(TENANT);
				await unMomento();
				expect(vieja.cierre).toBeNull();
				expect(mainDeLaTabla(hub)).toBe("main-vieja");
				expect(central.lecturas).toBe(1);

				// Vuelve a contestar: la siguiente actividad pregunta, aunque no haya pasado el minuto.
				central.caida = false;
				await hub.webSocketMessage(vieja.servidor, applyLote("op-1", [altaDeZona("z-1")]));
				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
				expect(central.lecturas).toBe(2);
			} finally {
				await cerrar(hub, vieja);
			}
		});
	});

	it("sin ninguna sesión `tpv` autenticada, el aviso lee igualmente", async () => {
		await enElHub("aud02-releer-vacio", async (hub: any) => {
			const { central } = await prepararHub(hub, "main-1");
			const handy = conectar(hub, "handy-1", "handy");
			try {
				await hub.releerMain(TENANT);
				expect(central.lecturas).toBe(1);
				expect(mainDeLaTabla(hub)).toBe("main-1");
			} finally {
				await cerrar(hub, handy);
			}
		});
	});

	it("si la única Main está a mitad del saludo, el aviso no se pierde: la respuesta vieja no la deja entrar", async () => {
		// B saluda y su lectura de la licencia («es B») se queda esperando. Se traslada a A y llega el
		// aviso: B todavía no está autenticada, pero el aviso lee igual, y su lectura, que empezó
		// después, es la que vale.
		await enElHub("aud02-releer-saludo", async (hub: any) => {
			const { central } = await prepararHub(hub, "equipo-b");
			const handy = conectar(hub, "handy-1", "handy");
			const b = await abrir(hub, "equipo-b");
			try {
				central.retenerLicencias = true;
				await mandarSaludo(hub, b);
				expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);

				central.retenerLicencias = false;
				await laLicenciaDiceQueLaMainEs(central.base, TENANT, "equipo-a");
				await hub.releerMain(TENANT);
				expect(mainDeLaTabla(hub)).toBe("equipo-a");

				// Ahora llega la respuesta vieja: «es B».
				soltarTodas(central);
				expect(await respuestaAlSaludo(b)).toMatchObject({ type: "error", error: "hello_failed", details: "device_replaced" });
				expect(await esperarCierre(b)).toEqual({ code: 4003, reason: "auth_failed" });
				expect(att(b).authed).toBe(false);
				expect(mainDeLaTabla(hub)).toBe("equipo-a");
				expect(hub.isMainConnected()).toBe(false);
				expect(handy.recibidos.filter((m) => m.type === "main_online")).toEqual([]);
				expect(central.lecturas).toBe(2);
			} finally {
				soltarTodas(central);
				await cerrar(hub, b, handy);
			}
		});
	});
});

describe("AUD-02 · el saludo", () => {
	const cierres: [string, (hub: any, c: Conexion) => Promise<void>][] = [
		[
			"el cliente cierra",
			async (hub, c) => {
				c.cliente.close(1000, "se va");
				await hub.webSocketClose(c.servidor, 1000, "se va", true);
			},
		],
		["el socket da un error", async (hub, c) => hub.webSocketError(c.servidor, new Error("se cayó"))],
		// Sin que llegue nada al DO (el runtime no garantiza `webSocketClose`): lo que lo para entonces
		// es el estado del socket.
		[
			"el socket se cierra sin aviso",
			async (hub, c) => {
				hub.webSocketClose = async () => {};
				c.servidor.close(1001, "se fue");
			},
		],
	];

	it.each(cierres)(
		"si mientras el saludo espera a la base central %s, no se autentica ni se anuncia",
		async (_como, cerrarlo) => {
			await enElHub(`aud02-saludo-cerrado-${_como.replace(/\W+/g, "-")}`, async (hub: any) => {
				const { central } = await prepararHub(hub, "main-1");
				const handy = conectar(hub, "handy-1", "handy");
				const main = await abrir(hub, "main-1");
				try {
					central.retenerLicencias = true;
					await mandarSaludo(hub, main);
					expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);

					await cerrarlo(hub, main);
					await unMomento();
					const hasta = handy.recibidos.length;

					central.retenerLicencias = false;
					soltarTodas(central);
					await unMomento();

					const anuncios = handy.recibidos
						.slice(hasta)
						.filter(
							(m) => m.type === "main_online" || m.type === "main_volcando",
						);
					expect(anuncios).toEqual([]);
					expect(att(main).authed).toBe(false);
					expect(hub.isMainConnected()).toBe(false);
					// La lectura sí se apunta: es lo que dice la base central.
					expect(mainDeLaTabla(hub)).toBe("main-1");
				} finally {
					soltarTodas(central);
					await cerrar(hub, main, handy);
				}
			});
		},
	);

	it("un cierre que llega al DO deja la sesión fuera, y lo que tuviera esperando no sigue", async () => {
		await enElHub("aud02-cierre-fuera", async (hub: any) => {
			const { sql, central } = await prepararHub(hub, "main-1");
			laTablaDiceQueLaMainEs(hub, "main-1");
			pasaUnMinuto(hub);
			const main = conectar(hub, "main-1");
			try {
				central.retenerLicencias = true;
				await hub.webSocketMessage(main.servidor, applyLote("op-b1", [altaDeZona("z-b1")]));
				expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);

				main.cliente.close(1000, "se va");
				await hub.webSocketClose(main.servidor, 1000, "se va", true);
				expect(att(main)).toMatchObject({ authed: false, fuera: true });

				central.retenerLicencias = false;
				soltarTodas(central);
				await unMomento();
				expect(elLog(sql)).toEqual([]);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
			} finally {
				soltarTodas(central);
				await cerrar(hub, main);
			}
		});
	});

	it("un `tpv` que ya no es la Main de la licencia no pasa el saludo, aunque firme bien", async () => {
		// El ticket del socket dura 30 s: se emitió antes del traslado y se usa después.
		await enElHub("aud02-saludo-vieja", async (hub: any) => {
			const { sql, central } = await prepararHub(hub, "main-nueva");
			laTablaDiceQueLaMainEs(hub, "main-nueva");
			const nueva = conectar(hub, "main-nueva");
			const vieja = await abrir(hub, "main-vieja");
			try {
				expect(await saludar(hub, vieja)).toMatchObject({ type: "error", error: "hello_failed", details: "device_replaced" });
				expect(await esperarCierre(vieja)).toEqual({ code: 4003, reason: "auth_failed" });
				expect(att(vieja).authed).toBe(false);

				await hub.webSocketMessage(vieja.servidor, applyLote("op-x", [altaDeZona("z-intrusa")]));
				await unMomento();
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas;")).toBe(0);
				expect(cambios(nueva)).toEqual([]);
				expect(nueva.cierre).toBeNull();
				expect(nueva.recibidos.filter((m) => m.type === "main_offline")).toEqual([]);
			} finally {
				await cerrar(hub, vieja, nueva);
			}
		});
	});

	it("el saludo de la Main de la licencia echa a la sesión `tpv` que quedara de otro equipo", async () => {
		// El aviso de cierre del traslado es best-effort. Si no llegó, la sesión anterior sigue dentro
		// sin escribir: recibiendo, y contando como Main lista.
		await enElHub("aud02-saludo-nueva", async (hub: any) => {
			const { sql, central } = await prepararHub(hub, "main-nueva");
			laTablaDiceQueLaMainEs(hub, "main-vieja");
			const vieja = conectar(hub, "main-vieja");
			const handy = conectar(hub, "handy-1", "handy");
			expect(hub.isMainReady()).toBe(true);

			const nueva = await abrir(hub, "main-nueva");
			try {
				expect(await saludar(hub, nueva)).toMatchObject({ type: "hello_ok", role: "tpv" });

				expect(await esperarCierre(vieja)).toEqual({ code: 4001, reason: "device_replaced" });
				expect(att(vieja)).toMatchObject({ authed: false, fuera: true });
				expect(mainDeLaTabla(hub)).toBe("main-nueva");
				// La Main de ahora saluda poniéndose al día: las Handy esperan, ya sin la anterior.
				expect(hub.isMainConnected()).toBe(true);
				expect(hub.isMainReady()).toBe(false);
				expect(await esperar(nueva, (m) => m.type === "main_status")).toMatchObject({ online: true, volcando: true });
				expect(await escribeLaHandy(hub, "op-handy", "z-handy")).toMatchObject({ ok: false, error: "main_volcando" });

				// Lo que escriba la Main nueva ya no le llega a la anterior, y no se vuelve a preguntar:
				// el saludo acaba de hacerlo.
				expect(central.lecturas).toBe(1);
				const hasta = vieja.recibidos.length;
				await hub.webSocketMessage(nueva.servidor, applyLote("op-nueva", [altaDeZona("z-nueva")]));
				expect(await acuseDe(nueva, "op-nueva")).toMatchObject({ ok: true, resultados: [{ ok: true }] });
				expect(await esperar(handy, (m) => m.type === "change" && m.opId === "op-nueva")).toBeTruthy();
				await unMomento();
				expect(cambios(vieja, hasta)).toEqual([]);
				expect(central.lecturas).toBe(1);
				expect(n(sql, "SELECT COUNT(*) AS n FROM Zonas WHERE ID_Zona = 'z-nueva';")).toBe(1);
			} finally {
				await cerrar(hub, vieja, nueva, handy);
			}
		});
	});

	it("la reconexión de la propia Main reemplaza su sesión anterior y no echa a nadie más", async () => {
		await enElHub("aud02-saludo-misma", async (hub: any) => {
			const { central, eventos } = await prepararHub(hub, "main-nueva");
			const handy = conectar(hub, "handy-1", "handy");
			const primera = await abrir(hub, "main-nueva");
			expect(await saludar(hub, primera)).toMatchObject({ type: "hello_ok", role: "tpv" });
			expect(att(primera).authed).toBe(true);

			const segunda = await abrir(hub, "main-nueva");
			try {
				// La anterior se cierra como reemplazada, no como echada por otro equipo.
				expect(await esperarCierre(primera)).toEqual({ code: 4000, reason: "replaced" });
				expect(await saludar(hub, segunda)).toMatchObject({ type: "hello_ok", role: "tpv" });
				await unMomento();

				expect(att(segunda).authed).toBe(true);
				expect(segunda.cierre).toBeNull();
				expect(hub.isMainConnected()).toBe(true);
				expect(handy.cierre).toBeNull();
				expect(att(handy).authed).toBe(true);
				expect(handy.recibidos.filter((m) => m.type === "main_offline")).toEqual([]);
				expect(eventos.filter((e) => e.name === "main_expulsada")).toEqual([]);
			} finally {
				await cerrar(hub, primera, segunda, handy);
			}
		});
	});

	it("dos traslados seguidos (B→A→B) con las respuestas al revés: entra B, que es la Main", async () => {
		// B saluda y su verificación tarda. Se traslada a A, que saluda; su lectura de la licencia
		// («es A») tarda más todavía. Se traslada otra vez a B, cuyo saludo sigue y lee «es B». Llega
		// la respuesta vieja de A: no se apunta, y A no entra.
		await enElHub("aud02-saludo-bab", async (hub: any) => {
			const { central } = await prepararHub(hub, "equipo-b");
			const handy = conectar(hub, "handy-1", "handy");
			const b = await abrir(hub, "equipo-b");
			let a: Conexion | null = null;
			// El saludo de B espera en la verificación de su firma hasta que se le suelte.
			const verificar = hub.verifyHelloSigned.bind(hub);
			let soltarB!: () => void;
			const bSuelta = new Promise<void>((r) => (soltarB = r));
			let bEsperando = false;
			hub.verifyHelloSigned = async (p: any) => {
				if (p.deviceId === "equipo-b" && !bEsperando) {
					bEsperando = true;
					await bSuelta;
				}
				return verificar(p);
			};
			try {
				await mandarSaludo(hub, b);
				expect(await esperarA(() => bEsperando)).toBe(true);

				await laLicenciaDiceQueLaMainEs(central.base, TENANT, "equipo-a");
				a = await abrir(hub, "equipo-a");
				central.retenerLicencias = true;
				await mandarSaludo(hub, a);
				expect(await esperarA(() => central.retenidas.some((r) => r.que === "licenses"))).toBe(true);
				const respuestaDeA = central.retenidas.find((r) => r.que === "licenses")!;

				central.retenerLicencias = false;
				await laLicenciaDiceQueLaMainEs(central.base, TENANT, "equipo-b");
				soltarB();
				expect(await respuestaAlSaludo(b)).toMatchObject({ type: "hello_ok", role: "tpv" });

				respuestaDeA.soltar();
				expect(await respuestaAlSaludo(a)).toMatchObject({ type: "error", error: "hello_failed", details: "device_replaced" });
				expect(await esperarCierre(a)).toEqual({ code: 4003, reason: "auth_failed" });

				expect(mainDeLaTabla(hub)).toBe("equipo-b");
				expect(att(b).authed).toBe(true);
				expect(b.cierre).toBeNull();
				expect(att(a).authed).toBe(false);
				expect(hub.isMainConnected()).toBe(true);
				expect(handy.recibidos.filter((m) => m.type === "main_offline")).toEqual([]);
			} finally {
				soltarB();
				soltarTodas(central);
				await cerrar(hub, b, handy, ...(a ? [a] : []));
			}
		});
	});

	it("un saludo que se quedó esperando a la base central no resucita la sesión que se echó entretanto", async () => {
		// La lectura de la licencia se hizo antes del traslado y su respuesta llega después: después
		// del cierre del equipo anterior y del saludo de la Main nueva.
		await enElHub("aud02-saludo-retenido", async (hub: any) => {
			const { central } = await prepararHub(hub, "main-vieja");
			const handy = conectar(hub, "handy-1", "handy");
			const vieja = await abrir(hub, "main-vieja");
			let nueva: Conexion | null = null;
			try {
				central.retenerLicencias = true;
				await mandarSaludo(hub, vieja);
				expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);

				// El traslado, con su aviso de cierre, y la Main nueva entra.
				await laLicenciaDiceQueLaMainEs(central.base, TENANT, "main-nueva");
				central.retenerLicencias = false;
				hub.revocarDispositivo("main-vieja");
				nueva = await abrir(hub, "main-nueva");
				expect(await saludar(hub, nueva)).toMatchObject({ type: "hello_ok", role: "tpv" });
				const hasta = { nueva: nueva.recibidos.length, handy: handy.recibidos.length };

				// Y ahora llega la respuesta vieja: «es la Main».
				soltarTodas(central);
				await unMomento();

				expect(mainDeLaTabla(hub)).toBe("main-nueva");
				expect(att(vieja)).toMatchObject({ authed: false, fuera: true });
				expect(vieja.recibidos.filter((m) => m.type === "hello_ok" || m.type === "main_status")).toEqual([]);
				expect(vieja.cierre).toEqual({ code: 4001, reason: "revoked" });
				// La Main nueva sigue dentro, y nadie ha oído que la anterior haya vuelto.
				expect(att(nueva).authed).toBe(true);
				expect(nueva.cierre).toBeNull();
				expect(hub.isMainConnected()).toBe(true);
				const anuncios = (c: Conexion, desde: number) =>
					c.recibidos
						.slice(desde)
						.filter((m) => m.deviceId === "main-vieja" && m.type === "main_online");
				expect(anuncios(nueva, hasta.nueva)).toEqual([]);
				expect(anuncios(handy, hasta.handy)).toEqual([]);
			} finally {
				soltarTodas(central);
				await cerrar(hub, vieja, handy, ...(nueva ? [nueva] : []));
			}
		});
	});

	it("ni el saludo que la propia Main dejó a medias al reconectar", async () => {
		await enElHub("aud02-saludo-retenido-misma", async (hub: any) => {
			const { central } = await prepararHub(hub, "main-nueva");
			const primera = await abrir(hub, "main-nueva");
			let segunda: Conexion | null = null;
			try {
				central.retenerLicencias = true;
				await mandarSaludo(hub, primera);
				expect(await esperarA(() => central.retenidas.length === 1)).toBe(true);

				// Reconecta antes de que conteste la base central: el socket anterior se reemplaza.
				central.retenerLicencias = false;
				segunda = await abrir(hub, "main-nueva");
				expect(await saludar(hub, segunda)).toMatchObject({ type: "hello_ok", role: "tpv" });

				soltarTodas(central);
				await unMomento();

				expect(att(primera)).toMatchObject({ authed: false, fuera: true });
				expect(primera.recibidos.filter((m) => m.type === "hello_ok")).toEqual([]);
				expect(att(segunda).authed).toBe(true);
				expect(segunda.cierre).toBeNull();
				expect(hub.isMainConnected()).toBe(true);
			} finally {
				soltarTodas(central);
				await cerrar(hub, primera, ...(segunda ? [segunda] : []));
			}
		});
	});

	it("si el saludo de la Main que reconecta falla, las Handy se enteran sin esperar a `webSocketClose`", async () => {
		// Al abrir el socket nuevo se echa el anterior sin anunciar nada (hay otro vivo). Si el saludo
		// del nuevo falla —aquí, porque la base central no contesta y sin ella un `tpv` no entra—, su
		// cierre es el que anuncia que no hay Main. La prueba no llama a `webSocketClose`.
		await enElHub("aud02-saludo-falla", async (hub: any) => {
			const { central } = await prepararHub(hub, "main-1");
			// El runtime no garantiza `webSocketClose` cuando cierra el propio DO: aquí no llega nunca.
			hub.webSocketClose = async () => {};
			const handy = conectar(hub, "handy-1", "handy");
			const primera = await abrir(hub, "main-1");
			let segunda: Conexion | null = null;
			try {
				expect(await saludar(hub, primera)).toMatchObject({ type: "hello_ok" });
				expect(await esperar(handy, (m) => m.type === "main_online")).toBeTruthy();

				segunda = await abrir(hub, "main-1");
				expect(await esperarCierre(primera)).toEqual({ code: 4000, reason: "replaced" });
				await unMomento();
				expect(handy.recibidos.filter((m) => m.type === "main_offline")).toEqual([]);

				central.caida = true;
				expect(await saludar(hub, segunda)).toMatchObject({ type: "error", error: "hello_failed" });
				expect(await esperarCierre(segunda)).toEqual({ code: 4003, reason: "auth_failed" });
				expect(await esperar(handy, (m) => m.type === "main_offline")).toMatchObject({ deviceId: "main-1" });
				expect(hub.isMainConnected()).toBe(false);
				// La tabla no ha cambiado: lo que no se sabe no se apunta.
				expect(mainDeLaTabla(hub)).toBe("main-1");
			} finally {
				await cerrar(hub, primera, handy, ...(segunda ? [segunda] : []));
			}
		});
	});
});
