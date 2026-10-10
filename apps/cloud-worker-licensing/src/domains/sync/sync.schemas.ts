// src/domains/sync/sync.schemas.ts
//
// Los cuatro cuerpos permisivos de la recuperación y la observabilidad (ARQ-06). Son schemas
// TOTALES a propósito: aquí un campo extraño cae a su default o se descarta, nunca bloquea vender.
// `cuerpoTolerante` conserva además el comportamiento histórico del JSON ausente o mal formado.

import * as z from "zod";

import { esTablaDeNegocio } from "./bootstrap.ventana";

/** Tope de filas por página. Lo impone el servidor: el cliente pide, no manda. */
const HISTORICO_MAX_FILAS = 2_000;
const HISTORICO_FILAS_DEFECTO = 1_000;

function objeto(valor: unknown): Record<string, any> {
	return valor !== null && typeof valor === "object" ? (valor as Record<string, any>) : {};
}

function numero(valor: unknown, defecto: number): number {
	return Number(valor ?? defecto) || defecto;
}

export const changesSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	return {
		since: Math.max(0, numero(body.since, 0)),
		limit: Math.min(Math.max(1, numero(body.limit, 500)), 1_000),
	};
});

export const historicoSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	return {
		tabla: String(body.tabla ?? ""),
		cursor: Math.max(0, numero(body.cursor, 0)),
		limite: Math.min(
			Math.max(1, numero(body.limite, HISTORICO_FILAS_DEFECTO)),
			HISTORICO_MAX_FILAS,
		),
	};
});

const identificadorAceptable = (valor: unknown): valor is string =>
	typeof valor === "string" && /^[A-Za-z0-9_]{1,64}$/.test(valor) && !valor.startsWith("_");

export const verificarClavesSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	const pedidas: any[] = Array.isArray(body.tablas) ? body.tablas.slice(0, 60) : [];
	const tablas = pedidas.flatMap((tabla) => {
		if (
			!identificadorAceptable(tabla?.nombre) ||
			!esTablaDeNegocio(tabla.nombre) ||
			!Array.isArray(tabla?.claves) ||
			tabla.claves.length === 0 ||
			tabla.claves.length > 4 ||
			!tabla.claves.every(identificadorAceptable)
		) {
			return [];
		}
		return [{ nombre: tabla.nombre, claves: tabla.claves as string[] }];
	});
	return { tablas };
});

export const saludSyncSchema = z.unknown().transform((entrada) => {
	const body = objeto(entrada);
	const descuadres: any[] = Array.isArray(body.descuadres) ? body.descuadres.slice(0, 50) : [];
	return {
		descuadres: descuadres.map((d) => ({
			tabla: String(d?.tabla ?? "").slice(0, 64),
			faltan: Number(d?.faltan ?? 0),
			sobran: Number(d?.sobran ?? 0),
			distintas: Number(d?.distintas ?? 0),
		})),
		apartadas: Number(body.apartadas ?? 0),
		reparadas: Number(body.reparadas ?? 0),
		ventana_omitida: Boolean(body.ventana_omitida),
		// PROD-06: el interruptor `reparacion_nube` estaba apagado y no se reparó nada. Sin esto,
		// un «0 reparadas» se leería igual que «no había nada que reparar».
		reparacion_apagada: Boolean(body.reparacion_apagada),
	};
});
