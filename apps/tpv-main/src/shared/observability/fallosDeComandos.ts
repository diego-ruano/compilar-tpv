// shared/observability/fallosDeComandos.ts
//
// Registro de los fallos de comandos (docs/arquitectura/observabilidad.md#los-fallos-de-comandos).
//
// Todo comando pasa por `invocar` (@tpv/client), que avisa aquí cuando uno falla. Esto decide qué
// es cada fallo por su código y lo cuenta: a Rust siempre (log local y Axiom, con su cola en
// disco, así que lo que falla sin red llega al volver) y a Sentry sólo los fallos del programa,
// con el rastro de lo que se pulsó antes. Avisar a quien está delante sigue siendo cosa de cada
// pantalla: esto es para nosotros.

import { alFallarUnComando, commands, type ErrorCode, type FalloAlInvocar } from "@tpv/client";
import type { FalloDeComando, GravedadFallo } from "@tpv/contracts";

import { capturarFalloDeComando } from "./sentry";

/**
 * Qué es cada código. Un código nuevo no compila hasta que alguien decida aquí qué es.
 *
 * `ignorar` es para lo que no es un fallo sino la respuesta normal de una pregunta que se repite:
 * mientras se vincula una Handy, se pregunta en bucle y la respuesta es `not_approved`.
 */
const GRAVEDAD: Record<ErrorCode, GravedadFallo | "ignorar"> = {
    internal: "programa",
    repository: "programa",
    tenant_migration_altered: "programa",
    bootstrap_too_large: "programa",
    external: "entorno",
    main_offline: "entorno",
    backup_corrupt: "entorno",
    validation: "normal",
    not_found: "normal",
    conflict: "normal",
    invalid_pin: "normal",
    permiso_denegado: "normal",
    device_revoked: "normal",
    license_expired: "normal",
    license_not_found: "normal",
    tenant_db_not_provisioned: "normal",
    datos_fiscales_incompletos: "normal",
    factura_completa_requerida: "normal",
    reserva_solapada: "normal",
    usuario_inactivo: "normal",
    not_approved: "ignorar",
};

/** El mismo comando con el mismo código dentro de esta ventana se cuenta una vez, con las veces. */
export const VENTANA_MS = 60_000;

/** El comando que cuenta los fallos. Su propio fallo no se cuenta: sería un bucle. */
const COMANDO_PROPIO = "telemetria_fallo_de_comando";

type Destinos = {
    contar: (fallo: FalloDeComando) => Promise<unknown>;
    aSentry: (fallo: FalloDeComando) => void;
    pantalla: () => string | null;
};

export function crearRegistroDeFallos(destinos: Destinos): (fallo: FalloAlInvocar) => void {
    const ventanas = new Map<string, { juntados: number; ultimo: FalloDeComando }>();
    const contar = (fallo: FalloDeComando) => {
        destinos.contar(fallo).catch(() => {
            // Si no se puede contar, se pierde: registrar nunca debe dar un fallo nuevo.
        });
    };

    return ({ comando, error, duracionMs }) => {
        if (comando === COMANDO_PROPIO) return;
        const gravedad = GRAVEDAD[error.code];
        if (gravedad === "ignorar") return;

        const fallo: FalloDeComando = {
            comando,
            code: error.code,
            gravedad,
            mensaje: gravedad === "normal" ? null : error.message,
            pantalla: destinos.pantalla(),
            duracion_ms: duracionMs,
            veces: 1,
        };

        // Una racha (un bucle que reintenta, una Handy sin Main) no puede inundar nada: el primero
        // sale ya, y los que lleguen en la ventana salen juntos al cerrarla.
        const clave = `${comando}|${error.code}`;
        const abierta = ventanas.get(clave);
        if (abierta) {
            abierta.juntados += 1;
            abierta.ultimo = fallo;
            return;
        }
        const ventana = { juntados: 0, ultimo: fallo };
        ventanas.set(clave, ventana);
        contar(fallo);
        if (gravedad === "programa") destinos.aSentry(fallo);
        setTimeout(() => {
            ventanas.delete(clave);
            if (ventana.juntados > 0) contar({ ...ventana.ultimo, veces: ventana.juntados });
        }, VENTANA_MS);
    };
}

/** Engancha el registro a `invocar`. Va al arrancar, junto a Sentry. */
export function iniciarRegistroDeFallos(): void {
    alFallarUnComando(
        crearRegistroDeFallos({
            contar: (fallo) => commands.telemetriaFalloDeComando(fallo),
            aSentry: capturarFalloDeComando,
            pantalla: () => window.location.pathname,
        }),
    );
}
