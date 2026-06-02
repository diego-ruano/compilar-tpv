import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    buildCommandCloudPayload,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

type AjusteLoteArgs = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    id_lote?: number;
    idLote?: number;
    stock_disponible?: number;
    stockDisponible?: number;
    notas?: string | null;
};

const COMMAND_NAME = "inventario.ajustarLote";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "inventario.ajustar_lote",
    "inventory.ajustarLote",
];

function normalizeText(value: unknown): string {
    return String(value ?? "").trim();
}

function normalizeOptionalText(value: unknown): string | null {
    const t = normalizeText(value);
    return t ? t : null;
}

function getHeaderOpId(req: Request): string {
    return normalizeText(req.headers.get("X-Idempotency-Key"));
}

function getHeaderCommandName(req: Request): string {
    return normalizeText(req.headers.get("X-Command-Name"));
}

function getRawBodyOpId(rawBody: any): string {
    return normalizeText(rawBody?.op_id ?? rawBody?.opId);
}

function getRawBodyCommandName(rawBody: any): string {
    return normalizeText(rawBody?.command_name ?? rawBody?.commandName);
}

function assertCommandNameAllowed(commandName: string): boolean {
    return COMMAND_ALIASES.includes(commandName);
}

async function loteExists(db: Client, idLote: number): Promise<boolean> {
    const r = await db.execute({
        sql: `
			SELECT 1 AS ok
			FROM Lotes_Producto
			WHERE ID_Lote = ?1
			LIMIT 1;
		`,
        args: [idLote],
    });

    return Boolean(r.rows?.[0]);
}

export async function handleInventarioAjustarLote(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const ctx: any = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );

        const tenantId = getTenantIdFromContext(ctx);
        if (!tenantId) {
            return json({ ok: false, error: "missing_tenant_id" }, 400, req);
        }

        const {
            rawBody,
            input: body,
            opId: bodyOpId,
        } = await readWriteRequest<AjusteLoteArgs>(req, {
            id_lote: 0,
            stock_disponible: 0,
        });

        const headerOpId = getHeaderOpId(req);
        const rawBodyOpId = getRawBodyOpId(rawBody);

        if (headerOpId && rawBodyOpId && headerOpId !== rawBodyOpId) {
            return json({ ok: false, error: "op_id_mismatch" }, 409, req);
        }

        const opId = normalizeText(bodyOpId || headerOpId || rawBodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const headerCommandName = getHeaderCommandName(req);
        const rawBodyCommandName = getRawBodyCommandName(rawBody);

        if (headerCommandName && !assertCommandNameAllowed(headerCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: headerCommandName,
                },
                409,
                req,
            );
        }

        if (rawBodyCommandName && !assertCommandNameAllowed(rawBodyCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: rawBodyCommandName,
                },
                409,
                req,
            );
        }

        const idLote = Number(body?.id_lote ?? body?.idLote ?? 0);
        const stockDisponible = Number(
            body?.stock_disponible ?? body?.stockDisponible ?? NaN,
        );

        if (!Number.isFinite(idLote) || idLote <= 0) {
            return json({ ok: false, error: "bad_id_lote" }, 400, req);
        }

        if (!Number.isFinite(stockDisponible) || stockDisponible < 0) {
            return json({ ok: false, error: "bad_stock_disponible" }, 400, req);
        }

        const notas = normalizeOptionalText(body?.notas);

        const exists = await loteExists(ctx.dbTenant, idLote);
        if (!exists) {
            return json({ ok: false, error: "lote_not_found" }, 404, req);
        }

        const domainArgs = {
            id_lote: idLote,
            stock_disponible: stockDisponible,
            notas,
        };

        const affected = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: domainArgs,
            cloudPayload: buildCommandCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: domainArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    saveAs: "affected",
                    sql: `
						UPDATE Lotes_Producto
						SET
							Stock_Disponible = ?1,
							Notas = COALESCE(NULLIF(?2, ''), Notas)
						WHERE ID_Lote = ?3;
					`,
                    args: [stockDisponible, notas, idLote],
                },
            ],
            resultKey: "affected",
        });

        if (Number(affected ?? 0) <= 0) {
            return json({ ok: false, error: "lote_not_found" }, 404, req);
        }

        return json({ ok: true, data: true }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}