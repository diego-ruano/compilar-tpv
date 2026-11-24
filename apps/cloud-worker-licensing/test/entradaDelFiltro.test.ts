// test/entradaDelFiltro.test.ts
//
// AUD-32 — lo que elige quien llama llega a la telemetría filtrado y acotado, en ese orden.
//
// Todo evento que sale hacia Axiom pasa antes, síncrono, por el filtro de datos personales. Tres de
// sus campos los elige quien llama: la ruta de una petición rechazada (sin token, hasta 16 KB) y la
// clave y el nombre de una operación que falla en el `TenantHub`. Se acotan **después** de filtrarlos:
// un JWT o un correo partidos antes de filtrar ya no se reconocerían, y su principio quedaría a la vista.
//
// Sin red: `fetch` sustituido, Axiom en un dominio `.invalid` y la base del negocio en el SQLite del
// propio Durable Object.

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { tenantAuth } from "../src/middleware/tenant";
import { ingestToAxiom } from "../src/observability/axiom";
import { MARCA_DE_RECORTE } from "../src/observability/tope";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { montarMainEnElHub } from "./helpers/mainEnElHub";

const b64url = (texto: string) => btoa(texto).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
/** El JWT de la revisión: un correo en la carga y relleno, más largo que cualquier tope de entrada. */
const JWT = [
	b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
	b64url(JSON.stringify({ sub: "1", email: "ana@example.com", relleno: "r".repeat(300) })),
	"c2lnLW5hdHVyZV8wMA",
].join(".");
/** Lo que no puede salir de ese JWT: la cabecera, el principio de la carga ni la firma. */
const TROZOS_DEL_JWT = ["eyJhbGci", "eyJzdWIi", "c2lnLW5h"];

const AXIOM = { AXIOM_TOKEN: "token-ficticio", AXIOM_DATASET_SYNC: "ds-ficticio", AXIOM_DOMAIN: "axiom.invalid" };

const enviar = vi.fn<typeof fetch>();
beforeEach(() => {
	enviar.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", enviar);
});
afterEach(() => vi.unstubAllGlobals());

/** Los eventos que han salido hacia Axiom. */
const enviados = (): any[] => enviar.mock.calls.flatMap(([, init]) => JSON.parse(String(init?.body)));

describe("AUD-32 · la ruta de una petición rechazada", () => {
	const env = {
		...AXIOM,
		LICENSE_JWT_SECRET: "secreto-ficticio",
	} as unknown as Env;
	const app = new Hono<{ Bindings: Env }>().use("*", tenantAuth as any).all("*", (c) => c.text("dentro"));

	/** El evento `device_auth_rechazado` de la última petición. */
	async function rechazo(ruta: string, metodo = "GET") {
		const respuesta = await app.request("https://tpv-api.test" + ruta, { method: metodo }, env);
		expect(respuesta.status).toBe(401);
		expect(((await respuesta.json()) as any).error).toBe("missing_token");
		await new Promise((r) => setTimeout(r, 0));
		expect(enviar).toHaveBeenCalledTimes(1);
		expect(String(enviar.mock.calls[0][0])).toBe("https://axiom.invalid/v1/ingest/ds-ficticio");
		return enviados()[0];
	}

	it("de 16 KB y sin token, llega con 256 bytes, ya filtrada, y su marca", async () => {
		const ruta = "/v1/clientes/" + "r".repeat(16_000);
		const evento = await rechazo(ruta);
		expect(evento).toMatchObject({ event: "device_auth_rechazado", motivo: "missing_token", metodo: "GET" });
		expect(evento.ruta).toBe(ruta.slice(0, 256 - new TextEncoder().encode(MARCA_DE_RECORTE).length) + MARCA_DE_RECORTE);
		// Y el evento entero es pequeño: nada más lleva texto de quien llama.
		expect(JSON.stringify(evento).length).toBeLessThan(600);
	});

	it("un JWT en la ruta se tapa entero, aunque la ruta pase del tope", async () => {
		const ruta = "/v1/sync/verificar/" + JWT;
		expect(ruta.length).toBeGreaterThan(256);
		const evento = await rechazo(ruta, "POST");
		expect(evento.ruta).toBe("/v1/sync/verificar/[jwt]");
		for (const trozo of TROZOS_DEL_JWT) expect(JSON.stringify(evento), trozo).not.toContain(trozo);
	});

	it("una ruta normal llega entera", async () => {
		const evento = await rechazo("/v1/sync/verificar/resumen", "POST");
		expect(evento).toMatchObject({ ruta: "/v1/sync/verificar/resumen", metodo: "POST" });
	});
});

describe("AUD-32 · la clave y el nombre de una operación que falla en el TenantHub", () => {
	const TENANT = "aud32-negocio-ficticio";
	const CLAVE = "op-" + JWT;
	const NOMBRE = "cmd-" + JWT;

	/** Una operación que la base rechaza siempre. */
	const operacionImposible = () => ({
		opId: CLAVE,
		commandName: NOMBRE,
		cmd: {
			type: "tenantDb.transaction" as const,
			payload: {
				steps: [{ kind: "execute" as const, sql: "INSERT INTO Tabla_Que_No_Existe (a) VALUES (?1);", args: ["x"] }],
			},
		},
		deviceId: "main-ficticia",
		requestPayloadJson: "{}",
		clientNow: "2026-01-01 12:30:00",
	});

	/**
	 * La base del negocio es el SQLite del DO, y los eventos de salud se recogen tal como los emite el
	 * DO. Se mandan después, desde aquí, por la misma salida que usa él (`ingestToAxiom`).
	 */
	function preparar(hub: any): { name: string; fields: Record<string, unknown> }[] {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		const db = clienteSobre(sql, hub.state.storage);
		hub.getTenantDb = async () => db;
		const eventos: { name: string; fields: Record<string, unknown> }[] = [];
		hub.emitSyncEvent = (name: string, fields: Record<string, unknown>) => void eventos.push({ name, fields });
		return eventos;
	}

	/** Lo que llega a Axiom de un evento del DO. */
	async function enAxiom(name: string, fields: Record<string, unknown>) {
		enviar.mockClear();
		expect(await ingestToAxiom(AXIOM as unknown as Env, "ds-ficticio", [{ event: name, ...fields }])).toBe(true);
		return enviados()[0];
	}

	it("apply_error las lleva enteras, y la salida las filtra: el JWT que llevan dentro se tapa entero", async () => {
		const eventos = await enElHub("aud32-apply-error", async (hub: any) => {
			const eventos = preparar(hub);
			hub.isMainConnected = () => true;
			hub.isMainReady = () => true;
			await expect(hub.applyInternalCommandIdempotent({ tenantId: TENANT, ...operacionImposible() })).rejects.toThrow();
			return eventos;
		});
		const fallos = eventos.filter((e) => e.name === "apply_error");
		expect(fallos).toHaveLength(1);
		// Sin recortar: un recorte antes de filtrar se comería el segundo punto del JWT.
		expect(fallos[0].fields).toMatchObject({ op_id: CLAVE, command_name: NOMBRE });
		const enviado = await enAxiom("apply_error", fallos[0].fields);
		expect(enviado).toMatchObject({ op_id: "op-[jwt]", command_name: "cmd-[jwt]" });
		expect(String(enviado.error).length).toBeLessThanOrEqual(500);
		for (const trozo of TROZOS_DEL_JWT) expect(JSON.stringify(enviado), trozo).not.toContain(trozo);
	});

	it("en un lote de la Main también: el veredicto de la operación lleva su clave entera", async () => {
		const { eventos, acuse } = await enElHub("aud32-lote", async (hub: any) => {
			const m = await montarMainEnElHub(hub, TENANT);
			const op = operacionImposible();
			const acuse = await m.mandarLote([{ opId: op.opId, commandName: op.commandName, command: op.cmd }]);
			return { eventos: m.eventos, acuse };
		});
		// Lo que se filtra es la copia del evento: la Main tiene que poder reconocer lo rechazado.
		expect(acuse.resultados).toMatchObject([{ opId: CLAVE, ok: false, permanente: true }]);
		const fallos = eventos.filter((e) => e.name === "apply_error");
		expect(fallos).toHaveLength(1);
		const { name: _nombre, ...campos } = fallos[0];
		expect(campos).toMatchObject({ op_id: CLAVE, command_name: NOMBRE });
		const enviado = await enAxiom("apply_error", campos);
		expect(enviado).toMatchObject({ op_id: "op-[jwt]", command_name: "cmd-[jwt]" });
		for (const trozo of TROZOS_DEL_JWT) expect(JSON.stringify(enviado), trozo).not.toContain(trozo);
	});
});
