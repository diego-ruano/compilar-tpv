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
//
// Cada caso tiene su base central de verdad (`helpers/central.ts`), a la que las rutas llegan por
// `getDb(env)`.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { centralDePrueba, filasDe, type CentralDePrueba } from "./helpers/central";
import { updatesRoutes } from "../src/domains/updates/updates.routes";
import { adminRoutes } from "../src/domains/admin/admin.routes";

const TOKEN = "token-de-pruebas";
const ENV = { ADMIN_API_TOKEN: TOKEN, RELEASE_ADMIN_TOKEN: TOKEN } as any;

const app = new Hono();
app.route("/update", updatesRoutes);
app.route("/admin", adminRoutes);

type Escenario = {
	central: CentralDePrueba;
	/** Pide `ruta` a la `app`, con la base central del escenario. */
	pedir: (ruta: string, init?: RequestInit) => Promise<Response>;
	publicar: (cuerpo: Record<string, unknown>) => Promise<Response>;
	/** Lo que el feed le contesta a un equipo de ese sistema. */
	feed: (target: string, dispositivo?: string) => Promise<any>;
};

/**
 * Un bar piloto y uno normal, en una base central propia. Windows 10/11: la 2.0.0 estable y la
 * 2.1.0 beta. Windows 7: la 1.0.0 estable y la 1.1.0 beta.
 */
async function escenario<T>(prueba: (e: Escenario) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	const pedir = async (ruta: string, init?: RequestInit) => app.request(ruta, init, { ...ENV, ...central.entorno });
	const publicar = (cuerpo: Record<string, unknown>) => {
		const version = String(cuerpo.version);
		return pedir("/update/publish", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ signature: `sig-${version}`, url: `https://cdn.test/${version}.exe`, ...cuerpo }),
		});
	};
	const feed = async (target: string, dispositivo?: string) => {
		const res = await pedir(`/update/${target}/x86_64/0.1.0`, {
			headers: dispositivo ? { "X-Tpv-Device": dispositivo } : {},
		});
		return res.status === 204 ? null : ((await res.json()) as any);
	};

	await filasDe(
		central,
		`INSERT INTO tenants (tenant_id, display_name, piloto) VALUES ('bar-piloto', 'Bar Piloto', 1), ('bar-normal', 'Bar Normal', 0);`,
	);
	await filasDe(
		central,
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
	return prueba({ central, pedir, publicar, feed });
}

describe("RI-74 · cada sistema, lo suyo", () => {
	it("Windows 10/11 y Windows 7 tienen cada uno su estable y su beta", async () => {
		await escenario(async ({ feed }) => {
			expect((await feed("windows", "main-normal")).version).toBe("2.0.0");
			expect((await feed("windows", "main-piloto")).version).toBe("2.1.0");
			expect((await feed("windows7", "main-normal")).version).toBe("1.0.0");
			expect((await feed("windows7", "main-piloto")).version).toBe("1.1.0");
		});
	});

	it("un Windows 7 no recibe nunca un instalador de Windows 10/11, aunque sea más nuevo", async () => {
		await escenario(async ({ feed }) => {
			const respuesta = await feed("windows7", "main-piloto");
			expect(respuesta.version).toBe("1.1.0");
			// Lo que se instala es lo que dicen las URLs: todas, de la 1.1.0 de Windows 7.
			const urls = Object.values(respuesta.platforms).map((p: any) => p.url);
			expect(new Set(urls)).toEqual(new Set(["https://cdn.test/1.1.0.exe"]));
		});
	});

	it("el manifiesto lleva la clave que busca un updater con el target fijado, y la de siempre", async () => {
		await escenario(async ({ feed }) => {
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
		await escenario(async ({ pedir, feed }) => {
			const res = await pedir("/admin/releases/promote", {
				method: "POST",
				headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ version: "1.1.0", target: "windows7" }),
			});
			expect(res.status).toBe(200);
			expect((await feed("windows7", "main-normal")).version).toBe("1.1.0");
			expect((await feed("windows", "main-normal")).version).toBe("2.0.0");
		});
	});
});

describe("RI-74 · lo que no existe no se publica", () => {
	it("un target o un canal mal escrito es un 400 y no deja fila", async () => {
		await escenario(async ({ central, publicar }) => {
			for (const cuerpo of [
				{ version: "9.0.0", target: "win7" },
				{ version: "9.0.0", channel: "win7" },
				{ version: "9.0.0", channel: "Beta" },
			]) {
				expect((await publicar(cuerpo)).status).toBe(400);
			}
			expect(await filasDe(central, `SELECT COUNT(*) AS n FROM app_releases WHERE version = '9.0.0';`)).toEqual([
				{ n: 0 },
			]);
		});
	});
});
