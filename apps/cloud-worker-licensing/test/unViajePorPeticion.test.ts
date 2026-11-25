// test/unViajePorPeticion.test.ts
//
// Las rutas de negocio se ejecutan dentro del TenantHub del negocio (`lib/enElHub.ts`): el Worker
// autentica y le pasa la petición entera, y el DO la ejecuta con su base al lado. Esto pasa por la
// `app` completa, el entorno real de la suite y una base central de verdad para cada negocio
// (`helpers/negocioFirmado.ts`):
//
// - la respuesta es la de la base que vive en el DO, y la petición hace UN viaje (`hub-ruta`), sin
//   ninguna consulta suelta (`hub-lee`) ni otra ida del DO a la base central (`en-hub-central`);
// - un rechazo de negocio que se decide dentro del DO llega al cliente con su código y su status;
// - lo que decide la base central (aquí, una licencia anulada) se queda en el Worker;
// - las lecturas que van por POST (AUD-27) hacen el mismo viaje, con su cuerpo, y el tope de ese
//   cuerpo se comprueba en el Worker: lo que pasa de él no llega al DO.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MAIN, conNegocioFirmado, peticionFirmada, viajes, type Negocio } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";

const env = entorno as any;
const deps = { firmarSesion, olvidarLicenciasCacheadas };
const ROL_CAMARERO = "00000000-0000-7000-8000-000000000002";

/**
 * Un negocio con su base en el DO (el administrador con el que nace y un usuario más) y su licencia
 * en la base central, anulada si se pide. La prueba corre dentro del TenantHub del negocio.
 */
async function conNegocio<R>(
	nombre: string,
	opciones: { anulada?: boolean },
	prueba: (n: Negocio, hub: any) => Promise<R>,
): Promise<R> {
	return conNegocioFirmado(deps, `un-viaje-${nombre}`, async (n, hub) => {
		hub.state.storage.sql.exec(
			`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES (?, ?, ?, 'x', 'Lucía');`,
			`usuario-${nombre}`,
			ROL_CAMARERO,
			`lucia-${nombre}@bar.test`,
		);
		if (opciones.anulada) await n.enCentral(`UPDATE licenses SET status = 'revoked' WHERE tenant_id = ?;`, n.tenantId);
		return prueba(n, hub);
	});
}

/**
 * Una petición firmada por la Main como la del cliente Rust (`sign_device_proof`), contra la app
 * entera. `sinClave`: sin clave de idempotencia, como manda la app una lectura; `firma`: otra en vez
 * de la buena.
 */
async function pedir(
	n: Negocio,
	metodo: "GET" | "POST",
	ruta: string,
	opciones: { cuerpo?: unknown; sinClave?: boolean; firma?: string } = {},
): Promise<{ status: number; json: any; tiempos: string; res: Response }> {
	const peticion = await peticionFirmada(deps, n, MAIN, metodo, ruta, { cuerpo: opciones.cuerpo });
	if (opciones.sinClave) peticion.headers.delete("X-Idempotency-Key");
	if (opciones.firma) peticion.headers.set("X-Device-Sig", opciones.firma);
	const res = await app.request(peticion, undefined, { ...env, ...n.entorno });
	return { status: res.status, json: await res.json(), tiempos: res.headers.get("Server-Timing") ?? "", res };
}

describe("un viaje al TenantHub por petición", () => {
	it("la lectura sale de la base del DO en un solo viaje, sin consultas sueltas", async () => {
		await conNegocio("lectura", {}, async (n) => {
			const r = await pedir(n, "GET", "/v1/login/users");
			expect(r.status).toBe(200);
			expect(r.json.map((u: any) => u.nombre).sort()).toEqual(["Admin", "Lucía"]);
			expect(viajes(r.res, "hub-ruta")).toBe(1);
			expect(viajes(r.res, "hub-lee")).toBe(0);
			// El DO trae su propio desglose: el trabajo hecho dentro, sin viajes.
			expect(r.tiempos).toMatch(/en-hub-total;dur=/);
			expect(viajes(r.res, "en-hub-central")).toBe(0);
		});
	});

	it("un rechazo que decide el DO llega con su código y su status", async () => {
		await conNegocio("rechazo", {}, async (n) => {
			// Sin Main conectada, la escritura de la Handy no entra: lo decide el motor del DO.
			const r = await pedir(n, "POST", "/v1/clientes", { cuerpo: { id_cliente: null, nombre: "Ana" } });
			expect(r.status).toBe(400);
			expect(r.json).toMatchObject({ ok: false, error: "main_offline" });
			expect(viajes(r.res, "hub-ruta")).toBe(1);
			expect(viajes(r.res, "hub-escribe")).toBe(0);
		});
	});

	it("la validación del cuerpo también se hace dentro, y contesta igual", async () => {
		await conNegocio("validacion", {}, async (n) => {
			const r = await pedir(n, "POST", "/v1/clientes", { cuerpo: { id_cliente: null, nombre: "  " } });
			expect(r.status).toBe(400);
			expect(r.json).toMatchObject({ ok: false, message: "Escribe el nombre del cliente." });
		});
	});

	it("lo que decide la base central se queda en el Worker: una licencia anulada no llega al DO", async () => {
		await conNegocio("anulada", { anulada: true }, async (n) => {
			const r = await pedir(n, "GET", "/v1/login/users");
			expect(r.status).toBe(403);
			expect(r.json.error).toBe("license_revoked");
			// Dentro del DO `tenantAuth` no mira la licencia: el veto es el del Worker. Y la respuesta no lleva
			// el desglose de tiempos, que sólo sale para quien pasa `tenantAuth` entero.
			expect(r.tiempos).toBe("");
		});
	});
});

describe("las lecturas por POST (AUD-27) también van enteras al TenantHub", () => {
	const KB = 1024;

	/** Las lecturas por POST, con un cuerpo de los que manda la app y el tope del suyo. */
	const LECTURAS: { ruta: string; cuerpo: Record<string, unknown>; tope: number }[] = [
		{ ruta: "/v1/reservas/buscar-cliente", cuerpo: { telefono: "600000000" }, tope: 8 * KB },
		{ ruta: "/v1/cuentas/entradas", cuerpo: { del: "2026-05-01", al: "2026-05-31", q: "cliente ficticio" }, tope: 8 * KB },
		{ ruta: "/v1/cuentas/salidas", cuerpo: { del: "2026-05-01", al: "2026-05-31", q: "luz" }, tope: 8 * KB },
		{ ruta: "/v1/cuentas/resumen", cuerpo: { del: "2026-05-01", al: "2026-05-31", q: "cliente ficticio" }, tope: 8 * KB },
		{ ruta: "/v1/mesas/productos/search", cuerpo: { query: "cro" }, tope: 8 * KB },
		{ ruta: "/v1/venta-rapida/productos/search", cuerpo: { query: "cro", limit: 5 }, tope: 8 * KB },
		{ ruta: "/v1/venta-rapida/index-rows", cuerpo: { ids: ["com-1"] }, tope: 64 * KB },
	];

	/** Lo que encuentran: un cliente y un producto, en la base del DO (la prueba corre dentro de él). */
	function conDatos(hub: any): void {
		const sql = hub.state.storage.sql;
		sql.exec(
			"INSERT INTO Clientes (ID_Cliente, Nombre, Telefono, Email, Created_At) VALUES ('cli-1', 'Cliente Ficticio', '600000000', 'prueba@ejemplo.invalid', '2026-01-01 10:00:00');",
		);
		sql.exec("INSERT INTO Categorias_Producto (ID_Categoria, Nombre, Pasa_Cocina) VALUES ('cat-cocina', 'Platos', 1);");
		sql.exec(
			"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('prod-croquetas', 'cat-cocina', 'Croquetas', 750);",
		);
	}

	it("cada una hace un solo viaje, sin clave de idempotencia y sin consultas sueltas, y lee la base del DO", async () => {
		await conNegocio("lecturas-post", {}, async (n, hub) => {
			conDatos(hub);
			for (const { ruta, cuerpo } of LECTURAS) {
				const r = await pedir(n, "POST", ruta, { cuerpo, sinClave: true });
				expect(r.status, ruta).toBe(200);
				expect(viajes(r.res, "hub-ruta"), ruta).toBe(1);
				expect(viajes(r.res, "hub-lee"), ruta).toBe(0);
				expect(viajes(r.res, "hub-escribe"), ruta).toBe(0);
			}

			const cliente = await pedir(n, "POST", "/v1/reservas/buscar-cliente", { cuerpo: { telefono: " 600000000 " }, sinClave: true });
			expect(cliente.json).toMatchObject({ id_cliente: "cli-1", coincide_por: "telefono" });
			const productos = await pedir(n, "POST", "/v1/venta-rapida/productos/search", { cuerpo: { query: "cro", limit: 5 }, sinClave: true });
			expect(JSON.stringify(productos.json)).toContain("Croquetas");
		});
	});

	it("un cuerpo que pasa de su tope se rechaza en el Worker, antes de autenticar: no llega al DO", async () => {
		await conNegocio("lecturas-post-tope", {}, async (n) => {
			for (const { ruta, cuerpo, tope } of LECTURAS) {
				// Con una firma que no vale: si se autenticara antes de mirar el tope, sería un 401.
				const r = await pedir(n, "POST", ruta, {
					cuerpo: { ...cuerpo, relleno: "x".repeat(tope + KB) },
					sinClave: true,
					firma: "firma-que-no-vale",
				});
				expect(r.status, ruta).toBe(413);
				expect(r.json, ruta).toMatchObject({ ok: false, error: "payload_too_large" });
				expect(viajes(r.res, "hub-ruta"), ruta).toBe(0);
			}
		});
	});

	it("un cuerpo que no es una búsqueda se rechaza dentro, con el mismo sobre", async () => {
		await conNegocio("lecturas-post-validacion", {}, async (n) => {
			const r = await pedir(n, "POST", "/v1/venta-rapida/productos/search", { cuerpo: { query: 7 }, sinClave: true });
			expect(r.status).toBe(400);
			expect(r.json).toMatchObject({ ok: false, error: "validation_error" });
			expect(viajes(r.res, "hub-ruta")).toBe(1);
		});
	});
});
