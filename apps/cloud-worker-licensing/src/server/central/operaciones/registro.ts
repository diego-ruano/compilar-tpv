// src/server/central/operaciones/registro.ts
//
// Las operaciones de la base central: lo que lee, decide y escribe en más de una sentencia y tiene
// que entrar entero o no entrar. Cada una corre dentro de su objeto, en una sola transacción
// (`durableObjects/baseCentral.operar.ts`), y se pide por su nombre (`ClienteCentral.operar`).
//
// Una operación es SÍNCRONA de principio a fin: ni `async`, ni `await`, ni promesas. Una espera
// dentro abriría el objeto a otras llamadas a mitad de la transacción, y lo escrito después de ella
// quedaría fuera. Lo que necesite esperar (una clave que cifrar, un hash) se calcula antes, en el
// Worker, y llega en sus datos.
//
// Lo que devuelve es un dato, que vuelve por el RPC: `null`, booleanos, números, textos,
// `ArrayBuffer`, y arrays y objetos literales de datos (una fila de un `Resultado` también lo es).
// Otra cosa (una instancia de una clase, una función, una fecha) se rechaza, y no queda nada escrito.
//
// Un nombre no cambia nunca de significado: una operación que cambia lleva un nombre nuevo. Durante
// un despliegue, un Worker nuevo puede hablar con el objeto viejo, que contesta
// `central_operacion_desconocida` a lo que no conoce.

import type { SqlSync } from "../../../lib/sql";

/** Una operación de la central: recibe la base, sin esperas, y sus datos, y devuelve su resultado. */
export type Operacion = (sql: SqlSync, datos: unknown) => unknown;

export const OPERACIONES: Readonly<Record<string, Operacion>> = {};
