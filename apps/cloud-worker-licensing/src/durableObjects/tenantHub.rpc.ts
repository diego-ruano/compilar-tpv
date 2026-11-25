import type { InternalApplyCommand } from "./tenantHub.types";

export type ValorJson = null | string | number | boolean | object;

/**
 * Quién pregunta, tal y como lo comprobó el Worker (`tenantAuth`), para una ruta que se ejecuta dentro
 * del TenantHub (`ejecutarRuta`, `lib/enElHub.ts`). Viaja como argumento del RPC, no en la petición.
 */
export type IdentidadDelWorker = {
	tenantId: string;
	deviceId: string;
	token: string;
	licHash: string;
	/**
	 * Rol del dispositivo (`tpv` | `handy`) según su fila de la base central, leído por el Worker al
	 * autenticar. Con él deciden los vetos de rol que corren dentro del DO (`soloLaMain…`), sin volver
	 * a la base central. Que un `tpv` siga siendo la Main de su licencia lo comprueba el Worker antes
	 * de pasar la petición (`vetoDeLicencia`: `device_replaced`).
	 */
	rol: string;
};

export type ApplyParams = {
	tenantId: string;
	deviceId: string;
	opId: string;
	commandName: string;
	command: Extract<InternalApplyCommand, { type: "tenantDb.exec" | "tenantDb.transaction" }>;
	cloudPayload?: unknown;
	clientNow?: string;
};

/** Los errores de negocio son datos: RPC no conserva las propiedades de una subclase de Error. */
export type ResultadoAplicacion =
	| { ok: true; data: ValorJson }
	| { ok: false; error: string; status: number; details?: { message: string } };

/**
 * DO-03 · Lo que contestan las operaciones de administración de la base del negocio (copias, vuelta a
 * un instante). Como `ResultadoAplicacion`: lo que se rechaza es un dato, con el estado HTTP y, si lo
 * hay, el motivo técnico (`detalle`: el de una copia que no se puede restaurar, `CopiaInservible`), que
 * no lleva nada de la base ni de la copia y va a la respuesta y a Axiom.
 */
export type ResultadoDeAdministracion<T> =
	| ({ ok: true } & T)
	| { ok: false; error: string; status: number; detalle?: string };

/** DO-03 · Cómo está la base de un negocio, para soporte (`/v1/admin/negocios/estado`). */
export type EstadoDeLaBase = {
	aprovisionado: boolean;
	/** El negocio apuntado en su sello (DO-NEGOCIO), o `null`. */
	negocio: string | null;
	/** Cuándo toca la siguiente copia diaria (la alarma del objeto), o `null` si no hay ninguna armada. */
	proximaCopiaMs: number | null;
	/** Si hay una vuelta a un instante preparada y sin aplicar. */
	vueltaEnCurso: boolean;
	/** El `Seq` más alto que sabe la base (`seqMasAlto`). */
	seq: number;
	/** Sesiones autenticadas ahora mismo. */
	sesiones: number;
	/** DO-SUBIDA: la subida completa que se le pidió a la Main (`tenantHub.subida.ts`), o `null`. */
	subida: Record<string, unknown> | null;
};

/** DO-03 · Lo que deja preparado la primera mitad de la vuelta a un instante (`prepararVuelta`). */
export type VueltaPreparada = {
	/** El marcador al que se vuelve. */
	destino: string;
	/** El marcador de ahora, antes de volver. */
	actual: string;
	/** El marcador con el que se deshace la vuelta (el de justo antes de aplicarla). */
	deshacer: string;
	/** El `Seq` más alto antes de volver: lo que la nube había numerado. */
	seqAntes: number;
	aprovisionadoAntes: boolean;
};

/** DO-03 · Cómo quedó la base tras volver (`trasVolver`). */
export type VueltaAplicada = {
	aprovisionado: boolean;
	/** El `Seq` del cambio vacío que abre el log, o `null` sin base. */
	inicio: number | null;
	purgadoHasta: number | null;
};

/**
 * DO-PERDIDA · Cómo quedó un objeto vacío al darle base desde la administración (`crearBaseVacia`,
 * `restaurarDesdeCopia`): el log, abierto como tras una vuelta a un instante (`abrirLogTrasVolver`).
 */
export type BaseDevuelta = {
	/** El `Seq` del cambio vacío que abre el log. */
	inicio: number;
	/** Lo purgado (sólo con `nube`), o `null`. */
	purgadoHasta: number | null;
};

/** DO-PERDIDA · Lo que entró de la copia (`restaurarDesdeCopia`). */
export type CopiaRestaurada = BaseDevuelta & {
	clave: string;
	filas: number;
	/** Tablas con alguna fila. */
	tablas: number;
};
