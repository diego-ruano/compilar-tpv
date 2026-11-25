// src/durableObjects/baseCentral.instante.ts
//
// Devolver la base central a un instante de los últimos 30 días, o a un marcador (`instantes.ts`):
// el protocolo de la base de cada negocio (`tenantHub.instante.ts`), en una base sin log de réplica
// que abrir después. Lo lanza la administración (`/v1/admin/central/volver`) en dos llamadas al
// objeto, cada una con su stub:
//
// 1. `prepararVuelta`: cierra la central, saca el marcador del instante (antes de copiar nada: si la
//    plataforma no vuelve a instantes o el instante no vale, no hay copia inútil), deja en R2 una
//    copia de cómo está (`base-central/antes-de-volver-<hora>.sql.gz`) y deja la vuelta preparada
//    para el siguiente arranque. Devuelve el marcador con el que se deshace.
// 2. `reiniciar`: `ctx.abort()`. La llamada falla siempre, y es lo esperado: al arrancar, el objeto
//    vuelve.
//
// **La marca de vuelta en curso** (`CLAVE_VUELTA_EN_CURSO`) cierra la central desde antes de la copia
// hasta el reinicio: lo que se escribiera entretanto no estaría en la copia de antes y se perdería al
// volver. Volver a un instante anterior se la lleva, porque es de después. Deshacer una vuelta no: el
// marcador de deshacer es el del objeto justo antes de reiniciarse, con la marca puesta. Por eso la
// marca que haya al arrancar ya no dice nada (la vuelta se aplica en el arranque, sea cual sea su
// causa) y se quita entonces (`BaseCentral`).
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
//   prepara otra encima, como una nueva.

import { copiarLaCentral, claveConHora, type CopiaHecha } from "./baseCentral.copia";
import { CLAVE_VUELTA_EN_CURSO, falloPorLasMarcas, marcasDe } from "./baseCentral.guardas";
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
 * La primera mitad de la vuelta (ver la cabecera). Sólo con la central aprovisionada, sin avería y
 * sin una restauración a medias; una vuelta ya preparada se puede volver a preparar, a otro destino.
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
	if (marcas.restauracion) return falloPorLasMarcas(marcas)!;
	if (averia) return averia;
	if (!baseAprovisionada(storage.sql)) return { ok: false, error: "central_sin_aprovisionar" };

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

	let copia: CopiaHecha;
	try {
		copia = await copiarLaCentral(storage.sql, bucket, claveConHora("antes-de-volver", new Date(ahora)));
	} catch (error) {
		reabrir();
		return { ok: false, error: "central_copia_fallida", detalle: String((error as Error)?.message ?? error) };
	}
	if (!esMia()) return sinLaMarca();

	storage.kv.put(CLAVE_VUELTA_EN_CURSO, { ...marca, fase: "programando" } satisfies MarcaDeVuelta);
	let deshacer: string;
	try {
		deshacer = await instantes.restaurarAlReiniciar(marcador);
	} catch (error) {
		reabrir();
		if (esSinVueltaAUnInstante(error)) return { ok: false, error: "central_vuelta_no_disponible" };
		throw error;
	}
	const preparada: VueltaPreparada = { marcador, deshacer, copiaDeAntes: copia.clave };
	storage.kv.put(CLAVE_VUELTA_EN_CURSO, { ...marca, fase: "preparada", preparada, anterior: null } satisfies MarcaDeVuelta);
	return { ok: true, valor: preparada };
}
