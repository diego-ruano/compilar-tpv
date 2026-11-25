// test/helpers/hub.ts
//
// Ejecutar código dentro de la instancia real del TenantHub es lo que permite probar sus
// métodos privados contra el mismo objeto que corre en producción. Los tres sitios que lo
// hacían repetían el mismo preámbulo (namespace → id → stub), así que vive aquí.
//
// El hub pide la base central con su propio entorno (`centralDe(env)`, en `getCentralDb` y en las
// rutas que se ejecutan dentro de él), y en los tests ése es el objeto del despliegue, sin
// aprovisionar y compartido por todos los casos del fichero. Una prueba que necesite la central se
// la pone con `{ central }` o con `ponerLaCentral` (`helpers/central.ts`).

import { env, runInDurableObject } from "cloudflare:test";

import type { CentralDePrueba } from "./central";

// El binding RPC es tipado; este arnes local accede al campo de instancia del motor
// para inyectar dobles en los helpers privados. Esa instancia no se devuelve por RPC.
const ejecutar = runInDurableObject as unknown as (
	stub: unknown,
	callback: (hub: any) => unknown,
) => Promise<unknown>;

/**
 * Pone la central `central` detrás del motor `hub`: lo que el hub le pide a la base central (por
 * `getCentralDb`, y en las rutas que se ejecutan dentro, por `getDb`) llega a ese objeto, por su
 * `entorno`, igual que una ruta del Worker. Sólo cambia a qué objeto llega: el cliente, el plazo y el
 * camino son los de producción. Dura lo que esta instancia del objeto (un hub que hiberna o se
 * reinicia vuelve a la del despliegue). Devuelve cómo quitarla, sin tocar lo demás que haya cambiado
 * en el entorno del hub entretanto.
 *
 * Para una prueba que después le habla al hub por RPC, desde fuera de `enElHub`, se le pone y no se
 * le quita: `await enElHub(nombre, (hub) => void ponerLaCentral(hub, central))`.
 */
export function ponerLaCentral(hub: any, central: Pick<CentralDePrueba, "entorno">): () => void {
	const antes = hub.env.BaseCentral;
	hub.env = { ...hub.env, ...central.entorno };
	return () => {
		hub.env = { ...hub.env, BaseCentral: antes };
	};
}

/**
 * Corre `callback` dentro del TenantHub llamado `nombre`. Con `central`, el hub la tiene puesta
 * (`ponerLaCentral`) mientras dura `callback`.
 *
 * Cada `nombre` es una instancia distinta del Durable Object: los tests que comparten nombre
 * comparten estado, y los que quieren aislamiento piden otro.
 */
export async function enElHub<R>(
	nombre: string,
	callback: (hub: any) => R | Promise<R>,
	opciones: { central?: Pick<CentralDePrueba, "entorno"> } = {},
): Promise<R> {
	const ns = (env as any).TenantHub as DurableObjectNamespace;
	const stub = ns.get(ns.idFromName(nombre));
	return (await ejecutar(stub, async (hub) => {
		const motor = hub.motor;
		if (!opciones.central) return callback(motor);
		const quitar = ponerLaCentral(motor, opciones.central);
		try {
			return await callback(motor);
		} finally {
			quitar();
		}
	})) as R;
}
