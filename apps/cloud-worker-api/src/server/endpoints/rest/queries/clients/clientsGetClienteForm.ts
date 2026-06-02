// src/server/endpoints/rest/queries/clients/clientsGetClienteForm.ts

import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import { readJsonSafe, unwrapArgs } from "../../../../utils/tenantHubWrites";

type ClienteFormBody = {
    idCliente?: number;
    id_cliente?: number;
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

export async function handleClientsGetClienteForm(
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

        const db: Client = ctx.dbTenant;
        if (!ctx?.claims?.tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const rawBody = await readJsonSafe<any>(req, {});
        const body = unwrapArgs<ClienteFormBody>(rawBody);

        const idCliente = nI(body?.id_cliente ?? body?.idCliente, 0);

        if (idCliente <= 0) {
            return json({ ok: true, data: null }, 200, req);
        }

        const r = await db.execute({
            sql: `
				SELECT
					Nombre AS nombre,
					Email AS email,
					Telefono AS telefono,
					Notas AS notas
				FROM Clientes
				WHERE ID_Cliente = ?1
				LIMIT 1;
			`,
            args: [idCliente],
        });

        const row: any | undefined = (r.rows ?? [])[0] as any;
        if (!row) {
            return json({ ok: true, data: null }, 200, req);
        }

        return json(
            {
                ok: true,
                data: {
                    nombre: s(row.nombre),
                    email: normOpt(row.email),
                    telefono: normOpt(row.telefono),
                    notas: normOpt(row.notas),
                },
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}