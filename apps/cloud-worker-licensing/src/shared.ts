// src/shared.ts
//
// Tipos que cruzan la frontera del worker de licencias (los consume el cliente Rust en
// `crates/tpv-infra-licensing`). Cambiar un nombre de campo aquí rompe la app: son contrato.

/** Ciclo de vida de una licencia en nuestro control-plane. */
export type LicenseStatus =
	| "issued" // emitida (comprada o alta manual), aún sin activar: el reloj no corre
	| "active" // activada en un Main; corre hasta expires_at_ms
	| "expired" // pasada la caducidad
	| "revoked" // anulada (fraude, reembolso, admin)
	| "redeemed"; // canjeada: su tiempo se sumó a otra licencia (`redeemed_into_license_id`) y ya no se activa

/** `pruebas`: las que emite el E2E, que se retiran con su base al acabar (`admin/pruebas.ts`). */
export type LicenseOrigin = "stripe" | "manual" | "pruebas";

/**
 * Cómo ve el gate el estado de la licencia. Lo deriva el servidor (`computeLicenseState`)
 * y viaja FIRMADO: el cliente lo verifica con la clave pública pineada antes de creérselo.
 */
export type LicenseGateState =
	| "active" // todo en orden
	| "warn" // caduca pronto (≤ 7 días): banner de aviso, pero se puede trabajar
	| "expiry_grace" // caducada, dentro de los 3 días de gracia: banner rojo, se puede trabajar
	| "expired" // caducada y agotada la gracia: bloqueo
	| "revoked" // anulada: bloqueo
	| "device_replaced"; // la licencia se movió a otro Main: este equipo queda fuera

export type ApiError = {
	ok: false;
	error: string;
	/** La frase para la persona, cuando depende del caso (si no, la pone `MENSAJES`). */
	message?: string;
	details?: any;
};

/** Datos del negocio que el TPV envía al activar (se persisten en `tenants`). */
export type TenantInfo = {
	displayName?: string;
	legalName?: string;
	phone?: string;
	country?: string;
};

export type ActivateResponse = {
	ok: true;
	tenantId: string;
	deviceId: string;
	token: string;
	status: LicenseStatus;
	expiresAt: string | null;
	/**
	 * DEK del tenant (base64, 32 bytes) para cifrar la PII del personal (TRAB-03).
	 * La Main la guarda en el almacén de secretos del sistema y NO vuelve a pedirla.
	 * Viaja sólo aquí, por TLS y en una respuesta que ya exige clave de activación válida.
	 */
	fieldDek: string;
	/**
	 * La licencia estaba en otro equipo y se ha trasladado a éste (con el código del correo). La
	 * base local de este equipo, si tiene algo, no vale: la Main la reconstruye desde la nube.
	 */
	cambioDeEquipo: boolean;
	/**
	 * REV-13 · La clave no ha estrenado nada: le ha **sumado su tiempo** a la licencia que este
	 * equipo ya tenía. No hay negocio nuevo, ni base nueva, ni nada que reconstruir — sigue todo
	 * como estaba, con más meses por delante. Es lo que permite que el mismo enlace de compra
	 * sirva para estrenar y para renovar.
	 */
	tiempoSumado?: boolean;
};

/**
 * Aserción de estado **firmada con ed25519** (§5.1). El cliente reconstruye `msg` con estos
 * mismos campos, en este mismo orden, y verifica `sig` contra la clave pública pineada en el
 * binario. Sin firma válida, no hay acceso: el TLS deja de ser la única barrera.
 */
export type SignedLicenseAssertion = {
	/** Versión del formato canónico de la firma. Si cambia el orden de los campos, sube. */
	v: 1;
	tenantId: string;
	deviceId: string;
	licenseId: string;
	/** Estado derivado por el servidor (autoridad). */
	state: LicenseGateState;
	plan: string;
	expiresAtMs: number | null;
	issuedAtMs: number;
	/** La aserción caduca a los 5 min: no vale reproducir una vieja. */
	assertionExpiresAtMs: number;
	/** El `X-Device-Ts` que mandó el cliente en ESTA petición: liga la aserción a la petición. */
	clientTs: number;
	/** Firma ed25519 en base64 del mensaje canónico. */
	sig: string;
};
