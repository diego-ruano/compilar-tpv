import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";
import { ensureMesaBarraThroughTenantHub } from "../../../../utils/tenantHubBarra";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
    sqlRef,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "comandas.getOrCreateBarra";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.comandasGetOrCreateBarra",
    "comandas_get_or_create_barra",
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

export async function handleComandasGetOrCreateBarra(
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
        const deviceId = getDeviceIdFromContext(ctx);

        if (!tenantId || !deviceId) {
            return json({ ok: false, error: "invalid_token_claims" }, 401, req);
        }

        const { input: body, opId } = await readWriteRequest<any>(req, {
            id_trabajador: null,
            idTrabajador: null,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idTrabajadorRaw =
            body?.id_trabajador ?? body?.idTrabajador ?? null;

        const idTrabajador =
            idTrabajadorRaw == null
                ? null
                : asNumber(idTrabajadorRaw, 0) > 0
                    ? asNumber(idTrabajadorRaw, 0)
                    : null;

        const idMesaBarra = await ensureMesaBarraThroughTenantHub({
            env,
            tenantId,
            opId: `${opId}:ensure_mesa_barra`,
            commandName: "mesas.getOrCreateMesaBarra",
            deviceId,
        });

        const domainArgs = {
            id_trabajador: idTrabajador,
        };

        const cloudPayload = {
            op_id: opId,
            command_name: COMMAND_NAME,
            args: domainArgs,
        };

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "existing_id",
                sql: `
                    SELECT ID_Comanda
                    FROM Comandas
                    WHERE ID_Mesa = ?1
                      AND Estado = 'Abierta'
                    ORDER BY ID_Comanda DESC
                    LIMIT 1;
                `,
                args: [idMesaBarra],
            },
            {
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET ID_Trabajador = COALESCE(ID_Trabajador, ?2)
                    WHERE ID_Comanda = ?1
                      AND COALESCE(?1, 0) > 0;
                `,
                args: [sqlRef("existing_id"), idTrabajador],
            },
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
                    SELECT
                        datetime('now','localtime'),
                        'Abierta',
                        0,
                        ?2,
                        ?3
                    WHERE COALESCE(?1, 0) <= 0;
                `,
                args: [sqlRef("existing_id"), idTrabajador, idMesaBarra],
            },
            {
                kind: "value",
                saveAs: "id_comanda",
                sql: `
                    SELECT CASE
                        WHEN COALESCE(?1, 0) > 0 THEN ?1
                        ELSE last_insert_rowid()
                    END;
                `,
                args: [sqlRef("existing_id")],
            },
            {
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
                args: [idMesaBarra, sqlRef("id_comanda")],
            },
            {
                kind: "value",
                saveAs: "result_id_comanda",
                sql: `SELECT ?1;`,
                args: [sqlRef("id_comanda")],
            },
        ];

        const idComanda = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId,
            beginMode: "immediate",
            steps,
            resultKey: "result_id_comanda",
            cloudPayload,
            requestPayload: cloudPayload,
        });

        const finalId = asNumber(idComanda, 0);

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
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}