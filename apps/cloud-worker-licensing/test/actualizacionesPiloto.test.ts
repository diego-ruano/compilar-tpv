// test/actualizacionesPiloto.test.ts
//
// RI-30 · Una versión nueva llega primero a los bares piloto.
//
// El feed se la ofrecía a todos los equipos a la vez, así que una versión mala llegaba el mismo día a
// todos los bares que pulsaran «instalar». Ahora el workflow de release publica en el canal `beta`, que
// sólo ven los equipos de un negocio marcado como piloto (`tenants.piloto`), y la versión pasa a
// `stable` cuando se promociona. Lo que se fija aquí:
//   · quién recibe qué (piloto, normal, sin cabecera, equipo desconocido o revocado);
//   · que promocionar se la da a todos, y que un rollback sin canal la quita de los dos;
//   · que volver a publicar no recrea la fila (el `INSERT OR REPLACE` de REV-23).
//
// Cada caso, con su propia base central de verdad (`helpers/central.ts`). Lo que el feed guarda en el
// isolate lo vacía cada publicación, así que un caso no ve lo que leyó el anterior.

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

/** Un bar piloto y uno normal, cada uno con su Main, y la 1.0.0 en stable + la 1.1.0 en beta. */
async function escenario<T>(prueba: (central: CentralDePrueba) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	await filasDe(
		central,
		`INSERT INTO tenants (tenant_id, display_name, piloto) VALUES ('bar-piloto', 'Bar Piloto', 1), ('bar-normal', 'Bar Normal', 0);`,
	);
	await filasDe(
		central,
		`INSERT INTO devices (device_id, tenant_id, role, revoked_at_ms) VALUES
		   ('main-piloto', 'bar-piloto', 'tpv', NULL),
		   ('main-normal', 'bar-normal', 'tpv', NULL),
		   ('revocada', 'bar-piloto', 'tpv', 1);`,
	);
	await publicar(central, "1.0.0", "stable");
	await publicar(central, "1.1.0", "beta");
	return prueba(central);
}

async function publicar(central: CentralDePrueba, version: string, channel: string, notes = "notas") {
	const res = await app.request(
		"/update/publish",
		{
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ version, channel, notes, signature: `sig-${version}`, url: `https://cdn.test/${version}.exe` }),
		},
		{ ...ENV, ...central.entorno },
	);
	expect(res.status).toBe(200);
}

/** La versión que el feed le ofrece a un equipo (o `null` si ninguna). */
async function ofrecida(central: CentralDePrueba, dispositivo?: string): Promise<string | null> {
	const res = await app.request(
		"/update/windows/x86_64/0.9.0",
		{ headers: dispositivo ? { "X-Tpv-Device": dispositivo } : {} },
		{ ...ENV, ...central.entorno },
	);
	return res.status === 204 ? null : ((await res.json()) as any).version;
}

async function admin(central: CentralDePrueba, metodo: "GET" | "POST", ruta: string, cuerpo?: unknown) {
	const res = await app.request(
		`/admin${ruta}`,
		{
			method: metodo,
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
		},
		{ ...ENV, ...central.entorno },
	);
	return { status: res.status, body: (await res.json()) as any };
}

describe("RI-30 · quién recibe qué", () => {
	it("el bar piloto recibe la beta; los demás, la estable", async () => {
		await escenario(async (central) => {
			expect(await ofrecida(central, "main-piloto")).toBe("1.1.0");
			expect(await ofrecida(central, "main-normal")).toBe("1.0.0");
		});
	});

	it("sin cabecera, con un equipo desconocido o con uno revocado: la estable", async () => {
		await escenario(async (central) => {
			expect(await ofrecida(central)).toBe("1.0.0");
			expect(await ofrecida(central, "no-existe")).toBe("1.0.0");
			expect(await ofrecida(central, "revocada")).toBe("1.0.0");
		});
	});

	it("un piloto no se queda atrás: si la estable es más nueva, recibe la estable", async () => {
		await escenario(async (central) => {
			await publicar(central, "1.2.0", "stable");
			expect(await ofrecida(central, "main-piloto")).toBe("1.2.0");
		});
	});
});

describe("RI-30 · promocionar y volver atrás", () => {
	it("promocionar una versión beta se la ofrece a todos, con la misma firma", async () => {
		await escenario(async (central) => {
			const r = await admin(central, "POST", "/releases/promote", { version: "1.1.0" });
			expect(r).toEqual({ status: 200, body: { ok: true, version: "1.1.0" } });
			expect(await ofrecida(central, "main-normal")).toBe("1.1.0");
			const firmas = await filasDe(central, `SELECT DISTINCT signature FROM app_releases WHERE version = '1.1.0';`);
			expect(firmas).toEqual([{ signature: "sig-1.1.0" }]);
		});
	});

	it("no se promociona lo que no está activo en beta", async () => {
		await escenario(async (central) => {
			expect((await admin(central, "POST", "/releases/promote", { version: "9.9.9" })).status).toBe(404);
		});
	});

	it("un rollback sin canal la quita de beta y de stable", async () => {
		await escenario(async (central) => {
			await admin(central, "POST", "/releases/promote", { version: "1.1.0" });
			const res = await app.request(
				"/update/deactivate",
				{
					method: "POST",
					headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
					body: JSON.stringify({ version: "1.1.0" }),
				},
				{ ...ENV, ...central.entorno },
			);
			expect(res.status).toBe(200);
			expect(await ofrecida(central, "main-piloto")).toBe("1.0.0");
			expect(await ofrecida(central, "main-normal")).toBe("1.0.0");
		});
	});

	it("volver a publicar retoca la fila sin recrearla, y la reactiva", async () => {
		await escenario(async (central) => {
			const [antes] = await filasDe(central, `SELECT created_at_ms FROM app_releases WHERE version = '1.1.0';`);
			await filasDe(central, `UPDATE app_releases SET is_active = 0 WHERE version = '1.1.0';`);
			await publicar(central, "1.1.0", "beta", "notas corregidas");
			const [despues] = await filasDe(
				central,
				`SELECT created_at_ms, notes, is_active FROM app_releases WHERE version = '1.1.0';`,
			);
			expect(despues).toEqual({ created_at_ms: antes.created_at_ms, notes: "notas corregidas", is_active: 1 });
		});
	});
});

describe("RI-30 · marcar los bares piloto", () => {
	it("se marcan y desmarcan por su id, y la lista dice cuáles son", async () => {
		await escenario(async (central) => {
			expect((await admin(central, "POST", "/pilotos", { tenantId: "bar-normal", piloto: true })).status).toBe(200);
			expect(await ofrecida(central, "main-normal")).toBe("1.1.0");

			await admin(central, "POST", "/pilotos", { tenantId: "bar-piloto", piloto: false });
			const lista = await admin(central, "GET", "/pilotos");
			expect(lista.body.negocios).toEqual([{ tenantId: "bar-normal", nombre: "Bar Normal", piloto: true }]);
			expect((await admin(central, "GET", "/pilotos?todos=1")).body.negocios).toHaveLength(2);
		});
	});

	it("un id que no existe es un 404, no un «hecho»", async () => {
		await escenario(async (central) => {
			expect((await admin(central, "POST", "/pilotos", { tenantId: "no-existe", piloto: true })).status).toBe(404);
		});
	});
});
