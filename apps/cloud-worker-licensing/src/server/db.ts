// src/server/db.ts
//
// La base central del Worker: la de su objeto `BaseCentral` (`durableObjects/baseCentral.ts`), por
// `clienteCentral` (`server/central/cliente.ts`). Lo que tiene que entrar entero va por sus
// operaciones (`getDb(env).operar(…)`, `server/central/operaciones/registro.ts`).

import type { Env } from "../env";
import { centralDe } from "../lib/objetosDelNegocio";
import type { Sql } from "../lib/sql";
import { clienteCentral, type ClienteCentral } from "./central/cliente";

/** La base central. No guarda nada: cada viaje pide su stub (`clienteCentral`). */
export function getDb(env: Pick<Env, "BaseCentral">): ClienteCentral {
	return clienteCentral(() => centralDe(env));
}

export async function exec(db: Sql, sql: string, args: any[] = []) {
	// El `await` no sobra: sin el, esta funcion DEVUELVE la promesa de `execute` en vez de
	// esperarla, y el runtime tarda un par de ticks en adoptarla. En ese hueco un rechazo cuenta
	// como no gestionado —aunque el llamante lo capture—, y workerd lo reporta como unhandled
	// rejection.
	return await db.execute({ sql, args });
}
