// test/reservasWebPuerta.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.1): la puerta de las rutas públicas, que
// no llevan `tenantAuth`. Lo que se fija aquí es quién pasa y quién no, contra una base central de
// verdad (`helpers/central.ts`):
//   · una clave inexistente, revocada o de un negocio sin licencia, suspendido o con el interruptor
//     apagado da siempre el mismo `reserva_web_no_disponible`, sin decir por qué;
//   · los limitadores cortan con 429;
//   · el alta exige Turnstile y, sin el secreto configurado, queda cerrada.

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import { centralDePrueba, centralQueApunta, filasDe, type CentralDePrueba } from "./helpers/central";
import { claveDelNegocio, olvidarClavesCacheadas } from "../src/domains/reservas_web/claves";
import {
	huellasDeLaConexion,
	limitadorAltas,
	puertaPublica,
	topeDelCuerpo,
	turnstileValido,
	verificacionHumana,
} from "../src/domains/reservas_web/puerta";
import { olvidarInterruptoresCacheados } from "../src/lib/interruptores";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";
import { redAmpliaIpv6 } from "../src/lib/limitador";

const app = new Hono<any>();
app.get("/p/:clave/negocio", puertaPublica, (c) => c.json({ ok: true, tenant: c.get("tenantId") }));
app.post("/p/:clave/reservas", puertaPublica, limitadorAltas, verificacionHumana, (c) =>
	c.json({ ok: true, tenant: c.get("tenantId") }),
);
app.post("/p/:clave/cancelar", puertaPublica, topeDelCuerpo, async (c) => c.json({ ok: true, leido: (await c.req.text()).length }));

const DIA = 86_400_000;

beforeEach(() => {
	olvidarClavesCacheadas();
	olvidarLicenciasCacheadas();
	olvidarInterruptoresCacheados();
});

type Escenario = {
	clave: string;
	central: CentralDePrueba;
	/** Pide `ruta` a la `app`, con la base central del escenario y lo que añada `env`. */
	pedir: (ruta: string, init?: RequestInit, env?: Record<string, unknown>) => Promise<Response>;
	/** Lee el negocio de la clave `clave` por la puerta. */
	leer: (clave: string, env?: Record<string, unknown>) => Promise<Response>;
	/** Ejecuta SQL en la base central, por debajo de sus guardas. */
	enCentral: (sql: string, ...args: unknown[]) => Promise<unknown>;
};

/** Un negocio activo con su licencia en vigor y su clave, en una base central propia. */
async function escenario(prueba: (e: Escenario) => Promise<void>) {
	const central = await centralDePrueba();
	await filasDe(central, `INSERT INTO tenants (tenant_id, status) VALUES ('t1', 'active');`);
	await filasDe(
		central,
		`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, disabled,
		                       term_months, origin, issued_at_ms, expires_at_ms, customer_email,
		                       created_at_ms, updated_at_ms)
		 VALUES ('l1', 'h1', 't1', 'main-1', 'active', 0, 12, 'admin', 0, ?, 'a@b.es', 0, 0);`,
		Date.now() + 90 * DIA,
	);
	const clave = await claveDelNegocio(central.db, "t1", Date.now());
	const pedir = async (ruta: string, init: RequestInit = {}, env: Record<string, unknown> = {}) =>
		app.request(ruta, init, { ...central.entorno, ...env });
	await prueba({
		clave,
		central,
		pedir,
		leer: (clave, env) => pedir(`/p/${clave}/negocio`, {}, env),
		enCentral: (sql, ...args) => filasDe(central, sql, ...args),
	});
}

async function noDisponible(res: Response) {
	expect(res.status).toBe(404);
	expect(((await res.json()) as any).error).toBe("reserva_web_no_disponible");
}

describe("la puerta pública de la reserva web", () => {
	it("deja pasar a un negocio activo, con licencia y con su clave, y fija su tenant", async () => {
		await escenario(async ({ clave, leer }) => {
			const res = await leer(clave);
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, tenant: "t1" });
		});
	});

	it("una clave inventada o revocada no lleva a ningún sitio", async () => {
		await escenario(async ({ clave, leer, enCentral }) => {
			await noDisponible(await leer("rw_AAAAAAAAAAAAAAAAAAAAAA"));
			await noDisponible(await leer("t1"));
			await enCentral(`UPDATE reserva_web_claves SET revoked_at_ms = 1 WHERE clave = ?;`, clave);
			olvidarClavesCacheadas();
			await noDisponible(await leer(clave));
		});
	});

	it("sin licencia en vigor no se reserva: caducada del todo, revocada o sin activar", async () => {
		await escenario(async ({ clave, leer, enCentral }) => {
			// Caducada, pero dentro de la gracia: el TPV sigue vendiendo, y la web también.
			await enCentral(`UPDATE licenses SET expires_at_ms = ? WHERE license_id = 'l1';`, Date.now() - DIA);
			expect((await leer(clave)).status).toBe(200);

			await enCentral(`UPDATE licenses SET expires_at_ms = ? WHERE license_id = 'l1';`, Date.now() - 400 * DIA);
			olvidarLicenciasCacheadas();
			await noDisponible(await leer(clave));

			await enCentral(`UPDATE licenses SET expires_at_ms = ?, status = 'revoked', disabled = 1;`, Date.now() + DIA);
			olvidarLicenciasCacheadas();
			await noDisponible(await leer(clave));

			await enCentral(`UPDATE licenses SET status = 'active', disabled = 0, main_device_id = NULL;`);
			olvidarLicenciasCacheadas();
			await noDisponible(await leer(clave));
		});
	});

	it("un negocio suspendido o dado de baja no atiende reservas aunque la licencia siga en vigor", async () => {
		await escenario(async ({ clave, leer, enCentral }) => {
			for (const estado of ["suspended", "deleted"]) {
				await enCentral(`UPDATE tenants SET status = ? WHERE tenant_id = 't1';`, estado);
				olvidarLicenciasCacheadas();
				await noDisponible(await leer(clave));
			}
		});
	});

	it("el interruptor `reservas_web` la cierra, para ese negocio o para todos", async () => {
		await escenario(async ({ clave, leer, enCentral }) => {
			for (const tenant of ["t1", "*"]) {
				await enCentral(`DELETE FROM interruptores;`);
				await enCentral(
					`INSERT INTO interruptores (interruptor_id, interruptor, tenant_id, motivo, expires_at_ms)
					 VALUES (?, 'reservas_web', ?, 'prueba', ?);`,
					`i-${tenant}`,
					tenant,
					Date.now() + DIA,
				);
				olvidarInterruptoresCacheados();
				await noDisponible(await leer(clave));
			}
			// Apagado otro negocio: éste sigue abierto.
			await enCentral(`UPDATE interruptores SET tenant_id = 't2';`);
			olvidarInterruptoresCacheados();
			expect((await leer(clave)).status).toBe(200);
		});
	});

	it("el limitador corta con 429 antes de mirar la clave", async () => {
		await escenario(async ({ central, leer }) => {
			const espia = centralQueApunta(central);
			const lleno = { limit: async () => ({ success: false }) };
			// Una clave inventada da 429 y no 404: el barrido de claves se frena antes de la base.
			const res = await leer("rw_AAAAAAAAAAAAAAAAAAAAAA", { LIMITADOR_RESERVA_WEB: lleno, ...espia.entorno });
			expect(res.status).toBe(429);
			expect(((await res.json()) as any).error).toBe("reserva_web_demasiadas");
			expect(espia.pedido).toEqual([]);
		});
	});

	it("el alta tiene su propio limitador, además del de las lecturas", async () => {
		await escenario(async ({ clave, pedir }) => {
			const lleno = { limit: async () => ({ success: false }) };
			const res = await pedir(
				`/p/${clave}/reservas`,
				{ method: "POST", headers: { "X-Turnstile-Token": "x" } },
				{ LIMITADOR_RESERVA_WEB_ALTA: lleno, TURNSTILE_SECRET_KEY: "s" },
			);
			expect(res.status).toBe(429);
		});
	});

	it("un cuerpo de más de 8 KB no se lee", async () => {
		await escenario(async ({ clave, pedir }) => {
			const enviar = (n: number) =>
				pedir(`/p/${clave}/cancelar`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(n) });
			expect((await enviar(8 * 1024)).status).toBe(200);
			const grande = await enviar(8 * 1024 + 1);
			expect(grande.status).toBe(413);
			expect(((await grande.json()) as any).error).toBe("validation_error");
		});
	});

	it("sin el secreto de Turnstile el alta queda cerrada, y sin token no se pasa", async () => {
		await escenario(async ({ clave, pedir }) => {
			const sinSecreto = await pedir(`/p/${clave}/reservas`, { method: "POST" });
			expect(sinSecreto.status).toBe(503);
			expect(((await sinSecreto.json()) as any).error).toBe("reserva_web_no_disponible");

			const sinToken = await pedir(`/p/${clave}/reservas`, { method: "POST" }, { TURNSTILE_SECRET_KEY: "s" });
			expect(sinToken.status).toBe(403);
			expect(((await sinToken.json()) as any).error).toBe("verificacion_humana_fallida");
		});
	});
});

describe("la verificación de Turnstile", () => {
	function respondiendo(cuerpo: unknown, fallar = false) {
		const llamadas: FormData[] = [];
		const fetcher = (async (_url: string, init: RequestInit) => {
			llamadas.push(init.body as FormData);
			if (fallar) throw new Error("sin red");
			return new Response(JSON.stringify(cuerpo));
		}) as unknown as typeof fetch;
		return { fetcher, llamadas };
	}

	it("pasa sólo con `success: true`, y manda el secreto, el token y la IP", async () => {
		const bien = respondiendo({ success: true });
		expect(await turnstileValido("secreto", "token", "1.2.3.4", bien.fetcher)).toBe("si");
		expect(bien.llamadas[0].get("secret")).toBe("secreto");
		expect(bien.llamadas[0].get("response")).toBe("token");
		expect(bien.llamadas[0].get("remoteip")).toBe("1.2.3.4");

		expect(await turnstileValido("secreto", "token", "1.2.3.4", respondiendo({ success: false }).fetcher)).toBe("no");
		expect(await turnstileValido("secreto", "token", "1.2.3.4", respondiendo({}).fetcher)).toBe("no");
	});

	it("si Turnstile no contesta, no pasa", async () => {
		expect(await turnstileValido("secreto", "token", "1.2.3.4", respondiendo({}, true).fetcher)).toBe("no");
	});

	it("un token vacío o desmesurado ni se pregunta", async () => {
		const r = respondiendo({ success: true });
		expect(await turnstileValido("secreto", "", "1.2.3.4", r.fetcher)).toBe("no");
		expect(await turnstileValido("secreto", "x".repeat(2049), "1.2.3.4", r.fetcher)).toBe("no");
		expect(r.llamadas).toHaveLength(0);
	});

	it("sin secreto no se puede saber", async () => {
		expect(await turnstileValido(undefined, "token", "1.2.3.4")).toBe("sin_secreto");
	});

	it("sin IP conocida no la manda", async () => {
		const r = respondiendo({ success: true });
		await turnstileValido("secreto", "token", "unknown", r.fetcher);
		expect(r.llamadas[0].get("remoteip")).toBeNull();
	});
});

describe("la huella de la conexión de un alta (RW-ALTAS)", () => {
	const ENV = { LICENSE_JWT_SECRET: "secreto" } as any;

	const conexion = async (ip: string, env = ENV, tenant = "t1") => (await huellasDeLaConexion(env, tenant, ip))?.conexion;
	const red = async (ip: string) => (await huellasDeLaConexion(ENV, "t1", ip))?.red;

	it("la IPv4 exacta, y la IPv6 por su /64, escrita como se escriba", async () => {
		const h = conexion;
		expect(await h("198.51.100.7")).toBe(await h(" 198.51.100.7 "));
		expect(await h("198.51.100.7")).toBe(await h("::ffff:198.51.100.7"));
		expect(await h("198.51.100.7")).not.toBe(await h("198.51.100.8"));
		expect(await h("2001:db8:1:2::1")).toBe(await h("2001:0DB8:0001:0002:ffff:eeee:dddd:cccc"));
		expect(await h("2001:db8:1:2::1")).not.toBe(await h("2001:db8:1:3::1"));
	});

	it("la red de una IPv6 es su /48, distinta de la huella de cualquier conexión; una IPv4 no tiene", async () => {
		expect(await red("2001:db8:1:2::1")).toMatch(/^[0-9a-f]{64}$/);
		expect(await red("2001:db8:1:2::1")).toBe(await red("2001:0DB8:0001:ffff:1:2:3:4"));
		expect(await red("2001:db8:1:2::1")).not.toBe(await red("2001:db8:2:2::1"));
		expect(await red("2001:db8:1:2::1")).not.toBe(await conexion("2001:db8:1:2::1"));
		expect(await red("198.51.100.7")).toBeNull();
		expect(await red("::ffff:198.51.100.7")).toBeNull();

		expect(redAmpliaIpv6("2001:0DB8:0001:0002::1")).toBe("2001:db8:1::/48");
		expect(redAmpliaIpv6("[2001:db8::1%eth0]")).toBe("2001:db8:0::/48");
		expect(redAmpliaIpv6("198.51.100.7")).toBeNull();
		expect(redAmpliaIpv6("::ffff:198.51.100.7")).toBeNull();
		expect(redAmpliaIpv6("no:es:una:ip:x")).toBeNull();
	});

	it("es un HMAC con el secreto, atado al negocio: sin la IP dentro y distinta en cada negocio", async () => {
		const huella = await conexion("198.51.100.7");
		expect(huella).toMatch(/^[0-9a-f]{64}$/);
		expect(huella).not.toBe(await conexion("198.51.100.7", ENV, "t2"));
		expect(huella).not.toBe(await conexion("198.51.100.7", { LICENSE_JWT_SECRET: "otro" } as any));
	});

	it("sin IP o sin secreto no hay huella: el alta no cuenta para ningún tope por conexión", async () => {
		expect(await huellasDeLaConexion(ENV, "t1", "unknown")).toBeNull();
		expect(await huellasDeLaConexion(ENV, "t1", "")).toBeNull();
		expect(await huellasDeLaConexion({ LICENSE_JWT_SECRET: " " } as any, "t1", "2001:db8:1:2::1")).toBeNull();
	});
});
