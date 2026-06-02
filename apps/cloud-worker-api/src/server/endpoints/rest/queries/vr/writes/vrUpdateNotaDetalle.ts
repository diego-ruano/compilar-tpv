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

const COMMAND_NAME = "vr.updateNotaDetalle";

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

async function detalleExists(db: Client, idDetalle: number): Promise<boolean> {
    const r = await db.execute({
        sql: `
            SELECT 1
            FROM Detalle_Comanda
            WHERE ID_Detalle = ?
            LIMIT 1;
        `,
        args: [idDetalle],
    });

    return Boolean(r.rows?.[0]);
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

export async function handleVrUpdateNotaDetalle(
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

        const idDetalle = asNumber(args.idDetalle ?? args.id_detalle ?? 0, 0);
        const notaRaw = args.nota ?? args.notas ?? null;
        const nota = String(notaRaw ?? "").trim();

        if (idDetalle <= 0) {
            return json({ ok: true, result: false, updated: false }, 200, req);
        }

        if (!(await detalleExists(ctx.tenantDb, idDetalle))) {
            return json({ ok: true, result: false, updated: false }, 200, req);
        }

        const domainArgs = {
            id_detalle: idDetalle,
            nota,
        };

        const cloudPayload = {
            op_id: opId,
            command_name: COMMAND_NAME,
            args: domainArgs,
        };

        const steps: TxStep[] = [
            {
                kind: "execute",
                sql: `
                    UPDATE Detalle_Comanda
                    SET Notas = NULLIF(?2, '')
                    WHERE ID_Detalle = ?1;
                `,
                args: [idDetalle, nota],
            },
            {
                kind: "value",
                saveAs: "updated_rows",
                sql: `SELECT changes();`,
                args: [],
            },
            {
                kind: "value",
                saveAs: "result_updated_rows",
                sql: `SELECT ?1;`,
                args: [sqlRef("updated_rows")],
            },
        ];

        const updatedRows = await applyTenantHubTransaction<number>({
            env,
            tenantId: ctx.tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: ctx.deviceId,
            beginMode: "immediate",
            steps,
            resultKey: "result_updated_rows",
            cloudPayload,
            requestPayload: cloudPayload,
        });

        const updated = asNumber(updatedRows, 0) > 0;

        return json(
            {
                ok: true,
                result: updated,
                updated,
            },
            200,
            req,
        );
    } catch (e: any) {
        return handleVrWriteError(req, e);
    }
}