// src/features/configuracion/api/verifactuApis.ts
//
// Veri*factu (FISCAL-01): lo que el frontend necesita del registro de facturación.
//
// Son TRES LECTURAS y ninguna escritura, y eso es la decisión, no una carencia: el registro se
// crea dentro de la transacción del cobro, en Rust. Un "emitir registro" invocable desde aquí
// sería la puerta a expedir una factura sin registro (o al revés), que es la única forma de
// romper esto de verdad — la AEAT lo llama «facturas huérfanas» en su FAQ de desarrolladores.

import { invokeClient } from "@tpv/client";
import type { BloqueFiscal, EstadoFiscal, RegistroFiscal } from "@tpv/contracts";

/**
 * El bloque fiscal de un ticket (número, QR y huella) por su número de factura.
 *
 * Sirve igual para **imprimir** y para **reimprimir**: los tres datos se leen de la fila, no se
 * recalculan. Recalcular daría otra hora de generación y, por tanto, otra huella — y una copia con
 * otra huella no es una copia.
 *
 * Devuelve `null` sin ruido cuando no hay número (la precuenta) o cuando el ticket es anterior a
 * que el negocio completara sus datos fiscales. Que no sea un error es lo que permite que la
 * precuenta y el ticket compartan el mismo camino de impresión.
 */
export async function verifactuBloqueTicket(
	numeroTicket: string | null | undefined,
): Promise<BloqueFiscal | null> {
	const n = (numeroTicket ?? "").trim();
	if (!n) return null;
	try {
		return (await invokeClient<BloqueFiscal | null>("verifactu_bloque_ticket", {
			args: { numeroTicket: n },
		})) ?? null;
	} catch {
		// Nada de lo que rodea al ticket puede impedir imprimirlo. Si esto falla, el papel sale sin
		// QR: la factura sigue siendo válida porque el registro ya está emitido y se remitirá igual.
		return null;
	}
}

/** Resumen del estado fiscal: datos del obligado, cola de envío y escalón de aviso. */
export async function verifactuEstado(): Promise<EstadoFiscal> {
	return await invokeClient<EstadoFiscal>("verifactu_estado");
}

/** Los registros del panel, del más reciente al más antiguo. Sólo Administrador. */
export async function verifactuListar(
	limite?: number,
	desplazamiento?: number,
): Promise<RegistroFiscal[]> {
	return await invokeClient<RegistroFiscal[]>("verifactu_listar", {
		args: { limite: limite ?? 100, desplazamiento: desplazamiento ?? 0 },
	});
}
