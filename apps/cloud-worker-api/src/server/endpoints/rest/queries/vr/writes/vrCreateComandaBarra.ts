import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../../utils/response";
import { ensureMesaBarraThroughTenantHub } from "../../../../../utils/tenantHubBarra";
import {
    applyTenantHubTransaction,
    readWriteRequest,
    sqlRef,
    type TxStep,
} from "../../../../../utils/tenantHubWrites";

const COMMAND_NAME = "vr.createComandaBarra";

function asNumber(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

async function getDeviceRole(
    dbCentral: Client,
    tenantId: string,
    deviceId: string,
): Promise<"tpv" | "handy" | "unknown" | null> {
    const r = await dbCentral.execute({
        sql: `
            SELECT role, revoked_at_ms
            FROM devices
            WHERE tenant_id=? AND device_id=?
            LIMIT 1
        `,
        args: [tenantId, deviceId],
    });

    const row = r.rows?.[0] as any | undefined;
    if (!row) return null;
    if (row.revoked_at_ms) return null;

    const role = String(row.role || "").trim().toLowerCase();
    if (role === "tpv") return "tpv";
    if (role === "handy") return "handy";
    return "unknown";
}

async function buildVrWriteContext(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<{ tenantId: string; deviceId: string }> {
    const ctx = await buildTenantContext(req, env, dbCentral, createDbClient);

    const tenantId = String(ctx?.claims?.tenantId ?? "").trim();
    const deviceId = String(ctx?.claims?.deviceId ?? "").trim();

    if (!tenantId || !deviceId) {
        throw new Error("invalid_token_claims");
    }

    const role = await getDeviceRole(dbCentral, tenantId, deviceId);
    if (!role) throw new Error("device_not_registered");

    /*
      Mantenemos comportamiento actual:
      venta rápida de esta ruta solo desde TPV.
      Handy sigue online-only, pero no abrimos permisos aquí en este bloque.
    */
    if (role !== "tpv") throw new Error("forbidden_not_tpv");

    return { tenantId, deviceId };
}

function isAuthError(msg: string): boolean {
    return (
        msg.includes("missing_token") ||
        msg.includes("invalid_token") ||
        msg.includes("invalid_token_claims") ||
        msg.includes("missing_device_proof") ||
        msg.includes("bad_device_signature") ||
        msg.includes("device_ts_out_of_range") ||
        msg.includes("device_pubkey_not_registered") ||
        msg.includes("bad_device_ts") ||
        msg.includes("bad_b64") ||
        msg.includes("device_not_registered") ||
        msg.includes("device_revoked") ||
        msg.includes("forbidden")
    );
}

function handleVrWriteError(req: Request, e: any): Response {
    const msg = String(e?.message || e);

    if (isAuthError(msg)) {
        return unauthorized(req, msg);
    }

    return serverError(req, "internal_error", {
        message: msg,
        name: e?.name,
        stack: e?.stack,
    });
}

export async function handleVrCreateComandaBarra(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const ctx = await buildVrWriteContext(req, env, dbCentral);
        const { input: args, opId } = await readWriteRequest<any>(req, {});

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idTrabajadorRaw = args.idTrabajador ?? args.id_trabajador ?? null;
        const idTrabajador =
            idTrabajadorRaw == null ? null : asNumber(idTrabajadorRaw, 0);

        const idTrabajadorFinal =
            idTrabajador && idTrabajador > 0 ? idTrabajador : null;

        const forcedIdComanda = asNumber(
            args.idComanda ?? args.id_comanda ?? 0,
            0,
        );

        const idMesaBarra = await ensureMesaBarraThroughTenantHub({
            env,
            tenantId: ctx.tenantId,
            opId: `${opId}:ensure_mesa_barra`,
            commandName: "mesas.getOrCreateMesaBarra",
            deviceId: ctx.deviceId,
        });

        const domainArgs: Record<string, any> = {
            id_trabajador: idTrabajadorFinal,
        };

        if (forcedIdComanda > 0) {
            domainArgs.id_comanda = forcedIdComanda;
        }

        const cloudPayload = {
            op_id: opId,
            command_name: COMMAND_NAME,
            args: domainArgs,
        };

        const steps: TxStep[] = [];

        if (forcedIdComanda > 0) {
            steps.push(
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Comandas (
                          ID_Comanda,
                          Fecha_Hora_Apertura,
                          Estado,
                          Total_Comanda,
                          ID_Trabajador,
                          ID_Mesa
                        )
                        VALUES (
                          ?1,
                          datetime('now','localtime'),
                          'Abierta',
                          0,
                          ?2,
                          ?3
                        )
                        ON CONFLICT(ID_Comanda) DO UPDATE SET
                          Estado = excluded.Estado,
                          Total_Comanda = COALESCE(Comandas.Total_Comanda, excluded.Total_Comanda),
                          ID_Trabajador = excluded.ID_Trabajador,
                          ID_Mesa = excluded.ID_Mesa;
                    `,
                    args: [forcedIdComanda, idTrabajadorFinal, idMesaBarra],
                },
                {
                    kind: "value",
                    sql: `SELECT ?1;`,
                    args: [forcedIdComanda],
                    saveAs: "new_id",
                },
            );
        } else {
            steps.push(
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Comandas (
                          Fecha_Hora_Apertura,
                          Estado,
                          Total_Comanda,
                          ID_Trabajador,
                          ID_Mesa
                        )
                        VALUES (
                          datetime('now','localtime'),
                          'Abierta',
                          0,
                          ?1,
                          ?2
                        );
                    `,
                    args: [idTrabajadorFinal, idMesaBarra],
                },
                {
                    kind: "value",
                    sql: `SELECT last_insert_rowid();`,
                    saveAs: "new_id",
                },
            );
        }

        steps.push({
            kind: "execute",
            sql: `
                DELETE FROM Comandas
                WHERE ID_Mesa = ?1
                  AND ID_Comanda <> ?2
                  AND COALESCE(Total_Comanda,0) <= 0
                  AND NOT EXISTS (
                    SELECT 1
                    FROM Detalle_Comanda dc
                    WHERE dc.ID_Comanda = Comandas.ID_Comanda
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM Pagos p
                    WHERE p.ID_Comanda = Comandas.ID_Comanda
                  );
            `,
            args: [idMesaBarra, sqlRef("new_id")],
        });

        const newId = await applyTenantHubTransaction<number>({
            env,
            tenantId: ctx.tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: ctx.deviceId,
            beginMode: "immediate",
            steps,
            resultKey: "new_id",

            /*
              Importante para sync:
              Cloud_Changes.Payload_Json debe guardar este envelope de dominio,
              no el payload SQL interno de TenantHub.
            */
            cloudPayload,

            /*
              Importante para idempotencia:
              el hash se calcula contra los argumentos de dominio.
            */
            requestPayload: cloudPayload,
        });

        const finalId = asNumber(newId, 0);

        return json(
            {
                ok: true,
                result: finalId,
                id_comanda: finalId,
                idComanda: finalId,
            },
            200,
            req,
        );
    } catch (e: any) {
        return handleVrWriteError(req, e);
    }
}