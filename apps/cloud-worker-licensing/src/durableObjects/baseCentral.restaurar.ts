// src/durableObjects/baseCentral.restaurar.ts
//
// Devolver la base central de una copia de R2 (`baseCentral.copia.ts`) a un objeto sin aprovisionar:
// `BaseCentral.aprovisionar({ claveDeCopia })`. Es lo que se hace si el objeto se pierde, y el mismo
// camino por el que entra una base que viene de fuera (convertida al formato de la copia y subida a
// `base-central/`). Se carga con el cargador que comparte con la base de cada negocio
// (`cargaDeCopias.ts`).
//
// Lo que no puede pasar nunca es que una central restaurada a medias atienda: contestaría como
// definitivo lo que no lo es («no existe» a una licencia que sí existe, «no vale» a un código que sí
// vale). El TPV no borra su licencia por eso (RI-09: un `license_not_found` sin firmar es
// `RechazoSinFirmar`, `tpv-infra-licensing::clasificar_error`), pero lo cuenta como no haber podido
// comprobar y, al agotar la gracia sin conexión, se bloquea; la Handy no puede trabajar, y el alta, el
// emparejamiento o la reserva web fallarían como si fuera de verdad. Por eso:
//
// - **Nada se intercala.** Quien llama lo hace dentro de `blockConcurrencyWhile`: ninguna otra llamada
//   entra hasta que acaba, tampoco las guardas que reafirman las claves foráneas, que aquí van
//   apagadas mientras entran las filas.
// - **Una marca mientras tanto.** Antes de tocar nada se pone la marca de restauración en curso
//   (`CLAVE_RESTAURACION_EN_CURSO`), y se quita en la misma transacción que da la central por buena.
//   Si el objeto se reinicia a mitad, al arrancar la marca sigue ahí y no atiende
//   (`central_restauracion_a_medias`), ni se pone al día con sus migraciones; la siguiente
//   restauración empieza vaciándolo.
// - **Si falla, como antes.** Lo que falla y se puede capturar vacía el objeto entero (`deleteAll`,
//   que también se lleva el SQL y la marca): queda sin aprovisionar, y se contesta
//   `central_copia_inservible` con el motivo.
//
// El orden: el esquema de la copia (sus migraciones, que tienen que ser un principio de las de aquí),
// sus filas, la comprobación de que está entera y no deja claves foráneas rotas, y SÓLO ENTONCES las
// migraciones que falten. Así una migración que transforme datos transforma también los restaurados.
//
// El límite: `blockConcurrencyWhile` reinicia el objeto si su cuerpo tarda más de 30 s, y la marca lo
// deja sin atender (la siguiente restauración volvería a empezar, y a cortarse). Medido en local, con
// filas como las de la central (licencias, auditoría y correos a partes iguales, con sus ids y sus
// claves al azar, que casi no se comprimen): 50.000 filas, 6 MB comprimidas, tardan unos 2,5 s;
// 150.000, 19 MB, entre 11 y 16 s, y 250.000, 30 MB, unos 29 s. Sólo con correos enviados
// (`email_sends`, la tabla que crece con los negocios), 300.000 filas, 9 MB, tardan unos 23 s, y
// 450.000, 14 MB, 42 s. No crece en línea recta, y lo que manda son las filas, no los bytes: la copia
// admite más de lo que se puede restaurar de una vez. Por eso el cron avisa a Sentry cuando la copia
// del día pasa de `FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ` (`index.ts`), y cuántas filas tiene la central
// lo dice `pnpm central:estado`. Antes de llegar, la carga tiene que partirse en varias llamadas,
// cada una en su `blockConcurrencyWhile` y con la marca puesta entre ellas.

import { capturarError } from "../observability/errors";
import { MIGRACIONES_DE_LA_CENTRAL } from "../server/central/migraciones";
import { CopiaInservible, cargarCopia, lineasDe } from "./cargaDeCopias";
import { esClaveDeCopiaDeLaCentral, esTablaDeLaCopia, NOMBRES_DE_UNA_COPIA } from "./baseCentral.copia";
import { CLAVE_RESTAURACION_EN_CURSO, marcasDe } from "./baseCentral.guardas";
import type { CopiaRestaurada, MarcaDeRestauracion, RespuestaDeLaCentral } from "./baseCentral.rpc";
import { baseAprovisionada, migrarBase } from "./sqliteDelObjeto";

/**
 * Hasta cuántas filas se restaura la central con holgura de una vez: con las filas más caras de lo
 * medido, éstas tardan como mucho la mitad de los 30 s (ver la cabecera).
 */
export const FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ = 150_000;

/** Los nombres de las migraciones de este worker, en orden. */
function nombresDeLasMigraciones(): string[] {
	return MIGRACIONES_DE_LA_CENTRAL.map((m) => m.name);
}

/**
 * Las líneas de la copia, con un gzip que no se deja leer convertido en `CopiaInservible`. Una línea
 * demasiado larga ya lo es (`lineasDe`), y sale tal cual.
 */
async function* leyendoElGzip(lineas: AsyncIterable<string>): AsyncGenerator<string> {
	try {
		yield* lineas;
	} catch (error) {
		if (error instanceof CopiaInservible) throw error;
		throw new CopiaInservible("copia_no_valida", `no se puede descomprimir: ${String((error as Error)?.message ?? error)}`);
	}
}

/**
 * Restaura la central desde la copia `clave` de `bucket`, en un objeto sin aprovisionar (o con una
 * restauración a medias, que se vacía antes). En uno aprovisionado no toca nada. Quien llama lo hace
 * dentro de `blockConcurrencyWhile` (ver la cabecera), y no lanza: lo que no ha hecho lo contesta.
 */
export async function restaurarLaCentral(
	storage: DurableObjectStorage,
	bucket: R2Bucket,
	clave: string,
): Promise<RespuestaDeLaCentral<CopiaRestaurada>> {
	// La clave que no tiene la forma de una copia no se repite en el motivo: es texto de quien llama, que
	// puede ser cualquier cosa. La ruta de la administración ya la para con su schema; esto es lo que
	// contesta el objeto a quien lo llame por RPC. La que la tiene ha pasado una gramática cerrada
	// (`esClaveDeCopiaDeLaCentral`), y sí sale: en la marca y en `copia_no_encontrada`.
	if (!esClaveDeCopiaDeLaCentral(clave)) {
		return {
			ok: false,
			error: "central_copia_inservible",
			detalle: `copia_no_valida: la clave no es la de una copia de la central: va como ${NOMBRES_DE_UNA_COPIA}`,
		};
	}
	const marcas = marcasDe(storage);
	if (!marcas.restauracion && baseAprovisionada(storage.sql)) return { ok: false, error: "central_ya_aprovisionada" };

	// De vacío: lo que haya dejado una restauración a medias, o cualquier otra cosa en un objeto sin
	// esquema, no se mezcla con la copia.
	await storage.deleteAll();
	const marca: MarcaDeRestauracion = { clave, desdeMs: Date.now() };
	storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, marca);

	try {
		const objeto = await bucket.get(clave);
		if (!objeto) throw new CopiaInservible("copia_no_encontrada", `no hay ninguna copia ${clave}`);
		const cargada = await cargarCopia(storage, leyendoElGzip(lineasDe(objeto.body)), {
			migraciones: nombresDeLasMigraciones(),
			esTablaDeLaCopia,
			prepararBase: async (deLaCopia) => {
				if (deLaCopia.length === 0) throw new CopiaInservible("copia_no_valida", "no dice con qué migraciones se hizo");
				await migrarBase(storage, MIGRACIONES_DE_LA_CENTRAL.slice(0, deLaCopia.length));
			},
		});

		// Ya entera y sin claves rotas: las migraciones que le faltan, sobre sus datos.
		await migrarBase(storage, MIGRACIONES_DE_LA_CENTRAL);
		const sql = storage.sql;
		storage.transactionSync(() => {
			const aplicadas = sql
				.exec("SELECT name FROM _migrations ORDER BY rowid;")
				.toArray()
				.map((f) => String(f.name));
			if (aplicadas.join(",") !== nombresDeLasMigraciones().join(",")) {
				throw new Error(`La base restaurada se ha quedado en ${aplicadas.at(-1) ?? "ninguna"} y este worker llega a ${nombresDeLasMigraciones().at(-1)}.`);
			}
			storage.kv.delete(CLAVE_RESTAURACION_EN_CURSO);
		});
		return { ok: true, valor: { clave, ...cargada } };
	} catch (error) {
		await storage.deleteAll();
		if (!(error instanceof CopiaInservible)) capturarError(error, "central.restaurar");
		const detalle =
			error instanceof CopiaInservible ? error.message : `no se ha podido cargar: ${String((error as Error)?.message ?? error)}`;
		return { ok: false, error: "central_copia_inservible", detalle };
	}
}
