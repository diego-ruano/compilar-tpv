// src/durableObjects/tenantHub.restaurar.ts
//
// DO-PERDIDA · Devolver a un TenantHub vacío la base de su copia diaria de R2 (DO-03,
// `tenantHub.copia.ts`), con el cargador que comparte con la base central (`cargaDeCopias.ts`).
//
// Lo propio de la base de un negocio: la copia sólo puede traer tablas del negocio
// (`esTablaDeNegocio`, la misma lista que el volcado), y antes de cargarla la base se pone entera, con
// todas las migraciones de este worker y el sello del negocio (`prepararBase`, que da quien llama):
// las filas de una copia de un esquema anterior entran en las tablas de hoy.
//
// Quien llama (`MotorTenantHub.restaurarDesdeCopia`) tiene la base cerrada a todo lo demás mientras
// tanto, porque el cargador espera a la red entre lote y lote; si algo falla, la vacía otra vez.

import { esTablaDeNegocio } from "../domains/sync/bootstrap.ventana";
import { MIGRATIONS } from "../server/tenantMigrations";
import { cargarCopia, type CopiaCargada } from "./cargaDeCopias";

/**
 * Carga una copia de la base del negocio. `prepararBase` pone el esquema (las migraciones y el
 * sello). Lanza `CopiaInservible` si la copia no vale.
 */
export function cargarCopiaDelNegocio(
	storage: DurableObjectStorage,
	lineas: AsyncIterable<string>,
	prepararBase: () => Promise<void>,
): Promise<CopiaCargada> {
	return cargarCopia(storage, lineas, {
		migraciones: MIGRATIONS.map((m) => m.name),
		esTablaDeLaCopia: esTablaDeNegocio,
		prepararBase,
	});
}
