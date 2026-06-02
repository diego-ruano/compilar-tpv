// src/server/endpoints/rest/queries/clients/clientsUpdateCliente.ts

import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    buildCommandCloudPayload,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "clients.updateCliente";

type UpdateClienteInput = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    idCliente?: number;
    id_cliente?: number;

    nombre?: string;
    email?: string | null;
    telefono?: string | null;
    notas?: string | null;
};

function s(v: any): string {
    return String(v ?? "").trim();
}

function normOpt(v: any): string | null {
    const t = s(v);
    return t.length ? t : null;
}

function nI(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function getHeaderOpId(req: Request): string {
    return String(req.headers.get("x-idempotency-key") || "").trim();
}

function getHeaderCommandName(req: Request): string {
    return String(req.headers.get("x-command-name") || "").trim();
}

function getRawBodyOpId(rawBody: any): string {
    return String(rawBody?.op_id ?? rawBody?.opId ?? "").trim();
}

function getRawBodyCommandName(rawBody: any): string {
    return String(rawBody?.command_name ?? rawBody?.commandName ?? "").trim();
}

async function clienteExists(db: Client, idCliente: number): Promise<boolean> {
    const r = await db.execute({
        sql: `
			SELECT 1 AS ok
			FROM Clientes
			WHERE ID_Cliente = ?1
			LIMIT 1;
		`,
        args: [idCliente],
    });

    return Boolean(r.rows?.[0]);
}

export async function handleClientsUpdateCliente(
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
            return unauthorized(req, "invalid_token_claims");
        }

        const {
            rawBody,
            input: body,
            opId,
            commandName,
        } = await readWriteRequest<UpdateClienteInput>(req, {
            idCliente: 0,
            id_cliente: 0,
            nombre: "",
            email: null,
            telefono: null,
            notas: null,
        });

        const headerOpId = getHeaderOpId(req);
        const rawBodyOpId = getRawBodyOpId(rawBody);

        if (headerOpId && rawBodyOpId && headerOpId !== rawBodyOpId) {
            return json({ ok: false, error: "op_id_mismatch" }, 409, req);
        }

        const opIdFinal = opId || headerOpId || rawBodyOpId;
        if (!opIdFinal) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const headerCommandName = getHeaderCommandName(req);
        const rawBodyCommandName = getRawBodyCommandName(rawBody);

        if (headerCommandName && headerCommandName !== COMMAND_NAME) {
            return json({ ok: false, error: "command_name_mismatch" }, 409, req);
        }

        if (rawBodyCommandName && rawBodyCommandName !== COMMAND_NAME) {
            return json({ ok: false, error: "command_name_mismatch" }, 409, req);
        }

        const commandNameFinal =
            commandName || headerCommandName || rawBodyCommandName;

        if (!commandNameFinal) {
            return json({ ok: false, error: "missing_command_name" }, 400, req);
        }

        if (commandNameFinal !== COMMAND_NAME) {
            return json({ ok: false, error: "command_name_mismatch" }, 409, req);
        }

        const idCliente = nI(body?.id_cliente ?? body?.idCliente, 0);
        if (idCliente <= 0) {
            return json({ ok: false, error: "id_cliente_required" }, 400, req);
        }

        const nombre = s(body?.nombre);
        if (!nombre) {
            return json({ ok: false, error: "nombre_required" }, 400, req);
        }

        const email = normOpt(body?.email);
        const telefono = normOpt(body?.telefono);
        const notas = normOpt(body?.notas);

        const domainArgs = {
            id_cliente: idCliente,
            nombre,
            email,
            telefono,
            notas,
        };

        const exists = await clienteExists(ctx.dbTenant, idCliente);
        if (!exists) {
            return json({ ok: false, error: "cliente_not_found" }, 404, req);
        }

        const affected = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId: opIdFinal,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: domainArgs,
            cloudPayload: buildCommandCloudPayload({
                opId: opIdFinal,
                commandName: COMMAND_NAME,
                args: domainArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    saveAs: "affected",
                    sql: `
						UPDATE Clientes
						SET
							Nombre = ?1,
							Telefono = ?2,
							Email = ?3,
							Notas = ?4
						WHERE ID_Cliente = ?5;
					`,
                    args: [nombre, telefono, email, notas, idCliente],
                },
            ],
            resultKey: "affected",
        });

        if (Number(affected) <= 0) {
            return json({ ok: false, error: "cliente_not_found" }, 404, req);
        }

        return json({ ok: true, data: true }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}