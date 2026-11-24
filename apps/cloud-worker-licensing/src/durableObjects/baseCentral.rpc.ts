// src/durableObjects/baseCentral.rpc.ts
//
// Lo que cruza el RPC de la `BaseCentral`: lo que se le manda y lo que contesta. Lo usan el objeto
// (`baseCentral.ts`) y quien le habla desde el Worker (`server/central/cliente.ts`).

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
	| "central_migracion_fallida";

export type FalloDeLaCentral = { ok: false; error: CodigoDeLaCentral; detalle?: string };

export type RespuestaDeLaCentral<T> = { ok: true; valor: T } | FalloDeLaCentral;

/** Cómo está el objeto (administración). */
export type EstadoDeLaCentral = {
	aprovisionada: boolean;
	migraciones: { nombre: string; hash: string; aplicadaMs: number }[];
	/** Por qué no atiende, si no atiende: una migración que no ha podido aplicar al arrancar o al aprovisionarlo. */
	averia: FalloDeLaCentral | null;
};
