import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import { ensureMesaBarraThroughTenantHub } from "../../../../utils/tenantHubBarra";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "comandas.createBarra";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.comandasCreateBarra",
    "comandas_create_barra",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function asNumber(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
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

export async function handleComandasCreateBarra(
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
            id_trabajador: null as number | null,
            idTrabajador: null as number | null,
            id_comanda: null as number | null,
            idComanda: null as number | null,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const deviceId = getDeviceIdFromContext(ctx);

        const idTrabajador =
            Number(body?.id_trabajador ?? body?.idTrabajador ?? 0) || null;

        const idComandaForced =
            Number(body?.id_comanda ?? body?.idComanda ?? 0) || null;

        const idMesaBarra = await ensureMesaBarraThroughTenantHub({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId,
        });

        const idComanda = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId,
            beginMode: "immediate",
            steps:
                idComandaForced && idComandaForced > 0
                    ? [
                        {
                            kind: "execute",
                            sql: `
                                  INSERT OR IGNORE INTO Comandas (
                                    ID_Comanda,
                                    ID_Mesa,
                                    ID_Trabajador,
                                    Fecha_Hora_Apertura,
                                    Total_Comanda,
                                    Estado
                                  )
                                  VALUES (
                                    ?1,
                                    ?2,
                                    ?3,
                                    datetime('now','localtime'),
                                    0,
                                    'Abierta'
                                  );
                              `,
                            args: [idComandaForced, idMesaBarra, idTrabajador],
                        },
                        {
                            kind: "value",
                            saveAs: "new_id",
                            sql: `SELECT ?1;`,
                            args: [idComandaForced],
                        },
                    ]
                    : [
                        {
                            kind: "execute",
                            sql: `
                                  INSERT INTO Comandas (
                                    ID_Mesa,
                                    ID_Trabajador,
                                    Fecha_Hora_Apertura,
                                    Total_Comanda,
                                    Estado
                                  )
                                  VALUES (
                                    ?1,
                                    ?2,
                                    datetime('now','localtime'),
                                    0,
                                    'Abierta'
                                  );
                              `,
                            args: [idMesaBarra, idTrabajador],
                        },
                        {
                            kind: "value",
                            saveAs: "new_id",
                            sql: `SELECT last_insert_rowid();`,
                            args: [],
                        },
                    ],
            resultKey: "new_id",
        });

        const finalId = asNumber(idComanda, 0);
        if (!(finalId > 0)) {
            throw new Error("No se pudo crear comanda BARRA.");
        }

        return json(finalId, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}