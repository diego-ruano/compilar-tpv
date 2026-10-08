import { z } from "zod";

const identificador = z.string().trim().min(1).max(200);
const clave = z.string().trim().min(1).max(256);

// La identidad Rust usa base64 estándar: no basta con recibir una cadena no vacía.
const clavePublica = z.string().trim().refine((valor) => {
	if (!/^[A-Za-z0-9+/]{43}=$/.test(valor)) return false;
	try {
		const bytes = atob(valor);
		return bytes.length === 32 && btoa(bytes) === valor;
	} catch {
		return false;
	}
}, "Se requiere una clave pública Ed25519 de 32 bytes en base64.");

export const activarSchema = z.object({
	activationKey: clave,
	deviceId: identificador,
	devicePubKey: clavePublica,
	instanceName: z.string().trim().max(200).optional(),
	tenantInfo: z.object({
		displayName: z.string().trim().max(200).optional(),
		legalName: z.string().trim().max(200).optional(),
		phone: z.string().trim().max(50).optional(),
		country: z.string().trim().max(100).optional(),
	}).optional(),
	deviceChangeCode: z.string().trim().regex(/^(?:[0-9]{6})?$/).optional(),
	soloSumar: z.boolean().optional(),
});

export const pedirCambioSchema = z.object({ activationKey: clave, deviceId: identificador });
