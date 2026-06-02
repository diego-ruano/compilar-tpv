import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError, unauthorized } from "../../../../utils/response";
import {
	applyTenantHubTransaction,
	getDeviceIdFromContext,
	readWriteRequest,
	sqlRef,
	type TxStep,
} from "../../../../utils/tenantHubWrites";

type TrabajadorCreateInput = {
	nombre?: string;
	apellido?: string | null;
	email?: string;
	estado?: string | null;

	idRol?: number;
	id_rol?: number;
	nombreRol?: string;
	nombre_rol?: string;
	rol?: string;

	telefono?: string | null;
	puesto?: string | null;
	dni?: string | null;
	iban?: string | null;

	numeroSeguridadSocial?: string | null;
	numero_seguridad_social?: string | null;

	fechaInicioContrato?: string | null;
	fecha_inicio_contrato?: string | null;

	fechaFinContrato?: string | null;
	fecha_fin_contrato?: string | null;

	passwordHash?: string | null;
	password_hash?: string | null;
	hashPassword?: string | null;
	hash_password?: string | null;
	password?: string | null;

	requiereSetup?: boolean | number | string | null;
	requiere_setup?: boolean | number | string | null;
};

const COMMAND_NAME = "trabajadores.create";

function trimOrNull(v: unknown): string | null {
	const s = String(v ?? "").trim();
	return s ? s : null;
}

function trimOrEmpty(v: unknown): string {
	return String(v ?? "").trim();
}

function normalizeBoolToInt(value: unknown, fallback = false): number {
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number") return value !== 0 ? 1 : 0;

	const s = String(value ?? "").trim().toLowerCase();
	if (!s) return fallback ? 1 : 0;

	if (["1", "true", "yes", "y", "si", "sí"].includes(s)) return 1;
	if (["0", "false", "no", "n"].includes(s)) return 0;

	return fallback ? 1 : 0;
}

function assertSql(errorLabel: string): string {
	return `json_extract('${errorLabel}', '$')`;
}

export async function handleTrabajadoresCreate(
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

		const tenantId = String(ctx?.claims?.tenantId || "").trim();
		if (!tenantId) {
			return unauthorized(req, "invalid_token_claims");
		}

		const { input: payload, opId } =
			await readWriteRequest<TrabajadorCreateInput>(req, {});

		if (!opId) {
			return json({ ok: false, error: "missing_op_id" }, 400, req);
		}

		const nombre = trimOrEmpty(payload?.nombre);
		const apellido = trimOrNull(payload?.apellido);
		const email = trimOrEmpty(payload?.email);
		const estado = trimOrNull(payload?.estado) || "Activo";

		const telefono = trimOrNull(payload?.telefono);
		const puesto = trimOrNull(payload?.puesto);
		const dni = trimOrNull(payload?.dni);
		const iban = trimOrNull(payload?.iban);

		const numeroSeguridadSocial = trimOrNull(
			payload?.numeroSeguridadSocial ?? payload?.numero_seguridad_social,
		);

		const fechaInicioContrato = trimOrNull(
			payload?.fechaInicioContrato ?? payload?.fecha_inicio_contrato,
		);

		const fechaFinContrato = trimOrNull(
			payload?.fechaFinContrato ?? payload?.fecha_fin_contrato,
		);

		const passwordHash =
			trimOrNull(payload?.passwordHash) ??
			trimOrNull(payload?.password_hash) ??
			trimOrNull(payload?.hashPassword) ??
			trimOrNull(payload?.hash_password) ??
			trimOrNull(payload?.password);

		const idRolInput = Number(payload?.idRol ?? payload?.id_rol ?? 0);
		const idRol =
			Number.isFinite(idRolInput) && idRolInput > 0 ? idRolInput : 0;

		const requestedRole =
			trimOrNull(payload?.nombreRol) ??
			trimOrNull(payload?.nombre_rol) ??
			trimOrNull(payload?.rol);

		const requiereSetup = normalizeBoolToInt(
			payload?.requiereSetup ?? payload?.requiere_setup,
			false,
		);

		if (!nombre || !email) {
			return json({ ok: false, error: "missing_required_fields" }, 400, req);
		}

		if (!passwordHash) {
			return json({ ok: false, error: "password_hash_required" }, 400, req);
		}

		const steps: TxStep[] = [
			{
				kind: "value",
				saveAs: "assert_email_unique",
				sql: `
					SELECT CASE
						WHEN EXISTS (
							SELECT 1
							FROM Usuarios
							WHERE lower(Email) = lower(?1)
							LIMIT 1
						)
						THEN ${assertSql("email_already_exists")}
						ELSE 1
					END;
				`,
				args: [email],
			},
			{
				kind: "value",
				saveAs: "assert_dni_unique",
				sql: `
					SELECT CASE
						WHEN ?1 IS NOT NULL
						 AND TRIM(?1) <> ''
						 AND EXISTS (
							SELECT 1
							FROM Trabajadores
							WHERE lower(DNI) = lower(?1)
							LIMIT 1
						 )
						THEN ${assertSql("dni_already_exists")}
						ELSE 1
					END;
				`,
				args: [dni],
			},
			{
				kind: "value",
				saveAs: "assert_numero_ss_unique",
				sql: `
					SELECT CASE
						WHEN ?1 IS NOT NULL
						 AND TRIM(?1) <> ''
						 AND EXISTS (
							SELECT 1
							FROM Trabajadores
							WHERE lower(Numero_Seguridad_Social) = lower(?1)
							LIMIT 1
						 )
						THEN ${assertSql("numero_seguridad_social_already_exists")}
						ELSE 1
					END;
				`,
				args: [numeroSeguridadSocial],
			},
			{
				kind: "value",
				saveAs: "id_rol_final",
				sql: `
					SELECT COALESCE(
						NULLIF(?1, 0),
						(
							SELECT ID_Rol
							FROM Roles
							WHERE ?2 IS NOT NULL
							  AND TRIM(?2) <> ''
							  AND lower(Nombre_Rol) = lower(?2)
							LIMIT 1
						),
						(
							SELECT ID_Rol
							FROM Roles
							WHERE (?2 IS NULL OR TRIM(?2) = '')
							  AND lower(Nombre_Rol) IN ('camarero', 'trabajador', 'empleado')
							ORDER BY CASE
								WHEN lower(Nombre_Rol) = 'camarero' THEN 0
								WHEN lower(Nombre_Rol) = 'trabajador' THEN 1
								WHEN lower(Nombre_Rol) = 'empleado' THEN 2
								ELSE 3
							END
							LIMIT 1
						),
						(
							SELECT ID_Rol
							FROM Roles
							WHERE (?2 IS NULL OR TRIM(?2) = '')
							ORDER BY ID_Rol ASC
							LIMIT 1
						)
					);
				`,
				args: [idRol, requestedRole],
			},
			{
				kind: "value",
				saveAs: "assert_role_found",
				sql: `
					SELECT CASE
						WHEN COALESCE(?1, 0) <= 0
						THEN ${assertSql("role_not_found")}
						ELSE 1
					END;
				`,
				args: [sqlRef("id_rol_final")],
			},
			{
				kind: "execute",
				sql: `
					INSERT INTO Usuarios (
						ID_Rol,
						Email,
						Password_Hash,
						Nombre,
						Apellido,
						Estado,
						Requiere_Setup
					)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);
				`,
				args: [
					sqlRef("id_rol_final"),
					email,
					passwordHash,
					nombre,
					apellido,
					estado,
					requiereSetup,
				],
			},
			{
				kind: "value",
				saveAs: "id_usuario_nuevo",
				sql: `SELECT last_insert_rowid();`,
				args: [],
			},
			{
				kind: "execute",
				sql: `
					INSERT INTO Trabajadores (
						ID_Usuario,
						Telefono,
						Puesto,
						DNI,
						IBAN,
						Numero_Seguridad_Social,
						Fecha_Inicio_Contrato,
						Fecha_Fin_Contrato
					)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);
				`,
				args: [
					sqlRef("id_usuario_nuevo"),
					telefono,
					puesto,
					dni,
					iban,
					numeroSeguridadSocial,
					fechaInicioContrato,
					fechaFinContrato,
				],
			},
			{
				kind: "value",
				saveAs: "ok_value",
				sql: `SELECT 1;`,
				args: [],
			},
		];

		await applyTenantHubTransaction<number>({
			env,
			tenantId,
			opId,
			commandName: COMMAND_NAME,
			deviceId: getDeviceIdFromContext(ctx),
			beginMode: "immediate",
			steps,
			resultKey: "ok_value",
		});

		return json(true, 200, req);
	} catch (e: any) {
		return serverError(req, "internal_error", {
			message: String(e?.message || e),
			name: e?.name,
			stack: e?.stack,
		});
	}
}