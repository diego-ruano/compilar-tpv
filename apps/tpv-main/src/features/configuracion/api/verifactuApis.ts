// src/features/configuracion/api/verifactuApis.ts
//
// Veri*factu (FISCAL-01): lo que el frontend necesita del registro de facturación.
//
// Son LECTURAS y ninguna escritura, y eso es la decisión, no una carencia: el registro se
// crea dentro de la transacción del cobro, en Rust. Un "emitir registro" invocable desde aquí
// sería la puerta a expedir una factura sin registro (o al revés), que es la única forma de
// romper esto de verdad — la AEAT lo llama «facturas huérfanas» en su FAQ de desarrolladores.

import { invokeClient } from "@tpv/client";
import type { EstadoFiscal, RegistroFiscal } from "@tpv/contracts";

// ⚠️ Los argumentos van PLANOS (`{ limite }`), no envueltos en `{ args: {…} }`.
//
// En el repo conviven las dos formas porque dependen de la firma de cada comando: `{ args: {…} }`
// es para los que declaran UN parámetro llamado `args` (`printer_set_selected`, `stats_*`), y estos
// declaran parámetros sueltos. Equivocarse **no da un error legible**: un parámetro `Option<…>`
// llega como `None` y el comando se queda con su valor por defecto, así que el síntoma es una lista
// que siempre trae lo mismo. Y no lo cubre `check-comandos-tauri.mjs`, que comprueba el NOMBRE del
// comando y no la forma de sus argumentos.

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
 * MODO-PRUEBA (temporal): activa o desactiva el modo prueba. Con él los cobros no emiten factura ni
 * se envía nada a Hacienda. Se quita entero antes de que Veri*factu sea obligatorio.
 */
export async function verifactuSetModoPrueba(encendido: boolean): Promise<void> {
	await invokeClient<void>("verifactu_set_modo_prueba", { encendido });
}

/**
 * Vuelve a mandar como subsanación los registros que la AEAT rechazó. Devuelve cuántos.
 *
 * Es manual a propósito: reintentar solo algo que ya fue rechazado repetiría el rechazo cada minuto.
 */
export async function verifactuSubsanarRechazados(): Promise<number> {
	return await invokeClient<number>("verifactu_subsanar_rechazados");
}
