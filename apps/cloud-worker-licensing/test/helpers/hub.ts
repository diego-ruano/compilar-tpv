// test/helpers/hub.ts
//
// Ejecutar código dentro de la instancia real del TenantHub es lo que permite probar sus
// métodos privados contra el mismo objeto que corre en producción. Los tres sitios que lo
// hacían repetían el mismo preámbulo (namespace → id → stub), así que vive aquí.

import { env, runInDurableObject } from "cloudflare:test";

// `runInDurableObject` está declarado como `<O extends DurableObject | Rpc.DurableObject, R>`.
// El binding `TenantHub` no lleva parámetro de tipo, así que `O` cae a esa unión y tsc aborta
// (TS2589) expandiendo el stub RPC de todos sus métodos. No hay tipo que darle —
// `DurableObjectStub<any>` explota igual—, de modo que aquí se aplana la firma una sola vez.
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
	return (await ejecutar(stub, callback)) as R;
}
