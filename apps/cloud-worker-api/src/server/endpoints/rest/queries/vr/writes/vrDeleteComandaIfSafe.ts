import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../../utils/response";
import {
    applyTenantHubTransaction,
    readWriteRequest,
    sqlRef,
    type TxStep,
} from "../../../../../utils/tenantHubWrites";

const COMMAND_NAME = "vr.deleteComandaIfSafe";

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

function pickTenantDb(ctx: any): Client {
    const db =
        (ctx?.dbTenant as Client) ||
        (ctx?.db as Client) ||
        (ctx?.tenantDb as Client) ||
        (ctx?.client as Client);

    if (!db) throw new Error("tenant_db_missing");
    return db;
}

async function getComandaDeleteState(
    db: Client,
    idComanda: number,
): Promise<{ exists: boolean; hasPaid: boolean }> {
    const r = await db.execute({
        sql: `
            SELECT
              CASE WHEN EXISTS (
                SELECT 1 FROM Comandas WHERE ID_Comanda = ?
              ) THEN 1 ELSE 0 END AS exists_value,
              CASE WHEN EXISTS (
                SELECT 1
                FROM Detalle_Comanda dc
                JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
                WHERE dc.ID_Comanda = ?
              ) THEN 1 ELSE 0 END AS has_paid;
        `,
        args: [idComanda, idComanda],
    });

    const row = r.rows?.[0] as any | undefined;
    return {
        exists: asNumber(row?.exists_value ?? row?.EXISTS_VALUE ?? 0, 0) === 1,
        hasPaid: asNumber(row?.has_paid ?? row?.HAS_PAID ?? 0, 0) === 1,
    };
}

async function buildVrWriteContext(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<{ tenantId: string; deviceId: string; tenantDb: Client }> {
    const ctx = await buildTenantContext(req, env, dbCentral, createDbClient);

    const tenantId = String(ctx?.claims?.tenantId ?? "").trim();
    const deviceId = String(ctx?.claims?.deviceId ?? "").trim();

    if (!tenantId || !deviceId) {
        throw new Error("invalid_token_claims");
    }

    const role = await getDeviceRole(dbCentral, tenantId, deviceId);
    if (!role) throw new Error("device_not_registered");

    if (role !== "tpv") throw new Error("forbidden_not_tpv");

    return { tenantId, deviceId, tenantDb: pickTenantDb(ctx) };
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

export async function handleVrDeleteComandaIfSafe(
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

        const idComanda = asNumber(args.idComanda ?? args.id_comanda ?? 0, 0);

        if (idComanda <= 0) {
            return json(
                {
                    ok: true,
                    result: false,
                    deleted: false,
                },
                200,
                req,
            );
        }

        const state = await getComandaDeleteState(ctx.tenantDb, idComanda);

        if (!state.exists || state.hasPaid) {
            return json(
                {
                    ok: true,
                    result: false,
                    deleted: false,
                    reason: state.hasPaid ? "has_paid_lines" : "not_found",
                },
                200,
                req,
            );
        }

        const domainArgs = {
            id_comanda: idComanda,
        };

        const cloudPayload = {
            op_id: opId,
            command_name: COMMAND_NAME,
            args: domainArgs,
        };

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "has_paid",
                sql: `
                    SELECT CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM Detalle_Comanda dc
                            JOIN Pago_Detalles pd
                              ON pd.ID_Detalle = dc.ID_Detalle
                            WHERE dc.ID_Comanda = ?1
                            LIMIT 1
                        )
                        THEN 1
                        ELSE 0
                    END;
                `,
                args: [idComanda],
            },
            {
                kind: "execute",
                sql: `
                    DELETE FROM Detalle_Comanda
                    WHERE ID_Comanda = ?1
                      AND COALESCE(?2, 0) = 0;
                `,
                args: [idComanda, sqlRef("has_paid")],
            },
            {
                kind: "execute",
                sql: `
                    DELETE FROM Comandas
                    WHERE ID_Comanda = ?1
                      AND COALESCE(?2, 0) = 0;
                `,
                args: [idComanda, sqlRef("has_paid")],
            },
            {
                kind: "value",
                saveAs: "ok_value",
                sql: `
                    SELECT CASE
                        WHEN COALESCE(?1, 0) = 0 THEN 1
                        ELSE 0
                    END;
                `,
                args: [sqlRef("has_paid")],
            },
        ];

        const okValue = await applyTenantHubTransaction<number>({
            env,
            tenantId: ctx.tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: ctx.deviceId,
            beginMode: "immediate",
            steps,
            resultKey: "ok_value",
            cloudPayload,
            requestPayload: cloudPayload,
        });

        const deleted = asNumber(okValue, 0) === 1;

        return json(
            {
                ok: true,
                result: deleted,
                deleted,
            },
            200,
            req,
        );
    } catch (e: any) {
        return handleVrWriteError(req, e);
    }
}