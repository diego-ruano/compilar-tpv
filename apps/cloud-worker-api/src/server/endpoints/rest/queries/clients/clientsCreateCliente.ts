// src/server/endpoints/rest/queries/clients/clientsCreateCliente.ts

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

const COMMAND_NAME = "clients.createCliente";

type CreateClienteInput = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    id_cliente?: number | null;
    idCliente?: number | null;

    nombre?: string;
    email?: string | null;
    telefono?: string | null;
    notas?: string | null;
};

type CreatedClienteResult = {
    id_cliente?: number;
    idCliente?: number;
    ID_Cliente?: number;
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

async function nextClienteId(db: Client): Promise<number> {
    const r = await db.execute({
        sql: `
			SELECT COALESCE(MAX(ID_Cliente), 0) + 1 AS next_id
			FROM Clientes;
		`,
        args: [],
    });

    const row: any = r.rows?.[0] ?? {};
    const nextId = nI(row.next_id, 1);

    return nextId > 0 ? nextId : 1;
}

export async function handleClientsCreateCliente(
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
        } = await readWriteRequest<CreateClienteInput>(req, {
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

        const nombre = s(body?.nombre);
        if (!nombre) {
            return json({ ok: false, error: "nombre_required" }, 400, req);
        }

        const requestedIdCliente = nI(body?.id_cliente ?? body?.idCliente, 0);
        const idCliente =
            requestedIdCliente > 0
                ? requestedIdCliente
                : await nextClienteId(ctx.dbTenant);

        const email = normOpt(body?.email);
        const telefono = normOpt(body?.telefono);
        const notas = normOpt(body?.notas);

        const requestArgs = {
            id_cliente: requestedIdCliente > 0 ? requestedIdCliente : null,
            nombre,
            email,
            telefono,
            notas,
        };

        const cloudArgs = {
            id_cliente: idCliente,
            nombre,
            email,
            telefono,
            notas,
        };

        const result = await applyTenantHubTransaction<CreatedClienteResult>({
            env,
            tenantId,
            opId: opIdFinal,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: requestArgs,
            cloudPayload: buildCommandCloudPayload({
                opId: opIdFinal,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    sql: `
						INSERT INTO Clientes (
							ID_Cliente,
							Nombre,
							Telefono,
							Email,
							Notas,
							Created_At
						)
						VALUES (
							?1,
							?2,
							?3,
							?4,
							?5,
							datetime('now','localtime')
						)
						ON CONFLICT(ID_Cliente) DO UPDATE SET
							Nombre = excluded.Nombre,
							Telefono = excluded.Telefono,
							Email = excluded.Email,
							Notas = excluded.Notas;
					`,
                    args: [idCliente, nombre, telefono, email, notas],
                },
                {
                    kind: "row",
                    saveAs: "cliente",
                    sql: `
						SELECT ID_Cliente AS id_cliente
						FROM Clientes
						WHERE ID_Cliente = ?1
						LIMIT 1;
					`,
                    args: [idCliente],
                },
            ],
            resultKey: "cliente",
        });

        const finalId = nI(
            result?.id_cliente ?? result?.idCliente ?? result?.ID_Cliente,
            idCliente,
        );

        if (!(finalId > 0)) {
            return json({ ok: false, error: "cliente_create_failed" }, 500, req);
        }

        return json(
            {
                ok: true,
                data: {
                    id_cliente: finalId,
                },
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}