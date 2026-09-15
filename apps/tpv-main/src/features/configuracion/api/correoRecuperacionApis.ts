// src/features/configuracion/api/correoRecuperacionApis.ts
//
// El correo de recuperación (LOGIN-08): a dónde llegan los códigos para recuperar el PIN de un
// administrador. Vive en la base central, así que todo esto necesita internet.

import { invokeClient } from "@tpv/client";
import type { CodigoEnviado, EstadoCorreoRecuperacion } from "@tpv/contracts";

export type { EstadoCorreoRecuperacion };

export function correoRecuperacionEstado(): Promise<EstadoCorreoRecuperacion> {
    return invokeClient<EstadoCorreoRecuperacion>("correo_recuperacion_estado");
}

/**
 * Manda un código al correo nuevo. Hasta confirmarlo, no cambia nada. `sinCambios` es que ya era
 * el correo de recuperación: no se ha mandado nada y no hay que confirmar.
 */
export async function correoRecuperacionSolicitar(correo: string): Promise<{
    emailHint: string;
    minutos: number;
    reenvioSegundos: number;
    sinCambios: boolean;
}> {
    const r = await invokeClient<CodigoEnviado>("correo_recuperacion_solicitar", {
        args: { correo },
    });
    return {
        emailHint: r.email_hint,
        minutos: r.minutos,
        reenvioSegundos: r.reenvio_segundos,
        sinCambios: r.sin_cambios,
    };
}

export function correoRecuperacionConfirmar(codigo: string): Promise<EstadoCorreoRecuperacion> {
    return invokeClient<EstadoCorreoRecuperacion>("correo_recuperacion_confirmar", {
        args: { codigo },
    });
}

export function correoRecuperacionUsarElDeLaCompra(): Promise<EstadoCorreoRecuperacion> {
    return invokeClient<EstadoCorreoRecuperacion>("correo_recuperacion_usar_el_de_la_compra");
}
