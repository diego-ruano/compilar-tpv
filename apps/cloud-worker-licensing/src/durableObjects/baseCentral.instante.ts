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
// Si algo falla antes de dejar la vuelta preparada, la central vuelve a atender, salvo que ya hubiera
// otra vuelta preparada de antes: ésa sigue en pie (lo que se escribiera se perdería al reiniciar), y
// su marca, con su destino, vuelve a ser la que se ve.

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

	// La vuelta que ya estuviera preparada, si la hay: si ésta no sale, es la que sigue en pie.
	const anterior = marcas.vuelta;
	const marca: MarcaDeVuelta = {
		destino: "marcador" in destino ? destino.marcador : new Date(destino.instanteMs).toISOString(),
		desdeMs: ahora,
	};
	storage.kv.put(CLAVE_VUELTA_EN_CURSO, marca);
	const reabrir = () => {
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

	let copia: CopiaHecha;
	try {
		copia = await copiarLaCentral(storage.sql, bucket, claveConHora("antes-de-volver", new Date(ahora)));
	} catch (error) {
		reabrir();
		return { ok: false, error: "central_copia_fallida", detalle: String((error as Error)?.message ?? error) };
	}

	let deshacer: string;
	try {
		deshacer = await instantes.restaurarAlReiniciar(marcador);
	} catch (error) {
		reabrir();
		if (esSinVueltaAUnInstante(error)) return { ok: false, error: "central_vuelta_no_disponible" };
		throw error;
	}
	return { ok: true, valor: { marcador, deshacer, copiaDeAntes: copia.clave } };
}
