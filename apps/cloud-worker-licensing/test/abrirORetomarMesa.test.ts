// test/abrirORetomarMesa.test.ts
//
// Abrir o retomar la mesa en un viaje (`POST /v1/mesas/comandas/abrir-o-retomar`) y no escribir lo
// que no cambia nada. Contra el SQLite de un TenantHub con el esquema de verdad:
//
//   · sin comanda abierta, se abre; con una sin trabajador ni líneas, se le pone; con una que ya
//     lo tiene, o que ya tiene líneas, no se escribe nada;
//   · lo que devuelve la ruta es la comanda abierta con sus líneas;
//   · `PUT /comandas/trabajador-if-null` tampoco aplica nada si la comanda ya tiene trabajador.
//
// Que la Main hace lo mismo lo fijan los casos de contrato `mesas/abrir_o_retomar*`.

import type { Client } from "@libsql/client/web";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ db: null as unknown, aplicados: [] as string[] }));

vi.mock("../src/middleware/tenant", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/middleware/tenant")>()),
	tenantAuth: async (_c: unknown, next: () => Promise<void>) => next(),
	soloLaMainCobra: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("../src/lib/enElHub", () => ({ alHub: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock("../src/lib/tenantClient", () => ({ tenantQuery: (_c: unknown, fn: (db: unknown) => unknown) => fn(estado.db) }));
vi.mock("../src/lib/rutas", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/rutas")>()),
	apply: vi.fn(async (_c: unknown, built: { commandName: string }) => {
		estado.aplicados.push(built.commandName);
		return null;
	}),
}));

import { planAbrirORetomar } from "../src/domains/mesas/abrirORetomar";
import { comandaConLineas } from "../src/domains/mesas/mesas.queries";
import { mesasRoutes } from "../src/domains/mesas/mesas.routes";
import { buildApplyBatch } from "../src/durableObjects/tenantHub.lote";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

const SEMILLA = [
	"INSERT INTO Roles (ID_Rol, Nombre_Rol) VALUES ('rol-1', 'RolDePrueba');",
	"INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES ('user-1', 'rol-1', 'u1@x.com', 'h', 'Ana');",
	"INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre) VALUES ('user-2', 'rol-1', 'u2@x.com', 'h', 'Luis');",
	"INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('trab-1', 'user-1');",
	"INSERT INTO Trabajadores (ID_Trabajador, ID_Usuario) VALUES ('trab-2', 'user-2');",
	"INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('zona-1', 'Salon');",
	"INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height) VALUES ('mesa-1', 'zona-1', '1', 4, 0, 0, 'rect', 80, 80);",
	"INSERT INTO Categorias_Producto (ID_Categoria, Nombre) VALUES ('cat-1', 'Bebidas');",
	"INSERT INTO Productos (ID_Producto, ID_Categoria, Nombre, Precio_Venta) VALUES ('cana', 'cat-1', 'Caña', 200);",
];

async function conMesa<R>(nombre: string, extra: string[], prueba: (db: Client, sql: any, hub: any) => Promise<R>): Promise<R> {
	return enElHub(`abrir-o-retomar-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const s of [...SEMILLA, ...extra]) sql.exec(s);
		return prueba(clienteSobre(sql) as unknown as Client, sql, hub);
	});
}

function aplicar(hub: any, sql: any, built: any): void {
	const batch = buildApplyBatch(built.command);
	hub.state.storage.transactionSync(() => {
		sql.exec("PRAGMA defer_foreign_keys = ON;");
		for (const st of batch.middle) sql.exec(st.sql, ...(st.args ?? []));
	});
}

const datos = (usuario: string) => ({ id_mesa: "db-mesa-mesa-1", id_trabajador_o_usuario: usuario, id_reserva: null });
const abierta = (trabajador: string | null) =>
	`INSERT INTO Comandas (ID_Comanda, Canal, ID_Mesa, ID_Trabajador, Fecha_Hora_Apertura, Estado) VALUES ('comanda-1', 'MESA', 'mesa-1', ${trabajador ? `'${trabajador}'` : "NULL"}, '2026-01-01 12:00:00', 'Abierta');`;

describe("lo que se escribe al abrir o retomar la mesa", () => {
	it("sin comanda abierta, la abre con el trabajador y la devuelve sin líneas", async () => {
		await conMesa("abre", [], async (db, sql, hub) => {
			const plan = await planAbrirORetomar(db, datos("user-1"));
			expect(plan?.commandName).toBe("abrir_comanda");
			aplicar(hub, sql, plan);
			const out = await comandaConLineas(db, "mesa-1");
			expect([out?.comanda.id_mesa, out?.comanda.id_trabajador, out?.lineas]).toEqual(["mesa-1", "trab-1", []]);
		});
	});

	it("con una abierta sin trabajador ni líneas, se lo pone", async () => {
		await conMesa("pone", [abierta(null)], async (db, sql, hub) => {
			const plan = await planAbrirORetomar(db, datos("user-2"));
			expect(plan?.commandName).toBe("comanda_set_trabajador_if_null");
			aplicar(hub, sql, plan);
			expect((await comandaConLineas(db, "mesa-1"))?.comanda.id_trabajador).toBe("trab-2");
		});
	});

	it("con una que ya tiene trabajador, o que ya tiene líneas, no escribe nada", async () => {
		await conMesa("con-trabajador", [abierta("trab-1")], async (db) => {
			expect(await planAbrirORetomar(db, datos("user-2"))).toBeNull();
		});
		await conMesa("con-lineas", [
			abierta(null),
			"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('det-1', 'comanda-1', 'cana', 1, 200);",
		], async (db) => {
			expect(await planAbrirORetomar(db, datos("user-2"))).toBeNull();
			const out = await comandaConLineas(db, "mesa-1");
			expect(out?.lineas.map((l) => l.ID_Detalle)).toEqual(["det-1"]);
		});
	});
});

describe("las rutas", () => {
	const app = new Hono().route("/v1/mesas", mesasRoutes);
	const pedir = (ruta: string, metodo: string, cuerpo: unknown) =>
		app.request(`/v1/mesas${ruta}`, {
			method: metodo,
			headers: { "Content-Type": "application/json", "X-Idempotency-Key": "op-1" },
			body: JSON.stringify(cuerpo),
		});

	it("abrir o retomar devuelve la comanda con sus líneas en una respuesta, y no aplica nada si no hace falta", async () => {
		await conMesa("ruta", [
			abierta("trab-1"),
			"INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, ID_Producto, Cantidad, Precio_Unitario) VALUES ('det-1', 'comanda-1', 'cana', 1, 200);",
		], async (db) => {
			estado.db = db;
			estado.aplicados = [];
			const r = await pedir("/comandas/abrir-o-retomar", "POST", { id_mesa: "mesa-1", id_usuario: "user-2" });
			expect(r.status).toBe(200);
			const out = (await r.json()) as any;
			expect([out.comanda.id_comanda, out.comanda.id_trabajador]).toEqual(["comanda-1", "trab-1"]);
			expect(out.lineas.map((l: any) => l.ID_Detalle)).toEqual(["det-1"]);
			expect(estado.aplicados).toEqual([]);
		});
	});

	it("poner el trabajador a una comanda que ya lo tiene no aplica nada", async () => {
		await conMesa("ruta-trabajador", [abierta("trab-1")], async (db) => {
			estado.db = db;
			estado.aplicados = [];
			const r = await pedir("/comandas/trabajador-if-null", "PUT", { id_comanda: "comanda-1", id_usuario: "user-2" });
			expect(await r.json()).toBe(false);
			expect(estado.aplicados).toEqual([]);
		});
		await conMesa("ruta-trabajador-falta", [abierta(null)], async (db) => {
			estado.db = db;
			estado.aplicados = [];
			const r = await pedir("/comandas/trabajador-if-null", "PUT", { id_comanda: "comanda-1", id_usuario: "user-2" });
			expect(await r.json()).toBe(true);
			expect(estado.aplicados).toEqual(["comanda_set_trabajador_if_null"]);
		});
	});
});
