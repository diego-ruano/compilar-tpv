// src/app/arranque/textosLicencia.ts
//
// Lo que se le dice a quien está delante cuando la licencia no le deja trabajar, o avisa de que va a
// dejar de hacerlo. Sin React, para poder probar que cada motivo del servidor tiene su explicación
// (`test/arranque.test.ts`): una pantalla que se bloquea sin decir por qué es la que acaba en una
// llamada a soporte.

import { diasNaturalesHasta } from "../../shared/lib/diasNaturales";
import { CORREO_SOPORTE } from "../../shared/lib/soporte";
import type { AvisoCaducidad } from "./pantallaDeArranque";

export type Texto = { titulo: string; cuerpo: string };

/**
 * AUD-06 · Lo que pasa con los datos de este ordenador cuando se activa en él otra licencia. Se
 * dice antes, en la pantalla de bloqueo y en la de activación, y no se impide. Vale para los dos
 * casos: una licencia que ya trabajaba en otro equipo trae sus datos de la nube, y una nueva no
 * tiene ninguno. Es el final de una frase: cada texto pone delante cuándo pasa.
 */
const LOS_DATOS_SE_APARTAN =
	"los datos que hay ahora en este ordenador se guardan aparte, sin borrarlos, y el TPV pasa a trabajar con los de esa licencia: si es nueva, empieza de cero.";

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
	// RI-09: el gate ya no borra la licencia local, así que esta pantalla se queda (también al
	// reiniciar) hasta que el servidor diga otra cosa o alguien pulse «Borrar y volver a activar».
	// Por eso cada texto dice qué arregla cada botón.
	//
	// AUD-06: y qué pasa con lo que hay guardado si después se activa otra licencia, antes de que
	// nadie pulse: los datos de este equipo se apartan y el TPV trabaja con los de esa licencia.
	if (motivo === "revoked")
		return {
			titulo: "Licencia anulada",
			cuerpo: `Esta licencia ha sido anulada, así que este equipo no puede seguir trabajando. Si es un error, en cuanto se deshaga la anulación basta con reintentar: el equipo vuelve a funcionar sin perder ningún dato. Si en vez de eso la borras y activas otra licencia, ${LOS_DATOS_SE_APARTAN}`,
		};
	if (motivo === "device_replaced")
		return {
			titulo: "Licencia trasladada",
			cuerpo: `Esta licencia se ha activado en otro equipo, así que este ha dejado de tener acceso. Si no has sido tú, contacta con soporte en ${CORREO_SOPORTE} cuanto antes. Para usar aquí otra licencia, borra esta y vuelve a activar: ${LOS_DATOS_SE_APARTAN}`,
		};
	if (motivo === "bad_signature")
		return {
			titulo: "No se pudo verificar la licencia",
			cuerpo: "La respuesta del servidor de licencias no superó la comprobación de seguridad. Revisa tu conexión (proxy/antivirus) y reintenta.",
		};
	// REV-10: el reloj tiene su propio texto porque tiene arreglo, y lo tiene quien está delante.
	// Con el de «sin conexión» se manda a mirar el router a alguien cuyo problema es la hora.
	if (motivo === "clock_skew_detected")
		return {
			titulo: "La hora de este equipo no es correcta",
			cuerpo: "El servidor de licencias rechaza las peticiones de este equipo porque su fecha y hora van desfasadas más de dos minutos. Ajústalas en Windows —lo más seguro es activar la hora automática— y reintenta la comprobación.",
		};
	if (motivo === "offline_expired" || motivo === "clock_rollback_detected")
		return {
			titulo: "Sin conexión demasiado tiempo",
			cuerpo: "Llevas demasiado tiempo sin conectar con el servidor de licencias. Conéctate a internet y reintenta la comprobación.",
		};
	// RI-09: el servidor dijo que no, pero sin firma, así que no se puede comprobar que fuera él. Lo
	// esperable es un fallo nuestro: por eso no se manda a volver a teclear la clave, sino a soporte.
	if (motivo === "rejection_unverified")
		return {
			titulo: "El servidor de licencias no reconoce este equipo",
			cuerpo: `Su respuesta no se ha podido verificar, así que este equipo ha seguido trabajando todo el tiempo que permite estar sin conexión. Contacta con soporte en ${CORREO_SOPORTE}: no hace falta volver a teclear la clave, y en cuanto se resuelva basta con reintentar.`,
		};
	return {
		titulo: "Licencia bloqueada",
		cuerpo: "No se puede validar la licencia en este momento. Reintenta la comprobación o vuelve a activar con tu clave.",
	};
}

/**
 * El aviso de la pantalla de activación cuando este equipo YA tuvo licencia y el servidor la rechazó.
 * Sin esto, la pantalla es la misma que ve un TPV recién instalado y nadie sabe qué pasó. Se llega
 * aquí sólo con «Borrar y volver a activar» desde una anulación o un traslado: el gate ya no borra
 * nada por su cuenta (RI-09).
 *
 * Lo importante que dice cada caso no es el nombre del estado, es qué hacer: una anulación se puede
 * deshacer y entonces **la misma clave vuelve a activar sin perder ningún dato**, porque activar la
 * licencia del mismo negocio no toca la base local. Eso convierte una revocación por error en un
 * susto y no en una pérdida, y es justo lo que nadie adivina mirando un formulario vacío.
 *
 * AUD-06: con otra licencia no es así, y se dice aquí, delante del campo de la clave.
 */
export function textoRechazoPrevio(motivo: string | null): Texto | null {
	if (!motivo) return null;

	const textos: Record<string, Texto> = {
		revoked: {
			titulo: "Esta licencia fue anulada",
			cuerpo:
				"Por eso se pide de nuevo. Si ha sido un error, en cuanto se deshaga la anulación " +
				"esta misma clave vuelve a activar el equipo y no se pierde ningún dato. Si en vez " +
				`de eso activas otra licencia, ${LOS_DATOS_SE_APARTAN}`,
		},
		device_replaced: {
			titulo: "Esta licencia se activó en otro equipo",
			cuerpo:
				"Al moverla, este ordenador dejó de tener acceso. Si no has sido tú, contacta con " +
				`soporte en ${CORREO_SOPORTE} cuanto antes; si sí, puedes volver a traerla aquí con tu clave. Actives ` +
				`la licencia que actives, ${LOS_DATOS_SE_APARTAN}`,
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
