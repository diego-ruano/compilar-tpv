// src/lib/enSegundoPlano.ts
//
// Lo que una ruta deja corriendo después de contestar: un evento a Axiom, un aviso, un correo.

/**
 * Mantiene viva `promesa` más allá de la respuesta: el runtime de Workers cancela lo que quede
 * pendiente sin `waitUntil` (`observability/axiom.ts`). Sin contexto de ejecución (los tests),
 * `executionCtx` lanza: perderla no puede tumbar la respuesta.
 */
export function enSegundoPlano(c: { executionCtx: Pick<ExecutionContext, "waitUntil"> }, promesa: Promise<unknown>): void {
	try {
		c.executionCtx.waitUntil(promesa);
	} catch {
		void promesa;
	}
}
