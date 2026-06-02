import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "reservas.setEstado";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.reservasSetEstado",
    "reservas_set_estado",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function validateCommandName(req: Request): Response | null {
    const raw = s(req.headers.get("X-Command-Name"));
    if (!raw) return null;

    if (!COMMAND_ALIASES.includes(raw)) {
        return json(
            {
                ok: false,
                error: "bad_command_name",
                expected: COMMAND_NAME,
                got: raw,
            },
            409,
            req,
        );
    }

    return null;
}

function normalizeEstado(raw: any): string {
    const estado = String(raw || "").trim().toUpperCase();

    if (estado === "NO_SHOW" || estado === "NOSHOW") return "NO_SHOW";
    if (estado === "FINALIZADA") return "FINALIZADA";
    if (estado === "CANCELADA") return "CANCELADA";
    if (estado === "ACTIVA") return "ACTIVA";
    if (estado === "PROXIMA") return "PROXIMA";

    return "";
}

export async function handleReservasSetEstado(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const commandError = validateCommandName(req);
        if (commandError) return commandError;

        const ctx: any = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );

        const tenantId = getTenantIdFromContext(ctx);

        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const { input: body, opId } = await readWriteRequest<any>(req, {
            id_reserva: 0,
            idReserva: 0,
            estado: "",
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idReserva = Number(body?.id_reserva ?? body?.idReserva ?? 0);
        const estado = normalizeEstado(body?.estado);

        if (!Number.isFinite(idReserva) || idReserva <= 0) {
            return json({ ok: false, error: "bad_id_reserva" }, 400, req);
        }

        if (!estado) {
            return json({ ok: false, error: "bad_estado" }, 400, req);
        }

        const steps: TxStep[] = [
            {
                kind: "execute",
                sql: `
                    UPDATE Reservas
                    SET Estado = ?2
                    WHERE ID_Reserva = ?1;
                `,
                args: [idReserva, estado],
            },
        ];

        if (
            estado === "FINALIZADA" ||
            estado === "CANCELADA" ||
            estado === "NO_SHOW"
        ) {
            steps.push({
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET ID_Reserva = NULL
                    WHERE ID_Reserva = ?1;
                `,
                args: [idReserva],
            });
        }

        await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps: [
                ...steps,
                {
                    kind: "value",
                    saveAs: "ok_value",
                    sql: `SELECT 1;`,
                    args: [],
                },
            ],
            resultKey: "ok_value",
        });

        return json({ ok: true, result: "OK", data: "OK" }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}