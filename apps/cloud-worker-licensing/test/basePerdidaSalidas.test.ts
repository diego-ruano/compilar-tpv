// test/basePerdidaSalidas.test.ts
//
// DO-PERDIDA · Las salidas de un negocio que ya nació y se ha quedado sin base en su TenantHub,
// desde la administración (`domains/admin/basesDeNegocios.ts`):
//
//   · crear su base vacía a sabiendas (`/v1/admin/negocios/base-vacia`), sin pasar por
//     `provisionTenantDatabase`, que se niega con un negocio nacido;
//   · devolverle su copia diaria de R2 (`/v1/admin/negocios/restaurar-copia`, DO-03).
//
// Las dos sólo con un negocio que ha nacido y cuyo objeto está vacío, con el token de
// administración, y dejando rastro en `admin_audit`. Y las dos abren el log de la réplica por encima
// de lo que la Main pueda haber visto, como la vuelta a un instante (`tenantHub.instante.ts`). La
// base central va sobre el SQLite de un DO; los TenantHub y el bucket son los de los tests.

import { env as entorno, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { PURGADO_HASTA } from "../src/domains/sync/cambiosJson";
import { claveDeCopia } from "../src/durableObjects/tenantHub.copia";
import { SALTO_DE_SEQ } from "../src/durableObjects/tenantHub.instante";

let dbDePruebas: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const { adminRoutes } = await import("../src/domains/admin/admin.routes");

const env = entorno as any;
const TOKEN = "token-de-pruebas";
const ENV = { ...env, ADMIN_API_TOKEN: TOKEN };
const bucket = env.COPIAS_NEGOCIOS as R2Bucket;
const ADMIN = "00000000-0000-7000-8000-000000000501";

const stub = (tenantId: string) => env.TenantHub.get(env.TenantHub.idFromName(tenantId));

async function pedir(ruta: string, cuerpo: unknown, token: string | null = TOKEN) {
	const res = await adminRoutes.fetch(
		new Request(`https://api${ruta}`, {
			method: "POST",
			headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
			body: JSON.stringify(cuerpo),
		}),
		ENV,
	);
	return { status: res.status, body: (await res.json()) as any };
}

type Central = { auditoria: () => string[]; nacer: (t: string) => void };

/** Corre `cuerpo` dentro del DO de la base central (su SQLite no se deja tocar desde fuera). */
async function conCentral<R>(nombre: string, cuerpo: (central: Central) => Promise<R>): Promise<R> {
	return enElHub(nombre, (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		sql.exec("DELETE FROM admin_audit;");
		dbDePruebas = clienteSobre(sql, hub.state.storage);
		return cuerpo({
			auditoria: () => sql.exec("SELECT action FROM admin_audit ORDER BY at_ms;").toArray().map((f: any) => f.action),
			nacer: (t: string) =>
				sql.exec(
					`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, disabled, term_months,
					   origin, issued_at_ms, activated_at_ms, customer_email, created_at_ms, updated_at_ms)
					 VALUES (?, ?, ?, 'la-main', 'active', 0, 12, 'stripe', 1, 1, 'bar@ejemplo.test', 1, 1);`,
					`lic-${t}`,
					`hash-${t}`,
					t,
				),
		});
	});
}

/** Lo que se compara de una base: las tablas del negocio que importan aquí, ordenadas. */
function foto(sql: any): Record<string, unknown[]> {
	const tabla = (t: string, orden: string) => sql.exec(`SELECT * FROM ${t} ORDER BY ${orden};`).toArray();
	return {
		clientes: tabla("Clientes", "ID_Cliente"),
		zonas: tabla("Zonas", "ID_Zona"),
		usuarios: tabla("Usuarios", "ID_Usuario"),
		roles: tabla("Roles", "ID_Rol"),
		ajustes: tabla("Business_Settings", "ID"),
	};
}

/** Un negocio con base, unos datos y su copia de hoy en R2. Devuelve la foto de su base. */
async function negocioConCopia(t: string): Promise<Record<string, unknown[]>> {
	await stub(t).aprovisionar(t);
	const antes = await enElHub(t, (hub: any) => {
		const sql = hub.state.storage.sql;
		sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre, Notas, Total_Gastado) VALUES ('c1', 'Ana', ?, 1250);", "una\nnota");
		sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre, Notas, Total_Gastado) VALUES ('c2', 'Luis', NULL, 0);");
		sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
		sql.exec("UPDATE Usuarios SET Requiere_Setup = 0, Nombre = 'Dueña' WHERE ID_Usuario = ?;", ADMIN);
		sql.exec("UPDATE Business_Settings SET Business_Name = 'Bar de pruebas' WHERE ID = 1;");
		sql.exec("INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES (70, 'op-70', 'x', '[]', 1);");
		return foto(sql);
	});
	expect(await runDurableObjectAlarm(stub(t))).toBe(true);
	return antes;
}

async function gzip(texto: string): Promise<Uint8Array> {
	return new Uint8Array(
		await new Response(new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
	);
}

async function leer(clave: string): Promise<string> {
	const o = await bucket.get(clave);
	return new Response(o!.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

const hoy = () => new Date().toISOString().slice(0, 10);

describe("DO-PERDIDA · las salidas de la administración", () => {
	it("sin el token de administración no entra", async () => {
		for (const ruta of ["/negocios/base-vacia", "/negocios/restaurar-copia"]) {
			expect((await pedir(ruta, { tenantId: "x", modo: "main", motivo: "abc" }, null)).status).toBe(401);
		}
	});

	it("base vacía: sólo para un negocio nacido y sin base, sin pasar por la activación, y abre el log", async () => {
		const t = "perdida-vacia";
		const r = await conCentral("perdida-central-vacia", async (central) => {
			// Sin nacer: eso lo hace la activación de su licencia.
			const sinNacer = await pedir("/negocios/base-vacia", { tenantId: t, modo: "nube", motivo: "se perdió" });
			central.nacer(t);
			const creada = await pedir("/negocios/base-vacia", { tenantId: t, modo: "nube", motivo: "se perdió" });
			// Con base ya no: no se pisa una base.
			const otraVez = await pedir("/negocios/base-vacia", { tenantId: t, modo: "nube", motivo: "se perdió" });
			return { sinNacer, creada, otraVez, auditoria: central.auditoria() };
		});

		expect(r.sinNacer).toMatchObject({ status: 409, body: { ok: false, error: "negocio_sin_nacer" } });
		expect(r.creada.status).toBe(200);
		expect(r.creada.body).toMatchObject({ ok: true, inicio: SALTO_DE_SEQ, purgadoHasta: SALTO_DE_SEQ - 1 });
		expect(r.otraVez).toMatchObject({ status: 409, body: { error: "tenant_db_already_provisioned" } });
		expect(r.auditoria).toEqual(["negocio_base_vacia"]);

		expect(await stub(t).estaAprovisionado()).toBe(true);
		await enElHub(t, async (hub: any) => {
			const sql = hub.state.storage.sql;
			// El administrador de la siembra, el sello y la copia diaria armada.
			expect(sql.exec("SELECT Requiere_Setup FROM Usuarios WHERE ID_Usuario = ?;", ADMIN).one().Requiere_Setup).toBe(1);
			expect(sql.exec("SELECT ID_Negocio FROM _Negocio;").one().ID_Negocio).toBe(t);
			expect(await hub.state.storage.getAlarm()).toBeGreaterThan(Date.now());
			expect(sql.exec("SELECT Last_Seq FROM Sync_Main_Checkpoints WHERE Device_Id = ?;", PURGADO_HASTA).one().Last_Seq).toBe(
				SALTO_DE_SEQ - 1,
			);
		});
	});

	it("restaurar la copia: devuelve las mismas filas a un objeto vacío y abre el log", async () => {
		const t = "perdida-copia";
		const antes = await negocioConCopia(t);
		await stub(t).borrarTodo(); // la base se pierde; la copia de R2, no

		const r = await conCentral("perdida-central-copia", async (central) => {
			central.nacer(t);
			const restaurada = await pedir("/negocios/restaurar-copia", { tenantId: t, modo: "main", motivo: "borrado por error" });
			const otraVez = await pedir("/negocios/restaurar-copia", { tenantId: t, modo: "main", motivo: "borrado por error" });
			return { restaurada, otraVez, auditoria: central.auditoria() };
		});

		expect(r.restaurada.status).toBe(200);
		expect(r.restaurada.body).toMatchObject({ ok: true, clave: claveDeCopia(t, hoy()), inicio: SALTO_DE_SEQ, purgadoHasta: null });
		expect(r.restaurada.body.filas).toBeGreaterThan(5);
		expect(r.otraVez).toMatchObject({ status: 409, body: { error: "tenant_db_already_provisioned" } });
		expect(r.auditoria).toEqual(["negocio_restaurar_copia"]);

		await enElHub(t, async (hub: any) => {
			const sql = hub.state.storage.sql;
			expect(foto(sql)).toEqual(antes);
			// El log de la réplica no venía en la copia: sólo el cambio vacío que lo abre.
			expect(sql.exec("SELECT Seq, Command_Name FROM Sync_Changes;").toArray()).toEqual([
				{ Seq: SALTO_DE_SEQ, Command_Name: "nube_devuelta" },
			]);
			expect(sql.exec("SELECT ID_Negocio FROM _Negocio;").one().ID_Negocio).toBe(t);
			expect(Number(sql.exec("PRAGMA foreign_keys;").one().foreign_keys)).toBe(1);
			expect(await hub.state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
		expect(await stub(t).leerParaLaWeb(t, { que: "plano" })).toMatchObject({ ok: true });
	});

	it("una copia cortada o de otra versión no se restaura y el objeto se queda vacío", async () => {
		const t = "perdida-copia-mala";
		await negocioConCopia(t);
		await stub(t).borrarTodo();
		const buena = await leer(claveDeCopia(t, hoy()));

		const cortada = buena.split("\n").filter((l) => !l.startsWith("-- Fin de la copia")).join("\n");
		await bucket.put(claveDeCopia(t, "2026-01-01"), await gzip(cortada));
		const deOtraVersion = buena.replace(/^-- Migraciones: (.*)$/m, "-- Migraciones: $1,9999_del_futuro");
		await bucket.put(claveDeCopia(t, "2026-01-02"), await gzip(deOtraVersion));

		const r = await conCentral("perdida-central-copia-mala", async (central) => {
			central.nacer(t);
			return {
				cortada: await pedir("/negocios/restaurar-copia", { tenantId: t, dia: "2026-01-01", modo: "main", motivo: "abc" }),
				otra: await pedir("/negocios/restaurar-copia", { tenantId: t, dia: "2026-01-02", modo: "main", motivo: "abc" }),
				noHay: await pedir("/negocios/restaurar-copia", { tenantId: t, dia: "2025-01-01", modo: "main", motivo: "abc" }),
			};
		});
		expect(r.cortada).toMatchObject({ status: 422, body: { error: "copia_cortada" } });
		expect(r.otra).toMatchObject({ status: 422, body: { error: "copia_de_otra_version" } });
		expect(r.noHay).toMatchObject({ status: 404, body: { error: "copia_no_encontrada" } });
		expect(await stub(t).estaAprovisionado()).toBe(false);
		expect(await enElHub(t, (hub: any) => hub.state.storage.getAlarm())).toBeNull();
	});

	it("mientras se restaura, la base no atiende a nadie", async () => {
		const t = "perdida-copia-cerrada";
		await negocioConCopia(t);
		await stub(t).borrarTodo();
		await enElHub(t, async (hub: any) => {
			// Una copia que no termina de llegar: el objeto espera a la red con la base a medias.
			let soltar!: () => void;
			const espera = new Promise<void>((r) => (soltar = r));
			const real = hub.env.COPIAS_NEGOCIOS;
			hub.env = {
				...hub.env,
				COPIAS_NEGOCIOS: {
					get: async (clave: string) => {
						const o = await real.get(clave);
						const lector = o.body.getReader();
						let primero = true;
						return {
							body: new ReadableStream({
								async pull(c) {
									if (!primero) await espera;
									primero = false;
									const { value, done } = await lector.read();
									if (done) c.close();
									else c.enqueue(value);
								},
							}),
						};
					},
				},
			};
			const restaurando = hub.restaurarDesdeCopia({ tenantId: t, clave: claveDeCopia(t, hoy()), modo: "main" });
			await vi.waitFor(async () => expect(await hub.state.storage.get("vuelta-en-curso")).toBeTruthy());
			expect(await hub.leerParaLaWeb(t, { que: "plano" })).toMatchObject({ ok: false, code: "tenant_db_restaurando" });
			soltar();
			expect(await restaurando).toMatchObject({ ok: true });
			expect(await hub.leerParaLaWeb(t, { que: "plano" })).toMatchObject({ ok: true });
		});
	});
});
