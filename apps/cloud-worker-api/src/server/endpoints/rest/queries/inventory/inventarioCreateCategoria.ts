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

type UpsertCategoriaArgs = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    id_categoria?: number | null;
    idCategoria?: number | null;

    nombre?: string;
    nombre_imagen?: string | null;
    nombreImagen?: string | null;
    ruta_imagen?: string | null;
    rutaImagen?: string | null;
    vendible?: boolean | number | string | null;
    pasa_cocina?: boolean | number | string | null;
    pasaCocina?: boolean | number | string | null;
};

const COMMAND_NAME = "inventario.createCategoria";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "inventario.create_categoria",
    "inventory.createCategoria",
];

function normalizeText(value: unknown): string {
    return String(value ?? "").trim();
}

function normalizeOptionalText(value: unknown): string | null {
    const t = normalizeText(value);
    return t ? t : null;
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;

    const s = String(value ?? "").trim().toLowerCase();
    if (!s) return fallback;

    if (["1", "true", "t", "yes", "y", "si", "sí"].includes(s)) return true;
    if (["0", "false", "f", "no", "n"].includes(s)) return false;

    return fallback;
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

async function nextCategoriaId(db: Client): Promise<number> {
    const r = await db.execute({
        sql: `
			SELECT COALESCE(MAX(ID_Categoria), 0) + 1 AS next_id
			FROM Categorias_Producto;
		`,
        args: [],
    });

    const row: any = r.rows?.[0] ?? {};
    const n = Number(row.next_id ?? 1);

    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

export async function handleInventarioCreateCategoria(
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
        } = await readWriteRequest<UpsertCategoriaArgs>(req, {
            nombre: "",
            nombre_imagen: "",
            ruta_imagen: "",
            vendible: true,
            pasa_cocina: false,
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

        const nombre = normalizeText(body?.nombre);
        if (!nombre) {
            return json({ ok: false, error: "nombre_required" }, 400, req);
        }

        const requestedIdCategoria = normalizePositiveIntOrNull(
            body?.id_categoria ?? body?.idCategoria,
        );

        const idCategoria =
            requestedIdCategoria ?? (await nextCategoriaId(ctx.dbTenant));

        const nombreImagen =
            normalizeOptionalText(body?.nombre_imagen ?? body?.nombreImagen) ?? "";

        const rutaImagen =
            normalizeOptionalText(body?.ruta_imagen ?? body?.rutaImagen) ?? "";

        const vendible = normalizeBoolean(body?.vendible, true);
        const pasaCocina = normalizeBoolean(
            body?.pasa_cocina ?? body?.pasaCocina,
            false,
        );

        const requestArgs = {
            id_categoria: requestedIdCategoria,
            nombre,
            nombre_imagen: nombreImagen,
            ruta_imagen: rutaImagen,
            vendible,
            pasa_cocina: pasaCocina,
        };

        const cloudArgs = {
            id_categoria: idCategoria,
            nombre,
            nombre_imagen: nombreImagen,
            ruta_imagen: rutaImagen,
            vendible,
            pasa_cocina: pasaCocina,
        };

        await applyTenantHubTransaction<number>({
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
						INSERT INTO Categorias_Producto
							(ID_Categoria, Nombre, Nombre_Imagen, Ruta_Imagen, Vendible, Pasa_Cocina)
						VALUES
							(?1, ?2, ?3, ?4, ?5, ?6)
						ON CONFLICT(ID_Categoria) DO UPDATE SET
							Nombre = excluded.Nombre,
							Nombre_Imagen = excluded.Nombre_Imagen,
							Ruta_Imagen = excluded.Ruta_Imagen,
							Vendible = excluded.Vendible,
							Pasa_Cocina = excluded.Pasa_Cocina;
					`,
                    args: [
                        idCategoria,
                        nombre,
                        nombreImagen,
                        rutaImagen,
                        vendible ? 1 : 0,
                        pasaCocina ? 1 : 0,
                    ],
                },
                {
                    kind: "value",
                    saveAs: "id_categoria",
                    sql: `
						SELECT ID_Categoria
						FROM Categorias_Producto
						WHERE ID_Categoria = ?1
						LIMIT 1;
					`,
                    args: [idCategoria],
                },
            ],
            resultKey: "id_categoria",
        });

        return json({ ok: true, data: { id_categoria: idCategoria } }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}