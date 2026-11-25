// src/durableObjects/baseCentral.instante.ts
//
// Devolver la base central a un instante de los últimos 30 días, o a un marcador (`instantes.ts`):
// el protocolo de la base de cada negocio (`tenantHub.instante.ts`), en una base sin log de réplica
// que abrir después. Lo lanza la administración (`/v1/admin/central/volver`) en dos llamadas al
// objeto, cada una con su stub:
//
// 1. `prepararVuelta`: cierra la central, saca el marcador del instante (antes de copiar nada: si la
//    plataforma no vuelve a instantes o el instante no vale, no hay copia inútil) y el de cómo está
//    ahora, que es con el que se deshace; deja en R2 una copia de cómo está
//    (`base-central/antes-de-volver-<hora>.sql.gz`), con ese marcador en sus metadatos, y deja la
//    vuelta preparada para el siguiente arranque.
// 2. `reiniciar(deshacer)`: `ctx.abort()`, y al arrancar el objeto vuelve. La llamada falla en quien
//    la hace, y es lo esperado. Sólo reinicia si la vuelta preparada es la que se deshace con
//    `deshacer` (`reiniciarParaAplicar`): el reinicio es de quien la ha preparado, y con otra en curso
//    (preparándose, pidiéndose a la plataforma o preparada) cortaría su preparación o aplicaría
//    una vuelta que no es la suya.
//
// **La marca de vuelta en curso** (`CLAVE_VUELTA_EN_CURSO`) cierra la central desde antes de la copia
// hasta el reinicio: lo que se escribiera entretanto no estaría en la copia de antes y se perdería al
// volver. Volver a un instante anterior se la lleva, porque es de después. Deshacer una vuelta no: el
// marcador de deshacer es el de la central ya cerrada, con la marca puesta. Por eso la
// marca que haya al arrancar ya no dice nada (la vuelta se aplica en el arranque, sea cual sea su
// causa) y se quita entonces (`BaseCentral`).
//
// **También con la central sin atender**: a medio restaurar, con una migración que no entra o sin
// esquema, que es como puede dejarla una vuelta (a un instante de en medio de una restauración, de
// antes de una migración o de antes de aprovisionarla). Deshacerla, o volver a otro instante, es la
// salida, así que no se le exige estar sana. Lo que no se puede es copiarla como una central sana:
// sin esquema no hay qué copiar, y una copia de una restauración a medias parecería buena y le
// faltarían filas. Así que la copia de antes sólo se hace con la central sana, y lo que queda siempre
// de cómo estaba es su marcador (`getCurrentBookmark`), que es con el que se deshace: con él se
// vuelve a ese estado exacto, también al averiado, que es la prueba de lo que pasó.
//
// **El marcador de deshacer queda fuera de la base que se devuelve, antes de pedir la vuelta.** La
// vuelta se lleva todo lo que guarda el objeto, también sus marcas (`storage.kv` vive en una tabla de
// su SQLite, `_cf_KV`, y la vuelta a un instante devuelve el SQLite entero: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api),
// y la respuesta de esta llamada puede no llegar a quien la pidió: la plataforma aplica la vuelta en
// el siguiente arranque, sea cual sea su causa. Así que va en R2: en los metadatos de la copia de
// antes (`marcador`) o, si no se podía copiar, solo, en `base-central/antes-de-volver-<hora>.marcador`
// (`baseCentral.copia.ts`). `pnpm central:copias` lo enseña mientras dura la ventana de 30 días. Si
// pese a todo se perdiera, se deshace volviendo con un instante de justo antes de la vuelta.
//
// **Y que se ha pedido, en cuanto la plataforma la tiene** (`….pedida`, al lado): sin respuesta, una
// vuelta que se ha aplicado y una que no llegó a pedirse dejan la central igual, atendiendo y sin
// marca, y repetir la orden en el primer caso volvería otra vez y se llevaría lo escrito desde
// entonces. Si R2 no la recibe, la vuelta sigue: ya está pedida, y lo que falta es la constancia.
//
// **Una sola preparación a la vez, y la marca es de quien la pone** (`MarcaDeVuelta.id`). La
// plataforma guarda una sola vuelta preparada, la última que se le pide, y no dice cuál es: dos
// preparaciones cruzadas no pueden dejar la central abierta con una vuelta pedida, ni pedir la suya
// encima de la otra sin que se sepa. Así que:
//
// - Una preparación nueva se queda la marca de una que está sacando el marcador o haciendo la copia
//   (`preparando`), y ésa, al ver que ya no es suya, lo deja sin pedir nada a la plataforma ni tocar
//   la marca (`central_vuelta_a_la_vez`). Mientras una se le está pidiendo a la plataforma
//   (`programando`), no entra ninguna otra.
// - Lo que no sale sólo devuelve la marca a como estaba si sigue siendo suya: a la vuelta que ya
//   estaba preparada antes, que sigue en pie (lo que se escribiera se perdería al reiniciar), o a
//   ninguna, y entonces la central vuelve a atender.
// - Repetir la misma orden con la vuelta ya preparada (el reinicio no llegó a pasar) no prepara
//   otra: devuelve la que hay, con su marcador de deshacer y su copia, para reiniciar. A otro destino,
//   prepara otra encima, como una nueva. Pero en cuanto el objeto se reinicia, por lo que sea, la
//   vuelta se aplica y su marca se va, y la misma orden prepararía otra: lo que aplica una vuelta
//   preparada sin volver a pedir nada es el reinicio con su `deshacer` (`reiniciarParaAplicar`), que
//   si ya se ha aplicado no hace nada.

import { capturarError } from "../observability/errors";
import {
	copiarLaCentral,
	claveConHora,
	guardarElMarcadorDeAntes,
	guardarQueSePidio,
	TOPE_COMPRIMIDO,
} from "./baseCentral.copia";
import { CLAVE_VUELTA_EN_CURSO, marcasDe } from "./baseCentral.guardas";
import type {
	DestinoDeLaVuelta,
	FalloDeLaCentral,
	MarcaDeVuelta,
	RespuestaDeLaCentral,
	VueltaPreparada,
} from "./baseCentral.rpc";
import { esInstanteDeLaVentana, esSinVueltaAUnInstante, type Instantes } from "./instantes";
import { baseAprovisionada } from "./sqliteDelObjeto";

/**
 * La vuelta que sigue en pie si la que empieza ahora no sale: la que ya estaba preparada, o la que
 * iba a seguir en pie para la preparación a la que ésta le quita la marca.
 */
function laQueSigueEnPie(actual: MarcaDeVuelta | null): MarcaDeVuelta | null {
	if (!actual) return null;
	return actual.fase === "preparada" ? actual : (actual.anterior ?? null);
}

const otraALaVez = (detalle: string): FalloDeLaCentral => ({ ok: false, error: "central_vuelta_a_la_vez", detalle });

/**
 * La primera mitad de la vuelta (ver la cabecera), esté como esté la central: sana, con la copia de
 * antes; sin atender, sin ella. Una vuelta ya preparada se puede volver a preparar, a otro destino.
 */
export async function prepararVueltaDeLaCentral(
	storage: DurableObjectStorage,
	bucket: R2Bucket,
	instantes: Instantes,
	averiado: Promise<FalloDeLaCentral | null>,
	destino: DestinoDeLaVuelta,
): Promise<RespuestaDeLaCentral<VueltaPreparada>> {
	const averia = await averiado;
	const marcas = marcasDe(storage);
	/** Si se puede copiar como una central sana: aprovisionada, sin avería y sin una restauración a medias. */
	const sana = !marcas.restauracion && !averia && baseAprovisionada(storage.sql);

	const ahora = Date.now();
	if ("instanteMs" in destino && !esInstanteDeLaVentana(destino.instanteMs, ahora)) {
		return { ok: false, error: "central_instante_fuera_de_plazo" };
	}
	const adonde = "marcador" in destino ? destino.marcador : new Date(destino.instanteMs).toISOString();

	const actual = marcas.vuelta;
	if (actual?.fase === "preparada" && actual.destino === adonde && actual.preparada) {
		return { ok: true, valor: actual.preparada };
	}
	if (actual?.fase === "programando") {
		return otraALaVez(`Se le está pidiendo a la plataforma la vuelta a ${actual.destino}.`);
	}

	const id = crypto.randomUUID();
	const anterior = laQueSigueEnPie(actual);
	const marca: MarcaDeVuelta = { id, destino: adonde, desdeMs: ahora, fase: "preparando", anterior };
	storage.kv.put(CLAVE_VUELTA_EN_CURSO, marca);
	/** ¿Sigue siendo suya la marca? Otra preparación ha podido quedársela mientras ésta esperaba. */
	const esMia = () => marcasDe(storage).vuelta?.id === id;
	const sinLaMarca = () => otraALaVez(`Otra vuelta ha empezado mientras se preparaba la vuelta a ${adonde}, y es la que sigue.`);
	/** Si no sale, y la marca sigue siendo suya: la vuelta que sigue en pie, o ninguna. */
	const reabrir = () => {
		if (!esMia()) return;
		if (anterior) storage.kv.put(CLAVE_VUELTA_EN_CURSO, anterior);
		else storage.kv.delete(CLAVE_VUELTA_EN_CURSO);
	};

	let marcador: string;
	try {
		marcador = "marcador" in destino ? destino.marcador : await instantes.marcadorDe(destino.instanteMs);
	} catch (error) {
		reabrir();
		if (esSinVueltaAUnInstante(error)) return { ok: false, error: "central_vuelta_no_disponible" };
		throw error;
	}
	if (!esMia()) return sinLaMarca();

	// Con qué se deshace: el marcador de cómo está, con la central ya cerrada. Lo escrito antes de
	// cerrarla se confirma primero, para que el marcador lo lleve.
	let deshacer: string;
	try {
		await storage.sync();
		deshacer = await instantes.marcadorActual();
	} catch (error) {
		reabrir();
		if (esSinVueltaAUnInstante(error)) return { ok: false, error: "central_vuelta_no_disponible" };
		throw error;
	}
	if (!esMia()) return sinLaMarca();

	// Fuera de la base que se devuelve, y antes de pedir la vuelta: con qué se deshace (ver la cabecera).
	let copiaDeAntes: string | null = null;
	try {
		if (sana) {
			const copia = await copiarLaCentral(storage.sql, bucket, claveConHora("antes-de-volver", new Date(ahora)), TOPE_COMPRIMIDO, deshacer);
			copiaDeAntes = copia.clave;
		} else {
			await guardarElMarcadorDeAntes(bucket, new Date(ahora), deshacer);
		}
	} catch (error) {
		reabrir();
		return { ok: false, error: "central_copia_fallida", detalle: String((error as Error)?.message ?? error) };
	}
	if (!esMia()) return sinLaMarca();

	storage.kv.put(CLAVE_VUELTA_EN_CURSO, { ...marca, fase: "programando" } satisfies MarcaDeVuelta);
	try {
		await instantes.restaurarAlReiniciar(marcador);
	} catch (error) {
		reabrir();
		if (esSinVueltaAUnInstante(error)) return { ok: false, error: "central_vuelta_no_disponible" };
		throw error;
	}
	// Que la plataforma ya la tiene, al lado de con qué se deshace (ver la cabecera).
	try {
		await guardarQueSePidio(bucket, new Date(ahora), deshacer);
	} catch (error) {
		capturarError(error, "central.vuelta_pedida");
	}
	const preparada: VueltaPreparada = { marcador, deshacer, copiaDeAntes };
	storage.kv.put(CLAVE_VUELTA_EN_CURSO, { ...marca, fase: "preparada", preparada, anterior: null } satisfies MarcaDeVuelta);
	return { ok: true, valor: preparada };
}

/**
 * La segunda mitad de la vuelta (ver la cabecera): reinicia el objeto, que al arrancar vuelve, sólo
 * si la vuelta en curso es la preparada que se deshace con `deshacer`. Con otra en curso, o sin
 * ninguna, no lo reinicia y dice por qué. Si lo reinicia, no vuelve: lanza en quien lo ha llamado.
 */
export function reiniciarParaAplicar(
	storage: DurableObjectStorage,
	instantes: Instantes,
	deshacer: string,
): RespuestaDeLaCentral<null> {
	const vuelta = marcasDe(storage).vuelta;
	if (!vuelta) return { ok: false, error: "central_sin_vuelta_preparada" };
	if (vuelta.fase !== "preparada" || vuelta.preparada?.deshacer !== deshacer) {
		const como = vuelta.fase === "preparada" ? "preparada" : "preparándose";
		return otraALaVez(`La vuelta en curso es otra: la vuelta a ${vuelta.destino}, ${como}.`);
	}
	instantes.reiniciar("central_devuelta");
	return { ok: true, valor: null };
}
