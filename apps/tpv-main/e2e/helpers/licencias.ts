// El API de administración de licencias, visto desde el E2E.
//
// La tanda emite UNA licencia al empezar (`onPrepare`) y la comparten todos los recorridos, porque
// comparten equipo. No sirve una fija del `.env`: el catch-up desde `Last_Seq = 0` reproduciría las
// ejecuciones anteriores contra tablas con `UNIQUE` en el nombre —la reconciliación acabaría en
// cuarentena y el login no se desbloquearía nunca—, y en cuanto `0001_inicial.sql` cambia, su
// tenant deja de migrar. El recorrido de la licencia, además, la revoca y la caduca a propósito:
// por eso va el último.
//
// Al terminar la tanda se revoca (`onComplete`): queda marcada y no se confunde con una de verdad.
// La base Turso que crea su activación no se borra sola — es el precio de esta prueba, y por eso es
// una por tanda y no una por recorrido.

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
    });
    return { licenseId: res.licenseId, key: res.key };
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
