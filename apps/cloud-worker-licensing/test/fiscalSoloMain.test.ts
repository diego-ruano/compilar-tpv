// test/fiscalSoloMain.test.ts
//
// FISCAL-01. `Registros_Facturacion` y `Serie_Facturacion` son de la Main y sólo de la Main.
//
// No es la misma clase de regla que `soloLaMainCobra` (que es una decisión de producto): es que la
// nube **no puede fabricar** un registro de facturación. El registro es el hecho fiscal, nace
// dentro de la transacción del cobro y va encadenado por una huella SHA-256 al anterior. La cadena
// vive en el SIF del obligado —el equipo del bar—; aquí se replica para que una Main que pierda su
// `data.db` pueda recuperarla. La nube es copia, no fuente.
//
// Una fila insertada desde la API sería un eslabón que ninguna huella ata a nada, y el `Orden` que
// gastara dejaría a la Main emitiendo por detrás de su propia cadena. Con el contador es más
// directo todavía: un número repartido desde dos sitios acaba en dos facturas con el mismo
// `IDFactura`, que es el error 3000 de la AEAT y un registro que no entra.
//
// El veto vive en `applyViaHub`, que es el camino de la API REST (o sea, el de la Handy): el
// outbox de la Main entra por el WebSocket del DO y no pasa por ahí. Está en el código y no en la
// revisión de quien añada la próxima ruta, que es lo que se olvida.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/internalAuth", () => ({
	signInternalWorkerRequest: async () => ({}),
}));

const { applyViaHub, HubError } = await import("../src/lib/hub");

/** `env` con un TenantHub que registra si LLEGÓ a llamarse. */
function entorno() {
	let llamado = false;
	const env: any = {
		LICENSE_JWT_SECRET: "s",
		TenantHub: {
			idFromName: () => "id",
			get: () => ({
				fetch: async () => {
					llamado = true;
					return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
				},
			}),
		},
	};
	return { env, seLlamo: () => llamado };
}

function aplicar(env: any, command: any) {
	return applyViaHub(env, {
		tenantId: "t1",
		deviceId: "d1",
		opId: "op1",
		commandName: "x",
		command,
	});
}

describe("las tablas fiscales sólo las escribe la Main", () => {
	it("rechaza un INSERT en Registros_Facturacion (exec suelto)", async () => {
		const { env, seLlamo } = entorno();
		await expect(
			aplicar(env, {
				type: "tenantDb.exec",
				payload: { sql: "INSERT INTO Registros_Facturacion (ID_Registro) VALUES (?);", args: ["x"] },
			}),
		).rejects.toMatchObject({ code: "escritura_solo_en_main:Registros_Facturacion", status: 403 });

		// Y no sólo devuelve error: no llega a tocar el DO.
		expect(seLlamo()).toBe(false);
	});

	it("rechaza un UPDATE de Serie_Facturacion escondido en el paso 3 de una transacción", async () => {
		const { env, seLlamo } = entorno();
		await expect(
			aplicar(env, {
				type: "tenantDb.transaction",
				payload: {
					steps: [
						{ kind: "value", sql: "SELECT lower(hex(randomblob(16)));", saveAs: "id" },
						{ kind: "execute", sql: "INSERT INTO Pagos (ID_Pago) VALUES (:id);", args: {} },
						{ kind: "execute", sql: "UPDATE Serie_Facturacion SET Ultimo = Ultimo + 1;", args: [] },
					],
				},
			}),
		).rejects.toMatchObject({ code: "escritura_solo_en_main:Serie_Facturacion", status: 403 });
		expect(seLlamo()).toBe(false);
	});

	it("deja pasar una LECTURA: la Handy sí puede ver los tickets", async () => {
		const { env, seLlamo } = entorno();
		await aplicar(env, {
			type: "tenantDb.exec",
			payload: { sql: "SELECT Huella FROM Registros_Facturacion WHERE ID_Pago = ?;", args: ["p"] },
		});
		expect(seLlamo()).toBe(true);
	});

	it("no estorba a una escritura normal", async () => {
		const { env, seLlamo } = entorno();
		await aplicar(env, {
			type: "tenantDb.exec",
			payload: { sql: "INSERT INTO Detalle_Comanda (ID_Detalle) VALUES (?);", args: ["d"] },
		});
		expect(seLlamo()).toBe(true);
	});

	it("el veto no depende de la capitalización del SQL", async () => {
		const { env } = entorno();
		await expect(
			aplicar(env, {
				type: "tenantDb.exec",
				payload: { sql: "insert into registros_facturacion (ID_Registro) values (?);", args: ["x"] },
			}),
		).rejects.toBeInstanceOf(HubError);
	});
});
