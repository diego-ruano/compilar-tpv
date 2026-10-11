// test/actualizacionesPorSistema.test.ts
//
// RI-74 · Qué sistema y qué canal son dos cosas distintas.
//
// La variante de Windows 7 se pedía por un canal propio (`win7`), así que no tenía beta ni pilotos, y
// el worker desplegado ni siquiera tenía esa ruta. Ahora el sistema va en el `target` (`windows` para
// Windows 10/11, `windows7` para la variante, que se lo fija ella misma al updater) y el canal sigue
// siendo `stable`/`beta`. Lo que se fija aquí:
//   · que cada sistema sólo ve lo suyo, con su estable, su beta y sus pilotos;
//   · que el manifiesto lleva la clave que busca un updater con el target fijado;
//   · que promocionar es por sistema;
//   · que un target o un canal mal escrito no se publica en silencio.

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

const { updatesRoutes } = await import("../src/domains/updates/updates.routes");
const { adminRoutes } = await import("../src/domains/admin/admin.routes");

const TOKEN = "token-de-pruebas";
const ENV = { ADMIN_API_TOKEN: TOKEN, RELEASE_ADMIN_TOKEN: TOKEN } as any;

const app = new Hono();
app.route("/update", updatesRoutes);
app.route("/admin", adminRoutes);

async function publicar(cuerpo: Record<string, unknown>) {
	const version = String(cuerpo.version);
	return app.request(
		"/update/publish",
		{
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ signature: `sig-${version}`, url: `https://cdn.test/${version}.exe`, ...cuerpo }),
		},
		ENV,
	);
}

/**
 * Un bar piloto y uno normal. Windows 10/11: la 2.0.0 estable y la 2.1.0 beta. Windows 7: la 1.0.0
 * estable y la 1.1.0 beta.
 */
async function escenario<T>(nombre: string, prueba: (sql: any) => Promise<T>): Promise<T> {
	return enElHub(`sistema-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		for (const t of ["app_releases", "devices", "tenants", "admin_audit"]) sql.exec(`DELETE FROM ${t};`);
		dbDePruebas = clienteSobre(sql);

		sql.exec(
			`INSERT INTO tenants (tenant_id, display_name, piloto) VALUES ('bar-piloto', 'Bar Piloto', 1), ('bar-normal', 'Bar Normal', 0);`,
		);
		sql.exec(
			`INSERT INTO devices (device_id, tenant_id, role, revoked_at_ms) VALUES
			   ('main-piloto', 'bar-piloto', 'tpv', NULL),
			   ('main-normal', 'bar-normal', 'tpv', NULL);`,
		);
		for (const r of [
			{ version: "2.0.0", channel: "stable" },
			{ version: "2.1.0", channel: "beta" },
			{ version: "1.0.0", channel: "stable", target: "windows7" },
			{ version: "1.1.0", channel: "beta", target: "windows7" },
		]) {
			expect((await publicar(r)).status).toBe(200);
		}
		return prueba(sql);
	});
}

/** Lo que el feed le contesta a un equipo de ese sistema. */
async function feed(target: string, dispositivo?: string) {
	const res = await app.request(
		`/update/${target}/x86_64/0.1.0`,
		{ headers: dispositivo ? { "X-Tpv-Device": dispositivo } : {} },
		ENV,
	);
	return res.status === 204 ? null : ((await res.json()) as any);
}

describe("RI-74 · cada sistema, lo suyo", () => {
	it("Windows 10/11 y Windows 7 tienen cada uno su estable y su beta", async () => {
		await escenario("canales", async () => {
			expect((await feed("windows", "main-normal")).version).toBe("2.0.0");
			expect((await feed("windows", "main-piloto")).version).toBe("2.1.0");
			expect((await feed("windows7", "main-normal")).version).toBe("1.0.0");
			expect((await feed("windows7", "main-piloto")).version).toBe("1.1.0");
		});
	});

	it("un Windows 7 no recibe nunca un instalador de Windows 10/11, aunque sea más nuevo", async () => {
		await escenario("sin-cruces", async () => {
			const respuesta = await feed("windows7", "main-piloto");
			expect(respuesta.version).toBe("1.1.0");
			// Lo que se instala es lo que dicen las URLs: todas, de la 1.1.0 de Windows 7.
			const urls = Object.values(respuesta.platforms).map((p: any) => p.url);
			expect(new Set(urls)).toEqual(new Set(["https://cdn.test/1.1.0.exe"]));
		});
	});

	it("el manifiesto lleva la clave que busca un updater con el target fijado, y la de siempre", async () => {
		await escenario("claves", async () => {
			const siete = await feed("windows7");
			expect(Object.keys(siete.platforms).sort()).toEqual(["windows7", "windows7-x86_64"]);
			expect(siete.platforms.windows7).toEqual({ signature: "sig-1.0.0", url: "https://cdn.test/1.0.0.exe" });

			const diez = await feed("windows");
			expect(diez.platforms["windows-x86_64"].url).toBe("https://cdn.test/2.0.0.exe");
		});
	});
});

describe("RI-74 · promocionar es por sistema", () => {
	it("promocionar la beta de Windows 7 no toca la de Windows 10/11", async () => {
		await escenario("promocion", async () => {
			const res = await app.request(
				"/admin/releases/promote",
				{
					method: "POST",
					headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
					body: JSON.stringify({ version: "1.1.0", target: "windows7" }),
				},
				ENV,
			);
			expect(res.status).toBe(200);
			expect((await feed("windows7", "main-normal")).version).toBe("1.1.0");
			expect((await feed("windows", "main-normal")).version).toBe("2.0.0");
		});
	});
});

describe("RI-74 · lo que no existe no se publica", () => {
	it("un target o un canal mal escrito es un 400 y no deja fila", async () => {
		await escenario("mal-escrito", async (sql) => {
			for (const cuerpo of [
				{ version: "9.0.0", target: "win7" },
				{ version: "9.0.0", channel: "win7" },
				{ version: "9.0.0", channel: "Beta" },
			]) {
				expect((await publicar(cuerpo)).status).toBe(400);
			}
			expect(sql.exec(`SELECT COUNT(*) AS n FROM app_releases WHERE version = '9.0.0';`).one().n).toBe(0);
		});
	});
});
