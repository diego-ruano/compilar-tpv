// src/durableObjects/tenantHub.restaurar.ts
//
// DO-PERDIDA · Devolver a un TenantHub vacío la base de su copia diaria de R2 (DO-03,
// `tenantHub.copia.ts`).
//
// La copia es un volcado SQL con una sentencia de datos por línea. Aquí se lee de R2 según llega
// (descomprimida y partida en líneas, sin tenerla entera en memoria), y de ella sólo se ejecutan
// los `INSERT` en tablas del negocio que existen en el esquema: el esquema lo ponen las migraciones
// de este worker, no la copia. Antes de tocar nada se mira que la copia sea de un esquema que este
// worker sabe poner (sus migraciones son un principio de las de aquí), y al acabar, que esté entera
// (su línea de fin, con las mismas filas) y que no haya dejado ninguna clave foránea rota.
//
// Las filas entran con las claves foráneas apagadas, como en las migraciones: la copia va tabla a
// tabla en el orden en que se crearon, no padres primero. Lo comprueba `foreign_key_check` al final.
// Quien llama (`MotorTenantHub.restaurarDesdeCopia`) tiene la base cerrada a todo lo demás mientras
// tanto, porque aquí se espera a la red entre lote y lote; si algo falla, la vacía otra vez.

import { esTablaDeNegocio } from "../domains/sync/bootstrap.ventana";
import { MIGRATIONS } from "../server/tenantMigrations";
import { LINEA_FIN, LINEA_MIGRACIONES, PRINCIPIO_DE_INSERT } from "./tenantHub.copia";
import { ponerFk } from "./tenantHub.sqlite";

/** Lo que se dice de una copia que no se puede devolver, y por qué. Sin datos de la copia. */
export class CopiaInservible extends Error {
	constructor(
		readonly codigo: "copia_de_otra_version" | "copia_cortada" | "copia_no_valida",
		detalle: string,
	) {
		super(`${codigo}: ${detalle}`);
		this.name = "CopiaInservible";
	}
}

/** Cuántas filas entran por transacción. */
const FILAS_POR_LOTE = 500;

/** Las líneas de un gzip, de una en una, según llegan. */
export async function* lineasDe(cuerpo: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const lector = cuerpo
		.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
		.pipeThrough(new TextDecoderStream())
		.getReader();
	let resto = "";
	for (;;) {
		const { value, done } = await lector.read();
		if (done) break;
		const partes = (resto + value).split("\n");
		resto = partes.pop() ?? "";
		yield* partes;
	}
	if (resto) yield resto;
}

/** La tabla de una línea de datos, `INSERT INTO "<tabla>" (`, o `null` si no lo es. */
function tablaDe(linea: string): string | null {
	if (!linea.startsWith(PRINCIPIO_DE_INSERT)) return null;
	const m = /^INSERT INTO "((?:[^"]|"")+)" \(/.exec(linea);
	return m ? m[1].replaceAll('""', '"') : null;
}

export type CopiaCargada = { filas: number; tablas: number };

/**
 * Carga una copia en la base del objeto. `prepararBase` se llama cuando ya se sabe que la copia es
 * de un esquema que este worker pone, y es quien lo pone (las migraciones y el sello). Las tablas
 * del negocio se vacían antes de cargar (las migraciones siembran roles y ajustes, y la copia trae
 * los suyos). Lanza `CopiaInservible` si la copia no vale; la base se queda como la deje.
 */
export async function cargarCopia(
	storage: DurableObjectStorage,
	lineas: AsyncIterable<string>,
	prepararBase: () => Promise<void>,
): Promise<CopiaCargada> {
	const sql = storage.sql;
	const iterador = lineas[Symbol.asyncIterator]();

	// La cabecera: con qué migraciones se hizo. Va antes del esquema.
	let migraciones: string[] | null = null;
	let pendiente: string | null = null;
	for (;;) {
		const { value, done } = await iterador.next();
		if (done) throw new CopiaInservible("copia_cortada", "sin datos");
		if (value.startsWith(LINEA_MIGRACIONES)) {
			migraciones = value.slice(LINEA_MIGRACIONES.length).split(",").filter(Boolean);
			break;
		}
		if (!value.startsWith("--")) {
			pendiente = value;
			break;
		}
	}
	if (!migraciones) throw new CopiaInservible("copia_no_valida", "sin la línea de las migraciones");
	const aqui = MIGRATIONS.map((m) => m.name);
	if (migraciones.length > aqui.length || migraciones.some((m, i) => m !== aqui[i])) {
		throw new CopiaInservible(
			"copia_de_otra_version",
			`la copia tiene ${migraciones.at(-1) ?? "ninguna"} y este worker llega a ${aqui.at(-1)}`,
		);
	}

	await prepararBase();
	const tablas = new Set(
		(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table';").toArray() as { name: string }[])
			.map((f) => String(f.name))
			.filter(esTablaDeNegocio),
	);

	await ponerFk(storage, false);
	try {
		storage.transactionSync(() => {
			for (const t of tablas) sql.exec(`DELETE FROM "${t.replaceAll('"', '""')}";`);
		});

		let filas = 0;
		let fin: number | null = null;
		const llenas = new Set<string>();
		let lote: string[] = [];
		const vaciarLote = () => {
			if (!lote.length) return;
			const sentencias = lote;
			lote = [];
			storage.transactionSync(() => {
				for (const s of sentencias) sql.exec(s);
			});
		};

		const tratar = (linea: string) => {
			if (linea.startsWith(LINEA_FIN)) {
				const m = /^(\d+) filas/.exec(linea.slice(LINEA_FIN.length));
				fin = m ? Number(m[1]) : -1;
				return;
			}
			const tabla = tablaDe(linea);
			if (tabla === null) return;
			if (!tablas.has(tabla)) throw new CopiaInservible("copia_no_valida", `una tabla que no es del negocio: ${tabla}`);
			lote.push(linea);
			llenas.add(tabla);
			filas++;
			if (lote.length >= FILAS_POR_LOTE) vaciarLote();
		};

		if (pendiente !== null) tratar(pendiente);
		for (;;) {
			const { value, done } = await iterador.next();
			if (done) break;
			tratar(value);
		}
		vaciarLote();

		if (fin === null) throw new CopiaInservible("copia_cortada", "le falta la línea del final");
		if (fin !== filas) throw new CopiaInservible("copia_cortada", `dice ${fin} filas y trae ${filas}`);
		const rota = sql.exec("PRAGMA foreign_key_check;").toArray()[0] as { table?: string } | undefined;
		if (rota) throw new CopiaInservible("copia_no_valida", `deja una clave foránea rota en ${rota.table ?? "?"}`);
		return { filas, tablas: llenas.size };
	} finally {
		await ponerFk(storage, true);
	}
}
