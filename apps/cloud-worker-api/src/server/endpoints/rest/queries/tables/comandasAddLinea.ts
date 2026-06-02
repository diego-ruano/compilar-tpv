import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
    sqlRef,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "comandas.addLinea";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.comandasAddLinea",
    "comandas_add_linea",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function n(v: unknown): number {
    const out = Number(v);
    return Number.isFinite(out) ? out : 0;
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

export async function handleComandasAddLinea(
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
            id_comanda: 0,
            idComanda: 0,
            id_producto: 0,
            idProducto: 0,
            cantidad: 1,
            precio: 0,
            precio_unitario: 0,
            id_usuario: null,
            idUsuario: null,
            id_trabajador: null,
            idTrabajador: null,
            id_detalle: null,
            idDetalle: null,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idComanda = Math.trunc(n(body?.id_comanda ?? body?.idComanda));
        const idProducto = Math.trunc(n(body?.id_producto ?? body?.idProducto));
        const cantidad = n(body?.cantidad ?? 1);
        const precio = n(body?.precio ?? body?.precio_unitario);
        const idDetalleForced = Math.trunc(n(body?.id_detalle ?? body?.idDetalle));

        const idUsuarioOrTrabajador = Math.trunc(
            n(
                body?.id_trabajador ??
                body?.idTrabajador ??
                body?.id_usuario ??
                body?.idUsuario,
            ),
        );

        if (idComanda <= 0 || idProducto <= 0) {
            return json({ ok: false, error: "bad_args" }, 400, req);
        }

        if (!Number.isFinite(cantidad) || cantidad <= 0) {
            return json({ ok: false, error: "bad_cantidad" }, 400, req);
        }

        if (!Number.isFinite(precio)) {
            return json({ ok: false, error: "bad_precio" }, 400, req);
        }

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "id_trabajador_real",
                sql: `
                    SELECT COALESCE(
                        (
                            SELECT ID_Trabajador
                            FROM Trabajadores
                            WHERE ?1 > 0
                              AND ID_Trabajador = ?1
                            LIMIT 1
                        ),
                        (
                            SELECT ID_Trabajador
                            FROM Trabajadores
                            WHERE ?1 > 0
                              AND ID_Usuario = ?1
                            LIMIT 1
                        )
                    );
                `,
                args: [idUsuarioOrTrabajador],
            },
            {
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET ID_Trabajador = ?2
                    WHERE ID_Comanda = ?1
                      AND Estado = 'Abierta'
                      AND COALESCE(?2, 0) > 0
                      AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0);
                `,
                args: [idComanda, sqlRef("id_trabajador_real")],
            },
        ];

        if (idDetalleForced > 0) {
            steps.push({
                kind: "execute",
                sql: `
                    INSERT OR IGNORE INTO Detalle_Comanda (
                        ID_Detalle,
                        ID_Comanda,
                        ID_Producto,
                        Cantidad,
                        Precio_Unitario,
                        Estado_Cocina
                    )
                    SELECT
                        ?1,
                        ?2,
                        ?3,
                        ?4,
                        ?5,
                        CASE
                            WHEN COALESCE(cat.Pasa_Cocina, 0) = 1 THEN 'PENDIENTE'
                            ELSE NULL
                        END
                    FROM Productos p
                    JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                    WHERE p.ID_Producto = ?3
                    LIMIT 1;
                `,
                args: [idDetalleForced, idComanda, idProducto, cantidad, precio],
            });
        } else {
            steps.push({
                kind: "execute",
                sql: `
                    INSERT INTO Detalle_Comanda (
                        ID_Comanda,
                        ID_Producto,
                        Cantidad,
                        Precio_Unitario,
                        Estado_Cocina
                    )
                    SELECT
                        ?1,
                        ?2,
                        ?3,
                        ?4,
                        CASE
                            WHEN COALESCE(cat.Pasa_Cocina, 0) = 1 THEN 'PENDIENTE'
                            ELSE NULL
                        END
                    FROM Productos p
                    JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
                    WHERE p.ID_Producto = ?2
                    LIMIT 1;
                `,
                args: [idComanda, idProducto, cantidad, precio],
            });
        }

        steps.push(
            {
                kind: "value",
                saveAs: "id_detalle",
                sql: `
                    SELECT CASE
                        WHEN COALESCE(?1, 0) > 0 THEN ?1
                        WHEN changes() > 0 THEN last_insert_rowid()
                        ELSE 0
                    END;
                `,
                args: [idDetalleForced],
            },
            {
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET Total_Comanda = (
                        SELECT IFNULL(
                            SUM(COALESCE(Cantidad, 1) * COALESCE(Precio_Unitario, 0)),
                            0
                        )
                        FROM Detalle_Comanda
                        WHERE ID_Comanda = ?1
                    )
                    WHERE ID_Comanda = ?1;
                `,
                args: [idComanda],
            },
        );

        const idDetalle = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "id_detalle",
        });

        const finalId = Number(idDetalle ?? 0);
        if (finalId <= 0) {
            return json({ ok: false, error: "detalle_not_inserted" }, 409, req);
        }

        return json(
            {
                ok: true,
                id_detalle: finalId,
                idDetalle: finalId,
                ID_Detalle: finalId,
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