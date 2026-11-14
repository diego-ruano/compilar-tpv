// El API de administración de licencias, visto desde el E2E.
//
// La tanda emite UNA licencia al empezar (`onPrepare`) y la comparten todos los recorridos, porque
// comparten equipo. No sirve una fija del `.env`: el catch-up desde `Last_Seq = 0` reproduciría las
// ejecuciones anteriores contra tablas con `UNIQUE` en el nombre —la reconciliación acabaría en
// cuarentena y el login no se desbloquearía nunca—, y en cuanto `0001_inicial.sql` cambia, su
// tenant deja de migrar. El recorrido de la licencia, además, la revoca y la caduca a propósito:
// por eso va el último.
//
// Se emite como de pruebas, y al terminar la tanda (`onComplete`) se retira su negocio con la base
// que creó su activación en su TenantHub: no se acumulan en el panel. Retirar se lleva también lo
// que dejara una tanda que no llegó al final.

const BASE = process.env.TPV_API_BASE || "https://tpv-api.altarialights.workers.dev";

function token(): string {
    const t = (process.env.ADMIN_API_TOKEN ?? "").trim();
    if (!t) {
        throw new Error(
            "Falta ADMIN_API_TOKEN en el .env de la raíz: sin él no se pueden emitir las licencias\n" +
                "de los recorridos de copias y de licencia.",
        );
    }
    return t;
}

async function admin<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    const r = await fetch(`${BASE}${ruta}`, {
        method: metodo,
        headers: {
            authorization: `Bearer ${token()}`,
            ...(cuerpo ? { "content-type": "application/json" } : {}),
        },
        ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    });

    const texto = await r.text();
    let datos: unknown;
    try {
        datos = JSON.parse(texto);
    } catch {
        throw new Error(`El worker contestó algo que no es JSON (${r.status}): ${texto.slice(0, 200)}`);
    }

    if (!r.ok || (datos as { ok?: boolean }).ok === false) {
        throw new Error(`${metodo} ${ruta} → ${r.status}: ${texto.slice(0, 300)}`);
    }
    return datos as T;
}

export type LicenciaEmitida = { licenseId: string; key: string };

/** Emite una licencia de un año para esta tanda. El nombre sirve para reconocerla en el panel. */
export async function emitirLicencia(nombre: string): Promise<LicenciaEmitida> {
    const res = await admin<{ licenseId: string; key: string }>("POST", "/v1/admin/licenses", {
        termMonths: 12,
        email: "e2e@altarialights.test",
        name: nombre,
        pruebas: true,
    });
    return { licenseId: res.licenseId, key: res.key };
}

type Retirada = {
    negocios: number;
    bases: number;
    licencias: number;
    fallos: { tenantId: string; error: string }[];
    quedan: boolean;
};

/**
 * Borra los negocios de pruebas que queden, con su base, y anula sus licencias. El worker
 * retira unos pocos por llamada, así que se repite mientras queden y la llamada anterior avance.
 */
export async function retirarLasDePrueba(): Promise<Retirada> {
    const total: Retirada = { negocios: 0, bases: 0, licencias: 0, fallos: [], quedan: true };
    while (total.quedan) {
        const r = await admin<Retirada>("POST", "/v1/admin/pruebas/retirar");
        total.negocios += r.negocios;
        total.bases += r.bases;
        total.licencias += r.licencias;
        total.fallos = r.fallos;
        total.quedan = r.quedan && r.negocios > 0;
    }
    return total;
}

export const revocar = (licenseId: string) =>
    admin<{ status: string }>("POST", `/v1/admin/licenses/${licenseId}/revoke`);

export const desrevocar = (licenseId: string) =>
    admin<{ status: string }>("POST", `/v1/admin/licenses/${licenseId}/unrevoke`);

/** Resta meses a la caducidad. Con bastantes, la deja en el pasado: eso es "caducada". */
export const acortar = (licenseId: string, months: number) =>
    admin<{ expiresAt: string; caducada: boolean }>(
        "POST",
        `/v1/admin/licenses/${licenseId}/shorten`,
        { months },
    );

export const alargar = (licenseId: string, months: 1 | 3 | 12) =>
    admin<{ expiresAt: string }>("POST", `/v1/admin/licenses/${licenseId}/extend`, { months });
