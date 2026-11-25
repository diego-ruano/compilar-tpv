// test/basePerdidaSalidas.test.ts
//
// DO-PERDIDA · Las salidas de un negocio que ya nació y se ha quedado sin base en su TenantHub,
// desde la administración (`domains/admin/basesDeNegocios.ts`):
//
//   · crear su base vacía a sabiendas (`/v1/admin/negocios/base-vacia`), sin pasar por
//     `provisionTenantDatabase`, que se niega con un negocio nacido;
//   · devolverle su copia diaria de R2 (`/v1/admin/negocios/restaurar-copia`, DO-03).
//
// Las dos sólo con un negocio que ha nacido y cuyo objeto está vacío, con el token de
// administración, y dejando rastro en `admin_audit`. Y las dos abren el log de la réplica por encima
// de lo que la Main pueda haber visto, como la vuelta a un instante (`tenantHub.instante.ts`). La
// base central es una de verdad para cada caso (`helpers/central.ts`); los TenantHub y el bucket son
// los de los tests.

import { env as entorno, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { centralDePrueba, centralInterceptada, filasDe, type CentralDePrueba } from "./helpers/central";
import { enElHub } from "./helpers/hub";
import { adminRoutes } from "../src/domains/admin/admin.routes";
import { CARACTERES_POR_LINEA } from "../src/durableObjects/cargaDeCopias";
import { PURGADO_HASTA } from "../src/domains/sync/cambiosJson";
import { leerPaginaDeCambios } from "../src/domains/sync/sync.routes";
import { claveDeCopia } from "../src/durableObjects/tenantHub.copia";
import { SALTO_DE_SEQ } from "../src/durableObjects/tenantHub.instante";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { clienteLocal } from "../src/durableObjects/tenantHub.sqlite";
import { MIGRATIONS } from "../src/server/tenantMigrations";

const { capturados } = vi.hoisted(() => ({
	/** Lo que se ha mandado a Sentry (`capturarError`): su operación, su mensaje y el de su causa. */
	capturados: [] as { operacion: string; mensaje: string; causa?: string }[],
}));

vi.mock("../src/observability/errors", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/errors")>();
	return {
		...original,
		capturarError: (error: unknown, operacion: string) => {
			const causa = (error as any)?.cause;
			capturados.push({
				operacion,
				mensaje: String((error as any)?.message ?? error),
				...(causa === undefined ? {} : { causa: String(causa?.message ?? causa) }),
			});
			original.capturarError(error, operacion);
		},
	};
});

const env = entorno as any;
const TOKEN = "token-de-pruebas";
const ENV = { ...env, ADMIN_API_TOKEN: TOKEN };
const bucket = env.COPIAS_NEGOCIOS as R2Bucket;
const ADMIN = "00000000-0000-7000-8000-000000000501";
/** Con Axiom configurado (el conjunto de datos y el dominio son los de la suite). */
const AXIOM = { AXIOM_TOKEN: "token-de-pruebas" };

const stub = (tenantId: string) => env.TenantHub.get(env.TenantHub.idFromName(tenantId));

/**
 * Una orden a la administración, con lo que se ponga en el entorno: la base central (sin ella, la del
 * despliegue) o Axiom.
 */
async function pedir(
	ruta: string,
	cuerpo: unknown,
	token: string | null = TOKEN,
	entorno: Partial<CentralDePrueba["entorno"] & typeof AXIOM> = {},
) {
	const res = await adminRoutes.fetch(
		new Request(`https://api${ruta}`, {
			method: "POST",
			headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
			body: JSON.stringify(cuerpo),
		}),
		{ ...ENV, ...entorno },
	);
	// Un fallo sin capturar sale del `onError` de Hono como texto: sin cuerpo que leer.
	return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

type Central = {
	/** Una orden a la administración (`pedir`) con esta base central. */
	pedir: (ruta: string, cuerpo: unknown) => ReturnType<typeof pedir>;
	auditoria: () => Promise<string[]>;
	nacer: (t: string) => Promise<void>;
	/** Desde ahora, la base central falla al apuntar esa acción en `admin_audit`, y sólo ésa. */
	fallarAlApuntar: (action: string) => void;
	/** Y vuelve a contestar. */
	contestar: () => void;
};

/**
 * Corre `cuerpo` con una base central nueva, y `entorno` en el de cada orden. Lo que se le hace fallar
 * a la central va en su stub.
 */
async function conCentral<R>(cuerpo: (central: Central) => Promise<R>, entorno: Partial<typeof AXIOM> = {}): Promise<R> {
	const base = await centralDePrueba();
	let fallarAlApuntar: string | null = null;
	const vista = centralInterceptada(base, (metodo, [sentencia], llamar) => {
		const { sql, args } = sentencia as SentenciaEnlazada;
		return metodo === "ejecutar" &&
			fallarAlApuntar !== null &&
			/^\s*INSERT INTO admin_audit\b/.test(sql) &&
			args.includes(fallarAlApuntar)
			? Promise.reject(new Error("la base central no contesta"))
			: llamar();
	});
	return cuerpo({
		pedir: (ruta, c) => pedir(ruta, c, TOKEN, { ...vista.entorno, ...entorno }),
		auditoria: async () =>
			(await filasDe(base, "SELECT action FROM admin_audit ORDER BY at_ms, rowid;")).map((f) => String(f.action)),
		fallarAlApuntar: (action) => void (fallarAlApuntar = action),
		contestar: () => void (fallarAlApuntar = null),
		nacer: async (t) => {
			await filasDe(
				base,
				`INSERT INTO licenses (license_id, license_key_hash, tenant_id, main_device_id, status, disabled, term_months,
				   origin, issued_at_ms, activated_at_ms, customer_email, created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, 'la-main', 'active', 0, 12, 'stripe', 1, 1, 'bar@ejemplo.test', 1, 1);`,
				`lic-${t}`,
				`hash-${t}`,
				t,
			);
		},
	});
}

/** Lo que se compara de una base: las tablas del negocio que importan aquí, ordenadas. */
function foto(sql: any): Record<string, unknown[]> {
	const tabla = (t: string, orden: string) => sql.exec(`SELECT * FROM ${t} ORDER BY ${orden};`).toArray();
	return {
		clientes: tabla("Clientes", "ID_Cliente"),
		zonas: tabla("Zonas", "ID_Zona"),
		usuarios: tabla("Usuarios", "ID_Usuario"),
		roles: tabla("Roles", "ID_Rol"),
		ajustes: tabla("Business_Settings", "ID"),
	};
}

/** Un negocio con base, unos datos y su copia de hoy en R2. Devuelve la foto de su base. */
async function negocioConCopia(t: string): Promise<Record<string, unknown[]>> {
	await stub(t).aprovisionar(t);
	const antes = await enElHub(t, (hub: any) => {
		const sql = hub.state.storage.sql;
		sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre, Notas, Total_Gastado) VALUES ('c1', 'Ana', ?, 1250);", "una\nnota");
		sql.exec("INSERT INTO Clientes (ID_Cliente, Nombre, Notas, Total_Gastado) VALUES ('c2', 'Luis', NULL, 0);");
		sql.exec("INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z1', 'Sala');");
		sql.exec("UPDATE Usuarios SET Requiere_Setup = 0, Nombre = 'Dueña' WHERE ID_Usuario = ?;", ADMIN);
		sql.exec("UPDATE Business_Settings SET Business_Name = 'Bar de pruebas' WHERE ID = 1;");
		sql.exec("INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES (70, 'op-70', 'x', '[]', 1);");
		return foto(sql);
	});
	expect(await runDurableObjectAlarm(stub(t))).toBe(true);
	return antes;
}

async function gzip(texto: string): Promise<Uint8Array> {
	return new Uint8Array(
		await new Response(new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
	);
}

async function leer(clave: string): Promise<string> {
	const o = await bucket.get(clave);
	return new Response(o!.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

const hoy = () => new Date().toISOString().slice(0, 10);

describe("DO-PERDIDA · las salidas de la administración", () => {
	it("sin el token de administración no entra", async () => {
		for (const ruta of ["/negocios/base-vacia", "/negocios/restaurar-copia"]) {
			expect((await pedir(ruta, { tenantId: "x", modo: "main", motivo: "abc" }, null)).status).toBe(401);
		}
	});

	it("base vacía: sólo para un negocio nacido y sin base, sin pasar por la activación, y abre el log", async () => {
		const t = "perdida-vacia";
		const r = await conCentral(async (central) => {
			// Sin nacer: eso lo hace la activación de su licencia.
			const sinNacer = await central.pedir("/negocios/base-vacia", { tenantId: t, modo: "nube", motivo: "se perdió" });
			await central.nacer(t);
			const creada = await central.pedir("/negocios/base-vacia", { tenantId: t, modo: "nube", motivo: "se perdió" });
			// Con base ya no: no se pisa una base.
			const otraVez = await central.pedir("/negocios/base-vacia", { tenantId: t, modo: "nube", motivo: "se perdió" });
			return { sinNacer, creada, otraVez, auditoria: await central.auditoria() };
		});

		expect(r.sinNacer).toMatchObject({ status: 409, body: { ok: false, error: "negocio_sin_nacer" } });
		expect(r.creada.status).toBe(200);
		expect(r.creada.body).toMatchObject({ ok: true, inicio: SALTO_DE_SEQ, purgadoHasta: SALTO_DE_SEQ - 1 });
		expect(r.otraVez).toMatchObject({ status: 409, body: { error: "tenant_db_already_provisioned" } });
		// Antes de llamar al objeto se apunta desde dónde se abrirá el log, también la vez que no se abre.
		expect(r.auditoria).toEqual(["negocio_log_reservado", "negocio_base_vacia", "negocio_log_reservado"]);

		expect(await stub(t).estaAprovisionado()).toBe(true);
		await enElHub(t, async (hub: any) => {
			const sql = hub.state.storage.sql;
			// El administrador de la siembra, el sello y la copia diaria armada.
			expect(sql.exec("SELECT Requiere_Setup FROM Usuarios WHERE ID_Usuario = ?;", ADMIN).one().Requiere_Setup).toBe(1);
			expect(sql.exec("SELECT ID_Negocio FROM _Negocio;").one().ID_Negocio).toBe(t);
			expect(await hub.state.storage.getAlarm()).toBeGreaterThan(Date.now());
			expect(sql.exec("SELECT Last_Seq FROM Sync_Main_Checkpoints WHERE Device_Id = ?;", PURGADO_HASTA).one().Last_Seq).toBe(
				SALTO_DE_SEQ - 1,
			);
		});
	});

	it("restaurar la copia: devuelve las mismas filas a un objeto vacío y abre el log", async () => {
		const t = "perdida-copia";
		const antes = await negocioConCopia(t);
		await stub(t).borrarTodo(); // la base se pierde; la copia de R2, no

		const r = await conCentral(async (central) => {
			await central.nacer(t);
			const restaurada = await central.pedir("/negocios/restaurar-copia", { tenantId: t, modo: "main", motivo: "borrado por error" });
			const otraVez = await central.pedir("/negocios/restaurar-copia", { tenantId: t, modo: "main", motivo: "borrado por error" });
			return { restaurada, otraVez, auditoria: await central.auditoria() };
		});

		expect(r.restaurada.status).toBe(200);
		// La copia dice hasta dónde numeró su base (el 70), y el log se abre por encima.
		expect(r.restaurada.body).toMatchObject({
			ok: true,
			clave: claveDeCopia(t, hoy()),
			seqConocido: 70,
			inicio: 70 + SALTO_DE_SEQ,
			purgadoHasta: null,
		});
		expect(r.restaurada.body.filas).toBeGreaterThan(5);
		expect(r.otraVez).toMatchObject({ status: 409, body: { error: "tenant_db_already_provisioned" } });
		expect(r.auditoria).toEqual(["negocio_log_reservado", "negocio_restaurar_copia", "negocio_log_reservado"]);

		await enElHub(t, async (hub: any) => {
			const sql = hub.state.storage.sql;
			expect(foto(sql)).toEqual(antes);
			// El log de la réplica no venía en la copia: sólo el cambio vacío que lo abre.
			expect(sql.exec("SELECT Seq, Command_Name FROM Sync_Changes;").toArray()).toEqual([
				{ Seq: 70 + SALTO_DE_SEQ, Command_Name: "nube_devuelta" },
			]);
			expect(sql.exec("SELECT ID_Negocio FROM _Negocio;").one().ID_Negocio).toBe(t);
			expect(Number(sql.exec("PRAGMA foreign_keys;").one().foreign_keys)).toBe(1);
			expect(await hub.state.storage.getAlarm()).toBeGreaterThan(Date.now());
		});
		expect(await stub(t).leerParaLaWeb(t, { que: "plano" })).toMatchObject({ ok: true });
	});

	it("tras otra pérdida el log nuevo se abre por encima del perdido, que la Main ya ha bajado (DO-PERDIDA)", async () => {
		const t = "perdida-dos-veces";
		const r = await conCentral(async (central) => {
			await central.nacer(t);
			const primera = await central.pedir("/negocios/base-vacia", { tenantId: t, modo: "main", motivo: "se perdió" });
			// La base nueva numera lo que escriben las Handy, y la Main lo baja: su checkpoint ya pasa del salto.
			const checkpoint = await enElHub(t, (hub: any) => {
				const sql = hub.state.storage.sql;
				for (let i = 1; i <= 5; i++) {
					sql.exec(
						"INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES (?, 'x', '[]', 'una-handy', 1);",
						`op-${i}`,
					);
				}
				const ultimo = Number(sql.exec("SELECT MAX(Seq) AS s FROM Sync_Changes;").one().s);
				sql.exec("INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES ('la-main', ?, 1);", ultimo);
				return ultimo;
			});
			// Y se vuelve a perder, antes de que le dé tiempo a hacer una copia.
			await stub(t).borrarTodo();
			const segunda = await central.pedir("/negocios/base-vacia", { tenantId: t, modo: "main", motivo: "otra vez" });
			// Una Handy escribe en la base de ahora, y la Main pide desde su checkpoint.
			const pagina = await enElHub(t, (hub: any) => {
				hub.state.storage.sql.exec(
					"INSERT INTO Sync_Changes (Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms) VALUES ('op-handy', 'x', '[]', 'una-handy', 2);",
				);
				return leerPaginaDeCambios(clienteLocal(hub.state.storage), checkpoint, 100);
			});
			return { primera, checkpoint, segunda, pagina };
		});

		expect(r.checkpoint).toBe(SALTO_DE_SEQ + 5);
		// La Main baja el cambio que abre el log y lo de la Handy: nada queda por debajo de su checkpoint.
		expect(r.pagina.items.map((c: any) => [Number(c.Seq), c.Op_Id])).toEqual([
			[2 * SALTO_DE_SEQ, expect.stringMatching(/^nube-devuelta-/)],
			[2 * SALTO_DE_SEQ + 1, "op-handy"],
		]);
		// Lo que se perdió lo dice la base central: el inicio del log anterior, en `admin_audit`.
		expect(r.primera.body).toMatchObject({ ok: true, seqConocido: 0, inicio: SALTO_DE_SEQ });
		expect(r.segunda.body).toMatchObject({ ok: true, seqConocido: SALTO_DE_SEQ, inicio: 2 * SALTO_DE_SEQ });
	});

	for (const ruta of ["/negocios/base-vacia", "/negocios/restaurar-copia"] as const) {
		it(`${ruta}: si la base central no apunta la orden con el log ya abierto, la siguiente pérdida abre igual por encima (DO-PERDIDA)`, async () => {
			const t = `perdida-sin-rastro-${ruta.slice(10)}`;
			const accion = ruta === "/negocios/base-vacia" ? "negocio_base_vacia" : "negocio_restaurar_copia";
			const orden = { tenantId: t, modo: "main", motivo: "se perdió" };
			if (ruta === "/negocios/restaurar-copia") await negocioConCopia(t); // su copia dice el 70
			await stub(t).borrarTodo();
			const r = await conCentral(async (central) => {
				await central.nacer(t);
				// El objeto abre el log, y la base central falla justo al apuntar la orden.
				central.fallarAlApuntar(accion);
				const fallida = await central.pedir(ruta, orden);
				central.contestar();
				const abierto = await enElHub(t, (hub: any) =>
					Number(hub.state.storage.sql.exec("SELECT MAX(Seq) AS s FROM Sync_Changes WHERE Command_Name = 'nube_devuelta';").one().s),
				);
				// Repetirla no lo arregla: el objeto ya tiene base.
				const repetida = await central.pedir(ruta, orden);
				// La Main baja de ese log, y el objeto se vuelve a perder antes de la copia de la noche.
				await stub(t).borrarTodo();
				const siguiente = await central.pedir("/negocios/base-vacia", orden);
				return { fallida, abierto, repetida, siguiente };
			});

			expect(r.fallida.status).toBe(500);
			expect(r.abierto).toBe((ruta === "/negocios/restaurar-copia" ? 70 : 0) + SALTO_DE_SEQ);
			expect(r.repetida).toMatchObject({ status: 409, body: { error: "tenant_db_already_provisioned" } });
			// Por encima del log que se abrió sin rastro, y de lo que la Main bajó de él (lo cubre el salto).
			expect(r.siguiente.status).toBe(200);
			expect(r.siguiente.body.seqConocido).toBeGreaterThanOrEqual(r.abierto);
			expect(r.siguiente.body.inicio).toBeGreaterThanOrEqual(r.abierto + SALTO_DE_SEQ);
		});
	}

	it("la copia dice hasta dónde numeró su base, y restaurarla abre el log por encima aunque la base central no lo sepa", async () => {
		const t = "perdida-copia-numerada";
		// Una base que ya venía de otra vuelta: numera por encima de varios saltos, y la Main con ella.
		const numerado = 3 * SALTO_DE_SEQ + 7;
		await stub(t).aprovisionar(t);
		await enElHub(t, (hub: any) => {
			const sql = hub.state.storage.sql;
			sql.exec("INSERT INTO Sync_Changes (Seq, Op_Id, Command_Name, Statements_Json, Created_At_Ms) VALUES (?, 'op-x', 'x', '[]', 1);", numerado - 2);
			sql.exec("INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms) VALUES ('la-main', ?, 1);", numerado);
		});
		expect(await runDurableObjectAlarm(stub(t))).toBe(true);
		const metadatos = (await bucket.head(claveDeCopia(t, hoy())))?.customMetadata;
		await stub(t).borrarTodo();

		// Sin rastro en la base central: lo sabe sólo la copia.
		const r = await conCentral(async (central) => {
			await central.nacer(t);
			return central.pedir("/negocios/base-vacia", { tenantId: t, modo: "nube", motivo: "se perdió" });
		});
		expect(r.body).toMatchObject({ ok: true, inicio: numerado + SALTO_DE_SEQ, purgadoHasta: numerado + SALTO_DE_SEQ - 1 });
		expect(r.body.seqConocido).toBe(numerado);
		expect(metadatos?.seq).toBe(String(numerado));
	});

	it("una copia cortada, de otra versión, con una línea que no es una fila, con una demasiado larga o con fines de línea de Windows no se restaura, el objeto se queda vacío y se dice por qué", async () => {
		const t = "perdida-copia-mala";
		await negocioConCopia(t);
		await stub(t).borrarTodo();
		const buena = await leer(claveDeCopia(t, hoy()));
		const lineas = buena.split("\n");
		/** La primera fila de Clientes, y dónde está en la copia (su número de línea es éste más uno). */
		const enClientes = lineas.findIndex((l) => l.startsWith('INSERT INTO "Clientes" ('));
		const deClientes = lineas[enClientes];
		/** La copia con la fila de Clientes cambiada por `otra`. */
		const conClientes = (otra: string) => lineas.with(enClientes, otra).join("\n");

		const cortada = lineas.filter((l) => !l.startsWith("-- Fin de la copia")).join("\n");
		await bucket.put(claveDeCopia(t, "2026-01-01"), await gzip(cortada));
		const deOtraVersion = buena.replace(/^-- Migraciones: (.*)$/m, "-- Migraciones: $1,9999_del_futuro");
		await bucket.put(claveDeCopia(t, "2026-01-02"), await gzip(deOtraVersion));
		// Una fila con otra sentencia detrás, que vaciaría las zonas si se ejecutara.
		await bucket.put(claveDeCopia(t, "2026-01-03"), await gzip(conClientes(`${deClientes} DELETE FROM Zonas;`)));
		// Una columna que el esquema de hoy no tiene: así se quedan las copias de antes de una migración
		// que la quite o le cambie el nombre.
		const conColumnaRetirada = deClientes.replace(
			/^INSERT INTO "Clientes" \((.*?)\) VALUES \(/,
			(_, columnas: string) => `INSERT INTO "Clientes" ("Columna_Retirada", ${columnas}) VALUES ('x', `,
		);
		expect(conColumnaRetirada).not.toBe(deClientes);
		await bucket.put(claveDeCopia(t, "2026-01-04"), await gzip(conClientes(conColumnaRetirada)));
		// Una línea más larga que la de la fila más grande que admite un objeto: no se junta entera.
		const demasiadoLarga = `INSERT INTO "Clientes" ("ID_Cliente", "Nombre") VALUES ('c-larga', '${"x".repeat(CARACTERES_POR_LINEA)}');`;
		await bucket.put(claveDeCopia(t, "2026-01-05"), await gzip(conClientes(demasiadoLarga)));
		// Con fines de línea de Windows: se dice eso, y no que sea de otra versión.
		await bucket.put(claveDeCopia(t, "2026-01-06"), await gzip(buena.replaceAll("\n", "\r\n")));

		const enviados: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			enviados.push(...JSON.parse(String(init.body)));
			return new Response("{}", { status: 200 });
		});
		const r = await conCentral(async (central) => {
			await central.nacer(t);
			const restaurar = (dia: string) =>
				central.pedir("/negocios/restaurar-copia", { tenantId: t, dia, modo: "main", motivo: "se perdió al migrar" });
			return {
				cortada: await restaurar("2026-01-01"),
				otra: await restaurar("2026-01-02"),
				manipulada: await restaurar("2026-01-03"),
				columnaRetirada: await restaurar("2026-01-04"),
				demasiadoLarga: await restaurar("2026-01-05"),
				crlf: await restaurar("2026-01-06"),
				noHay: await restaurar("2025-01-01"),
			};
		}, AXIOM).finally(() => vi.unstubAllGlobals());

		// Por qué no vale (`detalle`): la línea, el carácter y un código, y nada de lo que lleva la copia.
		const aqui = MIGRATIONS.map((m) => m.name);
		const porQue = {
			cortada: "copia_cortada: le falta la línea del final",
			otra: `copia_de_otra_version: la copia trae ${aqui.length + 1} migraciones y este worker sabe poner ${aqui.length}, hasta ${aqui.at(-1)}`,
			manipulada: `copia_no_valida: la línea ${enClientes + 1} no se puede cargar: sobra_texto (carácter ${deClientes.length + 1})`,
			columnaRetirada: `copia_no_valida: la línea ${enClientes + 1} no se puede cargar: columna_desconocida (carácter ${'INSERT INTO "Clientes" ('.length + 1})`,
			demasiadoLarga: `copia_no_valida: la línea ${enClientes + 1} es demasiado larga: pasa de ${CARACTERES_POR_LINEA} caracteres`,
			crlf: `copia_no_valida: la línea ${lineas.findIndex((l) => l.startsWith("-- Migraciones: ")) + 1} acaba en CR: la copia tiene fines de línea de Windows (CRLF); conviértela a LF`,
		};
		for (const [copia, detalle] of Object.entries(porQue)) {
			expect(r[copia as keyof typeof porQue], copia).toMatchObject({ status: 422, body: { ok: false, error: detalle.split(":")[0], detalle } });
		}
		expect(r.noHay).toMatchObject({ status: 404, body: { error: "copia_no_encontrada" } });
		expect(r.noHay.body).not.toHaveProperty("detalle");
		// Y queda en Axiom, sin el motivo de la orden, que es texto libre.
		expect(enviados.filter((e) => e.event === "copia_no_restaurada").map(({ error, detalle }) => [error, detalle])).toEqual([
			["copia_cortada", porQue.cortada],
			["copia_de_otra_version", porQue.otra],
			["copia_no_valida", porQue.manipulada],
			["copia_no_valida", porQue.columnaRetirada],
			["copia_no_valida", porQue.demasiadoLarga],
			["copia_no_valida", porQue.crlf],
			["copia_no_encontrada", undefined],
		]);
		expect(JSON.stringify(enviados)).not.toContain("al migrar");

		expect(await stub(t).estaAprovisionado()).toBe(false);
		expect(await enElHub(t, (hub: any) => hub.state.storage.getAlarm())).toBeNull();
	});

	it("una copia con el gzip roto, o con una fila que SQLite no acepta, tampoco: el objeto se queda vacío y se dice por qué, sin nada de la copia", async () => {
		const t = "perdida-copia-rechazada";
		await negocioConCopia(t);
		await stub(t).borrarTodo();
		const buena = await leer(claveDeCopia(t, hoy()));
		const lineas = buena.split("\n");
		const entera = await gzip(buena);
		await bucket.put(claveDeCopia(t, "2026-02-01"), entera.slice(0, Math.floor(entera.length / 2)));
		// La fila de un cliente otra vez, con otros datos: SQLite no la acepta (su clave ya está).
		const enClientes = lineas.findIndex((l) => l.startsWith('INSERT INTO "Clientes" ('));
		const repetida = lineas[enClientes].replace("'Ana'", "'Ana Gil Sanz, ana.gil@correo.es'");
		expect(repetida).not.toBe(lineas[enClientes]);
		const conRepetida = lineas
			.toSpliced(enClientes + 1, 0, repetida)
			.map((l) => l.replace(/^-- Fin de la copia: (\d+)/, (_m, n) => `-- Fin de la copia: ${Number(n) + 1}`))
			.join("\n");
		await bucket.put(claveDeCopia(t, "2026-02-02"), await gzip(conRepetida));

		const enviados: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			enviados.push(...JSON.parse(String(init.body)));
			return new Response("{}", { status: 200 });
		});
		capturados.length = 0;
		const r = await conCentral(async (central) => {
			await central.nacer(t);
			const restaurar = (dia: string) =>
				central.pedir("/negocios/restaurar-copia", { tenantId: t, dia, modo: "main", motivo: "se perdió al migrar" });
			return { gzipRoto: await restaurar("2026-02-01"), rechazada: await restaurar("2026-02-02") };
		}, AXIOM).finally(() => vi.unstubAllGlobals());

		const porQue = {
			gzipRoto: /^copia_no_valida: no se puede descomprimir: /,
			rechazada: /^copia_no_valida: SQLite no acepta una de las líneas \d+–\d+ de la copia \(.*\bClientes\b.*\): SQLITE_CONSTRAINT$/,
		};
		for (const [copia, detalle] of Object.entries(porQue)) {
			expect(r[copia as keyof typeof porQue], copia).toMatchObject({
				status: 422,
				body: { ok: false, error: "copia_no_valida", detalle: expect.stringMatching(detalle) },
			});
		}
		expect(JSON.stringify(r)).not.toMatch(/Ana Gil|ana\.gil/);
		// Queda en Axiom con su motivo, y lo que SQLite no acepta, también en Sentry, con su texto como causa.
		expect(enviados.filter((e) => e.event === "copia_no_restaurada").map(({ error, detalle }) => [error, detalle])).toEqual([
			["copia_no_valida", r.gzipRoto.body.detalle],
			["copia_no_valida", r.rechazada.body.detalle],
		]);
		expect(JSON.stringify(enviados)).not.toMatch(/Ana Gil|ana\.gil|al migrar/);
		expect(capturados).toEqual([{ operacion: "hub.restaurar_copia", mensaje: r.rechazada.body.detalle, causa: expect.stringMatching(/UNIQUE/) }]);

		expect(await stub(t).estaAprovisionado()).toBe(false);
		expect(await enElHub(t, (hub: any) => hub.state.storage.getAlarm())).toBeNull();
	});

	it("mientras se restaura, la base no atiende a nadie", async () => {
		const t = "perdida-copia-cerrada";
		await negocioConCopia(t);
		await stub(t).borrarTodo();
		await enElHub(t, async (hub: any) => {
			// Una copia que no termina de llegar: el objeto espera a la red con la base a medias.
			let soltar!: () => void;
			const espera = new Promise<void>((r) => (soltar = r));
			const real = hub.env.COPIAS_NEGOCIOS;
			hub.env = {
				...hub.env,
				COPIAS_NEGOCIOS: {
					get: async (clave: string) => {
						const o = await real.get(clave);
						const lector = o.body.getReader();
						let primero = true;
						return {
							body: new ReadableStream({
								async pull(c) {
									if (!primero) await espera;
									primero = false;
									const { value, done } = await lector.read();
									if (done) c.close();
									else c.enqueue(value);
								},
							}),
						};
					},
				},
			};
			const restaurando = hub.restaurarDesdeCopia({ tenantId: t, clave: claveDeCopia(t, hoy()), modo: "main" });
			await vi.waitFor(async () => expect(await hub.state.storage.get("vuelta-en-curso")).toBeTruthy());
			expect(await hub.leerParaLaWeb(t, { que: "plano" })).toMatchObject({ ok: false, code: "tenant_db_restaurando" });
			soltar();
			expect(await restaurando).toMatchObject({ ok: true });
			expect(await hub.leerParaLaWeb(t, { que: "plano" })).toMatchObject({ ok: true });
		});
	});
});
