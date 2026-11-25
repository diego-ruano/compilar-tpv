// test/pedidosProveedor.test.ts
//
// PED-HANDY · Los pedidos a proveedores desde la Handy: las rutas de `/v1/pedidos-proveedor`, con el
// router suelto y su escritura por el motor de verdad del TenantHub (como `guardasEnElLote.test.ts`).
// Lo que deja cada escritura y lo que devuelve la página igual que la Main lo fijan los arneses de
// contrato; aquí, lo que es de la ruta: la guarda de la edición (SYNC-30), lo que contesta un cambio
// de estado y su reintento, la búsqueda, el techo de la página y los mensajes.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { cuerpoDeErrorConStatus } from "../src/lib/errorHttp";
import { MENSAJES } from "../src/lib/errorCodes";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { TECHO_LINEAS_PAGINA } from "../src/domains/pedidos_proveedor/pedidos_proveedor.queries";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));

const TENANT = "t-pedidos";
let nube: any = null;

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", TENANT);
		c.set("deviceId", "handy-pedidos");
		await next();
	},
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (_c: any, fn: any) => fn(nube),
}));

const { pedidosProveedorRoutes } = await import("../src/domains/pedidos_proveedor/pedidos_proveedor.routes");

const app = new Hono();
app.route("/v1/pedidos-proveedor", pedidosProveedorRoutes);
app.onError((e: any, c) => c.json(cuerpoDeErrorConStatus(e), e.status ?? 500));

/** La hora local de quien escribe, como la manda la app (en los tests, UTC); tiene que estar cerca del reloj. */
const AHORA = new Date().toISOString().slice(0, 19).replace("T", " ");

type Negocio = {
	/** Las filas de una consulta. */
	filas: (consulta: string) => any[];
	difundidos: any[];
	pedir: (
		metodo: string,
		ruta: string,
		cuerpo?: unknown,
		opciones?: { antesDelLote?: string[]; clave?: string },
	) => Promise<{ status: number; json: any }>;
};

async function conNegocio(nombre: string, sembrar: string[], prueba: (n: Negocio) => Promise<void>) {
	await enElHub(`pedidos-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const s of sembrar) sql.exec(s);
		const real = clienteLocal(hub.state.storage);
		nube = real;
		let antesDelLote: string[] = [];
		const db = {
			...real,
			async batch(sentencias: any[]) {
				for (const s of antesDelLote) sql.exec(s);
				antesDelLote = [];
				return real.batch(sentencias);
			},
		};
		hub.withTenantDbRetry = async (_t: string, run: any) => run(db);
		hub.isMainConnected = () => true;
		hub.isMainReady = () => true;
		hub.maybePurgeSyncLog = async () => {};
		const difundidos: any[] = [];
		hub.broadcastAuthed = (m: any) => difundidos.push(m);
		hub.emitSyncEvent = () => {};

		const env = {
			TenantHub: {
				idFromName: (n: string) => n,
				get: () => ({ aplicar: (p: any) => hub.aplicar(p) }),
			},
		};
		await prueba({
			filas: (consulta) => sql.exec(consulta).toArray(),
			difundidos,
			async pedir(metodo, ruta, cuerpo, opciones = {}) {
				antesDelLote = opciones.antesDelLote ?? [];
				const res = await app.request(
					ruta,
					{
						method: metodo,
						headers: {
							"content-type": "application/json",
							"x-idempotency-key": opciones.clave ?? crypto.randomUUID(),
							"x-client-now": AHORA,
						},
						...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
					},
					env as any,
				);
				return { status: res.status, json: await res.json() };
			},
		});
	});
}

const PROVEEDOR = "INSERT INTO Proveedores (ID_Proveedor, Nombre_Empresa, Email) VALUES ('pr-1', 'Cafés Ñandú', 'pedidos@nandu.test');";

const linea = (id: string, nombre: string, cantidad = 1) => ({
	id_linea: id,
	nombre_producto: nombre,
	cantidad,
	precio_unitario: 150,
	unidad: "kg",
});

const nuevo = (id: string, lineas = [linea(`${id}-l1`, "Café en grano", 2)]) => ({
	id_pedido: id,
	id_proveedor: "pr-1",
	email_destino: "pedidos@nandu.test",
	notas: " urgente ",
	lineas,
});

describe("PED-HANDY · crear un pedido desde la Handy", () => {
	it("deja el borrador con la hora de quien escribe, la copia del nombre y sus líneas en orden", async () => {
		await conNegocio("crear", [PROVEEDOR], async (n) => {
			const r = await n.pedir("POST", "/v1/pedidos-proveedor", nuevo("p-1", [linea("l-b", "Leche"), linea("l-a", "Azúcar", 3)]));
			expect(r).toEqual({ status: 200, json: { ok: true, id_pedido: "p-1" } });

			expect(n.filas("SELECT ID_Pedido, ID_Proveedor, Email_Destino, Estado, Fecha_Creacion, Notas, Nombre_Proveedor FROM Pedidos_Proveedor")).toEqual([
				{
					ID_Pedido: "p-1",
					ID_Proveedor: "pr-1",
					Email_Destino: "pedidos@nandu.test",
					Estado: "borrador",
					Fecha_Creacion: AHORA,
					Notas: "urgente",
					Nombre_Proveedor: "Cafés Ñandú",
				},
			]);
			expect(n.filas("SELECT ID_Linea, Nombre_Producto, Cantidad FROM Lineas_Pedido_Proveedor ORDER BY rowid")).toEqual([
				{ ID_Linea: "l-b", Nombre_Producto: "Leche", Cantidad: 1 },
				{ ID_Linea: "l-a", Nombre_Producto: "Azúcar", Cantidad: 3 },
			]);

			// Lo que se replica a la Main saca el nombre de su base, como la sentencia de la Main.
			const replicado = JSON.stringify(n.difundidos);
			expect(replicado).toContain("SELECT Nombre_Empresa FROM Proveedores");
			expect(replicado).not.toContain("Ñandú");
		});
	});

	it("una línea sin id recibe uno; un pedido sin id o con 501 líneas no entra", async () => {
		await conNegocio("crear-validacion", [PROVEEDOR], async (n) => {
			const sinIdDeLinea = await n.pedir("POST", "/v1/pedidos-proveedor", nuevo("p-1", [linea("  ", "Leche")]));
			expect(sinIdDeLinea.status).toBe(200);
			const [{ ID_Linea }] = n.filas("SELECT ID_Linea FROM Lineas_Pedido_Proveedor");
			expect(String(ID_Linea)).toMatch(/^[0-9a-f-]{36}$/);

			const sinId = await n.pedir("POST", "/v1/pedidos-proveedor", nuevo(" "));
			expect(sinId.status).toBe(400);
			expect(sinId.json.message).toBe("Falta el pedido.");

			const muchas = Array.from({ length: 501 }, (_, i) => linea(`l-${i}`, "x"));
			const largo = await n.pedir("POST", "/v1/pedidos-proveedor", nuevo("p-2", muchas));
			expect(largo.status).toBe(400);
			expect(largo.json.message).toBe("Un pedido no puede llevar más de 500 líneas.");
			expect(n.filas("SELECT COUNT(*) AS n FROM Pedidos_Proveedor")[0].n).toBe(1);
		});
	});
});

describe("PED-HANDY · editar un pedido (SYNC-30)", () => {
	it("un borrador cambia su cabecera y sus líneas", async () => {
		await conNegocio("editar", [PROVEEDOR], async (n) => {
			await n.pedir("POST", "/v1/pedidos-proveedor", nuevo("p-1"));
			const { id_pedido: _id, ...edicion } = nuevo("p-1", [linea("l-2", "Té")]);
			const r = await n.pedir("PUT", "/v1/pedidos-proveedor/p-1", { ...edicion, notas: null, id_proveedor: null });
			expect(r).toEqual({ status: 200, json: { ok: true } });
			expect(n.filas("SELECT ID_Proveedor, Notas, Nombre_Proveedor FROM Pedidos_Proveedor")).toEqual([
				{ ID_Proveedor: null, Notas: null, Nombre_Proveedor: null },
			]);
			expect(n.filas("SELECT ID_Linea FROM Lineas_Pedido_Proveedor")).toEqual([{ ID_Linea: "l-2" }]);
		});
	});

	it("uno que se ha enviado entre la lectura y el lote no se toca, y se dice con el texto de la Main", async () => {
		await conNegocio("editar-enviado", [PROVEEDOR], async (n) => {
			await n.pedir("POST", "/v1/pedidos-proveedor", nuevo("p-1"));
			const { id_pedido: _id, ...edicion } = nuevo("p-1", [linea("l-2", "Té")]);
			const r = await n.pedir("PUT", "/v1/pedidos-proveedor/p-1", edicion, {
				antesDelLote: ["UPDATE Pedidos_Proveedor SET Estado = 'enviado' WHERE ID_Pedido = 'p-1';"],
			});
			expect(r.status).toBe(409);
			// El `code` (`conflict`, por el 409) y la frase de `MENSAJES` los pone `completarErrores` en la app.
			expect(r.json).toMatchObject({ error: "pedido_no_editable" });
			expect(MENSAJES.pedido_no_editable).toBe(
				"Ese pedido ya se ha enviado o cancelado y no se puede cambiar. Cierra el formulario.",
			);
			expect(n.filas("SELECT ID_Linea FROM Lineas_Pedido_Proveedor")).toEqual([{ ID_Linea: "p-1-l1" }]);
			expect(n.difundidos).toHaveLength(1); // sólo el alta

			const noExiste = await n.pedir("PUT", "/v1/pedidos-proveedor/p-x", edicion);
			expect(noExiste.status).toBe(409);
		});
	});
});

describe("PED-HANDY · enviar o cancelar un pedido", () => {
	it("dice si había un borrador que cambiar, y el reintento contesta lo mismo", async () => {
		await conNegocio("estado", [PROVEEDOR], async (n) => {
			await n.pedir("POST", "/v1/pedidos-proveedor", nuevo("p-1"));
			const enviar = { estado: " enviado ", fecha_envio: "18/11/26 12:34" };
			const r = await n.pedir("PUT", "/v1/pedidos-proveedor/p-1/estado", enviar, { clave: "clave-envio-p1-0001" });
			expect(r).toEqual({ status: 200, json: { ok: true, cambiado: true } });
			expect(n.filas("SELECT Estado, Fecha_Envio FROM Pedidos_Proveedor")).toEqual([
				{ Estado: "enviado", Fecha_Envio: "18/11/26 12:34" },
			]);

			const reintento = await n.pedir("PUT", "/v1/pedidos-proveedor/p-1/estado", enviar, { clave: "clave-envio-p1-0001" });
			expect(reintento.json.cambiado).toBe(true);

			// Ya no es un borrador: ni se cancela ni se vuelve a enviar.
			const cancelar = await n.pedir("PUT", "/v1/pedidos-proveedor/p-1/estado", { estado: "cancelado" });
			expect(cancelar.json).toEqual({ ok: true, cambiado: false });
			expect(n.filas("SELECT Estado FROM Pedidos_Proveedor")).toEqual([{ Estado: "enviado" }]);
		});
	});

	it("un estado que no es enviar ni cancelar se rechaza con la frase de la Main", async () => {
		await conNegocio("estado-malo", [PROVEEDOR], async (n) => {
			await n.pedir("POST", "/v1/pedidos-proveedor", nuevo("p-1"));
			const r = await n.pedir("PUT", "/v1/pedidos-proveedor/p-1/estado", { estado: "borrador" });
			expect(r.status).toBe(400);
			expect(r.json.message).toBe("Un pedido sólo se puede enviar o cancelar.");
		});
	});
});

describe("PED-HANDY · la página de pedidos", () => {
	const pedido = (id: string, dia: number, extra = "") =>
		`INSERT INTO Pedidos_Proveedor (ID_Pedido, ID_Proveedor, Estado, Fecha_Creacion, Notas${extra ? ", Nombre_Proveedor" : ""})
		 VALUES ('${id}', ${extra ? "NULL" : "'pr-1'"}, 'borrador', '2026-01-${String(dia).padStart(2, "0")} 10:00:00', 'descuento 50%'${extra ? `, '${extra}'` : ""});`;

	it("busca sin acentos ni comodines, con el total, lo más reciente primero y la clave desempatando", async () => {
		await conNegocio(
			"pagina",
			[
				PROVEEDOR,
				pedido("p-a", 1),
				pedido("p-c", 2),
				pedido("p-b", 2),
				pedido("p-borrado", 3, "Bebidas Sur"),
				"INSERT INTO Pedidos_Proveedor (ID_Pedido, Estado, Fecha_Creacion, Notas) VALUES ('p-500', 'enviado', '2026-01-04 10:00:00', 'pedir 500 cajas');",
			],
			async (n) => {
				const pagina = async (cuerpo: object) => (await n.pedir("POST", "/v1/pedidos-proveedor/pagina", cuerpo)).json;

				const todo = await pagina({ limit: 50, offset: 0 });
				expect(todo.total).toBe(5);
				expect(todo.pedidos.map((p: any) => p.id_pedido)).toEqual(["p-500", "p-borrado", "p-c", "p-b", "p-a"]);

				const nandu = await pagina({ limit: 50, offset: 0, search: " CAFES nandu " });
				expect(nandu.total).toBe(3);
				expect(nandu.pedidos[0]).toMatchObject({ id_pedido: "p-c", nombre_proveedor: "Cafés Ñandú" });

				// El proveedor borrado se encuentra por la copia del nombre.
				expect((await pagina({ limit: 50, offset: 0, search: "bebidas" })).pedidos.map((p: any) => p.id_pedido)).toEqual(["p-borrado"]);
				// `%` y `_` se buscan tal cual.
				expect((await pagina({ limit: 50, offset: 0, search: "50%" })).total).toBe(4);
				expect((await pagina({ limit: 50, offset: 0, search: "_" })).total).toBe(0);
				expect((await pagina({ limit: 50, offset: 0, search: "ENVIADO" })).pedidos.map((p: any) => p.id_pedido)).toEqual(["p-500"]);

				const segunda = await pagina({ limit: 2, offset: 2 });
				expect(segunda.pedidos.map((p: any) => p.id_pedido)).toEqual(["p-c", "p-b"]);
				expect(segunda.total).toBe(5);
			},
		);
	});

	it("se corta en su techo de líneas, siempre con un pedido, y la siguiente sigue donde acaba", async () => {
		const conLineas = (id: string, dia: number, lineas: number) => [
			pedido(id, dia),
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${lineas})
			 INSERT INTO Lineas_Pedido_Proveedor (ID_Linea, ID_Pedido, Nombre_Producto, Cantidad)
			 SELECT '${id}-' || i, '${id}', 'Producto ' || i, 1 FROM n;`,
		];
		expect(TECHO_LINEAS_PAGINA).toBe(2000);
		await conNegocio(
			"techo",
			[PROVEEDOR, ...conLineas("p-1", 9, 900), ...conLineas("p-2", 8, 900), ...conLineas("p-3", 7, 900), ...conLineas("p-4", 6, 2500)],
			async (n) => {
				const pagina = async (offset: number) =>
					(await n.pedir("POST", "/v1/pedidos-proveedor/pagina", { limit: 50, offset })).json;
				const primera = await pagina(0);
				expect(primera.total).toBe(4);
				expect(primera.pedidos.map((p: any) => [p.id_pedido, p.lineas.length])).toEqual([["p-1", 900], ["p-2", 900]]);
				expect(primera.pedidos[0].lineas[0]).toEqual({
					id_linea: "p-1-1",
					nombre_producto: "Producto 1",
					cantidad: 1,
					precio_unitario: null,
					unidad: null,
				});
				expect((await pagina(2)).pedidos.map((p: any) => p.id_pedido)).toEqual(["p-3"]);
				expect((await pagina(3)).pedidos.map((p: any) => p.lineas.length)).toEqual([2500]);
			},
		);
	});

	it("el tamaño de la página se acota como en la Main", async () => {
		const muchos = Array.from({ length: 205 }, (_, i) =>
			`INSERT INTO Pedidos_Proveedor (ID_Pedido, Estado, Fecha_Creacion) VALUES ('p-${String(i).padStart(3, "0")}', 'borrador', '2026-01-01 10:00:00');`,
		);
		await conNegocio("tamano", muchos, async (n) => {
			const grande = (await n.pedir("POST", "/v1/pedidos-proveedor/pagina", { limit: 999, offset: 0 })).json;
			expect(grande.pedidos).toHaveLength(200);
			const cero = (await n.pedir("POST", "/v1/pedidos-proveedor/pagina", { limit: 0, offset: 0 })).json;
			expect(cero.pedidos).toHaveLength(1);
		});
	});
});
