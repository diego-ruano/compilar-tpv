// src/lib/objetosDelNegocio.ts
//
// De dónde sale el Durable Object de un negocio: su `TenantHub` y su `AgendaWeb`.
//
// Un DO nace cerca de quien lo llama por primera vez y ahí se queda, con sus datos: la base del
// negocio (el `TenantHub`) y lo que espera a la Main de las reservas web (la `AgendaWeb`). Quien
// llama primero puede estar en cualquier sitio —el visitante de una web que reserva desde otro
// continente, por ejemplo—, así que **todo el que pide el objeto de un negocio pasa por aquí**
// (`hubDe`, `agendaDe`), que aplica siempre lo mismo:
//
// - **Sin jurisdicción** (`JURISDICCION_DO` vacía). Lo decidió el responsable, por latencia: dentro
//   de `eu` el objeto nace en un centro de la UE que no se elige y la pista de región no se respeta
//   (medido con `/v1/admin/diagnostico/latencias`).
// - **Con pista de región** (`UBICACION_DO = "weur"`, Europa occidental). Sólo cuenta en la primera
//   llamada, la que crea el objeto, y es una pista: Cloudflare la sigue cuando puede. Por eso va en
//   todas: nadie sabe cuál va a ser la primera.
//
// ⚠️ Son dos cosas distintas. La jurisdicción es parte de la identidad: el mismo nombre da OTRO
// objeto en otra jurisdicción, así que quien lo pidiera con otra hablaría con uno vacío, sin fallar,
// y cambiar `JURISDICCION_DO` con negocios dados de alta es empezar de cero. La pista no cambia de
// qué objeto se habla, sólo dónde se crea si esa llamada es la primera: quien lo pidiera sin ella
// podría crearlo lejos, y hoy un objeto no se muda después de creado.
//
// En local y en los tests las dos van vacías: workerd no implementa jurisdicciones («Jurisdiction
// restrictions are not implemented in workerd»).

import type { Env } from "../env";

/** Dónde nace un objeto: su jurisdicción, si la lleva, y la pista de región. */
export type Colocacion = {
	jurisdiccion?: DurableObjectJurisdiction;
	pista?: DurableObjectLocationHint;
};

/** Lo que dice el despliegue (`wrangler.json`). Vacío es «sin»: ni jurisdicción ni pista. */
export function colocacionDelDespliegue(env: Pick<Env, "JURISDICCION_DO" | "UBICACION_DO">): Colocacion {
	return {
		jurisdiccion: (env.JURISDICCION_DO || undefined) as DurableObjectJurisdiction | undefined,
		pista: (env.UBICACION_DO || undefined) as DurableObjectLocationHint | undefined,
	};
}

/**
 * El objeto `nombre` de un espacio de nombres, colocado donde se diga. Sólo lo llama directamente
 * la ruta de diagnóstico, que compara colocaciones con objetos de usar y tirar; lo demás, por
 * `objetoDelNegocio`.
 */
export function objetoEn<T extends Rpc.DurableObjectBranded | undefined>(
	espacio: DurableObjectNamespace<T>,
	nombre: string,
	donde: Colocacion,
): DurableObjectStub<T> {
	const ns = donde.jurisdiccion ? espacio.jurisdiction(donde.jurisdiccion) : espacio;
	const id = ns.idFromName(nombre);
	return donde.pista ? ns.get(id, { locationHint: donde.pista }) : ns.get(id);
}

/** El objeto de un negocio en `espacio` (`env.TenantHub`, `env.AgendaWeb`), como lo coloca el despliegue. */
export function objetoDelNegocio<T extends Rpc.DurableObjectBranded | undefined>(
	env: Pick<Env, "JURISDICCION_DO" | "UBICACION_DO">,
	espacio: DurableObjectNamespace<T>,
	tenantId: string,
): DurableObjectStub<T> {
	return objetoEn(espacio, tenantId, colocacionDelDespliegue(env));
}
