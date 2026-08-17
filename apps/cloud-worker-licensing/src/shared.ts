// src/shared.ts
//
// Tipos que cruzan la frontera del worker de licencias (los consume el cliente Rust en
// `crates/tpv-infra-licensing`). Cambiar un nombre de campo aquí rompe la app: son contrato.

/** Ciclo de vida de una licencia en NUESTRO control-plane (ya no el de Lemon). */
export type LicenseStatus =
	| "issued" // emitida (comprada o alta manual), aún sin activar: el reloj no corre
	| "active" // activada en un Main; corre hasta expires_at_ms
	| "expired" // pasada la caducidad
	| "revoked"; // anulada (fraude, reembolso, admin)

export type LicenseOrigin = "stripe" | "manual";

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
	details?: any;
};

/** Datos del negocio que el TPV envía al activar (se persisten en `tenants`). */
export type TenantInfo = {
	displayName?: string;
	legalName?: string;
	email?: string;
	phone?: string;
	country?: string;
};

export type ActivateRequest = {
	activationKey: string;
	deviceId: string;
	devicePubKey: string;
	instanceName?: string;
	tenantInfo?: TenantInfo;
	/** Código de 6 dígitos del email. Solo necesario al mover la licencia a otro Main (§6.4). */
	deviceChangeCode?: string;
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

export type StatusResponse = {
	ok: true;
	assertion: SignedLicenseAssertion;
	/** Token de sesión renovado (elimina el muro de los 30 días). Ausente si no tocaba renovar. */
	token?: string;
	/** Datos no críticos para la UI (Configuración → Licencia). No van firmados. */
	info: {
		keyShort: string | null;
		customerEmail: string;
		termMonths: number;
		origin: LicenseOrigin;
	};
	serverTime: number;
};
