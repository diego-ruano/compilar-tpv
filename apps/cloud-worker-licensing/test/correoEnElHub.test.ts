// test/correoEnElHub.test.ts
//
// DO-04 · Las dos rutas que mandan un correo leyendo la base del negocio se ejecutan dentro de su
// TenantHub (`lib/enElHub.ts`): `POST /v1/email/enviar-pedido` y `POST /v1/reservas-web/avisos`.
//
// Leían la base del negocio desde el Worker, consulta a consulta (`/avisos`, dos viajes al DO). Lo
// que se fija aquí, por el camino desplegado (la `app` entera, la petición firmada, `alHub`):
//   · cada una hace un solo viaje al TenantHub y ninguna consulta suelta;
//   · lo demás que hacen sigue funcionando desde dentro del DO: el cupo y la traza en la base
//     central, la agenda de reservas web (otro Durable Object), la clave del widget y el envío;
//   · un rechazo que se decide dentro llega con su código y su status;
//   · un pedido con su clave de envío (`id_envio`) no sale dos veces: un reintento de uno que ya
//     salió contesta ok sin mandar otro, uno que falló se puede repetir y uno que está saliendo
//     ahora mismo no se manda otra vez;
//   · las demás rutas de reservas web, que no leen la base del negocio, se quedan en el Worker.
//
// La base central de pruebas vive en el SQLite del propio TenantHub del negocio: es la única forma
// de que la lea una ruta que se ejecuta dentro de él (`helpers/negocioFirmado.ts`).

import { describe, expect, it, vi } from "vitest";

import { conNegocioFirmado, pedirFirmado, viajes, type Negocio } from "./helpers/negocioFirmado";

let dbCentral: unknown = null;

vi.mock("../src/server/db", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/server/db")>();
	return { ...original, getDb: () => dbCentral };
});

const { app } = await import("../src/app");
const { firmarSesion } = await import("../src/lib/sesion");
const { olvidarLicenciasCacheadas } = await import("../src/lib/licenciaEnUso");

const deps = {
	ponerCentral: (db: unknown) => void (dbCentral = db),
	firmarSesion,
	olvidarLicenciasCacheadas,
};

/** Lo que se ha mandado, y el binding de correo que lo apunta. */
const enviados: any[] = [];
/** Si el binding de correo tiene que fallar, como el de Cloudflare: con su `code`. */
let correoCaido = false;
const CORREO = {
	EMAIL: {
		send: async (m: any) => {
			if (correoCaido) throw Object.assign(new Error("caído"), { code: "E_INTERNAL" });
			enviados.push(m);
		},
	},
	EMAIL_FROM_ADDRESS: "pedidos@altaria.test",
	EMAIL_RESERVAS_FROM_ADDRESS: "reservas@altaria.test",
};

const ID_RESERVA = "0199aa00-0000-7000-8000-00000000abcd";
/** SHA-256 de «ana@correo.es». */
const HUELLA_ANA = "80ec301799f952e798d6387318dc4616444dc00c3963ed5c1845cf85c0e60758";

/**
 * Un negocio con un proveedor, sus datos de contacto y una reserva web, y el binding de correo
 * puesto en el entorno de su TenantHub: dentro del DO la ruta usa el entorno del DO, no el del Worker.
 */
async function conNegocio(nombre: string, prueba: (n: Negocio, sql: any) => Promise<void>): Promise<void> {
	enviados.length = 0;
	correoCaido = false;
	await conNegocioFirmado(
		deps,
		`correo-hub-${nombre}`,
		async (n, hub) => {
			hub.env = { ...hub.env, ...CORREO };
			const sql = hub.state.storage.sql;
			sql.exec("UPDATE Business_Settings SET Business_Name = 'Bar Pepe', Telefono = '950 000 000' WHERE ID = 1;");
			sql.exec("UPDATE Contact_Settings SET Contact_Email = 'bar@pepe.test' WHERE ID = 1;");
			sql.exec(
				"INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Email) VALUES ('pv1', 'Bebidas del Sur', 'pedidos@bebidas.test');",
			);
			sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('c1', 'Ana', 'ana@correo.es');");
			sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Salón');");
			sql.exec(
				`INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
				 VALUES ('m7', 'z1', 'Mesa 7', 4, 0, 0, 'rect', 80, 80);`,
			);
			sql.exec(
				`INSERT INTO Reservas (ID_Reserva, ID_Cliente, ID_Mesa, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
				 VALUES (?, 'c1', 'm7', '2026-10-24', '22:00', 'CENA', 4, 'PROXIMA', 'WEB');`,
				ID_RESERVA,
			);
			sql.exec("INSERT INTO reserva_web_claves (clave, tenant_id, created_at_ms) VALUES ('rw_CLAVE', ?, 1);", n.tenantId);
			await prueba(n, sql);
		},
		{ centralEnElNegocio: true },
	);
}

const PEDIDO = {
	email_destino: "pedidos@bebidas.test",
	nombre_proveedor: "Bebidas del Sur",
	notas: "Lo de siempre",
	lineas: [{ nombre_producto: "Cerveza", cantidad: 3, precio_unitario: 1250, unidad: "caja" }],
	id_envio: "0199aa00-0000-7000-8000-0000000e0000",
};

function aviso(extra: Record<string, unknown> = {}) {
	return {
		id_aviso: "0199aa00-0000-7000-8000-0000000a0001",
		id_reserva: ID_RESERVA,
		tipo: "modificada",
		dia_ymd: "2026-10-24",
		hora: "22:00",
		personas: 4,
		mesa: "Mesa 7",
		id_cliente: "c1",
		huella_correo: HUELLA_ANA,
		...extra,
	};
}

describe("DO-04 · el pedido a un proveedor se manda desde dentro del TenantHub", () => {
	it("un viaje, sin consultas sueltas: lee el proveedor, reserva el cupo, envía y deja la traza", async () => {
		await conNegocio("pedido", async (n, sql) => {
			const res = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", { cuerpo: PEDIDO });
			expect(await res.json()).toEqual({ ok: true });
			expect(res.status).toBe(200);
			expect(viajes(res, "hub-ruta")).toBe(1);
			expect(viajes(res, "hub-lee")).toBe(0);

			expect(enviados).toHaveLength(1);
			expect(enviados[0]).toMatchObject({
				to: "pedidos@bebidas.test",
				replyTo: "bar@pepe.test",
				subject: "Pedido de Bar Pepe",
				from: { email: "pedidos@altaria.test", name: "Bar Pepe" },
			});
			expect(enviados[0].text).toContain("Cerveza");

			// La traza y el cupo, en la base central, con quién lo pidió.
			const traza = sql.exec("SELECT tenant_id, device_id, to_email, proveedor, ok, tipo FROM email_sends;").toArray();
			expect(traza).toEqual([
				{
					tenant_id: n.tenantId,
					device_id: "main-firmada",
					to_email: "pedidos@bebidas.test",
					proveedor: "Bebidas del Sur",
					ok: 1,
					tipo: "pedido",
				},
			]);
		});
	});

	it("un destinatario que no es un proveedor del negocio se rechaza dentro, con su código", async () => {
		await conNegocio("pedido-ajeno", async (n, sql) => {
			const res = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", {
				cuerpo: { ...PEDIDO, email_destino: "cualquiera@otro.test" },
			});
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ ok: false, error: "email_destino_no_autorizado" });
			expect(viajes(res, "hub-ruta")).toBe(1);
			expect(enviados).toEqual([]);
			// Un rechazo no gasta cupo.
			expect(sql.exec("SELECT COUNT(*) AS n FROM email_sends;").one().n).toBe(0);
		});
	});
});

describe("el pedido a un proveedor no sale dos veces (id_envio)", () => {
	const CLAVE = "0199aa00-0000-7000-8000-0000000e0001";
	const conClave = (id_envio: string = CLAVE) => ({ cuerpo: { ...PEDIDO, id_envio } });
	const filas = (sql: any) => sql.exec("SELECT id, ok, error_code FROM email_sends ORDER BY sent_at_ms;").toArray();

	it("un reintento con la misma clave contesta ok y no manda otro correo", async () => {
		await conNegocio("pedido-una-vez", async (n, sql) => {
			const primero = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave());
			expect(await primero.json()).toEqual({ ok: true });
			// La respuesta se perdió por el camino y la Main lo repite con la misma clave.
			const repetido = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave());
			expect(repetido.status).toBe(200);
			expect(await repetido.json()).toEqual({ ok: true });

			expect(enviados).toHaveLength(1);
			// Una fila, con la clave y el negocio delante; cuenta una vez en el cupo.
			expect(filas(sql)).toEqual([{ id: `pedido:${n.tenantId}:${CLAVE}`, ok: 1, error_code: null }]);

			// Otro envío (otra clave) sí sale.
			const otro = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave("0199aa00-0000-7000-8000-0000000e0002"));
			expect(await otro.json()).toEqual({ ok: true });
			expect(enviados).toHaveLength(2);
		});
	});

	it("uno que falló se puede repetir con su misma clave, y entonces sale", async () => {
		await conNegocio("pedido-fallido", async (n, sql) => {
			correoCaido = true;
			const fallido = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave());
			expect(fallido.status).toBe(500);
			expect(filas(sql)).toEqual([{ id: `pedido:${n.tenantId}:${CLAVE}`, ok: 0, error_code: "E_INTERNAL" }]);

			correoCaido = false;
			const otraVez = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave());
			expect(await otraVez.json()).toEqual({ ok: true });
			expect(enviados).toHaveLength(1);
			expect(filas(sql)).toEqual([{ id: `pedido:${n.tenantId}:${CLAVE}`, ok: 1, error_code: null }]);
		});
	});

	it("si apuntar que salió falla, se insiste: no se queda en «enviando», que se podría retomar", async () => {
		await conNegocio("pedido-apuntar-insiste", async (n, sql) => {
			const real: any = dbCentral;
			let fallos = 2;
			dbCentral = {
				...real,
				execute: async (s: any) => {
					const texto = typeof s === "string" ? s : s.sql;
					if (/INSERT INTO email_sends[\s\S]*VALUES/.test(texto) && fallos-- > 0) throw new Error("la base central no contesta");
					return real.execute(s);
				},
			};
			const res = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave());
			expect(await res.json()).toEqual({ ok: true });
			expect(fallos).toBe(-1);
			expect(filas(sql)).toEqual([{ id: `pedido:${n.tenantId}:${CLAVE}`, ok: 1, error_code: null }]);

			// Pasados los minutos en que una reserva a medias se puede retomar, sigue sin salir otra vez.
			sql.exec("UPDATE email_sends SET sent_at_ms = sent_at_ms - 600000;");
			const repetido = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave());
			expect(await repetido.json()).toEqual({ ok: true });
			expect(enviados).toHaveLength(1);
		});
	});

	it("el mismo envío saliendo ahora por otra petición: ésta no lo manda (409)", async () => {
		await conNegocio("pedido-en-curso", async (n, sql) => {
			sql.exec(
				`INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
				 VALUES (?, ?, 'main-firmada', 'pedidos@bebidas.test', 'Bebidas del Sur', 0, 'enviando', ?, 'pedido');`,
				`pedido:${n.tenantId}:${CLAVE}`,
				n.tenantId,
				Date.now(),
			);
			const res = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave());
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ ok: false, code: "conflict", error: "email_en_curso" });
			expect(enviados).toEqual([]);
		});
	});

	it("sin clave, o con una que no tiene su forma, no hay pedido: ni sale ni gasta cupo", async () => {
		await conNegocio("pedido-sin-clave", async (n, sql) => {
			const { id_envio: _, ...sinClave } = PEDIDO;
			for (const cuerpo of [sinClave, { ...PEDIDO, id_envio: "" }, { ...PEDIDO, id_envio: "corta" }, { ...PEDIDO, id_envio: "con espacios y más de dieciséis" }]) {
				const res = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", { cuerpo });
				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({ ok: false, error: "validation_error" });
			}
			expect(enviados).toEqual([]);
			expect(filas(sql)).toEqual([]);
		});
	});

	it("una clave del negocio no tapa la misma clave de otro", async () => {
		// El id lleva el negocio delante: la clave la elige el dispositivo.
		await conNegocio("pedido-clave-ajena", async (n, sql) => {
			sql.exec(
				`INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
				 VALUES (?, 'otro-negocio', 'otro-equipo', 'x@otro.test', 'Otro', 1, NULL, ?, 'pedido');`,
				`pedido:otro-negocio:${CLAVE}`,
				Date.now(),
			);
			const res = await pedirFirmado(deps, app, n, "/v1/email/enviar-pedido", conClave());
			expect(await res.json()).toEqual({ ok: true });
			expect(enviados).toHaveLength(1);
		});
	});
});

describe("DO-04 · el aviso de una reserva web se manda desde dentro del TenantHub", () => {
	it("un viaje, sin consultas sueltas: lee la reserva, pide el enlace a la agenda y envía", async () => {
		await conNegocio("aviso", async (n, sql) => {
			const res = await pedirFirmado(deps, app, n, "/v1/reservas-web/avisos", { cuerpo: aviso() });
			expect(await res.json()).toEqual({ ok: true, enviado: true });
			expect(res.status).toBe(200);
			expect(viajes(res, "hub-ruta")).toBe(1);
			expect(viajes(res, "hub-lee")).toBe(0);

			expect(enviados).toHaveLength(1);
			expect(enviados[0]).toMatchObject({
				to: "ana@correo.es",
				subject: "Tu reserva en Bar Pepe ha cambiado",
				from: { email: "reservas@altaria.test" },
			});
			// El enlace de cancelar: la clave del widget sale de la base central y el token, de la
			// agenda de reservas web, que es otro Durable Object. Las dos se piden desde el TenantHub.
			const linea = String(enviados[0].text)
				.split("\n")
				.find((l) => l.startsWith("Cancelar la reserva: "));
			const enlace = new URL(linea!.slice("Cancelar la reserva: ".length));
			expect(enlace.pathname).toBe("/reservas-web/v1/w/rw_CLAVE/cancelar");
			expect(enlace.hash).toMatch(/^#t=.{16,}$/);

			// Idempotente por `id_aviso`, con su traza en la base central: repetido no manda otro.
			const otra = await pedirFirmado(deps, app, n, "/v1/reservas-web/avisos", { cuerpo: aviso() });
			expect(await otra.json()).toEqual({ ok: true, enviado: true });
			expect(enviados).toHaveLength(1);
			expect(sql.exec("SELECT id, device_id, tipo, ok FROM email_sends;").toArray()).toEqual([
				{ id: "rw:aviso:0199aa00-0000-7000-8000-0000000a0001", device_id: "main-firmada", tipo: "reserva_web", ok: 1 },
			]);
		});
	});

	it("una reserva que la nube aún no tiene es un 404 decidido dentro: quien lo manda lo repite", async () => {
		await conNegocio("aviso-sin-reserva", async (n) => {
			const res = await pedirFirmado(deps, app, n, "/v1/reservas-web/avisos", {
				cuerpo: aviso({ id_reserva: "0199aa00-0000-7000-8000-00000000ffff" }),
			});
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ ok: false, error: "reserva_inexistente" });
			expect(viajes(res, "hub-ruta")).toBe(1);
			expect(enviados).toEqual([]);
		});
	});

	it("el de una reserva cancelada, igual: un viaje", async () => {
		await conNegocio("aviso-cancelada", async (n) => {
			const res = await pedirFirmado(deps, app, n, "/v1/reservas-web/avisos", { cuerpo: aviso({ tipo: "cancelada" }) });
			expect(await res.json()).toEqual({ ok: true, enviado: true });
			expect(viajes(res, "hub-ruta")).toBe(1);
			expect(viajes(res, "hub-lee")).toBe(0);
			expect(enviados.map((m) => m.subject)).toEqual(["Tu reserva en Bar Pepe se ha cancelado"]);
		});
	});

	it("lo que no lee la base del negocio se queda en el Worker", async () => {
		await conNegocio("pendientes", async (n) => {
			const res = await pedirFirmado(deps, app, n, "/v1/reservas-web/pendientes");
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ ok: true, peticiones: [] });
			expect(viajes(res, "hub-ruta")).toBe(0);
			expect(viajes(res, "hub-lee")).toBe(0);
		});
	});
});
