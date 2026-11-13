// test/helpers/dosCaminos.ts
//
// Las rutas de sync que vuelcan la base la leen de dos formas (`domains/sync/volcado.ts`): del
// cursor del SQLite del Durable Object cuando la ruta se ejecuta dentro del TenantHub, que es como
// corre desplegada, y por `tenantQuery` cuando se ejecuta en el Worker. Lo que contestan tiene que
// ser lo mismo, byte a byte: aquí se pide por los dos caminos y se exige.

import { expect, vi } from "vitest";

import { dentroDelHub } from "../../src/lib/hubLocal";

async function leer(res: Response): Promise<{ status: number; texto: string }> {
	return { status: res.status, texto: await res.text() };
}

/**
 * Hace la misma petición con la ruta en el Worker y con la ruta dentro del TenantHub de `tenantId`
 * (cuya base es `sql`), comprueba que las dos respuestas son idénticas y devuelve una.
 *
 * Dentro del TenantHub la base sólo se ofrece en bruto: si un volcado pidiera el cliente (un objeto
 * por fila), el test falla ahí.
 *
 * Las dos peticiones ven el mismo reloj. Sin `X-Client-Now` la ventana sale de la hora del
 * servidor, y pedidas a un lado y a otro de un cambio de segundo las respuestas se diferenciarían
 * en eso y en nada más.
 */
export async function pedirPorLosDosCaminos(
	pedir: () => Response | Promise<Response>,
	sql: unknown,
	tenantId = "t1",
): Promise<{ status: number; body: any }> {
	const relojParado = !vi.isFakeTimers();
	if (relojParado) vi.useFakeTimers({ toFake: ["Date"] });
	try {
		const enElWorker = await leer(await pedir());
		const enElTenantHub = await dentroDelHub(
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
			async () => leer(await pedir()),
		);

		expect(
			enElTenantHub,
			"la ruta contesta distinto dentro del TenantHub que en el Worker",
		).toEqual(enElWorker);
		return { status: enElWorker.status, body: JSON.parse(enElWorker.texto) };
	} finally {
		if (relojParado) vi.useRealTimers();
	}
}
