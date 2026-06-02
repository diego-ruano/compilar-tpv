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

type CreateLoteArgs = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    id_lote?: number | null;
    idLote?: number | null;

    id_producto?: number;
    idProducto?: number;
    codigo_lote?: string;
    codigoLote?: string;
    caducidad?: string | null;
    cantidad_inicial?: number;
    cantidadInicial?: number;
    stock_disponible?: number | null;
    stockDisponible?: number | null;
    fecha_entrada?: string | null;
    fechaEntrada?: string | null;
    coste_unitario?: number | null;
    costeUnitario?: number | null;
    id_proveedor?: number | null;
    idProveedor?: number | null;
    notas?: string | null;
};

const COMMAND_NAME = "inventario.createLote";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "inventario.create_lote",
    "inventory.createLote",
];

function normalizeText(value: unknown): string {
    return String(value ?? "").trim();
}

function normalizeOptionalText(value: unknown): string | null {
    const t = normalizeText(value);
    return t ? t : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;

    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizePositiveIntOrNull(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
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

async function nextLoteId(db: Client): Promise<number> {
    const r = await db.execute({
        sql: `
			SELECT COALESCE(MAX(ID_Lote), 0) + 1 AS next_id
			FROM Lotes_Producto;
		`,
        args: [],
    });

    const row: any = r.rows?.[0] ?? {};
    const n = Number(row.next_id ?? 1);

    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

export async function handleInventarioCreateLote(
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
        } = await readWriteRequest<CreateLoteArgs>(req, {
            id_producto: 0,
            codigo_lote: "",
            cantidad_inicial: 0,
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

        const requestedIdLote = normalizePositiveIntOrNull(
            body?.id_lote ?? body?.idLote,
        );

        const idLote = requestedIdLote ?? (await nextLoteId(ctx.dbTenant));

        const idProducto = Number(body?.id_producto ?? body?.idProducto ?? 0);
        const codigoLote = normalizeText(body?.codigo_lote ?? body?.codigoLote);
        const cantidadInicial = Number(
            body?.cantidad_inicial ?? body?.cantidadInicial ?? NaN,
        );

        if (!Number.isFinite(idProducto) || idProducto <= 0) {
            return json({ ok: false, error: "bad_id_producto" }, 400, req);
        }

        if (!codigoLote) {
            return json({ ok: false, error: "codigo_lote_required" }, 400, req);
        }

        if (!Number.isFinite(cantidadInicial) || cantidadInicial < 0) {
            return json({ ok: false, error: "bad_cantidad_inicial" }, 400, req);
        }

        const stockDisponible =
            body?.stock_disponible == null && body?.stockDisponible == null
                ? cantidadInicial
                : Number(body?.stock_disponible ?? body?.stockDisponible);

        if (!Number.isFinite(stockDisponible) || stockDisponible < 0) {
            return json({ ok: false, error: "bad_stock_disponible" }, 400, req);
        }

        const fechaEntrada = normalizeOptionalText(
            body?.fecha_entrada ?? body?.fechaEntrada,
        );

        const caducidad = normalizeOptionalText(body?.caducidad);

        const costeUnitario = normalizeOptionalNumber(
            body?.coste_unitario ?? body?.costeUnitario,
        );

        const idProveedor = normalizeOptionalNumber(
            body?.id_proveedor ?? body?.idProveedor,
        );

        const notas = normalizeOptionalText(body?.notas);

        const requestArgs = {
            id_lote: requestedIdLote,
            id_producto: idProducto,
            codigo_lote: codigoLote,
            caducidad,
            cantidad_inicial: cantidadInicial,
            stock_disponible: stockDisponible,
            fecha_entrada: fechaEntrada,
            coste_unitario: costeUnitario,
            id_proveedor: idProveedor,
            notas,
        };

        const cloudArgs = {
            ...requestArgs,
            id_lote: idLote,
        };

        await applyTenantHubTransaction({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: requestArgs,
            cloudPayload: buildCommandCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    sql: `
						INSERT INTO Lotes_Producto
							(
								ID_Lote,
								ID_Producto,
								Codigo_Lote,
								Fecha_Entrada,
								Caducidad,
								Cantidad_Inicial,
								Stock_Disponible,
								Coste_Unitario,
								ID_Proveedor,
								Notas
							)
						VALUES
							(
								?1,
								?2,
								?3,
								COALESCE(NULLIF(?4, ''), datetime('now','localtime')),
								NULLIF(?5, ''),
								?6,
								?7,
								?8,
								?9,
								?10
							)
						ON CONFLICT(ID_Lote) DO UPDATE SET
							ID_Producto = excluded.ID_Producto,
							Codigo_Lote = excluded.Codigo_Lote,
							Fecha_Entrada = excluded.Fecha_Entrada,
							Caducidad = excluded.Caducidad,
							Cantidad_Inicial = excluded.Cantidad_Inicial,
							Stock_Disponible = excluded.Stock_Disponible,
							Coste_Unitario = excluded.Coste_Unitario,
							ID_Proveedor = excluded.ID_Proveedor,
							Notas = excluded.Notas;
					`,
                    args: [
                        idLote,
                        idProducto,
                        codigoLote,
                        fechaEntrada,
                        caducidad,
                        cantidadInicial,
                        stockDisponible,
                        costeUnitario,
                        idProveedor,
                        notas,
                    ],
                },
                {
                    kind: "row",
                    saveAs: "lote",
                    sql: `
						SELECT ID_Lote AS id_lote
						FROM Lotes_Producto
						WHERE ID_Lote = ?1
						LIMIT 1;
					`,
                    args: [idLote],
                },
            ],
            resultKey: "lote",
        });

        return json({ ok: true, data: { id_lote: idLote } }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}