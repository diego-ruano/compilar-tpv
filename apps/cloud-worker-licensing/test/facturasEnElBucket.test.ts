// test/facturasEnElBucket.test.ts
//
// El PDF de cada factura completa se guarda en el bucket de las imágenes, `IMAGES`, bajo
// `{tenant}/facturas/{ID_Registro}.pdf` (`domains/facturas/`). Un solo bucket para lo de los TPV,
// protegido por la carpeta. Aquí, por la `app` entera y con el R2 local de verdad:
//
//   · la Main sube y baja el PDF de una factura, firmado, y el negocio sale del token;
//   · una factura subida no cambia: otra subida del mismo registro contesta como hecha sin tocarla,
//     también si se cuela entre la pregunta y la escritura;
//   · lo que no es un PDF, un id que no es un UUID o un cuerpo que pasa del tope no entran; el tope,
//     antes de leer el cuerpo y de autenticar;
//   · ni una Handy ni la Main a la que se le ha trasladado la licencia suben ni bajan nada;
//   · ninguna ruta borra una factura;
//   · las rutas de las imágenes —sobre todo el GET público— no entregan, aceptan ni borran nada de
//     la carpeta de las facturas, se le pida como se le pida (mayúsculas, `..`, `%2F`, `%2e%2e`, `\`).

import { env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { HANDY, MAIN, conNegocioFirmado, peticionFirmada, type Negocio } from "./helpers/negocioFirmado";
import { MAX_BYTES_FACTURA } from "../src/domains/facturas/facturas.routes";

let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/server/db")>()),
	getDb: () => dbCentral,
}));

const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");
const deps = { ponerCentral: (db: unknown) => void (dbCentral = db), firmarSesion, olvidarLicenciasCacheadas };

const env = entorno as any;

const pdf = (texto: string) => new TextEncoder().encode(`%PDF-1.4\n% ${texto}\n%%EOF\n`);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

const clave = (n: Negocio, id: string) => `${n.tenantId}/facturas/${id}.pdf`;

/** Lo que hay guardado en una clave, como texto, o `null`. */
async function guardado(key: string, bucket = env.IMAGES): Promise<string | null> {
	const obj = await bucket.get(key);
	return obj ? obj.text() : null;
}

async function subir(n: Negocio, id: string, bytes: Uint8Array, deviceId = MAIN, entornoExtra: Record<string, unknown> = {}) {
	const peticion = await peticionFirmada(deps, n, deviceId, "PUT", `/v1/facturas/${id}`, {
		bytes,
		cabeceras: { "content-type": "application/pdf" },
	});
	return app.request(peticion, undefined, { ...env, ...entornoExtra });
}

async function bajar(n: Negocio, cuerpo: unknown, deviceId = MAIN) {
	return app.request(await peticionFirmada(deps, n, deviceId, "POST", "/v1/facturas/descargar", { cuerpo }), undefined, env);
}

describe("la Main sube y baja el PDF de una factura", () => {
	it("lo guarda en la carpeta de facturas de su negocio y lo devuelve tal cual, sin caché", async () => {
		await conNegocioFirmado(deps, "factura-sube-y-baja", async (n) => {
			const id = crypto.randomUUID();
			const res = await subir(n, id, pdf("F1-1"));
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, ya_estaba: false });

			const obj = await env.IMAGES.get(clave(n, id));
			expect(await obj.text()).toBe(new TextDecoder().decode(pdf("F1-1")));
			expect(obj.httpMetadata.contentType).toBe("application/pdf");
			expect(obj.customMetadata).toEqual({ dispositivo: MAIN });

			const bajada = await bajar(n, { id_registro: id });
			expect(bajada.status).toBe(200);
			expect(bajada.headers.get("Content-Type")).toBe("application/pdf");
			expect(bajada.headers.get("Cache-Control")).toBe("no-store");
			expect(bajada.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(new Uint8Array(await bajada.arrayBuffer())).toEqual(pdf("F1-1"));
		});
	});

	it("el id en mayúsculas es el mismo registro: la misma clave, en minúsculas", async () => {
		await conNegocioFirmado(deps, "factura-mayusculas", async (n) => {
			const id = crypto.randomUUID();
			expect((await subir(n, id.toUpperCase(), pdf("mayúsculas"))).status).toBe(200);
			expect(await guardado(clave(n, id))).toContain("%PDF-");
			const bajada = await bajar(n, { id_registro: id.toUpperCase() });
			expect(bajada.status).toBe(200);
			await bajada.arrayBuffer();
		});
	});

	it("una que no está en la nube es un 404 sin caché", async () => {
		await conNegocioFirmado(deps, "factura-no-esta", async (n) => {
			const res = await bajar(n, { id_registro: crypto.randomUUID() });
			expect(res.status).toBe(404);
			expect(res.headers.get("Cache-Control")).toBe("no-store");
			expect(await res.json()).toMatchObject({ ok: false, code: "not_found", error: "not_found" });
		});
	});

	it("el negocio sale del token: lo subido por uno no se baja desde otro", async () => {
		const id = crypto.randomUUID();
		await conNegocioFirmado(deps, "factura-de-uno", async (n) => {
			expect((await subir(n, id, pdf("de uno"))).status).toBe(200);
		});
		await conNegocioFirmado(deps, "factura-de-otro", async (n) => {
			const res = await bajar(n, { id_registro: id });
			expect(res.status).toBe(404);
			await res.arrayBuffer();
		});
	});
});

describe("una factura subida no cambia", () => {
	it("otra subida del mismo registro contesta como hecha y deja la primera", async () => {
		await conNegocioFirmado(deps, "factura-inmutable", async (n) => {
			const id = crypto.randomUUID();
			expect((await subir(n, id, pdf("la emitida"))).status).toBe(200);

			const otra = await subir(n, id, pdf("otra distinta"));
			expect(otra.status).toBe(200);
			expect(await otra.json()).toEqual({ ok: true, ya_estaba: true });
			expect(await guardado(clave(n, id))).toContain("la emitida");
		});
	});

	it("si otra subida se cuela entre la pregunta y la escritura, la escritura no pisa nada", async () => {
		await conNegocioFirmado(deps, "factura-carrera", async (n) => {
			const id = crypto.randomUUID();
			await env.IMAGES.put(clave(n, id), pdf("la que llegó antes"));
			// El bucket contesta a la pregunta como si aún no estuviera: es la carrera.
			const ciego = {
				head: async () => null,
				get: (k: string) => env.IMAGES.get(k),
				put: (...a: unknown[]) => env.IMAGES.put(...a),
			};
			const res = await subir(n, id, pdf("la que llegó después"), MAIN, { IMAGES: ciego });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true, ya_estaba: true });
			expect(await guardado(clave(n, id))).toContain("la que llegó antes");
		});
	});

	it("ninguna ruta la borra", async () => {
		await conNegocioFirmado(deps, "factura-sin-borrado", async (n) => {
			const id = crypto.randomUUID();
			expect((await subir(n, id, pdf("para siempre"))).status).toBe(200);

			for (const metodo of ["DELETE", "POST", "PATCH"]) {
				const res = await app.request(await peticionFirmada(deps, n, MAIN, metodo, `/v1/facturas/${id}`), undefined, env);
				expect(res.status, metodo).toBe(404);
				await res.arrayBuffer();
			}
			expect(await guardado(clave(n, id))).toContain("para siempre");
		});
	});

	it("del bucket sólo borran las rutas de imágenes y la retirada de un negocio de pruebas", () => {
		const fuentes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
			string,
			string
		>;
		delete fuentes["../src/server/worker-configuration.d.ts"];
		// Lo que nombra el bucket y borra algo (de él, o de la caché del edge).
		const conBorrado = Object.entries(fuentes)
			.filter(([, f]) => /\bIMAGES\b/.test(f) && /\.delete\s*\(/.test(f))
			.map(([fichero]) => fichero.replace("../src/", ""))
			.sort();
		expect(conBorrado).toEqual(["domains/admin/pruebas.ts", "domains/images/images.routes.ts"]);
		const facturas = fuentes["../src/domains/facturas/facturas.routes.ts"];
		expect(facturas).toBeDefined();
		expect(facturas).not.toMatch(/\.delete\s*\(/);
	});
});

describe("lo que no entra", () => {
	it("lo que no es un PDF, o viene vacío", async () => {
		await conNegocioFirmado(deps, "factura-no-pdf", async (n) => {
			for (const bytes of [PNG, new TextEncoder().encode("hola"), new TextEncoder().encode("%PDF-"), new Uint8Array()]) {
				const id = crypto.randomUUID();
				const res = await subir(n, id, bytes);
				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({ ok: false, code: "validation", error: "factura_no_es_pdf" });
				expect(await guardado(clave(n, id))).toBeNull();
			}
		});
	});

	it("un id que no es un UUID, ni en el camino ni en el cuerpo", async () => {
		await conNegocioFirmado(deps, "factura-id-malo", async (n) => {
			for (const id of ["F1-2026-1", "12345678", `${crypto.randomUUID()}.pdf`, `${crypto.randomUUID()}x`]) {
				const res = await subir(n, id, pdf("id malo"));
				expect(res.status, id).toBe(400);
				expect(await res.json()).toMatchObject({ error: "factura_id_no_valido" });
			}
			// Con una barra codificada, el camino ya no es el de la ruta, o el id no es un UUID.
			const conBarra = await subir(n, `..%2F${crypto.randomUUID()}`, pdf("barra"));
			expect([400, 404]).toContain(conBarra.status);
			await conBarra.arrayBuffer();

			for (const cuerpo of [{}, { id_registro: "F1-2026-1" }, { id_registro: 7 }, { id_registro: ` ${crypto.randomUUID()}` }]) {
				const res = await bajar(n, cuerpo);
				expect(res.status, JSON.stringify(cuerpo)).toBe(400);
				expect(await res.json()).toMatchObject({ error: "factura_id_no_valido" });
			}
			const listado = await env.IMAGES.list({ prefix: `${n.tenantId}/` });
			expect(listado.objects).toEqual([]);
		});
	});

	it("un cuerpo que pasa del tope se corta antes de leerlo y de autenticar", async () => {
		await conNegocioFirmado(deps, "factura-grande", async (n) => {
			const id = crypto.randomUUID();
			const grande = new Uint8Array(MAX_BYTES_FACTURA + 1);
			grande.set(pdf("grande"));
			// Sin firma: si el tope no fuera delante, saldría el 401 de `tenantAuth`.
			const res = await app.request(
				new Request(`https://tpv-api.test/v1/facturas/${id}`, {
					method: "PUT",
					headers: { "content-type": "application/pdf", "content-length": String(grande.byteLength) },
					body: grande,
				}),
				undefined,
				env,
			);
			expect(res.status).toBe(413);
			expect(await res.json()).toMatchObject({ ok: false, error: "factura_demasiado_grande" });
			expect(n.central).toEqual([]);
			expect(await guardado(clave(n, id))).toBeNull();

			// Y firmada, por la Main, tampoco.
			const firmada = await subir(n, id, grande);
			expect(firmada.status).toBe(413);
			await firmada.arrayBuffer();
			expect(await guardado(clave(n, id))).toBeNull();
		});
	});
});

describe("sólo la Main vigente", () => {
	it("una Handy no sube ni baja facturas", async () => {
		await conNegocioFirmado(deps, "factura-handy", async (n) => {
			const id = crypto.randomUUID();
			const sube = await subir(n, id, pdf("desde la Handy"), HANDY);
			expect(sube.status).toBe(403);
			expect(await sube.json()).toMatchObject({ ok: false, error: "forbidden_not_tpv" });
			expect(await guardado(clave(n, id))).toBeNull();

			await env.IMAGES.put(clave(n, id), pdf("de la Main"));
			const baja = await bajar(n, { id_registro: id }, HANDY);
			expect(baja.status).toBe(403);
			expect(await baja.json()).toMatchObject({ error: "forbidden_not_tpv" });
		});
	});

	it("la Main a la que se le ha trasladado la licencia tampoco, aunque el Worker aún la dé por buena", async () => {
		await conNegocioFirmado(deps, "factura-desplazada", async (n) => {
			const id = crypto.randomUUID();
			// Entra, y el Worker se queda con su «sí» un minuto.
			expect((await subir(n, id, pdf("antes del traslado"))).status).toBe(200);

			n.enCentral(`UPDATE licenses SET main_device_id = 'la-main-nueva', updated_at_ms = ? WHERE tenant_id = ?;`, Date.now(), n.tenantId);
			const otro = crypto.randomUUID();
			const sube = await subir(n, otro, pdf("después del traslado"));
			expect(sube.status).toBe(403);
			expect(await sube.json()).toMatchObject({ ok: false, code: "device_revoked", error: "device_replaced" });
			expect(await guardado(clave(n, otro))).toBeNull();

			const baja = await bajar(n, { id_registro: id });
			expect(baja.status).toBe(403);
			expect(await baja.json()).toMatchObject({ error: "device_replaced" });
		});
	});
});

describe("las rutas de las imágenes no llegan a las facturas", () => {
	/**
	 * Las formas de pedir el PDF de la factura `id` por `/v1/images/{tenant}/…`, el GET público. La
	 * URL normaliza `..`, `%2e%2e` y `\` antes de llegar al worker; `%2F` y `%66` llegan tal cual.
	 */
	const porElGetPublico = (tenant: string, id: string) => [
		`/v1/images/${tenant}/facturas/${id}.pdf`,
		`/v1/images/${tenant}/facturas/${id}.pdf?formato=pdf`,
		`/v1/images/${tenant}/FACTURAS/${id}.pdf`,
		`/v1/images/${tenant}/Facturas/${id}.PDF`,
		`/v1/images/${tenant}/%66acturas/${id}.pdf`,
		`/v1/images/${tenant}/images/../facturas/${id}.pdf`,
		`/v1/images/${tenant}/images/productos/../../facturas/${id}.pdf`,
		`/v1/images/${tenant}/images/%2e%2e/facturas/${id}.pdf`,
		`/v1/images/${tenant}/images/%2E%2E/facturas/${id}.pdf`,
		`/v1/images/${tenant}/images\\..\\facturas\\${id}.pdf`,
		`/v1/images/${tenant}/images%2F..%2Ffacturas%2F${id}.pdf`,
		`/v1/images/${tenant}/images%2f..%2ffacturas%2f${id}.pdf`,
		`/v1/images/${tenant}/images/productos/..%2F..%2Ffacturas%2F${id}.pdf`,
		`/v1/images/${tenant}/images/productos/${id}.pdf`,
		`/v1/images/${tenant}/images/facturas/${id}.pdf`,
		`/v1/images/${tenant}/images/productos/${id}.jpg/../../../facturas/${id}.pdf`,
		`/v1/images/${tenant}%2Ffacturas/${id}.pdf`,
		`/v1/images/${tenant}%2ffacturas/${id}.pdf`,
		`/v1/images/${tenant}%2Ffacturas/images/productos/${id}.jpg`,
		`/v1/images/${tenant}%2F..%2F${tenant}%2Ffacturas/${id}.pdf`,
		`/v1/images/${tenant}/facturas/${id}`,
		`/v1/images/${tenant}/facturas/`,
		`/v1/images/${tenant}/facturas`,
	];

	it("el GET público no entrega ninguna, se le pida como se le pida", async () => {
		await conNegocioFirmado(deps, "factura-get-publico", async (n) => {
			const id = crypto.randomUUID();
			await env.IMAGES.put(clave(n, id), pdf("privada"));
			// Y por si una forma rara acabara en una clave literal, también ahí hay un PDF.
			await env.IMAGES.put(`${n.tenantId}/facturas/images/productos/${id}.jpg`, pdf("privada"));

			for (const camino of porElGetPublico(n.tenantId, id)) {
				const res = await app.request(new Request(`https://tpv-api.test${camino}`), undefined, env);
				const cuerpo = await res.text();
				expect(res.status, camino).toBe(400);
				expect(cuerpo, camino).not.toContain("%PDF");
				expect(res.headers.get("Cache-Control"), camino).toBe("no-store");
			}
			// Sigue ahí: nadie la ha tocado.
			expect(await guardado(clave(n, id))).toContain("privada");
		});
	});

	it("la subida firmada de imágenes no escribe en la carpeta de las facturas", async () => {
		await conNegocioFirmado(deps, "factura-put-imagen", async (n) => {
			const id = crypto.randomUUID();
			await env.IMAGES.put(clave(n, id), pdf("la emitida"));

			for (const rel of [
				`facturas/${id}.pdf`,
				`FACTURAS/${id}.pdf`,
				`images/../facturas/${id}.pdf`,
				`images/%2e%2e/facturas/${id}.pdf`,
				`images%2F..%2Ffacturas%2F${id}.pdf`,
				`images/productos/..%2F..%2Ffacturas%2F${id}.pdf`,
				`images/productos/${id}.pdf`,
				`images/facturas/${id}.png`,
			]) {
				for (const bytes of [pdf("pisada"), PNG]) {
					const res = await app.request(
						await peticionFirmada(deps, n, MAIN, "PUT", `/v1/images/${rel}`, { bytes, cabeceras: { "content-type": "image/png" } }),
						undefined,
						env,
					);
					expect(res.status, rel).toBe(400);
					await res.arrayBuffer();
				}
			}
			expect(await guardado(clave(n, id))).toContain("la emitida");
			// Y no ha dejado nada más en el negocio.
			const listado = await env.IMAGES.list({ prefix: `${n.tenantId}/` });
			expect(listado.objects.map((o: { key: string }) => o.key)).toEqual([clave(n, id)]);
		});
	});

	it("el borrado firmado de imágenes no borra ninguna", async () => {
		await conNegocioFirmado(deps, "factura-delete-imagen", async (n) => {
			const id = crypto.randomUUID();
			await env.IMAGES.put(clave(n, id), pdf("la emitida"));

			for (const rel of [
				`facturas/${id}.pdf`,
				`FACTURAS/${id}.pdf`,
				`images/../facturas/${id}.pdf`,
				`images/%2E%2E/facturas/${id}.pdf`,
				`images%2F..%2Ffacturas%2F${id}.pdf`,
				`images/productos/..%2F..%2Ffacturas%2F${id}.pdf`,
				`images/productos/${id}.pdf`,
				`facturas/`,
				``,
			]) {
				const res = await app.request(await peticionFirmada(deps, n, MAIN, "DELETE", `/v1/images/${rel}`), undefined, env);
				expect([400, 404], rel).toContain(res.status);
				await res.arrayBuffer();
			}
			expect(await guardado(clave(n, id))).toContain("la emitida");
		});
	});

	it("la descarga firmada de imágenes no baja ninguna", async () => {
		await conNegocioFirmado(deps, "factura-download-imagen", async (n) => {
			const id = crypto.randomUUID();
			await env.IMAGES.put(clave(n, id), pdf("privada"));

			for (const rel_path of [
				`facturas/${id}.pdf`,
				`FACTURAS/${id}.pdf`,
				`./facturas/${id}.pdf`,
				`/facturas/${id}.pdf`,
				`images/../facturas/${id}.pdf`,
				`images/productos/../../facturas/${id}.pdf`,
				`images%2F..%2Ffacturas%2F${id}.pdf`,
				`images/productos/${id}.pdf`,
				`${n.tenantId}/facturas/${id}.pdf`,
			]) {
				const res = await app.request(
					await peticionFirmada(deps, n, MAIN, "POST", "/v1/images/download", { cuerpo: { rel_path } }),
					undefined,
					env,
				);
				const cuerpo = await res.text();
				expect(res.status, rel_path).toBe(400);
				expect(cuerpo, rel_path).not.toContain("%PDF");
			}
		});
	});
});
