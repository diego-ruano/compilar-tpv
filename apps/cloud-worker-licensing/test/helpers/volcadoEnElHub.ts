// test/helpers/volcadoEnElHub.ts
//
// Las rutas de sync que vuelcan la base la leen del cursor del SQLite del Durable Object, y sólo
// dentro del TenantHub de su negocio (`domains/sync/volcado.ts::lectorDe`, que fuera lanza). Un test
// que monta el router de sync suelto la ejecuta aquí: dentro de `dentroDelHub`, con el `SqlStorage`
// del DO en el que corre el test.

import { dentroDelHub } from "../../src/lib/hubLocal";

/**
 * Hace la petición con la ruta dentro del TenantHub de `tenantId`, cuya base es `sql`, y devuelve su
 * estado y su cuerpo.
 *
 * La base sólo se ofrece en bruto: si un volcado pidiera el cliente (un objeto por fila), el test
 * falla ahí. Lo que la ruta lea por `tenantQuery` lo contesta el doble del test.
 */
export async function pedirEnElHub(
	pedir: () => Response | Promise<Response>,
	sql: unknown,
	tenantId = "t1",
): Promise<{ status: number; body: any }> {
	const res = await dentroDelHub(
		{
			// Los volcados son de la Main: dentro del TenantHub el veto de rol decide con éste.
			identidad: { tenantId, deviceId: "d1", token: "", licHash: "", rol: "tpv" },
			base: async () => {
				throw new Error("dentro del TenantHub un volcado lee del cursor, no del cliente");
			},
			sql: async () => sql as SqlStorage,
			aplicar: async () => {
				throw new Error("un volcado no escribe");
			},
			estaAprovisionado: () => true,
			aprovisionar: async () => {
				throw new Error("un volcado no da de alta la base");
			},
		},
		async () => {
			const r = await pedir();
			return { status: r.status, texto: await r.text() };
		},
	);
	return { status: res.status, body: JSON.parse(res.texto) };
}
