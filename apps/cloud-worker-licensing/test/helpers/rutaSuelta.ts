// test/helpers/rutaSuelta.ts
//
// El doble de `alHub` (`lib/enElHub.ts`) para un test que monta un router suelto.
//
// En producción una ruta de negocio se ejecuta siempre dentro del TenantHub de su negocio: `alHub`
// le pasa la petición entera por RPC. Un test que monta el router solo, con la identidad, la base y
// el motor de mentira (`vi.mock` de `tenantAuth`, de `tenantQuery`, un `TenantHub` con sólo
// `aplicar`…), prueba lo que hace la ruta, no el viaje: declara este doble como el de cualquier otra
// salida, y la ruta corre allí mismo, contra esos dobles.
//
//     vi.mock("../src/lib/enElHub", () => import("./helpers/rutaSuelta"));
//
// El viaje tiene sus propias pruebas, por la `app` entera y el TenantHub de verdad
// (`unViajePorPeticion.test.ts`, `alHubSinElObjeto.test.ts`).

import type { MiddlewareHandler } from "hono";

export const alHub: MiddlewareHandler = async (_c, next) => {
	await next();
};
