// test/helpers/hub.ts
//
// Ejecutar código dentro de la instancia real del TenantHub es lo que permite probar sus
// métodos privados contra el mismo objeto que corre en producción. Los tres sitios que lo
// hacían repetían el mismo preámbulo (namespace → id → stub), así que vive aquí.

import { env, runInDurableObject } from "cloudflare:test";

// El binding RPC es tipado; este arnes local accede al campo de instancia del motor
// para inyectar dobles en los helpers privados. Esa instancia no se devuelve por RPC.
const ejecutar = runInDurableObject as unknown as (
	stub: unknown,
	callback: (hub: any) => unknown,
) => Promise<unknown>;

/**
 * Corre `callback` dentro del TenantHub llamado `nombre`.
 *
 * Cada `nombre` es una instancia distinta del Durable Object: los tests que comparten nombre
 * comparten estado, y los que quieren aislamiento piden otro.
 */
export async function enElHub<R>(
	nombre: string,
	callback: (hub: any) => R | Promise<R>,
): Promise<R> {
	const ns = (env as any).TenantHub as DurableObjectNamespace;
	const stub = ns.get(ns.idFromName(nombre));
	return (await ejecutar(stub, (hub) => callback(hub.motor))) as R;
}
