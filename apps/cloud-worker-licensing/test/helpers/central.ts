// test/helpers/central.ts
//
// Una base central de verdad para un test: un objeto `BaseCentral` propio y el cliente con el que le
// habla el worker (`clienteCentral`). El objeto de producción se pide siempre con el mismo nombre
// (`centralDe`); aquí cada test lo pide con el suyo, así que uno sin nombre recibe una base nueva y
// vacía, y dos que compartan nombre comparten base.

import { env } from "cloudflare:test";

import type { BaseCentral } from "../../src/durableObjects/baseCentral";
import { clienteCentral, type ClienteCentral } from "../../src/server/central/cliente";

type CentralDePrueba = { db: ClienteCentral; stub: DurableObjectStub<BaseCentral> };

/** Un nombre que no ha usado nadie: una base nueva. */
function nombreNuevo(): string {
	return `central-de-prueba-${crypto.randomUUID()}`;
}

/**
 * El objeto `nombre`, tal como esté: sin aprovisionar si nadie lo ha hecho. El cliente pide un stub
 * nuevo en cada viaje, como el de producción.
 */
export function centralSinAprovisionar(nombre: string = nombreNuevo()): CentralDePrueba {
	const id = env.BaseCentral.idFromName(nombre);
	const pedirStub = () => env.BaseCentral.get(id);
	return { db: clienteCentral(pedirStub), stub: pedirStub() };
}

/** El objeto `nombre`, aprovisionado: con el esquema de sus migraciones. */
export async function centralDePrueba(nombre: string = nombreNuevo()): Promise<CentralDePrueba> {
	const central = centralSinAprovisionar(nombre);
	if (!(await central.stub.estado()).aprovisionada) {
		const aprovisionada = await central.stub.aprovisionar();
		if (!aprovisionada.ok) {
			throw new Error(`No se ha podido aprovisionar la central de prueba: ${aprovisionada.error} ${aprovisionada.detalle ?? ""}`);
		}
	}
	return central;
}
