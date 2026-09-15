// src/app/arranque/textosLicencia.ts
//
// Lo que se le dice a quien está delante cuando la licencia no le deja trabajar, o avisa de que va a
// dejar de hacerlo. Sin React, para poder probar que cada motivo del servidor tiene su explicación
// (`test/arranque.test.ts`): una pantalla que se bloquea sin decir por qué es la que acaba en una
// llamada a soporte.

import { diasNaturalesHasta } from "../../shared/lib/diasNaturales";
import type { AvisoCaducidad } from "./pantallaDeArranque";

export type Texto = { titulo: string; cuerpo: string };

/**
 * Por qué la licencia bloquea la Main. El motivo crudo (el que compara el gate) se enseña aparte,
 * pequeño, para soporte. El caso por defecto cubre cualquier código nuevo sin dejar la pantalla muda.
 */
export function textoBloqueo(motivo: string): Texto {
	if (motivo === "expired")
		return {
			titulo: "Licencia caducada",
			cuerpo: "Tu licencia ha caducado y se acabó el periodo de gracia. Renuévala con el mismo correo de compra y vuelve a intentarlo.",
		};
	// Este es el momento en que el TPV se entera, con la app abierta: lo enseña el pulso periódico
	// de la licencia (job `licencia` → evento `license:changed`). Al reiniciar ya no se vuelve a
	// ver, porque un rechazo borra el estado local y el equipo cae en la pantalla de activación —
	// que lo explica por su cuenta (ver `textoRechazoPrevio`).
	if (motivo === "revoked")
		return {
			titulo: "Licencia anulada",
			cuerpo: "Esta licencia ha sido anulada, así que este equipo no puede seguir trabajando. Si es un error, en cuanto se deshaga la anulación la misma clave vuelve a activarlo sin perder ningún dato.",
		};
	if (motivo === "device_replaced")
		return {
			titulo: "Licencia trasladada",
			cuerpo: "Esta licencia se ha activado en otro equipo, así que este ha dejado de tener acceso. Si no has sido tú, contacta con soporte cuanto antes.",
		};
	if (motivo === "bad_signature")
		return {
			titulo: "No se pudo verificar la licencia",
			cuerpo: "La respuesta del servidor de licencias no superó la comprobación de seguridad. Revisa tu conexión (proxy/antivirus) y reintenta.",
		};
	if (motivo === "offline_expired" || motivo === "clock_rollback_detected")
		return {
			titulo: "Sin conexión demasiado tiempo",
			cuerpo: "Llevas demasiado tiempo sin conectar con el servidor de licencias. Conéctate a internet y reintenta la comprobación.",
		};
	if (motivo === "license_not_found")
		return {
			titulo: "Licencia no encontrada",
			cuerpo: "El servidor no reconoce esta licencia. Puede que se haya borrado o introducido mal. Vuelve a activar con tu clave.",
		};
	return {
		titulo: "Licencia bloqueada",
		cuerpo: "No se puede validar la licencia en este momento. Reintenta la comprobación o vuelve a activar con tu clave.",
	};
}

/**
 * El aviso de la pantalla de activación cuando este equipo YA tuvo licencia y el servidor la rechazó.
 * Sin esto, la pantalla es la misma que ve un TPV recién instalado y nadie sabe qué pasó.
 *
 * Lo importante que dice cada caso no es el nombre del estado, es qué hacer: una anulación se puede
 * deshacer y entonces **la misma clave vuelve a activar sin perder ningún dato**, porque activar no
 * toca la base local. Eso convierte una revocación por error en un susto y no en una pérdida, y es
 * justo lo que nadie adivina mirando un formulario vacío.
 */
export function textoRechazoPrevio(motivo: string | null): Texto | null {
	if (!motivo) return null;

	const textos: Record<string, Texto> = {
		revoked: {
			titulo: "Esta licencia fue anulada",
			cuerpo:
				"Por eso se pide de nuevo. Si ha sido un error, en cuanto se deshaga la anulación " +
				"esta misma clave vuelve a activar el equipo y no se pierde ningún dato: activar no " +
				"toca lo que hay guardado aquí.",
		},
		device_replaced: {
			titulo: "Esta licencia se activó en otro equipo",
			cuerpo:
				"Al moverla, este ordenador dejó de tener acceso. Si no has sido tú, contacta con " +
				"soporte cuanto antes; si sí, vuelve a activarla aquí con tu clave.",
		},
		license_not_found: {
			titulo: "El servidor no reconoce la licencia que tenía este equipo",
			cuerpo:
				"Comprueba la clave antes de volver a intentarlo. Si estás seguro de que es " +
				"correcta, contacta con soporte.",
		},
	};

	return (
		textos[motivo] ?? {
			titulo: "Este equipo se quedó sin licencia",
			cuerpo: `El servidor la rechazó (${motivo}). Vuelve a activarla con tu clave.`,
		}
	);
}

/**
 * El banner que acompaña a una Main que trabaja con la licencia por caducar (`warn`) o ya caducada
 * dentro del margen del servidor (`expiry_grace`).
 */
export function textoAvisoCaducidad(aviso: AvisoCaducidad, ahoraMs: number = Date.now()): string {
	// Ese margen es un por si acaso, no un plazo con el que contar: no se anuncia cuánto queda.
	if (aviso.motivo === "expiry_grace") {
		return "Tu licencia ha caducado y la aplicación puede bloquearse en cualquier momento.";
	}
	// Días de calendario, no horas redondeadas: caducar a las 23:00 es «hoy» a las 08:00.
	const dias = aviso.expiresAtMs != null ? diasNaturalesHasta(aviso.expiresAtMs, ahoraMs) : null;
	if (dias == null) return "Tu licencia caduca pronto.";
	if (dias <= 0) return "Tu licencia caduca hoy.";
	if (dias === 1) return "Tu licencia caduca mañana.";
	return `Tu licencia caduca en ${dias} días.`;
}
