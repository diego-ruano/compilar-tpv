// test/reservasWebAdmin.test.ts
//
// Reservas desde la web: lo que administra el proveedor (`/v1/admin/reservas-web`), contra la
// estructura de verdad de la base central. Los dominios son la lista de `frame-ancestors` del
// widget, así que lo que se fija es que sólo entra un origen bien formado, y que revocar una clave
// la deja sin negocio.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

let dbDePruebas: any = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbDePruebas };
});

const { adminRoutes } = await import("../src/domains/admin/admin.routes");
const { claveDelNegocio, negocioDeLaClave, normalizarOrigen, olvidarClavesCacheadas } = await import(
	"../src/domains/reservas_web/claves"
);

const TOKEN = "token-de-pruebas";
const app = new Hono();
app.route("/admin", adminRoutes);

async function pedir(metodo: string, ruta: string, cuerpo?: unknown, token = TOKEN) {
	const res = await app.request(
		`/admin/reservas-web${ruta}`,
		{
			method: metodo,
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
		},
		{ ADMIN_API_TOKEN: TOKEN } as any,
	);
	return { status: res.status, json: (await res.json()) as any };
}

async function escenario(nombre: string, prueba: (sql: any) => Promise<void>) {
	await enElHub(`rw-admin-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		dbDePruebas = clienteSobre(sql);
		olvidarClavesCacheadas();
		sql.exec(`INSERT INTO tenants (tenant_id, display_name) VALUES ('t1', 'Bar Pepe');`);
		await prueba(sql);
	});
}

describe("el origen de una web autorizada", () => {
	it("esquema, host y puerto; https, o http sólo en local", () => {
		expect(normalizarOrigen("https://www.barpepe.es/")).toBe("https://www.barpepe.es");
		expect(normalizarOrigen("  https://WWW.BarPepe.es:8443 ")).toBe("https://www.barpepe.es:8443");
		expect(normalizarOrigen("http://localhost:5173")).toBe("http://localhost:5173");
		expect(normalizarOrigen("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
		for (const malo of [
			"http://www.barpepe.es",
			"https://www.barpepe.es/reservas",
			"https://www.barpepe.es/?x=1",
			"https://usuario:clave@barpepe.es",
			"www.barpepe.es",
			"javascript:alert(1)",
			"",
		]) {
			expect(normalizarOrigen(malo), malo).toBeNull();
		}
	});
});

describe("/v1/admin/reservas-web", () => {
	it("sin el token de administración no se entra", async () => {
		await escenario("token", async () => {
			expect((await pedir("GET", "/t1", undefined, "otro")).status).toBe(401);
		});
	});

	it("los dominios: se ponen normalizados, sin repetirse, y se quitan", async () => {
		await escenario("dominios", async (sql) => {
			expect(await pedir("GET", "/t1")).toEqual({ status: 200, json: { ok: true, tenantId: "t1", clave: null, dominios: [] } });

			expect((await pedir("POST", "/t1/dominios", { origen: "https://www.barpepe.es/" })).json.dominios).toEqual([
				"https://www.barpepe.es",
			]);
			await pedir("POST", "/t1/dominios", { origen: "https://www.barpepe.es" });
			const dos = await pedir("POST", "/t1/dominios", { origen: "http://localhost:5173" });
			expect(dos.json.dominios).toEqual(["http://localhost:5173", "https://www.barpepe.es"]);

			expect((await pedir("POST", "/t1/dominios", { origen: "http://www.barpepe.es" })).status).toBe(400);
			expect((await pedir("POST", "/t1/dominios", { origen: 42 })).status).toBe(400);
			expect((await pedir("POST", "/no-existe/dominios", { origen: "https://otra.es" })).status).toBe(404);

			expect((await pedir("POST", "/t1/dominios/quitar", { origen: "http://localhost:5173/" })).json.dominios).toEqual([
				"https://www.barpepe.es",
			]);
			expect((await pedir("POST", "/t1/dominios/quitar", { origen: "http://localhost:5173" })).status).toBe(404);

			const auditado = sql.exec(`SELECT action FROM admin_audit ORDER BY at_ms, rowid;`).toArray().map((f: any) => f.action);
			expect(auditado.filter((a: string) => a === "reserva_web_dominio_poner")).toHaveLength(3);
			expect(auditado).toContain("reserva_web_dominio_quitar");
		});
	});

	it("revocar la clave la deja sin negocio; la siguiente que se pida es otra", async () => {
		await escenario("revocar", async (sql) => {
			expect((await pedir("POST", "/t1/revocar-clave")).status).toBe(404);

			const clave = await claveDelNegocio(dbDePruebas, "t1", 1);
			expect((await pedir("GET", "/t1")).json.clave).toBe(clave);
			expect(await negocioDeLaClave(dbDePruebas, clave)).toBe("t1");

			expect(await pedir("POST", "/t1/revocar-clave")).toEqual({
				status: 200,
				json: { ok: true, tenantId: "t1", revocada: clave },
			});
			// En este isolate, en el acto: no hace falta esperar a la caché.
			expect(await negocioDeLaClave(dbDePruebas, clave)).toBeNull();
			expect((await pedir("GET", "/t1")).json.clave).toBeNull();
			expect(await claveDelNegocio(dbDePruebas, "t1", 2)).not.toBe(clave);
			expect(sql.exec(`SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'reserva_web_revocar_clave';`).toArray()[0]).toEqual({ n: 1 });
		});
	});
});
