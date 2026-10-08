import { commands } from "@tpv/client";
// src/features/configuracion/api/correoRecuperacionApis.ts
//
// El correo de recuperación (LOGIN-08): a dónde llegan los códigos para recuperar el PIN de un
// administrador. Vive en la base central, así que todo esto necesita internet.


import type { CodigoEnviado, EstadoCorreoRecuperacion } from "@tpv/contracts";

export type { EstadoCorreoRecuperacion };

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
    const r = await commands.correoRecuperacionSolicitar({ correo });
    return {
        emailHint: r.email_hint,
        minutos: r.minutos,
        reenvioSegundos: r.reenvio_segundos ?? 0,
        sinCambios: r.sin_cambios ?? false,
    };
}

export function correoRecuperacionConfirmar(codigo: string): Promise<EstadoCorreoRecuperacion> {
    return commands.correoRecuperacionConfirmar({ codigo });
}
