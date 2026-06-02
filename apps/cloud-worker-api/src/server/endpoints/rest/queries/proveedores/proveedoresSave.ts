import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError, unauthorized } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

type ProveedorSaveInput = {
    op_id?: string;
    opId?: string;

    idProveedor?: number | null;
    id_proveedor?: number | null;

    nombreEmpresa?: string;
    nombre_empresa?: string;

    contacto?: string | null;
    telefono?: string | null;
    email?: string | null;
    cif?: string | null;

    informacionAdicional?: string | null;
    informacion_adicional?: string | null;

    nombreImagen?: string | null;
    nombre_imagen?: string | null;

    rutaImagen?: string | null;
    ruta_imagen?: string | null;
};

const COMMAND_NAME = "proveedores.save";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "proveedores.upsert",
    "proveedores_save",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function trimOrNull(v: unknown): string | null {
    const out = s(v);
    return out ? out : null;
}

function resolveOpId(req: Request, input: any, opIdFromBody: string): string {
    const fromBody = s(opIdFromBody || input?.op_id || input?.opId);
    if (fromBody) return fromBody;

    const fromHeader = s(req.headers.get("X-Idempotency-Key"));
    if (fromHeader) return fromHeader;

    return "";
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

function buildCloudPayload(params: {
    opId: string;
    commandName: string;
    args: Record<string, any>;
}) {
    return {
        op_id: params.opId,
        command_name: params.commandName,
        args: params.args,
    };
}

async function nextTableId(
    db: Client,
    table: string,
    column: string,
): Promise<number> {
    const r = await db.execute({
        sql: `SELECT COALESCE(MAX(${column}), 0) + 1 AS next_id FROM ${table};`,
        args: [],
    });

    const n = Number((r.rows?.[0] as any)?.next_id ?? 1);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

export async function handleProveedoresSave(
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

        const db: Client = ctx.dbTenant;

        const { input, opId: bodyOpId } =
            await readWriteRequest<ProveedorSaveInput>(req, {});

        const opId = resolveOpId(req, input, bodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idProveedorRaw = input?.idProveedor ?? input?.id_proveedor ?? null;

        const requestedIdProveedor =
            idProveedorRaw == null ? null : Number(idProveedorRaw);

        if (
            requestedIdProveedor !== null &&
            (!Number.isFinite(requestedIdProveedor) || requestedIdProveedor <= 0)
        ) {
            return json({ ok: false, error: "id_proveedor_invalido" }, 400, req);
        }

        const nombreEmpresa = s(input?.nombreEmpresa ?? input?.nombre_empresa);

        if (!nombreEmpresa) {
            return json({ ok: false, error: "nombre_empresa_required" }, 400, req);
        }

        const contacto = trimOrNull(input?.contacto);
        const telefono = trimOrNull(input?.telefono);
        const email = trimOrNull(input?.email);
        const cif = trimOrNull(input?.cif);
        const informacionAdicional = trimOrNull(
            input?.informacionAdicional ?? input?.informacion_adicional,
        );
        const nombreImagen = trimOrNull(
            input?.nombreImagen ?? input?.nombre_imagen,
        );
        const rutaImagen = trimOrNull(input?.rutaImagen ?? input?.ruta_imagen);

        const idProveedor =
            requestedIdProveedor ??
            (await nextTableId(db, "Proveedores", "ID_Proveedor"));

        const requestArgs = {
            id_proveedor: requestedIdProveedor,
            nombre_empresa: nombreEmpresa,
            contacto,
            telefono,
            email,
            cif,
            informacion_adicional: informacionAdicional,
            nombre_imagen: nombreImagen,
            ruta_imagen: rutaImagen,
        };

        const cloudArgs = {
            id_proveedor: idProveedor,
            nombre_empresa: nombreEmpresa,
            contacto,
            telefono,
            email,
            cif,
            informacion_adicional: informacionAdicional,
            nombre_imagen: nombreImagen,
            ruta_imagen: rutaImagen,
        };

        const steps: TxStep[] = [
            {
                kind: "execute",
                sql: `
					INSERT INTO Proveedores (
						ID_Proveedor,
						Nombre_Empresa,
						Contacto,
						Telefono,
						Email,
						CIF,
						Informacion_adicional,
						Nombre_Imagen,
						Ruta_Imagen
					)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
					ON CONFLICT(ID_Proveedor) DO UPDATE SET
						Nombre_Empresa = excluded.Nombre_Empresa,
						Contacto = excluded.Contacto,
						Telefono = excluded.Telefono,
						Email = excluded.Email,
						CIF = excluded.CIF,
						Informacion_adicional = excluded.Informacion_adicional,
						Nombre_Imagen = excluded.Nombre_Imagen,
						Ruta_Imagen = excluded.Ruta_Imagen;
				`,
                args: [
                    idProveedor,
                    nombreEmpresa,
                    contacto,
                    telefono,
                    email,
                    cif,
                    informacionAdicional,
                    nombreImagen,
                    rutaImagen,
                ],
            },
            {
                kind: "value",
                saveAs: "id_proveedor",
                sql: `SELECT ?1 AS id_proveedor;`,
                args: [idProveedor],
            },
        ];

        const txPayload = {
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            requestPayload: requestArgs,
            cloudPayload: buildCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),
            beginMode: "immediate" as const,
            steps,
            resultKey: "id_proveedor",
        };

        const resultId = await applyTenantHubTransaction<number>(txPayload);

        return json(
            {
                ok: true,
                data: {
                    id_proveedor: Number(resultId || idProveedor),
                },
                result: {
                    id_proveedor: Number(resultId || idProveedor),
                },
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}