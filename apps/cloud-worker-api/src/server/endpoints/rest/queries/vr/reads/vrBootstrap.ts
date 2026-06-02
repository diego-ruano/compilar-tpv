// src/server/endpoints/rest/queries/ventaRapida/vrBootstrap.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../../middleware/withTenant";
import { createDbClient } from "../../../../../db/clients";
import { json, serverError } from "../../../../../utils/response";
import { ensureMesaBarraThroughTenantHub } from "../../../../../utils/tenantHubBarra";
import {
	applyTenantHubTransaction,
	getDeviceIdFromContext,
	getTenantIdFromContext,
	readWriteRequest,
	sqlRef,
	type TxStep,
} from "../../../../../utils/tenantHubWrites";

const COMMAND_NAME = "comandas.getOrCreateBarra";

export type CategoriaRow = {
	ID_Categoria: number;
	Nombre: string;
	Nombre_Imagen: string | null;
	Ruta_Imagen: string | null;
	Vendible: number | null;
};

export type LineaComandaRow = {
	ID_Detalle: number;
	ID_Comanda: number;
	ID_Producto: number;
	Cantidad: number;
	Precio_Unitario: number;
	Notas: string | null;
	Estado_Cocina: string | null;
	Pagado: number;
	Nombre: string;
};

function asNumber(v: any, fallback = 0): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function pickTenantDb(ctx: any): Client {
	const db =
		(ctx?.dbTenant as Client) ||
		(ctx?.db as Client) ||
		(ctx?.tenantDb as Client) ||
		(ctx?.client as Client);

	if (!db) {
		throw new Error("tenant_db_missing");
	}

	return db;
}

async function readCategoriasVendibles(db: Client): Promise<CategoriaRow[]> {
	const r = await db.execute({
		sql: `
            SELECT
                ID_Categoria,
                Nombre,
                Nombre_Imagen,
                Ruta_Imagen,
                Vendible
            FROM Categorias_Producto
            WHERE COALESCE(Vendible, 1) = 1
            ORDER BY Nombre ASC;
        `,
		args: [],
	});

	return (r.rows || []).map((row: any) => ({
		ID_Categoria: Number(row.ID_Categoria || 0),
		Nombre: String(row.Nombre || ""),
		Nombre_Imagen:
			row.Nombre_Imagen == null ? null : String(row.Nombre_Imagen),
		Ruta_Imagen:
			row.Ruta_Imagen == null ? null : String(row.Ruta_Imagen),
		Vendible:
			row.Vendible === null || row.Vendible === undefined
				? null
				: Number(row.Vendible),
	}));
}

async function readLineasComanda(
	db: Client,
	idComanda: number,
): Promise<LineaComandaRow[]> {
	if (!(idComanda > 0)) return [];

	const r = await db.execute({
		sql: `
            SELECT
                dc.ID_Detalle,
                dc.ID_Comanda,
                dc.ID_Producto,
                COALESCE(dc.Cantidad, 1) AS Cantidad,
                COALESCE(dc.Precio_Unitario, 0) AS Precio_Unitario,
                dc.Notas,
                dc.Estado_Cocina,
                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM Pago_Detalles pd
                        WHERE pd.ID_Detalle = dc.ID_Detalle
                    )
                    THEN 1
                    ELSE 0
                END AS Pagado,
                COALESCE(p.Nombre, 'Producto') AS Nombre
            FROM Detalle_Comanda dc
            LEFT JOIN Productos p
              ON p.ID_Producto = dc.ID_Producto
            WHERE dc.ID_Comanda = ?1
            ORDER BY dc.ID_Detalle ASC;
        `,
		args: [idComanda],
	});

	return (r.rows || []).map((row: any) => ({
		ID_Detalle: Number(row.ID_Detalle || 0),
		ID_Comanda: Number(row.ID_Comanda || 0),
		ID_Producto: Number(row.ID_Producto || 0),
		Cantidad: Number(row.Cantidad ?? 1),
		Precio_Unitario: Number(row.Precio_Unitario ?? 0),
		Notas: row.Notas == null ? null : String(row.Notas),
		Estado_Cocina:
			row.Estado_Cocina == null ? null : String(row.Estado_Cocina),
		Pagado: Number(row.Pagado || 0),
		Nombre: String(row.Nombre || "Producto"),
	}));
}

export async function handleVrBootstrap(
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
		const deviceId = getDeviceIdFromContext(ctx);

		if (!tenantId || !deviceId) {
			return json({ ok: false, error: "invalid_token_claims" }, 401, req);
		}

		const db = pickTenantDb(ctx);

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
                      AND COALESCE(Total_Comanda, 0) <= 0
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

		const idComandaRaw = await applyTenantHubTransaction<number>({
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

		const idComanda = asNumber(idComandaRaw, 0);

		const categorias = await readCategoriasVendibles(db);
		const lineas = await readLineasComanda(db, idComanda);

		const result = {
			id_comanda: idComanda,
			idComanda,
			categorias,
			lineas,
		};

		return json(
			{
				ok: true,
				result,
				...result,
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