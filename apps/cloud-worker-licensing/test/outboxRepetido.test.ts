// test/outboxRepetido.test.ts
//
// El outbox de un servicio de verdad, subido de tres formas a tres TenantHub distintos, tiene que
// dejar lo mismo en los tres.
//
// `fixtures/outboxDeUnServicio.json` son las primeras 300 operaciones que una Main dejó en su outbox
// durante un servicio (comandas, líneas, cambios de línea y cobros con su caja, su stock y su
// registro de facturación), sacadas de sus caminos reales, y los maestros que necesitan. Entre
// ellas se meten las que fallan: una que la nube rechaza siempre, una que falla una vez por algo que
// nadie sabe clasificar, el alta de un lote (cuyo movimiento va delante y sólo entra aplazando las
// claves foráneas, AUD-20), una línea de una comanda que no existe y una sin la hora fijada.
//
//   (A) de una en una, en lotes de una operación (el ritmo de la Main tras dos lotes sin
//       respuesta): es la referencia;
//   (B) en lotes cortados como los corta la Main (200 operaciones o 256 KB de sentencias);
//   (C) en lotes de tamaño al azar, con acuses que se pierden (el lote se reenvía entero) y lotes
//       cortados a medias que se reenvían enteros.
//
// En los tres: las mismas tablas de negocio, los mismos días apuntados por los triggers de las
// estadísticas, el mismo orden de `Op_Id` en el log, las mismas sentencias replicadas, el mismo
// veredicto para cada operación, y el objeto vivo al terminar.

import { afterAll, describe, expect, it } from "vitest";

import servicio from "./fixtures/outboxDeUnServicio.json";
import { enElHub } from "./helpers/hub";
import { montarMainEnElHub, opDelOutbox, type MainEnElHub, type OpDelOutbox } from "./helpers/mainEnElHub";

const TENANT = "tenant-repetido";
/** Lo que corta la Main (`replicacion.rs::subir_pendientes`). */
const MAX_OPS = 200;
const MAX_BYTES = 256 * 1024;

const informe: Record<string, unknown> = {};
afterAll(() => {
	console.log("\n===== OUTBOX REPETIDO =====\n" + JSON.stringify(informe, null, 2));
});

type Sentencia = { sql: string; args: unknown[] };

// ---- Las operaciones ---------------------------------------------------------------------------

const DESCONOCIDA = "op-falla-una-vez";

/** Las del servicio, con las que fallan repartidas entre ellas. */
function operaciones(): OpDelOutbox[] {
	const delServicio = (servicio.outbox as Sentencia[][]).map((sentencias, i) =>
		opDelOutbox(`op-${String(i).padStart(4, "0")}`, sentencias),
	);
	const producto = String((servicio.maestros.Productos.rows[0] as unknown[])[0]);
	const metidas: [number, OpDelOutbox][] = [
		// La nube la rechaza siempre: se aparta y lo de detrás sigue.
		[40, opDelOutbox("op-permanente", [{ sql: "UPDATE Comandas SET Columna_Que_No_Existe = 1;" }])],
		// Falla la primera vez por algo que no se sabe clasificar (`conFallos`): para el lote.
		[90, opDelOutbox(DESCONOCIDA, [{ sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona) VALUES ('z-rara', 'Rara');" }])],
		// AUD-20: el movimiento 'ALTA' va delante del alta del lote. Sólo entra aplazando las FK.
		[
			140,
			opDelOutbox("op-alta-de-lote", [
				{
					sql: `INSERT INTO Movimientos_Stock
					        (ID_Movimiento, ID_Lote, Tipo, Delta, Stock_Resultante, Motivo, ID_Usuario, Fecha)
					      SELECT ?1, ?2, 'ALTA', ?3, ?3, 'Entrada', NULL, '2026-11-13 15:00:00'
					       WHERE NOT EXISTS (SELECT 1 FROM Lotes_Producto WHERE ID_Lote = ?2);`,
					args: ["mov-nuevo", "lote-nuevo", 24],
				},
				{
					sql: `INSERT INTO Lotes_Producto (ID_Lote, ID_Producto, Codigo_Lote, Fecha_Entrada, Stock_Disponible, Coste_Unitario)
					      VALUES (?1, ?2, 'NUEVO', '2026-11-13 15:00:00', ?3, 90)
					      ON CONFLICT(ID_Lote) DO NOTHING;`,
					args: ["lote-nuevo", producto, 24],
				},
			]),
		],
		// Una clave foránea rota de verdad: no puede llegar así al confirmar.
		[
			190,
			opDelOutbox("op-fk-rota", [
				{
					sql: "INSERT INTO Detalle_Comanda (ID_Detalle, ID_Comanda, Cantidad, Precio_Unitario) VALUES ('d-huerfana', 'NO-EXISTE', 1, 100);",
				},
			]),
		],
		// Una hora que tendría que elegir la base, y nadie manda la del emisor.
		[
			240,
			opDelOutbox("op-sin-hora", [
				{
					sql: "INSERT INTO Zonas (ID_Zona, Nombre_Zona, Updated_At) VALUES ('z-hora', 'Hora', datetime('now','localtime'));",
				},
			]),
		],
	];
	const salida: OpDelOutbox[] = [];
	delServicio.forEach((op, i) => {
		for (const [donde, metida] of metidas) if (donde === i) salida.push(metida);
		salida.push(op);
	});
	return salida;
}

// ---- El hub ------------------------------------------------------------------------------------

/** La carta, las mesas, el personal y los lotes del servicio. */
function sembrar(hub: any): void {
	const st = hub.state.storage;
	st.transactionSync(() => {
		for (const [tabla, v] of Object.entries(servicio.maestros) as [string, { cols: string[]; rows: unknown[][] }][]) {
			const texto = `INSERT OR IGNORE INTO ${tabla} (${v.cols.join(", ")}) VALUES (${v.cols.map(() => "?").join(", ")});`;
			for (const fila of v.rows) st.sql.exec(texto, ...fila);
		}
		const b = servicio.businessSettings;
		st.sql.exec(
			"UPDATE Business_Settings SET CIF = ?, Razon_Social = ?, Business_Name = ?, Direccion = ?, Telefono = ? WHERE ID = 1;",
			b.CIF,
			b.Razon_Social,
			b.Business_Name,
			b.Direccion,
			b.Telefono,
		);
		// El administrador de la siembra lleva su sal: la misma huella en los tres hubs.
		st.sql.exec("UPDATE Usuarios SET Password_Hash = 'x' WHERE Email = 'admin@local';");
	});
}

type Medidas = { lotes: number; ops: number; msTotal: number; msMax: number; opsDelMasLento: number; aplazadas: number };

/**
 * Pone delante de los dos caminos el fallo de `DESCONOCIDA`, la primera vez que se intenta, y cuenta
 * las operaciones de un lote que han necesitado aplazar las claves foráneas.
 */
function conFallos(hub: any, medidas: Medidas): void {
	let quedan = 1;
	const falla = (sentencias: any[]) => sentencias[1]?.args?.[0] === DESCONOCIDA && quedan-- > 0;
	const raro = () => new Error("un fallo que nadie ha visto nunca");

	const lote = hub.loteLocal.bind(hub);
	hub.loteLocal = (sentencias: any[], alAplazar: () => boolean) => {
		if (falla(sentencias)) throw raro();
		return lote(sentencias, () => {
			medidas.aplazadas++;
			return alAplazar();
		});
	};
	const abrir = hub.withTenantDbRetry.bind(hub);
	hub.withTenantDbRetry = (tenantId: string, run: (db: any) => Promise<unknown>) =>
		abrir(tenantId, (base: any) =>
			run({
				...base,
				async batch(sentencias: any[], modo?: string) {
					if (falla(sentencias)) throw raro();
					return base.batch(sentencias, modo);
				},
			}),
		);
}

// ---- Lo que queda ------------------------------------------------------------------------------

async function sha(texto: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SOLO_DE_LA_NUBE = new Set(["Applied_Operations", "Sync_Changes", "Sync_Main_Checkpoints", "Intentos_Login"]);

/** La huella de cada tabla de negocio: sus filas, ordenadas. */
async function huellas(sql: any): Promise<Record<string, string>> {
	const tablas: string[] = sql
		.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;")
		.toArray()
		.map((f: any) => String(f.name))
		.filter((t: string) => !t.startsWith("_") && !t.startsWith("sqlite_") && !SOLO_DE_LA_NUBE.has(t));
	const salida: Record<string, string> = {};
	for (const t of tablas) {
		const filas = (Array.from(sql.exec(`SELECT * FROM "${t}";`).raw()) as unknown[][]).map((f) => JSON.stringify(f));
		filas.sort();
		salida[t] = `${filas.length}:${await sha(filas.join("\n"))}`;
	}
	return salida;
}

type Resultado = {
	tablas: Record<string, string>;
	/**
	 * Los días que han apuntado los triggers del resumen de las estadísticas (§17 de `0001`), que
	 * saltan dentro de la transacción de cada operación: lo que se deshace no deja su marca.
	 */
	diasSucios: string[];
	/** Los `Op_Id` del log, en orden de `Seq`, y la huella de sus sentencias en ese orden. */
	log: string[];
	sentencias: string;
	/** Lo que la nube contestó de cada operación, sin repeticiones seguidas. */
	historias: Record<string, string[]>;
	/** Los `Op_Id` difundidos por primera vez, en el orden en que salieron. */
	difundidos: string[];
	medidas: Medidas;
};

function clase(v: any): string {
	if (v.ok) return "aplicada";
	if (v.noIntentada) return "sin intentar";
	if (v.permanente) return `permanente: ${v.error}`;
	if (v.transitorio) return `pasajera: ${v.error}`;
	return `desconocida: ${v.error}`;
}

/** Apunta un veredicto. Lo que no se llegó a intentar no cuenta, ni repetir lo que ya se sabía. */
function anotar(historias: Record<string, string[]>, v: any): void {
	const c = clase(v);
	if (c === "sin intentar") return;
	const h = (historias[v.opId] ??= []);
	if (h[h.length - 1] !== c) h.push(c);
}

async function recoger(m: MainEnElHub, historias: Record<string, string[]>, medidas: Medidas): Promise<Resultado> {
	const filas = m.sql.exec("SELECT Op_Id, Statements_Json FROM Sync_Changes ORDER BY Seq;").toArray() as any[];
	const vistos = new Set<string>();
	const difundidos = m
		.difundidos()
		.filter((d) => !vistos.has(d.opId) && vistos.add(d.opId))
		.map((d) => d.opId);
	return {
		tablas: await huellas(m.sql),
		diasSucios: m.sql
			.exec("SELECT Dia FROM _Estad_Dias_Sucios ORDER BY Dia;")
			.toArray()
			.map((f: any) => String(f.Dia)),
		log: filas.map((f) => String(f.Op_Id)),
		sentencias: await sha(filas.map((f) => String(f.Statements_Json)).join("\n")),
		historias,
		difundidos,
		medidas,
	};
}

// ---- Las tres formas de subir ------------------------------------------------------------------

/** (A) De una en una, cada una en su lote: se insiste en la que falla sin ser permanente. */
async function deUnaEnUna(m: MainEnElHub, ops: OpDelOutbox[], historias: Record<string, string[]>): Promise<void> {
	for (const op of ops) {
		for (let intento = 0; ; intento++) {
			if (intento > 3) throw new Error(`${op.opId} no entra`);
			const acuse = await m.mandarLote([op]);
			expect(acuse.ok, JSON.stringify(acuse).slice(0, 300)).toBe(true);
			const v = acuse.resultados[0];
			anotar(historias, v);
			if (v.ok || v.permanente) break;
		}
	}
}

/** Lo que hace la Main con un acuse: cuántas de las primeras del lote dejan de estar pendientes. */
function resueltas(lote: OpDelOutbox[], acuse: any, historias: Record<string, string[]>): number {
	expect(acuse.ok, JSON.stringify(acuse).slice(0, 300)).toBe(true);
	const porId = new Map<string, any>(acuse.resultados.map((r: any) => [r.opId, r]));
	expect(acuse.resultados.map((r: any) => r.opId)).toEqual(lote.map((o) => o.opId));
	let n = 0;
	let parada = false;
	for (const op of lote) {
		const v = porId.get(op.opId);
		anotar(historias, v);
		if (parada) {
			// Detrás de la que para el lote no se ha tocado nada.
			expect(v, op.opId).toEqual({ opId: op.opId, ok: false, noIntentada: true });
			continue;
		}
		if (v.ok || v.permanente) n++;
		else parada = true;
	}
	return n;
}

/**
 * Como `replicacion.rs::cortar`: hasta 200 operaciones y 256 KB de sentencias; la que no cabe se
 * queda para el lote siguiente, salvo que vaya sola.
 */
function corteDeLaMain(pendientes: OpDelOutbox[]): OpDelOutbox[] {
	const lote: OpDelOutbox[] = [];
	let bytes = 0;
	for (const op of pendientes.slice(0, MAX_OPS)) {
		const n = JSON.stringify(op.command.payload.steps.map(({ sql, args }) => ({ sql, args }))).length;
		if (lote.length && bytes + n > MAX_BYTES) break;
		bytes += n;
		lote.push(op);
	}
	return lote;
}

async function medido(m: MainEnElHub, lote: OpDelOutbox[], medidas: Medidas): Promise<any> {
	const t0 = performance.now();
	const acuse = await m.mandarLote(lote);
	const ms = performance.now() - t0;
	medidas.lotes++;
	medidas.ops += lote.length;
	medidas.msTotal += ms;
	if (ms > medidas.msMax) {
		medidas.msMax = ms;
		medidas.opsDelMasLento = lote.length;
	}
	return acuse;
}

/** (B) En lotes, como la Main. */
async function enLotes(
	m: MainEnElHub,
	ops: OpDelOutbox[],
	historias: Record<string, string[]>,
	medidas: Medidas,
): Promise<void> {
	let pendientes = ops;
	for (let vuelta = 0; pendientes.length; vuelta++) {
		if (vuelta > ops.length) throw new Error("la subida no avanza");
		const lote = corteDeLaMain(pendientes);
		pendientes = pendientes.slice(resueltas(lote, await medido(m, lote, medidas), historias));
	}
}

/** Un generador con semilla: el azar de (C) es el mismo en cada pasada. */
function azar(semilla: number): () => number {
	let s = semilla >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x1_0000_0000;
	};
}

/**
 * (C) Lotes de tamaño al azar. Uno de cada cuatro pierde su acuse y se reenvía entero; otro de cada
 * cuatro llega primero cortado (sólo sus primeras operaciones, y ese acuse también se pierde) y
 * después entero. Lo que la nube contestó en los acuses perdidos se apunta igual: es lo que pasó.
 */
async function alAzar(
	m: MainEnElHub,
	ops: OpDelOutbox[],
	historias: Record<string, string[]>,
	medidas: Medidas,
	semilla: number,
): Promise<void> {
	const r = azar(semilla);
	let pendientes = ops;
	for (let vuelta = 0; pendientes.length; vuelta++) {
		if (vuelta > ops.length * 2) throw new Error("la subida no avanza");
		const lote = pendientes.slice(0, 1 + Math.floor(r() * 60));
		const suerte = r();
		if (suerte < 0.25) {
			resueltas(lote, await medido(m, lote, medidas), historias);
		} else if (suerte < 0.5 && lote.length > 1) {
			const cortado = lote.slice(0, 1 + Math.floor(r() * (lote.length - 1)));
			resueltas(cortado, await medido(m, cortado, medidas), historias);
		}
		pendientes = pendientes.slice(resueltas(lote, await medido(m, lote, medidas), historias));
	}
}

// ---- La prueba ---------------------------------------------------------------------------------

async function subir(
	nombre: string,
	como: (m: MainEnElHub, ops: OpDelOutbox[], historias: Record<string, string[]>, medidas: Medidas) => Promise<void>,
): Promise<Resultado> {
	const resultado = await enElHub(nombre, async (hub: any) => {
		const m = await montarMainEnElHub(hub, TENANT);
		sembrar(hub);
		const medidas: Medidas = { lotes: 0, ops: 0, msTotal: 0, msMax: 0, opsDelMasLento: 0, aplazadas: 0 };
		conFallos(hub, medidas);
		hub.__marca = "viva";
		const historias: Record<string, string[]> = {};
		await como(m, operaciones(), historias, medidas);
		return recoger(m, historias, medidas);
	});
	// En otra invocación: el objeto no se ha reseteado por el camino.
	const marca = await enElHub(nombre, (hub: any) => hub.__marca ?? null);
	expect(marca, `${nombre}: el objeto se ha reseteado`).toBe("viva");
	return resultado;
}

function resumen(medidas: Medidas) {
	return {
		lotes: medidas.lotes,
		operacionesMandadas: medidas.ops,
		msPorLoteMedia: Math.round((medidas.msTotal / Math.max(1, medidas.lotes)) * 10) / 10,
		msDelLoteMasLento: Math.round(medidas.msMax * 10) / 10,
		operacionesDelLoteMasLento: medidas.opsDelMasLento,
		msPorOperacion: Math.round((medidas.msTotal / Math.max(1, medidas.ops)) * 1000) / 1000,
		aplazanLasClavesForaneas: medidas.aplazadas,
	};
}

describe("el outbox de un servicio, subido de tres formas", () => {
	it("deja lo mismo de una en una, en lotes y con lotes reenviados o cortados", { timeout: 120_000 }, async () => {
		const total = operaciones().length;
		const a = await subir("repetido-a", (m, ops, historias) => deUnaEnUna(m, ops, historias));
		const b = await subir("repetido-b", enLotes);
		const c1 = await subir("repetido-c1", (m, ops, h, medidas) => alAzar(m, ops, h, medidas, 20261113));
		const c2 = await subir("repetido-c2", (m, ops, h, medidas) => alAzar(m, ops, h, medidas, 7));

		informe.operaciones = total;
		informe.enLotes = resumen(b.medidas);
		informe.alAzar = [resumen(c1.medidas), resumen(c2.medidas)];

		// La referencia hace lo que se espera de ella: todo entra menos lo que tenía que fallar.
		const rechazadas = Object.entries(a.historias).filter(([, h]) => h[h.length - 1] !== "aplicada");
		expect(rechazadas.map(([id]) => id).sort()).toEqual(["op-fk-rota", "op-permanente", "op-sin-hora"]);
		expect(a.historias[DESCONOCIDA]).toEqual(["desconocida: un fallo que nadie ha visto nunca", "aplicada"]);
		expect(a.historias["op-alta-de-lote"]).toEqual(["aplicada"]);
		expect(a.log).toHaveLength(total - 3);
		expect(Object.keys(a.historias)).toHaveLength(total);
		// AUD-18: lo difundido sale en el orden del log.
		expect(a.difundidos).toEqual(a.log);
		// Los cobros del servicio apuntan sus días: los triggers del resumen saltan dentro de los lotes.
		expect(a.diasSucios.length).toBeGreaterThan(0);

		for (const [nombre, otro] of [["en lotes", b], ["al azar (1)", c1], ["al azar (2)", c2]] as const) {
			expect(otro.log, `${nombre}: el orden del log`).toEqual(a.log);
			expect(otro.sentencias, `${nombre}: las sentencias replicadas`).toBe(a.sentencias);
			expect(otro.tablas, `${nombre}: las tablas de negocio`).toEqual(a.tablas);
			expect(otro.diasSucios, `${nombre}: los días que apuntan los triggers de las estadísticas`).toEqual(a.diasSucios);
			expect(otro.historias, `${nombre}: los veredictos`).toEqual(a.historias);
			expect(otro.difundidos, `${nombre}: el orden de la primera difusión`).toEqual(a.log);
		}

		// Lo que un lote tiene que aplazar es lo que se metió para eso: el alta del lote y la FK rota.
		expect(b.medidas.aplazadas).toBe(2);
		expect(b.medidas.lotes).toBeGreaterThanOrEqual(3);
	});
});
