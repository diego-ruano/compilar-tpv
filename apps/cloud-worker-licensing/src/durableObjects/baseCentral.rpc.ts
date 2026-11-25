// src/durableObjects/baseCentral.rpc.ts
//
// Lo que cruza el RPC de la `BaseCentral`: lo que se le manda y lo que contesta. Lo usan el objeto
// (`baseCentral.ts`) y quien le habla desde el Worker (`server/central/cliente.ts` y la
// administración, `domains/admin/central.ts`).

import type { Valor } from "../lib/sql";

/** Una sentencia con sus argumentos ya convertidos (`server/central/enlace.ts`). */
export type SentenciaEnlazada = { sql: string; args: Valor[] };

/**
 * Por qué la central no ha hecho lo que se le pedía. Viaja como resultado y no como excepción: quien
 * llama lo distingue por su código, nunca por el texto de un error, y el objeto no lo cuenta como un
 * fallo suyo (una restricción violada es asunto de quien escribe, que lo recibe y decide).
 */
export type CodigoDeLaCentral =
	/** Una sentencia ha fallado (una restricción, una columna que no existe…): no ha escrito nada. */
	| "central_error_sql"
	/** Una operación ha lanzado: no ha escrito nada. */
	| "central_operacion_fallida"
	/** El objeto no tiene esquema: nadie lo ha aprovisionado, o se le ha pedido con otro nombre. */
	| "central_sin_aprovisionar"
	/** `aprovisionar` en un objeto que ya tiene esquema. */
	| "central_ya_aprovisionada"
	/** Una sentencia que la central no ejecuta (`baseCentral.guardas.ts`). */
	| "central_sentencia_prohibida"
	/** Una operación que este objeto no conoce: un despliegue a medias. */
	| "central_operacion_desconocida"
	/** Una migración ya aplicada ha cambiado: el objeto no atiende hasta que se arregle. */
	| "central_migracion_alterada"
	/** Una migración no ha podido aplicarse: el objeto no atiende hasta que se arregle. */
	| "central_migracion_fallida"
	/** Una copia no ha llegado a R2 (`baseCentral.copia.ts`): no ha subido nada. */
	| "central_copia_fallida"
	/**
	 * Una restauración desde una copia que no ha terminado (`baseCentral.restaurar.ts`): sus filas
	 * están a medias, y el objeto no atiende hasta que otra restauración lo vacíe y termine.
	 */
	| "central_restauracion_a_medias"
	/**
	 * La copia no se puede restaurar (no existe, está rota o cortada, es de otra versión…): el objeto
	 * se ha quedado como estaba, sin aprovisionar. El detalle dice por qué.
	 */
	| "central_copia_inservible"
	/** La vuelta a un instante está preparada y el objeto no se ha reiniciado: no atiende (`baseCentral.instante.ts`). */
	| "central_vuelta_en_curso"
	/**
	 * Otra vuelta a un instante se estaba preparando a la vez, y sólo sigue una: o se la estaba pidiendo
	 * a la plataforma, o se ha quedado la marca mientras ésta esperaba (`baseCentral.instante.ts`).
	 */
	| "central_vuelta_a_la_vez"
	/** Volver a un instante del futuro o de hace más de 30 días. */
	| "central_instante_fuera_de_plazo"
	/** La plataforma no devuelve objetos a un instante (en local no existe). */
	| "central_vuelta_no_disponible";

export type FalloDeLaCentral = { ok: false; error: CodigoDeLaCentral; detalle?: string };

export type RespuestaDeLaCentral<T> = { ok: true; valor: T } | FalloDeLaCentral;

/** La marca de una restauración desde una copia que ha empezado (`baseCentral.restaurar.ts`). */
export type MarcaDeRestauracion = { clave: string; desdeMs: number };

/**
 * La marca de una vuelta a un instante, desde que empieza a prepararse hasta que el objeto se
 * reinicia (`baseCentral.instante.ts`). Hay una sola, y es de la preparación que la ha puesto (`id`):
 * sólo ella la cambia o la quita.
 */
export type MarcaDeVuelta = {
	/** De qué preparación es. */
	id: string;
	/** Adónde vuelve: el marcador, o el instante en ISO. */
	destino: string;
	desdeMs: number;
	/**
	 * - `preparando`: saca el marcador y deja la copia de antes. Otra preparación puede quedarse con
	 *   la marca, y ésta lo deja.
	 * - `programando`: se le está pidiendo a la plataforma. Ninguna otra entra.
	 * - `preparada`: la plataforma la tiene, y se aplica en el siguiente arranque.
	 */
	fase: "preparando" | "programando" | "preparada";
	/** Ya preparada, lo que contestó: lo que se devuelve si se repite la misma orden. */
	preparada?: VueltaPreparada;
	/** La vuelta que ya estaba preparada cuando empezó ésta: si ésta no sale, es la que sigue en pie. */
	anterior?: MarcaDeVuelta | null;
};

/** Lo que el objeto tiene a medias. Mientras haya algo, no atiende. */
export type MarcasDeLaCentral = { restauracion: MarcaDeRestauracion | null; vuelta: MarcaDeVuelta | null };

/** Cómo está el objeto (administración). */
export type EstadoDeLaCentral = {
	aprovisionada: boolean;
	migraciones: { nombre: string; hash: string; aplicadaMs: number }[];
	/**
	 * Por qué no atiende, si no atiende: algo a medias (`enCurso`), o una migración que no ha podido
	 * aplicar al arrancar o al aprovisionarlo.
	 */
	averia: FalloDeLaCentral | null;
	enCurso: MarcasDeLaCentral;
	/** Las filas de cada tabla. Vacío sin aprovisionar o con algo a medias: no se cuentan filas a medias. */
	filas: Record<string, number>;
	/** Lo que ocupa la base, en bytes (`databaseSize`). */
	bytes: number;
};

/** Lo que entró de una copia al restaurarla. */
export type CopiaRestaurada = { clave: string; filas: number; tablas: number };

/** Cómo queda el objeto al aprovisionarlo: su estado y, si se restauró de una copia, lo que entró. */
export type CentralAprovisionada = EstadoDeLaCentral & { copia: CopiaRestaurada | null };

/** A qué se vuelve: un instante de los últimos 30 días, o un marcador (el `deshacer` de otra vuelta). */
export type DestinoDeLaVuelta = { instanteMs: number } | { marcador: string };

/** Lo que deja preparado la primera mitad de la vuelta a un instante (`prepararVuelta`). */
export type VueltaPreparada = {
	/** El marcador al que vuelve. */
	marcador: string;
	/** El marcador de cómo estaba la central al prepararla (`getCurrentBookmark`): volver a él la deshace. */
	deshacer: string;
	/**
	 * La copia de cómo estaba la central antes de volver, en R2. `null` si no se podía copiar como una
	 * central sana: sin esquema, con una restauración a medias o con una migración que no entra.
	 */
	copiaDeAntes: string | null;
};
