// src/domains/cuentas/cuentas.queries.ts

import type { Client } from "@libsql/client/web";

import type { EntradaDto, SalidaDto } from "@tpv/contracts";

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

function rangoWhere(del: string | null, al: string | null, fechaExpr: string) {
	const parts: string[] = [];
	const args: string[] = [];
	if (del) {
		args.push(del);
		parts.push(`date(${fechaExpr}) >= date(?${args.length})`);
	}
	if (al) {
		args.push(al);
		parts.push(`date(${fechaExpr}) <= date(?${args.length})`);
	}
	return { whereSql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
}

export async function entradas(
	db: Client,
	del: string | null,
	al: string | null,
): Promise<EntradaDto[]> {
	const { whereSql, args } = rangoWhere(del, al, "p.Fecha_Hora");
	const rs = await db.execute({
		sql: `
			SELECT
				CAST(p.ID_Pago AS TEXT) AS id,
				substr(p.Fecha_Hora, 1, 16) AS fecha_hora,
				(
					CASE
						WHEN m.Numero_Mesa = 'BARRA' THEN 'Take away'
						WHEN m.Numero_Mesa IS NOT NULL AND m.Numero_Mesa <> '' THEN 'Mesa ' || m.Numero_Mesa
						ELSE 'Venta'
					END
					||
					CASE
						WHEN cl.Nombre IS NOT NULL AND cl.Nombre <> '' THEN ' / ' || cl.Nombre
						ELSE ''
					END
				) AS cliente,
				CASE WHEN p.Metodo_Pago = 'Tarjeta' THEN 'Tarjeta' ELSE 'Efectivo' END AS metodo,
				IFNULL(p.Importe_Total, 0) AS importe
			FROM Pagos p
			JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
			LEFT JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
			LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
			LEFT JOIN Clientes cl ON cl.ID_Cliente = r.ID_Cliente
			${whereSql}
			ORDER BY p.Fecha_Hora DESC, p.ID_Pago DESC;
		`,
		args,
	});
	return rows(rs) as EntradaDto[];
}

export async function salidas(
	db: Client,
	del: string | null,
	al: string | null,
): Promise<SalidaDto[]> {
	const { whereSql, args } = rangoWhere(del, al, "Fecha");
	const rs = await db.execute({
		sql: `
			SELECT
				CAST(ID_Gasto AS TEXT) AS id,
				substr(Fecha, 1, 10) AS fecha_hora,
				Tipo_Gasto AS tipo_gasto,
				Concepto AS concepto,
				Importe AS importe,
				ID_Proveedor AS proveedor_id
			FROM Cuentas_Gastos
			${whereSql}
			ORDER BY date(Fecha) DESC, ID_Gasto DESC;
		`,
		args,
	});
	return rows(rs) as SalidaDto[];
}
