// test/copiasDeNegocios.test.ts
//
// DO-03 · La copia diaria de la base de cada negocio, y devolverla a un instante.
//
// - La copia la hace cada TenantHub con su alarma, de su propia base, a su carpeta del bucket
//   `COPIAS_NEGOCIOS` (el de los tests es local): sólo las tablas del negocio, en un volcado SQL
//   que se lee sin nuestro código, y con las 30 más nuevas guardadas.
// - La vuelta a un instante no existe en local (workerd: «does not implement point-in-time
//   recovery»): lo que se prueba con la plataforma de verdad es que la ruta lo dice. El resto, con un
//   doble de `Instantes` dentro del objeto: el orden de las llamadas, que la base queda cerrada
//   mientras tanto, que se echa a las sesiones y cómo queda el log para que la Main no se salte nada.
// - La administración: sin token no entra, y lo que cambia algo queda en `admin_audit`, en una base
//   central de verdad (`helpers/central.ts`); que no conteste se provoca en su stub.

import { env as entorno, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { centralDePrueba, centralInterceptada, filasDe } from "./helpers/central";
import { enElHub } from "./helpers/hub";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { leerPaginaDeCambios } from "../src/domains/sync/sync.routes";
import { PURGADO_HASTA } from "../src/domains/sync/cambiosJson";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import {
	COPIAS_QUE_SE_GUARDAN,
	claveDeCopia,
	listarCopias,
	siguienteCopiaMs,
	volcarNegocio,
} from "../src/durableObjects/tenantHub.copia";
import { CLAVE_VUELTA_EN_CURSO, SALTO_DE_SEQ } from "../src/durableObjects/tenantHub.instante";
import { literalEnUnaLinea } from "../src/durableObjects/volcadoSql";

const env = entorno as any;
const TOKEN = "token-de-pruebas";
const ENV = { ...env, ADMIN_API_TOKEN: TOKEN };
const bucket = env.COPIAS_NEGOCIOS as R2Bucket;

const stub = (tenantId: string) => env.TenantHub.get(env.TenantHub.idFromName(tenantId));

async function pedir(ruta: string, cuerpo: unknown, token: string | null = TOKEN, entorno = ENV) {
	const res = await adminRoutes.fetch(
		new Request(`https://api${ruta}`, {
			method: "POST",
			headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
			body: JSON.stringify(cuerpo),
		}),
		entorno,
	);
	// Un fallo sin capturar sale del `onError` de Hono como texto: sin cuerpo que leer.
	return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

type Central = {
	/** Pide `ruta` a la administración con el token, con esta base central. */
	pedir: (ruta: string, cuerpo: unknown) => ReturnType<typeof pedir>;
	auditoria: () => Promise<any[]>;
	nacer: (t: string) => Promise<unknown>;
	apuntar: (action: string, detail: unknown) => Promise<unknown>;
	/** Desde ahora, la base central falla al apuntar esa acción en `admin_audit`, y sólo ésa. */
	fallarAlApuntar: (action: string) => void;
	/** Y vuelve a contestar. */
	contestar: () => void;
};

/** La sentencia con la que la administración apunta en `admin_audit` (`auditAdmin`). */
const APUNTA_EN_LA_AUDITORIA = /^\s*INSERT INTO admin_audit\b/;

/**
 * Corre `cuerpo` con una base central de verdad, nueva (`admin_audit` vacía). Que no conteste al
 * apuntar una acción se provoca en su stub (`centralInterceptada`): la sentencia no llega a ella.
 */
async function conCentral<R>(cuerpo: (central: Central) => Promise<R>): Promise<R> {
	const base = await centralDePrueba();
	let falla: string | null = null;
	const central = centralInterceptada(base, (metodo, [s], llamar) => {
		const sentencia = s as SentenciaEnlazada;
		return metodo === "ejecutar" &&
			falla !== null &&
			APUNTA_EN_LA_AUDITORIA.test(sentencia.sql) &&
			sentencia.args?.[1] === falla
			? Promise.reject(new Error("la base central no contesta"))
			: llamar();
	});
	return cuerpo({
		pedir: (ruta, datos) => pedir(ruta, datos, TOKEN, { ...ENV, ...central.entorno }),
		auditoria: async () =>
			(await filasDe(base, "SELECT action, detail FROM admin_audit ORDER BY at_ms, rowid;")).map((f) => ({
				action: f.action,
				detail: JSON.parse(f.detail),
			})),
		nacer: (t) =>
			filasDe(
				base,
				`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, disabled, term_months,
				   origin, issued_at_ms, activated_at_ms, customer_email, created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, 'la-main', 'active', 0, 12, 'stripe', 1, 1, 'bar@ejemplo.test', 1, 1);`,
				`lic-${t}`,
				`hash-${t}`,
				t,
			),
		apuntar: (action, detail) =>
			filasDe(
				base,
				"INSERT INTO admin_audit (audit_id, action, license_id, detail, at_ms) VALUES (?, ?, NULL, ?, 1);",
				crypto.randomUUID(),
				action,
				JSON.stringify(detail),
			),
		fallarAlApuntar: (action) => void (falla = action),
		contestar: () => void (falla = null),
	});
}

async function texto(clave: string): Promise<string> {
	const o = await bucket.get(clave);
	if (!o) throw new Error(`no está ${clave}`);
	return new Response(o.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Un negocio con base y unas filas: de negocio, del andamiaje de la réplica y propias del objeto. */
async function negocioConDatos(tenantId: string): Promise<void> {
	await stub(tenantId).aprovisionar(tenantId);
	await enElHub(tenantId, (hub: any) => {
		const sql = hub.state.storage.sql;
		sql.exec(
			"INSERT INTO Clientes (ID_Cliente, Nombre, Notas, Total_Gastado) VALUES ('c1', 'Ana O''Neil', ?, 1250);",
			"Sin gluten\nmesa del fondo\r\nsiempre",
		);
		sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
		sql.exec(
			"INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES ('op-1', 'x', '[]', 'la-main', 1);",
		);
		sql.exec("INSERT INTO Intentos_Login (ID_Usuario, Intentos_Fallidos) VALUES ('00000000-0000-7000-8000-000000000501', 3);");
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("DO-03 · la copia diaria", () => {
	it("el alta arma la alarma, y la alarma deja la copia de hoy con sólo las tablas del negocio y vuelve a armarse", async () => {
		const t = "copia-contenido";
		await negocioConDatos(t);
		const antes = await enElHub(t, (hub: any) => hub.state.storage.getAlarm());
		expect(antes).toBeGreaterThan(Date.now());

		expect(await runDurableObjectAlarm(stub(t))).toBe(true);

		const hoy = new Date().toISOString().slice(0, 10);
		const sqlCopia = await texto(claveDeCopia(t, hoy));
		const lineas = sqlCopia.split("\n");

		// Legible sin nuestro código: cabecera, el esquema de las tablas y una sentencia por fila.
		expect(lineas[0]).toContain(`negocio ${t}`);
		expect(lineas).toContain("BEGIN TRANSACTION;");
		expect(lineas.at(-2)).toBe("COMMIT;");
		expect(sqlCopia).toMatch(/CREATE TABLE (IF NOT EXISTS )?Clientes/);
		expect(lineas.find((l) => l.startsWith('INSERT INTO "Zonas" ("ID_Zona", "Nombre_Zona"'))).toMatch(/VALUES \('z1', 'Sala'/);
		const cliente = lineas.find((l) => l.startsWith('INSERT INTO "Clientes"'))!;
		// Un salto de línea dentro de un texto no parte la sentencia.
		expect(cliente).toContain("('Sin gluten'||char(10)||'mesa del fondo'||char(13)||''||char(10)||'siempre')");
		expect(cliente).toContain("'Ana O''Neil'");

		// Nada que no sea del negocio.
		for (const tabla of ["Sync_Changes", "Applied_Operations", "Sync_Main_Checkpoints", "Intentos_Login", "_Negocio", "_migrations", "_cf_KV"]) {
			expect(sqlCopia).not.toContain(`INSERT INTO "${tabla}"`);
		}
		expect(sqlCopia).not.toMatch(/CREATE TABLE[^(]*(_Negocio|Sync_Changes|Intentos_Login)/);
		expect(sqlCopia).not.toContain("CREATE TRIGGER");

		// Y la siguiente, para mañana de madrugada.
		const despues = (await enElHub(t, (hub: any) => hub.state.storage.getAlarm())) as number;
		expect(despues).toBe(siguienteCopiaMs(t, Date.now()));
		expect(despues - Date.now()).toBeGreaterThan(0);
		expect(despues - Date.now()).toBeLessThanOrEqual(26 * 60 * 60 * 1000);
	});

	it("guarda las 30 más nuevas y borra las demás, sólo de su negocio", async () => {
		const t = "copia-retencion";
		await negocioConDatos(t);
		const viejas = Array.from({ length: COPIAS_QUE_SE_GUARDAN + 5 }, (_, i) =>
			claveDeCopia(t, new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)),
		);
		for (const clave of viejas) await bucket.put(clave, "x");
		// La de otro negocio cuyo nombre empieza igual no es suya.
		await bucket.put(claveDeCopia(`${t}-otro`, "2020-01-01"), "x");

		expect(await runDurableObjectAlarm(stub(t))).toBe(true);

		const quedan = await listarCopias(bucket, t);
		expect(quedan).toHaveLength(COPIAS_QUE_SE_GUARDAN);
		expect(quedan[0].dia).toBe(new Date().toISOString().slice(0, 10));
		expect(quedan.at(-1)!.clave).toBe(viejas.at(-(COPIAS_QUE_SE_GUARDAN - 1)));
		expect(await bucket.head(claveDeCopia(`${t}-otro`, "2020-01-01"))).not.toBeNull();
	});

	it("si la copia falla no propaga: lo vuelve a intentar en una hora", async () => {
		const t = "copia-falla";
		await negocioConDatos(t);
		await enElHub(t, (hub: any) => {
			hub.env = { ...hub.env, COPIAS_NEGOCIOS: { put: async () => { throw new Error("r2_caido"); } } };
		});
		expect(await runDurableObjectAlarm(stub(t))).toBe(true);
		const alarma = (await enElHub(t, (hub: any) => hub.state.storage.getAlarm())) as number;
		expect(alarma - Date.now()).toBeGreaterThan(55 * 60 * 1000);
		expect(alarma - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
	});

	it("un objeto sin base no copia ni se vuelve a armar, y retirarlo quita la alarma", async () => {
		const t = "copia-retirado";
		await negocioConDatos(t);
		await stub(t).borrarTodo();
		expect(await enElHub(t, (hub: any) => hub.state.storage.getAlarm())).toBeNull();

		await enElHub(t, (hub: any) => hub.state.storage.setAlarm(Date.now() + 60_000));
		expect(await runDurableObjectAlarm(stub(t))).toBe(true);
		expect(await enElHub(t, (hub: any) => hub.state.storage.getAlarm())).toBeNull();
		expect(await listarCopias(bucket, t)).toEqual([]);
	});

	it("el techo: una copia que no cabe falla en voz alta", async () => {
		const t = "copia-techo";
		await negocioConDatos(t);
		await enElHub(t, (hub: any) => {
			expect(() => volcarNegocio(hub.state.storage.sql, { tenantId: t, ahora: new Date(), topeComprimido: 100 })).toThrow(
				/copia_demasiado_grande/,
			);
		});
	});

	it("cada valor cabe en una línea y SQLite lo lee igual", async () => {
		await enElHub("copia-literales", (hub: any) => {
			const sql = hub.state.storage.sql;
			const valores = ["a'b\nc\r\nd", "con\0nulo", 12.5, -3, null, new Uint8Array([0, 255, 16]).buffer, ""];
			for (const v of valores) {
				const lit = literalEnUnaLinea(v);
				expect(lit).not.toMatch(/[\r\n]/);
				const leido = sql.exec(`SELECT ${lit} AS v;`).one().v;
				if (v instanceof ArrayBuffer) expect(new Uint8Array(leido)).toEqual(new Uint8Array(v));
				else expect(leido).toEqual(v);
			}
			expect(() => literalEnUnaLinea(Number.NaN)).toThrow(/copia_valor_no_finito/);
		});
	});
});

describe("DO-03 · la administración de la base de un negocio", () => {
	it("sin el token de administración no entra, y sin token configurado está cerrada", async () => {
		for (const ruta of ["/negocios/estado", "/negocios/copiar", "/negocios/instante"]) {
			expect((await pedir(ruta, { tenantId: "x" }, null)).status).toBe(401);
			expect((await pedir(ruta, { tenantId: "x" }, "otro-token")).status).toBe(401);
			expect((await pedir(ruta, { tenantId: "x" }, TOKEN, { ...env, ADMIN_API_TOKEN: "" })).status).toBe(503);
		}
	});

	it("copiar ahora deja la copia y su rastro; el estado la enseña con la próxima", async () => {
		const t = "copia-a-mano";
		await negocioConDatos(t);
		await conCentral(async (central) => {
			await central.nacer(t);

			const r = await central.pedir("/negocios/copiar", { tenantId: t });
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({ ok: true, tenantId: t, clave: claveDeCopia(t, new Date().toISOString().slice(0, 10)) });
			expect(r.body.filas).toBeGreaterThanOrEqual(2);
			expect(await central.auditoria()).toEqual([
				{ action: "negocio_copiar", detail: expect.objectContaining({ tenantId: t, clave: r.body.clave }) },
			]);

			const e = await central.pedir("/negocios/estado", { tenantId: t });
			expect(e.body).toMatchObject({ ok: true, nacido: true, aprovisionado: true, negocio: t, vueltaEnCurso: false });
			expect(e.body.copias.map((c: any) => c.clave)).toEqual([r.body.clave]);
			expect(e.body.proximaCopiaMs).toBeGreaterThan(Date.now());

			// Sin base no hay nada que copiar.
			const vacio = await central.pedir("/negocios/copiar", { tenantId: "copia-sin-base" });
			expect(vacio).toMatchObject({ status: 404, body: { error: "tenant_db_not_provisioned" } });
		});
	});

	it("en local no hay vuelta a un instante, y la ruta lo dice sin tocar nada", async () => {
		const t = "instante-sin-pitr";
		await negocioConDatos(t);
		const r = await conCentral((central) =>
			central.pedir("/negocios/instante", { tenantId: t, instanteMs: Date.now() - 60_000, modo: "nube", motivo: "prueba" }),
		);
		expect(r).toMatchObject({ status: 501, body: { ok: false, error: "vuelta_no_disponible" } });
		expect(await enElHub(t, (hub: any) => hub.state.storage.get(CLAVE_VUELTA_EN_CURSO))).toBeUndefined();
	});

	it("rechaza un instante fuera de los 30 días, o sin decir a qué se vuelve", async () => {
		const fuera = await pedir("/negocios/instante", {
			tenantId: "x",
			instanteMs: Date.now() - 31 * 24 * 60 * 60 * 1000,
			modo: "nube",
			motivo: "prueba",
		});
		expect(fuera).toMatchObject({ status: 400, body: { error: "instante_fuera_de_plazo" } });
		const ninguno = await pedir("/negocios/instante", { tenantId: "x", modo: "nube", motivo: "prueba" });
		expect(ninguno.status).toBe(400);
		const sinModo = await pedir("/negocios/instante", { tenantId: "x", marcador: "m", motivo: "prueba" });
		expect(sinModo.status).toBe(400);
	});
});

/**
 * El doble de la plataforma. «Reiniciar» hace lo que se ve desde fuera de volver a un instante
 * anterior a la preparación: se lleva la marca de vuelta en curso, que es de después.
 */
function dobleDeInstantes(hub: any, llamadas: string[]) {
	hub.instantes = {
		marcadorActual: async () => (llamadas.push("actual"), "m-actual"),
		marcadorDe: async (ms: number) => (llamadas.push(`de:${typeof ms}`), "m-destino"),
		restaurarAlReiniciar: async (m: string) => (llamadas.push(`restaurar:${m}`), "m-deshacer"),
		reiniciar: () => {
			llamadas.push("reiniciar");
			hub.state.storage.delete(CLAVE_VUELTA_EN_CURSO);
		},
	};
}

describe("DO-03 · volver a un instante (con un doble de la plataforma)", () => {
	for (const modo of ["nube", "main"] as const) {
		it(`modo ${modo}: echa a las sesiones, vuelve y abre el log por encima de todo lo numerado`, async () => {
			const t = `instante-${modo}`;
			await negocioConDatos(t);
			const llamadas: string[] = [];
			const cierre: { code?: number; reason?: string } = {};
			const seqAntes = await enElHub(t, (hub: any) => {
				dobleDeInstantes(hub, llamadas);
				const sql = hub.state.storage.sql;
				// La Main va por el 40 y la nube había numerado hasta el 41.
				sql.exec("INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES (41, 'op-41', 'x', '[]', 2);");
				sql.exec("INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES ('la-main', 40, 2);");
				const par = new WebSocketPair();
				hub.state.acceptWebSocket(par[1], ["la-main"]);
				par[1].serializeAttachment({ tenantId: t, deviceId: "la-main", role: "tpv", authed: true, autenticadaMs: Date.now(), recovering: false });
				par[0].accept();
				par[0].addEventListener("close", (ev: CloseEvent) => {
					Object.assign(cierre, { code: ev.code, reason: ev.reason });
				});
				return 41;
			});

			const { r, auditoria } = await conCentral(async (central) => ({
				r: await central.pedir("/negocios/instante", {
					tenantId: t,
					instanteMs: Date.now() - 3_600_000,
					modo,
					motivo: "un borrado por error",
				}),
				auditoria: await central.auditoria(),
			}));
			expect(r.status).toBe(200);
			expect(r.body).toMatchObject({
				ok: true,
				modo,
				destino: "m-destino",
				actual: "m-actual",
				deshacer: "m-deshacer",
				seqAntes,
				aprovisionado: true,
				inicio: seqAntes + SALTO_DE_SEQ,
				purgadoHasta: modo === "nube" ? seqAntes + SALTO_DE_SEQ - 1 : null,
			});
			expect(r.body.queHacer.join(" ")).toContain("--marcador m-deshacer");
			expect(llamadas).toEqual(["de:number", "actual", "restaurar:m-destino", "reiniciar"]);
			await vi.waitFor(() => expect(cierre).toEqual({ code: 4003, reason: "nube_devuelta" }));

			// Lo que ve la Main al pedir cambios desde su checkpoint: el cambio vacío, nada que se salte,
			// y con `nube`, que a su base le falta un tramo (SYNC-32: se trae la nube).
			const pagina = await enElHub(t, (hub: any) => leerPaginaDeCambios(clienteLocal(hub.state.storage), 40, 100));
			expect(pagina.items.map((c: any) => [Number(c.Seq), c.Statements_Json])).toEqual([
				[41, "[]"],
				[seqAntes + SALTO_DE_SEQ, "[]"],
			]);
			expect(pagina.highWater).toBe(seqAntes + SALTO_DE_SEQ);
			if (modo === "nube") expect(pagina.purgadoHasta).toBeGreaterThan(40);
			else expect(pagina.purgadoHasta).toBeLessThan(40);

			// La base vuelve a atender, y queda el rastro con el motivo.
			expect(await stub(t).leerParaLaWeb(t, { que: "plano" })).toMatchObject({ ok: true });
			expect(auditoria).toEqual([
				// Antes de abrir el log, desde dónde se abrirá (DO-PERDIDA).
				{
					action: "negocio_log_reservado",
					detail: { tenantId: t, operacion: "instante", seqAntes, inicio: seqAntes + SALTO_DE_SEQ },
				},
				{
					action: "negocio_volver_a_instante",
					detail: expect.objectContaining({ tenantId: t, modo, deshacer: "m-deshacer", motivo: "un borrado por error" }),
				},
			]);

			// Deshacer es volver al marcador: otra vez por encima de lo último numerado.
			const deshecho = await conCentral((central) =>
				central.pedir("/negocios/instante", { tenantId: t, marcador: "m-deshacer", modo, motivo: "deshacer" }),
			);
			expect(deshecho.body).toMatchObject({ ok: true, destino: "m-deshacer", inicio: seqAntes + 2 * SALTO_DE_SEQ });
		});
	}

	it("abre por encima también de lo que numeró una base anterior del negocio, que el objeto no recuerda (DO-PERDIDA)", async () => {
		const t = "instante-tras-perdida";
		await negocioConDatos(t);
		await enElHub(t, (hub: any) => dobleDeInstantes(hub, []));
		// El negocio ya perdió una base, cuyo log se abrió en el 5·salto: la Main puede ir por ahí.
		const anterior = 5 * SALTO_DE_SEQ;
		const r = await conCentral(async (central) => {
			await central.apuntar("negocio_base_vacia", { tenantId: t, modo: "main", inicio: anterior, purgadoHasta: null });
			await central.apuntar("negocio_base_vacia", { tenantId: "otro-negocio", modo: "main", inicio: 9 * SALTO_DE_SEQ });
			return central.pedir("/negocios/instante", { tenantId: t, marcador: "m", modo: "main", motivo: "prueba" });
		});
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ ok: true, seqAntes: 1, seqConocido: anterior, inicio: anterior + SALTO_DE_SEQ });
	});

	it("si la base central no apunta la vuelta con el log ya abierto, una pérdida después abre igual por encima (DO-PERDIDA)", async () => {
		const t = "instante-sin-rastro";
		await negocioConDatos(t);
		await enElHub(t, (hub: any) => dobleDeInstantes(hub, []));
		const r = await conCentral(async (central) => {
			await central.nacer(t);
			// El objeto vuelve y abre el log, y la base central falla justo al apuntar la vuelta.
			central.fallarAlApuntar("negocio_volver_a_instante");
			const vuelta = await central.pedir("/negocios/instante", { tenantId: t, marcador: "m", modo: "main", motivo: "prueba" });
			central.contestar();
			const abierto = await enElHub(t, (hub: any) =>
				Number(hub.state.storage.sql.exec("SELECT MAX(Seq) AS s FROM Sync_Changes WHERE Command_Name = 'nube_devuelta';").one().s),
			);
			// La Main baja de ese log, y el objeto se pierde antes de la copia de la noche.
			await stub(t).borrarTodo();
			const vacia = await central.pedir("/negocios/base-vacia", { tenantId: t, modo: "main", motivo: "se perdió" });
			return { vuelta, abierto, vacia };
		});
		expect(r.vuelta.status).toBe(500);
		expect(r.abierto).toBe(1 + SALTO_DE_SEQ);
		expect(r.vacia.status).toBe(200);
		expect(r.vacia.body.seqConocido).toBeGreaterThanOrEqual(r.abierto);
		expect(r.vacia.body.inicio).toBeGreaterThanOrEqual(r.abierto + SALTO_DE_SEQ);
	});

	it("si la base central no contesta al apuntar desde dónde se abre el log, la vuelta no lo abre y lo dice", async () => {
		const t = "instante-sin-reserva";
		await negocioConDatos(t);
		const llamadas: string[] = [];
		await enElHub(t, (hub: any) => dobleDeInstantes(hub, llamadas));
		const r = await conCentral(async (central) => {
			central.fallarAlApuntar("negocio_log_reservado");
			return central.pedir("/negocios/instante", { tenantId: t, marcador: "m", modo: "main", motivo: "prueba" });
		});
		expect(r).toMatchObject({ status: 503, body: { ok: false, error: "log_sin_reservar", deshacer: "m-deshacer" } });
		expect(r.body.message).toContain("Repite la misma orden");
		// Ni se reinicia el objeto ni se abre el log: la vuelta sigue preparada y la base, cerrada.
		expect(llamadas).not.toContain("reiniciar");
		expect(await stub(t).estadoDeLaBase(t)).toMatchObject({ ok: true, vueltaEnCurso: true });
	});

	it("mientras la vuelta está preparada la base no atiende a nadie, y sin volver no se abre el log", async () => {
		const t = "instante-cerrado";
		await negocioConDatos(t);
		await enElHub(t, (hub: any) => {
			dobleDeInstantes(hub, []);
			hub.instantes.reiniciar = () => {}; // el objeto no llega a reiniciarse
		});
		const prep = await stub(t).prepararVuelta({ tenantId: t, instanteMs: Date.now() - 60_000 });
		expect(prep).toMatchObject({ ok: true, deshacer: "m-deshacer" });

		expect(await stub(t).leerParaLaWeb(t, { que: "plano" })).toMatchObject({ ok: false, code: "tenant_db_restaurando" });
		expect(await stub(t).estadoDeLaBase(t)).toMatchObject({ ok: true, vueltaEnCurso: true });
		await enElHub(t, (hub: any) => expect(hub.aprovisionar(t)).rejects.toMatchObject({ code: "tenant_db_restaurando" }));
		expect(await stub(t).trasVolver({ tenantId: t, seqAntes: 0, modo: "main" })).toEqual({
			ok: false,
			error: "vuelta_sin_aplicar",
			status: 503,
		});
		const sinMarca = await enElHub(t, (hub: any) =>
			hub.state.storage.sql.exec("SELECT COUNT(*) AS n FROM Sync_Changes WHERE Command_Name = 'nube_devuelta';").one().n,
		);
		expect(sinMarca).toBe(0);
	});

	it("la marca de lo purgado sólo sube", async () => {
		const t = "instante-purgado";
		await negocioConDatos(t);
		await enElHub(t, (hub: any) => {
			hub.state.storage.sql.exec(
				"INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES (?, ?, 1);",
				PURGADO_HASTA,
				5,
			);
			dobleDeInstantes(hub, []);
		});
		await stub(t).prepararVuelta({ tenantId: t, marcador: "m" });
		await stub(t).reiniciar();
		const r = await stub(t).trasVolver({ tenantId: t, seqAntes: 7, modo: "nube" });
		expect(r).toMatchObject({ ok: true, inicio: 7 + SALTO_DE_SEQ, purgadoHasta: 6 + SALTO_DE_SEQ });
	});
});
