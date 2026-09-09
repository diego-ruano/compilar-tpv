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

// ⚠️ Los argumentos van PLANOS (`{ numeroTicket }`), no envueltos en `{ args: {…} }`.
//
// En el repo conviven las dos formas porque dependen de la firma de cada comando: `{ args: {…} }`
// es para los que declaran UN parámetro llamado `args` (`printer_set_selected`, `stats_*`), y estos
// declaran parámetros sueltos. Equivocarse **no da un error legible**: un parámetro `Option<…>`
// llega como `None` y el comando se queda con su valor por defecto, así que el síntoma es una lista
// que siempre trae lo mismo. Y no lo cubre `check-comandos-tauri.mjs`, que comprueba el NOMBRE del
// comando y no la forma de sus argumentos.

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
			numeroTicket: n,
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
		limite: limite ?? 100,
		desplazamiento: desplazamiento ?? 0,
	});
}

/**
 * Lo que hay que declarar sobre el software (art. 13 RRSIF).
 *
 * No es un DTO de `ts-rs`: se declara aquí porque no cruza ninguna frontera más que esta pantalla.
 */
export type DeclaracionResponsable = {
	productor_nombre_razon: string;
	productor_nif: string;
	nombre_sistema: string;
	id_sistema: string;
	version: string;
	texto: string;
	/** `false` mientras falten los datos definitivos del productor. */
	completa: boolean;
};

/** La declaración responsable que la ley obliga a poder ver desde dentro del programa. */
export async function verifactuDeclaracionResponsable(): Promise<DeclaracionResponsable> {
	return await invokeClient<DeclaracionResponsable>("verifactu_declaracion_responsable");
}

/**
 * Genera el ZIP con los registros de un rango (art. 8 RRSIF) y devuelve cuántos entraron.
 *
 * `destino` es una ruta **absoluta y fuera de AppData**: la elige el usuario con el diálogo del
 * sistema, igual que al sacar una copia de seguridad. Las fechas van en `AAAA-MM-DD`.
 */
export async function verifactuExportar(
	destino: string,
	desde: string,
	hasta: string,
): Promise<number> {
	return await invokeClient<number>("verifactu_exportar", { destino, desde, hasta });
}

/**
 * Da por vistas las anomalías de la cadena. Devuelve cuántas ha marcado.
 *
 * «Reconocida» no es «resuelta»: las filas se conservan. Lo único que cambia es que dejan de gritar.
 */
export async function verifactuReconocerAnomalias(): Promise<number> {
	return await invokeClient<number>("verifactu_reconocer_anomalias");
}

/**
 * Enciende o apaga el modo formación. Devuelve cuántas facturas de prueba se anularon.
 *
 * **Apagarlo ES la anulación**, no un paso aparte: la AEAT obliga a anular las facturas de prueba, y
 * dejarlo a que alguien se acuerde es dejar que el día que se le olvide quede una venta ficticia
 * contada como real.
 */
export async function verifactuSetFormacion(encendido: boolean): Promise<number> {
	return await invokeClient<number>("verifactu_set_formacion", { encendido });
}
